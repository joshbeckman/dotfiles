// The acceptance test for WP18 (OBJ-40): one objective's whole life, driven by the faux model and
// the fake clock. It exists to prove the layer is real rather than each package's unit tests
// agreeing with each other, so every assertion reads panad's own state (`GET /objectives/:id`, its
// threads, its deliveries and its `objective_events`) rather than an internal helper.
//
// One ordering note, because it is a discovery rather than a preference. An armed metric check
// keeps an active objective `idle` forever: OBJ-03 reads `idle` while "a metric check is due in the
// future", and a repeating check is always due in the future, so an objective with a check loop can
// never read `stranded`. The check is therefore declared after the strand (step 6 here, though the
// brief lists it fourth) and measured there with no session awake; `done` still needs its reading.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { BRIEF_TITLE } from "../src/objectives/index.ts";
import type { MetricView, MetricsView } from "../src/objectives/metrics.ts";
import { nextDayStart } from "../src/sessions/budget.ts";
import { deliveryOf, draft, events, headOf, inputs, launch, pana, reply, seedSession, settle, startObjectives, view } from "./harness/objectives.ts";
import type { TestPanad } from "./harness/index.ts";

const MINUTE = 60_000;

let t: TestPanad | undefined;
afterEach(async () => {
	await t?.close();
	t = undefined;
});

// --- Small reads over panad's state ---------------------------------------------

interface SessionFacts {
	id: string;
	state: string;
	parent: string | null;
	depth: number;
	objective_id: string | null;
	stopped_by: "user" | "objective" | null;
	hold_until: number | null;
}

async function sessionFacts(id: string): Promise<SessionFacts> {
	const row = await t!.runtime.db.get<SessionFacts>(
		"SELECT id, state, parent, depth, objective_id, stopped_by, hold_until FROM sessions WHERE id = ?",
		id,
	);
	expect(row, `session ${id}`).toBeDefined();
	return row!;
}

/** Active wake schedules targeting a session, in the WAK-01 payload shape. */
async function wakesFor(sessionId: string) {
	const rows = await t!.runtime.db.all<{ id: string; next_at: number; payload: string }>(
		`SELECT id, next_at, payload FROM schedules
		  WHERE kind = 'wake' AND state = 'active' AND json_extract(payload, '$.session') = ? ORDER BY next_at, id`,
		sessionId,
	);
	return rows.map((row) => ({ id: row.id, next_at: row.next_at, payload: JSON.parse(row.payload) as { session: string; note: string; hold?: boolean } }));
}

/** Notices the domain posted, oldest last. */
async function domainNotices(): Promise<string[]> {
	const rows = await t!.runtime.db.all<{ body: string }>(
		"SELECT m.body AS body FROM messages m JOIN participants p ON p.id = m.sender_id WHERE p.kind = 'domain' ORDER BY m.created_at, m.seq",
	);
	return rows.map((row) => row.body);
}

async function metricsOf(objectiveId: string): Promise<MetricsView> {
	const res = await t!.client.get<MetricsView>(`/objectives/${objectiveId}/metrics`);
	expect(res.status).toBe(200);
	return res.body;
}

async function metricOf(objectiveId: string, name: string): Promise<MetricView> {
	const found = (await metricsOf(objectiveId)).metrics.find((metric) => metric.name === name);
	expect(found, `metric ${name}`).toBeDefined();
	return found!;
}

/** The objective's thread between the lead and the member, where the lead coordinates. */
async function threadWith(sessionId: string): Promise<string> {
	const rows = await t!.runtime.db.all<{ thread_id: string }>("SELECT thread_id FROM thread_participants WHERE participant_id = ?", sessionId);
	expect(rows).toHaveLength(1);
	return rows[0]!.thread_id;
}

// --- OBJ-40 --------------------------------------------------------------------

it("OBJ-40 an objective survives its lead's death, wakes on its own, and says why it stopped", async () => {
	t = await startObjectives({
		// Five quiet minutes between lead runs: exactly what the held-deliveries step needs.
		config: { objectives: { wakeMinMinutes: 5 } },
		script: [
			// The lead's first run carries the briefing and puts one member to work.
			{ toolCalls: [{ name: "pana_session_create", args: { prompt: "Audit the boiler: cycles per day, then report." } }] },
			{ text: "Noted." },
			{ text: "Noted." },
		],
	});

	// 1. A session proposes a draft; only the user launches it, and the lead's first run carries
	// the briefing (OBJ-04, OBJ-05, OBJ-32).
	const proposer = await seedSession(t, null, "idle");
	const objective = await draft(t, "Cut the boiler's energy use", { wakeMinMinutes: 5, maxDailyUsd: 0.05, maxDailyUserMessages: 40 }, proposer);
	expect(objective.phase).toBe("drafting");
	expect(objective.proposedBy!.id).toBe(proposer);
	expect(objective.lead).toBeNull();
	const refused = await pana(t, "objective launch", { id: objective.id }, proposer);
	expect(refused.exitCode).toBe(1);
	expect((refused.body as { error: { code: string } }).error.code).toBe("forbidden");

	const cycles = await pana(t, "objective metric add", { id: objective.id, name: "boiler-cycles", unit: "cycles/day", direction: "down", target: "5" });
	expect(cycles.exitCode).toBe(0);

	// Thirty seconds in, so every hold below releases between the sweeper's five-minute marks: a
	// sweep that is in flight when the clock jumps cannot read a state the run behind it changed.
	await t.clock.advance(30_000);
	const launched = await launch(t, objective.id);
	expect(launched.phase).toBe("active");
	expect(launched.proposedBy!.id).toBe(proposer);
	const lead = launched.lead!.id;
	const threadId = launched.thread!.id;
	expect(launched.thread!.url).toBe(`pana://test.example/threads/${threadId}`);
	// The lead is the user's child at depth 0, whatever session proposed the draft.
	expect(await sessionFacts(lead)).toMatchObject({ parent: null, depth: 0, objective_id: objective.id });
	const opening = (await inputs(t, lead)).filter((text) => text.length > 0)[0]!;
	expect(opening).toContain(BRIEF_TITLE);
	expect(opening).toContain("Cut the boiler's energy use");
	expect(opening).toContain(`pana://test.example/objectives/${objective.id}`);
	for (const section of ["### Scope", "### Cancel", "### Done", "### Guidance", "### Escalation", "### Notes"]) expect(opening).toContain(section);

	// 2. The lead creates one member; the member does work and reports; a metric moves (OBJ-13, OBJ-25).
	const shown = await view(t, objective.id);
	expect(shown.members).toHaveLength(2);
	const member = shown.members.find((entry) => entry.id !== lead)!;
	expect(await sessionFacts(member.id)).toMatchObject({ parent: lead, depth: 1, objective_id: objective.id });

	const memberThread = await threadWith(member.id);
	// The lead sends the work order; the member's run is held at its first model call until the
	// order exists, so its report can name the message it answers.
	const releaseMember = t.model.gate({ at: "start" });
	const order = await pana(t, "thread respond", { thread: memberThread, after: await headOf(t, memberThread), body: "Measure the cycle count and report." }, lead);
	expect(order.exitCode).toBe(0);
	t.model.append([
		{ toolCalls: [{ name: "bash", args: { command: "printf 'cycles: 9\\n' > boiler.txt" } }] },
		{
			toolCalls: [
				{
					name: "pana_reply",
					args: { thread: memberThread, after: (order.body as { message: { id: string } }).message.id, body: "Report: nine cycles a day, and the flow temperature never reached target." },
				},
			],
		},
		{ text: "Report sent to the lead." },
	]);
	releaseMember();
	await settle(t);
	expect(await sessionFacts(member.id)).toMatchObject({ state: "idle" });
	const report = await t!.runtime.db.get<{ id: string; body: string; sender_id: string }>(
		"SELECT id, body, sender_id FROM messages WHERE thread_id = ? AND body LIKE 'Report:%'",
		memberThread,
	);
	expect(report!.sender_id).toBe(member.id);
	expect(report!.body).toContain("nine cycles a day");
	// The work was real: the member measured in its own scratch directory.
	expect(existsSync(join(t.runtime.paths.scratch, member.id, "boiler.txt"))).toBe(true);

	// The lead acts on the report: the objective's measured value moves, short of its target.
	expect((await pana(t, "objective metric set", { id: objective.id, name: "boiler-cycles", value: "9" }, lead)).exitCode).toBe(0);
	const measured = await metricOf(objective.id, "boiler-cycles");
	expect(measured.readings).toHaveLength(1);
	expect(measured.readings[0]).toMatchObject({ value: 9, source: "lead" });
	expect(measured.target).toBe(5);
	expect(measured.baseline).toBe(9);

	// 3. Deliveries inside `wakeMinMinutes` are held and coalesce into exactly one lead run
	// (OBJ-18): the member's answer, the member's report, and the user's mail all wait, unread.
	const calls = t.model.calls();
	const userMail = await reply(t, threadId, "How is the boiler doing?");
	expect(userMail.status).toBe(200);
	await t.clock.settle();
	expect(t.model.calls()).toBe(calls);
	const held = await t!.runtime.db.all<{ message_id: string; body: string }>(
		`SELECT d.message_id AS message_id, m.body AS body FROM deliveries d JOIN messages m ON m.id = d.message_id
		  WHERE d.recipient_id = ? AND d.read_at IS NULL ORDER BY d.created_at, d.id`,
		lead,
	);
	const heldBodies = held.map((row) => row.body).join("\n");
	expect(heldBodies).toContain("nine cycles a day");
	expect(heldBodies).toContain("How is the boiler doing?");
	const leadHold = await sessionFacts(lead);
	expect(leadHold.hold_until).not.toBeNull();
	expect((await view(t, objective.id)).state).toBe("idle");
	const holdWakes = await wakesFor(lead);
	expect(holdWakes).toHaveLength(1);
	expect(holdWakes[0]!.payload.hold).toBe(true);
	expect(holdWakes[0]!.next_at).toBe(leadHold.hold_until);
	// The hold is an ordinary wake whose note names what is waiting, so it survives a restart (OBJ-18).
	for (const row of held) expect(holdWakes[0]!.payload.note).toContain(row.message_id);

	// When the interval elapses, exactly one run starts and carries every held delivery in order.
	t.model.append([{ text: "Both reports read; the boiler work continues." }]);
	await t!.clock.advanceTo(leadHold.hold_until!);
	await settle(t);
	expect(t.model.calls()).toBe(calls + 1);
	const submissionIds = new Set<unknown>();
	for (const row of held) {
		const delivered = await deliveryOf(t, lead, row.message_id);
		expect(delivered!.read_at, row.body).not.toBeNull();
		expect(delivered!.wake_submission_id, row.body).not.toBeNull();
		submissionIds.add(delivered!.wake_submission_id);
		// Delivered once: one delivery row per message, and one run carrying it.
		const copies = await t!.runtime.db.get<{ n: number }>("SELECT count(*) AS n FROM deliveries WHERE recipient_id = ? AND message_id = ?", lead, row.message_id);
		expect(copies!.n, row.body).toBe(1);
	}
	expect(submissionIds.size, "one run carried them all").toBe(1);
	expect(await sessionFacts(lead)).toMatchObject({ state: "idle", hold_until: null });
	expect(await wakesFor(lead)).toHaveLength(0);
	const transcript = (await inputs(t, lead)).join("\n");
	expect(transcript.split("How is the boiler doing?")).toHaveLength(2);
	expect(transcript.split("nine cycles a day")).toHaveLength(2);

	// 4. The user stops the lead mid-run. The objective reads `stranded` and nobody tells the user
	// yet; the sweep (OBJ-06) posts exactly one notice, naming the objective and why it stopped.
	const strandMail = await reply(t, threadId, "Write this week's summary.");
	expect(strandMail.status).toBe(200);
	// A run that takes a little real time, so the user's stop lands in the middle of it: one turn,
	// never answered, so nothing is left queued for a later run to pick up.
	t.model.append([{ toolCalls: [{ name: "bash", args: { command: "sleep 2" } }] }]);
	const heldUntil = (await sessionFacts(lead)).hold_until!;
	expect(heldUntil).toBeGreaterThan(t.clock.now());
	await t!.clock.advanceTo(heldUntil);
	// The hold released and the lead is working: the objective is moving, not stranded.
	expect(await sessionFacts(lead)).toMatchObject({ state: "running" });
	expect((await view(t, objective.id)).state).toBe("running");
	expect((await domainNotices()).filter((body) => body.includes("is stranded"))).toHaveLength(0);
	// The user stops it in the middle of that run.
	expect((await t.client.post(`/sessions/${lead}/stop`)).status).toBe(200);
	await settle(t);
	expect(await sessionFacts(lead)).toMatchObject({ state: "stopped", stopped_by: "user" });
	expect((await view(t, objective.id)).state).toBe("stranded");
	// The next sweep tells the user once, by name, and offers the replacement.
	await t.clock.advance(5 * MINUTE);
	await settle(t);
	const stranded = (await domainNotices()).filter((body) => body.includes("is stranded"));
	expect(stranded).toHaveLength(1);
	expect(stranded[0]).toContain(`pana://test.example/objectives/${objective.id}`);
	expect(stranded[0]).toContain("nothing will move it");
	expect(stranded[0]).toContain("regenerate-lead");
	await t.clock.advance(10 * MINUTE);
	await settle(t);
	expect((await domainNotices()).filter((body) => body.includes("is stranded")), "not repeated while nothing moves").toHaveLength(1);

	// 5. The user regenerates the lead: the old one is archived and out of the thread, the
	// replacement wakes with the briefing, and there is never a second live lead (OBJ-35).
	t.model.append([{ text: "I am the replacement, and I have the briefing." }]);
	const regenerated = await t.client.post(`/objectives/${objective.id}/regenerate-lead`, { reason: "It stopped in the middle of a run." });
	expect(regenerated.status).toBe(200);
	await settle(t);
	const afterSwap = await view(t, objective.id);
	const replacement = afterSwap.lead!.id;
	expect(replacement).not.toBe(lead);
	expect(afterSwap.phase).toBe("active");
	expect(await sessionFacts(lead)).toMatchObject({ state: "archived", stopped_by: "objective" });
	expect(await t!.runtime.db.get("SELECT 1 AS one FROM thread_participants WHERE thread_id = ? AND participant_id = ?", threadId, lead)).toBeUndefined();
	const liveLeads = await t!.runtime.db.all<{ id: string }>(
		"SELECT id FROM sessions WHERE objective_id = ? AND parent IS NULL AND state NOT IN ('stopped', 'archived')",
		objective.id,
	);
	expect(liveLeads.map((row) => row.id)).toEqual([replacement]);
	expect(await sessionFacts(replacement)).toMatchObject({ parent: null, depth: 0, objective_id: objective.id });
	const swap = await events(t, objective.id, "regenerated");
	expect(swap).toHaveLength(1);
	expect(swap[0]!.detail).toMatchObject({ from: lead, to: replacement, reason: "It stopped in the middle of a run." });
	expect((await t.client.post(`/sessions/${lead}/resume`)).status).toBe(403);
	const handoff = (await inputs(t, replacement)).filter((text) => text.length > 0)[0]!;
	expect(handoff).toContain(BRIEF_TITLE);
	expect(handoff).toContain("You are the new lead of this objective.");
	expect(handoff).toContain(lead);
	expect(handoff).toContain("It stopped in the middle of a run.");

	// 6. A metric measured by its own `--check` loop with no session awake (OBJ-26). An armed check
	// makes an active objective `idle` (OBJ-03), which is why this follows the strand.
	const added = await pana(t, "objective metric add", {
		id: objective.id,
		name: "kilowatt-hours",
		unit: "kWh",
		direction: "down",
		target: "200",
		check: "printf 210",
		"check-every": "1d",
	});
	expect(added.exitCode).toBe(0);
	const checked = await metricOf(objective.id, "kilowatt-hours");
	expect(checked.check!.command).toBe("printf 210");
	expect(checked.readings).toEqual([]);
	expect((await view(t, objective.id)).state).toBe("idle");

	// 7. The day budget pauses the objective, stops its running members as the objective's act,
	// and wakes the lead at the next local day (OBJ-20).
	// The replacement puts a member of its own to work: the retired lead's threads are read-only
	// once it is archived (STA-07), so the work continues on a thread the new lead is part of.
	t.model.append([{ toolCalls: [{ name: "bash", args: { command: "sleep 2" } }], usage: { costUsd: 0.06 } }]);
	const hired = await t.client.post<{ session: { id: string } }>("/sessions", { prompt: "Audit the boiler again and report." }, { caller: replacement });
	expect(hired.status, JSON.stringify(hired.body)).toBe(201);
	const worker = hired.body.session.id;
	// Its own run crosses today's $0.05, which is the objective's act to stop, not the user's.
	await vi.waitFor(async () => expect((await view(t!, objective.id)).paused).toBe("budget_day"));
	const resumeAt = nextDayStart(t.clock.now(), "UTC");
	await vi.waitFor(async () => expect((await sessionFacts(replacement)).hold_until).toBe(resumeAt));
	const paused = await view(t, objective.id);
	expect(paused.state).toBe("idle");
	expect(await sessionFacts(worker)).toMatchObject({ state: "stopped", stopped_by: "objective" });
	const budgetWakes = await wakesFor(replacement);
	expect(budgetWakes).toHaveLength(1);
	expect(budgetWakes[0]!.next_at).toBe(resumeAt);
	const budgetNotices = (await domainNotices()).filter((body) => body.includes("daily budget"));
	expect(budgetNotices).toHaveLength(1);
	expect(budgetNotices[0]).toContain(`pana://test.example/objectives/${objective.id}`);
	expect(budgetNotices[0]).toContain(new Date(resumeAt).toISOString());
	// A paused objective starts nothing: a member create is refused until the day turns.
	const refusedHire = await t.client.post(`/sessions`, { prompt: "one more" }, { caller: replacement });
	expect(refusedHire.status).toBe(402);
	expect((refusedHire.body as { error: { code: string } }).error.code).toBe("objective_budget_day");

	// 8. `done` waits for the user's confirmation, and every metric at target is required
	// (OBJ-07). First the check measures the objective while nothing is awake.
	const checkAt = (await metricOf(objective.id, "kilowatt-hours")).check!.nextCheckAt!;
	t.model.append([{ text: "Back at work on the new day." }]);
	const runsBefore = (await inputs(t, replacement)).filter((text) => text.length > 0).length;
	await t!.clock.advanceTo(resumeAt);
	await settle(t);
	expect((await view(t, objective.id)).paused).toBeNull();
	expect(await sessionFacts(replacement)).toMatchObject({ state: "idle", hold_until: null });
	// The replacement woke on the day budget's schedule, and every lead run starts with the briefing.
	const woke = (await inputs(t, replacement)).filter((text) => text.length > 0);
	expect(woke.length).toBe(runsBefore + 1);
	expect(woke.at(-1)).toContain(BRIEF_TITLE);
	expect(woke.at(-1)).toContain(`pana://test.example/objectives/${objective.id}`);

	const running = await t!.runtime.db.all<{ id: string }>("SELECT id FROM sessions WHERE objective_id = ? AND state IN ('running', 'waiting')", objective.id);
	expect(running).toHaveLength(0);
	const beforeCheck = t.model.calls();
	// Exactly to the check's time: the fake clock must not move again until the check has answered,
	// because the check's own 30-second timeout is measured on it (SCH-11).
	await t!.clock.advanceTo(checkAt);
	await vi.waitFor(async () => expect((await metricOf(objective.id, "kilowatt-hours")).readings).toHaveLength(1));
	const byCheck = await metricOf(objective.id, "kilowatt-hours");
	expect(byCheck.readings[0]).toMatchObject({ value: 210, source: "check" });
	expect(byCheck.baseline).toBe(210);
	expect(t.model.calls(), "no session woke for the check").toBe(beforeCheck);

	// Short of target, nothing finishes the objective, and the user is told which metrics are behind.
	const behind = await t.client.post(`/objectives/${objective.id}/done`);
	expect(behind.status).toBe(409);
	expect((behind.body as { error: { code: string } }).error.code).toBe("metric_behind");
	expect((behind.body as { error: { metrics: Array<{ name: string; target: number; value: number | null }> } }).error.metrics.map((metric) => metric.name).sort()).toEqual([
		"boiler-cycles",
		"kilowatt-hours",
	]);

	// Every metric reaches its target, and the lead still may not finish it: that is the user's word.
	expect((await pana(t, "objective metric set", { id: objective.id, name: "boiler-cycles", value: "4" }, replacement)).exitCode).toBe(0);
	expect((await pana(t, "objective metric set", { id: objective.id, name: "kilowatt-hours", value: "195" }, replacement)).exitCode).toBe(0);
	expect((await t.client.post(`/objectives/${objective.id}/done`, {}, { caller: replacement })).status).toBe(403);
	const done = await t.client.post<{ objective: { phase: string; state: string | null } }>(`/objectives/${objective.id}/done`);
	expect(done.status).toBe(200);
	expect(done.body.objective).toMatchObject({ phase: "done", state: null });
	expect((await events(t, objective.id, "done")).length).toBeGreaterThanOrEqual(1);
});
