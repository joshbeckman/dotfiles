// The `pana objective` command table (OBJ-38).
//
// It lives here, beside the package it commands, so a later WP18 package adds its own commands
// here rather than editing `src/cli/commands.ts`: that file spreads `OBJECTIVE_COMMANDS` once.
// Every command is defined now, and a command whose route a later package owns exits 1 with
// panad's 501 `not_implemented` until that package fills the handler in.

import { readFileSync } from "node:fs";
import { CommandUsageError } from "../cli/args.ts";
import type { CommandParams, CommandSpec, FileAttachment, FlagSpec } from "../cli/commands.ts";
import { parseRef } from "../ids/index.ts";

function text(params: CommandParams, name: string): string | undefined {
	const value = params[name];
	return typeof value === "string" ? value : undefined;
}

/** Keep only the keys a request carries, so absent flags stay out of the JSON. */
function compact(fields: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(fields)) {
		if (value !== undefined) out[key] = value;
	}
	return out;
}

/** A path segment from a bare objective ULID or a `pana://` objective URL (ID-02). */
function objectiveSegment(value: string | undefined): string {
	const input = (value ?? "").trim();
	if (!input) return "";
	if (!input.startsWith("pana://")) return encodeURIComponent(input);
	try {
		const ref = parseRef(input);
		if (ref.kind !== "objective") throw new CommandUsageError(`expected an objective URL, got a ${ref.kind} URL: ${input}`);
		return encodeURIComponent(ref.id);
	} catch (error) {
		throw new CommandUsageError(error instanceof Error ? error.message : String(error));
	}
}

const string = (name: string, syntax: string, description: string, extra: { required?: boolean } = {}): FlagSpec => ({
	name,
	syntax,
	type: "string",
	description,
	...extra,
});

const bool = (name: string, syntax: string, description: string): FlagSpec => ({ name, syntax, type: "boolean", description });

/** SCALE-03: every list command pages. */
const PAGE_FLAGS: readonly FlagSpec[] = [
	string("limit", "--limit N", "Return at most N items"),
	string("cursor", "--cursor CURSOR", "Continue from a previous page's nextCursor"),
];

const BODY_FLAGS: readonly FlagSpec[] = [
	string("body", "--body TEXT", "Message body, or - to read stdin"),
	string("body-file", "--body-file PATH", "Read the message body from a file"),
];

/** --goal or --goal-file, read here so the API only ever sees the text. */
const GOAL_FLAGS: readonly FlagSpec[] = [
	string("goal", "--goal TEXT", "The objective's goal statement"),
	string("goal-file", "--goal-file PATH", "Read the goal from a file"),
];

function goalOf(params: CommandParams): string | undefined {
	const inline = text(params, "goal");
	if (inline !== undefined) return inline;
	const path = text(params, "goal-file");
	if (path === undefined) return undefined;
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		throw new CommandUsageError(`cannot read --goal-file ${path}: ${(error as Error).message}`);
	}
}

/** OBJ-01's create: exactly one of a goal and a goal file. */
function validateGoal(params: CommandParams): string | undefined {
	const hasGoal = Boolean(text(params, "goal")?.trim());
	const hasFile = Boolean(text(params, "goal-file")?.trim());
	if (hasGoal === hasFile) return "give one of --goal TEXT or --goal-file PATH";
	return undefined;
}

export const OBJECTIVE_COMMANDS: readonly CommandSpec[] = [
	{
		path: ["objective", "create"],
		usage: "pana objective create --goal TEXT",
		altUsage: ["pana objective create --goal-file PATH"],
		summary: "Draft an objective; only you can launch it",
		flags: [
			...GOAL_FLAGS,
			string("due-at", "--due-at TIME", "The deadline pace is measured against; for a vote or a merge, the date that party meets"),
			string("autonomy", "--autonomy manual|auto", "Whether the lead may finish without your confirmation"),
			string("max-daily-usd", "--max-daily-usd N", "Daily spend limit for the objective's sessions"),
			string("max-total-usd", "--max-total-usd N", "Lifetime spend limit for the objective's sessions"),
			string("wake-min-minutes", "--wake-min-minutes N", "Quiet interval between the lead's runs"),
			string("max-daily-lead-turns", "--max-daily-lead-turns N", "Lead runs per local day"),
			string("max-daily-user-messages", "--max-daily-user-messages N", "Messages to you per local day"),
			string("max-active-members", "--max-active-members N", "Members not stopped or archived"),
		],
		positionals: [],
		validate: validateGoal,
		request: (params) => ({
			method: "POST",
			path: "/objectives",
			body: compact({
				goal: goalOf(params),
				dueAt: text(params, "due-at"),
				autonomy: text(params, "autonomy"),
				maxDailyUsd: numberParam(params, "max-daily-usd"),
				maxTotalUsd: numberParam(params, "max-total-usd"),
				wakeMinMinutes: numberParam(params, "wake-min-minutes"),
				maxDailyLeadTurns: numberParam(params, "max-daily-lead-turns"),
				maxDailyUserMessages: numberParam(params, "max-daily-user-messages"),
				maxActiveMembers: numberParam(params, "max-active-members"),
			}),
		}),
	},
	{
		path: ["objective", "list"],
		usage: "pana objective list [--phase PHASE] [--creator ADDR]",
		summary: "List objectives, newest first",
		flags: [string("phase", "--phase PHASE", "Only objectives in this phase"), string("creator", "--creator ADDR", "Only objectives this identity created"), ...PAGE_FLAGS],
		positionals: [],
		request: (params) => ({
			method: "GET",
			path: "/objectives",
			query: { phase: text(params, "phase"), creator: text(params, "creator"), limit: text(params, "limit"), cursor: text(params, "cursor") },
		}),
	},
	{
		path: ["objective", "show"],
		usage: "pana objective show OBJECTIVE",
		summary: "Show one objective, with its derived state and members",
		flags: [],
		positionals: [{ name: "OBJECTIVE", param: "id", required: true }],
		request: (params) => ({ method: "GET", path: `/objectives/${objectiveSegment(text(params, "id"))}` }),
	},
	{
		path: ["objective", "launch"],
		usage: "pana objective launch OBJECTIVE",
		summary: "Launch a draft: create its lead and thread, and start the lead's first run",
		flags: [],
		positionals: [{ name: "OBJECTIVE", param: "id", required: true }],
		request: (params) => ({ method: "POST", path: `/objectives/${objectiveSegment(text(params, "id"))}/launch` }),
	},
	{
		path: ["objective", "stop"],
		usage: "pana objective stop OBJECTIVE",
		altUsage: ["pana objective stop --all"],
		summary: "Stop an objective and its members, or every active objective",
		flags: [bool("all", "--all", "Stop every active objective")],
		positionals: [{ name: "OBJECTIVE", param: "id" }],
		validate: (params) => (params.all === true) === Boolean(text(params, "id")?.trim()) ? "give an OBJECTIVE or --all" : undefined,
		request: (params) =>
			params.all === true
				? { method: "POST", path: "/objectives/stop", body: { all: true } }
				: { method: "POST", path: `/objectives/${objectiveSegment(text(params, "id"))}/stop` },
	},
	{
		path: ["objective", "resume"],
		usage: "pana objective resume OBJECTIVE",
		summary: "Resume a stopped objective",
		flags: [],
		positionals: [{ name: "OBJECTIVE", param: "id", required: true }],
		request: (params) => ({ method: "POST", path: `/objectives/${objectiveSegment(text(params, "id"))}/resume` }),
	},
	{
		path: ["objective", "done"],
		usage: "pana objective done OBJECTIVE",
		summary: "Finish an objective whose metrics are all at target",
		flags: [],
		positionals: [{ name: "OBJECTIVE", param: "id", required: true }],
		request: (params) => ({ method: "POST", path: `/objectives/${objectiveSegment(text(params, "id"))}/done` }),
	},
	{
		path: ["objective", "archive"],
		usage: "pana objective archive OBJECTIVE",
		summary: "Archive a stopped or done objective and its member sessions",
		flags: [],
		positionals: [{ name: "OBJECTIVE", param: "id", required: true }],
		request: (params) => ({ method: "POST", path: `/objectives/${objectiveSegment(text(params, "id"))}/archive` }),
	},
	{
		path: ["objective", "charter", "set"],
		usage: "pana objective charter set OBJECTIVE --section SECTION (--body TEXT | --body-file PATH | --body -)",
		summary: "Append a charter revision; a session may write only Notes",
		flags: [string("section", "--section SECTION", "Scope, Cancel, Done, Guidance, Escalation, or Notes", { required: true }), string("base-rev", "--base-rev N", "The charter revision you read"), ...BODY_FLAGS],
		positionals: [{ name: "OBJECTIVE", param: "id", required: true }],
		needsBody: true,
		request: (params) => ({
			method: "POST",
			path: `/objectives/${objectiveSegment(text(params, "id"))}/charter`,
			body: compact({ section: text(params, "section"), body: text(params, "body"), baseRev: numberParam(params, "base-rev") }),
		}),
	},
	{
		path: ["objective", "charter", "log"],
		usage: "pana objective charter log OBJECTIVE [--section SECTION]",
		summary: "List charter revisions with author and time",
		flags: [string("section", "--section SECTION", "Only this section's revisions")],
		positionals: [{ name: "OBJECTIVE", param: "id", required: true }],
		request: (params) => ({
			method: "GET",
			path: `/objectives/${objectiveSegment(text(params, "id"))}/charter`,
			query: { section: text(params, "section") },
		}),
	},
	{
		path: ["objective", "metric", "add"],
		usage: "pana objective metric add OBJECTIVE --name NAME --unit UNIT --direction up|down",
		altUsage: ["pana objective metric add OBJECTIVE --name NAME --unit UNIT --direction up|down --target N --check COMMAND --check-every DURATION"],
		summary: "Declare a metric, with an optional target and check",
		flags: [
			string("name", "--name NAME", "The metric's slug: [a-z0-9-], 1 to 40", { required: true }),
			string("unit", "--unit UNIT", "The unit every value is rendered with", { required: true }),
			string("direction", "--direction up|down", "Which way is progress", { required: true }),
			string("target", "--target N", "The value that finishes the metric; omitted, it is infinite"),
			string("aggregation", "--aggregation raw|mean", "Latest reading, or a trailing mean"),
			string("window", "--window WINDOW", "The trailing window for a mean, such as 7d"),
			string("check", "--check COMMAND", "Read the value from the world instead of trusting the lead"),
			string("check-cwd", "--check-cwd DIR", "Absolute directory the check runs in"),
			string("check-every", "--check-every DURATION", "Run the check every this long, such as 1d"),
			string("check-cron", "--check-cron CRON", "Run the check on a cron schedule"),
		],
		positionals: [{ name: "OBJECTIVE", param: "id", required: true }],
		request: (params) => ({
			method: "POST",
			path: `/objectives/${objectiveSegment(text(params, "id"))}/metrics`,
			body: compact({
				name: text(params, "name"),
				unit: text(params, "unit"),
				direction: text(params, "direction"),
				target: numberParam(params, "target"),
				aggregation: text(params, "aggregation"),
				window: text(params, "window"),
				check: text(params, "check"),
				checkCwd: text(params, "check-cwd"),
				checkEvery: text(params, "check-every"),
				checkCron: text(params, "check-cron"),
			}),
		}),
	},
	{
		path: ["objective", "metric", "list"],
		usage: "pana objective metric list OBJECTIVE",
		summary: "Show each metric's readings, target, and current value",
		flags: [],
		positionals: [{ name: "OBJECTIVE", param: "id", required: true }],
		request: (params) => ({ method: "GET", path: `/objectives/${objectiveSegment(text(params, "id"))}/metrics` }),
	},
	{
		path: ["objective", "metric", "set"],
		usage: "pana objective metric set OBJECTIVE --name NAME --value V [--source S]",
		summary: "Append a reading to a metric",
		flags: [
			string("name", "--name NAME", "The metric's name", { required: true }),
			string("value", "--value V", "The reading; must be numeric", { required: true }),
			string("source", "--source S", "Where the value came from: lead, user, or check"),
		],
		positionals: [{ name: "OBJECTIVE", param: "id", required: true }],
		request: (params) => ({
			method: "POST",
			path: `/objectives/${objectiveSegment(text(params, "id"))}/metrics/${encodeURIComponent(text(params, "name") ?? "")}/readings`,
			body: compact({ value: numberParam(params, "value"), source: text(params, "source") }),
		}),
	},
	{
		path: ["objective", "metric", "target"],
		usage: "pana objective metric target OBJECTIVE --name NAME [--target N]",
		summary: "Set or remove a metric's target; you only, and recorded as an event",
		flags: [
			string("name", "--name NAME", "The metric's name", { required: true }),
			string("target", "--target N", "The value that finishes the metric; omit to make it infinite"),
		],
		positionals: [{ name: "OBJECTIVE", param: "id", required: true }],
		request: (params) => ({
			method: "POST",
			path: `/objectives/${objectiveSegment(text(params, "id"))}/metrics/${encodeURIComponent(text(params, "name") ?? "")}`,
			// Omitted, --target removes the target and the metric is infinite again (OBJ-29).
			body: { target: numberParam(params, "target") ?? null },
		}),
	},
	{
		path: ["objective", "brief"],
		usage: "pana objective brief [OBJECTIVE]",
		summary: "Print the lead's briefing",
		flags: [],
		positionals: [{ name: "OBJECTIVE", param: "id" }],
		request: (params) => ({ method: "GET", path: `/objectives/${objectiveSegment(text(params, "id"))}/brief` }),
	},
	{
		path: ["objective", "report"],
		usage: "pana objective report OBJECTIVE (--body TEXT | --body-file PATH | --body -)",
		summary: "Post a report in the objective's thread",
		flags: [...BODY_FLAGS],
		positionals: [{ name: "OBJECTIVE", param: "id", required: true }],
		needsBody: true,
		request: (params) => ({
			method: "POST",
			path: `/objectives/${objectiveSegment(text(params, "id"))}/report`,
			body: { body: text(params, "body") },
		}),
	},
	{
		path: ["objective", "escalate"],
		usage: "pana objective escalate OBJECTIVE (--body TEXT | --body-file PATH | --body -) [--member SESSION]",
		summary: "Ask the user to decide; holds the runs this escalation covers",
		flags: [string("member", "--member SESSION", "Hold only this member's work, not the whole objective"), ...BODY_FLAGS],
		positionals: [{ name: "OBJECTIVE", param: "id", required: true }],
		needsBody: true,
		request: (params) => ({
			method: "POST",
			path: `/objectives/${objectiveSegment(text(params, "id"))}/escalate`,
			body: compact({ body: text(params, "body"), member: text(params, "member") }),
		}),
	},
	{
		path: ["objective", "regenerate-lead"],
		usage: "pana objective regenerate-lead OBJECTIVE --reason TEXT",
		summary: "Replace a failed lead and hand the new one the briefing",
		flags: [string("reason", "--reason TEXT", "Why the lead is being replaced", { required: true })],
		positionals: [{ name: "OBJECTIVE", param: "id", required: true }],
		request: (params) => ({
			method: "POST",
			path: `/objectives/${objectiveSegment(text(params, "id"))}/regenerate-lead`,
			body: { reason: text(params, "reason") },
		}),
	},
	{
		path: ["objective", "artifact", "add"],
		usage: "pana objective artifact add OBJECTIVE PATH",
		summary: "Upload a file and link it to the objective",
		flags: [],
		positionals: [
			{ name: "OBJECTIVE", param: "id", required: true },
			{ name: "PATH", param: "path", required: true },
		],
		// OBJ-31: the file goes through `POST /files` (FIL-01..FIL-07 unchanged) and the route only
		// links the id, so panad never reads a path from a client.
		uploads: "path",
		validate: (params) => (text(params, "path") ? undefined : "give a PATH to upload"),
		request: (params) => ({
			method: "POST",
			path: `/objectives/${objectiveSegment(text(params, "id"))}/artifacts`,
			body: { file: uploaded(params)?.id },
		}),
	},
	{
		path: ["objective", "artifact", "remove"],
		usage: "pana objective artifact remove OBJECTIVE ID",
		summary: "Unlink an artifact without deleting the file",
		flags: [],
		positionals: [
			{ name: "OBJECTIVE", param: "id", required: true },
			{ name: "ID", param: "file", required: true },
		],
		request: (params) => ({
			method: "DELETE",
			path: `/objectives/${objectiveSegment(text(params, "id"))}/artifacts/${encodeURIComponent(text(params, "file") ?? "")}`,
		}),
	},
];

/** The one file `uploads` put in `params.files`, when the CLI ran the command. */
function uploaded(params: CommandParams): FileAttachment | undefined {
	const value = params.files;
	return Array.isArray(value) ? (value as FileAttachment[])[0] : undefined;
}

/** A numeric flag: passed through as a number so the API sees a number, never a numeric string. */
function numberParam(params: CommandParams, name: string): number | undefined {
	const value = text(params, name);
	if (value === undefined || value.trim() === "") return undefined;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) throw new CommandUsageError(`--${name} must be a number, got ${value}`);
	return parsed;
}
