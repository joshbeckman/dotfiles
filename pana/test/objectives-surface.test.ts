// WP18 surface: the two things an objective accumulates and the two notices that keep it honest.
// OBJ-30 (reports), OBJ-31 (artifacts), OBJ-06 (the stranded sweep), OBJ-08 (the behind condition
// and its pace arithmetic).
//
// The files this package owns are separate from `test/objectives.test.ts` so the packages building
// WP18 in parallel rarely edit the same test file.

import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { runPanaCommand } from "../src/cli/commands.ts";
import { main, type CliIo } from "../src/cli/index.ts";
import { metricPaces, paceOf, sweepObjectives, type ObjectiveArtifactView, type ObjectiveReportView, type ObjectiveView } from "../src/objectives/index.ts";
import { sessionRuntime } from "../src/sessions/index.ts";
import { startTestPanad, TEST_USER, type TestPanad, type TestPanadOptions } from "./harness/index.ts";

let t: TestPanad | undefined;
afterEach(async () => {
	await t?.close();
	t = undefined;
});

async function start(options: TestPanadOptions = {}): Promise<TestPanad> {
	t = await startTestPanad({
		...options,
		config: { defaultModel: "faux/faux-1", timezone: "UTC", ...(options.config ?? {}) },
		script: options.script ?? [{ text: "Understood." }],
	});
	return t;
}

type Params = Record<string, string | string[] | boolean | undefined>;

async function command(name: string, params: Params, caller?: string) {
	return runPanaCommand(name, params, {
		endpoint: { socketPath: t!.panad.socketPath },
		...(caller ? { caller } : {}),
	});
}

async function runCli(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	let stdout = "";
	let stderr = "";
	const io: Partial<CliIo> = {
		env: { PANA_STATE: t!.dir },
		stdin: Readable.from([]),
		stdout: { write: (chunk) => (stdout += chunk), isTTY: false },
		stderr: { write: (chunk) => (stderr += chunk), isTTY: false },
	};
	const code = await main(argv, io);
	return { code, stdout, stderr };
}

async function draft(goal = "Cut the energy bill", body: Record<string, unknown> = {}): Promise<ObjectiveView> {
	const made = await t!.client.post<{ objective: ObjectiveView }>("/objectives", { goal, ...body });
	expect(made.status).toBe(201);
	return made.body.objective;
}

async function view(id: string): Promise<ObjectiveView> {
	const res = await t!.client.get<{ objective: ObjectiveView }>(`/objectives/${id}`);
	expect(res.status).toBe(200);
	return res.body.objective;
}

/** An active objective with a real thread and a lead whose run has ended. */
async function launched(goal = "Cut the energy bill", body: Record<string, unknown> = {}): Promise<ObjectiveView> {
	const objective = await draft(goal, body);
	const res = await t!.client.post<{ objective: ObjectiveView }>(`/objectives/${objective.id}/launch`);
	expect(res.status).toBe(200);
	await settle();
	return res.body.objective;
}

/** Settle every run and every queued session job. */
async function settle(): Promise<void> {
	await t!.runtime.harness.waitForIdle(ctx);
	await sessionRuntime(t!.runtime).idle();
}

/** One count of a table. */
async function count(sql: string, ...params: string[]): Promise<number> {
	return (await t!.runtime.db.get<{ n: number }>(sql, ...params))!.n;
}

/** Every message in a thread, oldest first, with its sender's URL. */
async function threadMessages(threadId: string): Promise<Array<{ id: string; body: string; sender_id: string; url: string }>> {
	return t!.runtime.db.all<{ id: string; body: string; sender_id: string; url: string }>(
		`SELECT m.id AS id, m.body AS body, m.sender_id AS sender_id, p.url AS url
		   FROM messages m JOIN participants p ON p.id = m.sender_id
		  WHERE m.thread_id = ? ORDER BY m.seq`,
		threadId,
	);
}

/** The text of a session's inputs, oldest first. */
async function inputs(sessionId: string): Promise<string[]> {
	const row = await t!.runtime.db.get<{ conversation_id: number }>("SELECT conversation_id FROM sessions WHERE id = ?", sessionId);
	const conversation = await t!.runtime.harness.conversation(row!.conversation_id as never, ctx);
	const page = await conversation!.entries({ order: "ascending" }, 200, undefined, ctx);
	return page.items.map((entry) =>
		(entry.model ?? [])
			.map((message) => message as { role?: string; content?: unknown })
			.filter((message) => message.role === "user")
			.map((message) => String(message.content ?? ""))
			.join("\n"),
	);
}

// --- OBJ-30 -------------------------------------------------------------------

it("OBJ-30 a report is a message in the objective's thread plus its mark, and the view returns the newest", async () => {
	await start({ script: [{ text: "I am the lead." }, { text: "Understood." }, { text: "Understood." }] });
	const objective = await launched("Cut the energy bill");
	const lead = objective.lead!.id;
	const threadId = objective.thread!.id;

	const report = await command("objective report", { id: objective.id, body: "Week one: 412 kWh and falling." }, lead);
	expect(report.exitCode).toBe(0);
	const rows = await t!.runtime.db.all<{ message_id: string }>(
		"SELECT message_id FROM objective_reports WHERE objective_id = ?",
		objective.id,
	);
	expect(rows).toHaveLength(1);
	const marked = await t!.runtime.db.get<{ thread_id: string; sender_id: string }>(
		"SELECT thread_id, sender_id FROM messages WHERE id = ?",
		rows[0]!.message_id,
	);
	// A report is ordinary mail: in the objective's thread, sent by the caller.
	expect(marked).toEqual({ thread_id: threadId, sender_id: lead });
	expect((await threadMessages(threadId)).some((message) => message.body === "Week one: 412 kWh and falling.")).toBe(true);
	// It delivers like mail too, so the user reads it in the thread and hears the push.
	expect(
		await t!.runtime.db.get("SELECT recipient_id FROM deliveries WHERE message_id = ?", rows[0]!.message_id),
	).toEqual({ recipient_id: TEST_USER });

	// GET /objectives/:id returns the newest report message and its URL, which the PWA shows.
	const first = (await view(objective.id)).report as ObjectiveReportView;
	expect(first.messageId).toBe(rows[0]!.message_id);
	expect(first.url).toBe(`pana://test.example/threads/${threadId}?message=${rows[0]!.message_id}`);
	expect(first.threadUrl).toBe(`pana://test.example/threads/${threadId}`);
	expect(first.sender).toEqual({ id: lead, url: `pana://test.example/sessions/${lead}` });
	expect(first.body).toBe("Week one: 412 kWh and falling.");
	expect(first.revised).toBe(false);
	expect(first.redacted).toBe(false);

	// The objective has no report until one is posted.
	const quiet = await launched("Another goal");
	expect((await view(quiet.id)).report).toBeNull();

	// The newest report is the one the view shows.
	const userReport = await t!.client.post<{ report: ObjectiveReportView }>(`/objectives/${objective.id}/report`, {
		body: "The bill dropped 10%.",
	});
	expect(userReport.status).toBe(201);
	expect(userReport.body.report.messageId).not.toBe(first.messageId);
	expect((await view(objective.id)).report!.messageId).toBe(userReport.body.report.messageId);
	expect((await view(objective.id)).report!.sender.id).toBe(TEST_USER);

	// A revision and a redaction are the message's own, so the report view keeps them (EDT-04).
	const target = userReport.body.report.messageId;
	const revised = await t!.client.post(`/messages/${target}/revisions`, { body: "The bill dropped 12%." });
	expect(revised.status).toBe(200);
	expect((await view(objective.id)).report).toMatchObject({ body: "The bill dropped 12%.", revised: true, redacted: false });
	const redacted = await t!.client.post(`/messages/${target}/redact`, {});
	expect(redacted.status).toBe(200);
	const hidden = (await view(objective.id)).report!;
	expect(hidden.redacted).toBe(true);
	expect(hidden.body).toBeUndefined();
	expect(hidden.display).toBe("[redacted]");
	// The row stays: a report is marked, and redaction hides its text rather than unlinking it.
	expect(await count("SELECT count(*) AS n FROM objective_reports WHERE objective_id = ?", objective.id)).toBe(2);

	// A draft has no thread (OBJ-04), so it has nowhere to report.
	const unfinished = await draft("Still a draft");
	const refused = await command("objective report", { id: unfinished.id, body: "Too early." });
	expect(refused.exitCode).toBe(3);
	expect((refused.body as { error: { code: string } }).error.code).toBe("wrong_phase");
	expect(await count("SELECT count(*) AS n FROM objective_reports WHERE objective_id = ?", unfinished.id)).toBe(0);

	// A report inherits the thread's delivery rules. A closed objective refuses a delivery to its
	// members (OBJ-07), so the user's report — which would deliver to the lead — is refused; a
	// member's report delivers only to the user, who is not a member, and is still readable mail.
	await t!.client.post(`/objectives/${objective.id}/stop`);
	const closed = await command("objective report", { id: objective.id, body: "The objective is closed." });
	expect(closed.exitCode).toBe(3);
	expect((closed.body as { error: { code: string } }).error.code).toBe("objective_closed");
	expect(await count("SELECT count(*) AS n FROM objective_reports WHERE objective_id = ?", objective.id)).toBe(2);
	const parting = await command("objective report", { id: objective.id, body: "What was left undone." }, lead);
	expect(parting.exitCode, JSON.stringify(parting.body)).toBe(0);
	expect((await view(objective.id)).report!.body).toBe("What was left undone.");
});

// --- OBJ-31 -------------------------------------------------------------------

it("OBJ-31 an artifact is an uploaded file plus a link, and unlinking never deletes the file", async () => {
	await start();
	const objective = await draft("Publish the audit");
	const url = `pana://test.example/objectives/${objective.id}`;
	const source = join(t!.dir, "audit.csv");
	const bytes = "day,kwh\n1,412\n";
	writeFileSync(source, bytes);

	// `pana objective artifact add PATH` uploads through POST /files, then links the id.
	const added = await runCli(["objective", "artifact", "add", url, source]);
	expect(added.code, added.stderr).toBe(0);
	const artifact = (JSON.parse(added.stdout) as { artifact: ObjectiveArtifactView }).artifact;
	expect(artifact).toMatchObject({ name: "audit.csv", mediaType: "text/csv", size: Buffer.byteLength(bytes) });
	expect(artifact.url).toBe(`pana://test.example/files/${artifact.id}/audit.csv`);
	// FIL-01..FIL-07 unchanged: the bytes are an ordinary uploaded file.
	const file = await t!.runtime.db.get<{ name: string; path: string; size: number }>("SELECT name, path, size FROM files WHERE id = ?", artifact.id);
	expect(file).toEqual({ name: "audit.csv", path: join("files", artifact.id, "audit.csv"), size: Buffer.byteLength(bytes) });
	expect(existsSync(join(t!.runtime.paths.files, artifact.id, "audit.csv"))).toBe(true);

	// GET /objectives/:id lists artifacts with name, size, and file URL.
	const shown = await view(objective.id);
	expect(shown.artifacts).toEqual([artifact]);
	// A second link to the same file is the same link.
	const again = await t!.client.post(`/objectives/${objective.id}/artifacts`, { file: artifact.id });
	expect(again.status).toBe(201);
	expect((await view(objective.id)).artifacts).toHaveLength(1);

	// An unknown file is a 404, by id or by URL.
	const unknown = await t!.client.post(`/objectives/${objective.id}/artifacts`, { file: t!.runtime.newId() });
	expect(unknown.status).toBe(404);
	const nothing = await t!.client.post(`/objectives/${objective.id}/artifacts`, {});
	expect(nothing.status).toBe(400);

	// `artifact remove ID` unlinks without deleting the file or its bytes.
	const removed = await runCli(["objective", "artifact", "remove", url, artifact.id]);
	expect(removed.code, removed.stderr).toBe(0);
	expect(JSON.parse(removed.stdout)).toMatchObject({ removed: artifact.id, objective: { artifacts: [] } });
	expect((await view(objective.id)).artifacts).toEqual([]);
	expect(await count("SELECT count(*) AS n FROM objective_files WHERE objective_id = ?", objective.id)).toBe(0);
	expect(await count("SELECT count(*) AS n FROM files WHERE id = ?", artifact.id)).toBe(1);
	expect(existsSync(join(t!.runtime.paths.files, artifact.id, "audit.csv"))).toBe(true);

	// Removing an artifact that is not linked is 404, not a silent success.
	expect((await command("objective artifact remove", { id: objective.id, file: artifact.id })).exitCode).toBe(4);
});

// --- OBJ-06 -------------------------------------------------------------------

it("OBJ-06 the sweep notices a stranded objective once, names it, and wakes nothing", async () => {
	await start({ script: [{ text: "I am the lead." }] });
	const objective = await launched("Watch the meter");
	const lead = objective.lead!.id;
	const threadId = objective.thread!.id;
	expect((await view(objective.id)).state).toBe("stranded");
	const messagesBefore = await count("SELECT count(*) AS n FROM messages WHERE thread_id = ?", threadId);
	const schedulesBefore = await count("SELECT count(*) AS n FROM schedules");
	const sessionDeliveries = "SELECT count(*) AS n FROM deliveries d JOIN sessions s ON s.id = d.recipient_id";
	const sessionDeliveriesBefore = await count(sessionDeliveries);

	const sweep = await sweepObjectives(t!.runtime);
	expect(sweep.stranded.map((notice) => notice.objective)).toEqual([objective.id]);
	// One notice, in the objective's thread, from the domain, to the user only.
	const messages = await threadMessages(threadId);
	expect(messages).toHaveLength(messagesBefore + 1);
	const notice = messages[messages.length - 1]!;
	expect(notice.url).toBe("pana://test.example");
	expect(notice.body).toContain(`pana://test.example/objectives/${objective.id}`);
	expect(notice.body).toContain("No member is running or waiting");
	expect(await t!.runtime.db.all("SELECT recipient_id FROM deliveries WHERE message_id = ?", notice.id)).toEqual([{ recipient_id: TEST_USER }]);
	// It woke nothing: no schedule, no session delivery, and the lead is still idle.
	expect(await count("SELECT count(*) AS n FROM schedules")).toBe(schedulesBefore);
	expect(await count(sessionDeliveries)).toBe(sessionDeliveriesBefore);
	expect(await t!.runtime.db.get("SELECT state FROM sessions WHERE id = ?", lead)).toEqual({ state: "idle" });
	// The event says why, and the stamp is a notice time, not a state.
	const event = await t!.runtime.db.get<{ kind: string; detail: string }>(
		"SELECT kind, detail FROM objective_events WHERE objective_id = ? AND kind = 'stranded'",
		objective.id,
	);
	expect(event?.kind).toBe("stranded");
	expect(JSON.parse(event!.detail)).toMatchObject({ message: notice.id });
	expect(await t!.runtime.db.get("SELECT stranded_noticed_at FROM objectives WHERE id = ?", objective.id)).toEqual({
		stranded_noticed_at: t!.clock.now(),
	});
	expect((await view(objective.id)).state).toBe("stranded");

	// It is not repeated while the objective has not moved.
	await t!.clock.advance(5 * 60_000);
	expect(await count("SELECT count(*) AS n FROM messages WHERE thread_id = ?", threadId)).toBe(messagesBefore + 1);

	// A wake is movement: no notice, and the stamp clears.
	const wake = await t!.client.post<{ schedule: { id: string } }>("/schedules", { kind: "wake", session: lead, in: "1h", note: "Check the meter." });
	expect(wake.status).toBe(201);
	expect((await sweepObjectives(t!.runtime)).stranded).toEqual([]);
	expect((await t!.runtime.db.get("SELECT stranded_noticed_at FROM objectives WHERE id = ?", objective.id))).toEqual({
		stranded_noticed_at: null,
	});
	// When the wake is gone and it is stranded again, the user hears about it again.
	await t!.client.delete(`/schedules/${wake.body.schedule.id}`);
	expect((await sweepObjectives(t!.runtime)).stranded.map((notice) => notice.objective)).toEqual([objective.id]);
	expect(await count("SELECT count(*) AS n FROM messages WHERE thread_id = ?", threadId)).toBe(messagesBefore + 2);

	// OBJ-22/OBJ-33: a standing condition is a hold, not a strand, and it clears the stamp.
	await t!.runtime.db.write((tx) =>
		tx.run("INSERT INTO objective_escalations (id, objective_id, state, created_at) VALUES (?, ?, 'open', ?)", t!.runtime.newId(), objective.id, t!.clock.now()),
	);
	await t!.runtime.db.write((tx) => tx.run("UPDATE objectives SET stranded_noticed_at = ? WHERE id = ?", t!.clock.now(), objective.id));
	expect((await sweepObjectives(t!.runtime)).stranded).toEqual([]);
	expect((await t!.runtime.db.get("SELECT stranded_noticed_at FROM objectives WHERE id = ?", objective.id))).toEqual({
		stranded_noticed_at: null,
	});
	await t!.runtime.db.write((tx) => tx.run("DELETE FROM objective_escalations WHERE objective_id = ?", objective.id));
	// OBJ-20..22: `obj/lead-limits` owns the budget predicate and `objectiveState` reads it, so a
	// paused objective is `idle` before the sweep looks and the notice inherits that. The stamp is
	// clear here, so a `stranded` reading would have posted one: the sweep needs no budget hook.
	await t!.runtime.db.write(async (tx) => {
		await tx.run("UPDATE objectives SET max_daily_usd = 1 WHERE id = ?", objective.id);
		await tx.run(
			"INSERT INTO objective_costs (day, objective_id, cost_usd) VALUES (?, ?, 2)",
			new Date(t!.clock.now()).toISOString().slice(0, 10),
			objective.id,
		);
	});
	expect((await view(objective.id)).paused).toBe("budget_day");
	expect((await view(objective.id)).state).toBe("idle");
	expect((await sweepObjectives(t!.runtime)).stranded).toEqual([]);
	// Only active objectives are swept; a stopped one is its phase's business.
	await t!.client.post(`/objectives/${objective.id}/stop`);
	expect((await sweepObjectives(t!.runtime)).stranded).toEqual([]);
});

it("OBJ-06 panad sweeps again every five minutes on its clock", async () => {
	await start({ script: [{ text: "I am the lead." }] });
	const objective = await launched("Watch the meter");
	await t!.clock.settle();
	const notices = async () => count("SELECT count(*) AS n FROM messages WHERE thread_id = ?", objective.thread!.id);
	const before = await notices();
	await t!.clock.advance(4 * 60_000);
	await t!.clock.settle();
	expect(await notices()).toBe(before);
	await t!.clock.advance(60_000);
	for (let i = 0; i < 200 && (await notices()) === before; i++) await new Promise((resolve) => setTimeout(resolve, 10));
	expect(await notices()).toBe(before + 1);
});

// --- OBJ-08 -------------------------------------------------------------------

it("OBJ-08 pace is needed against achieved, in the metric's own direction", async () => {
	const at = Date.UTC(2026, 0, 1);
	const dueAt = at + 10 * 24 * 60 * 60_000;
	// Down is progress: 100 → 80 over 10 days needs 2 a day. Two days in at 96 is on pace.
	const down = paceOf({ name: "weight", unit: "kg", direction: "down", target: 80, baseline: { at, value: 100 }, current: 96, now: at + 2 * 24 * 60 * 60_000, dueAt });
	expect(down.remaining).toBe(16);
	expect(down.requiredPerDay).toBe(2);
	expect(down.achievedPerDay).toBe(2);
	expect(down.behind).toBe(false);
	// Two days in at 99 has moved 0.5 a day: no path to 80 by the deadline.
	const slow = { ...down, ...paceOf({ name: "weight", unit: "kg", direction: "down", target: 80, baseline: { at, value: 100 }, current: 99, now: at + 2 * 24 * 60 * 60_000, dueAt }) };
	expect(slow.behind).toBe(true);
	// Moving the wrong way is behind, and so is a deadline already passed short of target.
	expect(paceOf({ name: "weight", unit: "kg", direction: "down", target: 80, baseline: { at, value: 100 }, current: 101, now: at + 2 * 24 * 60 * 60_000, dueAt }).behind).toBe(true);
	const late = paceOf({ name: "weight", unit: "kg", direction: "down", target: 80, baseline: { at, value: 100 }, current: 84, now: at + 11 * 24 * 60 * 60_000, dueAt });
	expect(late.remainingDays).toBe(0);
	expect(late.behind).toBe(true);
	expect(late.requiredPerDay).toBe(Infinity);
	// Up is progress, and a metric at or past its target is never behind.
	const up = paceOf({ name: "posts", unit: "posts", direction: "up", target: 30, baseline: { at, value: 0 }, current: 12, now: at + 5 * 24 * 60 * 60_000, dueAt });
	expect(up.requiredPerDay).toBeCloseTo(18 / 5);
	expect(up.achievedPerDay).toBeCloseTo(12 / 5);
	expect(up.behind).toBe(true);
	const met = paceOf({ name: "posts", unit: "posts", direction: "up", target: 30, baseline: { at, value: 0 }, current: 31, now: at + 9 * 24 * 60 * 60_000, dueAt });
	expect(met.remaining).toBe(0);
	expect(met.behind).toBe(false);
	// No elapsed time means no achieved pace to compare yet, so nothing is behind on day zero.
	const fresh = paceOf({ name: "posts", unit: "posts", direction: "up", target: 30, baseline: { at, value: 0 }, current: 0, now: at, dueAt });
	expect(fresh.achievedPerDay).toBeNull();
	expect(fresh.behind).toBe(false);
});

it("OBJ-08 the sweep notices an objective with no path to its dueAt once, separately from stranded", async () => {
	await start({ script: [{ text: "I am the lead." }, { text: "Still on it." }, { text: "Watching." }, { text: "Measuring." }, { text: "Understood." }] });
	const dueAt = t!.clock.now() + 10 * 24 * 60 * 60_000;
	const objective = await launched("Lose 10 kg", { dueAt });
	const now = t!.clock.now();
	await t!.runtime.db.write(async (tx) => {
		await tx.run(
			"INSERT INTO objective_metrics (objective_id, name, unit, direction, target, created_at) VALUES (?, 'weight', 'kg', 'down', 80, ?)",
			objective.id,
			now - 5 * 24 * 60 * 60_000,
		);
		// Five days of readings that moved 1 kg, where the ten days left need 19 more at 1.9 a day.
		for (const [day, value] of [
			[5, 100],
			[0, 99],
		] as const) {
			await tx.run(
				"INSERT INTO metric_readings (id, objective_id, name, at, value, source) VALUES (?, ?, 'weight', ?, ?, 'user')",
				t!.runtime.newId(),
				objective.id,
				now - day * 24 * 60 * 60_000,
				value,
			);
		}
	});
	const paces = await metricPaces(t!.runtime.db, { id: objective.id, due_at: dueAt }, now);
	expect(paces.map((pace) => pace.name)).toEqual(["weight"]);
	expect(paces[0]).toMatchObject({ direction: "down", target: 80, baseline: 100, current: 99, behind: true });

	const sweep = await sweepObjectives(t!.runtime);
	expect(sweep.behind.map((notice) => notice.objective)).toEqual([objective.id]);
	const messages = await threadMessages(objective.thread!.id);
	const notice = messages[messages.length - 1]!;
	expect(notice.body).toContain(`pana://test.example/objectives/${objective.id}`);
	expect(notice.body).toContain("weight (kg): needs 1.9 kg/day, has moved 0.2 kg/day");
	expect(notice.body).toContain("Nothing is blocked");
	// Separate stamps: the objective reads stranded (nothing is running) but not behind twice.
	expect((await t!.runtime.db.get("SELECT behind_noticed_at, stranded_noticed_at FROM objectives WHERE id = ?", objective.id))).toMatchObject({
		behind_noticed_at: now,
	});
	await t!.clock.advance(5 * 60_000);
	expect((await sweepObjectives(t!.runtime)).behind).toEqual([]);

	// `behind` never blocks a run: the lead still answers.
	await settle();
	const before = await count("SELECT count(*) AS n FROM messages WHERE thread_id = ?", objective.thread!.id);
	const reply = await t!.client.post(`/threads/${objective.thread!.id}/messages`, { after: notice.id, body: "How is the weight going?" });
	expect(reply.status).toBe(200);
	await settle();
	expect(await count("SELECT count(*) AS n FROM messages WHERE thread_id = ?", objective.thread!.id)).toBeGreaterThan(before);
	// The lead ran: the reply reached its next input, so the notice blocked nothing.
	expect((await inputs(objective.lead!.id)).join("\n")).toContain("How is the weight going?");

	// Catching up clears the stamp, so a later slip notices again.
	await t!.runtime.db.write((tx) =>
		tx.run(
			"INSERT INTO metric_readings (id, objective_id, name, at, value, source) VALUES (?, ?, 'weight', ?, 90, 'user')",
			t!.runtime.newId(),
			objective.id,
			t!.clock.now(),
		),
	);
	await t!.clock.settle();
	expect((await sweepObjectives(t!.runtime)).behind).toEqual([]);
	expect((await t!.runtime.db.get("SELECT behind_noticed_at FROM objectives WHERE id = ?", objective.id))).toEqual({ behind_noticed_at: null });

	// No due date is no pace: the infinite case reports nothing, and revisiting it names the date.
	const undated = await launched("Keep watching");
	expect((await sweepObjectives(t!.runtime)).behind).toEqual([]);
	expect((await view(undated.id)).dueAt).toBeNull();

	// An objective with a target and no reading has no baseline yet, so it has no pace.
	const readingless = await draft("Measure something", { dueAt: now + 7 * 24 * 60 * 60_000 });
	await t!.client.post(`/objectives/${readingless.id}/launch`);
	await settle();
	await t!.runtime.db.write((tx) =>
		tx.run(
			"INSERT INTO objective_metrics (objective_id, name, unit, direction, target, created_at) VALUES (?, 'sleep', 'hours', 'up', 8, ?)",
			readingless.id,
			t!.clock.now(),
		),
	);
	expect((await sweepObjectives(t!.runtime)).behind).toEqual([]);
	expect(await metricPaces(t!.runtime.db, { id: readingless.id, due_at: t!.clock.now() + 7 * 24 * 60 * 60_000 }, t!.clock.now())).toEqual([]);
});
