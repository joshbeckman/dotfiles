// The local CLI preserves Git argv/stdin/output and needs no running daemon.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
const CLI = fileURLToPath(new URL("../bin/pana", import.meta.url));
const SESSION = "01HZZZZZZZZZZZZZZZZZZZZZZZ";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup() {
	const root = mkdtempSync(join(tmpdir(), "pana-git-cli-")); dirs.push(root);
	const repo = join(root, "repo"); const state = join(root, "state"); const home = join(root, "home");
	for (const dir of [repo, state, home]) mkdirSync(dir);
	writeFileSync(join(state, "config.json"), JSON.stringify({ domain: "test.example", user: "tester" }));
	const env = { PATH: process.env.PATH, HOME: home, PANA_STATE: state, PANA_SESSION: SESSION, GIT_CONFIG_NOSYSTEM: "1" };
	const git = (args: string[]) => execFileSync("git", args, { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] }).toString();
	git(["init", "-q"]); git(["config", "user.name", "tester"]); git(["config", "user.email", "tester@test.example"]); git(["config", "commit.gpgsign", "false"]);
	const run = (args: string[], input?: string, overrides = {}) => spawnSync(process.execPath, [CLI, ...args], { cwd: repo, env: { ...env, ...overrides }, input, encoding: "utf8" });
	return { repo, git, run };
}
describe("local git commit CLI", () => {
	it("commits without panad, keeps message flags intact, and prints native Git output", () => {
		const t = setup();
		for (const message of ["--help", "--json", "-h"]) {
			const result = t.run(["git", "commit", "--allow-empty", "-m", message]);
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout).not.toMatch(/^\{/);
			const body = t.git(["log", "-1", "--format=%B"]);
			expect(body).toContain(`${message}\n`);
			expect(body).toContain(`Co-authored-by: AI pana://test.example/sessions/${SESSION} <tester@test.example>`);
		}
	});
	it("forwards stdin for -F -", () => {
		const t = setup();
		const result = t.run(["git", "commit", "--allow-empty", "-F", "-"], "from stdin\n\nbody\n");
		expect(result.status, result.stderr).toBe(0);
		expect(t.git(["log", "-1", "--format=%B"])).toContain("from stdin\n\nbody");
	});
	it("requires session context before making a commit", () => {
		const t = setup();
		const result = t.run(["git", "commit", "--allow-empty", "-m", "outside"], undefined, { PANA_SESSION: "" });
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("requires PANA_SESSION");
		expect(t.git(["rev-list", "--all", "--count"]).trim()).toBe("0");
	});
	it("advertises local help without session context", () => {
		const t = setup();
		for (const args of [["--help"], ["git", "--help"], ["git", "commit", "--help"]]) {
			const result = t.run(args, undefined, { PANA_SESSION: "" });
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout).toContain("pana git commit [GIT_COMMIT_ARGS...]");
		}
	});
});
