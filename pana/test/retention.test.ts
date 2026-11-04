// DB-05: delivery retention. The sweep drops a delivery only when its reader has read it, has
// archived its thread, read it more than `retention.readDeliveryDays` ago (default 30; 0 disables),
// and it never carried a wake. Each test below is one clause of that sentence, and the unread
// counter is checked against its own COUNT after every sweep, because REF-06's cache is now
// load-bearing for the sweep's safety rather than only for the inbox's speed.

import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig, DEFAULTS } from "../src/config/index.ts";
import { sessionRuntime } from "../src/sessions/index.ts";
import { RETENTION_BATCH_SIZE, RETENTION_MAX_BATCHES, sweepRetention } from "../src/threads/index.ts";
import { createFakeClock, startTestPanad, TEST_USER, type Script, type TestPanad } from "./harness/index.ts";

const DAY = 24 * 60 * 60 * 1000;

let t: TestPanad | undefined;
afterEach(async () => {
	await t?.close();
	t = undefined;
});

/** Enough turns for every run these tests start, so a session always answers. */
const SCRIPT: Script = Array.from({ length: 80 }, () => ({ text: "ack" }));

async function start(config: Record<string, unknown> = {}): Promise<TestPanad> {
	t = await startTestPanad({ config: { defaultModel: "faux/faux-1", timezone: "UTC", ...config }, script: SCRIPT });
	return t;
}

/** Wait for every run and every queued session job to settle. */
async function settle(): Promise<void> {
	await t!.runtime.harness.waitForIdle(BG);
	await sessionRuntime(t!.runtime).idle();
	await t!.clock.settle();
}

async function createSession(): Promise<string> {
	const res = await t!.client.post<{ session: { id: string } }>("/sessions", { prompt: "go" });
	expect(res.status).toBe(201);
	await settle();
	return res.body.session.id;
}

/** A thread from the user to `to`, with the session's answer posted, and its message ids. */
async function createThread(to: string[]): Promise<{ threadId: string; messages: string[] }> {
	const made = await t!.client.post<{ thread: { id: string } }>("/threads", { to, body: "hello" });
	expect(made.status).toBe(201);
	await settle();
	const threadId = made.body.thread.id;
	const messages = (await t!.runtime.db.all<{ id: string }>("SELECT id FROM messages WHERE thread_id = ? ORDER BY seq", threadId)).map((row) => row.id);
	return { threadId, messages };
}

const readAsUser = (threadId: string) => t!.client.get(`/threads/${threadId}`);

/** The inbox rows for these threads only: a session's own create thread is the user's mail too. */
async function inboxRows(path: string, only: readonly string[]): Promise<Array<[string, string]>> {
	const res = await t!.client.get<{ deliveries: Array<{ threadId: string; readAt: number | null }> }>(path);
	return res.body.deliveries
		.filter((row) => only.includes(row.threadId))
		.map((row) => [row.threadId, row.readAt === null ? "unread" : "read"]);
}
const archiveAs = (threadId: string, caller?: string) => t!.client.post(`/threads/${threadId}/archive`, {}, caller ? { caller } : {});
const unarchiveAsUser = (threadId: string) => t!.client.post(`/threads/${threadId}/unarchive`);

function deliveryOf(messageId: string, recipient: string) {
	return t!.runtime.db.get<{ read_at: number | null; wake_submission_id: number | null }>(
		"SELECT read_at, wake_submission_id FROM deliveries WHERE message_id = ? AND recipient_id = ?",
		messageId,
		recipient,
	);
}

const deliveryCount = async (): Promise<number> => (await t!.runtime.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM deliveries"))!.n;

/** The COUNT the counter stands in for, split by the two buckets the inbox reads (REF-06). */
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

/** Every participant's stored counter still equals its COUNT, in both buckets. */
async function expectCounterExact(): Promise<void> {
	const rows = await t!.runtime.db.all<{ participant_id: string; unarchived: number; archived: number }>(
		"SELECT participant_id, unarchived, archived FROM unread_counts",
	);
	for (const row of rows) expect({ participant: row.participant_id, ...(await oracle(row.participant_id)) }).toEqual({
		participant: row.participant_id,
		unarchived: row.unarchived,
		archived: row.archived,
	});
	// And no unread delivery is unaccounted for: the counter is every one of them.
	const counted = (await t!.runtime.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM deliveries WHERE read_at IS NULL"))!.n;
	const stored = (await t!.runtime.db.get<{ n: number }>("SELECT COALESCE(SUM(unarchived + archived), 0) AS n FROM unread_counts"))!.n;
	expect(stored).toBe(counted);
}

/** Wind one delivery's read time back, for the predicate cases that are about the clock and not the flow. */
async function backdateReads(messageIds: readonly string[], byMs: number): Promise<void> {
	for (const id of messageIds) {
		await t!.runtime.db.write((tx) => tx.run("UPDATE deliveries SET read_at = read_at - ? WHERE message_id = ? AND read_at IS NOT NULL", byMs, id));
	}
}

describe("DB-05 the window in config", () => {
	it("DB-05 retention.readDeliveryDays defaults to 30, and 0 turns the sweep off", async () => {
		const config = parseConfig({ domain: "d.example", user: "u" });
		expect(config.retention.readDeliveryDays).toBe(30);
		expect(DEFAULTS.retention.readDeliveryDays).toBe(30);
		expect(parseConfig({ domain: "d.example", user: "u", retention: { readDeliveryDays: 0 } }).retention.readDeliveryDays).toBe(0);
		expect(parseConfig({ domain: "d.example", user: "u", retention: { readDeliveryDays: 7.5 } }).retention.readDeliveryDays).toBe(7.5);
		expect(() => parseConfig({ domain: "d.example", user: "u", retention: { readDeliveryDays: -1 } })).toThrow(/retention\.readDeliveryDays/);
		expect(() => parseConfig({ domain: "d.example", user: "u", retention: "30" })).toThrow(/retention must be an object/);
	});
});

describe("DB-05 what a reader sees", () => {
	it("DB-05 an archived thread keeps 30 days of inbox history, and the sweep then drops its read deliveries", async () => {
		// The standing sweep is off here so the test drives the window itself with `days`.
		await start({ retention: { readDeliveryDays: 0 } });
		const session = await createSession();
		const { threadId, messages } = await createThread([session]);
		expect((await readAsUser(threadId)).status).toBe(200);
		expect((await archiveAs(threadId)).status).toBe(200);

		// The archived inbox is where a reader still sees read history, so it is where the cost lands.
		expect(await inboxRows("/inbox?archived=1", [threadId])).toEqual([[threadId, "read"]]);

		await t!.clock.advance(29 * DAY);
		expect((await sweepRetention(t!.runtime, { days: 30 })).deleted).toBe(0);
		await expectCounterExact();
		expect(await inboxRows("/inbox?archived=1", [threadId])).toEqual([[threadId, "read"]]);

		await t!.clock.advance(2 * DAY);
		const swept = await sweepRetention(t!.runtime, { days: 30 });
		expect(swept).toMatchObject({ days: 30, deleted: 1, batches: 1, more: false });
		expect(await deliveryOf(messages[1]!, TEST_USER)).toBeUndefined();

		// What is gone is the inbox item. The thread, its messages, and the archive stay.
		expect(await inboxRows("/inbox?archived=1", [threadId])).toEqual([]);
		const thread = await t!.client.get<{ messages: Array<{ readAt?: number | null }>; archived: boolean }>(`/threads/${threadId}`);
		expect(thread.status).toBe(200);
		expect(thread.body.archived).toBe(true);
		expect(thread.body.messages).toHaveLength(2);
		await expectCounterExact();
	});

	it("DB-05 the live inbox is untouched: only a thread the recipient archived may lose history", async () => {
		await start({ retention: { readDeliveryDays: 0 } });
		const session = await createSession();
		const kept = await createThread([session]);
		const filed = await createThread([session]);
		await readAsUser(kept.threadId);
		await readAsUser(filed.threadId);
		await archiveAs(filed.threadId);
		await t!.clock.advance(31 * DAY);

		expect((await sweepRetention(t!.runtime, { days: 30 })).deleted).toBe(1);
		expect(await inboxRows("/inbox", [kept.threadId, filed.threadId])).toEqual([[kept.threadId, "read"]]);
		expect(await inboxRows("/inbox?archived=1", [kept.threadId, filed.threadId])).toEqual([]);
	});
});

describe("DB-05 the predicate", () => {
	it("DB-05 read, archived by that recipient, older than the window, and never woken — five rows, one goes", async () => {
		await start({ retention: { readDeliveryDays: 0 } });
		const session = await createSession();
		const other = await createSession();

		// Goes: read, archived by the user, old, no wake ever.
		const goes = await createThread([session]);
		await readAsUser(goes.threadId);
		await archiveAs(goes.threadId);
		// Stays: archived, old, but unread (the session's answer arrived after the user filed it).
		const unread = await createThread([other]);
		await archiveAs(unread.threadId);
		// Stays: read and old, but the thread is still in the live inbox.
		const live = await createThread([session]);
		await readAsUser(live.threadId);
		// Stays: read, archived by the session itself, and its delivery carried a wake.
		const woken = await createThread([other]);
		await archiveAs(woken.threadId, other);
		// Stays: read and archived, but read inside the window (the clock moves before the read).
		await t!.clock.advance(21 * DAY);
		const young = await createThread([session]);
		await readAsUser(young.threadId);
		await archiveAs(young.threadId);
		await t!.clock.advance(10 * DAY);

		expect(await deliveryOf(goes.messages[1]!, TEST_USER)).toMatchObject({ wake_submission_id: null });
		const wokenRow = (await deliveryOf(woken.messages[0]!, other))!;
		expect(wokenRow.wake_submission_id).not.toBeNull();
		expect(wokenRow.read_at).not.toBeNull();
		const before = await deliveryCount();

		const result = await sweepRetention(t!.runtime, { days: 30 });
		expect(result.deleted).toBe(1);
		expect(await deliveryCount()).toBe(before - 1);

		expect(await deliveryOf(goes.messages[1]!, TEST_USER)).toBeUndefined();
		expect(await deliveryOf(unread.messages[1]!, TEST_USER)).toMatchObject({ read_at: null });
		expect((await deliveryOf(live.messages[1]!, TEST_USER))!.read_at).not.toBeNull();
		expect((await deliveryOf(woken.messages[0]!, other))!.wake_submission_id).not.toBeNull();
		expect((await deliveryOf(young.messages[1]!, TEST_USER))!.read_at).not.toBeNull();
		await expectCounterExact();
	});

	it("DB-05 a session's own read mail survives: an inbox is a user's", async () => {
		await start({ retention: { readDeliveryDays: 0 } });
		const session = await createSession();
		const { threadId, messages } = await createThread([session]);
		// A session can archive its own view of a thread, and a retired objective's `settleUnread`
		// marks its queued mail read without ever waking it — so this row is read, archived by its
		// recipient, old, and carries no submission. It is exactly what the participants clause
		// exists to keep: `reply.ts`'s newer-delivery walk reads a session's rows.
		expect((await t!.client.post(`/sessions/${session}/stop`)).status).toBe(200);
		expect((await t!.client.post(`/threads/${threadId}/messages`, { body: "queued", after: messages[1] })).status).toBe(200);
		const queued = (await t!.runtime.db.get<{ id: string }>("SELECT id FROM messages WHERE thread_id = ? ORDER BY seq DESC LIMIT 1", threadId))!.id;
		expect(await deliveryOf(queued, session)).toMatchObject({ read_at: null, wake_submission_id: null });
		await sessionRuntime(t!.runtime).archive(session, "objective", { settleUnread: true });
		expect((await t!.client.post(`/threads/${threadId}/archive`, {}, { caller: session })).status).toBe(200);
		await backdateReads([queued], 31 * DAY);

		const row = await t!.runtime.db.get<{ read_at: number; wake_submission_id: number | null }>(
			"SELECT read_at, wake_submission_id FROM deliveries WHERE message_id = ? AND recipient_id = ?",
			queued,
			session,
		);
		expect(row!.read_at).toBeLessThan(t!.clock.now() - 30 * DAY);
		expect(row!.wake_submission_id).toBeNull();
		expect(await t!.runtime.db.get("SELECT 1 AS archived FROM thread_archives WHERE thread_id = ? AND participant_id = ?", threadId, session)).toBeDefined();
		expect(await deliveryOf(messages[0]!, session)).toMatchObject({ wake_submission_id: expect.any(Number) });

		expect(await sweepRetention(t!.runtime, { days: 30 })).toMatchObject({ deleted: 0 });
		expect((await deliveryOf(queued, session))!.read_at).toBe(row!.read_at);
		// The user's side of the thread is untouched too: the user never read it or archived it.
		expect((await deliveryOf(messages[1]!, TEST_USER))!.read_at).toBeNull();
		await expectCounterExact();
	});

	it("DB-05 the window's edge: exactly `days` old goes, a millisecond younger stays", async () => {
		await start({ retention: { readDeliveryDays: 0 } });
		const session = await createSession();
		const onTheEdge = await createThread([session]);
		await readAsUser(onTheEdge.threadId);
		await archiveAs(onTheEdge.threadId);
		await t!.clock.advance(1);
		const younger = await createThread([session]);
		await readAsUser(younger.threadId);
		await archiveAs(younger.threadId);
		await t!.clock.advance(30 * DAY - 1);

		expect((await sweepRetention(t!.runtime, { days: 30 })).deleted).toBe(1);
		expect(await deliveryOf(onTheEdge.messages[1]!, TEST_USER)).toBeUndefined();
		expect((await deliveryOf(younger.messages[1]!, TEST_USER))!.read_at).toBe(t!.clock.now() - 30 * DAY + 1);
	});

	it("DB-05 0 days of retention deletes nothing at all", async () => {
		await start({ retention: { readDeliveryDays: 0 } });
		const session = await createSession();
		const { threadId, messages } = await createThread([session]);
		await readAsUser(threadId);
		await archiveAs(threadId);
		// Ancient: read 400 days ago. Off is off, so the sweep reads the config and does nothing.
		await backdateReads([messages[1]!], 400 * DAY);
		expect(await deliveryOf(messages[1]!, TEST_USER)).toBeDefined();
		expect(await sweepRetention(t!.runtime)).toMatchObject({ days: 0, deleted: 0, batches: 0 });
		expect(await deliveryOf(messages[1]!, TEST_USER)).toBeDefined();
	});
});

describe("DB-05 batching and idempotence", () => {
	it("DB-05 several batches, a cap that stops a run mid-way, and a second sweep that finds nothing", async () => {
		await start({ retention: { readDeliveryDays: 0 } });
		const session = await createSession();
		const threads = [];
		for (let index = 0; index < 5; index++) {
			const made = await createThread([session]);
			await readAsUser(made.threadId);
			await archiveAs(made.threadId);
			threads.push(made);
		}
		await t!.clock.advance(31 * DAY);
		const before = await deliveryCount();

		// Two batches of two, then the cap: four of the five go and the run says it has more to do.
		const capped = await sweepRetention(t!.runtime, { days: 30, batchSize: 2, maxBatches: 2 });
		expect(capped).toMatchObject({ deleted: 4, batches: 2, more: true });
		expect(await deliveryCount()).toBe(before - 4);
		await expectCounterExact();

		// Stopping there is a consistent database: the fifth item is still a whole inbox item.
		expect(await inboxRows("/inbox?archived=1", threads.map((made) => made.threadId))).toHaveLength(1);

		// The next run continues from where the cap stopped, and then there is nothing left.
		expect(await sweepRetention(t!.runtime, { days: 30, batchSize: 2, maxBatches: 2 })).toMatchObject({ deleted: 1, batches: 1, more: false });
		expect(await sweepRetention(t!.runtime, { days: 30, batchSize: 2, maxBatches: 2 })).toMatchObject({ deleted: 0, batches: 1, more: false });
		await expectCounterExact();
		expect(await inboxRows("/inbox?archived=1", threads.map((made) => made.threadId))).toEqual([]);
	});

	it("DB-05 the defaults are a bounded run: 200 rows a batch, 20 batches a sweep", async () => {
		expect(RETENTION_BATCH_SIZE).toBe(200);
		expect(RETENTION_MAX_BATCHES).toBe(20);
	});
});

describe("DB-05 where it runs", () => {
	it("DB-05 panad sweeps when it starts, before any run it recovers", async () => {
		await start({ retention: { readDeliveryDays: 0 } });
		const session = await createSession();
		const { threadId, messages } = await createThread([session]);
		await readAsUser(threadId);
		await archiveAs(threadId);
		await t!.clock.advance(31 * DAY);
		const at = t!.clock.now();
		const dir = t!.dir;
		await t!.stop();

		// Enable the sweep and start again, on a clock that is still 31 days past the read: the
		// startup sweep is the only thing in that boot that can delete this.
		const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
		config.retention = { readDeliveryDays: 30 };
		writeFileSync(join(dir, "config.json"), JSON.stringify(config, null, "\t"));
		t = await startTestPanad({ stateDir: dir, clock: createFakeClock(at) });
		for (let index = 0; index < 200 && (await deliveryOf(messages[1]!, TEST_USER)) !== undefined; index++) await t!.clock.settle();
		expect(await deliveryOf(messages[1]!, TEST_USER)).toBeUndefined();
		await expectCounterExact();
	});

	it("DB-05 panad sweeps again every 24 hours on its clock", async () => {
		await start({ retention: { readDeliveryDays: 1 } });
		const session = await createSession();
		const { threadId, messages } = await createThread([session]);
		await readAsUser(threadId);
		await archiveAs(threadId);
		await t!.clock.advance(DAY - 1);
		expect(await deliveryOf(messages[1]!, TEST_USER)).toBeDefined();
		await t!.clock.advance(1);
		for (let index = 0; index < 200 && (await deliveryOf(messages[1]!, TEST_USER)) !== undefined; index++) await t!.clock.settle();
		expect(await deliveryOf(messages[1]!, TEST_USER)).toBeUndefined();
	});

	it("DB-05 with the sweep disabled no timer runs and nothing is ever deleted", async () => {
		await start({ retention: { readDeliveryDays: 0 } });
		const session = await createSession();
		const { threadId, messages } = await createThread([session]);
		await readAsUser(threadId);
		await archiveAs(threadId);
		await t!.clock.advance(3 * DAY);
		await t!.clock.settle();
		expect(await deliveryOf(messages[1]!, TEST_USER)).toBeDefined();
		expect(await sweepRetention(t!.runtime, { days: 0 })).toMatchObject({ days: 0, deleted: 0 });
	});

	it("DB-05 an unarchived thread comes back with its history intact, even after a sweep", async () => {
		await start({ retention: { readDeliveryDays: 0 } });
		const session = await createSession();
		const { threadId } = await createThread([session]);
		await readAsUser(threadId);
		await archiveAs(threadId);
		await t!.clock.advance(31 * DAY);
		// The item is still there to unarchive: the sweep has not run yet.
		expect((await unarchiveAsUser(threadId)).status).toBe(200);
		expect((await sweepRetention(t!.runtime, { days: 30 })).deleted).toBe(0);
		expect(await inboxRows("/inbox", [threadId])).toEqual([[threadId, "read"]]);
	});
});
