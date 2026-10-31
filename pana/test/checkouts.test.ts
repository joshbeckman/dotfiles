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
import { PanaExecutionEnv } from "../src/extension/env.ts";
import {
	blockedCheckout,
	checkoutCommandRefusal,
	primaryCheckoutOf,
	primaryCheckouts,
	realPath,
	resetCheckoutScan,
} from "../src/extension/checkouts.ts";
import { addWorktree } from "../src/worktrees/index.ts";
import type { Runtime } from "../src/server/runtime.ts";
import type { RequestContext } from "../src/api/types.ts";
import { handlers } from "../src/worktrees/handlers.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	resetCheckoutScan();
});

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

function canNamespace(): boolean {
	try {
		execFileSync("unshare", ["--map-root-user", "--mount", "true"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

describe("GUARD-01 the file tools refuse the user's checkout", () => {
	it("refuses a write behind a symlinked path and allows the session's own worktree", async () => {
		const t = setup();
		const wt = join(t.scratch, "dotfiles-worktree");
		t.git(t.repo, ["worktree", "add", "-q", "-b", "pana/work", wt, "HEAD"]);
		const e = env({ home: t.home, cwd: t.scratch });

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
	it.skipIf(!canNamespace())("a write the admission check cannot see still fails, and a worktree write succeeds", async () => {
		const t = setup();
		const wt = join(t.scratch, "worktree");
		t.git(t.repo, ["worktree", "add", "-q", "-b", "pana/bash", wt, "HEAD"]);
		const e = env({ home: t.home, cwd: t.scratch, protect: "sandbox" });
		// `$TARGET` is unreadable to the string check, so only the read-only mount can refuse it.
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
});

describe("GUARD-06 the admission check costs no process", () => {
	it("refuses a command that enters the checkout, and allows one that names a file", async () => {
		const t = setup();
		const e = env({ home: t.home, cwd: t.scratch });
		writeFileSync(join(t.repo, "readable.txt"), "hello\n");

		const entered = await e.exec("cd ~/pana && npm run test:web", undefined, ctx);
		expect(entered.ok).toBe(false);
		if (entered.ok) throw new Error("expected a refusal");
		expect(entered.error.message).toContain(t.repo);
		expect(entered.error.message).toContain("pana worktree add");

		// Reading stays allowed, and so does a read-only git command.
		const read = await e.exec(`grep -n hello ${join(t.home, "pana", "readable.txt")}`, undefined, ctx);
		expect(read.ok).toBe(true);
		if (!read.ok) throw new Error(read.error.message);
		expect(read.value.exitCode).toBe(0);
		const git = await e.exec(["git", "-C", t.repo, "log", "--oneline"], undefined, ctx);
		expect(git.ok).toBe(true);
	});

	it("answers a command in microseconds, so guard mode costs nothing per call", async () => {
		const t = setup();
		const e = env({ home: t.home, cwd: t.scratch });
		// Warm the scan, then time the pure-string check on a typical command.
		primaryCheckouts({ roots: [t.home] });
		const checkouts = [realPath(t.repo)];
		const started = performance.now();
		const rounds = 1000;
		for (let i = 0; i < rounds; i++) {
			expect(
				checkoutCommandRefusal("npm test && git status --porcelain | head -3", { cwd: t.scratch, home: t.home, checkouts }),
			).toBeUndefined();
		}
		const perCall = (performance.now() - started) / rounds;
		expect(perCall).toBeLessThan(1);
	});

	it("refuses the ways into a checkout: pushd, git -C with a write, a redirect, a mutator", () => {
		const t = setup();
		const checkouts = [realPath(t.repo)];
		const refusal = (command: string) => checkoutCommandRefusal(command, { cwd: t.scratch, home: t.home, checkouts });
		expect(refusal("pushd ~/pana")).toBeDefined();
		expect(refusal(`git -C ${t.repo} commit -am wip`)).toBeDefined();
		expect(refusal(`git --git-dir=${join(t.repo, ".git")} commit -m wip`)).toBeDefined();
		expect(refusal(`printf x > ${join(t.repo, "a.txt")}`)).toBeDefined();
		expect(refusal(`sed -i s/a/b/ ${join(t.repo, "tracked.txt")}`)).toBeDefined();
		expect(refusal(`rm -rf ${join(t.repo, "pana")}`)).toBeDefined();
		expect(refusal(`git -C ${t.repo} status --porcelain`)).toBeUndefined();
		expect(refusal(`cat ${join(t.repo, "tracked.txt")}`)).toBeUndefined();
		expect(refusal("npm test")).toBeUndefined();
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
		const state = tmp("pana-state-");
		const runtime = { paths: { dir: state } } as unknown as Runtime;
		const first = await addWorktree(runtime, "01HZZZZZZZZZZZZZZZZZZZZZZZ", { repo: join(t.home, "pana") });
		expect(first.created).toBe(true);
		expect(first.path).toBe(join(state, "worktrees", "01HZZZZZZZZZZZZZZZZZZZZZZZ", "dotfiles"));
		expect(first.branch).toBe("pana/01HZZZZZZZZZZZZZZZZZZZZZZZ/dotfiles");
		expect(existsSync(join(first.path, "tracked.txt"))).toBe(true);

		const again = await addWorktree(runtime, "01HZZZZZZZZZZZZZZZZZZZZZZZ", { repo: t.repo });
		expect(again.created).toBe(false);
		expect(again.path).toBe(first.path);
	});

	it("is for a session, not the user", async () => {
		const t = setup();
		const state = tmp("pana-state-");
		const context = {
			runtime: { paths: { dir: state } },
			caller: { kind: "user", id: "joshbeckman" },
			body: { repo: t.repo },
		} as unknown as RequestContext;
		await expect(handlers["worktrees.add"]!(context)).rejects.toThrow(/only a session/);
	});
});
