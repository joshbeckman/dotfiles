import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { realPath } from "../src/extension/checkouts.ts";
import { PanaExecutionEnv } from "../src/extension/env.ts";
import { planCheck, sessionBox } from "../src/schedules/check-box.ts";
import { runCheck, runStoredCheck } from "../src/schedules/check.ts";
import type { Runtime } from "../src/server/runtime.ts";
import { addWorktree } from "../src/worktrees/index.ts";
import { ownedPaths, saveOwner } from "../src/worktrees/ownership.ts";
import { createFakeClock } from "./harness/index.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const id = "01HZZZZZZZZZZZZZZZZZZZZZZZ";
const caller = { kind: "session" as const, id, url: `pana://test/sessions/${id}` };
const empty = { command: null, cwd: null, author: null };
const signal = () => new AbortController().signal;

function fixture() {
	const home = realPath(mkdtempSync(join(tmpdir(), "pana-check-provenance-")));
	dirs.push(home);
	const state = join(home, "state"), repo = join(home, "repo");
	mkdirSync(state); mkdirSync(repo);
	const git = (args: string[]) => execFileSync("git", ["-C", repo, ...args], {
		env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
	}).toString().trim();
	git(["init", "-q"]); git(["config", "user.name", "test"]); git(["config", "user.email", "test@example.test"]);
	writeFileSync(join(repo, "tracked"), "original"); git(["add", "."]); git(["-c", "commit.gpgsign=false", "commit", "-qm", "init"]);
	const runtime = { paths: { dir: state, scratch: join(state, "scratch"), memoryWorktrees: join(state, "memory", "worktrees") },
		config: { tools: { protectCheckouts: "guard" }, worktreeAdapters: [] } } as unknown as Runtime;
	const plan = (cwd?: string) => planCheck(runtime, caller, { check: "true", ...(cwd === undefined ? {} : { checkCwd: cwd }) }, empty);
	const run = (cwd: string) => runStoredCheck(runtime, { command: "touch should-not-run", cwd, author: id }, createFakeClock(), signal());
	return { home, state, repo, runtime, git, plan, run };
}

describe("session check cwd provenance", () => {
	it.each(["scratch", "worktrees", "memory/worktrees"])("rejects a replaced %s namespace at definition and execution", async (group) => {
		const t = fixture();
		const root = join(t.state, group, id);
		mkdirSync(root, { recursive: true });
		const plan = t.plan(root);
		const box = sessionBox(t.runtime, id);
		rmSync(root, { recursive: true });
		symlinkSync(t.repo, root);
		expect(() => t.plan(root)).toThrow("outside session");
		if (group === "scratch") expect(() => t.plan()).toThrow("outside session");
		expect((await t.run(plan.cwd!)).status).toBe("failed");
		// A box captured before replacement must not retain the old authority.
		expect((await runCheck("touch should-not-run", root, createFakeClock(), signal(), { box, stateDir: t.state })).status).toBe("failed");
		expect(readFileSync(join(t.repo, "tracked"), "utf8")).toBe("original");
	});

	it("rejects forged receipts and a linked checkout reached through scratch", async () => {
		const t = fixture();
		const peer = join(t.home, "pana-peer-repo", "src");
		t.git(["worktree", "add", "-qb", "peer", peer]);
		saveOwner(t.state, "forged", { session: id, path: peer, common: join(t.repo, ".git") });
		expect(ownedPaths(t.state, id)).toEqual([]);
		expect(() => t.plan(peer)).toThrow("outside session");
		expect((await t.run(peer)).status).toBe("failed");
		// A check's chosen cwd is not the explicit session-create cwd escape hatch.
		const env = new PanaExecutionEnv({ cwd: peer, sessionId: id, stateDir: t.state, allowCwdCheckout: false });
		expect((await env.exec("touch should-not-run", undefined, BACKGROUND_CONTEXT)).ok).toBe(false);
		const alias = join(t.home, `pana-${id.toLowerCase()}-forged`);
		symlinkSync(peer, alias);
		saveOwner(t.state, "alias", { session: id, path: alias, common: join(t.repo, ".git") });
		expect(ownedPaths(t.state, id)).toEqual([]);
		expect(() => t.plan(alias)).toThrow("outside session");
		const scratch = join(t.state, "scratch", id); mkdirSync(scratch, { recursive: true });
		symlinkSync(peer, join(scratch, "peer"));
		expect(() => t.plan(join(scratch, "peer"))).toThrow("outside session");
		expect((await t.run(join(scratch, "peer"))).status).toBe("failed");
		// Even a checkout physically inside scratch is not explicit cwd authority.
		const linked = join(scratch, "linked"); t.git(["worktree", "add", "-qb", "scratch-linked", linked]);
		expect(() => t.plan(linked)).toThrow("outside session");
		expect((await t.run(linked)).status).toBe("failed");
	});

	it("does not adopt a linked checkout that replaces the worktree namespace itself", async () => {
		const t = fixture(); const root = join(t.state, "worktrees", id);
		mkdirSync(dirname(root), { recursive: true });
		t.git(["worktree", "add", "-qb", "replacement", root]);
		expect(() => t.plan(root)).toThrow("outside session");
		expect((await t.run(root)).status).toBe("failed");
	});

	it("accepts legitimate ordinary, memory and adapter worktrees and rechecks receipts", async () => {
		const t = fixture();
		const ordinary = await addWorktree(t.runtime, id, { repo: t.repo });
		const memory = join(t.state, "memory", "worktrees", id); mkdirSync(dirname(memory), { recursive: true });
		t.git(["worktree", "add", "-qb", "memory", memory]);
		const root = join(t.home, "managed"); mkdirSync(root);
		const script = join(t.home, "adapter.mjs");
		writeFileSync(script, `import {execFileSync} from 'node:child_process'; import {mkdirSync} from 'node:fs'; import {dirname} from 'node:path'; const [repo,path,branch]=process.argv.slice(2); mkdirSync(dirname(path),{recursive:true}); execFileSync('git',['-C',repo,'worktree','add','-qb',branch,path]);`);
		t.runtime.config.worktreeAdapters = [{ repo: join(t.repo, ".git"), root, subdir: "src", create: [process.execPath, script, "{repo}", "{path}", "{branch}"] }];
		const adapted = await addWorktree(t.runtime, id, { repo: t.repo, name: "adapted" });
		for (const cwd of [ordinary.path, memory, adapted.path]) {
			expect(t.plan(cwd).cwd).toBe(cwd);
			expect((await t.run(cwd)).status).toBe("passed");
		}
		// Replacing git's backpointer invalidates the adapter receipt before the next run.
		writeFileSync(join(adapted.path, ".git"), "gitdir: /nonexistent\n");
		expect(() => t.plan(adapted.path)).toThrow("outside session");
		expect((await t.run(adapted.path)).status).toBe("failed");
	});
});
