// The pana CLI (CLI-01..07).
//
// It talks only to the Unix socket (CLI-01), sends the caller from `PANA_SESSION` (CLI-02),
// renders text on a TTY and JSON otherwise (CLI-03), maps API statuses to exit codes (CLI-05,
// API-02), and exits 2 with a usage line for a bad invocation (CLI-04, CLI-07).
//
// Every command is defined once in `commands.ts`, which the pana tools use too. This file is
// only the terminal: parse the globals, resolve the invocation, run it, and render.

import { homedir } from "node:os";
import { join } from "node:path";
import { statusToExitCode } from "../api/errors.ts";
import { statePaths } from "../config/index.ts";
import { parseArgv, UsageError } from "./args.ts";
import { ApiResponseError, uploadAttachment, type ApiCall } from "./body.ts";
import {
	callFor,
	COMMANDS,
	findCommand,
	invocationFor,
	isKnownPath,
	runPanaCommand,
	type CommandOutcome,
	type CommandSpec,
} from "./commands.ts";
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

async function drain(stream: AsyncIterable<Buffer | string>): Promise<string> {
	let out = "";
	for await (const chunk of stream) out += chunk.toString();
	return out;
}

/** The usage line for a bad invocation: the longest known command prefix names it. */
function usageLine(argv: readonly string[]): string {
	const path: string[] = [];
	for (const token of argv) {
		if (token.startsWith("-")) break;
		path.push(token);
	}
	for (let length = path.length; length > 0; length--) {
		const command = findCommand(COMMANDS, path.slice(0, length));
		if (command) return `usage: ${command.usage}`;
	}
	return "usage: Usage: pana <noun> <command> [options]";
}

/** The CLI entry point. Returns the process exit code. */
export async function main(argv: readonly string[], overrides: Partial<CliIo> = {}): Promise<number> {
	const io: CliIo = { ...defaultIo(), ...overrides };
	const json = argv.includes("--json") || io.stdout.isTTY !== true;
	const endpoint = { endpoint: { socketPath: io.socketPath ?? statePaths(stateDirFrom(io.env)).socket }, caller: callerFrom(io.env) };
	const call: ApiCall = callFor(endpoint);

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

		let spec: CommandSpec;
		let outcome: CommandOutcome;
		try {
			const invocation = await invocationFor(argv, {
				readStdin: () => drain(io.stdin),
				upload: (path: string) => uploadAttachment(call, path),
			});
			spec = invocation.spec;
			outcome = await runPanaCommand(spec.path.join(" "), invocation.params, endpoint);
		} catch (error) {
			if (error instanceof ApiResponseError) {
				if (json) io.stderr.write(renderJson(error.response.body));
				else io.stderr.write(`pana: ${apiMessage(error.response.body) ?? `request failed with status ${error.response.status}`}\n`);
				return statusToExitCode(error.response.status);
			}
			throw error;
		}

		if (outcome.exitCode === 0) {
			io.stdout.write(json ? renderJson(outcome.body) : (spec.formatText?.(outcome.body) ?? renderText(outcome.body)));
			return 0;
		}
		if (outcome.usage) {
			io.stderr.write(`pana: ${outcome.message}\n${usageLine(argv)}\n`);
			return 2;
		}
		if (outcome.status === 0) {
			io.stderr.write("pana: panad is not running\n");
			return 1;
		}
		if (json) io.stderr.write(renderJson(outcome.body ?? { error: { code: "http_error", message: outcome.message } }));
		else io.stderr.write(`pana: ${outcome.message}\n`);
		return outcome.exitCode;
	} catch (error) {
		if (error instanceof UsageError) {
			io.stderr.write(`pana: ${error.message}\n${usageLine(argv)}\n`);
			return 2;
		}
		const message = error instanceof Error ? error.message : String(error);
		io.stderr.write(`pana: ${message}\n`);
		return 1;
	}
}

function apiMessage(body: unknown): string | undefined {
	if (typeof body !== "object" || body === null) return undefined;
	const error = (body as { error?: { message?: unknown } }).error;
	return error && typeof error.message === "string" ? error.message : undefined;
}
