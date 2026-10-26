import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { statusToExitCode } from "../src/api/errors.ts";
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
	});
});
