// The pana CLI (CLI-01..07).
//
// It talks only to the Unix socket (CLI-01), sends the caller from `PANA_SESSION` (CLI-02),
// renders text on a TTY and JSON otherwise (CLI-03), maps API statuses to exit codes (CLI-05,
// API-02), and exits 2 with a usage line for a bad invocation (CLI-04, CLI-07).

import { homedir } from "node:os";
import { join } from "node:path";
import { request, type ApiResponse } from "../api/client.ts";
import { statusToExitCode } from "../api/errors.ts";
import { statePaths } from "../config/index.ts";
import { parseArgv, resolveFlags, resolvePositionals, UsageError } from "./args.ts";
import { ApiResponseError } from "./body.ts";
import { COMMANDS, findCommand, isKnownPath, type CommandContext } from "./commands.ts";
import { renderHelp } from "./help.ts";
import { renderJson, renderText } from "./output.ts";

export interface CliIo {
	env: Record<string, string | undefined>;
	stdin: AsyncIterable<Buffer | string>;
	stdout: { write(chunk: string): unknown; isTTY?: boolean };
	stderr: { write(chunk: string): unknown; isTTY?: boolean };
	/** Skip state-directory resolution; tests point this at a panad socket. */
	socketPath?: string;
}

/** panad could not be reached on the socket (CLI-01). */
class PanadNotRunning extends Error {
	constructor(cause: unknown) {
		super("panad is not running");
		this.name = "PanadNotRunning";
		this.cause = cause;
	}
}

const CONNECTION_CODES = new Set(["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE", "EACCES"]);

function defaultIo(): CliIo {
	return { env: process.env, stdin: process.stdin, stdout: process.stdout, stderr: process.stderr };
}

function stateDirFrom(env: Record<string, string | undefined>): string {
	const override = env.PANA_STATE;
	return override && override.length > 0 ? override : join(homedir(), ".local", "state", "pana");
}

/** The caller for `Pana-Caller` (CLI-02). Absent `PANA_SESSION` means the configured user. */
function callerFrom(env: Record<string, string | undefined>): string | undefined {
	const value = env.PANA_SESSION;
	return value !== undefined && value.length > 0 ? value : undefined;
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

function errorMessage(body: unknown): string | undefined {
	if (typeof body !== "object" || body === null) return undefined;
	const error = (body as { error?: { message?: unknown } }).error;
	return error && typeof error.message === "string" ? error.message : undefined;
}

function usageLine(argv: readonly string[]): string {
	const path: string[] = [];
	for (const token of argv) {
		if (token.startsWith("-")) break;
		path.push(token);
	}
	const command = findCommand(COMMANDS, path);
	return command?.usage ?? "Usage: pana <noun> <command> [options]";
}

/** The CLI entry point. Returns the process exit code. */
export async function main(argv: readonly string[], overrides: Partial<CliIo> = {}): Promise<number> {
	const io: CliIo = { ...defaultIo(), ...overrides };
	const json = argv.includes("--json") || io.stdout.isTTY !== true;
	const socketPath = io.socketPath ?? statePaths(stateDirFrom(io.env)).socket;

	const call = async (
		method: string,
		path: string,
		options: { body?: unknown; bytes?: Uint8Array; headers?: Record<string, string>; query?: Record<string, string | undefined> } = {},
	): Promise<ApiResponse> => {
		try {
			return await request({ socketPath }, method, withQuery(path, options.query), {
				body: options.body,
				bytes: options.bytes,
				headers: options.headers,
				caller: callerFrom(io.env),
			});
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code && CONNECTION_CODES.has(code)) throw new PanadNotRunning(error);
			throw error;
		}
	};

	try {
		const parsed = parseArgv(argv, COMMANDS);
		if (parsed.help) {
			// A word before any command is a command someone mistyped, not a topic for help.
			const typed =
				parsed.path.length === 0 && parsed.positionals.length > 0 ? [parsed.positionals[0]!] : parsed.path;
			if (!isKnownPath(COMMANDS, typed)) throw new UsageError(`unknown command: pana ${typed.join(" ")}`);
			io.stdout.write(renderHelp(COMMANDS, parsed.path));
			return 0;
		}
		const command = findCommand(COMMANDS, parsed.path);
		if (!command) {
			const typed = [...parsed.path, ...(parsed.positionals.length > 0 ? [parsed.positionals[0]!] : [])];
			if (typed.length === 0) throw new UsageError("a command is required");
			const written = typed.join(" ");
			if (isKnownPath(COMMANDS, typed)) throw new UsageError(`pana ${written} needs a command`);
			throw new UsageError(`unknown command: pana ${written}`);
		}
		const flags = resolveFlags(command, parsed.flags);
		const positionals = resolvePositionals(command, parsed.positionals);
		const ctx: CommandContext = {
			flags,
			positionals,
			caller: callerFrom(io.env),
			stdin: io.stdin,
			call: (method, path, options) => call(method, path, options),
		};

		const response = await command.run(ctx);
		if (response.status < 200 || response.status >= 300) return fail(io, response, json);
		io.stdout.write(json ? renderJson(response.body) : renderText(response.body));
		return 0;
	} catch (error) {
		if (error instanceof ApiResponseError) return fail(io, error.response, json);
		if (error instanceof PanadNotRunning) {
			io.stderr.write("pana: panad is not running\n");
			return 1;
		}
		if (error instanceof UsageError) {
			io.stderr.write(`pana: ${error.message}\nusage: ${usageLine(argv)}\n`);
			return 2;
		}
		io.stderr.write(`pana: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}

/** Print an API error and map its status to an exit code (CLI-05, API-02). */
function fail(io: CliIo, response: ApiResponse, json: boolean): number {
	if (json) {
		const body = response.body ?? { error: { code: "http_error", message: `status ${response.status}` } };
		io.stderr.write(renderJson(body));
	} else {
		io.stderr.write(`pana: ${errorMessage(response.body) ?? `request failed with status ${response.status}`}\n`);
	}
	return statusToExitCode(response.status);
}
