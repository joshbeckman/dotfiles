// The `s` secrets store, reachable from the Settings page (SET-05).
//
// pana keeps no secrets of its own. `s` (https://github.com/tobi/s) owns the encrypted store at
// `~/.config/senv/senv`, and that is the store a session already reads with
// `s NAME -- command`. The page is a phone-friendly writer for it: pana lists the names, and
// passes a name with its value to `s` on stdin. A value never enters argv, so it does not show
// up in `ps`, and pana never reads one back: `s get` refuses to answer without a TTY, and
// nothing here needs to know a value.
//
// `s` needs the store password and panad has no terminal. It comes from `S_KEY_COMMAND` (or
// `S_KEY`) in panad's own environment, exported by `bin/panad-service`; the child inherits it
// and nothing else is added.

import { spawn } from "node:child_process";

export interface SecretStore {
	/** Stored names, never values. */
	list(): Promise<string[]>;
	/** Add or replace one secret. */
	set(name: string, value: string): Promise<void>;
	remove(name: string): Promise<void>;
}

export type SecretsErrorCode = "invalid_name" | "invalid_value" | "not_found" | "unavailable" | "failed";

/** A refusal from the store, with a code the handler turns into a status. */
export class SecretsError extends Error {
	readonly code: SecretsErrorCode;
	constructor(code: SecretsErrorCode, message: string) {
		super(message);
		this.name = "SecretsError";
		this.code = code;
	}
}

/** `s` stores env-style keys: a letter or underscore, then letters, digits, or underscores. */
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Long enough for a PEM key, short enough that a body limit is not the thing that refuses it. */
export const MAX_VALUE_BYTES = 64 * 1024;

const MAX_NAME_LENGTH = 128;

/** The reason a name is unusable, or undefined when it is fine. */
export function secretNameError(name: unknown): string | undefined {
	if (typeof name !== "string" || name.length === 0) return "a secret needs a name";
	if (name.length > MAX_NAME_LENGTH) return `a secret name is at most ${MAX_NAME_LENGTH} characters`;
	if (!NAME.test(name)) return "a secret name starts with a letter or underscore and holds only letters, digits, and underscores";
	return undefined;
}

/** The reason a value is unusable, or undefined when it is fine. */
export function secretValueError(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0) return "a secret needs a value";
	if (Buffer.byteLength(value) > MAX_VALUE_BYTES) return `a secret value is at most ${MAX_VALUE_BYTES} bytes`;
	if (value.includes("\0")) return "a secret value cannot hold a NUL byte";
	return undefined;
}

export interface SenvStoreOptions {
	/** The `s` executable. Default `s`, resolved on panad's PATH. */
	command?: string;
	/** How long one `s` call may take before it is killed. */
	timeoutMs?: number;
	/** Environment for the child. Default: panad's own, which carries `S_KEY_COMMAND`. */
	env?: NodeJS.ProcessEnv;
}

interface RunResult {
	stdout: string;
	stderr: string;
}

/** Run `s` once, optionally writing `input` to its stdin, and resolve with what it printed. */
function run(command: string, args: string[], input: string | undefined, timeoutMs: number, env: NodeJS.ProcessEnv): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		let child;
		try {
			child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env });
		} catch (error) {
			reject(new SecretsError("unavailable", `${command} could not run: ${(error as Error).message}`));
			return;
		}
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		let settled = false;
		const finish = (error: SecretsError | undefined, result?: RunResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error) reject(error);
			else resolve(result!);
		};
		// `s` only talks to its store, but a locked keychain or a hung secret store would
		// otherwise hold the request open until the client gave up.
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(new SecretsError("failed", `${command} did not answer within ${Math.round(timeoutMs / 1000)}s`));
		}, timeoutMs);
		child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
		child.on("error", (error: NodeJS.ErrnoException) => {
			finish(error.code === "ENOENT"
				? new SecretsError("unavailable", `${command} is not installed where panad can run it`)
				: new SecretsError("failed", `${command} could not run: ${error.message}`));
		});
		child.on("close", (code, signal) => {
			const stdout = Buffer.concat(out).toString("utf8");
			const stderr = Buffer.concat(err).toString("utf8");
			if (code === 0) finish(undefined, { stdout, stderr });
			else finish(failure(stderr, code, signal, command));
		});
		child.stdin.on("error", () => {
			// A command that exits before reading stdin closes the pipe; its exit code is the
			// answer, so an EPIPE here is not a second failure.
		});
		child.stdin.end(input ?? "");
	});
}

/** Name the reason `s` refused, using its own words when it has any. */
function failure(stderr: string, code: number | null, signal: NodeJS.Signals | null, command: string): SecretsError {
	const detail = stderr.trim().split("\n").filter((line) => line.trim().length > 0).pop();
	if (detail && /not found/i.test(detail)) return new SecretsError("not_found", detail.replace(/^error:\s*/i, ""));
	if (detail) return new SecretsError("failed", detail.replace(/^error:\s*/i, ""));
	return new SecretsError("failed", `${command} exited with ${signal ? `signal ${signal}` : `code ${code}`}`);
}

/** Parse `s list --json`: a JSON array of names. */
export function parseNames(stdout: string): string[] {
	const text = stdout.trim();
	if (text.length === 0) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new SecretsError("failed", "could not read the secret list that s printed");
	}
	if (!Array.isArray(parsed) || parsed.some((name) => typeof name !== "string")) {
		throw new SecretsError("failed", "could not read the secret list that s printed");
	}
	return (parsed as string[]).sort((a, b) => a.localeCompare(b));
}

/** An `s`-backed store. Calls run one at a time: `s` rewrites its whole store on each write. */
export function createSenvStore(options: SenvStoreOptions = {}): SecretStore {
	const command = options.command ?? "s";
	const timeoutMs = options.timeoutMs ?? 15_000;
	const env = options.env ?? process.env;
	let queue: Promise<unknown> = Promise.resolve();
	const serial = <T>(work: () => Promise<T>): Promise<T> => {
		const next = queue.then(work, work);
		queue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	};
	return {
		list: () => serial(async () => parseNames((await run(command, ["list", "--json"], undefined, timeoutMs, env)).stdout)),
		set: (name, value) =>
			serial(async () => {
				const nameProblem = secretNameError(name);
				if (nameProblem) throw new SecretsError("invalid_name", nameProblem);
				const valueProblem = secretValueError(value);
				if (valueProblem) throw new SecretsError("invalid_value", valueProblem);
				// `-f` so one path adds and replaces; the value goes on stdin, never in argv.
				await run(command, ["set", "-f", name, "--stdin"], value, timeoutMs, env);
			}),
		remove: (name) =>
			serial(async () => {
				const nameProblem = secretNameError(name);
				if (nameProblem) throw new SecretsError("invalid_name", nameProblem);
				await run(command, ["rm", name], undefined, timeoutMs, env);
			}),
	};
}
