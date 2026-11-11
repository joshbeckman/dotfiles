import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureDelivery, type DeliveredEvent, type DeliveryHooks } from "../src/threads/index.ts";
import type { ScheduleView } from "../src/schedules/store.ts";
import { FAUX_MODEL, startTestPanad, type TestPanad } from "./harness/index.ts";

let t: TestPanad | undefined;
let dir: string | undefined;
afterEach(async () => {
	await t?.close();
	t = undefined;
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
});

/** A session row, wakeable only when it carries a conversation (DLV-01). */
async function seedSession(harness: TestPanad, state = "idle", conversation = false): Promise<string> {
	const id = harness.runtime.newId();
	const now = harness.clock.now();
	let conversationId: number | null = null;
	if (conversation) {
		const created = await harness.runtime.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: FAUX_MODEL } }, ctx);
		conversationId = created.id;
	}
	await harness.runtime.db.write(async (tx) => {
		await tx.run("INSERT INTO participants (id, kind, url, created_at) VALUES (?, 'session', ?, ?)", id, harness.runtime.url({ kind: "session", id }), now);
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

/** Replace the delivery hook so a test sees every delivery without submitting one. */
function capture(harness: TestPanad): DeliveredEvent[] {
	const events: DeliveredEvent[] = [];
	const hooks: DeliveryHooks = {
		onDelivered: async (tx, event) => {
			events.push(event);
			if (event.requestId !== null) await tx.run("UPDATE deliveries SET wake_submission_id = 1 WHERE id = ?", event.deliveryId);
		},
	};
	configureDelivery(harness.runtime, hooks);
	return events;
}

const base = { kind: "session", cron: "* * * * *", payload: { prompt: "only when ready" } };

async function create(extra: Record<string, unknown> = {}, caller?: string): Promise<ScheduleView> {
	const res = await t!.client.post<{ schedule: ScheduleView }>("/schedules", { ...base, ...extra }, caller === undefined ? {} : { caller });
	expect(res.status).toBe(201);
	return res.body.schedule;
}

async function show(id: string): Promise<ScheduleView> {
	return (await t!.client.get<{ schedule: ScheduleView }>(`/schedules/${id}`)).body.schedule;
}

/** Fire the schedule once and wait for this firing's result, not the previous one. */
async function fire(id: string): Promise<void> {
	const before = (await show(id)).lastCheck?.checkedAt ?? -1;
	const at = (await show(id)).nextAt!;
	await t!.clock.advanceTo(at);
	await vi.waitFor(async () => {
		const now = await show(id);
		expect(now.lastCheck).not.toBeNull();
		expect(now.lastCheck!.checkedAt).toBeGreaterThan(before);
		expect(now.nextAt).not.toBe(at);
	});
}

interface NoticeThread {
	id: string;
	subject: string;
	messages: Array<{ body: string; sender: string }>;
	participants: string[];
}

/** The one thread a schedule speaks in, failing the test when there is not exactly one. */
async function onlyThread(): Promise<NoticeThread> {
	const threads = await noticeThreads();
	expect(threads).toHaveLength(1);
	return threads[0]!;
}

async function noticeThreads(): Promise<NoticeThread[]> {
	const rows = await t!.runtime.db.all<{ id: string; subject: string | null }>(
		"SELECT id, subject FROM threads ORDER BY created_at, id",
	);
	return Promise.all(
		rows.map(async (row) => {
			const messages = await t!.runtime.db.all<{ body: string; sender_id: string }>("SELECT body, sender_id FROM messages WHERE thread_id = ? ORDER BY seq", row.id);
			const participants = await t!.runtime.db.all<{ participant_id: string }>("SELECT participant_id FROM thread_participants WHERE thread_id = ?", row.id);
			return {
				id: row.id,
				subject: row.subject ?? "",
				messages: messages.map((m) => ({ body: m.body, sender: m.sender_id })),
				participants: participants.map((p) => p.participant_id),
			};
		}),
	);
}

describe("schedule notices", () => {
	it("SCH-22 a repeated failure speaks once in one thread to its creator, and a new reason speaks again", async () => {
		t = await startTestPanad({ handlers: { "sessions.create": () => ({ status: 201 }) } });
		const mine = await seedSession(t);
		const schedule = await create({ check: "printf broken >&2; exit 7" }, mine);

		await fire(schedule.id);
		await fire(schedule.id);
		await fire(schedule.id);

		const thread = await onlyThread();
		expect(thread.subject).toBe(`Scheduled session ${schedule.url}`);
		expect(thread.participants).toContain(mine);
		expect(thread.messages).toHaveLength(1);
		expect(thread.messages[0]!.body).toContain(`Scheduled session ${schedule.url} check failed: check exited 7`);
		// The creator hears it; the user's inbox stays out of a schedule that is not theirs.
		const inbox = await t.client.get<{ deliveries: unknown[] }>("/inbox");
		expect(inbox.body.deliveries).toEqual([]);

		expect((await t.client.post(`/schedules/${schedule.id}`, { check: "printf worse >&2; exit 9" }, { caller: mine })).status).toBe(200);
		await fire(schedule.id);

		const after = await onlyThread();
		expect(after.id).toBe(thread.id);
		expect(after.messages).toHaveLength(2);
		expect(after.messages[1]!.body).toContain("check exited 9");
	});

	it("SCH-22 a passing check ends the streak, so the same failure is news again", async () => {
		t = await startTestPanad({ handlers: { "sessions.create": () => ({ status: 201 }) } });
		const mine = await seedSession(t);
		const schedule = await create({ check: "exit 7" }, mine);

		await fire(schedule.id);
		expect((await show(schedule.id)).lastCheck).toMatchObject({ status: "failed" });

		// Ready: the check passes, the dispatch happens, and the stored reason is cleared.
		await t.runtime.db.write(async (tx) => {
			await tx.run("UPDATE schedules SET check_command = 'true' WHERE id = ?", schedule.id);
		});
		await fire(schedule.id);
		expect((await show(schedule.id)).lastCheck).toMatchObject({ status: "passed" });
		expect(await t.runtime.db.get("SELECT reason FROM schedule_notices WHERE schedule_id = ?", schedule.id)).toEqual({ reason: null });

		// The same failure returns: same thread, a second message.
		await t.runtime.db.write(async (tx) => {
			await tx.run("UPDATE schedules SET check_command = 'exit 7' WHERE id = ?", schedule.id);
		});
		await fire(schedule.id);

		const thread = await onlyThread();
		expect(thread.messages).toHaveLength(2);
	});

	it("SCH-22 a session creator is woken by its schedule's notice; the user's notice wakes nothing", async () => {
		t = await startTestPanad({ handlers: { "sessions.create": () => ({ status: 201 }) } });
		const events = capture(t);
		const mine = await seedSession(t, "idle", true);
		const schedule = await create({ check: "exit 7" }, mine);

		await fire(schedule.id);
		const toCreator = events.filter((event) => event.recipientId === mine);
		expect(toCreator).toHaveLength(1);
		expect(toCreator[0]).toMatchObject({ recipientKind: "session", senderKind: "domain" });
		expect(toCreator[0]!.requestId).not.toBeNull();

		const theirs = await create({ check: "exit 7" });
		events.length = 0;
		await fire(theirs.id);
		expect(events.filter((event) => event.recipientKind === "session" && event.requestId !== null && event.recipientId !== mine)).toHaveLength(0);
		const userDelivery = events.find((event) => event.recipientKind === "user");
		expect(userDelivery?.requestId).toBeNull();
	});

	it("SCH-22 deleting a schedule takes its notice record with it", async () => {
		t = await startTestPanad({ handlers: { "sessions.create": () => ({ status: 201 }) } });
		const mine = await seedSession(t);
		const schedule = await create({ check: "exit 7" }, mine);
		await fire(schedule.id);
		expect(await t.runtime.db.get("SELECT schedule_id FROM schedule_notices WHERE schedule_id = ?", schedule.id)).toEqual({ schedule_id: schedule.id });

		expect((await t.client.delete(`/schedules/${schedule.id}`, { caller: mine })).status).toBe(204);
		expect(await t.runtime.db.get("SELECT schedule_id FROM schedule_notices WHERE schedule_id = ?", schedule.id)).toBeUndefined();
	});

	it("SCH-22 a notice thread is reused after a restart", async () => {
		t = await startTestPanad({ handlers: { "sessions.create": () => ({ status: 201 }) } });
		dir = mkdtempSync(join(tmpdir(), "pana-notices-"));
		const mine = await seedSession(t);
		const schedule = await create({ check: "exit 7" }, mine);
		await fire(schedule.id);
		const first = t;
		await first.stop();
		t = await startTestPanad({ stateDir: first.dir, clock: first.clock, handlers: { "sessions.create": () => ({ status: 201 }) } });
		await fire(schedule.id);
		const thread = await onlyThread();
		expect(thread.messages).toHaveLength(1);
	});
});
