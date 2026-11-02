import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generatedBranch } from "../src/worktrees/branch.ts";
import { testGit } from "./harness/git.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
	const repo = mkdtempSync(join(tmpdir(), "pana-branch-"));
	dirs.push(repo);
	const git = (...args: string[]) => testGit(repo, args).trim();
	git("init", "-q");
	git("-c", "user.name=Tester", "-c", "user.email=tester@example.test", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "initial");
	return { repo, git };
}

describe("generated worktree branch names", () => {
	it.each([["session"], ["session", "repo"]])("keeps the preferred name when available: %j", async (...parts) => {
		const t = setup();
		expect(await generatedBranch(t.repo, parts)).toBe(["pana", ...parts].join("/"));
	});

	it.each(["pana", "pana/session", "pana/session/repo", "pana/session/repo/child"])("avoids local exact and prefix collisions: %s", async (branch) => {
		const t = setup();
		t.git("branch", branch);
		const before = t.git("show-ref");
		expect(await generatedBranch(t.repo, ["session", "repo"])).toBe("pana-session-repo");
		expect(t.git("show-ref")).toBe(before);
	});

	it("uses flat suffixes when the fallback has exact or descendant collisions", async () => {
		const t = setup();
		for (const branch of ["pana", "pana-session-repo", "pana-session-repo-2/child", "pana-session-repo-3"]) t.git("branch", branch);
		expect(await generatedBranch(t.repo, ["session", "repo"])).toBe("pana-session-repo-4");
	});

	it("does not confuse similar names with slash-prefix collisions", async () => {
		const t = setup();
		t.git("branch", "pana/session/repository");
		t.git("branch", "panama");
		expect(await generatedBranch(t.repo, ["session", "repo"])).toBe("pana/session/repo");
	});

	it("selects a pushable name when the remote has pana but no local branch does", async () => {
		const t = setup();
		const remote = join(t.repo, "remote.git");
		t.git("init", "--bare", "-q", remote);
		t.git("remote", "add", "origin", remote);
		t.git("push", "-q", "origin", "HEAD:refs/heads/pana");
		t.git("fetch", "-q", "origin");
		expect(t.git("branch", "--list", "pana")).toBe("");
		const branch = await generatedBranch(t.repo, ["session", "repo"]);
		expect(branch).toBe("pana-session-repo");
		t.git("branch", branch);
		t.git("push", "-q", "origin", branch);
		expect(t.git("ls-remote", "--heads", "origin", branch)).toContain(`refs/heads/${branch}`);
	});

	it("checks exact and descendant tracking refs from all remotes, including names with slashes", async () => {
		const t = setup();
		t.git("remote", "add", "team/upstream", join(t.repo, "not-contacted.git"));
		t.git("update-ref", "refs/remotes/team/upstream/pana/session/repo/child", "HEAD");
		t.git("update-ref", "refs/remotes/team/upstream/pana-session-repo", "HEAD");
		expect(await generatedBranch(t.repo, ["session", "repo"])).toBe("pana-session-repo-2");
	});

	it("uses cached refs offline and does not ignore refs whose remote config is absent", async () => {
		const t = setup();
		t.git("update-ref", "refs/remotes/old/pana", "HEAD");
		expect(await generatedBranch(t.repo, ["session"])).toBe("pana-session");
	});
});
