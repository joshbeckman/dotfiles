import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { statusToExitCode } from "../src/api/errors.ts";
import * as gitModule from "../src/memory/git.ts";
import { runGit } from "../src/memory/git.ts";
import { FAKE_EPOCH, startTestPanad, TEST_DOMAIN, TEST_USER, type TestPanad } from "./harness/index.ts";

let t: TestPanad | undefined;
afterEach(async () => {
	await t?.close();
	t = undefined;
});

/** Run git in the harness's isolated environment and return stdout, failing on a non-zero exit. */
async function git(args: string[]): Promise<string> {
	const result = await runGit(args);
	if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout.replace(/\n$/, "");
}

function repo(): string {
	return t!.runtime.paths.memoryGit;
}

/** A session row so `Pana-Caller` can name it (API-03). */
async function addSession(harness: TestPanad): Promise<string> {
	const id = harness.runtime.newId();
	const now = harness.clock.now();
	await harness.runtime.db.write(async (tx) => {
		await tx.run(
			"INSERT INTO participants (id, kind, url, created_at) VALUES (?, 'session', ?, ?)",
			id,
			harness.runtime.url({ kind: "session", id }),
			now,
		);
		await tx.run("INSERT INTO sessions (id, state, depth, created_at, updated_at) VALUES (?, 'idle', 0, ?, ?)", id, now, now);
	});
	return id;
}

async function worktree(caller?: string): Promise<string> {
	const res = await t!.client.get<{ path: string }>("/memory/worktree", caller ? { caller } : undefined);
	expect(res.status).toBe(200);
	return res.body.path;
}

async function commit(message: string, caller?: string) {
	return t!.client.post<{
		committed: boolean;
		commit?: { hash: string; authorUrl: string; email: string; time: string; message: string };
	}>("/memory/commit", { message }, caller ? { caller } : undefined);
}

describe("memory", () => {
	it("MEM-01 on first start memory.git is a bare repo with one empty commit on main", async () => {
		t = await startTestPanad();
		const gitDir = repo();
		expect(existsSync(gitDir)).toBe(true);
		expect(await git(["-C", gitDir, "rev-parse", "--is-bare-repository"])).toBe("true");
		expect(await git(["-C", gitDir, "rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
		expect(await git(["-C", gitDir, "rev-list", "--count", "main"])).toBe("1");
		expect(await git(["-C", gitDir, "ls-tree", "-r", "main"])).toBe("");
	});

	it("MEM-02 memory prints the caller's worktree path, creating it from main", async () => {
		t = await startTestPanad();

		const first = await t.client.get<{ path: string; branch: string; created: boolean }>("/memory/worktree");
		expect(first.status).toBe(200);
		expect(first.body.path).toBe(join(t.runtime.paths.memoryWorktrees, TEST_USER));
		expect(first.body.branch).toBe(`writer/${TEST_USER}`);
		expect(first.body.created).toBe(true);
		expect(existsSync(join(first.body.path, ".git"))).toBe(true);
		expect(await git(["-C", first.body.path, "rev-parse", "--abbrev-ref", "HEAD"])).toBe(`writer/${TEST_USER}`);
		expect(await git(["-C", first.body.path, "rev-parse", "HEAD"])).toBe(await git(["-C", repo(), "rev-parse", "main"]));

		const again = await t.client.get<{ path: string; created: boolean }>("/memory/worktree");
		expect(again.body.path).toBe(first.body.path);
		expect(again.body.created).toBe(false);

		const session = await addSession(t);
		const created = await t.client.post<{ path: string; branch: string }>("/memory/worktree", undefined, { caller: session });
		expect(created.status).toBe(201);
		expect(created.body.path).toBe(join(t.runtime.paths.memoryWorktrees, session));
		expect(created.body.branch).toBe(`writer/${session}`);
		expect(await git(["-C", created.body.path, "rev-parse", "--abbrev-ref", "HEAD"])).toBe(`writer/${session}`);
	});

	it("MEM-03 memory commit stages, commits with the caller as author, rebases, and moves main", async () => {
		t = await startTestPanad();
		const path = await worktree();
		mkdirSync(join(path, "notes"), { recursive: true });
		writeFileSync(join(path, "notes", "first.md"), "# First\n\nhello\n");

		const res = await commit("add the first note");
		expect(res.status).toBe(200);
		expect(res.body.committed).toBe(true);
		expect(res.body.commit?.authorUrl).toBe(t.runtime.userUrl);
		expect(res.body.commit?.email).toBe(`${TEST_USER}@${TEST_DOMAIN}`);
		expect(res.body.commit?.message).toBe("add the first note");

		expect(await git(["-C", repo(), "log", "-1", "--format=%an|%ae|%s", "main"])).toBe(
			`${t.runtime.userUrl}|${TEST_USER}@${TEST_DOMAIN}|add the first note`,
		);
		expect(await git(["-C", repo(), "show", "main:notes/first.md"])).toBe("# First\n\nhello");
		// main moved to the writer's commit, and the worktree followed.
		expect(await git(["-C", repo(), "rev-parse", "main"])).toBe(await git(["-C", path, "rev-parse", `writer/${TEST_USER}`]));
		expect(await git(["-C", repo(), "rev-list", "--count", "main"])).toBe("2");
	});

	it("MEM-04 a rebase conflict aborts, keeps the commit on the writer branch, and exits 3 with paths", async () => {
		t = await startTestPanad();
		const session = await addSession(t);
		const sessionPath = await worktree(session);
		const userPath = await worktree();
		expect(sessionPath).not.toBe(userPath);

		writeFileSync(join(userPath, "shared.md"), "from the user\n");
		expect((await commit("user writes shared")).status).toBe(200);
		const userMain = await git(["-C", repo(), "rev-parse", "main"]);

		writeFileSync(join(sessionPath, "shared.md"), "from the session\n");
		const res = await t.client.post<{ error: { code: string; paths: string[] } }>(
			"/memory/commit",
			{ message: "session writes shared" },
			{ caller: session },
		);

		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe("conflict");
		expect(res.body.error.paths).toEqual(["shared.md"]);
		expect(statusToExitCode(res.status)).toBe(3);

		// main did not move, and the session's commit is still on its own branch.
		expect(await git(["-C", repo(), "rev-parse", "main"])).toBe(userMain);
		expect(await git(["-C", repo(), "log", "--format=%s", "-1", `writer/${session}`])).toBe("session writes shared");
		// The rebase was aborted: no rebase state and no conflicted index entries.
		expect(await git(["-C", sessionPath, "status", "--porcelain"])).toBe("");
		expect(existsSync(await git(["-C", sessionPath, "rev-parse", "--git-path", "rebase-merge"]))).toBe(false);
		expect(existsSync(await git(["-C", sessionPath, "rev-parse", "--git-path", "rebase-apply"]))).toBe(false);
	});

	it("MEM-05 two writers committing different files at once both land on main", async () => {
		t = await startTestPanad();
		const a = await addSession(t);
		const b = await addSession(t);
		const pathA = await worktree(a);
		const pathB = await worktree(b);
		mkdirSync(join(pathA, "notes"), { recursive: true });
		mkdirSync(join(pathB, "notes"), { recursive: true });
		writeFileSync(join(pathA, "notes", "a.md"), "alpha\n");
		writeFileSync(join(pathB, "notes", "b.md"), "beta\n");

		const [first, second] = await Promise.all([commit("writer a", a), commit("writer b", b)]);
		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect(first.body.committed).toBe(true);
		expect(second.body.committed).toBe(true);

		expect(await git(["-C", repo(), "rev-list", "--count", "main"])).toBe("3");
		const subjects = (await git(["-C", repo(), "log", "--format=%s", "main"])).split("\n");
		expect(subjects).toHaveLength(3);
		expect(subjects.slice(0, 2).sort()).toEqual(["writer a", "writer b"]);
		expect(subjects[2]).toBe("Initialize memory");
		const authors = new Set((await git(["-C", repo(), "log", "--format=%an", "main"])).split("\n"));
		expect(authors.has(t.runtime.url({ kind: "session", id: a }))).toBe(true);
		expect(authors.has(t.runtime.url({ kind: "session", id: b }))).toBe(true);
		expect(await git(["-C", repo(), "show", "main:notes/a.md"])).toBe("alpha");
		expect(await git(["-C", repo(), "show", "main:notes/b.md"])).toBe("beta");
	});

	it("MEM-06 memory commit with no changes exits 0 and creates no commit", async () => {
		t = await startTestPanad();
		await worktree();

		const empty = await commit("nothing to see");
		expect(empty.status).toBe(200);
		expect(empty.body.committed).toBe(false);
		expect(empty.body.commit).toBeUndefined();
		expect(await git(["-C", repo(), "rev-list", "--count", "main"])).toBe("1");

		const path = await worktree();
		writeFileSync(join(path, "note.md"), "one\n");
		expect((await commit("add note")).body.committed).toBe(true);
		const again = await commit("still nothing");
		expect(again.status).toBe(200);
		expect(again.body.committed).toBe(false);
		expect(await git(["-C", repo(), "rev-list", "--count", "main"])).toBe("2");
	});

	it("MEM-07 memory search runs a case-insensitive git grep over main", async () => {
		t = await startTestPanad();
		const path = await worktree();
		mkdirSync(join(path, "notes"), { recursive: true });
		writeFileSync(join(path, "notes", "greeting.md"), "Hello World\nsecond hello line\n");
		writeFileSync(join(path, "other.md"), "nothing to find here\n");
		expect((await commit("seed memory")).status).toBe(200);

		const res = await t.client.get<{ results: Array<{ path: string; line: number; text: string }>; tree: string }>(
			"/memory/search?query=hello",
		);
		expect(res.status).toBe(200);
		expect(res.body.tree).toBe("main");
		expect(res.body.results).toEqual([
			{ path: "notes/greeting.md", line: 1, text: "Hello World" },
			{ path: "notes/greeting.md", line: 2, text: "second hello line" },
		]);

		const none = await t.client.get<{ results: unknown[] }>("/memory/search?query=absent");
		expect(none.status).toBe(200);
		expect(none.body.results).toEqual([]);

		expect((await t.client.get("/memory/search")).status).toBe(400);
	});

	it("MEM-08 memory log returns commits with author URL, time, and message", async () => {
		t = await startTestPanad();
		const path = await worktree();
		writeFileSync(join(path, "one.md"), "one\n");
		expect((await commit("first commit")).status).toBe(200);
		await t.clock.advance(60_000);
		writeFileSync(join(path, "two.md"), "two\n");
		expect((await commit("second commit")).status).toBe(200);

		const res = await t.client.get<{
			commits: Array<{ hash: string; authorUrl: string; email: string; time: string; message: string }>;
		}>("/memory/log");
		expect(res.status).toBe(200);
		expect(res.body.commits.map((c) => c.message)).toEqual(["second commit", "first commit", "Initialize memory"]);
		const newest = res.body.commits[0]!;
		expect(newest.authorUrl).toBe(t.runtime.userUrl);
		expect(newest.email).toBe(`${TEST_USER}@${TEST_DOMAIN}`);
		expect(newest.hash).toMatch(/^[0-9a-f]{40}$/);
		expect(new Date(newest.time).getTime()).toBe(FAKE_EPOCH + 60_000);

		const filtered = await t.client.get<{ commits: Array<{ message: string }> }>("/memory/log?path=one.md");
		expect(filtered.status).toBe(200);
		expect(filtered.body.commits.map((c) => c.message)).toEqual(["first commit"]);

		const limited = await t.client.get<{ commits: unknown[] }>("/memory/log?limit=1");
		expect(limited.body.commits).toHaveLength(1);
	});

	it("MEM-09 memory edits from the PWA commit as the user through the same path as MEM-03", async () => {
		t = await startTestPanad();
		const res = await t.tcp.post<{ path: string; committed: boolean; commit?: { authorUrl: string; email: string } }>(
			"/memory/files/knowledge/today.md",
			{ content: "# Today\n\nWrote from the PWA.\n", message: "pwa: add today" },
		);
		expect(res.status).toBe(201);
		expect(res.body).toMatchObject({ path: "knowledge/today.md", committed: true });
		expect(res.body.commit?.authorUrl).toBe(t.runtime.userUrl);
		expect(res.body.commit?.email).toBe(`${TEST_USER}@${TEST_DOMAIN}`);
		expect(await git(["-C", repo(), "show", "main:knowledge/today.md"])).toBe("# Today\n\nWrote from the PWA.");
		expect(await git(["-C", repo(), "log", "-1", "--format=%an|%s", "main"])).toBe(
			`${t.runtime.userUrl}|pwa: add today`,
		);

		// A PWA edit without a message still commits through the same path.
		const edited = await t.tcp.post<{ commit?: { message: string } }>("/memory/files/knowledge/today.md", {
			content: "# Today\n\nEdited again.\n",
		});
		expect(edited.status).toBe(201);
		expect(edited.body.commit?.message).toBe("Update knowledge/today.md");

		const read = await t.tcp.get<{ path: string; content: string }>("/memory/files/knowledge/today.md");
		expect(read.status).toBe(200);
		expect(read.body.path).toBe("knowledge/today.md");
		expect(read.body.content).toBe("# Today\n\nEdited again.\n");

		expect((await t.tcp.get("/memory/files/knowledge/missing.md")).status).toBe(404);
		expect((await t.tcp.post("/memory/files/%2e%2e%2fescape.md", { content: "nope" })).status).toBe(400);
		// A control character would split `git show`'s patch headers; it is not a path.
		expect((await t.tcp.post("/memory/files/a%0Ab.md", { content: "nope" })).status).toBe(400);
	});

	it("MEM-09 reads return content and revision from one snapshot even if main advances mid-read", async () => {
		t = await startTestPanad();
		await t.tcp.post("/memory/files/snapshot.md", { content: "before\n" });
		const before = await git(["-C", repo(), "rev-parse", "main"]);
		const original = gitModule.runGit;
		let advanced = false;
		const spy = vi.spyOn(gitModule, "runGit").mockImplementation(async (args, options) => {
			if (!advanced && args.includes("cat-file") && args.at(-1)?.endsWith(":snapshot.md")) {
				advanced = true;
				expect((await t!.tcp.post("/memory/files/snapshot.md", { content: "after\n" })).status).toBe(201);
			}
			return original(args, options);
		});
		try {
			const read = await t.tcp.get<{ commit: string; content: string }>("/memory/files/snapshot.md");
			expect(advanced).toBe(true);
			expect(read.body).toMatchObject({ commit: before, content: "before\n" });
		} finally {
			spy.mockRestore();
		}
	});

	it("MEM-09 UI save fast-forwards a clean stale worktree before editing a session-created file", async () => {
		t = await startTestPanad();
		const path = await worktree(); // Exists before the session creates the file.
		const session = await addSession(t);
		expect((await t.client.post("/memory/files/profile.md", { content: "Principal engineer\n" }, { caller: session })).status).toBe(201);
		const read = await t.tcp.get<{ content: string; commit: string }>("/memory/files/profile.md");
		expect(read.status).toBe(200);
		expect(existsSync(join(path, "profile.md"))).toBe(false);
		const saved = await t.tcp.post("/memory/files/profile.md", { content: "Senior Staff engineer\n", baseCommit: read.body.commit });
		expect(saved.status).toBe(201);
		expect(await git(["-C", repo(), "show", "main:profile.md"])).toBe("Senior Staff engineer");
		expect(await git(["-C", repo(), "log", "-1", "--format=%an", "main"])).toBe(t.runtime.userUrl);
		expect(await git(["-C", path, "status", "--porcelain"])).toBe("");
		const again = await t.tcp.post("/memory/files/profile.md", { content: "Senior Staff engineer\n" });
		expect(again.status).toBe(200); // No redundant commit on retry.
	});

	it("MEM-09 UI save updates an existing stale file without reverting unrelated session changes", async () => {
		t = await startTestPanad();
		await t.tcp.post("/memory/files/profile.md", { content: "old\n" });
		const session = await addSession(t);
		await t.client.post("/memory/files/profile.md", { content: "current\n" }, { caller: session });
		await t.client.post("/memory/files/other.md", { content: "keep\n" }, { caller: session });
		const read = await t.tcp.get<{ commit: string }>("/memory/files/profile.md");
		const saved = await t.tcp.post("/memory/files/profile.md", { content: "edited current\n", baseCommit: read.body.commit });
		expect(saved.status).toBe(201);
		expect(await git(["-C", repo(), "show", "main:other.md"])).toBe("keep");
	});

	it("MEM-09 UI save rejects dirty and unpublished worktrees without changing or publishing them", async () => {
		t = await startTestPanad();
		await t.tcp.post("/memory/files/profile.md", { content: "published\n" });
		const path = await worktree();
		const main = await git(["-C", repo(), "rev-parse", "main"]);
		writeFileSync(join(path, "profile.md"), "local edit\n");
		writeFileSync(join(path, "untracked.md"), "untracked\n");
		const status = await git(["-C", path, "status", "--porcelain"]);
		const dirty = await t.tcp.post<{ error: { code: string } }>("/memory/files/profile.md", { content: "UI edit\n" });
		expect(dirty.status).toBe(409);
		expect(dirty.body.error.code).toBe("dirty_worktree");
		expect(await git(["-C", path, "status", "--porcelain"])).toBe(status);
		expect(readFileSync(join(path, "profile.md"), "utf8")).toBe("local edit\n");
		await git(["-C", path, "add", "-A"]);
		await git(["-C", path, "commit", "-qm", "unpublished local work"]);
		const head = await git(["-C", path, "rev-parse", "HEAD"]);
		for (let i = 0; i < 2; i++) {
			const blocked = await t.tcp.post("/memory/files/profile.md", { content: "UI edit\n" });
			expect(blocked.status).toBe(409);
			expect(await git(["-C", path, "rev-parse", "HEAD"])).toBe(head);
			expect(await git(["-C", repo(), "rev-parse", "main"])).toBe(main);
		}
	});

	it("MEM-09 UI save detects stale editor content but allows unrelated main changes", async () => {
		t = await startTestPanad();
		await t.tcp.post("/memory/files/profile.md", { content: "original\n" });
		const read = await t.tcp.get<{ commit: string }>("/memory/files/profile.md");
		const session = await addSession(t);
		await t.client.post("/memory/files/other.md", { content: "unrelated\n" }, { caller: session });
		expect((await t.tcp.post("/memory/files/profile.md", { content: "first edit\n", baseCommit: read.body.commit })).status).toBe(201);
		const main = await git(["-C", repo(), "rev-parse", "main"]);
		const stale = await t.tcp.post<{ error: { code: string } }>("/memory/files/profile.md", { content: "stale edit\n", baseCommit: read.body.commit });
		expect(stale.status).toBe(409);
		expect(stale.body.error.code).toBe("stale_file");
		expect(await git(["-C", repo(), "rev-parse", "main"])).toBe(main);
		expect(await git(["-C", await worktree(), "status", "--porcelain"])).toBe("");
	});

	it("MEM-09 UI creation never overwrites an existing file and validates its base revision", async () => {
		t = await startTestPanad();
		expect((await t.tcp.post("/memory/files/new.md", { content: "new\n", baseCommit: null })).status).toBe(201);
		expect((await t.tcp.post("/memory/files/new.md", { content: "overwrite\n", baseCommit: null })).status).toBe(409);
		for (const baseCommit of [123, "main", "0".repeat(40)]) {
			expect((await t.tcp.post("/memory/files/new.md", { content: "bad\n", baseCommit })).status).toBe(400);
		}
	});

	it("MEM-09 stale editor cannot recreate a deleted file and saves reject symlink paths", async () => {
		t = await startTestPanad();
		await t.tcp.post("/memory/files/notes/keep.md", { content: "keep\n" });
		const read = await t.tcp.get<{ commit: string }>("/memory/files/notes/keep.md");
		const session = await addSession(t);
		expect((await t.client.delete("/memory/files/notes/keep.md", { caller: session })).status).toBe(200);
		expect((await t.tcp.post("/memory/files/notes/keep.md", { content: "stale\n", baseCommit: read.body.commit })).status).toBe(409);
		const path = await worktree();
		mkdirSync(join(path, "notes"), { recursive: true });
		writeFileSync(join(path, "notes/keep.md"), "keep\n");
		symlinkSync(join(path, "notes"), join(path, "link"));
		symlinkSync(join(path, "missing"), join(path, "dangling"));
		await commit("seed symlinks");
		for (const target of ["link/keep.md", "dangling/new.md"]) {
			expect((await t.tcp.post(`/memory/files/${target}`, { content: "unsafe\n" })).status).toBe(400);
		}
		expect(readFileSync(join(path, "notes/keep.md"), "utf8")).toBe("keep\n");
		expect(existsSync(join(path, "missing"))).toBe(false);
	});

	it("MEM-09 concurrent UI saves by the same writer are serialized before writing or staging", async () => {
		t = await startTestPanad();
		await t.tcp.post("/memory/files/shared.md", { content: "original\n" });
		const read = await t.tcp.get<{ commit: string }>("/memory/files/shared.md");
		const results = await Promise.all(["one\n", "two\n"].map(content =>
			t!.tcp.post("/memory/files/shared.md", { content, baseCommit: read.body.commit })));
		expect(results.map(r => r.status).sort()).toEqual([201, 409]);
		expect(await git(["-C", repo(), "rev-list", "--count", "main"])).toBe("3");
		expect(await git(["-C", await worktree(), "status", "--porcelain"])).toBe("");
	});

	it("MEM-13 deletion removes the file from main, listing and search but preserves attributed history", async () => {
		t = await startTestPanad();
		await t.tcp.post("/memory/files/notes/two%20words.md", { content: "unique-memory-text\n" });
		const deleted = await t.tcp.delete<{ committed: boolean; commit: { hash: string; authorUrl: string; message: string } }>("/memory/files/notes/two%20words.md");
		expect(deleted.status).toBe(200);
		expect(deleted.body.committed).toBe(true);
		expect(deleted.body.commit.authorUrl).toBe(t.runtime.userUrl);
		expect(deleted.body.commit.message).toBe("Delete notes/two words.md");
		expect((await t.tcp.get("/memory/files/notes/two%20words.md")).status).toBe(404);
		expect((await t.tcp.get<{ files: unknown[] }>("/memory/files")).body.files).toEqual([]);
		expect((await t.tcp.get<{ results: unknown[] }>("/memory/search?query=unique-memory-text")).body.results).toEqual([]);
		const detail = await t.tcp.get<{ files: Array<{ path: string; status: string; patch: string }> }>(`/memory/commits/${deleted.body.commit.hash}`);
		expect(detail.body.files[0]).toMatchObject({ path: "notes/two words.md", status: "deleted" });
		expect(detail.body.files[0]!.patch).toContain("-unique-memory-text");
		expect(await git(["-C", repo(), "show", "main^:notes/two words.md"])).toBe("unique-memory-text");
		expect((await t.tcp.delete("/memory/files/notes/two%20words.md")).status).toBe(404);
	});

	it("MEM-13 deletion fast-forwards a clean stale user worktree to include session-created files", async () => {
		t = await startTestPanad();
		await worktree();
		const session = await addSession(t);
		await t.client.post("/memory/files/from-session.md", { content: "session note" }, { caller: session });
		const deleted = await t.tcp.delete("/memory/files/from-session.md", { body: { message: "Remove old note" } });
		expect(deleted.status).toBe(200);
		expect(await git(["-C", repo(), "log", "-1", "--format=%s", "main"])).toBe("Remove old note");
		expect((await t.tcp.get("/memory/files/from-session.md")).status).toBe(404);
	});

	it("MEM-13 deletion rejects unsafe paths, directories, symlinks and dirty or unpublished worktrees", async () => {
		t = await startTestPanad();
		await t.tcp.post("/memory/files/notes/keep.md", { content: "keep me" });
		expect((await t.tcp.delete("/memory/files/%2e%2e%2fescape.md")).status).toBe(400);
		expect((await t.tcp.delete("/memory/files/.git")).status).toBe(400);
		expect((await t.tcp.delete("/memory/files/notes")).status).toBe(400);
		const path = await worktree();
		writeFileSync(join(path, "local.md"), "uncommitted");
		expect((await t.tcp.delete("/memory/files/notes/keep.md")).status).toBe(409);
		expect((await t.tcp.get("/memory/files/notes/keep.md")).status).toBe(200);
		await git(["-C", path, "add", "local.md"]);
		await git(["-C", path, "commit", "-qm", "unpublished"]);
		expect((await t.tcp.delete("/memory/files/notes/keep.md")).status).toBe(409);
		await commit("publish local");
		writeFileSync(join(path, ".gitignore"), "ignored.md\n");
		await commit("ignore local file");
		writeFileSync(join(path, "ignored.md"), "not memory");
		expect((await t.tcp.delete("/memory/files/ignored.md")).status).toBe(404);
		expect(existsSync(join(path, "ignored.md"))).toBe(true);
		symlinkSync(join(path, "notes"), join(path, "link"));
		await commit("add symlink");
		expect((await t.tcp.delete("/memory/files/link/keep.md")).status).toBe(400);
		expect((await t.tcp.get("/memory/files/notes/keep.md")).status).toBe(200);
	});

	it("MEM-10 a commit view has its message, author, file statuses, and patch", async () => {
		t = await startTestPanad();
		await t.tcp.post("/memory/files/notes.md", { content: "one\ntwo\n", message: "first notes" });
		t.clock.advance(60_000);
		const written = await t.tcp.post<{ commit: { hash: string } }>("/memory/files/notes.md", {
			content: "one\nTWO\nthree\n",
			message: "second notes",
		});
		expect(written.status).toBe(201);
		const hash = written.body.commit.hash;

		const shown = await t.tcp.get<{
			hash: string;
			short: string;
			subject: string;
			message: string;
			authorUrl: string;
			time: string;
			parents: string[];
			truncated: boolean;
			files: Array<{ path: string; status: string; additions: number; deletions: number; binary: boolean; patch: string; truncated: boolean }>;
		}>(`/memory/commits/${hash}`);
		expect(shown.status).toBe(200);
		expect(shown.body).toMatchObject({
			hash,
			short: hash.slice(0, 8),
			subject: "second notes",
			message: "second notes",
			authorUrl: t.runtime.userUrl,
			truncated: false,
		});
		expect(new Date(shown.body.time).getTime()).toBe(FAKE_EPOCH + 60_000);
		expect(shown.body.parents).toHaveLength(1);
		expect(shown.body.files).toHaveLength(1);
		expect(shown.body.files[0]).toMatchObject({
			path: "notes.md",
			status: "modified",
			additions: 2,
			deletions: 1,
			binary: false,
			truncated: false,
		});
		expect(shown.body.files[0]!.patch).toContain("-two");
		expect(shown.body.files[0]!.patch).toContain("+TWO");
		expect(shown.body.files[0]!.patch).toContain("+three");

		// An abbreviated hash resolves to the same commit, since that is what a log row shows.
		const short = await t.tcp.get<{ hash: string }>(`/memory/commits/${hash.slice(0, 8)}`);
		expect(short.status).toBe(200);
		expect(short.body.hash).toBe(hash);

		expect((await t.tcp.get("/memory/commits/deadbeef")).status).toBe(404);
		// Not a hash, but never a git option either.
		expect((await t.tcp.get("/memory/commits/--help")).status).toBe(400);
	});
});

describe("memory for sessions", () => {
	it("MEM-02 a plain git commit in a writer's worktree is authored by that writer, not the process's git identity", async () => {
		t = await startTestPanad();
		const session = await addSession(t);
		const path = await worktree(session);
		writeFileSync(join(path, "direct.md"), "written with plain git\n");
		await git(["-C", path, "add", "direct.md"]);
		// No GIT_AUTHOR_* in the environment: the worktree's own config must supply the identity.
		await git(["-C", path, "commit", "-q", "--no-verify", "-m", "direct"]);
		expect(await git(["-C", path, "log", "-1", "--format=%an <%ae>"])).toBe(
			`${t.runtime.url({ kind: "session", id: session })} <${session}@${TEST_DOMAIN}>`,
		);
		// The user's worktree keeps its own identity, and git still treats both as worktrees.
		const mine = await worktree();
		expect(await git(["-C", mine, "config", "user.name"])).toBe(t.runtime.userUrl);
		expect(await git(["-C", mine, "rev-parse", "--is-bare-repository"])).toBe("false");
		// `pana memory commit` publishes commits made with plain git, even with a clean tree.
		const published = await commit("publish direct", session);
		expect(published.body.committed).toBe(true);
		expect(await git(["-C", repo(), "log", "-1", "--format=%s", "main"])).toBe("direct");
		expect((await commit("nothing left", session)).body.committed).toBe(false);
	});
});
