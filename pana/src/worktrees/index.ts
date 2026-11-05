// Worktrees a session makes for itself (GUARD-03).
//
// The guard keeps a session out of the user's primary checkout (extension/checkouts.ts), and the
// read-only mount keeps `git worktree add` itself out of it too — the primary's `.git` is exactly
// what that command writes. So the one command a refused session needs runs here, in panad, where
// nothing is mounted read-only. Managed repositories use a machine-configured creation adapter.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { ApiError } from "../api/errors.ts";
import { realPath } from "../extension/checkouts.ts";
import { checkoutCommon, owners, saveOwner } from "./ownership.ts";
import type { Runtime } from "../server/runtime.ts";
import { generatedBranch } from "./branch.ts";

const run = promisify(execFile);

export interface AddWorktreeInput {
	/** The repository's path, or any directory inside it. */
	repo: string;
	/** The branch to create; default `pana/<session>/<name>`, with a flat fallback on collision. */
	branch?: string;
	/** Worktree name; default the repository's own name. External names include the session ID. */
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

// Serialize a destination through validation, creation and receipt publication.
const pending = new Map<string, Promise<unknown>>();

/** GUARD-03: a worktree of `input.repo` for `sessionId`, made or reused. */
export async function addWorktree(runtime: Runtime, sessionId: string, input: AddWorktreeInput): Promise<WorktreeResult> {
	const repo = await repoRoot(input.repo);
	const common = realPath(await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
	const name = safeName(input.name ?? basename(repo));
	const adapter = runtime.config?.worktreeAdapters?.find((a) => realPath(a.repo) === common);
	// External materializers commonly require lowercase IDs; use that portable form up front.
	const treeName = `pana-${safeName(sessionId)}-${name}`.toLowerCase();
	let path = adapter
		? join(realPath(adapter.root), treeName, adapter.subdir ?? "")
		: join(realPath(runtime.paths.dir), "worktrees", sessionId, name);
	if (adapter) {
		// Do not relocate a previously verified owned tree created with the old case-preserving ID.
		const legacyPath = join(realPath(adapter.root), `pana-${safeName(sessionId)}-${name}`, adapter.subdir ?? "");
		if (legacyPath !== path && (await owners(runtime.db)).some((o) =>
			o.path === legacyPath && o.session === sessionId && o.common === common && checkoutCommon(o.path) === common)) path = legacyPath;
	}
	const previous = pending.get(path) ?? Promise.resolve();
	const work = previous.catch(() => {}).then(async () => {
		if (realPath(path) !== resolve(path)) throw ApiError.badRequest("invalid_worktree", "worktree destination contains a symlink");
		const owner = (await owners(runtime.db)).find((o) => o.path === path);
		if (owner && (owner.session !== sessionId || owner.common !== common)) {
			throw ApiError.badRequest("worktree_collision", "destination belongs to another session or repository");
		}
		if (existsSync(path) && !owner && adapter) throw ApiError.badRequest("worktree_collision", `unowned destination already exists: ${path}`);
		let created = false;
		let branch = input.branch;
		if (!existsSync(path)) {
			try {
				branch ??= await generatedBranch(repo, [sessionId, name]);
			} catch (error) {
				throw ApiError.badRequest("invalid_repo", (error as { stderr?: string }).stderr?.trim() || (error as Error).message);
			}
			if (adapter) {
				const substitutions: Record<string, string> = { name: treeName, branch, path, repo };
				const argv = adapter.create.map((arg) => arg.replace(/\{(name|branch|path|repo)\}/g, (_, key: string) => substitutions[key]!));
				try {
					await run(argv[0]!, argv.slice(1), { cwd: repo, timeout: 600_000 });
				} catch (error) {
					throw ApiError.badRequest("worktree_adapter_failed", (error as { stderr?: string }).stderr?.trim() || (error as Error).message);
				}
			} else {
				mkdirSync(join(runtime.paths.dir, "worktrees", sessionId), { recursive: true });
				// A generated-name race must fail rather than join another writer's branch.
				const exists = input.branch === undefined ? "" : await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).catch(() => "");
				await git(repo, exists === "" ? ["worktree", "add", "-q", "-b", branch, path, "HEAD"] : ["worktree", "add", "-q", path, branch]);
			}
			created = true;
		}
		// A successful external command is not proof that it created the requested checkout.
		if (realPath(path) !== resolve(path) || !existsSync(join(path, ".git")) ||
			await repoRoot(path) !== path || checkoutCommon(path) !== common ||
			realPath(await git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"])) !== common) {
			throw ApiError.badRequest("invalid_worktree", "created checkout does not match the requested repository and path");
		}
		const actualBranch = await git(path, ["rev-parse", "--abbrev-ref", "HEAD"]);
		if (created && actualBranch !== branch) throw ApiError.badRequest("invalid_worktree", "adapter checked out the wrong branch");
		await saveOwner(runtime.db, { session: sessionId, path, common });
		return { session: sessionId, repo, path, branch: actualBranch, created };
	});
	pending.set(path, work);
	try { return await work; } finally { if (pending.get(path) === work) pending.delete(path); }
}
