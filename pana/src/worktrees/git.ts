// The git this module runs on a caller-chosen repository (GUARD-03).
//
// `repo` comes from the caller, so both the path and the `.git/config` behind it are theirs. Git
// executes what that config names — hooks on `worktree add`, `core.fsmonitor` on anything that
// reads the index — and it would execute it as panad, with panad's environment. panad's own
// environment is no safer to hand over: `GIT_DIR`, `GIT_WORK_TREE` or `GIT_CONFIG_*` from the
// shell that started panad point the child at a repository other than the one validated here.
// So every call builds its environment, and passes the flags that keep repository config from
// running a command. Filter drivers are the one path git offers no flag for: a repository's own
// `.git/config` can name a `filter.<driver>.smudge`, and git runs it while populating a checkout,
// so they are read out of the repository and overwritten on the command line.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ApiError } from "../api/errors.ts";

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

/** The filter commands the repository itself configures, in git's own spelling. */
const FILTER_COMMANDS = "^filter\\..*\\.(clean|smudge|process)$";

/** The repository's own filter command keys; empty when it has none, which is the ordinary case. */
async function filterKeys(repo: string): Promise<string[]> {
	try {
		const { stdout } = await gitIn(repo, ["config", "--local", "--get-regexp", "--name-only", FILTER_COMMANDS]);
		return stdout.split("\n").filter(Boolean);
	} catch (error) {
		// `git config` exits 1, with nothing on stdout, when no key matches.
		if ((error as { code?: unknown }).code === 1) return [];
		throw error;
	}
}

/** Whether git reads `key` as true, at whichever config level wins: a required driver fails a null checkout. */
async function isTrue(repo: string, key: string): Promise<boolean> {
	try {
		const { stdout } = await run("git", [...NEUTRAL, "-C", repo, "config", "--bool", "--get", key], { env: scrubbedEnv() });
		return stdout.trim() === "true";
	} catch {
		// Unset is the ordinary answer, and one exit code covers both that and a value git cannot read.
		return false;
	}
}

/**
 * GUARD-03: the `-c` overrides that keep the repository's own filter drivers from running as panad
 * while git populates a checkout. Git has no switch that turns filters off, so each command the
 * repository names becomes `cat`, which copies the bytes through and runs nothing; an empty
 * `filter.<driver>.process` takes the long-running filter out of play. Only the repository's own
 * config is overwritten: drivers panad's own Git config names (`git-lfs`, for instance) are not the
 * caller's code, and neutralising them would break every legitimately filtered checkout.
 *
 * A `required` driver cannot be neutralised — with no real command git fails the checkout instead
 * of silently writing unfiltered bytes — so that repository is refused rather than run.
 */
export async function filterOverrides(repo: string): Promise<string[]> {
	const keys = await filterKeys(repo);
	const overrides: string[] = [];
	const drivers = new Set<string>();
	for (const key of keys) {
		overrides.push("-c", key.endsWith(".process") ? `${key}=` : `${key}=cat`);
		drivers.add(key.slice(0, key.lastIndexOf(".")));
	}
	for (const driver of drivers) {
		if (!await isTrue(repo, `${driver}.required`)) continue;
		const name = driver.replace(/^filter\./, "");
		throw ApiError.badRequest("worktree_filter_required",
			`repository requires filter '${name}': a required driver fails the checkout when its command is neutralised, ` +
			`and panad will not run it as itself — unset filter.${name}.required in that repository, or create the worktree from a clone that does not configure it`);
	}
	return overrides;
}
