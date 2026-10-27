// HOK-01..HOK-06: the pana git hook directory, against real git in temp repositories.

import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PanaExecutionEnv } from "../src/extension/env.ts";
import { commitTrailer, installGitHooks, STANDARD_HOOKS } from "../src/extension/hooks.ts";

const DOMAIN = "test.example";
const SESSION = "01SESSIONSESSION0000000000";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = "pana-hooks-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

function plainGit(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
	return execFileSync("git", args, {
		cwd,
		env: { PATH: process.env.PATH ?? "", HOME: tempHome(), LANG: "C.UTF-8", ...env },
		stdio: ["ignore", "pipe", "pipe"],
	}).toString();
}

function tempHome(): string {
	return tempDir("pana-home-");
}

function makeRepo(): string {
	const repo = tempDir("pana-repo-");
	plainGit(repo, ["init", "-q"]);
	plainGit(repo, ["config", "user.name", "tester"]);
	plainGit(repo, ["config", "user.email", `tester@${DOMAIN}`]);
	return repo;
}

interface Setup {
	repo: string;
	home: string;
	hooksDir: string;
	env: ExecutionEnv;
}

function setup(): Setup {
	const repo = makeRepo();
	const home = tempHome();
	const hooksDir = join(tempDir("pana-state-"), "hooks");
	installGitHooks(hooksDir, DOMAIN);
	const env = new PanaExecutionEnv({ cwd: repo, sessionId: SESSION, hooksDir, home });
	return { repo, home, hooksDir, env };
}

interface Run {
	exitCode: number;
	stdout: string;
	stderr: string;
}

async function run(env: ExecutionEnv, command: string | string[], envOverrides?: Record<string, string>): Promise<Run> {
	let stdout = "";
	let stderr = "";
	const result = await env.exec(
		command,
		{
			...(envOverrides === undefined ? {} : { env: envOverrides }),
			onOutput: (text, _context, info) => {
				if (info.stream === "stdout") stdout += text;
				else stderr += text;
			},
		},
		ctx,
	);
	if (!result.ok) throw new Error(`exec failed: ${result.error.code}: ${result.error.message}`);
	return { exitCode: result.value.exitCode, stdout, stderr };
}

async function commit(env: ExecutionEnv, message: string): Promise<Run> {
	return run(env, ["git", "commit", "-m", message]);
}

function countTrailers(message: string): number {
	return message.split("\n").filter((line) => line.startsWith("Co-authored-by: AI ")).length;
}

describe("git hooks", () => {
	it("HOK-01 bash sets GIT_CONFIG_COUNT, GIT_CONFIG_KEY_0=core.hooksPath, and GIT_CONFIG_VALUE_0=<state>/hooks", async () => {
		const { env, hooksDir } = setup();
		const result = await run(env, "env");
		const vars = new Map(
			result.stdout
				.split("\n")
				.map((line) => /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line))
				.filter((match): match is RegExpExecArray => match !== null)
				.map((match) => [match[1]!, match[2]!]),
		);
		expect(vars.get("GIT_CONFIG_COUNT")).toBe("1");
		expect(vars.get("GIT_CONFIG_KEY_0")).toBe("core.hooksPath");
		expect(vars.get("GIT_CONFIG_VALUE_0")).toBe(hooksDir);
	});

	it("HOK-02 a commit made through bash carries exactly one pana trailer", async () => {
		const { env, repo, home } = setup();
		writeFileSync(join(env.cwd, "a.txt"), "one\n");
		expect((await run(env, ["git", "add", "a.txt"])).exitCode).toBe(0);
		expect((await commit(env, "first")).exitCode).toBe(0);

		const message = (await run(env, ["git", "log", "-1", "--format=%B"])).stdout;
		expect(countTrailers(message)).toBe(1);
		// The address is the configured git user.email, not a session mailbox.
		expect(message).toContain(commitTrailer(DOMAIN, SESSION, `tester@${DOMAIN}`));
		expect(message).not.toContain(`${SESSION}@${DOMAIN}`);

		// With no repo-local identity, the address comes from the user's own ~/.gitconfig.
		plainGit(repo, ["config", "--local", "--unset", "user.email"]);
		writeFileSync(join(home, ".gitconfig"), `[user]\n\temail = josh@${DOMAIN}\n`);
		writeFileSync(join(repo, "b.txt"), "two\n");
		await run(env, ["git", "add", "b.txt"]);
		expect((await commit(env, "second")).exitCode).toBe(0);
		const fromGlobal = (await run(env, ["git", "log", "-1", "--format=%B"])).stdout;
		expect(fromGlobal).toContain(commitTrailer(DOMAIN, SESSION, `josh@${DOMAIN}`));
		expect(fromGlobal).not.toContain(`${SESSION}@${DOMAIN}`);
	});

	it("HOK-03 git commit --amend and a second commit do not duplicate the trailer", async () => {
		const { env } = setup();
		writeFileSync(join(env.cwd, "a.txt"), "one\n");
		await run(env, ["git", "add", "a.txt"]);
		await commit(env, "first");

		expect((await run(env, ["git", "commit", "--amend", "--no-edit"])).exitCode).toBe(0);
		let message = (await run(env, ["git", "log", "-1", "--format=%B"])).stdout;
		expect(countTrailers(message)).toBe(1);
		expect(message).toContain("first");

		writeFileSync(join(env.cwd, "b.txt"), "two\n");
		await run(env, ["git", "add", "b.txt"]);
		await commit(env, "second");
		const messages = (await run(env, ["git", "log", "--format=%B%x00"])).stdout.split("\0");
		const trailers = messages.map(countTrailers).filter((count) => count > 0);
		expect(trailers).toEqual([1, 1]);
	});

	it("HOK-04 every standard hook runs the repo's own hook of that name and preserves its exit code", async () => {
		// Local core.hooksPath wins, and a relative path resolves from the repo root.
		const local = setup();
		const localHooks = join(local.repo, ".repo-hooks");
		mkdirSync(localHooks);
		const localMarker = join(local.repo, "local-ran");
		writeHook(join(localHooks, "pre-commit"), `touch '${localMarker}'`);
		plainGit(local.repo, ["config", "--local", "core.hooksPath", ".repo-hooks"]);
		writeFileSync(join(local.repo, "a.txt"), "one\n");
		await run(local.env, ["git", "add", "a.txt"]);
		expect((await commit(local.env, "first")).exitCode).toBe(0);
		expect(existsSync(localMarker)).toBe(true);

		// Then global core.hooksPath, from the session's HOME.
		const global = setup();
		const globalHooks = tempDir("pana-global-hooks-");
		const globalMarker = join(global.repo, "global-ran");
		writeHook(join(globalHooks, "pre-commit"), `touch '${globalMarker}'`);
		await run(global.env, ["git", "config", "--global", "core.hooksPath", globalHooks]);
		writeFileSync(join(global.repo, "a.txt"), "one\n");
		await run(global.env, ["git", "add", "a.txt"]);
		expect((await commit(global.env, "first")).exitCode).toBe(0);
		expect(existsSync(globalMarker)).toBe(true);

		// A local core.hooksPath wins over the global one.
		const localOverGlobal = join(global.repo, ".local-hooks");
		mkdirSync(localOverGlobal);
		const localOverGlobalMarker = join(global.repo, "local-over-global-ran");
		writeHook(join(localOverGlobal, "pre-commit"), `touch '${localOverGlobalMarker}'`);
		plainGit(global.repo, ["config", "--local", "core.hooksPath", ".local-hooks"]);
		writeFileSync(join(global.repo, "b.txt"), "two\n");
		await run(global.env, ["git", "add", "b.txt"]);
		expect((await commit(global.env, "second")).exitCode).toBe(0);
		expect(existsSync(localOverGlobalMarker)).toBe(true);

		// The repo's own prepare-commit-msg runs first, so the trailer survives its rewrite.
		const rewrite = setup();
		writeHook(
			join(rewrite.repo, ".git", "hooks", "prepare-commit-msg"),
			`printf 'repo message\\n' > "$1"`,
		);
		writeFileSync(join(rewrite.repo, "a.txt"), "one\n");
		await run(rewrite.env, ["git", "add", "a.txt"]);
		expect((await commit(rewrite.env, "first")).exitCode).toBe(0);
		const rewritten = (await run(rewrite.env, ["git", "log", "-1", "--format=%B"])).stdout;
		expect(rewritten).toContain("repo message");
		expect(countTrailers(rewritten)).toBe(1);

		// Then $(git rev-parse --git-path hooks).
		const fallback = setup();
		const fallbackMarker = join(fallback.repo, "fallback-ran");
		writeHook(join(fallback.repo, ".git", "hooks", "pre-commit"), `touch '${fallbackMarker}'`);
		writeFileSync(join(fallback.repo, "a.txt"), "one\n");
		await run(fallback.env, ["git", "add", "a.txt"]);
		expect((await commit(fallback.env, "first")).exitCode).toBe(0);
		expect(existsSync(fallbackMarker)).toBe(true);

		// The exit code of the repo's hook is the exit code of the pana hook, and of git.
		const failing = setup();
		writeHook(join(failing.repo, ".git", "hooks", "commit-msg"), "exit 7");
		writeFileSync(join(failing.repo, "a.txt"), "one\n");
		await run(failing.env, ["git", "add", "a.txt"]);
		const direct = await run(failing.env, [join(failing.hooksDir, "commit-msg"), ".git/COMMIT_EDITMSG"]);
		expect(direct.exitCode).toBe(7);

		// Every standard hook name exists and is executable.
		for (const name of STANDARD_HOOKS) {
			const path = join(failing.hooksDir, name);
			expect(existsSync(path)).toBe(true);
			expect(statSync(path).mode & 0o111).not.toBe(0);
		}
	});

	it("HOK-05 a repo with a failing pre-commit still blocks the commit", async () => {
		const { env, repo } = setup();
		writeFileSync(join(repo, "a.txt"), "one\n");
		await run(env, ["git", "add", "a.txt"]);
		expect((await commit(env, "first")).exitCode).toBe(0);
		const before = (await run(env, ["git", "rev-list", "--count", "HEAD"])).stdout.trim();

		writeHook(join(repo, ".git", "hooks", "pre-commit"), "echo 'no commits today' >&2\nexit 1");
		writeFileSync(join(repo, "b.txt"), "two\n");
		await run(env, ["git", "add", "b.txt"]);
		const blocked = await commit(env, "second");
		expect(blocked.exitCode).not.toBe(0);
		expect(blocked.stderr).toContain("no commits today");
		expect((await run(env, ["git", "rev-list", "--count", "HEAD"])).stdout.trim()).toBe(before);
	});

	it("HOK-06 commits made outside pana are unchanged", () => {
		const repo = makeRepo();
		writeFileSync(join(repo, "a.txt"), "one\n");
		plainGit(repo, ["add", "a.txt"]);
		const home = tempHome();
		const out = spawnSync("git", ["commit", "-m", "outside pana"], {
			cwd: repo,
			env: { PATH: process.env.PATH ?? "", HOME: home, TERM: "dumb" },
			encoding: "utf8",
		});
		expect(out.status).toBe(0);
		const message = plainGit(repo, ["log", "-1", "--format=%B"], { HOME: home });
		expect(message).not.toContain("Co-authored-by: AI");
		expect(message.trim()).toBe("outside pana");
	});
});

function writeHook(path: string, body: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
	chmodSync(path, 0o755);
}
