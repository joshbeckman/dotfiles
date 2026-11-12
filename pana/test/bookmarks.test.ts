// WP21: the user's saved messages. BKM-01 is the write, BKM-02 the list, BKM-03 the mark on a
// thread read. Every test is named for the item it proves.

import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../src/cli/index.ts";
import { KEYMAP } from "../web/keys.js";
import { routeFromHash, SECTIONS } from "../web/links.js";
import { apiName, viewName } from "../web/perf.js";
import { bookmarkRow, messageView } from "../web/views.js";
import { startTestPanad, TEST_USER, type TestPanad } from "./harness/index.ts";

interface Person {
	id: string;
	kind: string;
	url: string;
}

interface MessageBody {
	id: string;
	url: string;
	threadId: string;
	seq: number;
	sender: Person;
	createdAt: number;
	body?: string;
	revised: boolean;
	redacted: boolean;
	bookmarked?: true;
}

interface ThreadBody {
	thread: { id: string; url: string; subject: string | null };
	message: MessageBody;
}

interface ReadBody {
	thread: ThreadBody["thread"];
	messages: MessageBody[];
}

interface BookmarkBody {
	participant: Person;
	bookmarks: Array<{
		messageId: string;
		messageUrl: string;
		threadId: string;
		threadUrl: string;
		subject: string | null;
		sender: Person;
		createdAt: number;
		bookmarkedAt: number;
		snippet: string;
		revised: boolean;
		redacted: boolean;
	}>;
	nextCursor: string | null;
}

let t: TestPanad | undefined;
afterEach(async () => {
	await t?.close();
	t = undefined;
});

async function start(): Promise<TestPanad> {
	t = await startTestPanad();
	return t;
}

/** Insert a session row, as threads.test.ts does. */
async function seedSession(t: TestPanad): Promise<string> {
	const id = t.runtime.newId();
	const now = t.clock.now();
	await t.runtime.db.write(async (tx) => {
		await tx.run("INSERT INTO participants (id, kind, url, created_at) VALUES (?, 'session', ?, ?)", id, t.runtime.url({ kind: "session", id }), now);
		await tx.run(
			"INSERT INTO sessions (id, conversation_id, state, depth, created_at, updated_at) VALUES (?, NULL, 'idle', 0, ?, ?)",
			id,
			now,
			now,
		);
	});
	return id;
}

async function createThread(t: TestPanad, body = "hello"): Promise<ThreadBody> {
	const session = await seedSession(t);
	const res = await t.client.post<ThreadBody>("/threads", { to: [session], body });
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body;
}

function rows(t: TestPanad): Promise<number> {
	return t.runtime.db.get<{ n: number }>("SELECT count(*) AS n FROM message_bookmarks").then((row) => row!.n);
}

describe("bookmarks", () => {
	it("BKM-01 the user bookmarks a message, a second save keeps its first time, and unbookmark removes it", async () => {
		const t = await start();
		const created = await createThread(t);
		const id = created.message.id;

		const saved = await t.client.post<{ message: MessageBody; bookmarked: boolean }>(`/messages/${id}/bookmark`, {});
		expect(saved.status, JSON.stringify(saved.body)).toBe(200);
		expect(saved.body.bookmarked).toBe(true);
		expect(saved.body.message.bookmarked).toBe(true);
		expect(await rows(t)).toBe(1);
		const first = await t.runtime.db.get<{ created_at: number }>("SELECT created_at FROM message_bookmarks WHERE message_id = ?", id);

		await t.clock.advance(5_000);
		const again = await t.client.post<{ bookmarked: boolean }>(`/messages/${id}/bookmark`, {});
		expect(again.status).toBe(200);
		expect(await rows(t)).toBe(1);
		const second = await t.runtime.db.get<{ created_at: number }>("SELECT created_at FROM message_bookmarks WHERE message_id = ?", id);
		expect(second!.created_at).toBe(first!.created_at);

		const removed = await t.client.post<{ message: MessageBody; bookmarked: boolean }>(`/messages/${id}/unbookmark`, {});
		expect(removed.status).toBe(200);
		expect(removed.body.bookmarked).toBe(false);
		expect(removed.body.message.bookmarked).toBeUndefined();
		expect(await rows(t)).toBe(0);
	});

	it("BKM-01 only the user may bookmark, and an unknown message is not found", async () => {
		const t = await start();
		const session = await seedSession(t);
		const created = await t.client.post<ThreadBody>("/threads", { to: [session], body: "hello" }, { caller: session });
		const asSession = await t.client.post(`/messages/${created.body.message.id}/bookmark`, {}, { caller: session });
		expect(asSession.status).toBe(403);
		expect((asSession.body as { error: { code: string } }).error.code).toBe("forbidden");
		expect(await rows(t)).toBe(0);

		const missing = await t.client.post(`/messages/${t.runtime.newId()}/bookmark`, {});
		expect(missing.status).toBe(404);
		const missingRemove = await t.client.post(`/messages/${t.runtime.newId()}/unbookmark`, {});
		expect(missingRemove.status).toBe(404);
	});

	it("BKM-02 the list is newest save first, names the thread and sender, and pages with a cursor", async () => {
		const t = await start();
		const created = await createThread(t, "first message");
		const threadId = created.thread.id;
		const reply = await t.client.post<ThreadBody>(`/threads/${threadId}/messages`, { after: created.message.id, body: "second message" });
		expect(reply.status, JSON.stringify(reply.body)).toBe(200);

		await t.client.post(`/messages/${created.message.id}/bookmark`, {});
		await t.clock.advance(1_000);
		await t.client.post(`/messages/${reply.body.message.id}/bookmark`, {});

		const list = await t.client.get<BookmarkBody>("/bookmarks");
		expect(list.status).toBe(200);
		expect(list.body.bookmarks.map((row) => row.messageId)).toEqual([reply.body.message.id, created.message.id]);
		const newest = list.body.bookmarks[0]!;
		expect(newest.threadId).toBe(threadId);
		expect(newest.threadUrl).toBe(created.thread.url);
		expect(newest.messageUrl).toBe(reply.body.message.url);
		expect(newest.subject).toBe("first message");
		expect(newest.sender).toEqual({ id: TEST_USER, kind: "user", url: t.runtime.userUrl });
		expect(newest.snippet).toBe("second message");
		expect(newest.createdAt).toBe(reply.body.message.createdAt);
		expect(newest.bookmarkedAt).toBeGreaterThan(list.body.bookmarks[1]!.bookmarkedAt);

		const firstPage = await t.client.get<BookmarkBody>("/bookmarks?limit=1");
		expect(firstPage.body.bookmarks).toHaveLength(1);
		expect(firstPage.body.nextCursor).toBeTruthy();
		const secondPage = await t.client.get<BookmarkBody>(`/bookmarks?limit=1&cursor=${encodeURIComponent(firstPage.body.nextCursor!)}`);
		expect(secondPage.body.bookmarks.map((row) => row.messageId)).toEqual([created.message.id]);
		expect(secondPage.body.nextCursor).toBeNull();

		const empty = await t.client.get<BookmarkBody>("/bookmarks?limit=1&cursor=not-a-cursor");
		expect(empty.status).toBe(400);
		expect((empty.body as unknown as { error: { code: string } }).error.code).toBe("invalid_cursor");
	});

	it("BKM-02 a bookmark lists from an archived thread and reads `[redacted]` after a redaction", async () => {
		const t = await start();
		const created = await createThread(t, "keep this");
		const id = created.message.id;
		await t.client.post(`/messages/${id}/bookmark`, {});
		await t.client.post(`/threads/${created.thread.id}/archive`, {});

		const before = await t.client.get<BookmarkBody>("/bookmarks");
		expect(before.body.bookmarks.map((row) => row.messageId)).toEqual([id]);
		expect(before.body.bookmarks[0]!.redacted).toBe(false);

		await t.client.post(`/messages/${id}/redact`, {});
		const after = await t.client.get<BookmarkBody>("/bookmarks");
		expect(after.body.bookmarks[0]).toMatchObject({ messageId: id, redacted: true, snippet: "[redacted]" });
	});

	it("BKM-03 a thread read marks the caller's bookmarked messages and never another reader's", async () => {
		const t = await start();
		const session = await seedSession(t);
		const created = await t.client.post<ThreadBody>("/threads", { to: [session], body: "hello" });
		expect(created.status, JSON.stringify(created.body)).toBe(201);
		const threadId = created.body.thread.id;
		const id = created.body.message.id;
		await t.client.post(`/messages/${id}/bookmark`, {});

		const mine = await t.client.get<ReadBody>(`/threads/${threadId}`);
		expect(mine.body.messages.find((message) => message.id === id)!.bookmarked).toBe(true);

		// The session has its own reader row, and the user's bookmark is not it.
		const theirs = await t.client.get<ReadBody>(`/threads/${threadId}`, { caller: session });
		expect(theirs.body.messages.find((message) => message.id === id)!.bookmarked).toBeUndefined();

		await t.client.post(`/messages/${id}/unbookmark`, {});
		const cleared = await t.client.get<ReadBody>(`/threads/${threadId}`);
		expect(cleared.body.messages.find((message) => message.id === id)!.bookmarked).toBeUndefined();
	});

	it("BKM-03 a single message read carries the mark too", async () => {
		const t = await start();
		const created = await createThread(t);
		await t.client.post(`/messages/${created.message.id}/bookmark`, {});
		const read = await t.client.get<{ message: MessageBody }>(`/messages/${created.message.id}`);
		expect(read.body.message.bookmarked).toBe(true);
	});
});


/** Run one `pana` command line against this panad, as a session started by the harness would. */
async function cli(t: TestPanad, argv: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	let stdout = "";
	let stderr = "";
	const code = await main(argv, {
		env: { PANA_STATE: t.dir },
		stdin: Readable.from([]),
		stdout: { write: (chunk) => (stdout += chunk), isTTY: true },
		stderr: { write: (chunk) => (stderr += chunk), isTTY: true },
	});
	return { code, stdout, stderr };
}

describe("bookmark surface", () => {
	it("BKM-04 the message view carries the reader's bookmark", () => {
		const base = { id: "M", threadId: "T", sender: { url: "pana://d/users/u", kind: "user" }, createdAt: 1 };
		expect(messageView(base).bookmarked).toBe(false);
		expect(messageView({ ...base, bookmarked: true }).bookmarked).toBe(true);
	});

	it("BKM-05 the section, its route, its key, and its measured names follow the list", async () => {
		const section = SECTIONS.find((candidate) => candidate.id === "bookmarks");
		expect(section).toEqual({ id: "bookmarks", title: "Bookmarks", route: "#/bookmarks" });
		expect(routeFromHash("#/bookmarks")).toMatchObject({ section: "bookmarks", id: undefined, rest: [] });
		expect(viewName("#/bookmarks")).toBe("#/bookmarks");
		expect(KEYMAP.find((binding) => binding.action === "go:bookmarks")?.sequences).toEqual([["g", "b"]]);
		expect(apiName("GET", "/bookmarks?limit=10")).toBe("GET /bookmarks");
		expect(apiName("POST", "/messages/01KE6P4YM0J41B1MJ5ZZ2WGMXQ/bookmark")).toBe("POST /messages/:id/bookmark");
		expect(apiName("POST", "/messages/01KE6P4YM0J41B1MJ5ZZ2WGMXQ/unbookmark")).toBe("POST /messages/:id/unbookmark");

		// The row the list draws: the message's own link, its thread, and the save time.
		const t = await start();
		const created = await createThread(t, "a saved thought");
		await t.client.post(`/messages/${created.message.id}/bookmark`, {});
		const body = await t.client.get<BookmarkBody>("/bookmarks");
		const row = bookmarkRow(body.body.bookmarks[0]);
		expect(row).toEqual({
			messageId: created.message.id,
			messageUrl: created.message.url,
			threadId: created.thread.id,
			threadUrl: created.thread.url,
			subject: "a saved thought",
			sender: { url: t.runtime.userUrl, kind: "user" },
			snippet: "a saved thought",
			at: created.message.createdAt,
			bookmarkedAt: body.body.bookmarks[0]!.bookmarkedAt,
		});
		// The list opens the message where it sits in its thread (UX-05), through `appHref`.
		expect(routeFromHash(`#/threads/${row.threadId}?message=${row.messageId}`)).toMatchObject({
			section: "threads",
			id: row.threadId,
		});
	});

	it("BKM-06 pana bookmark add, list, and remove work against a live panad", async () => {
		const t = await start();
		const created = await createThread(t, "command line");

		const added = await cli(t, ["bookmark", "add", created.message.id]);
		expect(added.code, added.stderr).toBe(0);
		expect(added.stdout).toContain("bookmarked: true");

		const listed = await cli(t, ["bookmark", "list"]);
		expect(listed.code, listed.stderr).toBe(0);
		expect(listed.stdout).toContain(created.message.id);
		expect(listed.stdout).toContain("command line");

		const removed = await cli(t, ["bookmark", "remove", created.message.id]);
		expect(removed.code, removed.stderr).toBe(0);
		expect(removed.stdout).toContain("bookmarked: false");
		const empty = await cli(t, ["bookmark", "list", "--json"]);
		expect(JSON.parse(empty.stdout)).toMatchObject({ bookmarks: [], nextCursor: null });
	});
});
