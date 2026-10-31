// The briefing (OBJ-32) and the lead's prompt (OBJ-37): what a lead run knows, and what it is told
// to do with it.

import { afterEach, expect, it } from "vitest";
import { BRIEF_TITLE, leadBriefing, leadRunInput } from "../src/objectives/index.ts";
import { draft, events, inputs, launch, pana, reply, settle, startObjectives, view } from "./harness/objectives.ts";
import type { TestPanad } from "./harness/index.ts";

let t: TestPanad | undefined;
afterEach(async () => {
	await t?.close();
	t = undefined;
});

async function start(): Promise<TestPanad> {
	t = await startObjectives({ script: [{ text: "I am the lead." }, { text: "Still here." }] });
	return t;
}

async function brief(id: string, caller?: string): Promise<string> {
	const res = await t!.client.get<{ brief: string }>(`/objectives/${id}/brief`, caller ? { caller } : {});
	expect(res.status).toBe(200);
	return res.body.brief;
}

// --- OBJ-32 --------------------------------------------------------------------

it("OBJ-32 the brief carries the goal, phase, charter, roster, spend, metrics, wakes, escalation, held deliveries, and reports", async () => {
	await start();
	const objective = await draft(t!, "Cut the energy bill by 10%", {
		maxDailyUsd: 5,
		maxTotalUsd: 10,
		maxDailyLeadTurns: 3,
		maxActiveMembers: 4,
		wakeMinMinutes: 7,
	});
	await launch(t!, objective.id);
	const shown = await view(t!, objective.id);
	const lead = shown.lead!.id;
	const threadId = shown.thread!.id;

	const now = t!.clock.now();
	await t!.client.post(`/objectives/${objective.id}/charter`, { section: "Scope", body: "The meter and the boiler." });
	await t!.runtime.db.write(async (tx) => {
		await tx.run("INSERT INTO objective_metrics (objective_id, name, unit, direction, target, created_at) VALUES (?, 'kilowatt-hours', 'kWh', 'down', 200, ?)", objective.id, now);
		await tx.run(
			"INSERT INTO metric_readings (id, objective_id, name, at, value, source) VALUES (?, ?, 'kilowatt-hours', ?, 210.5, 'check')",
			t!.runtime.newId(),
			objective.id,
			now,
		);
		// OBJ-20/21: today and lifetime spend both come from the per-day ledger (limits.ts).
		const day = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
		const yesterday = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now - 86_400_000));
		await tx.run("INSERT INTO objective_costs (day, objective_id, cost_usd) VALUES (?, ?, 1.25)", day, objective.id);
		await tx.run("INSERT INTO objective_costs (day, objective_id, cost_usd) VALUES (?, ?, 1.25)", yesterday, objective.id);
		// Five newer reports and one older than the window, so "the last five" is visible.
		for (let index = 0; index < 6; index++) {
			const messageId = t!.runtime.newId();
			await tx.run(
				"INSERT INTO messages (id, thread_id, seq, sender_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				messageId,
				threadId,
				100 + index,
				lead,
				`Report ${index}.`,
				now - (6 - index) * 60_000,
			);
			await tx.run("INSERT INTO objective_reports (objective_id, message_id, created_at) VALUES (?, ?, ?)", objective.id, messageId, now - (6 - index) * 60_000);
		}
	});

	// A member with a stop reason, a pending wake for it, and an escalation.
	const memberId = t!.runtime.newId();
	await t!.runtime.db.write(async (tx) => {
		await tx.run("INSERT INTO participants (id, kind, url, created_at) VALUES (?, 'session', ?, ?)", memberId, t!.runtime.url({ kind: "session", id: memberId }), now);
		await tx.run(
			"INSERT INTO sessions (id, state, parent, depth, profile, objective_id, stopped_by, created_at, updated_at) VALUES (?, 'stopped', ?, 1, 'energy', ?, 'user', ?, ?)",
			memberId,
			lead,
			objective.id,
			now,
			now,
		);
	});
	const wake = await t!.client.post<{ schedule: { id: string } }>("/schedules", { kind: "wake", session: memberId, in: "1h", note: "Check the meter." });
	expect(wake.status).toBe(201);
	const escalated = await t!.client.post<{ escalation: { url: string } }>(`/objectives/${objective.id}/escalate`, { body: "Which tariff?" }, { caller: lead });
	expect(escalated.status).toBe(201);

	const text = await brief(objective.id);
	expect(text.startsWith(BRIEF_TITLE)).toBe(true);
	expect(text).toContain("Objective: Cut the energy bill by 10%");
	expect(text).toContain(shown.url);
	expect(text).toContain("Phase: active");
	for (const heading of ["### Scope", "### Cancel", "### Done", "### Guidance", "### Escalation", "### Notes"]) expect(text).toContain(heading);
	expect(text).toContain("The meter and the boiler.");
	expect(text).toMatch(new RegExp(`lead pana://test\\.example/sessions/${lead}: (idle|running)`));
	expect(text).toContain(`profile energy`);
	expect(text).toContain("stopped by the user — inert to the objective");
	expect(text).toContain(`pana://test.example/sessions/${memberId}`);
	expect(text).toContain("Money today: $1.25 of $5.00");
	expect(text).toContain("Money in total: $2.50 of $10.00");
	expect(text).toContain("Lead runs today: 1 of 3");
	expect(text).toContain("Lead runs in total: 1");
	expect(text).toContain("Members active: 1 of 4");
	expect(text).toContain("Quiet interval between your runs: 7 minutes");
	expect(text).toContain("Held deliveries: 0");
	// OBJ-24's message count is limits.ts', and the escalation is one message to the user.
	// Two messages so far: the first run's reply to the user, and the escalation.
	expect(text).toContain("Messages to the user today: 2 of 10");
	expect(text).toMatch(/kilowatt-hours \(down is progress, raw\): 210\.5 kWh as of /);
	expect(text).toContain("target 200 kWh; short of target");
	expect(text).toContain("At target: 0 of 1.");
	expect(text).toContain(new Date(now + 3_600_000).toISOString());
	expect(text).toContain("## Awaiting the user");
	expect(text).toContain(escalated.body.escalation.url);
	expect(text).toContain(`pana://test.example/threads/${threadId}`);

	// The last five reports, newest first, and not the sixth.
	expect(text).toContain("Report 5.");
	expect(text).toContain("Report 1.");
	expect(text).not.toContain("Report 0.");
	expect(text.match(/Report \d\./g)).toHaveLength(5);

	// OBJ-32: deterministic for a given database state.
	expect(await brief(objective.id)).toBe(text);

	// A held delivery and a held run are both conditions the brief names.
	await t!.runtime.db.write((tx) => tx.run("UPDATE deliveries SET read_at = NULL, wake_submission_id = NULL, wake_request_id = NULL WHERE recipient_id = ?", lead));
	const held = await brief(objective.id);
	expect(held).not.toContain("Held deliveries: 0");
	await t!.runtime.db.write((tx) => tx.run("UPDATE sessions SET hold_until = ? WHERE id = ?", now + 600_000, lead));
	expect(await brief(objective.id)).toContain(`Your next run is held until ${new Date(now + 600_000).toISOString()}`);

	// The CLI prints the brief as its body, by ID and — as the lead — with none.
	const byId = await pana(t!, "objective brief", { id: objective.id });
	expect(byId.exitCode).toBe(0);
	expect((byId.body as { brief: string }).brief).toBe(await brief(objective.id));
	const own = await pana(t!, "objective brief", {}, lead);
	expect(own.exitCode).toBe(0);
	expect((own.body as { brief: string }).brief).toBe(await brief(objective.id));
	// The user has no objective of their own to ask for.
	expect((await pana(t!, "objective brief", {})).exitCode).toBe(2);
});

it("OBJ-32 a draft's brief renders without members, and names what is missing rather than inventing it", async () => {
	await start();
	const objective = await draft(t!, "A goal with no lead yet");
	const text = await brief(objective.id);
	expect(text).toContain("Phase: drafting");
	expect(text).toContain("The objective is drafting: no run starts until the user changes that.");
	expect(text).toContain("No members yet.");
	expect(text).toContain("No metrics declared.");
	expect(text).toContain("Nothing: no escalation is open.");
	expect(text).toContain("Money today: $0.00 (no limit)");
	expect(text).toContain("No deadline: this objective has no `dueAt`.");
});

it("OBJ-32 the brief renders each targeted metric's pace against the deadline", async () => {
	await start();
	const objective = await draft(t!, "Lose 5 kg by June", { dueAt: new Date(t!.clock.now() + 30 * 86_400_000).toISOString() });
	const now = t!.clock.now();
	await t!.runtime.db.write(async (tx) => {
		await tx.run("INSERT INTO objective_metrics (objective_id, name, unit, direction, target, created_at) VALUES (?, 'weight', 'kg', 'down', 80, ?)", objective.id, now - 10 * 86_400_000);
		for (const [daysAgo, value] of [[10, 86], [5, 85], [0, 84.5]] as const) {
			await tx.run(
				"INSERT INTO metric_readings (id, objective_id, name, at, value, source) VALUES (?, ?, 'weight', ?, ?, 'lead')",
				t!.runtime.newId(),
				objective.id,
				now - daysAgo * 86_400_000,
				value,
			);
		}
	});
	const text = await brief(objective.id);
	expect(text).toContain("## Pace");
	// `pace.ts`' line: what it needs a day against what it has moved.
	expect(text).toMatch(/- weight \(kg\): needs [\d.-]+ kg\/day, has moved [\d.-]+ kg\/day/);
	// The deadline is 30 days out and the pace is short, so the brief names it.
	expect(text).toMatch(/weight \(kg\): needs .* (— behind)?/);
});

// --- OBJ-37 --------------------------------------------------------------------

it("OBJ-37 the lead's prompt text says to coordinate, keep state in Notes, use memory, and reply", async () => {
	await start();
	const objective = await draft(t!, "Run the household energy audit");
	await launch(t!, objective.id);
	const shown = await view(t!, objective.id);
	const lead = shown.lead!.id;
	const text = await brief(objective.id);

	expect(text).toContain("You coordinate; you hold no durable output of your own");
	expect(text).toContain("no worktree or branch");
	expect(text).toContain("charter's `Notes`");
	expect(text).toContain("memory");
	expect(text).toContain("`pana_reply`");
	expect(text).toContain("This objective: ");
	// It names its objective URL, its members, and its limits.
	expect(text).toContain(shown.url);
	expect(text).toContain(`pana://test.example/sessions/${lead}`);
	expect(text).toContain("## Limits and spend");

	// Every run starts with it: the next message's input begins with the briefing, then the mail.
	// The quiet interval between lead runs (OBJ-18) has to pass first, or the message waits.
	await t!.clock.advance(6 * 60_000);
	await reply(t!, shown.thread!.id, "How is it going?");
	await settle(t!);
	const last = (await inputs(t!, lead)).filter((text) => text.length > 0).at(-1)!;
	expect(last.indexOf(BRIEF_TITLE)).toBe(0);
	expect(last).toContain("How is it going?");
});

it("OBJ-32 the briefing on a run is rendered fresh, and a handoff briefing is not doubled", async () => {
	await start();
	const objective = await draft(t!, "Watch the meter");
	await launch(t!, objective.id);
	const shown = await view(t!, objective.id);
	const lead = shown.lead!.id;
	const row = (await t!.runtime.db.get("SELECT * FROM objectives WHERE id = ?", objective.id)) as never;

	// Direct render is what a run gets.
	const arrival = "New message.\nFrom: pana://test.example/users/tester\n\nhello";
	expect(await leadRunInput(t!.runtime, lead, arrival)).toBe(`${await leadBriefing(t!.runtime, row)}\n\n---\n\n${arrival}`);
	// A briefing that arrives as a message is not prefixed again: launch's first input and a handoff.
	const briefText = await leadBriefing(t!.runtime, row);
	expect(await leadRunInput(t!.runtime, lead, briefText)).toBe(briefText);
	// A member's delivery is unchanged.
	expect(await leadRunInput(t!.runtime, "some-other-session", arrival)).toBe(arrival);
	expect((await events(t!, objective.id, "launched")).length).toBe(1);
});
