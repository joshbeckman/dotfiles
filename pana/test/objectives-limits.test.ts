// OBJ-41: the user's limits. A write is the user's alone, one `objective_events` row per change,
// and the value written is the value every later read and every later admission sees — which is
// what makes raising a lifetime budget the way back from a `budget_total` pause (OBJ-21).

import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { afterEach, expect, it } from "vitest";
import { admitRun, type ObjectiveView } from "../src/objectives/index.ts";
import { recordCost } from "../src/sessions/budget.ts";
import { sessionRuntime } from "../src/sessions/index.ts";
import { runPanaCommand } from "../src/cli/commands.ts";
import { startTestPanad, TEST_USER, type Script, type TestPanad } from "./harness/index.ts";

let t: TestPanad | undefined;
afterEach(async () => {
	await t?.close();
	t = undefined;
});

async function start(script: Script = []): Promise<TestPanad> {
	t = await startTestPanad({
		config: { defaultModel: "faux/faux-1", timezone: "UTC" },
		script,
	});
	return t;
}

type Params = Record<string, string | string[] | boolean | undefined>;

async function command(name: string, params: Params, caller?: string) {
	return runPanaCommand(name, params, { endpoint: { socketPath: t!.panad.socketPath }, ...(caller ? { caller } : {}) });
}

async function draft(goal: string, body: Record<string, unknown> = {}): Promise<ObjectiveView> {
	const made = await t!.client.post<{ objective: ObjectiveView }>("/objectives", { goal, ...body });
	expect(made.status, JSON.stringify(made.body)).toBe(201);
	return made.body.objective;
}

async function view(id: string): Promise<ObjectiveView> {
	const res = await t!.client.get<{ objective: ObjectiveView }>(`/objectives/${id}`);
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return res.body.objective;
}

/** Settle every run and every queued session job. */
async function settle(): Promise<void> {
	await t!.runtime.harness.waitForIdle(ctx);
	await sessionRuntime(t!.runtime).idle();
}

/** A session row, without a conversation: enough for the authorization checks. */
async function seedSession(objectiveId: string | null): Promise<string> {
	const id = t!.runtime.newId();
	const now = t!.clock.now();
	await t!.runtime.db.write(async (tx) => {
		await tx.run("INSERT INTO participants (id, kind, url, created_at) VALUES (?, 'session', ?, ?)", id, t!.runtime.url({ kind: "session", id }), now);
		await tx.run(
			"INSERT INTO sessions (id, state, depth, objective_id, created_at, updated_at) VALUES (?, 'idle', 0, ?, ?, ?)",
			id,
			objectiveId,
			now,
			now,
		);
	});
	return id;
}

interface LimitEvent {
	kind: string;
	detail: string;
	actor_id: string | null;
}

async function limitEvents(objectiveId: string): Promise<LimitEvent[]> {
	return t!.runtime.db.all<LimitEvent>(
		"SELECT kind, detail, actor_id FROM objective_events WHERE objective_id = ? AND kind = 'limits.set' ORDER BY at, id",
		objectiveId,
	);
}

async function heldDelivery(messageId: string, sessionId: string) {
	return t!.runtime.db.get<{ read_at: number | null; wake_request_id: string | null }>(
		"SELECT read_at, wake_request_id FROM deliveries WHERE message_id = ? AND recipient_id = ?",
		messageId,
		sessionId,
	);
}

it("OBJ-41 only the user sets limits, every change is an objective_events row, and the command writes the same route", async () => {
	await start();
	const objective = await draft("Cut the energy bill", { maxTotalUsd: 20 });

	// A session may not set its own limits: a lead that could raise its budget would not have one.
	const member = await seedSession(objective.id);
	const refused = await t!.client.post(`/objectives/${objective.id}/limits`, { maxTotalUsd: 40 }, { caller: member });
	expect(refused.status).toBe(403);
	expect((await command("objective limits set", { id: objective.id, "max-total-usd": "40" }, member)).exitCode).toBe(1);
	expect(await limitEvents(objective.id)).toEqual([]);

	// The user's write lands, and each changed field records the field and both values.
	const written = await t!.client.post<{ objective: ObjectiveView; changes: unknown[] }>(`/objectives/${objective.id}/limits`, {
		maxTotalUsd: 40,
		maxDailyUsd: 5,
	});
	expect(written.status, JSON.stringify(written.body)).toBe(200);
	expect(written.body.objective.limits).toMatchObject({ maxTotalUsd: 40, maxDailyUsd: 5 });
	// OBJ-39's meters read `effectiveLimits`, so a value the user set says whose it is.
	expect(written.body.objective.effectiveLimits.maxDailyUsd).toEqual({ value: 5, source: "objective" });
	// OBJ-18/OBJ-24: a limit the objective leaves unset resolves to the domain's, and says so.
	expect(written.body.objective.effectiveLimits.maxDailyUserMessages).toEqual({
		value: t!.runtime.config.objectives.maxDailyUserMessages,
		source: "config",
	});
	expect(written.body.objective.effectiveLimits.maxActiveMembers).toEqual({ value: null, source: "none" });
	// One row per change, in the order the six limits are declared.
	const events = await limitEvents(objective.id);
	expect(events.map((event) => JSON.parse(event.detail) as unknown)).toEqual([
		{ field: "maxDailyUsd", from: null, to: 5 },
		{ field: "maxTotalUsd", from: 20, to: 40 },
	]);
	expect(events.every((event) => event.actor_id === TEST_USER)).toBe(true);

	// null clears a limit back to the domain's default, and the read says which that is.
	const cleared = await t!.client.post<{ objective: ObjectiveView }>(`/objectives/${objective.id}/limits`, { maxTotalUsd: null });
	expect(cleared.status).toBe(200);
	expect(cleared.body.objective.limits.maxTotalUsd).toBeNull();
	expect(cleared.body.objective.effectiveLimits.maxTotalUsd).toEqual({ value: null, source: "none" });
	expect((JSON.parse((await limitEvents(objective.id)).at(-1)!.detail) as { to: unknown }).to).toBeNull();

	// A write with nothing to write, an unknown value, and a no-op are usage errors that write nothing.
	expect((await t!.client.post(`/objectives/${objective.id}/limits`, {})).status).toBe(400);
	expect((await t!.client.post(`/objectives/${objective.id}/limits`, { maxDailyUsd: 0 })).status).toBe(400);
	expect((await t!.client.post(`/objectives/${objective.id}/limits`, { maxDailyUsd: 5 })).status).toBe(400);
	expect((await view(objective.id)).limits.maxDailyUsd).toBe(5);
	expect(await limitEvents(objective.id)).toHaveLength(3);

	// CLI parity: the command is the API, and `default` clears a limit.
	const set = await command("objective limits set", { id: objective.id, "max-daily-usd": "7" });
	expect(set.exitCode, JSON.stringify(set.body)).toBe(0);
	expect((await view(objective.id)).limits.maxDailyUsd).toBe(7);
	const unset = await command("objective limits set", { id: objective.id, "max-daily-usd": "default" });
	expect(unset.exitCode, JSON.stringify(unset.body)).toBe(0);
	expect((await view(objective.id)).limits.maxDailyUsd).toBeNull();
	expect((await command("objective limits set", { id: objective.id })).exitCode).toBe(2);
	// A bad number is a usage error the CLI reports, not a request the API ever sees.
	await expect(command("objective limits set", { id: objective.id, "max-daily-usd": "lots" })).rejects.toThrow(/must be a positive number/);
});

it("OBJ-41 raising maxTotalUsd lifts a budget_total pause, and the lead's held mail is handed back to the gate", async () => {
	await start([{ text: "I will read the meter tomorrow." }, { text: "Reading it now." }]);
	const objective = await draft("Cut the energy bill", { maxTotalUsd: 1 });
	const launched = await t!.client.post<{ objective: ObjectiveView }>(`/objectives/${objective.id}/launch`);
	expect(launched.status, JSON.stringify(launched.body)).toBe(200);
	const leadId = launched.body.objective.lead!.id;
	const threadId = launched.body.objective.thread!.id;
	await settle();

	// Spend past the lifetime limit, which pauses the objective with no automatic lift (OBJ-21).
	await t!.runtime.db.write((tx) => recordCost(tx, t!.runtime, leadId, 2));
	expect((await view(objective.id)).paused).toBe("budget_total");
	const refused = await t!.runtime.db.write((tx) => admitRun(tx, t!.runtime, leadId, { kind: "delivery" }));
	expect(refused).toMatchObject({ admit: false, condition: "budget_total" });

	// Past the lead's quiet interval, so the budget is the only thing holding the next run (OBJ-18).
	await t!.clock.advance(10 * 60_000);
	// Mail to the lead waits instead of waking it, and nothing is lost: unread, no wake (OBJ-23).
	const head = (await t!.runtime.db.get<{ id: string }>("SELECT id FROM messages WHERE thread_id = ? ORDER BY seq DESC LIMIT 1", threadId))!.id;
	const posted = await t!.client.post<{ message: { id: string } }>(`/threads/${threadId}/messages`, { after: head, body: "Please read the meter." });
	expect(posted.status, JSON.stringify(posted.body)).toBe(200);
	await settle();
	expect(await heldDelivery(posted.body.message.id, leadId)).toMatchObject({ read_at: null, wake_request_id: null });

	// Raising the limit is the only way back. The route hands the lead's held mail to the gate that
	// now admits it, so the work resumes rather than waiting for a poke.
	await t!.client.post(`/objectives/${objective.id}/limits`, { maxTotalUsd: 5 });
	// The lead ran the held mail: one run started, and the delivery woke it exactly once.
	await settle();
	expect((await heldDelivery(posted.body.message.id, leadId))!.wake_request_id).not.toBeNull();
	expect((await view(objective.id)).paused).toBeNull();
	// The change itself is in the objective's history beside the budget event it answers.
	const conditions = await t!.runtime.db.all<{ kind: string; detail: string }>(
		"SELECT kind, detail FROM objective_events WHERE objective_id = ? AND kind IN ('budget', 'limits.set') ORDER BY at, id",
		objective.id,
	);
	expect(conditions.map((row) => row.kind)).toEqual(["budget", "limits.set"]);
	expect(JSON.parse(conditions.at(-1)!.detail)).toEqual({ field: "maxTotalUsd", from: 1, to: 5 });
});
