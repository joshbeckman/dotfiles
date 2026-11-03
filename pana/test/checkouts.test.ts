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
	it.skipIf(!canNamespace())("a write the admission check cannot see still fails, and a worktree write succeeds", async () => {
		const t = setup();
		const wt = join(t.scratch, "worktree");
		t.git(t.repo, ["worktree", "add", "-q", "-b", "pana/bash", wt, "HEAD"]);
		const e = env({ home: t.home, cwd: wt, protect: "sandbox" });
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

	it("GUARD-06 admits graph/object queries and only explicit mixed-mode reads", () => {
		const t = setup();
		const options = { cwd: t.scratch, home: t.home, checkouts: [realPath(t.repo)] };
		const queries = [
			"merge-base HEAD HEAD", "merge-base --is-ancestor HEAD HEAD", "merge-base --fork-point HEAD",
			"cherry HEAD", "name-rev HEAD", "show-ref --head", "count-objects -v",
			"diff-tree HEAD", "diff-index HEAD", "diff-files",
			"branch -avv", "branch --color", "branch --column", "branch --list -- 'm*'",
			"branch", "branch -vv", "branch --show-current", "branch --list 'feature*'",
			'branch --list --format="%(refname)"', 'tag --list --format="%(refname)"',
			"branch --contains HEAD", 'branch --list --sort=-committerdate --format="%(refname)"',
			"tag --list -- 'v*'", "tag", "tag --list 'v*'", "tag -n1", "tag --contains HEAD",
			"remote -v show -n origin", "remote", "remote -v", "remote get-url --all origin", "remote show -n origin",
			"worktree list", "worktree list --porcelain -z",
			"config --file .git/config --get user.name", "config --get --type bool core.bare",
			"config get --all user.name", "config --get user.name", "config --global --get-all user.name",
			"config --get-regexp 'user.*'", "config --get-urlmatch http https://example.test",
			"config --list --show-origin", "config get user.name", "config list --show-scope",
		];
		for (const query of queries) {
			for (const prefix of [`git -C ${t.repo}`, `git --git-dir=${join(t.repo, ".git")}`]) {
				expect(checkoutCommandRefusal(`${prefix} ${query}`, options), query).toBeUndefined();
				// Peer checkouts get the same read permission, never the fast-forward exception.
				expect(checkoutCommandRefusal(`${prefix} ${query}`, { ...options, noFastForward: options.checkouts }), query).toBeUndefined();
			}
		}
		// Execute the original failing query only in a disposable repository.
		expect(t.git(t.repo, ["merge-base", "HEAD", "HEAD"]).trim()).toBe(t.git(t.repo, ["rev-parse", "HEAD"]).trim());
	});

	it("GUARD-06 refuses mixed-mode mutations, combined write flags, and output files", () => {
		const t = setup();
		const options = { cwd: t.scratch, home: t.home, checkouts: [realPath(t.repo)] };
		const writes = [
			'branch --format "" created', "branch --format '' created",
			'tag --format "" created-tag', "tag --format '' created-tag",
			'branch --sort "" created-sort', "branch --sort '' created-sort",
			'branch --format ""', "branch --format ''",
			"branch --format @(a|b)", "branch --format *", "branch --sort ?", "tag --format [ab]", "branch --format {a,b}",
			"branch feature", "branch -v feature", "branch -d feature", "branch -D feature",
			"branch -m renamed", "branch -c copied", "branch --set-upstream-to=origin/main",
			'branch --format="%(refname)" -D feature', 'tag --format="%(refname)" --delete v1',
			'branch --list --format="%(refname)" --delete feature',
			"branch --list -D feature", "branch --list --delete feature", "branch --list --future-mode",
			"tag v1", "tag -a v1 -m release", "tag -d v1", "tag --list --delete v1",
			"remote add origin https://example.test/repo", "remote remove origin", "remote rename origin upstream",
			"remote set-url origin https://example.test/repo", "remote update", "remote prune origin",
			"remote show --future-mode origin", "worktree add ../other", "worktree remove ../other",
			"worktree move ../old ../new", "worktree lock ../other", "worktree unlock ../other",
			"worktree prune", "worktree repair", "worktree list --future-mode",
			"config user.name changed", "config --add user.name changed", "config --unset user.name",
			"config --replace-all user.name changed", "config --edit", "config set user.name changed",
			"config unset user.name", "config --get --unset user.name", "config --list --edit", "config --file .git/config --unset user.name",
			"config --rename-section old new", "config --remove-section old", "config --get --future-mode user.name",
			"diff --out\\\nput=tracked.txt",
			"diff --output=tracked.txt", "log --output tracked.txt", "show --output=tracked.txt",
		];
		for (const write of writes) {
			for (const prefix of [`git -C ${t.repo}`, `git --git-dir=${join(t.repo, ".git")}`]) {
				expect(checkoutCommandRefusal(`${prefix} ${write}`, options), write).toBeDefined();
			}
		}
		expect(checkoutCommandRefusal(`git -C ${t.repo} merge-base HEAD HEAD && git -C ${t.repo} branch -D feature`, options)).toBeDefined();
	});

	it("admits the fast-forward PRM-05 permits: fetch, and pull or merge pinned to --ff-only", () => {
		const t = setup();
		const checkouts = [realPath(t.repo)];
		const refusal = (command: string) => checkoutCommandRefusal(command, { cwd: t.scratch, home: t.home, checkouts });

		expect(refusal(`git -C ${t.repo} fetch`)).toBeUndefined();
		expect(refusal(`git -C ${t.repo} fetch origin`)).toBeUndefined();
		expect(refusal(`git -C ${t.repo} fetch --all --prune`)).toBeUndefined();
		expect(refusal(`git -C ${t.repo} fetch --tags origin`)).toBeUndefined();
		expect(refusal(`git -C ${t.repo} fetch -v --no-tags origin`)).toBeUndefined();
		// A remote URL carries a colon and is still not a refspec.
		expect(refusal(`git -C ${t.repo} fetch https://github.com/joshbeckman/dotfiles.git main`)).toBeUndefined();
		expect(refusal(`git -C ${t.repo} fetch git@github.com:joshbeckman/dotfiles.git`)).toBeUndefined();
		expect(refusal(`git -C ${t.repo} pull --ff-only`)).toBeUndefined();
		expect(refusal(`git -C ${t.repo} pull --ff-only --no-autostash origin abc1234`)).toBeUndefined();
		// The flag need not come first, and the pinned commit need not come last.
		expect(refusal(`git -C ${t.repo} pull origin abc1234 --ff-only`)).toBeUndefined();
		expect(refusal(`git -C ${t.repo} pull --no-autostash --ff-only origin abc1234`)).toBeUndefined();
		expect(refusal(`git -C ${t.repo} merge --ff-only origin/master`)).toBeUndefined();
		expect(refusal(`git -C ${t.repo} merge --no-autostash --ff-only abc1234`)).toBeUndefined();
		// In a chain or a pipeline, up to a separator: the words after it are another command.
		expect(refusal(`npm test && git -C ${t.repo} pull --ff-only`)).toBeUndefined();
		expect(refusal(`git -C ${t.repo} fetch origin && git -C ${t.repo} pull --ff-only`)).toBeUndefined();
		expect(refusal(`git -C ${t.repo} pull --ff-only origin abc1234 | tail -3`)).toBeUndefined();
		expect(refusal(`git -C ${t.repo} merge --ff-only abc1234; git -C ${t.repo} log --oneline -1`)).toBeUndefined();
		// `~` and `$HOME` resolve to the session's HOME, as they do for a read.
		expect(refusal("git -C ~/pana fetch")).toBeUndefined();
		expect(refusal("git -C ~/pana pull --ff-only")).toBeUndefined();
		expect(refusal(`git -C "$HOME/pana" pull --ff-only`)).toBeUndefined();
		expect(refusal("git -C $HOME/pana merge --ff-only origin/master")).toBeUndefined();
	});

	it("refuses every pull or merge that is not the fast-forward, and every other write", () => {
		const t = setup();
		const checkouts = [realPath(t.repo)];
		const refusal = (command: string) => checkoutCommandRefusal(command, { cwd: t.scratch, home: t.home, checkouts });

		for (const command of [
			`git -C ${t.repo} pull`,
			`git -C ${t.repo} pull origin master`,
			`git -C ${t.repo} pull --no-ff`,
			`git -C ${t.repo} pull --ff`,
			`git -C ${t.repo} pull --ff-only --ff`,
			`git -C ${t.repo} pull --rebase`,
			`git -C ${t.repo} pull --rebase=merges`,
			`git -C ${t.repo} pull --ff-only --rebase`,
			`git -C ${t.repo} pull --autostash`,
			`git -C ${t.repo} pull --ff-only --autostash`,
			`git -C ${t.repo} pull --ff-only --squash`,
			`git -C ${t.repo} pull --ff-only --no-commit`,
			`git -C ${t.repo} merge`,
			`git -C ${t.repo} merge origin/master`,
			`git -C ${t.repo} merge --no-ff origin/master`,
			`git -C ${t.repo} merge --ff-only --no-ff`,
			`git -C ${t.repo} merge --ff-only --squash`,
			// `--git-dir` names no work tree, so the fast-forward is not admitted through it.
			`git --git-dir=${join(t.repo, ".git")} pull --ff-only`,
			`git --git-dir=${join(t.repo, ".git")} fetch`,
			// `fetch` writes no working tree, but a refspec into a local ref moves the user's branch.
			`git -C ${t.repo} fetch origin main:main`,
			`git -C ${t.repo} fetch --force origin foo:refs/heads/main`,
			`git -C ${t.repo} fetch --force --update-head-ok origin main:main`,
			`git -C ${t.repo} fetch -f origin`,
			`git -C ${t.repo} fetch -fv origin`,
			`git -C ${t.repo} fetch --update-head-ok origin`,
			`git -C ${t.repo} fetch --mirror origin`,
			`git -C ${t.repo} fetch --prune-tags origin`,
			`git -C ${t.repo} fetch origin +main:refs/heads/main`,
			// The mutator list and the read-only list are unchanged.
			`git -C ${t.repo} reset --hard`,
			`git -C ${t.repo} checkout main`,
			`git -C ${t.repo} switch -c x`,
			`git -C ${t.repo} stash`,
			`git -C ${t.repo} commit -m x`,
			`git -C ${t.repo} clean -fd`,
			`git -C ${t.repo} rebase main`,
			// A fast-forward in a chain does not carry the chain: the write after it is refused.
			`git -C ${t.repo} pull --ff-only && git -C ${t.repo} reset --hard`,
			// Inside a chain and a pipeline the same flag rule applies.
			`npm test && git -C ${t.repo} pull`,
			`git -C ${t.repo} pull | tee /dev/null`,
		]) {
			expect(refusal(command), command).toBeDefined();
		}
	});

	it("teaches the allowed fast-forward instead of only naming a worktree", () => {
		const t = setup();
		const checkouts = [realPath(t.repo)];
		const message = checkoutCommandRefusal(`git -C ${t.repo} pull`, {
			cwd: t.scratch,
			home: t.home,
			checkouts,
		});
		expect(message).toContain(t.repo);
		expect(message).toContain("pull --ff-only");
		expect(message).toContain("--no-autostash");
		expect(message).toContain("pana worktree add");
	});

	it("lets a fast-forward reach git in the checkout, and stops a bare pull before it runs", async () => {
		const t = setup();
		const e = env({ home: t.home, cwd: t.scratch });
		// The checkout has no upstream, so git itself fails: the point is that the guard let it run.
		const ran = await e.exec(["git", "-C", t.repo, "pull", "--ff-only"], undefined, ctx);
		if (!ran.ok) throw new Error(ran.error.message);
		expect(ran.value.exitCode).not.toBe(0);
		const refused = await e.exec(["git", "-C", t.repo, "pull"], undefined, ctx);
		expect(refused.ok).toBe(false);
		if (refused.ok) throw new Error("expected a refusal");
		expect(refused.error.message).toContain("pull --ff-only");
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
		const runtime = { paths: { dir: tmp("pana-state-") } } as unknown as Runtime;
		const first = await addWorktree(runtime, "session", { repo: t.repo });
		expect(first.branch).toBe("pana-session-dotfiles");
		expect(t.git(first.path, ["branch", "--show-current"]).trim()).toBe(first.branch);
		const again = await addWorktree(runtime, "session", { repo: t.repo });
		expect(again).toEqual({ ...first, created: false });
	});

	it("does not reuse a colliding generated branch without an existing worktree", async () => {
		const t = setup();
		t.git(t.repo, ["branch", "pana/session/dotfiles"]);
		const runtime = { paths: { dir: tmp("pana-state-") } } as unknown as Runtime;
		expect((await addWorktree(runtime, "session", { repo: t.repo })).branch).toBe("pana-session-dotfiles");
	});

	it("preserves explicit branch reuse and refuses explicit prefix collisions without renaming", async () => {
		const t = setup();
		t.git(t.repo, ["branch", "existing"]);
		const runtime = { paths: { dir: tmp("pana-state-") } } as unknown as Runtime;
		expect((await addWorktree(runtime, "session", { repo: t.repo, branch: "existing" })).branch).toBe("existing");
		t.git(t.repo, ["branch", "pana"]);
		await expect(addWorktree(runtime, "other", { repo: t.repo, branch: "pana/explicit" })).rejects.toThrow(/cannot lock ref/);
		expect(t.git(t.repo, ["branch", "--list", "pana-other-dotfiles"]).trim()).toBe("");
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
