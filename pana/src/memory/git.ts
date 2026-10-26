// A thin, isolated wrapper around the `git` binary. Memory shells out to real git rather than
// reimplementing refs, rebase, and grep; this file keeps every call deterministic.
//
// The environment is built from scratch instead of inherited. A pana session's bash tool runs
// with its own GIT_CONFIG_* and GIT_DIR variables (HOK-01), and panad may itself be started from
// such a shell; inheriting them would point memory's git at somebody else's repo. Global and
// system config are disabled so a developer's `core.hooksPath`, `commit.gpgsign`, or identity
// cannot change a memory commit.

import { spawn } from "node:child_process";

export interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface GitOptions {
	/** Working directory. Use a worktree path, or pass `-C <repo>` in `args`. */
	cwd?: string;
	/** Extra environment variables, merged over the isolated base. */
	env?: Record<string, string>;
	/** Bytes for stdin; the stream is closed immediately when absent. */
	input?: string;
}

const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

function baseEnv(): Record<string, string> {
	const env: Record<string, string> = {
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_TERMINAL_PROMPT: "0",
		GIT_EDITOR: "true",
		GIT_SEQUENCE_EDITOR: "true",
		GIT_MERGE_AUTOEDIT: "no",
		// Byte-stable output: no localized messages, no quoted paths.
		LC_ALL: "C",
		LANG: "C",
	};
	for (const key of ["PATH", "HOME", "TMPDIR"]) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	return env;
}

/** Run git and resolve with its exit code, stdout, and stderr. Never rejects for a non-zero exit. */
export function runGit(args: string[], options: GitOptions = {}): Promise<GitResult> {
	const env = { ...baseEnv(), ...options.env };
	return new Promise((resolve, reject) => {
		const child = spawn("git", args, {
			cwd: options.cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		let size = 0;
		const collect = (chunks: Buffer[], chunk: Buffer) => {
			size += chunk.byteLength;
			if (size > MAX_OUTPUT_BYTES) {
				child.kill("SIGKILL");
				reject(new Error(`git ${args.join(" ")} produced more than ${MAX_OUTPUT_BYTES} bytes`));
				return;
			}
			chunks.push(chunk);
		};
		child.stdout.on("data", (chunk: Buffer) => collect(out, chunk));
		child.stderr.on("data", (chunk: Buffer) => collect(err, chunk));
		child.on("error", reject);
		child.on("close", (code) => {
			resolve({
				code: code ?? 1,
				stdout: Buffer.concat(out).toString("utf8"),
				stderr: Buffer.concat(err).toString("utf8"),
			});
		});
		child.stdin.on("error", () => {
			// git may exit before reading stdin; the exit code carries the failure.
		});
		if (options.input !== undefined) child.stdin.end(options.input);
		else child.stdin.end();
	});
}

/** Run git and throw with stderr when it fails. */
export async function gitOrThrow(args: string[], options: GitOptions = {}): Promise<GitResult> {
	const result = await runGit(args, options);
	if (result.code !== 0) {
		throw new Error(`git ${args.join(" ")} failed (${result.code}): ${result.stderr.trim()}`);
	}
	return result;
}
