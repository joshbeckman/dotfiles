// Hermetic git for test fixtures.
//
// A test repo must be built from git's built-in defaults, not from whatever the machine
// running the suite has configured. A developer's `init.templatedir` can install a
// pre-commit hook that asks for a password, `commit.gpgsign` can demand a signing key,
// and a global identity can change what a commit records. None of that belongs in a
// fixture: sessions have no TTY, so such a hook or signature turns into
// "error: reading password from TTY: No such device or address" from a `git commit`
// that has nothing to do with the behavior under test.
//
// The environment is built the same way `src/memory/git.ts` builds it for memory, so a
// test repo behaves identically on a bare CI runner and on a developer's machine.

import { execFileSync } from "node:child_process";

export interface TestGitEnvOptions {
	/** Fixture home to use instead of the runner's. Defaults to the inherited HOME. */
	home?: string;
	/** Extra variables, merged over the isolated base. */
	env?: Record<string, string>;
}

/** An environment where git reads no system or global config and never prompts. */
export function testGitEnv(options: TestGitEnvOptions = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH,
		HOME: options.home ?? process.env.HOME,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_TERMINAL_PROMPT: "0",
		GIT_EDITOR: "true",
		GIT_SEQUENCE_EDITOR: "true",
	};
	return { ...env, ...options.env };
}

/** Run git in a fixture repo and return its stdout. Throws on a non-zero exit. */
export function testGit(cwd: string, args: string[], options: TestGitEnvOptions = {}): string {
	const stdio: ["ignore", "pipe", "pipe"] = ["ignore", "pipe", "pipe"];
	return execFileSync("git", args, { cwd, env: testGitEnv(options), stdio }).toString();
}
