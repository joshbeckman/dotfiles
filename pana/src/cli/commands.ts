// The command table (CLI-01..07): every command in README.md, the flags it accepts, and the
// one API call it makes. Handlers live in the packages that own them; this file only shapes
// the request, so a command works as soon as its route does.

import type { ApiResponse } from "../api/client.ts";
import { UsageError } from "./args.ts";
import { withAttachments } from "./body.ts";

export type FlagType = "string" | "boolean" | "list";

export interface FlagSpec {
	/** Canonical name without dashes, e.g. `body-file`. */
	name: string;
	/** How the flag is written in help and errors. */
	syntax: string;
	type: FlagType;
	description: string;
	required?: boolean;
}

export interface PositionalSpec {
	name: string;
	required?: boolean;
}

/** Flags as the command sees them: one value, a list, or presence. */
export interface Flags {
	has(name: string): boolean;
	get(name: string): string | undefined;
	list(name: string): string[];
}

export interface CommandContext {
	flags: Flags;
	positionals: string[];
	/** The caller's session, from `PANA_SESSION` (CLI-02). */
	caller: string | undefined;
	/** Read stdin, for `--body -`. */
	stdin: AsyncIterable<Buffer | string>;
	call(method: string, path: string, options?: CallOptions): Promise<ApiResponse>;
}

export interface CallOptions {
	body?: unknown;
	bytes?: Uint8Array;
	headers?: Record<string, string>;
	query?: Record<string, string | undefined>;
}

export interface CommandSpec {
	/** The words after `pana`, e.g. `["session", "create"]`. */
	path: readonly string[];
	/** The README's usage line, verbatim. Help prints it and tests compare it. */
	usage: string;
	/** More usage lines for a command the README documents in several forms. */
	altUsage?: readonly string[];
	summary: string;
	flags: readonly FlagSpec[];
	positionals: readonly PositionalSpec[];
	/** The command needs a body from the flags (CLI-04). */
	needsBody?: boolean;
	run(ctx: CommandContext): Promise<ApiResponse>;
}

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

const BODY_FLAGS = [
	string("body", "--body TEXT", "Message body, or - to read stdin"),
	string("body-file", "--body-file PATH", "Read the message body from a file"),
	list("attach", "--attach PATH", "Attach a file (repeatable)"),
] as const;

/** Split a comma-separated address list into its parts (ID-03: a bare ULID is a session). */
export function addresses(values: string[]): string[] {
	return values
		.flatMap((value) => value.split(","))
		.map((value) => value.trim())
		.filter((value) => value.length > 0);
}

function segments(...parts: Array<string | undefined>): string {
	return parts
		.filter((part): part is string => part !== undefined && part.length > 0)
		.map((part) => encodeURIComponent(part))
		.join("/");
}

export const COMMANDS: readonly CommandSpec[] = [
	{
		path: ["session", "create"],
		usage: "pana session create --prompt TEXT [--model M] [--thinking LEVEL] [--cwd DIR] [--profile NAME] [--to ADDRS]",
		summary: "Create a session and a thread between you and it",
		flags: [
			string("prompt", "--prompt TEXT", "The first message, which starts the session", { required: true }),
			string("model", "--model M", "Model id, overriding the profile"),
			string("thinking", "--thinking LEVEL", "Thinking level, overriding the profile"),
			string("cwd", "--cwd DIR", "Working directory for the session"),
			string("profile", "--profile NAME", "Profile to apply"),
			list("to", "--to ADDRS", "Add participants to the new thread"),
		],
		positionals: [],
		run: (ctx) =>
			ctx.call("POST", "/sessions", {
				body: {
					prompt: ctx.flags.get("prompt"),
					model: ctx.flags.get("model"),
					thinking: ctx.flags.get("thinking"),
					cwd: ctx.flags.get("cwd"),
					profile: ctx.flags.get("profile"),
					to: addresses(ctx.flags.list("to")),
				},
			}),
	},
	{
		path: ["session", "show"],
		usage: "pana session show SESSION",
		summary: "Show one session",
		flags: [],
		positionals: [{ name: "SESSION", required: true }],
		run: (ctx) => ctx.call("GET", `/sessions/${segments(ctx.positionals[0])}`),
	},
	{
		path: ["session", "search"],
		usage: "pana session search [--query TEXT] [--state STATE] [--parent SESSION]",
		summary: "Search sessions",
		flags: [
			string("query", "--query TEXT", "Search transcripts"),
			string("state", "--state STATE", "Only sessions in this state"),
			string("parent", "--parent SESSION", "Only sessions created by this session"),
		],
		positionals: [],
		run: (ctx) =>
			ctx.call("GET", "/sessions", {
				query: {
					query: ctx.flags.get("query"),
					state: ctx.flags.get("state"),
					parent: ctx.flags.get("parent"),
				},
			}),
	},
	{
		path: ["session", "stop"],
		usage: "pana session stop SESSION",
		summary: "Abort the current run and stop the session",
		flags: [],
		positionals: [{ name: "SESSION", required: true }],
		run: (ctx) => ctx.call("POST", `/sessions/${segments(ctx.positionals[0])}/stop`),
	},
	{
		path: ["session", "resume"],
		usage: "pana session resume SESSION",
		summary: "Resume a stopped session and deliver its queued mail",
		flags: [],
		positionals: [{ name: "SESSION", required: true }],
		run: (ctx) => ctx.call("POST", `/sessions/${segments(ctx.positionals[0])}/resume`),
	},
	{
		path: ["session", "compact"],
		usage: "pana session compact SESSION",
		summary: "Compact a session's transcript",
		flags: [],
		positionals: [{ name: "SESSION", required: true }],
		run: (ctx) => ctx.call("POST", `/sessions/${segments(ctx.positionals[0])}/compact`),
	},
	{
		path: ["session", "inbox"],
		usage: "pana session inbox SESSION",
		summary: "List a session's inbox",
		flags: [],
		positionals: [{ name: "SESSION", required: true }],
		run: (ctx) => ctx.call("GET", "/inbox", { query: { participant: ctx.positionals[0] } }),
	},
	{
		path: ["session", "inbox", "read"],
		usage: "pana session inbox read SESSION MESSAGE",
		summary: "Read one message as a session and mark it read",
		flags: [],
		positionals: [
			{ name: "SESSION", required: true },
			{ name: "MESSAGE", required: true },
		],
		run: (ctx) =>
			ctx.call("POST", `/messages/${segments(ctx.positionals[1])}/read`, {
				query: { participant: ctx.positionals[0] },
			}),
	},
	{
		path: ["thread", "create"],
		usage: "pana thread create --to ADDRS (--body TEXT | --body-file PATH | --body -) [--attach PATH...]",
		summary: "Create a thread with a first message",
		flags: [list("to", "--to ADDRS", "Participants, comma-separated", { required: true }), ...BODY_FLAGS],
		positionals: [],
		needsBody: true,
		run: async (ctx) =>
			ctx.call("POST", "/threads", {
				body: {
					to: addresses(ctx.flags.list("to")),
					body: await withAttachments(ctx),
				},
			}),
	},
	{
		path: ["thread", "respond"],
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
		run: async (ctx) =>
			ctx.call("POST", `/threads/${segments(ctx.flags.get("thread"))}/messages`, {
				body: {
					after: ctx.flags.get("after"),
					cc: addresses(ctx.flags.list("cc")),
					body: await withAttachments(ctx),
				},
			}),
	},
	{
		path: ["thread", "read"],
		usage: "pana thread read THREAD",
		altUsage: ["pana thread read --message MESSAGE"],
		summary: "Read a thread's messages",
		flags: [string("message", "--message MESSAGE", "Read one message instead of a thread")],
		positionals: [{ name: "THREAD" }],
		// README documents this twice: `thread read THREAD` and `thread read --message MESSAGE`.
		run: (ctx) => {
			const thread = ctx.positionals[0];
			const message = ctx.flags.get("message");
			if (thread !== undefined && message !== undefined) {
				throw new UsageError("give THREAD or --message MESSAGE, not both");
			}
			if (message !== undefined) return ctx.call("GET", `/messages/${segments(message)}`);
			if (thread !== undefined) return ctx.call("GET", `/threads/${segments(thread)}`);
			throw new UsageError("thread read needs a THREAD or --message MESSAGE");
		},
	},
	{
		path: ["thread", "subject"],
		usage: "pana thread subject THREAD [--regenerate]",
		summary: "Show a thread's subject",
		flags: [bool("regenerate", "--regenerate", "Replace the subject with a new one")],
		positionals: [{ name: "THREAD", required: true }],
		run: (ctx) =>
			ctx.call("POST", `/threads/${segments(ctx.positionals[0])}/subject`, {
				body: { regenerate: ctx.flags.has("regenerate") },
			}),
	},
	{
		path: ["thread", "search"],
		usage: "pana thread search --query TEXT",
		summary: "Search thread subjects and bodies",
		flags: [string("query", "--query TEXT", "What to search for", { required: true })],
		positionals: [],
		run: (ctx) => ctx.call("GET", "/threads", { query: { query: ctx.flags.get("query") } }),
	},
	{
		path: ["memory"],
		usage: "pana memory",
		summary: "Print your memory worktree path, creating it if needed",
		flags: [],
		positionals: [],
		run: (ctx) => ctx.call("GET", "/memory/worktree"),
	},
	{
		path: ["memory", "search"],
		usage: "pana memory search TEXT",
		summary: "Search memory on main",
		flags: [],
		positionals: [{ name: "TEXT", required: true }],
		run: (ctx) => ctx.call("GET", "/memory/search", { query: { query: ctx.positionals[0] } }),
	},
	{
		path: ["memory", "commit"],
		usage: "pana memory commit -m MSG",
		summary: "Commit your memory changes",
		flags: [string("message", "-m MSG", "Commit message", { required: true })],
		positionals: [],
		run: (ctx) => ctx.call("POST", "/memory/commit", { body: { message: ctx.flags.get("message") } }),
	},
	{
		path: ["memory", "log"],
		usage: "pana memory log [PATH]",
		summary: "Show memory commits",
		flags: [],
		positionals: [{ name: "PATH" }],
		run: (ctx) => ctx.call("GET", "/memory/log", { query: { path: ctx.positionals[0] } }),
	},
	{
		path: ["schedule", "session", "create"],
		usage: 'pana schedule session create --cron "0 22 * * 1-5" --prompt TEXT',
		altUsage: ["pana schedule session create --at 2026-10-25T18:26:14Z --prompt TEXT"],
		summary: "Create a session on a cron schedule",
		flags: [
			string("cron", "--cron CRON", "Cron expression in the domain timezone"),
			string("at", "--at TIME", "Run once at this ISO time"),
			string("prompt", "--prompt TEXT", "The first message, which starts the session", { required: true }),
			string("model", "--model M", "Model id, overriding the profile"),
			string("thinking", "--thinking LEVEL", "Thinking level, overriding the profile"),
			string("cwd", "--cwd DIR", "Working directory for the session"),
			string("profile", "--profile NAME", "Profile to apply"),
			list("to", "--to ADDRS", "Add participants to the new thread"),
		],
		positionals: [],
		run: (ctx) => {
			const cron = ctx.flags.get("cron");
			const at = ctx.flags.get("at");
			if (cron === undefined && at === undefined) throw new UsageError("give --cron CRON or --at TIME");
			if (cron !== undefined && at !== undefined) throw new UsageError("--cron and --at are mutually exclusive");
			return ctx.call("POST", "/schedules", {
				body: {
					kind: "session",
					cron,
					at,
					prompt: ctx.flags.get("prompt"),
					model: ctx.flags.get("model"),
					thinking: ctx.flags.get("thinking"),
					cwd: ctx.flags.get("cwd"),
					profile: ctx.flags.get("profile"),
					to: addresses(ctx.flags.list("to")),
				},
			});
		},
	},
	{
		path: ["schedule", "thread", "create"],
		usage: "pana schedule thread create --at 2026-10-25T18:26:14Z --to ADDRS --body-file PATH",
		summary: "Create a thread at a future time",
		flags: [
			string("at", "--at TIME", "Run once at this ISO time", { required: true }),
			list("to", "--to ADDRS", "Participants, comma-separated", { required: true }),
			...BODY_FLAGS,
		],
		positionals: [],
		needsBody: true,
		run: async (ctx) =>
			ctx.call("POST", "/schedules", {
				body: {
					kind: "thread",
					at: ctx.flags.get("at"),
					to: addresses(ctx.flags.list("to")),
					body: await withAttachments(ctx),
				},
			}),
	},
	{
		path: ["schedule", "list"],
		usage: "pana schedule list [--kind session|thread]",
		summary: "List schedules",
		flags: [string("kind", "--kind KIND", "Only schedules of this kind")],
		positionals: [],
		run: (ctx) => ctx.call("GET", "/schedules", { query: { kind: ctx.flags.get("kind") } }),
	},
	{
		path: ["schedule", "delete"],
		usage: "pana schedule delete SCHEDULE",
		summary: "Delete a schedule",
		flags: [],
		positionals: [{ name: "SCHEDULE", required: true }],
		run: (ctx) => ctx.call("DELETE", `/schedules/${segments(ctx.positionals[0])}`),
	},
];

/** Commands indexed for lookup by path. */
export function commandKey(path: readonly string[]): string {
	return path.join(" ");
}

export function findCommand(commands: readonly CommandSpec[], path: readonly string[]): CommandSpec | undefined {
	return commands.find((command) => commandKey(command.path) === commandKey(path));
}

/** True when `path` names a command or the beginning of one, for `--help`. */
export function isKnownPath(commands: readonly CommandSpec[], path: readonly string[]): boolean {
	if (path.length === 0) return true;
	const key = commandKey(path);
	return commands.some((command) => commandKey(command.path) === key || commandKey(command.path).startsWith(`${key} `));
}
