// REF-06's invariant: the unread counter is a cache of a COUNT, and it must equal that COUNT after
// every write, in both buckets the inbox reads. A randomized sequence of deliveries, reads,
// archives, settles and recounts does the writes; the original SQL is the oracle after each one,
// and again after the database is closed and reopened. The routes and runtime calls are the ones a
// reader and the sweep drive, not hand-written SQL, so a write path that forgets the counter fails
// here.

import { afterEach, expect, it } from "vitest";
import { sessionRuntime } from "../src/sessions/index.ts";
import { postNotice } from "../src/threads/store.ts";
import { recountUnread, unreadCounts } from "../src/threads/unread.ts";
import { startTestPanad, TEST_USER, type TestPanad } from "./harness/index.ts";

let t: TestPanad | undefined;
afterEach(async () => {
	await t?.close();
	t = undefined;
});

/** The COUNT the inbox ran before the counter existed, split by the archived bucket. */
async function oracle(participantId: string): Promise<{ unarchived: number; archived: number }> {
	return (await t!.runtime.db.get<{ unarchived: number; archived: number }>(
		`SELECT
		   (SELECT COUNT(*) FROM deliveries d
		     WHERE d.recipient_id = ? AND d.read_at IS NULL
		       AND NOT EXISTS (SELECT 1 FROM thread_archives a WHERE a.thread_id = d.thread_id AND a.participant_id = d.recipient_id)) AS unarchived,
		   (SELECT COUNT(*) FROM deliveries d
		     WHERE d.recipient_id = ? AND d.read_at IS NULL
		       AND EXISTS (SELECT 1 FROM thread_archives a WHERE a.thread_id = d.thread_id AND a.participant_id = d.recipient_id)) AS archived`,
		participantId,
		participantId,
	))!;
}

/** Deterministic PRNG, so a failure can be replayed by fixing the seed printed in the message. */
function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state * 1_664_525 + 1_013_904_223) >>> 0;
		return state / 2 ** 32;
	};
}

it("REF-06 the unread counter equals COUNT(*) after every write, in both buckets, and after a reopen", async () => {
	t = await startTestPanad({ config: { defaultModel: "faux/faux-1", timezone: "UTC" }, script: [{ text: "Noted." }] });
	const panad = t;
	const now = panad.clock.now();
	const next = random(0x5eed);

	// Sessions that never run (no conversation) plus the user: every delivery either queues for a
	// session or lands in the user's inbox, and only writes move the counter. One more session
	// exists only to be retired: archiving a session makes its thread read-only, so it keeps a
	// thread of its own.
	const sessions: string[] = [];
	for (let index = 0; index < 4; index++) {
		const id = panad.runtime.newId();
		await panad.runtime.db.write(async (tx) => {
			await tx.run("INSERT INTO participants (id, kind, url, created_at) VALUES (?, 'session', ?, ?)", id, panad.runtime.url({ kind: "session", id }), now);
			await tx.run("INSERT INTO sessions (id, conversation_id, state, depth, created_at, updated_at) VALUES (?, NULL, 'idle', 0, ?, ?)", id, now, now);
		});
		sessions.push(id);
	}
	const participants = [TEST_USER, ...sessions];
	// The user's own address is already a participant; make sure a row exists for it in the oracle.
	const threads: string[] = [];
	/** Who is in each thread, so a read or an archive is one a member is allowed to make. */
	const members = new Map<string, string[]>();
	const createThread = async (to: string[], body: string): Promise<string> => {
		const made = await panad.client.post<{ thread: { id: string } }>("/threads", { to, body });
		expect(made.status).toBe(201);
		members.set(made.body.thread.id, [TEST_USER, ...to]);
		return made.body.thread.id;
	};
	threads.push(await createThread(sessions.slice(0, 3), "the meter and the boiler"));
	threads.push(await createThread([sessions[0]!, sessions[1]!], "the second thread"));
	threads.push(await createThread([sessions[2]!], "a session-only thread"));
	const retiring = sessions[3]!;
	threads.push(await createThread([retiring], "the thread that retires"));

	const observed = { steps: 0, delivers: 0, reads: 0, archives: 0, settles: 0, recounts: 0, nonEmpty: 0, archivedSeen: 0 };
	const check = async (label: string): Promise<void> => {
		let any = false;
		for (const participant of participants) {
			const want = await oracle(participant);
			const got = await unreadCounts(panad.runtime.db, participant);
			expect(got, `${label}: ${participant}`).toEqual(want);
			if (want.unarchived + want.archived > 0) any = true;
			if (want.archived > 0) observed.archivedSeen += 1;
		}
		if (any) observed.nonEmpty += 1;
	};

	const pick = <T,>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!;
	// A session retired with `settleUnread` is archived: it can still be read, but it cannot post,
	// so the writers below stay away from it.
	const settled = new Set<string>();

	for (let step = 0; step < 60; step++) {
		const roll = next();
		const threadId = pick(threads);
		const participant = pick(participants);
		const live = members.get(threadId)!.filter((id) => id === TEST_USER || !settled.has(id));
		const member = live.length > 0 ? pick(live) : TEST_USER;
		// The user's caller is named by the test harness, not by a session id.
		const as = member === TEST_USER ? undefined : { caller: member };
		observed.steps += 1;
		if (roll < 0.28) {
			// A delivery: the user or a session writes to a thread they are in.
			const from = next() < 0.5 ? TEST_USER : member;
			const head = await panad.runtime.db.get<{ id: string }>("SELECT id FROM messages WHERE thread_id = ? ORDER BY seq DESC LIMIT 1", threadId);
			const res = await panad.client.post(
				`/threads/${threadId}/messages`,
				{ after: head!.id, body: `step ${step}` },
				from === TEST_USER ? undefined : { caller: from },
			);
			expect([200, 201], `deliver: ${JSON.stringify(res.body)}`).toContain(res.status);
			observed.delivers += 1;
		} else if (roll < 0.46) {
			const res = await panad.client.get(`/threads/${threadId}`, as);
			expect(res.status).toBe(200);
			observed.reads += 1;
		} else if (roll < 0.56) {
			// Read one message, if this participant has a delivery in this thread.
			const row = await panad.runtime.db.get<{ message_id: string }>(
				"SELECT message_id FROM deliveries WHERE recipient_id = ? AND thread_id = ? ORDER BY created_at DESC LIMIT 1",
				member,
				threadId,
			);
			if (row) {
				const res = await panad.client.post(`/messages/${row.message_id}/read`, {}, as);
				expect(res.status).toBe(200);
				observed.reads += 1;
			}
		} else if (roll < 0.7) {
			const res = await panad.client.post(`/threads/${threadId}/archive`, {}, as);
			expect(res.status, `archive: ${JSON.stringify(res.body)}`).toBe(200);
			observed.archives += 1;
		} else if (roll < 0.8) {
			const res = await panad.client.post(`/threads/${threadId}/unarchive`, {}, as);
			expect(res.status).toBe(200);
			observed.archives += 1;
		} else if (roll < 0.88) {
			// A notice: the domain writes to named recipients, joining them to the thread it uses.
			await postNotice(panad.runtime, { thread: threadId, body: `notice ${step}`, to: [member] });
			observed.delivers += 1;
		} else if (roll < 0.95) {
			// The objective's retirement path: a session archives with its unread mail settled.
			await sessionRuntime(panad.runtime).archive(retiring, null, { settleUnread: true });
			if (!settled.has(retiring)) observed.settles += 1;
			settled.add(retiring);
		} else {
			// The stop path's helper, on the same rows it would recompute.
			await panad.runtime.db.write((tx) => recountUnread(tx, participant));
			observed.recounts += 1;
		}
		await check(`step ${step} (roll ${roll.toFixed(3)})`);
	}

	// The sequence has to have exercised both buckets and a non-trivial total, or it proves little.
	expect(observed.delivers).toBeGreaterThan(10);
	expect(observed.reads).toBeGreaterThan(5);
	expect(observed.archives).toBeGreaterThan(3);
	expect(observed.nonEmpty).toBeGreaterThan(10);
	// Both buckets have to carry a number at some point, or the archived half is untested.
	expect(observed.archivedSeen).toBeGreaterThan(0);
	expect(observed.settles).toBeGreaterThan(0);

	// The counter is state, not a cache in memory: it survives a close and reopen.
	await panad.stop();
	t = await startTestPanad({ stateDir: panad.dir });
	for (const participant of participants) {
		expect(await unreadCounts(t.runtime.db, participant), `after reopen: ${participant}`).toEqual(await oracle(participant));
	}
});

it("REF-06 migration 14 backfills the counter from the same COUNT, and re-running it rebuilds it", async () => {
	t = await startTestPanad({ config: { defaultModel: "faux/faux-1", timezone: "UTC" }, script: [{ text: "Noted." }] });
	const panad = t;
	const now = panad.clock.now();
	const sessions: string[] = [];
	for (let index = 0; index < 2; index++) {
		const id = panad.runtime.newId();
		await panad.runtime.db.write(async (tx) => {
			await tx.run("INSERT INTO participants (id, kind, url, created_at) VALUES (?, 'session', ?, ?)", id, panad.runtime.url({ kind: "session", id }), now);
			await tx.run("INSERT INTO sessions (id, conversation_id, state, depth, created_at, updated_at) VALUES (?, NULL, 'idle', 0, ?, ?)", id, now, now);
		});
		sessions.push(id);
	}
	const first = await panad.client.post<{ thread: { id: string } }>("/threads", { to: sessions, body: "before the counter" });
	expect(first.status).toBe(201);
	const second = await panad.client.post<{ thread: { id: string } }>("/threads", { to: [sessions[0]!], body: "and one more" });
	expect(second.status).toBe(201);
	// Read one thread as one session, so the two buckets and a zero are both in the backfill.
	await panad.client.get(`/threads/${first.body.thread.id}`, { caller: sessions[0]! });
	// A session archives its thread: that puts its unread row in the archived bucket.
	await panad.client.post(`/threads/${second.body.thread.id}/archive`, {}, { caller: sessions[0]! });
	const before = new Map<string, { unarchived: number; archived: number }>();
	for (const participant of [TEST_USER, ...sessions]) before.set(participant, await oracle(participant));
	expect([...before.values()].some((counts) => counts.archived > 0)).toBe(true);

	// Pretend the database came from before migration 14: no counter rows, version 13.
	await panad.runtime.db.write(async (tx) => {
		await tx.run("DELETE FROM unread_counts");
		await tx.run("PRAGMA user_version = 13");
	});
	await panad.stop();
	t = await startTestPanad({ stateDir: panad.dir });
	for (const participant of [TEST_USER, ...sessions]) {
		expect(await unreadCounts(t.runtime.db, participant), `backfilled: ${participant}`).toEqual(before.get(participant));
		expect(await unreadCounts(t.runtime.db, participant), `backfilled vs SQL: ${participant}`).toEqual(await oracle(participant));
	}

	// Re-running the migration (DB-03) rebuilds the same numbers rather than doubling them.
	await t.runtime.db.write(async (tx) => {
		await tx.run("PRAGMA user_version = 13");
	});
	const dir = t.dir;
	await t.stop();
	t = await startTestPanad({ stateDir: dir });
	for (const participant of [TEST_USER, ...sessions]) {
		expect(await unreadCounts(t.runtime.db, participant), `re-run: ${participant}`).toEqual(before.get(participant));
	}
});
