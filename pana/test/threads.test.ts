import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { statusToExitCode } from "../src/api/errors.ts";
import { wakeRequestId } from "../src/db/outbox.ts";
import {
	configureDelivery,
	postNotice,
	type DeliveredEvent,
	type DeliveryHooks,
} from "../src/threads/index.ts";
import { FAUX_MODEL, startTestPanad, TEST_DOMAIN, TEST_USER, type TestPanad } from "./harness/index.ts";

interface Person {
	id: string;
	kind: string;
	url: string;
}

interface MessageBody {
	id: string;
	url: string;
	threadId: string;
	threadUrl: string;
	seq: number;
	sender: Person;
	createdAt: number;
	body?: string;
	revised: boolean;
	redacted: boolean;
	display?: string;
	readAt?: number | null;
}

interface ThreadBody {
	thread: {
		id: string;
		url: string;
		subject: string | null;
		createdBy: Person;
		createdAt: number;
		participants: Array<Person & { joinedAt: number; joinedMessageId: string | null }>;
	};
	message: MessageBody;
}

interface ReadBody {
	thread: ThreadBody["thread"];
	messages: MessageBody[];
}

interface SearchBody {
	threads: Array<{
		threadId: string;
		threadUrl: string;
		subject: string | null;
		messageId?: string;
		messageUrl?: string;
		snippet: string;
		matched: "subject" | "message";
		createdAt: number;
	}>;
}

interface InboxBody {
	participant: Person;
	deliveries: Array<{
		id: string;
		messageId: string;
		messageUrl: string;
		threadId: string;
		threadUrl: string;
		subject: string | null;
		sender: Person;
		recipients: Array<Person & { readAt: number | null }>;
		createdAt: number;
		deliveredAt: number;
		readAt: number | null;
		body?: string;
		revised: boolean;
		redacted: boolean;
	}>;
}

let t: TestPanad | undefined;
afterEach(async () => {
	await t?.close();
	t = undefined;
});

async function start(options: Parameters<typeof startTestPanad>[0] = {}): Promise<TestPanad> {
	t = await startTestPanad(options);
	return t;
}

/** Insert a session row. With `conversation`, the session is wakeable through pi-durable. */
async function seedSession(t: TestPanad, state = "idle", conversation = false): Promise<string> {
	const id = t.runtime.newId();
	const now = t.clock.now();
	let conversationId: number | null = null;
	if (conversation) {
		const created = await t.runtime.harness.createConversation(
			{ ownership: { kind: "ownerless" }, agent: { model: FAUX_MODEL } },
			ctx,
		);
		conversationId = created.id;
	}
	await t.runtime.db.write(async (tx) => {
		await tx.run("INSERT INTO participants (id, kind, url, created_at) VALUES (?, 'session', ?, ?)", id, t.runtime.url({ kind: "session", id }), now);
		await tx.run(
			"INSERT INTO sessions (id, conversation_id, state, depth, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)",
			id,
			conversationId,
			state,
			now,
			now,
		);
	});
	return id;
}

/** Replace the WP3 delivery hook for this panad and collect what it sees. */
function captureDeliveries(t: TestPanad): DeliveredEvent[] {
	const events: DeliveredEvent[] = [];
	setHooks(t, {
		onDelivered: async (tx, event) => {
			events.push(event);
			if (event.requestId) await tx.run("UPDATE deliveries SET wake_submission_id = 1 WHERE id = ?", event.deliveryId);
		},
	});
	return events;
}

function setHooks(t: TestPanad, hooks: DeliveryHooks): void {
	configureDelivery(t.runtime, hooks);
}

async function createThread(t: TestPanad, to: string[], body = "hello", options: { caller?: string } = {}): Promise<ThreadBody> {
	const res = await t.client.post<ThreadBody>("/threads", { to, body }, options);
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body;
}

function count(t: TestPanad, table: string): Promise<number> {
	return t.runtime.db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`).then((row) => row!.n);
}

describe("threads", () => {
	it("THR-01 thread create makes a thread whose participants are the caller, A, and B", async () => {
		const t = await start();
		const a = await seedSession(t);
		const b = await seedSession(t);
		const created = await createThread(t, [a, b]);

		expect(created.thread.participants.map((p) => p.id).sort()).toEqual([TEST_USER, a, b].sort());
		expect(created.thread.createdBy).toEqual({ id: TEST_USER, kind: "user", url: t.runtime.userUrl });
		expect(created.thread.url).toBe(`pana://${TEST_DOMAIN}/threads/${created.thread.id}`);
		expect(created.message.sender.id).toBe(TEST_USER);
		expect(created.message.body).toBe("hello");
		expect(created.thread.subject).toBe("hello");
	});

	it("THR-02 every message gets one delivery per participant except its sender", async () => {
		const t = await start();
		const a = await seedSession(t, "idle", true);
		const b = await seedSession(t, "idle", true);
		const events = captureDeliveries(t);

		const created = await createThread(t, [a, b]);
		const first = await t.runtime.db.all<{ id: string; recipient_id: string; wake_request_id: string | null }>(
			"SELECT id, recipient_id, wake_request_id FROM deliveries WHERE message_id = ? ORDER BY recipient_id",
			created.message.id,
		);
		expect(first.map((row) => row.recipient_id)).toEqual([a, b].sort());
		expect(first.map((row) => row.wake_request_id)).toEqual(first.map((row) => wakeRequestId(row.id)));

		const reply = await t.client.post<ThreadBody>("/threads/" + created.thread.id + "/messages", { after: created.message.id, body: "reply" }, { caller: a });
		expect(reply.status).toBe(200);
		const second = await t.runtime.db.all<{ recipient_id: string }>(
			"SELECT recipient_id FROM deliveries WHERE message_id = ? ORDER BY recipient_id",
			reply.body.message.id,
		);
		expect(second.map((row) => row.recipient_id)).toEqual([b, TEST_USER].sort());
		expect(events).toHaveLength(4);
		expect(events.filter((event) => event.requestId !== null).map((event) => event.recipientId).sort()).toEqual([a, b, b].sort());
	});

	it("THR-02 onDelivered runs inside the append transaction, so a failure rolls back its writes", async () => {
		const t = await start();
		await t.runtime.db.exec("CREATE TABLE hook_marks (id TEXT PRIMARY KEY)");
		const a = await seedSession(t);
		let sawTx = false;

		setHooks(t, {
			onDelivered: async (tx, event) => {
				sawTx = true;
				await tx.run("INSERT INTO hook_marks (id) VALUES (?)", event.deliveryId);
			},
		});
		await createThread(t, [a]);
		expect(sawTx).toBe(true);
		expect(await count(t, "hook_marks")).toBe(1);
		expect(await count(t, "deliveries")).toBe(1);

		setHooks(t, {
			onDelivered: async (tx, event) => {
				await tx.run("INSERT INTO hook_marks (id) VALUES (?)", event.deliveryId);
				throw new Error("hook failed");
			},
		});
		const before = { threads: await count(t, "threads"), messages: await count(t, "messages"), deliveries: await count(t, "deliveries") };
		const failed = await t.client.post("/threads", { to: [a], body: "second" });
		expect(failed.status).toBe(500);
		expect(await count(t, "hook_marks")).toBe(1);
		expect({
			threads: await count(t, "threads"),
			messages: await count(t, "messages"),
			deliveries: await count(t, "deliveries"),
		}).toEqual(before);
	});

	it("THR-03 respond without --after exits 2 (400)", async () => {
		const t = await start();
		const created = await createThread(t, []);
		const res = await t.client.post("/threads/" + created.thread.id + "/messages", { body: "no head" });
		expect(res.status).toBe(400);
		expect(statusToExitCode(res.status)).toBe(2);
		expect(res.body).toMatchObject({ error: { code: "missing_after" } });
	});

	it("THR-04 respond after the newest message appends it", async () => {
		const t = await start();
		const a = await seedSession(t);
		const created = await createThread(t, [a]);
		const res = await t.client.post<ThreadBody>("/threads/" + created.thread.id + "/messages", { after: created.message.id, body: "next" });
		expect(res.status).toBe(200);
		expect(res.body.message.seq).toBe(2);
		const read = await t.client.get<ReadBody>("/threads/" + created.thread.id);
		expect(read.body.messages.map((m) => m.body)).toEqual(["hello", "next"]);
	});

	it("THR-05 respond after an older message is 409 with the newer IDs and appends nothing", async () => {
		const t = await start();
		const created = await createThread(t, []);
		const second = await t.client.post<ThreadBody>("/threads/" + created.thread.id + "/messages", { after: created.message.id, body: "second" });

		const stale = await t.client.post("/threads/" + created.thread.id + "/messages", { after: created.message.id, body: "late" });
		expect(stale.status).toBe(409);
		expect(statusToExitCode(stale.status)).toBe(3);
		expect(stale.body).toMatchObject({ error: { code: "stale", newer: [second.body.message.id] } });
		expect(await count(t, "messages")).toBe(2);
	});

	it("THR-06 respond after a message in another thread is 400", async () => {
		const t = await start();
		const one = await createThread(t, [], "one");
		const two = await createThread(t, [], "two");
		const res = await t.client.post("/threads/" + two.thread.id + "/messages", { after: one.message.id, body: "wrong" });
		expect(res.status).toBe(400);
		expect(res.body).toMatchObject({ error: { code: "wrong_thread" } });
		expect(await count(t, "messages")).toBe(2);
	});

	it("THR-07 two concurrent responds with the same --after make one append and one 409", async () => {
		const t = await start();
		const created = await createThread(t, []);
		const path = "/threads/" + created.thread.id + "/messages";
		const [first, second] = await Promise.all([
			t.client.post<ThreadBody>(path, { after: created.message.id, body: "one" }),
			t.client.post<ThreadBody>(path, { after: created.message.id, body: "two" }),
		]);
		expect([first.status, second.status].sort()).toEqual([200, 409]);
		expect(await count(t, "messages")).toBe(2);
	});

	it("THR-08 --cc adds a participant who receives this message and later ones, not earlier ones", async () => {
		const t = await start();
		const a = await seedSession(t);
		const c = await seedSession(t);
		const created = await createThread(t, [a]);

		const res = await t.client.post<ThreadBody>(
			"/threads/" + created.thread.id + "/messages",
			{ after: created.message.id, body: "with cc", cc: [c] },
		);
		expect(res.status).toBe(200);
		const joined = res.body.thread.participants.find((p) => p.id === c);
		expect(joined?.joinedMessageId).toBe(res.body.message.id);

		const cDeliveries = await t.runtime.db.all<{ message_id: string }>("SELECT message_id FROM deliveries WHERE recipient_id = ? ORDER BY id", c);
		expect(cDeliveries.map((row) => row.message_id)).toEqual([res.body.message.id]);

		const third = await t.client.post<ThreadBody>("/threads/" + created.thread.id + "/messages", { after: res.body.message.id, body: "later" });
		expect(third.status).toBe(200);
		const after = await t.runtime.db.all<{ message_id: string }>("SELECT message_id FROM deliveries WHERE recipient_id = ? ORDER BY id", c);
		expect(after.map((row) => row.message_id)).toEqual([res.body.message.id, third.body.message.id]);
	});

	it("THR-09 a session outside the thread cannot respond, but the user can and joins", async () => {
		const t = await start();
		const a = await seedSession(t);
		const b = await seedSession(t);
		const outsiderSession = await seedSession(t);
		const asSession = await t.client.post<ThreadBody>("/threads", { to: [b], body: "session thread" }, { caller: a });
		expect(asSession.status).toBe(201);

		const outsider = await t.client.post(
			"/threads/" + asSession.body.thread.id + "/messages",
			{ after: asSession.body.message.id, body: "intruder" },
			{ caller: outsiderSession },
		);
		expect(outsider.status).toBe(403);
		expect(statusToExitCode(outsider.status)).toBe(1);

		const user = await t.client.post<ThreadBody>("/threads/" + asSession.body.thread.id + "/messages", {
			after: asSession.body.message.id,
			body: "user joins",
		});
		expect(user.status).toBe(200);
		const joined = user.body.thread.participants.find((p) => p.id === TEST_USER);
		expect(joined).toBeDefined();
		expect(joined?.joinedMessageId).toBeNull();

		const next = await t.client.post<ThreadBody>("/threads/" + asSession.body.thread.id + "/messages", {
			after: user.body.message.id,
			body: "later",
		}, { caller: a });
		expect(next.status).toBe(200);
		const forUser = await t.runtime.db.get("SELECT 1 FROM deliveries WHERE message_id = ? AND recipient_id = ?", next.body.message.id, TEST_USER);
		expect(forUser).toBeDefined();
	});

	it("THR-10 thread read returns messages in order with sender URLs and revisions, and marks them read", async () => {
		const t = await start();
		const a = await seedSession(t);
		const created = await createThread(t, [a], "first line\nsecond line");
		const second = await t.client.post<ThreadBody>("/threads/" + created.thread.id + "/messages", { after: created.message.id, body: "second" });
		await t.client.post("/messages/" + created.message.id + "/revisions", { body: "first line, edited" });

		const read = await t.client.get<ReadBody>("/threads/" + created.thread.id, { caller: a });
		expect(read.status).toBe(200);
		expect(read.body.thread.subject).toBe("first line");
		expect(read.body.messages.map((m) => m.id)).toEqual([created.message.id, second.body.message.id]);
		expect(read.body.messages.map((m) => m.sender.url)).toEqual([t.runtime.userUrl, t.runtime.userUrl]);
		expect(read.body.messages.map((m) => m.createdAt)).toEqual([t.clock.now(), t.clock.now()]);
		expect(read.body.messages.map((m) => m.body)).toEqual(["first line, edited", "second"]);
		expect(read.body.messages[0]!.revised).toBe(true);

		const unread = await t.runtime.db.all<{ read_at: number | null }>("SELECT read_at FROM deliveries WHERE recipient_id = ? AND thread_id = ?", a, created.thread.id);
		expect(unread).toHaveLength(2);
		expect(unread.every((row) => typeof row.read_at === "number")).toBe(true);
	});

	it("THR-11 nonmembers read threads and messages without joining, subscribing, or changing others' read state", async () => {
		const t = await start();
		const member = await seedSession(t);
		const outsider = await seedSession(t);
		const created = await createThread(t, [member], "original");
		const threadPath = "/threads/" + created.thread.id;
		const messagePath = "/messages/" + created.message.id;
		await t.client.post(messagePath + "/revisions", { body: "edited" });
		const deliveriesBefore = await t.runtime.db.all("SELECT * FROM deliveries WHERE thread_id = ?", created.thread.id);

		const thread = await t.client.get<ReadBody>(threadPath, { caller: outsider });
		expect(thread.status).toBe(200);
		expect(thread.body.messages).toHaveLength(1);
		expect(thread.body.messages[0]).toMatchObject({ id: created.message.id, body: "edited", revised: true });
		expect(thread.body.messages[0]).not.toHaveProperty("readAt");
		expect(thread.body.thread.participants.map((p) => p.id)).not.toContain(outsider);

		// Plain reads and both ways to request a read receipt affect only the caller.
		for (const suffix of ["", "?read=1"]) {
			const message = await t.client.get<{ message: MessageBody }>(messagePath + suffix, { caller: outsider });
			expect(message.status).toBe(200);
			expect(message.body.message).toMatchObject({ id: created.message.id, body: "edited", revised: true });
			expect(message.body.message).not.toHaveProperty("readAt");
		}
		const marked = await t.client.post<{ message: MessageBody }>(messagePath + "/read", {}, { caller: outsider });
		expect(marked.status).toBe(200);
		expect(marked.body.message).not.toHaveProperty("readAt");
		expect(await t.runtime.db.all("SELECT * FROM deliveries WHERE thread_id = ?", created.thread.id)).toEqual(deliveriesBefore);
		expect(await t.runtime.db.get("SELECT 1 FROM thread_participants WHERE thread_id = ? AND participant_id = ?", created.thread.id, outsider)).toBeUndefined();

		// Reading does not grant reply permission or the ability to act for a recipient.
		expect((await t.client.post(threadPath + "/messages", { after: created.message.id, body: "not allowed" }, { caller: outsider })).status).toBe(403);
		expect((await t.client.get("/inbox?participant=" + member, { caller: outsider })).status).toBe(403);
		expect((await t.client.get(messagePath + "?participant=" + member + "&read=1", { caller: outsider })).status).toBe(403);
		expect((await t.client.post(messagePath + "/read", { participant: member }, { caller: outsider })).status).toBe(403);
		expect(await t.runtime.db.all("SELECT * FROM deliveries WHERE thread_id = ?", created.thread.id)).toEqual(deliveriesBefore);

		await t.client.post(messagePath + "/redact", {});
		const redactedThread = await t.client.get<ReadBody>(threadPath, { caller: outsider });
		const redactedMessage = await t.client.get<{ message: MessageBody }>(messagePath, { caller: outsider });
		for (const message of [redactedThread.body.messages[0]!, redactedMessage.body.message]) {
			expect(message.redacted).toBe(true);
			expect(message).not.toHaveProperty("body");
		}

		const later = await t.client.post<ThreadBody>(threadPath + "/messages", { after: created.message.id, body: "later" });
		expect(later.status).toBe(200);
		expect(await t.runtime.db.all("SELECT * FROM deliveries WHERE recipient_id = ?", outsider)).toEqual([]);
		const outsiderInbox = await t.client.get<InboxBody>("/inbox", { caller: outsider });
		expect(outsiderInbox.body.deliveries).toEqual([]);
		expect((await t.client.get("/threads/" + t.runtime.newId(), { caller: outsider })).status).toBe(404);
		expect((await t.client.get("/messages/" + t.runtime.newId(), { caller: outsider })).status).toBe(404);
	});

	it("SRC-01 a created thread gets a first-line subject, its messages search, and revisions and redactions follow", async () => {
		const t = await start();
		const a = await seedSession(t);
		const created = await createThread(t, [a], "Launch notes\nwith a second line");
		expect(created.thread.subject).toBe("Launch notes");
		const written = await t.runtime.db.get<{ subject: string | null }>("SELECT subject FROM threads WHERE id = ?", created.thread.id);
		expect(written?.subject).toBe("Launch notes");

		const bySubject = await t.client.get<SearchBody>("/threads?query=Launch");
		expect(bySubject.status).toBe(200);
		const subjectHit = bySubject.body.threads.find((thread) => thread.matched === "subject");
		expect(subjectHit).toMatchObject({ threadId: created.thread.id, subject: "Launch notes" });
		expect(bySubject.body.threads.every((thread) => thread.threadId === created.thread.id)).toBe(true);

		const byBody = await t.client.get<SearchBody>("/threads?query=second");
		const hit = byBody.body.threads.find((thread) => thread.messageId === created.message.id);
		expect(hit).toMatchObject({ threadId: created.thread.id, matched: "message", messageId: created.message.id });
		expect(hit?.snippet).toContain("second");

		const reply = await t.client.post<ThreadBody>("/threads/" + created.thread.id + "/messages", { after: created.message.id, body: "apollo project kickoff" });
		expect(reply.status).toBe(200);
		const replied = await t.client.get<SearchBody>("/threads?query=apollo");
		expect(replied.body.threads.map((thread) => thread.messageId)).toEqual([reply.body.message.id]);

		await t.client.post("/messages/" + reply.body.message.id + "/revisions", { body: "zephyr project kickoff" });
		expect((await t.client.get<SearchBody>("/threads?query=apollo")).body.threads).toEqual([]);
		expect((await t.client.get<SearchBody>("/threads?query=zephyr")).body.threads.map((thread) => thread.messageId)).toEqual([
			reply.body.message.id,
		]);

		await t.client.post("/messages/" + reply.body.message.id + "/redact", {});
		expect((await t.client.get<SearchBody>("/threads?query=zephyr")).body.threads).toEqual([]);
		expect((await t.client.get<SearchBody>("/threads?query=nothing-matches-this")).body.threads).toEqual([]);
	});
});

describe("edits and redactions", () => {
	it("EDT-01 only the user may revise or redact", async () => {
		const t = await start();
		const a = await seedSession(t);
		const created = await createThread(t, [a]);
		const revise = await t.client.post("/messages/" + created.message.id + "/revisions", { body: "nope" }, { caller: a });
		expect(revise.status).toBe(403);
		const redact = await t.client.post("/messages/" + created.message.id + "/redact", {}, { caller: a });
		expect(redact.status).toBe(403);

		const allowed = await t.client.post<{ message: MessageBody }>("/messages/" + created.message.id + "/revisions", { body: "yes" });
		expect(allowed.status).toBe(200);
		expect(allowed.body.message.body).toBe("yes");
	});

	it("EDT-02 a revision appends an event, reads show the newest body and revised, and the original stays", async () => {
		const t = await start();
		const created = await createThread(t, [], "original");
		const revised = await t.client.post<{ message: MessageBody }>("/messages/" + created.message.id + "/revisions", { body: "edited" });
		expect(revised.status).toBe(200);
		expect(revised.body.message.body).toBe("edited");
		expect(revised.body.message.revised).toBe(true);

		const stored = await t.runtime.db.get<{ body: string }>("SELECT body FROM messages WHERE id = ?", created.message.id);
		expect(stored?.body).toBe("original");
		const events = await t.runtime.db.all<{ kind: string; body: string | null }>("SELECT kind, body FROM message_events WHERE message_id = ?", created.message.id);
		expect(events).toEqual([{ kind: "message.revised", body: "edited" }]);

		const read = await t.client.get<ReadBody>("/threads/" + created.thread.id);
		expect(read.body.messages[0]!.body).toBe("edited");
		expect(read.body.messages[0]!.revised).toBe(true);
	});

	it("EDT-03 a redaction appends an event, reads show [redacted] and no body", async () => {
		const t = await start();
		const created = await createThread(t, [], "secret");
		const redacted = await t.client.post<{ message: MessageBody }>("/messages/" + created.message.id + "/redact", {});
		expect(redacted.status).toBe(200);
		expect(redacted.body.message.redacted).toBe(true);
		expect(redacted.body.message.body).toBeUndefined();
		expect(redacted.body.message.display).toBe("[redacted]");

		const stored = await t.runtime.db.get<{ body: string }>("SELECT body FROM messages WHERE id = ?", created.message.id);
		expect(stored?.body).toBe("secret");
		const events = await t.runtime.db.all<{ kind: string }>("SELECT kind FROM message_events WHERE message_id = ?", created.message.id);
		expect(events).toEqual([{ kind: "message.redacted" }]);

		const read = await t.client.get<ReadBody>("/threads/" + created.thread.id);
		expect(read.body.messages[0]!.redacted).toBe(true);
		expect(read.body.messages[0]!.body).toBeUndefined();
	});

	it("EDT-04 no source file issues UPDATE or DELETE on messages", () => {
		const root = join(import.meta.dirname, "..", "src");
		const files = (readdirSync(root, { recursive: true }) as string[]).filter((name) => name.endsWith(".ts"));
		expect(files.length).toBeGreaterThan(5);
		const offenders: string[] = [];
		for (const name of files) {
			const text = readFileSync(join(root, name), "utf8");
			if (/\bUPDATE\s+(?:OR\s+\w+\s+)?"?messages"?\b/i.test(text) || /\bDELETE\s+FROM\s+"?messages"?\b/i.test(text)) {
				offenders.push(name);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("EDT-05 revisions and redactions create no deliveries and no wakes", async () => {
		const t = await start();
		const a = await seedSession(t, "idle", true);
		const events = captureDeliveries(t);
		const created = await createThread(t, [a]);
		const deliveries = await count(t, "deliveries");
		expect(events).toHaveLength(1);

		await t.client.post("/messages/" + created.message.id + "/revisions", { body: "edited" });
		await t.client.post("/messages/" + created.message.id + "/redact", {});

		expect(await count(t, "deliveries")).toBe(deliveries);
		expect(events).toHaveLength(1);
		const wakes = await t.runtime.db.all("SELECT id FROM deliveries WHERE wake_submission_id IS NOT NULL");
		expect(wakes).toHaveLength(1);
	});
});

describe("inbox", () => {
	it("INB-01 inbox lists deliveries with message, thread, subject, sender, recipients, time, and read state, newest first", async () => {
		const t = await start();
		const a = await seedSession(t);
		const first = await createThread(t, [a], "first subject");
		const second = await createThread(t, [a], "second subject");

		const res = await t.client.get<InboxBody>("/inbox", { caller: a });
		expect(res.status).toBe(200);
		expect(res.body.participant.id).toBe(a);
		expect(res.body.deliveries.map((d) => d.messageId)).toEqual([second.message.id, first.message.id]);

		const newest = res.body.deliveries[0]!;
		expect(newest.threadId).toBe(second.thread.id);
		expect(newest.subject).toBe("second subject");
		expect(newest.sender.url).toBe(t.runtime.userUrl);
		expect(newest.createdAt).toBe(t.clock.now());
		expect(newest.readAt).toBeNull();
		expect(newest.recipients.map((r) => r.id)).toEqual([a]);
		expect(newest.recipients.every((r) => r.readAt === null)).toBe(true);
	});

	it("INB-02 reading one message returns it in full and marks it read for the session", async () => {
		const t = await start();
		const a = await seedSession(t);
		const created = await createThread(t, [a], "read me");

		const res = await t.client.post<{ message: MessageBody }>("/messages/" + created.message.id + "/read", {}, { caller: a });
		expect(res.status).toBe(200);
		expect(res.body.message.id).toBe(created.message.id);
		expect(res.body.message.body).toBe("read me");
		expect(res.body.message.sender.url).toBe(t.runtime.userUrl);
		expect(typeof res.body.message.readAt).toBe("number");

		const inbox = await t.client.get<InboxBody>("/inbox", { caller: a });
		expect(inbox.body.deliveries[0]!.readAt).toBe(t.clock.now());
	});

	it("INB-03 GET /inbox answers for the caller, a session may not read another session's inbox, and the user may read any", async () => {
		const t = await start();
		const a = await seedSession(t);
		const b = await seedSession(t);
		await createThread(t, [a]);

		const asSession = await t.client.get<InboxBody>("/inbox", { caller: a });
		expect(asSession.body.participant.id).toBe(a);
		const asUser = await t.client.get<InboxBody>("/inbox");
		expect(asUser.body.participant.id).toBe(TEST_USER);

		const cross = await t.client.get("/inbox?participant=" + a, { caller: b });
		expect(cross.status).toBe(403);
		expect(statusToExitCode(cross.status)).toBe(1);

		const byUser = await t.client.get<InboxBody>("/inbox?participant=" + a);
		expect(byUser.status).toBe(200);
		expect(byUser.body.participant.id).toBe(a);
		expect(byUser.body.deliveries.map((d) => d.sender.url)).toEqual([t.runtime.userUrl]);
	});
});

describe("notices", () => {
	it("NTC-01 a notice posts as the domain URL, delivers to users only, and never wakes a session", async () => {
		const t = await start();
		const a = await seedSession(t);
		const calls: DeliveredEvent[] = [];
		setHooks(t, {
			onDelivered: async (_tx, event) => {
				calls.push(event);
			},
		});

		const notice = await postNotice(t.runtime, { body: "budget reached", to: [a, TEST_USER] });
		expect(notice.message.sender).toEqual({ id: TEST_DOMAIN, kind: "domain", url: `pana://${TEST_DOMAIN}` });
		expect(notice.thread.createdBy.id).toBe(TEST_DOMAIN);
		expect(notice.thread.participants.map((p) => p.id).sort()).toEqual([TEST_DOMAIN, TEST_USER].sort());

		const rows = await t.runtime.db.all<{ recipient_id: string; wake_request_id: string | null; wake_submission_id: number | null }>(
			"SELECT recipient_id, wake_request_id, wake_submission_id FROM deliveries WHERE message_id = ?",
			notice.message.id,
		);
		expect(rows).toEqual([{ recipient_id: TEST_USER, wake_request_id: null, wake_submission_id: null }]);
		expect(calls).toEqual([]);

		const inbox = await t.client.get<InboxBody>("/inbox");
		expect(inbox.body.deliveries.map((d) => d.sender.url)).toEqual([`pana://${TEST_DOMAIN}`]);
	});
});
