// The `s` secrets store, reachable from the Settings page (SET-05).
//
// pana keeps no secrets of its own. `s` (https://github.com/tobi/s) owns the encrypted store at
// `~/.config/senv/senv`, and that is the store a session already reads with
// `s NAME -- command`. The page is a phone-friendly writer for it: pana lists the names, and
// passes a name with its value to `s` on stdin. A value never enters argv, so it does not show
// up in `ps`, and pana never reads one back: `s get` refuses to answer without a TTY, and
// nothing here needs to know a value.
//
// `s` needs the store password and panad has no terminal. Under `bin/panad-service`, panad is a
// child of `s KEYS -- panad`, which strips `S_KEY` and `S_FILE` from panad's environment and
// passes `S_KEY_COMMAND` through. So the password comes from `S_KEY_COMMAND` and that is the
// only key source this code relies on; the child inherits the environment as it is.
//
// One write race is not pana's to close: `s` writes its whole store through a temporary file and
// a rename, with no lock. pana serialises its own calls, so two page writes cannot interleave,
// but a terminal `s set` that lands inside pana's read-rename window is overwritten. That window
// is milliseconds.

import type { SetTimer } from "@earendil-works/pi-durable";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SecretStore {
	/** Stored names, never values. */
	list(): Promise<string[]>;
	/** Add or replace one secret. */
	set(name: string, value: string): Promise<void>;
	remove(name: string): Promise<void>;
}

export type SecretsErrorCode =
	| "invalid_name"
	| "invalid_value"
	| "not_found"
	| "unavailable"
	/** More calls are already waiting on `s` than the store will hold. */
	| "busy"
	| "failed";

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

/** The longest `s` message that reaches the page. A future `s` must not be able to dump output there. */
const MAX_DETAIL = 300;

/** The reason a name is unusable, or undefined when it is fine. */
export function secretNameError(name: unknown): string | undefined {
	if (typeof name !== "string" || name.length === 0) return "a secret needs a name";
	if (name.length > MAX_NAME_LENGTH) return `a secret name is at most ${MAX_NAME_LENGTH} characters`;
	if (!NAME.test(name)) return "a secret name starts with a letter or underscore and holds only letters, digits, and underscores";
	return undefined;
}

/** What `s --stdin` stores: trailing newlines are dropped, everything else is kept. */
export function withoutTrailingNewlines(value: string): string {
	return value.replace(/[\r\n]+$/, "");
}

/** The reason a value is unusable, or undefined when it is fine. */
export function secretValueError(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0) return "a secret needs a value";
	if (Buffer.byteLength(value) > MAX_VALUE_BYTES) return `a secret value is at most ${MAX_VALUE_BYTES} bytes`;
	if (value.includes("\0")) return "a secret value cannot hold a NUL byte";
	// `s --stdin` strips trailing newlines, so this is the value it would store.
	if (withoutTrailingNewlines(value).length === 0) return "a secret needs a value";
	return undefined;
}

export interface SenvStoreOptions {
	/** The `s` executable. Default `s`, resolved on panad's PATH. */
	command?: string;
	/** How long one `s` call may take before it and the command it runs are killed. */
	timeoutMs?: number;
	/** Environment for the child. Default: panad's own, which carries `S_KEY_COMMAND`. */
	env?: NodeJS.ProcessEnv;
	/** Calls allowed to wait on `s` before the store refuses with `busy`. */
	maxQueued?: number;
	/** The runtime's timer, so a fake clock drives the timeout (CONTRIBUTING). */
	setTimer?: SetTimer;
}

interface RunResult {
	stdout: string;
	stderr: string;
}

/** The environment an `s` child gets: panad's own, with the global store pinned when it exists. */
export function senvChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const child: NodeJS.ProcessEnv = { ...env };
	// `s` prefers a `./.senv` in its cwd over the global store, and panad's cwd is the user's home.
	// Pinning the file the page is documented to write keeps a stray `s init` in `$HOME` from
	// silently taking over. An explicit `S_FILE` wins; a machine with no global store is left as
	// `s` found the machine.
	if (!child.S_FILE) {
		const global = join(child.HOME ?? homedir(), ".config", "senv", "senv");
		if (existsSync(global)) child.S_FILE = global;
	}
	return child;
}

/** Run `s` once, optionally writing `input` to its stdin, and resolve with what it printed. */
function run(
	command: string,
	args: string[],
	input: string | undefined,
	options: { timeoutMs: number; env: NodeJS.ProcessEnv; setTimer: SetTimer },
): Promise<RunResult> {
	const { timeoutMs, env, setTimer } = options;
	return new Promise((resolve, reject) => {
		let child;
		try {
			// Its own process group, so the kill reaches the `S_KEY_COMMAND` child too: on macOS a
			// locked keychain leaves `security find-generic-password` waiting behind `s`.
			child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env, detached: true });
		} catch (error) {
			reject(new SecretsError("unavailable", `${command} could not run: ${(error as Error).message}`));
			return;
		}
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		let settled = false;
		let cancelTimer: (() => void) | undefined;
		const finish = (error: SecretsError | undefined, result?: RunResult) => {
			if (settled) return;
			settled = true;
			cancelTimer?.();
			if (error) reject(error);
			else resolve(result!);
		};
		const kill = () => {
			try {
				if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
			} catch {
				// The group is already gone, or the platform refused it; the direct kill is a fallback.
				child.kill("SIGKILL");
			}
		};
		// `s` only talks to its store, but a locked keychain or a hung secret store would
		// otherwise hold the request open until the client gave up.
		cancelTimer = setTimer(() => {
			kill();
			finish(new SecretsError("failed", `${command} did not answer within ${Math.round(timeoutMs / 1000)}s`));
		}, timeoutMs, { background: true });
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

/** The one line of `s` output worth showing: the error, capped, never the whole transcript. */
function detailLine(stderr: string): string | undefined {
	const lines = stderr.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
	// `s` prints its reason on the `error:` line and advice below it. The reason is the part that
	// helps; the advice is written for a terminal.
	const reason = lines.find((line) => /^error:/i.test(line)) ?? lines[0];
	return reason?.replace(/^error:\s*/i, "").slice(0, MAX_DETAIL);
}

/** Name the reason `s` refused, using its own words when it has any. */
function failure(stderr: string, code: number | null, signal: NodeJS.Signals | null, command: string): SecretsError {
	const detail = detailLine(stderr);
	if (detail && /not found/i.test(detail)) return new SecretsError("not_found", detail);
	// `s` has its own name rules and a denylist of names that would rewrite its child's
	// environment (PATH, LD_PRELOAD, S_KEY_COMMAND, ...). Both are the caller's mistake, not a
	// broken store.
	if (detail && /unsafe env name|invalid key/i.test(detail)) return new SecretsError("invalid_name", detail);
	if (detail) return new SecretsError("failed", detail);
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
	const env = options.env ?? senvChildEnv();
	const setTimer: SetTimer =
		options.setTimer ??
		((callback, delayMs) => {
			const timer = setTimeout(callback, Math.max(0, delayMs));
			return () => clearTimeout(timer);
		});
	const maxQueued = Math.max(0, options.maxQueued ?? 4);
	let pending = 0;
	let queue: Promise<unknown> = Promise.resolve();
	const serial = <T>(work: () => Promise<T>): Promise<T> => {
		// A stolen token or a stuck keychain must not pile up 15-second children without bound.
		if (pending >= maxQueued + 1) return Promise.reject(new SecretsError("busy", "too many secret calls are already waiting on s"));
		pending += 1;
		const next = queue.then(work, work);
		queue = next.then(
			() => { pending -= 1; },
			() => { pending -= 1; },
		);
		return next;
	};
	return {
		list: () => serial(async () => parseNames((await run(command, ["list", "--json"], undefined, { timeoutMs, env, setTimer })).stdout)),
		set: (name, value) =>
			serial(async () => {
				const nameProblem = secretNameError(name);
				if (nameProblem) throw new SecretsError("invalid_name", nameProblem);
				const valueProblem = secretValueError(value);
				if (valueProblem) throw new SecretsError("invalid_value", valueProblem);
				// `-f` so one path adds and replaces; the value goes on stdin, never in argv.
				await run(command, ["set", "-f", name, "--stdin"], withoutTrailingNewlines(value), { timeoutMs, env, setTimer });
			}),
		remove: (name) =>
			serial(async () => {
				const nameProblem = secretNameError(name);
				if (nameProblem) throw new SecretsError("invalid_name", nameProblem);
				await run(command, ["rm", name], undefined, { timeoutMs, env, setTimer });
			}),
	};
}
