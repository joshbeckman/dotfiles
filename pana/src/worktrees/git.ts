// The git this module runs on a caller-chosen repository (GUARD-03).
//
// `repo` comes from the caller, so both the path and the `.git/config` behind it are theirs. Git
// executes what that config names — hooks on `worktree add`, `core.fsmonitor` on anything that
// reads the index, and filters during checkout — as panad, with panad's environment. panad's own
// environment is no safer to hand over: `GIT_DIR`, `GIT_WORK_TREE` or `GIT_CONFIG_*` from the
// shell that started panad point the child at a repository other than the one validated here.
// So every call builds its environment and disables hooks and fsmonitor. Checkout also needs an
// isolated config: there is no Git option that disables all named filter commands.

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Git's global flags, before the subcommand: no fsmonitor command, and no hooks at all. */
const NEUTRAL = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"];

/** The variables a git child needs; nothing else from panad's environment, and no `GIT_*`. */
const KEEP = ["PATH", "HOME", "TMPDIR", "USER", "LANG", "TERM"] as const;

/** A built environment for a git child, never panad's. */
export function scrubbedEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: "0" };
	for (const key of KEEP) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	env.PATH ??= "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
	return env;
}

/** Run git in `repo` in argv form; resolves with its output and rejects on a non-zero exit. */
export function gitIn(repo: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
	return run("git", [...NEUTRAL, "-C", repo, ...args], { env: scrubbedEnv() });
}

/** Populate a registered, no-checkout worktree without trusting any filter configuration. */
export async function checkoutIsolated(path: string, common: string): Promise<void> {
	const [{ stdout: commit }, { stdout: index }, { stdout: format }] = await Promise.all([
		gitIn(path, ["rev-parse", "--verify", "HEAD^{commit}"]),
		gitIn(path, ["rev-parse", "--path-format=absolute", "--git-path", "index"]),
		gitIn(path, ["rev-parse", "--show-object-format"]),
	]);
	const dir = mkdtempSync(join(tmpdir(), "pana-checkout-"));
	try {
		// Git has no wildcard override for filter drivers. An empty private git dir also blocks
		// drivers from included, worktree, global and system config without an enumeration race.
		const env = { ...scrubbedEnv(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1" };
		await run("git", ["init", "--bare", "-q", `--object-format=${format.trim()}`, "--template=", dir], { env });
		await run("git", ["--git-dir", dir, "--work-tree", path, ...NEUTRAL,
			"-c", "core.attributesFile=/dev/null", "read-tree", "--reset", "-u", commit.trim()], {
			env: { ...env, GIT_OBJECT_DIRECTORY: join(common, "objects"), GIT_INDEX_FILE: index.trim() },
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
