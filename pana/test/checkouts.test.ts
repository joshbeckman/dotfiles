// GUARD: a session edits a worktree, never the user's primary checkout.
//
// The fixtures are real repositories in a temporary HOME, so the symlink case (`~/pana` →
// `~/dotfiles/pana`), the worktree case, and the scan all run against git's own answers.

import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PanaExecutionEnv, sandboxSupported } from "../src/extension/env.ts";
import {
	blockedCheckout,
	primaryCheckoutOf,
	primaryCheckouts,
	realPath,
	resetCheckoutScan,
} from "../src/extension/checkouts.ts";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { migrate, PanaDatabase } from "../src/db/index.ts";
import { addWorktree } from "../src/worktrees/index.ts";
import type { Runtime } from "../src/server/runtime.ts";
import type { RequestContext } from "../src/api/types.ts";
import { handlers } from "../src/worktrees/handlers.ts";

const dirs: string[] = [];
const dbs: PanaDatabase[] = [];
afterEach(async () => {
	for (const db of dbs.splice(0)) await db.close().catch(() => {});
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	resetCheckoutScan();
});

/** A state directory with a migrated database, as panad has: ownership is a row (GUARD-07). */
async function stateRuntime(): Promise<Runtime> {
	const dir = tmp("pana-state-");
	const db = new PanaDatabase(await openNodeSqliteDatabase(join(dir, "pana.sqlite")));
	await migrate(db);
	dbs.push(db);
	return { paths: { dir }, db } as unknown as Runtime;
}

function tmp(prefix = "pana-guard-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

/** A HOME with one primary checkout at `home/dotfiles`, its worktree, and a scratch directory. */
function setup() {
	const home = tmp();
	const repo = join(home, "dotfiles");
	const scratch = join(home, "scratch");
	mkdirSync(repo);
	mkdirSync(scratch);
	const git = (cwd: string, args: string[]) =>
		execFileSync("git", args, {
			cwd,
			env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
		}).toString();
	git(repo, ["init", "-q"]);
	git(repo, ["config", "user.name", "tester"]);
	git(repo, ["config", "user.email", "tester@example.test"]);
	git(repo, ["config", "commit.gpgsign", "false"]);
	writeFileSync(join(repo, "tracked.txt"), "primary\n");
	git(repo, ["add", "tracked.txt"]);
	git(repo, ["commit", "-q", "-m", "first"]);
	// `~/pana` is how a session reached the live checkout in the first place.
	symlinkSync(join(repo), join(home, "pana"));
	return { home, repo, scratch, git };
}

function env(options: { home: string; cwd: string; roots?: string[]; protect?: "guard" | "sandbox" | "off" }): PanaExecutionEnv {
	return new PanaExecutionEnv({
		cwd: options.cwd,
		home: options.home,
		sessionId: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
		checkoutRoots: options.roots ?? [options.home],
		...(options.protect === undefined ? {} : { protectCheckouts: options.protect }),
	});
}

/** GUARD-02: the wrapper needs a mount namespace and the capability drop that follows it. */
function canNamespace(): boolean {
	return sandboxSupported();
}

describe("GUARD-01 the file tools refuse the user's checkout", () => {
	it("refuses a write behind a symlinked path and allows the session's own worktree", async () => {
		const t = setup();
		const wt = join(t.scratch, "dotfiles-worktree");
		t.git(t.repo, ["worktree", "add", "-q", "-b", "pana/work", wt, "HEAD"]);
		const e = env({ home: t.home, cwd: wt });

		const refused = await e.writeFile(join(t.home, "pana", "new-file.txt"), "nope", ctx);
		expect(refused.ok).toBe(false);
		if (refused.ok) throw new Error("expected a refusal");
		expect(refused.error.code).toBe("permission_denied");
		expect(refused.error.message).toContain(t.repo);
		expect(refused.error.message).toContain("pana worktree add");
		expect(existsSync(join(t.repo, "new-file.txt"))).toBe(false);

		expect((await e.writeFile(join(wt, "new-file.txt"), "yes", ctx)).ok).toBe(true);
		expect((await e.writeFile(join(t.scratch, "note.txt"), "yes", ctx)).ok).toBe(true);
		expect((await e.remove(join(t.repo, "tracked.txt"), undefined, ctx)).ok).toBe(false);
	});

	it("GUARD-05 allows the checkout a session was created in", async () => {
		const t = setup();
		const e = env({ home: t.home, cwd: t.repo });
		expect((await e.writeFile(join(t.repo, "by-owner.txt"), "yes", ctx)).ok).toBe(true);
		// The hatch is the session's own cwd, not every checkout.
		const other = join(t.home, "other");
		mkdirSync(other);
		t.git(other, ["init", "-q"]);
		expect((await e.writeFile(join(other, "refused.txt"), "no", ctx)).ok).toBe(false);
	});

	it("tools.protectCheckouts: off turns the refusal off", async () => {
		const t = setup();
		const e = env({ home: t.home, cwd: t.scratch, protect: "off" });
		expect((await e.writeFile(join(t.repo, "off.txt"), "yes", ctx)).ok).toBe(true);
	});
});

describe("GUARD-02 sandbox mode cannot write to the checkout", () => {
	it.skipIf(!canNamespace())("a Bash write fails on a read-only checkout mount, and a worktree write succeeds", async () => {
		const t = setup();
		const wt = join(t.scratch, "worktree");
		t.git(t.repo, ["worktree", "add", "-q", "-b", "pana/bash", wt, "HEAD"]);
		const e = env({ home: t.home, cwd: wt, protect: "sandbox" });
		// Shell syntax is not classified; filesystem mounts enforce the write boundary.
		const script = ["sh", "-c", `printf nope > "$TARGET"`];

		const refused = await e.exec(script, { env: { TARGET: join(t.repo, "from-bash.txt") } }, ctx);
		expect(refused.ok).toBe(true);
		if (!refused.ok) throw new Error(refused.error.message);
		expect(refused.value.exitCode).not.toBe(0);
		expect(existsSync(join(t.repo, "from-bash.txt"))).toBe(false);

		const allowed = await e.exec(script, { env: { TARGET: join(wt, "from-bash.txt") } }, ctx);
		expect(allowed.ok).toBe(true);
		if (!allowed.ok) throw new Error(allowed.error.message);
		expect(allowed.value.exitCode).toBe(0);
		expect(existsSync(join(wt, "from-bash.txt"))).toBe(true);
	});

	it.skipIf(!canNamespace())("a confined command cannot undo the read-only mount", async () => {
		const t = setup();
		const e = env({ home: t.home, cwd: t.scratch, protect: "sandbox" });
		// The mounts are made by the namespace's own root, and the command does not inherit the
		// capability it would take to remount one writable.
		const remount = await e.exec(["mount", "-o", "remount,bind,rw", t.repo], undefined, ctx);
		expect(remount.ok).toBe(true);
		if (!remount.ok) throw new Error(remount.error.message);
		expect(remount.value.exitCode).not.toBe(0);
		// Binding an ancestor over the checkout would be a writable view of the same directory.
		const holder = join(t.scratch, "holder");
		mkdirSync(holder);
		const bind = await e.exec(["mount", "--bind", t.home, holder], undefined, ctx);
		expect(bind.ok).toBe(true);
		if (!bind.ok) throw new Error(bind.error.message);
		expect(bind.value.exitCode).not.toBe(0);
		const nested = await e.exec(["unshare", "--map-root-user", "--mount", "mount", "-o", "remount,bind,rw", t.repo], undefined, ctx);
		expect(nested.ok).toBe(true);
		if (!nested.ok) throw new Error(nested.error.message);
		expect(nested.value.exitCode).not.toBe(0);
		expect(existsSync(join(t.repo, "from-bash.txt"))).toBe(false);
	});
});

describe("GUARD-06 checkout protection uses paths, not shell-command classification", () => {
	it("runs compound reads, quoted examples and Git queries without a command allowlist", async () => {
		const t = setup();
		const e = env({ home: t.home, cwd: t.scratch });
		for (const command of [
			`sed -n '1,10p' ${join(t.repo, "tracked.txt")}; git -C ${t.repo} symbolic-ref --short HEAD`,
			`printf '%s\\n' 'git -C ${t.repo} symbolic-ref --short HEAD'`,
			`python3 - <<'PY'\nmessage = 'git -C ${t.repo} symbolic-ref --short HEAD'\nprint(message)\nPY`,
			`cd ${t.repo} && git status --porcelain`,
		]) {
			const result = await e.exec(command, undefined, ctx);
			expect(result.ok).toBe(true);
			if (!result.ok) throw new Error(result.error.message);
			expect(result.value.exitCode).toBe(0);
		}
		expect(t.git(t.repo, ["status", "--porcelain"])).toBe("");
	});

	it("retains file-tool refusal but does not promise Bash write prevention in guard mode", async () => {
		const t = setup();
		const e = env({ home: t.home, cwd: t.scratch });
		const file = join(t.repo, "from-bash.txt");
		expect((await e.writeFile(file, "blocked", ctx)).ok).toBe(false);
		// Only a disposable fixture is written: guard mode is not a filesystem sandbox.
		const result = await e.exec(`printf allowed > "${file}"`, undefined, ctx);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.error.message);
		expect(result.value.exitCode).toBe(0);
		expect(existsSync(file)).toBe(true);
	});

	it("runs argv commands as argv rather than classifying their joined text", async () => {
		const t = setup();
		const e = env({ home: t.home, cwd: t.scratch });
		const result = await e.exec(["git", "-C", t.repo, "symbolic-ref", "--short", "HEAD"], undefined, ctx);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.error.message);
		expect(result.value.exitCode).toBe(0);
	});
});

describe("GUARD-04 the scan finds checkouts, not worktrees", () => {
	it("lists primary checkouts under a root and skips node_modules", async () => {
		const t = setup();
		const wt = join(t.scratch, "worktree");
		t.git(t.repo, ["worktree", "add", "-q", "-b", "pana/scan", wt, "HEAD"]);
		mkdirSync(join(t.repo, "node_modules", "dep", ".git"), { recursive: true });
		const found = primaryCheckouts({ roots: [t.home] }).sort();
		expect(found).toContain(realPath(t.repo));
		expect(found.some((path) => path.includes("node_modules"))).toBe(false);
		expect(found).not.toContain(realPath(wt));
		expect(primaryCheckoutOf(join(wt, "tracked.txt"))).toBeUndefined();
		expect(primaryCheckoutOf(join(t.repo, "tracked.txt"))).toBe(realPath(t.repo));
		expect(blockedCheckout(join(t.repo, "tracked.txt"), t.scratch)).toBe(realPath(t.repo));
		expect(blockedCheckout(join(t.repo, "tracked.txt"), t.repo)).toBeUndefined();
	});
});

describe("GUARD-03 pana worktree add", () => {
	it("creates a worktree of a repository for a session, and reuses it", async () => {
		const t = setup();
		const runtime = await stateRuntime();
		const state = runtime.paths.dir;
		const first = await addWorktree(runtime, "01HZZZZZZZZZZZZZZZZZZZZZZZ", { repo: join(t.home, "pana") });
		expect(first.created).toBe(true);
		expect(first.path).toBe(join(realPath(state), "worktrees", "01HZZZZZZZZZZZZZZZZZZZZZZZ", "dotfiles"));
		expect(first.branch).toBe("pana/01HZZZZZZZZZZZZZZZZZZZZZZZ/dotfiles");
		expect(existsSync(join(first.path, "tracked.txt"))).toBe(true);

		const again = await addWorktree(runtime, "01HZZZZZZZZZZZZZZZZZZZZZZZ", { repo: t.repo });
		expect(again.created).toBe(false);
		expect(again.path).toBe(first.path);
	});

	it("creates and reuses the fallback branch when a cached remote prefix conflicts", async () => {
		const t = setup();
		t.git(t.repo, ["update-ref", "refs/remotes/origin/pana", "HEAD"]);
		const runtime = await stateRuntime();
		const first = await addWorktree(runtime, "session", { repo: t.repo });
		expect(first.branch).toBe("pana-session-dotfiles");
		expect(t.git(first.path, ["branch", "--show-current"]).trim()).toBe(first.branch);
		const again = await addWorktree(runtime, "session", { repo: t.repo });
		expect(again).toEqual({ ...first, created: false });
	});

	it("does not reuse a colliding generated branch without an existing worktree", async () => {
		const t = setup();
		t.git(t.repo, ["branch", "pana/session/dotfiles"]);
		const runtime = await stateRuntime();
		expect((await addWorktree(runtime, "session", { repo: t.repo })).branch).toBe("pana-session-dotfiles");
	});

	it("preserves explicit branch reuse and refuses explicit prefix collisions without renaming", async () => {
		const t = setup();
		t.git(t.repo, ["branch", "existing"]);
		const runtime = await stateRuntime();
		expect((await addWorktree(runtime, "session", { repo: t.repo, branch: "existing" })).branch).toBe("existing");
		t.git(t.repo, ["branch", "pana"]);
		await expect(addWorktree(runtime, "other", { repo: t.repo, branch: "pana/explicit" })).rejects.toThrow(/cannot lock ref/);
		expect(t.git(t.repo, ["branch", "--list", "pana-other-dotfiles"]).trim()).toBe("");
	});

	it("is for a session, not the user", async () => {
		const t = setup();
		const runtime = await stateRuntime();
		const context = {
			runtime,
			caller: { kind: "user", id: "joshbeckman" },
			body: { repo: t.repo },
		} as unknown as RequestContext;
		await expect(handlers["worktrees.add"]!(context)).rejects.toThrow(/only a session/);
	});
});
