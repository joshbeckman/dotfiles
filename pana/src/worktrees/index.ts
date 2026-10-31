// Worktrees a session makes for itself (GUARD-03).
//
// The guard keeps a session out of the user's primary checkout (extension/checkouts.ts), and the
// read-only mount keeps `git worktree add` itself out of it too — the primary's `.git` is exactly
// what that command writes. So the one command a refused session needs runs here, in panad, where
// nothing is mounted read-only: `<state>/worktrees/<session>/<repo>` on its own branch.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { ApiError } from "../api/errors.ts";
import type { Runtime } from "../server/runtime.ts";

const run = promisify(execFile);

export interface AddWorktreeInput {
	/** The repository's path, or any directory inside it. */
	repo: string;
	/** The branch to create; default `pana/<session>/<name>`. */
	branch?: string;
	/** The directory name under `<state>/worktrees/<session>`; default the repository's own name. */
	name?: string;
}

export interface WorktreeResult {
	session: string;
	repo: string;
	path: string;
	branch: string;
	/** False when the worktree was already there, so a retried call costs nothing. */
	created: boolean;
}

/** A directory name git and a shell both accept. */
function safeName(value: string): string {
	const name = value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+/, "");
	if (name === "" || name === "." || name === "..") throw ApiError.badRequest("invalid_name", "name must have letters or digits");
	return name;
}

async function git(cwd: string, args: string[]): Promise<string> {
	try {
		const { stdout } = await run("git", ["-C", cwd, ...args]);
		return stdout.trim();
	} catch (error) {
		const stderr = (error as { stderr?: string }).stderr?.trim();
		throw ApiError.badRequest("invalid_repo", stderr || (error as Error).message);
	}
}

/** The repository's top level, so `pana worktree add ~/pana` and its root name the same repo. */
async function repoRoot(repo: string): Promise<string> {
	const path = resolve(repo);
	if (!existsSync(path)) throw ApiError.badRequest("invalid_repo", `not a directory: ${repo}`);
	const top = await git(path, ["rev-parse", "--show-toplevel"]);
	if (top === "") throw ApiError.badRequest("invalid_repo", `not a git repository: ${repo}`);
	return top;
}

/** GUARD-03: a worktree of `input.repo` for `sessionId`, made or reused. */
export async function addWorktree(runtime: Runtime, sessionId: string, input: AddWorktreeInput): Promise<WorktreeResult> {
	const repo = await repoRoot(input.repo);
	const name = safeName(input.name ?? basename(repo));
	const path = join(runtime.paths.dir, "worktrees", sessionId, name);
	const branch = input.branch ?? `pana/${sessionId}/${name}`;

	if (existsSync(join(path, ".git"))) {
		return { session: sessionId, repo, path, branch: await git(path, ["rev-parse", "--abbrev-ref", "HEAD"]), created: false };
	}

	mkdirSync(join(runtime.paths.dir, "worktrees", sessionId), { recursive: true });
	const exists = await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).catch(() => "");
	// A branch that already exists is reused rather than refused: a session resuming its own work
	// asks for the same branch twice, and git refuses `-b` on an existing one.
	await git(repo, exists === "" ? ["worktree", "add", "-q", "-b", branch, path, "HEAD"] : ["worktree", "add", "-q", path, branch]);
	return { session: sessionId, repo, path, branch, created: true };
}
