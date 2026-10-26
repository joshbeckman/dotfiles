// The six pana commands, defined once. A pana tool wraps one command with the same
// arguments, the same API request, and the same exit code as the CLI (TOL-02, TOL-03).
// The `pana` CLI (WP1) runs the same commands through `runPanaCli`.

import { readFileSync } from "node:fs";
import { request, type Endpoint } from "../api/client.ts";
import { statusToExitCode } from "../api/errors.ts";
import type { Method } from "../api/routes.ts";

export type PanaCommandName =
	| "thread respond"
	| "thread read"
	| "thread create"
	| "session create"
	| "memory search"
	| "memory commit";

export type PanaToolName =
	| "pana_reply"
	| "pana_thread_read"
	| "pana_thread_create"
	| "pana_session_create"
	| "pana_memory_search"
	| "pana_memory_commit";

/** Tool arguments and CLI flags, after validation. A command reads only the keys it declares. */
export interface CommandParams {
	[key: string]: string | string[] | undefined;
}

export interface CommandRequest {
	method: Method;
	path: string;
	body?: Record<string, unknown>;
}

/** A bad invocation: the CLI exits 2 for it (API-02). */
export class CommandUsageError extends Error {
	readonly exitCode = 2;
	constructor(message: string) {
		super(message);
		this.name = "CommandUsageError";
	}
}

export interface CommandDef {
	readonly command: PanaCommandName;
	readonly tool: PanaToolName;
	readonly usage: string;
	/** Parse CLI arguments into the same params the tool receives. Throws `CommandUsageError`. */
	parse(argv: string[]): CommandParams;
	/** A usage problem the tool and the CLI both reject with exit code 2, such as a missing choice. */
	validate?(params: CommandParams): string | undefined;
	request(params: CommandParams): CommandRequest;
}

interface ParsedArgs {
	flags: Record<string, string | true>;
	positionals: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
	const flags: Record<string, string | true> = {};
	const positionals: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--") {
			positionals.push(...argv.slice(i + 1));
			break;
		}
		if (!arg.startsWith("-") || arg === "-") {
			positionals.push(arg);
			continue;
		}
		const equals = arg.indexOf("=");
		if (equals !== -1) {
			flags[arg.slice(0, equals)] = arg.slice(equals + 1);
			continue;
		}
		const next = argv[i + 1];
		if (next !== undefined && !next.startsWith("-")) {
			flags[arg] = next;
			i++;
			continue;
		}
		flags[arg] = true;
	}
	return { flags, positionals };
}

function take(flags: ParsedArgs["flags"], name: string): string | undefined {
	const value = flags[name];
	if (value === true) throw new CommandUsageError(`${name} needs a value`);
	return value;
}

function required(flags: ParsedArgs["flags"], name: string): string {
	const value = take(flags, name);
	if (value === undefined || value === "") throw new CommandUsageError(`missing required ${name}`);
	return value;
}

/** `--body TEXT`, `--body-file PATH`, or `--body -` for stdin. */
function body(flags: ParsedArgs["flags"]): string {
	const text = take(flags, "--body");
	const file = take(flags, "--body-file");
	if (text !== undefined && file !== undefined) throw new CommandUsageError("use either --body or --body-file");
	if (text === undefined && file === undefined) throw new CommandUsageError("missing --body or --body-file");
	if (file === undefined) return text === "-" ? readFileSync(0, "utf8") : text!;
	if (file === "-") throw new CommandUsageError("--body-file takes a path; use --body - for stdin");
	return readFileSync(file, "utf8");
}

function list(value: string | string[] | undefined): string[] {
	if (value === undefined) return [];
	const parts = Array.isArray(value) ? value : [value];
	return parts
		.flatMap((part) => part.split(","))
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}

function addressList(flags: ParsedArgs["flags"], name: string): string[] | undefined {
	const value = take(flags, name);
	if (value === undefined) return undefined;
	const addresses = list(value);
	if (addresses.length === 0) throw new CommandUsageError(`${name} needs at least one address`);
	return addresses;
}

function onlyFlags(parsed: ParsedArgs): void {
	if (parsed.positionals.length > 0) {
		throw new CommandUsageError(`unexpected argument: ${parsed.positionals[0]}`);
	}
}

function singlePositional(parsed: ParsedArgs, name: string): string {
	if (parsed.positionals.length !== 1) throw new CommandUsageError(`missing ${name}`);
	return parsed.positionals[0]!;
}

const DEFS: Record<PanaCommandName, CommandDef> = {
	"thread respond": {
		command: "thread respond",
		tool: "pana_reply",
		usage: "thread respond --thread THREAD --after MESSAGE (--body TEXT | --body-file PATH) [--cc ADDRS]",
		parse: (argv) => {
			const parsed = parseArgs(argv);
			onlyFlags(parsed);
			const cc = addressList(parsed.flags, "--cc");
			return {
				thread: required(parsed.flags, "--thread"),
				after: required(parsed.flags, "--after"),
				body: body(parsed.flags),
				...(cc === undefined ? {} : { cc }),
			};
		},
		request: (params) => ({
			method: "POST",
			path: `/threads/${encodeURIComponent(String(params.thread))}/messages`,
			body: { after: params.after, body: params.body, ...(params.cc === undefined ? {} : { cc: params.cc }) },
		}),
	},
	"thread read": {
		command: "thread read",
		tool: "pana_thread_read",
		usage: "thread read THREAD | thread read --message MESSAGE",
		parse: (argv) => {
			const parsed = parseArgs(argv);
			const message = take(parsed.flags, "--message");
			if (message !== undefined) {
				onlyFlags(parsed);
				return { message };
			}
			return { thread: singlePositional(parsed, "THREAD") };
		},
		validate: (params) =>
			(params.thread === undefined) === (params.message === undefined)
				? "give either a THREAD or --message MESSAGE"
				: undefined,
		request: (params) => {
			if (params.message !== undefined) return { method: "GET", path: `/messages/${encodeURIComponent(String(params.message))}` };
			return { method: "GET", path: `/threads/${encodeURIComponent(String(params.thread))}` };
		},
	},
	"thread create": {
		command: "thread create",
		tool: "pana_thread_create",
		usage: "thread create --to ADDRS (--body TEXT | --body-file PATH)",
		parse: (argv) => {
			const parsed = parseArgs(argv);
			onlyFlags(parsed);
			const to = addressList(parsed.flags, "--to");
			if (to === undefined) throw new CommandUsageError("missing required --to");
			return { to, body: body(parsed.flags) };
		},
		request: (params) => ({ method: "POST", path: "/threads", body: { to: list(params.to), body: params.body } }),
	},
	"session create": {
		command: "session create",
		tool: "pana_session_create",
		usage: "session create --prompt TEXT [--model M] [--thinking LEVEL] [--cwd DIR] [--profile NAME] [--to ADDRS]",
		parse: (argv) => {
			const parsed = parseArgs(argv);
			onlyFlags(parsed);
			const to = addressList(parsed.flags, "--to");
			const params: CommandParams = { prompt: required(parsed.flags, "--prompt") };
			for (const key of ["--model", "--thinking", "--cwd", "--profile"] as const) {
				const value = take(parsed.flags, key);
				if (value !== undefined) params[key.slice(2)] = value;
			}
			if (to !== undefined) params.to = to;
			return params;
		},
		request: (params) => {
			const body: Record<string, unknown> = { prompt: params.prompt };
			for (const key of ["model", "thinking", "cwd", "profile"] as const) {
				if (params[key] !== undefined) body[key] = params[key];
			}
			if (params.to !== undefined) body.to = list(params.to);
			return { method: "POST", path: "/sessions", body };
		},
	},
	"memory search": {
		command: "memory search",
		tool: "pana_memory_search",
		usage: "memory search TEXT",
		parse: (argv) => {
			const parsed = parseArgs(argv);
			const query = take(parsed.flags, "--query") ?? singlePositional(parsed, "TEXT");
			return { query };
		},
		request: (params) => ({ method: "GET", path: `/memory/search?query=${encodeURIComponent(String(params.query))}` }),
	},
	"memory commit": {
		command: "memory commit",
		tool: "pana_memory_commit",
		usage: "memory commit -m MSG",
		parse: (argv) => {
			const parsed = parseArgs(argv);
			onlyFlags(parsed);
			return { message: required(parsed.flags, "-m") };
		},
		request: (params) => ({ method: "POST", path: "/memory/commit", body: { message: params.message } }),
	},
};

export const PANA_COMMANDS = DEFS;

export function commandForTool(tool: PanaToolName): CommandDef {
	for (const def of Object.values(DEFS)) {
		if (def.tool === tool) return def;
	}
	throw new Error(`no pana command for tool ${tool}`);
}

export function isCommandName(name: string): name is PanaCommandName {
	return Object.prototype.hasOwnProperty.call(DEFS, name);
}

export interface CommandEndpoint {
	endpoint: Endpoint;
	/** The caller's session ULID, sent as `Pana-Caller`; absent means the local user. */
	caller?: string;
}

export interface CommandOutcome {
	/** The HTTP status, or 0 when panad could not be reached. */
	status: number;
	exitCode: number;
	body: unknown;
	/** The text a CLI prints with `--json`, and what a tool shows the model. */
	text: string;
	/** The error's message, when the command failed. */
	message?: string;
}

function render(body: unknown): string {
	return body === undefined ? "" : JSON.stringify(body, null, 2);
}

function errorMessage(body: unknown, status: number): string {
	if (typeof body === "object" && body !== null && "error" in body) {
		const error = (body as { error?: { message?: unknown } }).error;
		if (error && typeof error.message === "string") return error.message;
	}
	return `pana: request failed with status ${status}`;
}

/** Send one command to panad and turn the response into its CLI exit code and text. */
export async function runPanaCommand(
	command: PanaCommandName,
	params: CommandParams,
	target: CommandEndpoint,
): Promise<CommandOutcome> {
	const def = DEFS[command];
	const usageProblem = def.validate?.(params);
	if (usageProblem !== undefined) {
		return { status: 0, exitCode: 2, body: { error: { code: "usage", message: usageProblem } }, text: usageProblem, message: usageProblem };
	}
	const { method, path, body } = def.request(params);
	let response;
	try {
		response = await request(target.endpoint, method, path, { body, caller: target.caller });
	} catch (error) {
		const message = `pana: cannot reach panad: ${(error as Error).message}`;
		return { status: 0, exitCode: 1, body: { error: { code: "unreachable", message } }, text: message, message };
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

/** Run one CLI invocation: `["thread", "respond", "--thread", ...]`. */
export async function runPanaCli(argv: string[], target: CommandEndpoint): Promise<CommandOutcome> {
	const [group, verb, ...rest] = argv;
	const name = `${group ?? ""} ${verb ?? ""}`;
	if (!isCommandName(name)) throw new CommandUsageError(`unknown command: ${name.trim() || "(none)"}`);
	return runPanaCommand(name, DEFS[name].parse(rest), target);
}

export function usageFor(command: PanaCommandName): string {
	return DEFS[command].usage;
}
