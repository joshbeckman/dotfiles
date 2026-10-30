import type { ServerResponse } from "node:http";
import { subscribeEvents } from "../src/web/events.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	applyInitialSubject,
	awaitSubjectJobs,
	firstLineSubject,
	indexMessage,
	indexSessionRun,
	listThreads,
	matchExpression,
	reindexRevision,
	removeRedacted,
	scheduleSubject,
	searchSessions,
	searchThreads,
	subjectHistory,
} from "../src/search/index.ts";
import { startTestPanad, TEST_DOMAIN, TEST_USER, type TestPanad } from "./harness/index.ts";

let t: TestPanad | undefined;
const restores: Array<() => void> = [];

afterEach(async () => {
	for (const restore of restores.splice(0)) restore();
	await t?.close();
	t = undefined;
});

interface Seeded {
	threadId: string;
	messageId: string;
}

/**
 * A thread with one message, written the way WP2 will write it: the message insert, its index row,
 * and the first-line subject share one transaction.
 */
async function seed(panad: TestPanad, body: string, options: { subject?: boolean } = {}): Promise<Seeded> {
	const { db, newId, clock } = panad.runtime;
	const threadId = newId();
	const messageId = newId();
	await db.write(async (tx) => {
		await tx.run(
			"INSERT OR IGNORE INTO participants (id, kind, url, created_at) VALUES (?, 'user', ?, ?)",
			TEST_USER,
			`pana://${TEST_DOMAIN}/users/${TEST_USER}`,
			clock.now(),
		);
		await tx.run("INSERT INTO threads (id, subject, created_by, created_at) VALUES (?, NULL, ?, ?)", threadId, TEST_USER, clock.now());
		await tx.run(
			"INSERT INTO thread_participants (thread_id, participant_id, joined_at) VALUES (?, ?, ?)",
			threadId,
			TEST_USER,
			clock.now(),
		);
		await tx.run(
			"INSERT INTO messages (id, thread_id, seq, sender_id, body, created_at) VALUES (?, ?, 1, ?, ?, ?)",
			messageId,
			threadId,
			TEST_USER,
			body,
			clock.now(),
		);
		await indexMessage(tx, { id: messageId, threadId, body });
		if (options.subject !== false) await applyInitialSubject(tx, { threadId, body, id: newId(), now: clock.now() });
	});
	return { threadId, messageId };
}

async function appendMessages(panad: TestPanad, threadId: string, bodies: string[]): Promise<string[]> {
	const ids: string[] = [];
	await panad.runtime.db.write(async tx => {
		for (const [index, body] of bodies.entries()) {
			const id = panad.runtime.newId(); ids.push(id);
			await tx.run("INSERT INTO messages (id, thread_id, seq, sender_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				id, threadId, index + 2, TEST_USER, body, panad.runtime.clock.now());
		}
	});
	return ids;
}

async function currentSubject(panad: TestPanad, threadId: string): Promise<string | null | undefined> {
	const row = await panad.runtime.db.get<{ subject: string | null }>("SELECT subject FROM threads WHERE id = ?", threadId);
	return row?.subject;
}

describe("SUB subjects", () => {
	it("SUB-02/SUB-04 publish committed subject changes for background jobs and regeneration, but not failures", async () => {
		t = await startTestPanad({ config: { subjectModel: "faux/faux-1" }, script: [
			{ text: "Background subject" }, { text: "Regenerated subject" }, { fail: "provider error" },
		] });
		const seeded = await seed(t, "Initial subject");
		const frames: Array<{ kind: string; threadId?: string; subject?: string }> = [];
		const committed: Array<Promise<string | null | undefined>> = [];
		const stop = subscribeEvents(t.runtime, {
			write(chunk: string) {
				const line = chunk.split("\n").find((line) => line.startsWith("data:"));
				if (line) {
					const event = JSON.parse(line.slice(5));
					if (event.kind === "thread.subject") {
						frames.push(event);
						committed.push(currentSubject(t!, seeded.threadId));
					}
				}
				return true;
			},
			on() { return this; },
		} as unknown as ServerResponse);
		try {
			scheduleSubject(t.runtime, seeded.threadId);
			await awaitSubjectJobs(t.runtime);
			await t.client.post(`/threads/${seeded.threadId}/subject`, { regenerate: true });
			const failed = await t.client.post(`/threads/${seeded.threadId}/subject`, { regenerate: true });
			expect(failed.status).not.toBe(200);
			expect(frames).toEqual([
				expect.objectContaining({ kind: "thread.subject", threadId: seeded.threadId, subject: "Background subject" }),
				expect.objectContaining({ kind: "thread.subject", threadId: seeded.threadId, subject: "Regenerated subject" }),
			]);
			expect(await Promise.all(committed)).toEqual(["Background subject", "Regenerated subject"]);
		} finally { stop(); }
	});
	it("SUB-01 a new thread's subject is the first line of its first message, trimmed to 80 characters", async () => {
		t = await startTestPanad();
		const panad = t;

		const long = "abcdefghij".repeat(12);
		const longThread = await seed(panad, `  ${long}  \nand a second line\n`);
		expect(await currentSubject(panad, longThread.threadId)).toBe(long.slice(0, 80));
		expect((await currentSubject(panad, longThread.threadId))!.length).toBe(80);

		const blank = await seed(panad, "\n\n   Planning the lantern   \nbody follows");
		expect(await currentSubject(panad, blank.threadId)).toBe("Planning the lantern");
		expect(await subjectHistory(panad.runtime, blank.threadId)).toEqual([
			expect.objectContaining({ subject: "Planning the lantern", source: "first-line" }),
		]);

		expect(firstLineSubject("one line\nrest of the body")).toBe("one line");
	});

	it("SUB-02 with subjectModel set a background job replaces the subject, and create does not wait for it", async () => {
		t = await startTestPanad({ config: { subjectModel: "faux/faux-1" }, script: [{ text: "Lantern maintenance plan" }] });
		const panad = t;
		const seeded = await seed(panad, "we should talk about the lantern\nand the schedule");
		expect(panad.model.calls()).toBe(0);

		const queued = scheduleSubject(panad.runtime, seeded.threadId);
		expect(queued).toBeUndefined();
		// The job has not reached the model yet, so a reader still sees the first-line subject.
		expect(panad.model.calls()).toBe(0);
		expect(await currentSubject(panad, seeded.threadId)).toBe("we should talk about the lantern");

		await awaitSubjectJobs(panad.runtime);
		expect(panad.model.calls()).toBe(1);
		expect(await currentSubject(panad, seeded.threadId)).toBe("Lantern maintenance plan");
		expect((await subjectHistory(panad.runtime, seeded.threadId)).map((s) => s.source)).toEqual(["first-line", "model"]);
		// The index moved with the subject.
		expect((await searchThreads(panad.runtime, "Maintenance")).map((h) => h.threadId)).toEqual([seeded.threadId]);
	});

	it("SUB-03 a failed subject job leaves the first-line subject and logs the failure", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		restores.push(() => errors.mockRestore());
		t = await startTestPanad({ config: { subjectModel: "faux/faux-1" }, script: [{ fail: "provider error" }] });
		const panad = t;
		const seeded = await seed(panad, "keep this line\nmore body");

		scheduleSubject(panad.runtime, seeded.threadId);
		await awaitSubjectJobs(panad.runtime);

		expect(await currentSubject(panad, seeded.threadId)).toBe("keep this line");
		expect((await subjectHistory(panad.runtime, seeded.threadId)).map((s) => s.source)).toEqual(["first-line"]);
		const logged = errors.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("subject job"));
		expect(logged).toHaveLength(1);
		expect(logged[0]).toContain(seeded.threadId);
		expect(logged[0]).toContain("provider error");
	});

	it("SUB-04 thread subject --regenerate makes a new subject and keeps the old ones in subjects", async () => {
		t = await startTestPanad({
			config: { subjectModel: "faux/faux-1" },
			script: [{ text: "First model subject" }, { text: "Second model subject" }],
		});
		const panad = t;
		const seeded = await seed(panad, "first line subject\nbody");

		interface SubjectBody {
			subject: string;
			previous: string | null;
			history: Array<{ subject: string; source: string }>;
		}
		const first = await panad.client.post<SubjectBody>(`/threads/${seeded.threadId}/subject`, { regenerate: true });
		expect(first.status).toBe(200);
		expect(first.body.subject).toBe("First model subject");
		expect(first.body.previous).toBe("first line subject");
		expect(first.body.history.map((s) => s.source)).toEqual(["first-line", "model"]);

		const second = await panad.client.post<SubjectBody>(`/threads/${seeded.threadId}/subject?regenerate=true`);
		expect(second.status).toBe(200);
		expect(second.body.history.map((s) => s.subject)).toEqual([
			"first line subject",
			"First model subject",
			"Second model subject",
		]);
		expect(await currentSubject(panad, seeded.threadId)).toBe("Second model subject");

		// Search follows the newest subject; an old one is no longer indexed.
		expect((await searchThreads(panad.runtime, "Second model subject")).map((h) => h.threadId)).toContain(seeded.threadId);
		expect(await searchThreads(panad.runtime, "First model subject")).toEqual([]);
	});

	it("regeneration reads the conversation in order with revisions, never redacted or superseded text", async () => {
		t = await startTestPanad({ config: { subjectModel: "faux/faux-1" }, script: [{ text: "Current topic" }] });
		const panad = t;
		const seeded = await seed(panad, "Hello");
		const [revised, redacted] = await appendMessages(panad, seeded.threadId, ["superseded wording", "private removed content", "Current substantive discussion"]);
		await panad.runtime.db.write(async tx => {
			for (const [id, kind, body] of [[revised, "message.revised", "Corrected discussion"], [redacted, "message.redacted", null]] as const) {
				await tx.run("INSERT INTO message_events (id, message_id, kind, body, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
					panad.runtime.newId(), id!, kind, body, TEST_USER, panad.runtime.clock.now());
			}
		});
		const ask = vi.spyOn(panad.runtime.models, "completeSimple"); restores.push(() => ask.mockRestore());
		const result = await panad.client.post(`/threads/${seeded.threadId}/subject`, { regenerate: true });
		expect(result.status).toBe(200);
		const context = ask.mock.calls[0]![1];
		const input = String(context.messages[0]!.content);
		expect(input).toContain("Hello");
		expect(input).toContain("Corrected discussion");
		expect(input).toContain("Current substantive discussion");
		expect(input.indexOf("Hello")).toBeLessThan(input.indexOf("Corrected discussion"));
		expect(input.indexOf("Corrected discussion")).toBeLessThan(input.indexOf("Current substantive discussion"));
		expect(input).not.toContain("superseded wording");
		expect(input).not.toContain("private removed content");
	});

	it("regeneration works after the greeting is redacted and rejects entirely redacted threads", async () => {
		t = await startTestPanad({ config: { subjectModel: "faux/faux-1" }, script: [{ text: "Later discussion" }] });
		const panad = t;
		const seeded = await seed(panad, "Hello");
		await panad.runtime.db.write(tx => tx.run("INSERT INTO message_events (id, message_id, kind, body, created_by, created_at) VALUES (?, ?, 'message.redacted', NULL, ?, ?)",
			panad.runtime.newId(), seeded.messageId, TEST_USER, panad.runtime.clock.now()));
		const empty = await panad.client.post(`/threads/${seeded.threadId}/subject`, { regenerate: true });
		expect(empty.status).toBe(400);
		expect(panad.model.calls()).toBe(0);
		await appendMessages(panad, seeded.threadId, ["A later substantive discussion"]);
		const result = await panad.client.post(`/threads/${seeded.threadId}/subject`, { regenerate: true });
		expect(result.status).toBe(200);
		expect(await currentSubject(panad, seeded.threadId)).toBe("Later discussion");
	});

	it("regeneration bounds input size and message count while retaining recent context", async () => {
		t = await startTestPanad({ config: { subjectModel: "faux/faux-1" }, script: [{ text: "Recent topic" }, { text: "Latest topic" }] });
		const panad = t;
		const seeded = await seed(panad, "Old greeting");
		await appendMessages(panad, seeded.threadId, Array.from({ length: 120 }, (_, i) => `Discussion number ${i}`));
		const ask = vi.spyOn(panad.runtime.models, "completeSimple"); restores.push(() => ask.mockRestore());
		await panad.client.post(`/threads/${seeded.threadId}/subject`, { regenerate: true });
		const input = String(ask.mock.calls[0]![1].messages[0]!.content);
		expect(input).not.toContain("Old greeting");
		expect(input).toContain("Discussion number 119");
		expect(input.split("\n")).toHaveLength(101);
		const huge = await seed(panad, "a".repeat(100000));
		await appendMessages(panad, huge.threadId, Array.from({ length: 20 }, (_, i) => "b".repeat(10000) + ` recent-${i}`));
		await panad.client.post(`/threads/${huge.threadId}/subject`, { regenerate: true });
		const bounded = String(ask.mock.calls[1]![1].messages[0]!.content);
		expect(bounded.length).toBeLessThanOrEqual(32000);
		expect(bounded).toContain("recent-19");
		expect(bounded).toContain("[message truncated]");
	});

	it("SUB-04 reads the current subject and its history without regenerating", async () => {
		t = await startTestPanad();
		const panad = t;
		const seeded = await seed(panad, "a subject to read");

		const res = await panad.client.post<{ subject: string; history: Array<{ subject: string }> }>(
			`/threads/${seeded.threadId}/subject`,
		);
		expect(res.status).toBe(200);
		expect(res.body.subject).toBe("a subject to read");
		expect(res.body.history.map((s) => s.subject)).toEqual(["a subject to read"]);

		const missing = await panad.client.post("/threads/00000000000000000000000000/subject");
		expect(missing.status).toBe(404);
	});
});

describe("SRC search", () => {
	it("SRC-01 thread search matches subjects and message bodies with FTS5 and returns thread, message, and a snippet", async () => {
		t = await startTestPanad();
		const panad = t;
		const bySubject = await seed(panad, "Quarterly planning notes");
		const byBody = await seed(panad, "Weekly sync\nWe walked through the lantern maintenance plan.");

		const subjectHits = await searchThreads(panad.runtime, "Quarterly");
		const subjectOnly = subjectHits.filter((hit) => hit.matched === "subject");
		expect(subjectOnly.map((hit) => hit.threadId)).toEqual([bySubject.threadId]);
		expect(subjectOnly[0]!.snippet).toContain("[Quarterly]");
		expect(subjectOnly[0]!.messageId).toBeUndefined();
		expect(subjectOnly[0]!.threadUrl).toBe(`pana://${TEST_DOMAIN}/threads/${bySubject.threadId}`);

		const bodyHits = await searchThreads(panad.runtime, "lantern");
		expect(bodyHits).toHaveLength(1);
		expect(bodyHits[0]).toMatchObject({ threadId: byBody.threadId, messageId: byBody.messageId, matched: "message" });
		expect(bodyHits[0]!.snippet).toContain("[lantern]");
		expect(bodyHits[0]!.messageUrl).toBe(
			`pana://${TEST_DOMAIN}/threads/${byBody.threadId}?message=${byBody.messageId}`,
		);

		const viaRoute = await panad.client.get<{ threads: Array<{ messageId?: string }> }>("/threads?query=lantern");
		expect(viaRoute.status).toBe(200);
		expect(viaRoute.body.threads[0]?.messageId).toBe(byBody.messageId);

		// `GET /threads` without a query lists threads, newest first.
		const listed = await listThreads(panad.runtime);
		expect(listed.map((row) => row.threadId)).toEqual([byBody.threadId, bySubject.threadId]);
	});

	it("SRC-01 search text with FTS5 syntax is treated as words, not an error", async () => {
		t = await startTestPanad();
		const panad = t;
		const seeded = await seed(panad, "the lantern and the draft");

		expect(matchExpression("lantern-draft")).toBe('"lantern-draft"');
		expect(await searchThreads(panad.runtime, "lantern -draft")).not.toEqual([]);
		expect(await searchThreads(panad.runtime, '"unbalanced')).toEqual([]);
		const hits = await searchThreads(panad.runtime, "lantern AND draft");
		expect(hits.filter((hit) => hit.matched === "message").map((hit) => hit.messageId)).toEqual([seeded.messageId]);
	});

	it("SRC-02 redacted text is removed from the index and revised text replaces the old text", async () => {
		t = await startTestPanad();
		const panad = t;
		const seeded = await seed(panad, "an early draft about lanterns", { subject: false });
		expect((await searchThreads(panad.runtime, "draft")).map((hit) => hit.messageId)).toEqual([seeded.messageId]);

		const revised = "the final wording about lanterns";
		await panad.runtime.db.write(async (tx) => {
			await tx.run(
				"INSERT INTO message_events (id, message_id, kind, body, created_by, created_at) VALUES (?, ?, 'message.revised', ?, ?, ?)",
				panad.runtime.newId(),
				seeded.messageId,
				revised,
				TEST_USER,
				panad.runtime.clock.now(),
			);
			await reindexRevision(tx, { id: seeded.messageId, threadId: seeded.threadId, body: revised });
		});
		expect(await searchThreads(panad.runtime, "draft")).toEqual([]);
		expect((await searchThreads(panad.runtime, "wording")).map((hit) => hit.messageId)).toEqual([seeded.messageId]);

		await panad.runtime.db.write(async (tx) => {
			await tx.run(
				"INSERT INTO message_events (id, message_id, kind, body, created_by, created_at) VALUES (?, ?, 'message.redacted', NULL, ?, ?)",
				panad.runtime.newId(),
				seeded.messageId,
				TEST_USER,
				panad.runtime.clock.now(),
			);
			await removeRedacted(tx, seeded.messageId);
		});
		expect(await searchThreads(panad.runtime, "wording")).toEqual([]);
		// EDT-04 holds: the index changed, the message row did not.
		expect(await panad.runtime.db.get("SELECT id FROM messages WHERE id = ?", seeded.messageId)).toBeDefined();
	});

	it("SRC-03 session search matches user and assistant text of transcripts indexed when a run settles", async () => {
		t = await startTestPanad();
		const panad = t;
		const sessionId = panad.runtime.newId();
		const entries = [
			{ id: "entry-1", role: "user" as const, text: "Where does the telescope live?" },
			{ id: "entry-2", role: "assistant" as const, text: "The telescope lives in the lantern room." },
			{ id: "entry-3", role: "assistant" as const, text: "   " },
		];
		await panad.runtime.db.write((tx) => indexSessionRun(tx, { sessionId, entries }));

		const hits = await searchSessions(panad.runtime, "telescope");
		expect(hits.map((hit) => hit.sessionId)).toEqual([sessionId, sessionId]);
		expect(hits[0]!.sessionUrl).toBe(`pana://${TEST_DOMAIN}/sessions/${sessionId}`);
		expect(hits.map((hit) => hit.snippet).join(" ")).toContain("[telescope]");
		expect((await searchSessions(panad.runtime, "lantern")).map((hit) => hit.sessionId)).toEqual([sessionId]);

		// Re-indexing the same run after a restart replaces its rows instead of duplicating them.
		await panad.runtime.db.write((tx) => indexSessionRun(tx, { sessionId, entries }));
		expect(await searchSessions(panad.runtime, "lantern")).toHaveLength(1);
		expect(await searchSessions(panad.runtime, "telescope")).toHaveLength(2);
	});
});


it("SRC-05 browse and search include archived threads by default, omit personal state, and paginate", async () => {
	t = await startTestPanad();
	const older = await seed(t, "Lantern older");
	await t.clock.advance(1);
	const newer = await seed(t, "Lantern newer");
	await t.client.post(`/threads/${newer.threadId}/archive`, {});
	const get = async (url: string) => (await t!.client.get<{ threads: Array<{ threadId: string }>; nextCursor: string | null }>(url)).body;
	expect((await get("/threads")).threads.map(r => r.threadId)).toEqual([newer.threadId, older.threadId]);
	const page = await get("/threads?limit=1");
	expect(page.threads).toMatchObject([{ threadId: newer.threadId }]);
	expect((await get(`/threads?limit=1&cursor=${encodeURIComponent(page.nextCursor!)}`)).threads).toMatchObject([{ threadId: older.threadId }]);
	for (const query of ["Lantern", "older", "newer"]) {
		const all = await get(`/threads?query=${query}`);
		expect(all.threads.length).toBeGreaterThan(0);
		for (const row of all.threads) {
			expect(row).not.toHaveProperty("archived");
			expect(row).not.toHaveProperty("unreadCount");
			expect(row).toHaveProperty("participants");
		}
	}
	for (const filter of ["archived=1", "includeArchived=1", "unread=1", "archived=0"]) {
		expect((await t.client.get(`/threads?${filter}`)).status).toBe(400);
	}
	const before = await get("/threads");
	await t.client.get(`/threads/${newer.threadId}`);
	expect(await get("/threads")).toEqual(before);
	expect((await t.client.get<{ canArchive: boolean }>(`/threads/${newer.threadId}`)).body.canArchive).toBe(true);
});

it("SRC-04 participant membership scopes domain-wide listing and both subject/message search with pagination", async () => {
	t = await startTestPanad();
	const first = await seed(t, "Lantern first");
	const excluded = await seed(t, "Lantern excluded");
	const last = await seed(t, "Lantern last");
	const member = t.runtime.newId();
	const outsider = t.runtime.newId();
	await t.runtime.db.write(async tx => {
		for (const id of [member, outsider]) {
			await tx.run("INSERT INTO participants (id, kind, url, created_at) VALUES (?, 'session', ?, ?)", id, t!.runtime.url({ kind: "session", id }), t!.clock.now());
			await tx.run("INSERT INTO sessions (id, state, depth, created_at, updated_at) VALUES (?, 'idle', 0, ?, ?)", id, t!.clock.now(), t!.clock.now());
		}
		for (const thread of [first, last]) await tx.run("INSERT INTO thread_participants (thread_id, participant_id, joined_at) VALUES (?, ?, ?)", thread.threadId, member, t!.clock.now());
	});
	const url = t.runtime.url({ kind: "session", id: member });
	for (const caller of [undefined, outsider]) {
		for (const ref of [member, url]) {
			const options = caller ? { caller } : undefined;
			const list = await t.client.get<{ threads: Array<{ threadId: string; participants: Array<{ id: string }> }>; nextCursor: string }>(`/threads?participant=${encodeURIComponent(ref)}&limit=1`, options);
			expect(list.status).toBe(200);
			expect(list.body.threads.map(r => r.threadId)).toEqual([last.threadId]);
			expect(list.body.threads[0]!.participants.map(p => p.id)).toEqual(expect.arrayContaining([member, TEST_USER]));
			const next = await t.client.get<{ threads: Array<{ threadId: string }>; nextCursor: null }>(`/threads?participant=${member}&limit=1&cursor=${encodeURIComponent(list.body.nextCursor)}`, options);
			expect(next.body.threads.map(r => r.threadId)).toEqual([first.threadId]);
			expect(next.body.nextCursor).toBeNull();
			const hits: Array<{ threadId: string; matched: string }> = [];
			let cursor: string | null = null;
			do {
				const page: { status: number; body: { threads: typeof hits; nextCursor: string | null } } = await t.client.get<{ threads: typeof hits; nextCursor: string | null }>(`/threads?query=Lantern&participant=${encodeURIComponent(ref)}&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, options);
				expect(page.status).toBe(200);
				hits.push(...page.body.threads);
				cursor = page.body.nextCursor;
			} while (cursor);
			expect(hits).toHaveLength(4);
			expect(new Set(hits.map(r => r.threadId))).toEqual(new Set([first.threadId, last.threadId]));
			expect(hits.map(r => r.matched)).toEqual(["subject", "subject", "message", "message"]);
		}
		const all = await t.client.get<{ threads: Array<{ threadId: string }> }>("/threads", caller ? { caller } : undefined);
		expect(all.body.threads.map(r => r.threadId)).toContain(excluded.threadId);
	}
	for (const ref of [TEST_USER, t.runtime.url({ kind: "user", id: TEST_USER })]) {
		expect((await t.client.get<{ threads: unknown[] }>(`/threads?participant=${encodeURIComponent(ref)}`)).body.threads).toHaveLength(3);
	}
	for (const ref of ["", `pana://${TEST_DOMAIN}/users/%`, `pana://${TEST_DOMAIN}/users/%C0%AF`, `pana://elsewhere/sessions/${member}`, t.runtime.url({ kind: "thread", id: first.threadId })]) {
		expect((await t.client.get(`/threads?participant=${encodeURIComponent(ref)}`)).status).toBe(400);
	}
	for (const ref of ["unknown-user", t.runtime.newId()]) expect((await t.client.get(`/threads?participant=${ref}`)).status).toBe(404);
	// Discovery does not join an outsider or create unknown participants.
	expect(await t.runtime.db.get("SELECT * FROM thread_participants WHERE participant_id = ?", outsider)).toBeUndefined();
	expect(await t.runtime.db.get("SELECT * FROM participants WHERE id = 'unknown-user'")).toBeUndefined();
});


it("SRC-04 SRC-05 discovery query plans retain ranked FTS top-N and indexed sparse membership paging", async () => {
	t = await startTestPanad();
	await seed(t, "Lantern query plans");
	const all = vi.spyOn(t.runtime.db, "all");
	await searchThreads(t.runtime, "Lantern", { participantId: TEST_USER, limit: 1 });
	await listThreads(t.runtime, { participantId: TEST_USER, limit: 1 });
	const calls = [...all.mock.calls];
	all.mockRestore();
	expect(calls).toHaveLength(3);
	for (const [sql, ...params] of calls) {
		const plan = await t.runtime.db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...params);
		const details = plan.map(row => row.detail).join("\n");
		expect(details).not.toContain("USE TEMP B-TREE FOR ORDER BY");
		if (sql.includes(" MATCH ")) {
			// FTS5 bit 32 means it consumes ORDER BY rank rather than sorting every match.
			expect(details).toMatch(/VIRTUAL TABLE INDEX 32:/);
		} else {
			expect(details).toContain("thread_participants_participant_thread");
			expect(details).not.toMatch(/SCAN t\b/);
		}
	}
});
