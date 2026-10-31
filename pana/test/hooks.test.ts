// Repository hook ownership: session shells do not redirect Git hooks or add attribution.
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PanaExecutionEnv } from "../src/extension/env.ts";
import { testGit } from "./harness/git.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup() {
	const root = mkdtempSync(join(tmpdir(), "pana-native-hooks-"));
	dirs.push(root);
	const home = join(root, "home");
	const repo = join(root, "repo");
	mkdirSync(home); mkdirSync(repo);
	// The fixture home carries its own global config, so HOK-04 can write a global
	// `core.hooksPath` and watch a session's shell respect it. Pointing git's global
	// config at that file keeps the runner's own config out, which is what makes the
	// plain repos here independent of the machine running the suite.
	const plain = (args: string[]) => testGit(repo, args, { home, env: { GIT_CONFIG_GLOBAL: join(home, ".gitconfig") } });
	plain(["init", "-q"]);
	plain(["config", "user.name", "tester"]);
	plain(["config", "user.email", "tester@example.test"]);
	plain(["config", "commit.gpgsign", "false"]);
	const env = new PanaExecutionEnv({ cwd: repo, home, sessionId: "01HZZZZZZZZZZZZZZZZZZZZZZZ" });
	async function run(args: string[]) {
		let stdout = "";
		const result = await env.exec(args, { onOutput: (text, _ctx, info) => { if (info.stream === "stdout") stdout += text; } }, ctx);
		if (!result.ok) throw new Error(result.error.message);
		return { code: result.value.exitCode, stdout };
	}
	function hook(dir: string, name: string, script: string) {
		mkdirSync(dir, { recursive: true });
		const path = join(dir, name);
		writeFileSync(path, `#!/bin/sh\n${script}\n`); chmodSync(path, 0o755);
	}
	return { repo, home, plain, run, hook };
}
describe("repository-owned Git hooks", () => {
	it("HOK-01 a session shell leaves core.hooksPath unset when the repository has no override", async () => {
		const t = setup();
		expect((await t.run(["git", "config", "--get", "core.hooksPath"])).code).toBe(1);
		expect((await t.run(["git", "rev-parse", "--git-path", "hooks"])).stdout.trim()).toBe(".git/hooks");
	});
	it.each(["local", "global"])("HOK-04 repository tooling sees the %s hooksPath unchanged", async (scope) => {
		const t = setup();
		const hooks = join(t.repo, "custom-hooks");
		t.plain(["config", `--${scope}`, "core.hooksPath", hooks]);
		t.hook(hooks, "pre-commit", 'printf native > hook-ran');
		expect((await t.run(["git", "config", "--get", "core.hooksPath"])).stdout.trim()).toBe(hooks);
		expect((await t.run(["git", "commit", "--allow-empty", "-m", "plain"])).code).toBe(0);
		expect(readFileSync(join(t.repo, "hook-ran"), "utf8")).toBe("native");
		expect(t.plain(["log", "-1", "--format=%B"])).not.toContain("Co-authored-by: AI");
	});
	it("HOK-05 a native failing pre-commit blocks a session's plain Git commit", async () => {
		const t = setup();
		t.hook(join(t.repo, ".git", "hooks"), "pre-commit", "exit 23");
		expect((await t.run(["git", "commit", "--allow-empty", "-m", "blocked"])).code).not.toBe(0);
		expect((await t.run(["git", "rev-parse", "--verify", "HEAD"])).code).not.toBe(0);
	});
});
