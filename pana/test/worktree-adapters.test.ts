import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addWorktree } from "../src/worktrees/index.ts";
import { ownedPaths, owners, saveOwner } from "../src/worktrees/ownership.ts";
import { realPath, resetCheckoutScan } from "../src/extension/checkouts.ts";
import { PanaExecutionEnv } from "../src/extension/env.ts";
import { loadConfig } from "../src/config/index.ts";
import type { Runtime } from "../src/server/runtime.ts";

vi.mock("../src/worktrees/ownership.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/worktrees/ownership.ts")>();
	return { ...actual, owners: vi.fn(actual.owners) };
});

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); resetCheckoutScan(); vi.clearAllMocks(); });
function fixture() {
	const home = realPath(mkdtempSync(join(tmpdir(), "pana-adapter-")));
	dirs.push(home);
	const repo = join(home, "repo"), state = join(home, "state"), root = join(home, "managed", "trees");
	mkdirSync(repo); mkdirSync(state); mkdirSync(root, { recursive: true });
	const git = (cwd: string, args: string[]) => execFileSync("git", ["-C", cwd, ...args], {
		env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
	}).toString().trim();
	git(repo, ["init", "-q"]); git(repo, ["config", "user.name", "test"]); git(repo, ["config", "user.email", "test@example.test"]);
	writeFileSync(join(repo, "tracked"), "untouched"); git(repo, ["add", "."]); git(repo, ["-c", "commit.gpgsign=false", "commit", "-qm", "init"]);
	const script = join(home, "materialize.mjs");
	writeFileSync(script, `import {execFileSync} from 'node:child_process'; import {mkdirSync} from 'node:fs'; import {dirname} from 'node:path';
const [repo,path,branch] = process.argv.slice(2); mkdirSync(dirname(path),{recursive:true}); execFileSync('git',['-C',repo,'worktree','add','-qb',branch,path,'HEAD']);`);
	const adapter = { repo: join(repo, ".git"), root, subdir: "src", create: [process.execPath, script, "{repo}", "{path}", "{branch}"] };
	const runtime = { paths: { dir: state }, config: { worktreeAdapters: [adapter] } } as unknown as Runtime;
	const env = (sessionId: string) => new PanaExecutionEnv({ cwd: state, stateDir: state, sessionId, home, managedRoots: [root], managedLayouts: [adapter], checkoutRoots: [home] });
	// The cwd cannot be an ownership escape hatch for the peer-state fixture below.
	const scratch = join(home, "scratch"); mkdirSync(scratch);
	const guarded = (sessionId: string) => new PanaExecutionEnv({ cwd: scratch, stateDir: state, sessionId, home, managedRoots: [root], managedLayouts: [adapter], checkoutRoots: [home] });
	return { home, repo, state, root, git, adapter, runtime, env, guarded };
}

describe("GUARD-07 managed worktrees", () => {
	it("creates through argv, verifies repository/branch, persists ownership and reuses after restart", async () => {
		const t = fixture();
		const result = await addWorktree(t.runtime, "alice", { repo: t.repo, branch: "feature/a" });
		expect(result.path).toBe(join(t.root, "pana-alice-repo", "src"));
		expect(result.branch).toBe("feature/a"); expect(result.created).toBe(true);
		expect(ownedPaths(t.state, "alice")).toEqual([result.path]);
		expect((await addWorktree({ ...t.runtime } as Runtime, "alice", { repo: t.repo })).created).toBe(false);
		expect(t.git(t.repo, ["status", "--porcelain"])).toBe("");
		expect(readFileSync(join(t.repo, "tracked"), "utf8")).toBe("untouched");
		expect((await t.guarded("alice").writeFile(join(result.path, "new"), "ok", ctx)).ok).toBe(true);
		expect((await t.guarded("bob").writeFile(join(result.path, "new"), "no", ctx)).ok).toBe(false);
		const peerCwd = new PanaExecutionEnv({ cwd: result.path, stateDir: t.state, sessionId: "bob", checkoutRoots: [t.home] });
		expect((await peerCwd.writeFile(join(result.path, "new"), "no", ctx)).ok).toBe(false);
		expect((await peerCwd.exec("git reset --hard", undefined, ctx)).ok).toBe(false);
		// Bash text is not gated; the file tools and actual execution cwd retain ownership checks.
		expect((await t.guarded("bob").exec(`cd '${result.path}' && pwd`, undefined, ctx)).ok).toBe(true);
	});

	it("passes the collision-free fallback to the adapter and reuses its owned checkout", async () => {
		const t = fixture();
		t.git(t.repo, ["update-ref", "refs/remotes/origin/pana", "HEAD"]);
		const first = await addWorktree(t.runtime, "alice", { repo: t.repo });
		expect(first.branch).toBe("pana-alice-repo");
		expect(t.git(first.path, ["branch", "--show-current"])).toBe(first.branch);
		expect(ownedPaths(t.state, "alice")).toEqual([first.path]);
		expect(await addWorktree(t.runtime, "alice", { repo: t.repo })).toEqual({ ...first, created: false });
	});

	it("requests lowercase external IDs before a normalizing materializer creates an uppercase session/name tree", async () => {
		const t = fixture();
		const script = t.adapter.create[1]!; const log = join(t.home, "normalizer-argv.json");
		t.adapter.create.push("{name}");
		writeFileSync(script, readFileSync(script, "utf8")
			.replace("{mkdirSync}", "{mkdirSync,writeFileSync}")
			.replace("{dirname}", "{dirname,basename,join}")
			.replace("const [repo,path,branch] = process.argv.slice(2);", "const [repo,requestedPath,branch] = process.argv.slice(2); const path = join(dirname(dirname(requestedPath)),basename(dirname(requestedPath)).toLowerCase(),basename(requestedPath));") +
			`\nwriteFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2)));`);
		const result = await addWorktree(t.runtime, "01HZZZZZZZZZZZZZZZZZZZZZZZ", { repo: t.repo, name: "REPO" });
		expect(result.path).toBe(join(t.root, "pana-01hzzzzzzzzzzzzzzzzzzzzzzz-repo", "src"));
		expect(result.branch).toBe("pana/01HZZZZZZZZZZZZZZZZZZZZZZZ/REPO");
		const argv = JSON.parse(readFileSync(log, "utf8"));
		expect(argv[1]).toBe(result.path); expect(argv[2]).toBe(result.branch);
		expect(argv[3]).toBe("pana-01hzzzzzzzzzzzzzzzzzzzzzzz-repo");
		expect(ownedPaths(t.state, "01HZZZZZZZZZZZZZZZZZZZZZZZ")).toEqual([result.path]);
		expect((await addWorktree(t.runtime, "01HZZZZZZZZZZZZZZZZZZZZZZZ", { repo: t.repo, name: "REPO" })).created).toBe(false);
	});

	it("does not adopt an unowned mixed-case tree through a case-insensitive alias", async (context) => {
		const t = fixture(); const legacy = join(t.root, "pana-ALICE-REPO", "src");
		t.git(t.repo, ["worktree", "add", "-qb", "unowned-alias", legacy]);
		if (!existsSync(join(t.root, "pana-alice-repo", "src"))) context.skip();
		await expect(addWorktree(t.runtime, "ALICE", { repo: t.repo, name: "REPO" })).rejects.toThrow();
		expect(owners(t.state)).toEqual([]);
		expect(readFileSync(join(legacy, "tracked"), "utf8")).toBe("untouched");
	});

	it("reuses a previously verified owned adapter tree with a case-preserving ID", async () => {
		const t = fixture(); const legacy = join(t.root, "pana-ALICE-REPO", "src");
		t.git(t.repo, ["worktree", "add", "-qb", "legacy-case", legacy]);
		saveOwner(t.state, "legacy-case", { session: "ALICE", path: legacy, common: join(t.repo, ".git") });
		const result = await addWorktree(t.runtime, "ALICE", { repo: t.repo, name: "REPO" });
		expect(result.path).toBe(legacy); expect(result.created).toBe(false); expect(result.branch).toBe("legacy-case");
	});

	it("protects a newly registered peer tree even when the scan is cached", async () => {
		const t = fixture(); const e = t.guarded("bob");
		await e.exec("true", undefined, ctx);
		const a = await addWorktree(t.runtime, "alice", { repo: t.repo });
		expect((await e.writeFile(join(a.path, "peer-write"), "no", ctx)).ok).toBe(false);
	});

	it("a receipt file alone grants nothing: it must name the session's own tree", async () => {
		const t = await fixture();
		const b = await addWorktree(t.runtime, "bob", { repo: t.repo });
		// `$PANA_STATE` is the session's own shell's to write, so it can write a receipt in exactly
		// the shape panad writes one. It reaches nothing: the tree is not named for the session.
		saveOwner(t.state, "forged", { session: "alice", path: b.path, common: join(t.repo, ".git") });
		expect((await t.guarded("alice").writeFile(join(b.path, "forged"), "no", ctx)).ok).toBe(false);
		expect((await t.guarded("alice").remove(join(b.path, "tracked"), undefined, ctx)).ok).toBe(false);
		expect((await t.guarded("bob").writeFile(join(b.path, "mine"), "yes", ctx)).ok).toBe(true);
		// Both halves are needed: a tree named for the session with no receipt is not its own either.
		const named = join(t.root, "pana-alice-hand", "src");
		t.git(t.repo, ["worktree", "add", "-qb", "hand", named]);
		expect((await t.guarded("alice").writeFile(join(named, "no"), "no", ctx)).ok).toBe(false);
		const a = await addWorktree(t.runtime, "alice", { repo: t.repo });
		expect((await t.guarded("alice").writeFile(join(a.path, "own"), "yes", ctx)).ok).toBe(true);
	});

	it("does not grant ownership when the adapter checks out the wrong branch", async () => {
		const t = fixture(); t.adapter.create[t.adapter.create.length - 1] = "wrong-branch";
		await expect(addWorktree(t.runtime, "alice", { repo: t.repo })).rejects.toThrow("wrong branch");
		expect(owners(t.state)).toEqual([]);
	});

	it.each(["peer", "common"])("rejects a same-repository %s git pointer substituted into an owned tree", async (pointer) => {
		const t = fixture(); const a = await addWorktree(t.runtime, "alice", { repo: t.repo });
		const b = await addWorktree(t.runtime, "bob", { repo: t.repo });
		writeFileSync(join(a.path, ".git"), pointer === "peer" ? readFileSync(join(b.path, ".git"), "utf8") : `gitdir: ${join(t.repo, ".git")}\n`);
		expect(ownedPaths(t.state, "alice")).toEqual([]);
		await expect(addWorktree(t.runtime, "alice", { repo: t.repo })).rejects.toThrow("does not match");
		expect((await t.guarded("alice").writeFile(join(a.path, "new"), "no", ctx)).ok).toBe(false);
	});

	it("reads one ownership snapshot per shell invocation, not per discovered tree", async () => {
		const t = fixture();
		for (const session of ["alice", "bob", "carol"]) await addWorktree(t.runtime, session, { repo: t.repo });
		vi.mocked(owners).mockClear();
		expect((await t.guarded("alice").exec("true", undefined, ctx)).ok).toBe(true);
		expect(owners).toHaveBeenCalledTimes(1);
	});

	it("does not retain ownership if a checkout pointer is replaced", async () => {
		const t = fixture(); const a = await addWorktree(t.runtime, "alice", { repo: t.repo });
		writeFileSync(join(a.path, ".git"), "gitdir: /nonexistent\n");
		expect(ownedPaths(t.state, "alice")).toEqual([]);
		expect((await t.guarded("alice").writeFile(join(a.path, "new"), "no", ctx)).ok).toBe(false);
	});

	it("preserves argv with spaces/metacharacters without shell evaluation", async () => {
		const t = fixture(); t.adapter.root = join(t.root, "with spaces");
		const script = t.adapter.create[1]!; const log = join(t.home, "argv.json");
		writeFileSync(script, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2)));\n` + readFileSync(script, "utf8"));
		const sentinel = join(t.home, "should-not-exist"); const literal = `$(touch ${sentinel}); literal`;
		t.adapter.create.push(literal);
		const a = await addWorktree(t.runtime, "alice", { repo: t.repo, branch: "feature/semicolon;literal" });
		expect(a.path).toContain("with spaces"); expect(existsSync(sentinel)).toBe(false);
		expect(JSON.parse(readFileSync(log, "utf8"))[3]).toBe(literal);
	});

	it("rejects a successful materializer that creates another repository", async () => {
		const t = fixture(); const other = join(t.home, "other");
		t.git(t.repo, ["clone", "-q", t.repo, other]); t.adapter.create[2] = other;
		await expect(addWorktree(t.runtime, "alice", { repo: t.repo })).rejects.toThrow("does not match");
		expect(owners(t.state)).toEqual([]);
	});

	it("partial creation fails closed on retry and is not deleted", async () => {
		const t = fixture(); const script = t.adapter.create[1]!;
		writeFileSync(script, readFileSync(script, "utf8") + "\nprocess.stderr.write('failed after creation'); process.exit(1);\n");
		await expect(addWorktree(t.runtime, "alice", { repo: t.repo })).rejects.toThrow("failed after creation");
		const path = join(t.root, "pana-alice-repo", "src"); expect(existsSync(join(path, "tracked"))).toBe(true);
		await expect(addWorktree(t.runtime, "alice", { repo: t.repo })).rejects.toThrow("unowned destination");
		expect(owners(t.state)).toEqual([]);
	});

	it("does not claim an unowned existing external tree", async () => {
		const t = fixture(); const path = join(t.root, "pana-alice-repo", "src"); mkdirSync(path, { recursive: true });
		await expect(addWorktree(t.runtime, "alice", { repo: t.repo })).rejects.toThrow("unowned destination");
		expect(owners(t.state)).toEqual([]);
	});

	it("refuses a same-name destination for a different repository", async () => {
		const t = fixture(); await addWorktree(t.runtime, "alice", { repo: t.repo });
		const other = join(t.home, "other"); t.git(t.repo, ["clone", "-q", t.repo, other]);
		t.runtime.config.worktreeAdapters!.push({ ...t.adapter, repo: join(other, ".git") });
		await expect(addWorktree(t.runtime, "alice", { repo: other, name: "repo" })).rejects.toThrow("another session or repository");
	});

	it("serializes concurrent retry creation of one tree", async () => {
		const t = fixture();
		const results = await Promise.all([addWorktree(t.runtime, "alice", { repo: t.repo }), addWorktree(t.runtime, "alice", { repo: t.repo })]);
		expect(results.map((r) => r.created).sort()).toEqual([false, true]);
	});

	it("reports external failure without fallback, granting no ownership", async () => {
		const t = fixture(); t.adapter.create = [process.execPath, "-e", "process.stderr.write('materializer unavailable'); process.exit(1)"];
		await expect(addWorktree(t.runtime, "alice", { repo: t.repo })).rejects.toThrow("materializer unavailable");
		expect(owners(t.state)).toEqual([]); expect(existsSync(join(t.state, "worktrees"))).toBe(false);
	});

	it("does not trust success without a checkout", async () => {
		const t = fixture(); t.adapter.create = [process.execPath, "-e", "process.exit(0)"];
		await expect(addWorktree(t.runtime, "alice", { repo: t.repo })).rejects.toThrow("does not match");
		expect(owners(t.state)).toEqual([]);
	});

	it("rejects a symlinked tree destination before executing the adapter", async () => {
		const t = fixture(); symlinkSync(t.repo, join(t.root, "pana-alice-repo"));
		await expect(addWorktree(t.runtime, "alice", { repo: t.repo })).rejects.toThrow("symlink");
		expect(owners(t.state)).toEqual([]);
	});

	it("refuses writes to another linked checkout even without receipts", async () => {
		const t = fixture(); const path = join(t.root, "user", "src");
		t.git(t.repo, ["worktree", "add", "-qb", "user", path]);
		expect((await t.guarded("alice").writeFile(join(path, "new"), "no", ctx)).ok).toBe(false);
		expect((await t.guarded("alice").writeFile(join(path, "peer-write"), "no", ctx)).ok).toBe(false);
	});

	it("protects other sessions' legacy state worktrees but allows this session's", async () => {
		const t = fixture(); t.runtime.config.worktreeAdapters = [];
		const a = await addWorktree(t.runtime, "alice", { repo: t.repo });
		const b = await addWorktree(t.runtime, "bob", { repo: t.repo });
		expect((await t.guarded("alice").writeFile(join(a.path, "new"), "yes", ctx)).ok).toBe(true);
		expect((await t.guarded("alice").writeFile(join(b.path, "new"), "no", ctx)).ok).toBe(false);
	});

	it("an ancestor cwd does not authorize peer managed or state trees", async () => {
		const t = fixture(); const a = await addWorktree(t.runtime, "alice", { repo: t.repo });
		expect((await t.env("bob").writeFile(join(a.path, "new"), "no", ctx)).ok).toBe(false);
		const e = new PanaExecutionEnv({ cwd: t.root, stateDir: t.state, sessionId: "bob", checkoutRoots: [t.home], managedLayouts: [t.adapter] });
		expect((await e.writeFile(join(a.path, "new"), "no", ctx)).ok).toBe(false);
		expect((await e.writeFile(join(a.path, "peer-write"), "no", ctx)).ok).toBe(false);
	});

	it("protects receipt-free legacy peer layouts and rejects namespace symlinks", async () => {
		const t = fixture(); const bob = join(t.state, "worktrees", "bob");
		t.git(t.repo, ["worktree", "add", "-qb", "legacy-bob", bob]);
		const e = t.guarded("alice");
		expect((await e.writeFile(join(bob, "new"), "no", ctx)).ok).toBe(false);
		const peerCwd = new PanaExecutionEnv({ cwd: bob, stateDir: t.state, sessionId: "alice", checkoutRoots: [t.home] });
		expect((await peerCwd.exec("git reset --hard", undefined, ctx)).ok).toBe(false);
		expect((await e.exec(`git -C '${bob}' status --porcelain`, undefined, ctx)).ok).toBe(true);
		expect((await t.guarded("bob").writeFile(join(bob, "new"), "yes", ctx)).ok).toBe(true);
		symlinkSync(bob, join(t.state, "worktrees", "alice"));
		expect((await e.writeFile(join(t.state, "worktrees", "alice", "new"), "no", ctx)).ok).toBe(false);
		const memory = join(t.state, "memory", "worktrees", "bob");
		t.git(t.repo, ["worktree", "add", "-qb", "memory-bob", memory]);
		symlinkSync(memory, join(t.state, "memory", "worktrees", "alice"));
		expect((await e.writeFile(join(t.state, "memory", "worktrees", "alice", "new"), "no", ctx)).ok).toBe(false);
	});

	it("protects file-tool writes in configured subdirectories below skipped/deep names", async () => {
		const t = fixture(); t.adapter.subdir = "build/a/b/c/d/e/src";
		const path = join(t.root, "user", t.adapter.subdir);
		t.git(t.repo, ["worktree", "add", "-qb", "deep-user", path]);
		expect((await t.guarded("alice").writeFile(join(path, "peer-write"), "no", ctx)).ok).toBe(false);
	});

	it("validates machine-local adapter config", () => {
		const t = fixture(); const config = join(t.state, "config.json");
		writeFileSync(config, JSON.stringify({ domain: "test.example", user: "test", worktreeAdapters: [t.adapter] }));
		expect(loadConfig(t.state).worktreeAdapters).toEqual([t.adapter]);
		for (const patch of [{ root: "relative" }, { subdir: "../escape" }, { create: [] }, { repo: null }]) {
			writeFileSync(config, JSON.stringify({ domain: "test.example", user: "test", worktreeAdapters: [{ ...t.adapter, ...patch }] }));
			expect(() => loadConfig(t.state)).toThrow("worktreeAdapters");
		}
	});
});
