// The one command layer: every `pana` command is defined here once, as its usage line, flags,
// positionals, and the API request it makes. The CLI parses argv into it, the pana tools call it
// with structured parameters, and both run it through `runPanaCommand`, so a tool and the CLI
// send the same request and report the same exit code (TOL-02, TOL-03).
//
// Handlers live in the packages that own them (routes.ts names the owner). A command works as
// soon as its route does; until then panad answers 501 and the command exits 1.

import { isAbsolute } from "node:path";
import { request, type ApiResponse, type Endpoint } from "../api/client.ts";
import { statusToExitCode } from "../api/errors.ts";
import type { Method } from "../api/routes.ts";
import { parseRef } from "../ids/index.ts";
import { appendAttachmentMarkdown } from "../threads/files.ts";
import { CommandUsageError, parseArgv, resolveFlags, resolvePositionals, type Flags } from "./args.ts";

export { CommandUsageError, UsageError } from "./args.ts";
import { OBJECTIVE_COMMANDS } from "../objectives/cli.ts";
import { readBody, readStdinSync, uploadAttachments, type ApiCall, type FileAttachment } from "./body.ts";
import { renderText } from "./output.ts";

export type FlagType = "string" | "boolean" | "list";

export interface FlagSpec {
	/** Canonical name without dashes, e.g. `body-file`. Also the parameter name. */
	name: string;
	/** How the flag is written in help and errors. */
	syntax: string;
	type: FlagType;
	description: string;
	required?: boolean;
}

export interface PositionalSpec {
	/** The metavar, e.g. `THREAD`. */
	name: string;
	/** The command parameter this positional fills. */
	param: string;
	required?: boolean;
}

/**
 * What a command reads. The CLI fills it from flags and positionals; a pana tool passes the same
 * keys as its arguments. `files` are uploaded attachments the CLI added to the body (FIL-02).
 */
export interface CommandParams {
	[key: string]: string | string[] | boolean | FileAttachment[] | undefined;
}

/** One request, before the transport is chosen. */
export interface CommandRequest {
	method: Method;
	path: string;
	body?: unknown;
	query?: Record<string, string | undefined>;
}

export interface CommandSpec {
	/** The words after `pana`, e.g. `["session", "create"]`. */
	path: readonly string[];
	/** The pana tool that wraps this command. Only the six TOL-01 tools have one. */
	tool?: PanaToolName;
	/** The README's usage line, verbatim. Help prints it and tests compare it. */
	usage: string;
	/** More usage lines for a command the README documents in several forms. */
	altUsage?: readonly string[];
	summary: string;
	flags: readonly FlagSpec[];
	positionals: readonly PositionalSpec[];
	/** The command needs a body from the flags (CLI-04). */
	needsBody?: boolean;
	/**
	 * The parameter holding a local file path this command uploads through `POST /files` before its
	 * request (FIL-01), the way `--attach` does for a message. The uploaded file lands in
	 * `params.files`, so a command that links a file (OBJ-31) sends its id and panad never reads a
	 * client path.
	 */
	uploads?: string;
	/** Text output for a handler's reply, when the generic record rendering reads badly. */
	formatText?: (value: unknown) => string;
	/** A usage problem the tool and the CLI both reject with exit code 2. */
	validate?(params: CommandParams): string | undefined;
	request(params: CommandParams): CommandRequest;
}

export type PanaToolName =
	| "pana_reply"
	| "pana_thread_read"
	| "pana_thread_create"
	| "pana_session_create"
	| "pana_memory_search"
	| "pana_memory_commit"
	| "pana_schedule_wake";

/** The command names the pana tools wrap. */
export type PanaCommandName =
	| "thread respond"
	| "thread read"
	| "thread create"
	| "session create"
	| "memory search"
	| "memory commit"
	| "schedule wake";

// --- Parameter helpers ---------------------------------------------------------

/** Read a string parameter. */
function text(params: CommandParams, name: string): string | undefined {
	const value = params[name];
	return typeof value === "string" ? value : undefined;
}

/** Read an address or value list, splitting comma-separated values (ID-03). */
function items(params: CommandParams, name: string): string[] {
	const value = params[name];
	if (value === undefined || typeof value === "boolean") return [];
	const parts = Array.isArray(value) ? (value as unknown[]).map((part) => String(part)) : [String(value)];
	return parts
		.flatMap((part) => part.split(","))
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}

/** A list parameter, or undefined when it was not given, so absent stays absent in the body. */
function optionalItems(params: CommandParams, name: string): string[] | undefined {
	const list = items(params, name);
	return list.length > 0 ? list : undefined;
}

function files(params: CommandParams): FileAttachment[] {
	const value = params.files;
	return Array.isArray(value) ? (value as FileAttachment[]) : [];
}

/** The body with one Markdown reference appended per uploaded attachment (FIL-02). */
function bodyWithAttachments(params: CommandParams): string {
	return appendAttachmentMarkdown(text(params, "body") ?? "", files(params));
}

type RefKind = "session" | "thread" | "message" | "schedule";

/** A path segment from a bare ID or a pana:// URL, so every command accepts both. */
function segment(value: string | undefined, kind: RefKind): string {
	return encodeURIComponent(idOf(value, kind) ?? "");
}

function idOf(value: string | undefined, kind: RefKind): string | undefined {
	if (value === undefined || !value.trim().startsWith("pana://")) return value;
	let ref;
	try {
		ref = parseRef(value);
	} catch (error) {
		throw new CommandUsageError(error instanceof Error ? error.message : String(error));
	}
	// A message URL is threads/<thread>?message=<message>; a thread argument wants the thread part.
	if (kind === "thread" && ref.kind === "message") return ref.thread;
	if (ref.kind !== kind) throw new CommandUsageError(`expected a ${kind} URL, got a ${ref.kind} URL: ${value}`);
	return ref.id;
}

/** Keep only the keys a request actually carries, so absent flags stay out of the JSON. */
function compact(fields: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(fields)) {
		if (value !== undefined) out[key] = value;
	}
	return out;
}

// --- The command table ---------------------------------------------------------

const flag = (
	name: string,
	syntax: string,
	type: FlagType,
	description: string,
	extra: { required?: boolean } = {},
): FlagSpec => ({ name, syntax, type, description, ...extra });

const string = (name: string, syntax: string, description: string, extra: { required?: boolean } = {}) =>
	flag(name, syntax, "string", description, extra);
const list = (name: string, syntax: string, description: string, extra: { required?: boolean } = {}) =>
	flag(name, syntax, "list", description, extra);
const bool = (name: string, syntax: string, description: string) => flag(name, syntax, "boolean", description);

const RECURRING_FLAGS = [
	string("cron", "--cron CRON", "Cron expression in the domain timezone"),
	string("check", "--check COMMAND", "Bash readiness check before each cron dispatch: 0 ready, 1 not ready"),
	string("checkCwd", "--check-cwd DIR", "Absolute check directory; defaults to the daemon's cwd at creation"),
	bool("stopAfterSuccess", "--stop-after-success", "Finish a cron schedule after its first successful dispatch"),
];

/** Empty optional timing fields from tool calls are absent, including in the API payload. */
function scheduleSelector(params: CommandParams, name: string): string | undefined {
	const value = text(params, name);
	return value?.trim() ? value : undefined;
}

function validateSchedule(params: CommandParams, wake = false): string | undefined {
	const choices = wake ? ["in", "at", "cron"] : ["cron", "at"];
	const supplied = choices.filter((key) => scheduleSelector(params, key) !== undefined);
	if (supplied.length === 0) {
		return wake
			? "Provide one schedule selector: --in DURATION, --at TIME, or --cron CRON"
			: "Provide one schedule selector: --cron CRON or --at TIME";
	}
	if (supplied.length > 1) {
		return `Conflicting schedule selectors: ${supplied.map((key) => `--${key}`).join(", ")}. Provide only one.`;
	}
	const check = text(params, "check");
	const cwd = text(params, "checkCwd");
	if ((check !== undefined || cwd !== undefined || params.stopAfterSuccess === true) && scheduleSelector(params, "cron") === undefined) {
		return "--check, --check-cwd, and --stop-after-success require --cron";
	}
	if (check !== undefined && !check.trim()) return "--check must not be empty";
	if (cwd !== undefined && check === undefined) return "--check-cwd requires --check";
	if (cwd !== undefined && !isAbsolute(cwd)) return "--check-cwd must be an absolute directory";
	return undefined;
}

function recurringFields(params: CommandParams): Record<string, unknown> {
	return {
		cron: scheduleSelector(params, "cron"),
		check: text(params, "check"),
		checkCwd: text(params, "checkCwd"),
		stopAfterSuccess: params.stopAfterSuccess,
	};
}

const BODY_FLAGS = [
	string("body", "--body TEXT", "Message body, or - to read stdin"),
	string("body-file", "--body-file PATH", "Read the message body from a file"),
	list("attach", "--attach PATH", "Attach a file (repeatable)"),
] as const;

/** SCALE-03: every list command pages. `nextCursor` in the output is the next page's `--cursor`. */
const PAGE_FLAGS = [
	string("limit", "--limit N", "Return at most N items"),
	string("cursor", "--cursor CURSOR", "Continue from a previous page's nextCursor"),
] as const;

function pageQuery(params: CommandParams): Record<string, string | undefined> {
	return { limit: text(params, "limit"), cursor: text(params, "cursor") };
}

const SESSION_CREATE_FLAGS = [
	string("prompt", "--prompt TEXT", "The first message, which starts the session", { required: true }),
	string("model", "--model M", "Model id, overriding the profile"),
	string("thinking", "--thinking LEVEL", "Thinking level, overriding the profile"),
	string("cwd", "--cwd DIR", "Working directory for the session"),
	string("profile", "--profile NAME", "Profile to apply"),
	list("to", "--to ADDRS", "Add participants to the new thread"),
] as const;

export const COMMANDS: readonly CommandSpec[] = [
	{
		path: ["session", "create"],
		tool: "pana_session_create",
		usage: "pana session create --prompt TEXT [--model M] [--thinking LEVEL] [--cwd DIR] [--profile NAME] [--to ADDRS]",
		summary: "Create a session and a thread between you and it",
		flags: SESSION_CREATE_FLAGS,
		positionals: [],
		request: (params) => ({
			method: "POST",
			path: "/sessions",
			body: compact({
				prompt: text(params, "prompt"),
				model: text(params, "model"),
				thinking: text(params, "thinking"),
				cwd: text(params, "cwd"),
				profile: text(params, "profile"),
				to: optionalItems(params, "to"),
			}),
		}),
	},
	{
		path: ["session", "show"],
		usage: "pana session show SESSION",
		summary: "Show one session",
		flags: [],
		positionals: [{ name: "SESSION", param: "id", required: true }],
		request: (params) => ({ method: "GET", path: `/sessions/${segment(text(params, "id"), "session")}` }),
	},
	{
		path: ["session", "search"],
		usage: "pana session search [--query TEXT] [--state STATE] [--parent SESSION]",
		summary: "Search sessions",
		flags: [
			string("query", "--query TEXT", "Search transcripts"),
			string("state", "--state STATE", "Only sessions in this state"),
			string("parent", "--parent SESSION", "Only sessions created by this session"),
			...PAGE_FLAGS,
		],
		positionals: [],
		request: (params) => ({
			method: "GET",
			path: "/sessions",
			query: {
				query: text(params, "query"),
				state: text(params, "state"),
				parent: text(params, "parent"),
				...pageQuery(params),
			},
		}),
	},
	{
		path: ["session", "stop"],
		usage: "pana session stop SESSION",
		summary: "Abort the current run and stop the session",
		flags: [],
		positionals: [{ name: "SESSION", param: "id", required: true }],
		request: (params) => ({ method: "POST", path: `/sessions/${segment(text(params, "id"), "session")}/stop` }),
	},
	{
		path: ["session", "resume"],
		usage: "pana session resume SESSION",
		summary: "Resume a stopped session and deliver its queued mail",
		flags: [],
		positionals: [{ name: "SESSION", param: "id", required: true }],
		request: (params) => ({ method: "POST", path: `/sessions/${segment(text(params, "id"), "session")}/resume` }),
	},
	{
		path: ["session", "compact"],
		usage: "pana session compact SESSION",
		summary: "Compact a session's transcript",
		flags: [],
		positionals: [{ name: "SESSION", param: "id", required: true }],
		request: (params) => ({ method: "POST", path: `/sessions/${segment(text(params, "id"), "session")}/compact` }),
	},
	{
		path: ["session", "archive"],
		usage: "pana session archive SESSION",
		summary: "Archive a session for good; its threads become read-only",
		flags: [],
		positionals: [{ name: "SESSION", param: "id", required: true }],
		request: (params) => ({ method: "POST", path: `/sessions/${segment(text(params, "id"), "session")}/archive` }),
	},
	{
		path: ["session", "inbox"],
		usage: "pana session inbox SESSION",
		summary: "List a session's inbox",
		flags: [...PAGE_FLAGS],
		positionals: [{ name: "SESSION", param: "session", required: true }],
		request: (params) => ({
			method: "GET",
			path: "/inbox",
			query: { participant: idOf(text(params, "session"), "session"), ...pageQuery(params) },
		}),
	},
	{
		path: ["session", "inbox", "read"],
		usage: "pana session inbox read SESSION MESSAGE",
		summary: "Read one message as a session and mark it read",
		flags: [],
		positionals: [
			{ name: "SESSION", param: "session", required: true },
			{ name: "MESSAGE", param: "message", required: true },
		],
		request: (params) => ({
			method: "POST",
			path: `/messages/${segment(text(params, "message"), "message")}/read`,
			body: { participant: text(params, "session") },
		}),
	},
	{
		path: ["thread", "create"],
		tool: "pana_thread_create",
		usage: "pana thread create --to ADDRS (--body TEXT | --body-file PATH | --body -) [--attach PATH...]",
		summary: "Create a thread with a first message",
		flags: [list("to", "--to ADDRS", "Participants, comma-separated", { required: true }), ...BODY_FLAGS],
		positionals: [],
		needsBody: true,
		request: (params) => ({
			method: "POST",
			path: "/threads",
			body: { to: items(params, "to"), body: bodyWithAttachments(params) },
		}),
	},
	{
		path: ["thread", "respond"],
		tool: "pana_reply",
		usage: "pana thread respond --thread THREAD --after MESSAGE [--cc ADDRS] (--body ...) [--attach PATH...]",
		summary: "Append a message to a thread you have read to its head",
		flags: [
			string("thread", "--thread THREAD", "The thread to append to", { required: true }),
			string("after", "--after MESSAGE", "The newest message you have read", { required: true }),
			list("cc", "--cc ADDRS", "Add participants, comma-separated"),
			...BODY_FLAGS,
		],
		positionals: [],
		needsBody: true,
		request: (params) => ({
			method: "POST",
			path: `/threads/${segment(text(params, "thread"), "thread")}/messages`,
			body: compact({
				after: text(params, "after"),
				body: bodyWithAttachments(params),
				cc: optionalItems(params, "cc"),
			}),
		}),
	},
	{
		path: ["thread", "read"],
		tool: "pana_thread_read",
		usage: "pana thread read THREAD",
		altUsage: ["pana thread read --message MESSAGE"],
		summary: "Read a thread's messages",
		flags: [string("message", "--message MESSAGE", "Read one message instead of a thread")],
		positionals: [{ name: "THREAD", param: "thread" }],
		validate: (params) =>
			Boolean(text(params, "thread")?.trim()) === Boolean(text(params, "message")?.trim())
				? "give either a THREAD or --message MESSAGE"
				: undefined,
		request: (params) =>
			text(params, "message")?.trim()
				? { method: "GET", path: `/messages/${segment(text(params, "message"), "message")}` }
				: { method: "GET", path: `/threads/${segment(text(params, "thread"), "thread")}` },
	},
	{
		path: ["thread", "subject"],
		usage: "pana thread subject THREAD [--regenerate]",
		summary: "Show a thread's subject",
		flags: [bool("regenerate", "--regenerate", "Replace the subject with a new one")],
		positionals: [{ name: "THREAD", param: "id", required: true }],
		request: (params) => ({
			method: "POST",
			path: `/threads/${segment(text(params, "id"), "thread")}/subject`,
			body: { regenerate: params.regenerate === true },
		}),
	},
	{
		path: ["thread", "archive"],
		usage: "pana thread archive THREAD",
		summary: "Hide a thread from your inbox",
		flags: [],
		positionals: [{ name: "THREAD", param: "id", required: true }],
		request: (params) => ({ method: "POST", path: `/threads/${segment(text(params, "id"), "thread")}/archive` }),
	},
	{
		path: ["thread", "unarchive"],
		usage: "pana thread unarchive THREAD",
		summary: "Show an archived thread again",
		flags: [],
		positionals: [{ name: "THREAD", param: "id", required: true }],
		request: (params) => ({ method: "POST", path: `/threads/${segment(text(params, "id"), "thread")}/unarchive` }),
	},
	{
		path: ["thread", "list"],
		usage: "pana thread list [--participant ADDR]",
		summary: "List all same-domain threads, newest-created first",
		flags: [string("participant", "--participant ADDR", "Only threads this identity participates in"), ...PAGE_FLAGS],
		positionals: [],
		request: (params) => ({ method: "GET", path: "/threads", query: { participant: text(params, "participant"), ...pageQuery(params) } }),
	},
	{
		path: ["thread", "search"],
		usage: "pana thread search --query TEXT [--participant ADDR]",
		summary: "Search all same-domain thread subjects and bodies",
		flags: [
			string("query", "--query TEXT", "What to search for", { required: true }),
			string("participant", "--participant ADDR", "Only threads this identity participates in"),
			...PAGE_FLAGS,
		],
		positionals: [],
		validate: (params) => text(params, "query")?.trim() ? undefined : "give --query TEXT",
		request: (params) => ({
			method: "GET",
			path: "/threads",
			query: { query: text(params, "query"), participant: text(params, "participant"), ...pageQuery(params) },
		}),
	},
	{
		path: ["memory"],
		usage: "pana memory",
		summary: "Print your memory worktree path, creating it if needed",
		flags: [],
		positionals: [],
		request: () => ({ method: "GET", path: "/memory/worktree" }),
		// WP5 also returns the branch, repo, and caller. The point of `pana memory` is the path,
		// so a shell can use it directly.
		formatText: (value) => {
			const path = (value as { path?: unknown } | null | undefined)?.path;
			return typeof path === "string" ? `${path}\n` : renderText(value);
		},
	},
	{
		path: ["memory", "search"],
		tool: "pana_memory_search",
		usage: "pana memory search TEXT",
		summary: "Search memory on main",
		flags: [string("query", "--query TEXT", "Text to search for")],
		positionals: [{ name: "TEXT", param: "query", required: true }],
		request: (params) => ({ method: "GET", path: "/memory/search", query: { query: text(params, "query") } }),
	},
	{
		path: ["memory", "commit"],
		tool: "pana_memory_commit",
		usage: "pana memory commit -m MSG",
		summary: "Commit your memory changes",
		flags: [string("message", "-m MSG", "Commit message", { required: true })],
		positionals: [],
		request: (params) => ({
			method: "POST",
			path: "/memory/commit",
			body: { message: text(params, "message") },
		}),
	},
	{
		path: ["memory", "log"],
		usage: "pana memory log [PATH]",
		summary: "Show memory commits",
		flags: [],
		positionals: [{ name: "PATH", param: "path" }],
		request: (params) => ({ method: "GET", path: "/memory/log", query: { path: text(params, "path") } }),
	},
	{
		path: ["scratch"],
		usage: "pana scratch [--session SESSION]",
		summary: "Print a session's scratch directory; a session's own by default",
		flags: [string("session", "--session SESSION", "The session whose scratch to print; the user must name one")],
		positionals: [],
		request: (params) => ({ method: "GET", path: "/scratch", query: { session: text(params, "session") } }),
		// Like `pana memory`: the point is the path, so a shell can use it directly.
		formatText: (value) => {
			const path = (value as { path?: unknown } | null | undefined)?.path;
			return typeof path === "string" ? `${path}\n` : renderText(value);
		},
	},
	{
		path: ["scratch", "prune"],
		usage: "pana scratch prune [--dry-run]",
		summary: "Remove archived, orphaned, and idle scratch now",
		flags: [bool("dryRun", "--dry-run", "List what would be removed without removing it")],
		positionals: [],
		request: (params) => ({ method: "POST", path: "/scratch/prune", body: { dryRun: params.dryRun === true } }),
	},
	// WP18: `src/objectives/cli.ts` holds the `pana objective` table, so a WP18 package adds its
	// commands there and not here.
	...OBJECTIVE_COMMANDS,
	{
		path: ["worktree", "add"],
		usage: "pana worktree add REPO [--branch NAME] [--name NAME]",
		summary: "Create a worktree of a repository for this session and print its path",
		flags: [
			string("branch", "--branch NAME", "Branch to create (default: pana/<session>/<repo>)"),
			string("name", "--name NAME", "Directory name under <state>/worktrees/<session>"),
		],
		positionals: [{ name: "REPO", param: "repo", required: true }],
		request: (params) => ({
			method: "POST",
			path: "/worktrees",
			body: compact({ repo: text(params, "repo"), branch: text(params, "branch"), name: text(params, "name") }),
		}),
		// Like `pana scratch`: the point is the path, so a shell can use it directly.
		formatText: (value) => {
			const path = (value as { path?: unknown } | null | undefined)?.path;
			return typeof path === "string" ? `${path}\n` : renderText(value);
		},
	},
	{
		path: ["schedule", "session", "create"],
		usage: 'pana schedule session create --cron "0 22 * * 1-5" --prompt TEXT [--check COMMAND] [--check-cwd DIR] [--stop-after-success]',
		altUsage: ["pana schedule session create --at 2026-10-25T18:26:14Z --prompt TEXT"],
		summary: "Create a session on a cron schedule",
		flags: [
			...RECURRING_FLAGS,
			string("subject", "--subject TEXT", "Optional schedule label; generated from the description when omitted"),
			string("at", "--at TIME", "Run once at this ISO time"),
			...SESSION_CREATE_FLAGS,
		],
		positionals: [],
		validate: (params) => validateSchedule(params),
		request: (params) => ({
			method: "POST",
			path: "/schedules",
			body: compact({
				kind: "session",
				...recurringFields(params),
				subject: text(params, "subject"),
				at: scheduleSelector(params, "at"),
				prompt: text(params, "prompt"),
				model: text(params, "model"),
				thinking: text(params, "thinking"),
				cwd: text(params, "cwd"),
				profile: text(params, "profile"),
				to: optionalItems(params, "to"),
			}),
		}),
	},
	{
		path: ["schedule", "thread", "create"],
		usage: "pana schedule thread create --at 2026-10-25T18:26:14Z --to ADDRS --body-file PATH",
		altUsage: [
			'pana schedule thread create --cron "*/5 * * * *" --to ADDRS --body TEXT [--check COMMAND] [--check-cwd DIR] [--stop-after-success]',
		],
		summary: "Create a thread once or on a cron schedule",
		flags: [
			...RECURRING_FLAGS,
			string("subject", "--subject TEXT", "Optional schedule label; generated from the description when omitted"),
			string("at", "--at TIME", "Run once at this ISO time"),
			list("to", "--to ADDRS", "Participants, comma-separated", { required: true }),
			...BODY_FLAGS,
		],
		positionals: [],
		needsBody: true,
		validate: (params) => validateSchedule(params),
		request: (params) => ({
			method: "POST",
			path: "/schedules",
			body: compact({
				kind: "thread",
				...recurringFields(params),
				subject: text(params, "subject"),
				at: scheduleSelector(params, "at"),
				to: items(params, "to"),
				body: bodyWithAttachments(params),
			}),
		}),
	},
	{
		path: ["schedule", "wake"],
		tool: "pana_schedule_wake",
		usage: "pana schedule wake --in 10m --note TEXT [--session SESSION]",
		altUsage: [
			"pana schedule wake --at 2026-10-25T18:26:14Z --note TEXT",
			'pana schedule wake --cron "*/5 * * * *" --note TEXT [--check COMMAND] [--check-cwd DIR] [--stop-after-success]',
		],
		summary: "Wake a session later with a note: yours by default",
		flags: [
			...RECURRING_FLAGS,
			string("subject", "--subject TEXT", "Optional schedule label; generated from the description when omitted"),
			string("in", "--in DURATION", "Wake after this long: 90s, 10m, 2h, or 1d"),
			string("at", "--at TIME", "Wake at this ISO time"),
			string("note", "--note TEXT", "What to check when you wake, and where to reply", { required: true }),
			string("session", "--session SESSION", "The session to wake; only the user may name another"),
		],
		positionals: [],
		validate: (params) => validateSchedule(params, true),
		request: (params) => ({
			method: "POST",
			path: "/schedules",
			body: compact({
				kind: "wake",
				...recurringFields(params),
				subject: text(params, "subject"),
				in: scheduleSelector(params, "in"),
				at: scheduleSelector(params, "at"),
				note: text(params, "note"),
				session: text(params, "session"),
			}),
		}),
	},
	{
		path: ["schedule", "list"],
		usage: "pana schedule list [--kind session|thread|wake]",
		summary: "List schedules",
		flags: [string("kind", "--kind KIND", "Only schedules of this kind"), ...PAGE_FLAGS],
		positionals: [],
		request: (params) => ({ method: "GET", path: "/schedules", query: { kind: text(params, "kind"), ...pageQuery(params) } }),
	},
	{
		path: ["schedule", "delete"],
		usage: "pana schedule delete SCHEDULE",
		summary: "Delete a schedule",
		flags: [],
		positionals: [{ name: "SCHEDULE", param: "id", required: true }],
		request: (params) => ({ method: "DELETE", path: `/schedules/${segment(text(params, "id"), "schedule")}` }),
	},
];

// --- Lookup --------------------------------------------------------------------

/** The command name, e.g. `thread respond`. */
export function commandName(spec: CommandSpec): string {
	return spec.path.join(" ");
}

export function findCommand(commands: readonly CommandSpec[], path: readonly string[]): CommandSpec | undefined {
	return commands.find((command) => commandName(command) === path.join(" "));
}

export function specForCommand(name: string): CommandSpec | undefined {
	return findCommand(COMMANDS, name.split(" "));
}

/** True when `path` names a command or the beginning of one, for `--help`. */
export function isKnownPath(commands: readonly CommandSpec[], path: readonly string[]): boolean {
	if (path.length === 0) return true;
	const key = path.join(" ");
	return commands.some((command) => {
		const commandPath = commandName(command);
		return commandPath === key || commandPath.startsWith(`${key} `);
	});
}

export function commandForTool(tool: PanaToolName): CommandSpec {
	const spec = COMMANDS.find((command) => command.tool === tool);
	if (!spec) throw new Error(`no pana command for tool ${tool}`);
	return spec;
}

/** The six commands the pana tools wrap, keyed by command name. */
export const PANA_COMMANDS: Record<PanaCommandName, CommandSpec> = Object.fromEntries(
	COMMANDS.filter((command) => command.tool !== undefined).map((command) => [commandName(command), command]),
) as Record<PanaCommandName, CommandSpec>;

export function isCommandName(name: string): name is PanaCommandName {
	return Object.prototype.hasOwnProperty.call(PANA_COMMANDS, name);
}

export function usageFor(command: PanaCommandName): string {
	return PANA_COMMANDS[command].usage;
}

// --- Parameters from argv ------------------------------------------------------

/**
 * Turn resolved flags and positionals into the parameters of one command. Flags map 1:1 by
 * name; the body flags are handled by `readBody` and attachments are uploaded separately.
 */
export function paramsFor(spec: CommandSpec, flags: Flags, positionals: readonly string[]): CommandParams {
	const params: CommandParams = {};
	for (const flagSpec of spec.flags) {
		if (flagSpec.name === "body" || flagSpec.name === "body-file" || flagSpec.name === "attach") continue;
		if (flagSpec.type === "list") {
			const list = flags.list(flagSpec.name);
			if (list.length > 0) params[flagSpec.name] = list;
		} else if (flagSpec.type === "boolean") {
			if (flags.has(flagSpec.name)) params[flagSpec.name] = true;
		} else {
			const value = flags.get(flagSpec.name);
			if (value !== undefined) params[flagSpec.name] = value;
		}
	}
	for (const [index, positional] of spec.positionals.entries()) {
		const value = positionals[index];
		if (value !== undefined) params[positional.param] = value;
	}
	return params;
}

export interface InvocationIo {
	/** Read `--body -`. */
	readStdin?: () => Promise<string>;
	/** Upload one `--attach PATH`; absent means this caller cannot attach. */
	upload?: (path: string) => Promise<FileAttachment>;
}

/** Resolve one invocation into its command and parameters, reading any body and attachments. */
export async function invocationFor(
	argv: readonly string[],
	io: InvocationIo = {},
): Promise<{ spec: CommandSpec; params: CommandParams }> {
	const parsed = parseArgv(argv, COMMANDS);
	if (parsed.help) throw new CommandUsageError("help is not a command");
	const spec = findCommand(COMMANDS, parsed.path);
	if (!spec) throw new CommandUsageError(unknownCommandMessage(parsed.path, parsed.positionals));
	const flags = resolveFlags(spec, parsed.flags);
	const positionals = resolvePositionals(spec, parsed.positionals);
	const params = paramsFor(spec, flags, positionals);
	if (spec.needsBody) {
		if (!io.readStdin) throw new CommandUsageError("this caller cannot read a body from stdin");
		params.body = await readBody(flags, io.readStdin);
	}
	const attach = flags.list("attach");
	if (attach.length > 0) {
		if (!io.upload) throw new CommandUsageError("this caller cannot attach files");
		const uploaded: FileAttachment[] = [];
		for (const path of attach) uploaded.push(await io.upload(path));
		params.files = uploaded;
	}
	if (spec.uploads !== undefined) {
		const path = params[spec.uploads];
		if (typeof path === "string" && path.length > 0) {
			if (!io.upload) throw new CommandUsageError("this caller cannot upload files");
			params.files = [await io.upload(path)];
		}
	}
	return { spec, params };
}

/** The message for a command path that does not name a command. */
export function unknownCommandMessage(path: readonly string[], positionals: readonly string[]): string {
	const typed = [...path, ...(positionals.length > 0 ? [positionals[0]!] : [])];
	if (typed.length === 0) return "a command is required";
	const written = typed.join(" ");
	if (isKnownPath(COMMANDS, typed)) return `pana ${written} needs a command`;
	return `unknown command: pana ${written}`;
}

// --- Running -------------------------------------------------------------------

export interface CommandEndpoint {
	endpoint: Endpoint;
	/** The caller's session URL or ULID, sent as `Pana-Caller`; absent means the local user. */
	caller?: string;
}

export interface CommandOutcome {
	/** The HTTP status, or 0 when the request never reached panad or never left. */
	status: number;
	exitCode: number;
	body: unknown;
	/** The JSON text a tool shows the model. */
	text: string;
	/** The failure message, when the command failed. */
	message?: string;
	/** True when the failure is the invocation's, so the CLI prints a usage line. */
	usage?: boolean;
}

function withQuery(path: string, query: Record<string, string | undefined> | undefined): string {
	if (!query) return path;
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(query)) {
		if (value !== undefined) params.set(key, value);
	}
	const encoded = params.toString();
	return encoded.length === 0 ? path : `${path}?${encoded}`;
}

/** A client for one endpoint, used by the command runner and by attachment uploads. */
export function callFor(target: CommandEndpoint): ApiCall {
	return (method, path, options = {}) =>
		request(target.endpoint, method, withQuery(path, options.query), {
			body: options.body,
			bytes: options.bytes,
			headers: options.headers,
			caller: target.caller,
		});
}

function errorMessage(body: unknown, status: number): string {
	if (typeof body === "object" && body !== null) {
		const error = (body as { error?: { message?: unknown } }).error;
		if (error && typeof error.message === "string") return error.message;
	}
	return `request failed with status ${status}`;
}

function render(body: unknown): string {
	return body === undefined ? "" : JSON.stringify(body, null, 2);
}

/**
 * Send one command to panad and turn the reply into its CLI exit code and JSON text
 * (API-02). A validation failure is exit 2 and never touches the server; an unreachable panad
 * is exit 1.
 */
export async function runPanaCommand(
	command: string,
	params: CommandParams,
	target: CommandEndpoint,
): Promise<CommandOutcome> {
	const spec = specForCommand(command);
	if (!spec) {
		const message = `unknown command: ${command}`;
		return { status: 0, exitCode: 2, body: { error: { code: "usage", message } }, text: message, message, usage: true };
	}
	const problem = spec.validate?.(params);
	if (problem !== undefined) {
		return { status: 0, exitCode: 2, body: { error: { code: "usage", message: problem } }, text: problem, message: problem, usage: true };
	}
	const built = spec.request(params);
	let response: ApiResponse;
	try {
		response = await callFor(target)(built.method, built.path, { body: built.body, query: built.query });
	} catch (error) {
		const message = "panad is not running";
		return {
			status: 0,
			exitCode: 1,
			body: { error: { code: "unreachable", message, cause: (error as Error).message } },
			text: message,
			message,
		};
	}
	const exitCode = statusToExitCode(response.status);
	const outcome: CommandOutcome = {
		status: response.status,
		exitCode,
		body: response.body,
		text: render(response.body),
	};
	if (exitCode !== 0) outcome.message = errorMessage(response.body, response.status);
	return outcome;
}

/**
 * Run one CLI invocation, `["thread", "respond", "--thread", ...]`. The pana tools use
 * `runPanaCommand` directly; this is the CLI's shape of the same path, kept for the parity test.
 */
export async function runPanaCli(argv: readonly string[], target: CommandEndpoint): Promise<CommandOutcome> {
	const call = callFor(target);
	const { spec, params } = await invocationFor(argv, {
		readStdin: async () => readStdinSync(),
		upload: async (path) => (await uploadAttachments(call, [path]))[0]!,
	});
	return runPanaCommand(commandName(spec), params, target);
}

export type { FileAttachment };
