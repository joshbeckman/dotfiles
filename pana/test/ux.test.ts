// WP13: PWA usability. The browser checks live in test/browser/ux.spec.ts; this file covers the
// server's thread inbox (UX-03) and the PWA modules whose logic is pure (UX-01, UX-02, UX-06,
// UX-08).

import { afterEach, describe, expect, it } from "vitest";
import { runPanaCli } from "../src/cli/commands.ts";
import { snippetOf } from "../src/threads/index.ts";
import { startTestPanad, TEST_USER, type TestPanad } from "./harness/index.ts";

interface Person {
	id: string;
	kind: string;
	url: string;
}

interface InboxThread {
	threadId: string;
	threadUrl: string;
	subject: string | null;
	participants: Person[];
	latest: { messageId: string; messageUrl: string; sender: Person; createdAt: number; snippet: string; revised: boolean; redacted: boolean };
	unreadCount: number;
	archived: boolean;
}

interface ThreadInbox {
	participant: Person;
	threads: InboxThread[];
	unreadTotal: number;
	nextCursor: string | null;
}

let t: TestPanad | undefined;
afterEach(async () => {
	await t?.close();
	t = undefined;
});

/** A stopped session row: mail to it queues and wakes nothing, so no model turns are needed. */
async function seedSession(): Promise<string> {
	const id = t!.runtime.newId();
	const now = t!.clock.now();
	await t!.runtime.db.write(async (tx) => {
		await tx.run("INSERT INTO participants (id, kind, url, created_at) VALUES (?, 'session', ?, ?)", id, t!.runtime.url({ kind: "session", id }), now);
		await tx.run("INSERT INTO sessions (id, state, depth, created_at, updated_at) VALUES (?, 'stopped', 0, ?, ?)", id, now, now);
	});
	return id;
}

async function post<T>(path: string, body: unknown, caller?: string): Promise<T> {
	const res = await t!.client.post<T>(path, body, caller ? { caller } : {});
	expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
	await t!.clock.advance(1000);
	return res.body;
}

interface Created {
	thread: { id: string };
	message: { id: string };
}

describe("UX-03 the inbox lists threads by latest activity", () => {
	it("UX-03 one row per thread, newest activity first, with subject, participants, snippet, time, and unread count", async () => {
		t = await startTestPanad();
		const a = await seedSession();
		const b = await seedSession();

		const first = await post<Created>("/threads", { to: [TEST_USER], body: "First thread from A\n\nmore lines" }, a);
		const second = await post<Created>("/threads", { to: [TEST_USER, b], body: "Second thread, three people" }, a);
		const third = await post<Created>("/threads", { to: [a], body: "The user starts this one" });
		// Two more messages in the first thread: it has the newest activity, with two unread.
		const reply = await post<Created>(`/threads/${first.thread.id}/messages`, { after: first.message.id, body: "a follow-up" }, a);
		const long = "word ".repeat(60).trim();
		await post(`/threads/${first.thread.id}/messages`, { after: reply.message.id, body: long }, a);

		const res = await t.client.get<ThreadInbox>("/inbox?view=threads");
		expect(res.status).toBe(200);
		const rows = res.body.threads;
		expect(rows.map((row) => row.threadId)).toEqual([first.thread.id, third.thread.id, second.thread.id]);

		const top = rows[0]!;
		expect(top.subject).toBe("First thread from A");
		expect(top.unreadCount).toBe(3);
		expect(top.latest.sender.url).toBe(t.runtime.url({ kind: "session", id: a }));
		expect(top.latest.snippet).toBe(snippetOf(long));
		expect(top.latest.snippet.length).toBeLessThanOrEqual(141);
		expect(top.latest.snippet.endsWith("…")).toBe(true);
		expect(top.latest.messageUrl).toContain(`?message=${top.latest.messageId}`);
		expect(top.participants.map((p) => p.url).sort()).toEqual([t.runtime.userUrl, t.runtime.url({ kind: "session", id: a })].sort());

		// The user sent the newest message of the third thread: it still shows, with nothing unread.
		expect(rows[1]!.latest.sender.url).toBe(t.runtime.userUrl);
		expect(rows[1]!.unreadCount).toBe(0);
		expect(rows[2]!.participants).toHaveLength(3);
		expect(res.body.unreadTotal).toBe(4);

		// Reading a thread clears its count; the row stays.
		await t.client.get(`/threads/${first.thread.id}`);
		const after = (await t.client.get<ThreadInbox>("/inbox?view=threads")).body;
		expect(after.threads[0]!.unreadCount).toBe(0);
		expect(after.unreadTotal).toBe(1);
	});

	it("UX-03 archived threads leave the inbox and list with archived=1, and new mail brings one back", async () => {
		t = await startTestPanad();
		const a = await seedSession();
		const kept = await post<Created>("/threads", { to: [TEST_USER], body: "kept" }, a);
		const hidden = await post<Created>("/threads", { to: [TEST_USER], body: "hidden" }, a);
		await post(`/threads/${hidden.thread.id}/archive`, {});

		const inbox = (await t.client.get<ThreadInbox>("/inbox?view=threads")).body;
		expect(inbox.threads.map((row) => row.threadId)).toEqual([kept.thread.id]);
		const archived = (await t.client.get<ThreadInbox>("/inbox?view=threads&archived=1")).body;
		expect(archived.threads.map((row) => [row.threadId, row.archived])).toEqual([[hidden.thread.id, true]]);

		await post(`/threads/${hidden.thread.id}/messages`, { after: hidden.message.id, body: "back again" }, a);
		const back = (await t.client.get<ThreadInbox>("/inbox?view=threads")).body;
		expect(back.threads.map((row) => row.threadId)).toEqual([hidden.thread.id, kept.thread.id]);
	});

	it("UX-03 pages by cursor without repeating a thread, and a redacted latest message shows as redacted", async () => {
		t = await startTestPanad();
		const a = await seedSession();
		const ids: string[] = [];
		let last: Created | undefined;
		for (let i = 0; i < 7; i++) {
			last = await post<Created>("/threads", { to: [TEST_USER], body: `thread ${i}` }, a);
			ids.unshift(last.thread.id);
		}
		await post(`/messages/${last!.message.id}/redact`, {});

		const seen: string[] = [];
		let cursor: string | null = null;
		let pages = 0;
		do {
			const res: { status: number; body: ThreadInbox } = await t.client.get<ThreadInbox>(`/inbox?view=threads&limit=3${cursor ? `&cursor=${cursor}` : ""}`);
			expect(res.status).toBe(200);
			seen.push(...res.body.threads.map((row) => row.threadId));
			cursor = res.body.nextCursor;
			pages++;
		} while (cursor && pages < 10);
		expect(seen).toEqual(ids);
		expect(pages).toBe(3);

		const top = (await t.client.get<ThreadInbox>("/inbox?view=threads&limit=1")).body.threads[0]!;
		expect(top.latest).toMatchObject({ redacted: true, snippet: "[redacted]" });
	});

	it("UX-03 the delivery inbox stays the default, so `session inbox` still lists deliveries, and an unknown view is a 400", async () => {
		t = await startTestPanad();
		const a = await seedSession();
		await post("/threads", { to: [TEST_USER, a], body: "to both" });
		const deliveries = await t.client.get<{ deliveries: unknown[] }>("/inbox");
		expect(deliveries.status).toBe(200);
		expect(Array.isArray(deliveries.body.deliveries)).toBe(true);

		const cli = await runPanaCli(["session", "inbox", a], { endpoint: { socketPath: t.panad.socketPath } });
		expect(cli.exitCode, JSON.stringify(cli.body)).toBe(0);
		expect((cli.body as { deliveries: unknown[] }).deliveries).toHaveLength(1);

		const bad = await t.client.get<{ error: { code: string } }>("/inbox?view=messages");
		expect(bad.status).toBe(400);
		expect(bad.body.error.code).toBe("invalid_view");
	});

	it("UX-03 snippets collapse whitespace and cut at a word", () => {
		expect(snippetOf("  a\n\nb\tc  ")).toBe("a b c");
		expect(snippetOf("alpha beta gamma delta", 12)).toBe("alpha beta…");
		expect(snippetOf(undefined)).toBe("");
	});
});
