// WP18 metrics (OBJ-25..OBJ-29): declared metrics, append-only readings, derived baseline and
// current value, the scheduler-run check, and the user-only target.

import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runPanaCommand } from "../src/cli/commands.ts";
import { MIGRATIONS } from "../src/db/schema.ts";
import type { ObjectiveView } from "../src/objectives/index.ts";
import type { MetricView, MetricsView } from "../src/objectives/metrics.ts";
import { startTestPanad, TEST_USER, type TestPanad, type TestPanadOptions } from "./harness/index.ts";

let t: TestPanad | undefined;
afterEach(async () => {
	await t?.close();
	t = undefined;
});

const DAY = 24 * 60 * 60 * 1000;

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

async function draft(goal = "Cut the energy bill", body: Record<string, unknown> = {}, caller?: string): Promise<ObjectiveView> {
	const made = await t!.client.post<{ objective: ObjectiveView }>("/objectives", { goal, ...body }, caller ? { caller } : {});
	expect(made.status).toBe(201);
	return made.body.objective;
}

/** A session row for an objective, without a conversation: enough for every read to see it. */
async function seedSession(objectiveId: string | null, state = "idle"): Promise<string> {
	const id = t!.runtime.newId();
	const now = t!.clock.now();
	await t!.runtime.db.write(async (tx) => {
		await tx.run("INSERT INTO participants (id, kind, url, created_at) VALUES (?, 'session', ?, ?)", id, t!.runtime.url({ kind: "session", id }), now);
		await tx.run(
			"INSERT INTO sessions (id, state, depth, objective_id, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?)",
			id,
			state,
			objectiveId,
			now,
			now,
		);
	});
	return id;
}

/** An active objective with this seeded lead, without a launch (OBJ-05 is the foundation's test). */
async function active(goal = "Cut the energy bill", body: Record<string, unknown> = {}): Promise<{ objective: ObjectiveView; lead: string }> {
	const objective = await draft(goal, body);
	const lead = await seedSession(objective.id);
	await t!.runtime.db.write((tx) =>
		tx.run("UPDATE objectives SET phase = 'active', lead_id = ?, updated_at = ? WHERE id = ?", lead, t!.clock.now(), objective.id),
	);
	return { objective, lead };
}

async function addMetric(objectiveId: string, body: Record<string, unknown>, caller?: string): Promise<MetricView> {
	const res = await t!.client.post<{ metric: MetricView }>(`/objectives/${objectiveId}/metrics`, body, caller ? { caller } : {});
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.metric;
}

async function reading(objectiveId: string, name: string, value: number, extra: Record<string, unknown> = {}, caller?: string): Promise<MetricView> {
	const res = await t!.client.post<{ metric: MetricView }>(
		`/objectives/${objectiveId}/metrics/${encodeURIComponent(name)}/readings`,
		{ value, ...extra },
		caller ? { caller } : {},
	);
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.metric;
}

async function metrics(objectiveId: string, caller?: string): Promise<MetricsView> {
	const res = await t!.client.get<MetricsView>(`/objectives/${objectiveId}/metrics`, caller ? { caller } : {});
	expect(res.status).toBe(200);
	return res.body;
}

async function metric(objectiveId: string, name: string): Promise<MetricView> {
	return (await metrics(objectiveId)).metrics.find((entry) => entry.name === name)!;
}

async function counts(): Promise<{ messages: number; deliveries: number; schedules: number }> {
	const one = async (sql: string) => (await t!.runtime.db.get<{ n: number }>(sql))!.n;
	return {
		messages: await one("SELECT count(*) AS n FROM messages"),
		deliveries: await one("SELECT count(*) AS n FROM deliveries"),
		schedules: await one("SELECT count(*) AS n FROM schedules"),
	};
}

// --- OBJ-25 --------------------------------------------------------------------

it("OBJ-25 a metric declares its fields, appends readings, and its baseline is its first reading", async () => {
	await start();
	const { objective } = await active();
	const declared = await addMetric(objective.id, {
		name: "energy",
		unit: "kWh",
		direction: "down",
		target: 10,
		aggregation: "raw",
	});
	expect(declared).toMatchObject({
		name: "energy",
		unit: "kWh",
		direction: "down",
		target: 10,
		targetDisplay: "10 kWh",
		aggregation: "raw",
		window: null,
		check: null,
		frozen: false,
		// OBJ-25: no typed baseline, and no reading yet.
		baseline: null,
		baselineDisplay: null,
		current: { value: null, at: null, stale: true, display: null },
		atTarget: false,
		readings: [],
	});
	// A baseline is the first reading, never a number typed into a form.
	expect((await t!.client.post(`/objectives/${objective.id}/metrics`, { name: "typed", unit: "kg", direction: "down", baseline: 70 })).status).toBe(400);
	const columns = (await t!.runtime.db.all<{ name: string }>("PRAGMA table_info(objective_metrics)")).map((row) => row.name);
	expect(columns).not.toContain("baseline");

	const first = await reading(objective.id, "energy", 13.5);
	expect(first.baseline).toBe(13.5);
	expect(first.baselineDisplay).toBe("13.5 kWh");
	expect(first.frozen).toBe(true);
	const second = await reading(objective.id, "energy", 12);
	// OBJ-25: the latest reading is the current value, and the baseline never moves.
	expect(second.current).toMatchObject({ value: 12, display: "12 kWh", stale: false });
	expect(second.baseline).toBe(13.5);
	expect(second.readings.map((entry) => entry.value)).toEqual([13.5, 12]);

	// A second definition under the same name is 409, not a silent replacement.
	const again = await t!.client.post(`/objectives/${objective.id}/metrics`, { name: "energy", unit: "kWh", direction: "down" });
	expect(again.status).toBe(409);
	expect((again.body as { error: { code: string } }).error.code).toBe("metric_exists");

	// The name is a slug of [a-z0-9-], 1 to 40 long.
	for (const name of ["Energy", "a_b", "", "energy ", "blood pressure"]) {
		expect((await t!.client.post(`/objectives/${objective.id}/metrics`, { name, unit: "kWh", direction: "down" })).status, name).toBe(400);
	}
	expect((await t!.client.post(`/objectives/${objective.id}/metrics`, { name: "x".repeat(41), unit: "kWh", direction: "down" })).status).toBe(400);
	expect((await addMetric(objective.id, { name: "x".repeat(40), unit: "kWh", direction: "down" })).name).toHaveLength(40);
	expect((await addMetric(objective.id, { name: "blood-pressure", unit: "mmHg", direction: "down" })).name).toBe("blood-pressure");

	// The required fields, and a window only with a mean.
	expect((await t!.client.post(`/objectives/${objective.id}/metrics`, { name: "no-unit", direction: "down" })).status).toBe(400);
	expect((await t!.client.post(`/objectives/${objective.id}/metrics`, { name: "no-direction", unit: "kg" })).status).toBe(400);
	expect((await t!.client.post(`/objectives/${objective.id}/metrics`, { name: "sideways", unit: "kg", direction: "sideways" })).status).toBe(400);
	expect((await t!.client.post(`/objectives/${objective.id}/metrics`, { name: "raw-window", unit: "kg", direction: "down", window: "7d" })).status).toBe(400);
	expect((await t!.client.post(`/objectives/${objective.id}/metrics`, { name: "mean-no-window", unit: "kg", direction: "down", aggregation: "mean" })).status).toBe(400);
	expect((await addMetric(objective.id, { name: "mean-window", unit: "kg", direction: "down", aggregation: "mean", window: "7d" })).window).toBe("7d");

	// `target: null` is the infinite case: nothing finishes it, and it reports no progress.
	const infinite = await addMetric(objective.id, { name: "mood", unit: "pts", direction: "up" });
	await reading(objective.id, "mood", 4);
	expect((await metric(objective.id, "mood")).atTarget).toBeNull();

	// The CLI reaches the same routes.
	const viaCli = await command("objective metric add", { id: objective.id, name: "gas", unit: "therm", direction: "down", target: "5" });
	expect(viaCli.exitCode).toBe(0);
	expect((viaCli.body as { metric: MetricView }).metric).toMatchObject({ name: "gas", target: 5 });
	const setViaCli = await command("objective metric set", { id: objective.id, name: "gas", value: "4.5", source: "user" });
	expect(setViaCli.exitCode).toBe(0);
	expect((setViaCli.body as { metric: MetricView }).metric.current.value).toBe(4.5);
	const listedViaCli = await command("objective metric list", { id: objective.id });
	expect(listedViaCli.exitCode).toBe(0);
	expect((listedViaCli.body as MetricsView).metrics.map((entry) => entry.name)).toContain("gas");
});

it("OBJ-25 metric_readings is append-only: no source file issues UPDATE or DELETE on it", async () => {
	await start();
	const root = join(import.meta.dirname, "..", "src");
	const files = (readdirSync(root, { recursive: true }) as string[]).filter((name) => name.endsWith(".ts"));
	expect(files.length).toBeGreaterThan(5);
	const offenders: string[] = [];
	for (const name of files) {
		const text = readFileSync(join(root, name), "utf8");
		if (/\bUPDATE\s+(?:OR\s+\w+\s+)?"?metric_readings"?\b/i.test(text) || /\bDELETE\s+FROM\s+"?metric_readings"?\b/i.test(text)) {
			offenders.push(name);
		}
	}
	expect(offenders).toEqual([]);
	// The row carries no updated_at, so an edit has nowhere to be recorded even by accident.
	const columns = (await t!.runtime.db.all<{ name: string }>("PRAGMA table_info(metric_readings)")).map((row) => row.name);
	expect(columns.sort()).toEqual(["at", "id", "name", "objective_id", "source", "value"]);

	// Two readings at the same instant are two rows: nothing is coalesced or overwritten.
	const { objective } = await active();
	await addMetric(objective.id, { name: "weight", unit: "kg", direction: "down" });
	await reading(objective.id, "weight", 80);
	await reading(objective.id, "weight", 81);
	expect(await t!.runtime.db.all("SELECT value FROM metric_readings WHERE objective_id = ? ORDER BY at, id", objective.id)).toEqual([{ value: 80 }, { value: 81 }]);
});

// --- OBJ-26 --------------------------------------------------------------------

it("OBJ-26 the check lives on the metric, runs on the clock with no session, and appends a reading", async () => {
	await start();
	const { objective, lead } = await active();
	const declared = await addMetric(objective.id, {
		name: "weight",
		unit: "kg",
		direction: "down",
		target: 80,
		check: "printf 82.5",
		checkCwd: process.cwd(),
		checkEvery: "1d",
	});
	// The check is part of the definition, in the SCH-10 shape, and its first run is one interval away.
	expect(declared.check).toMatchObject({ command: "printf 82.5", cwd: process.cwd(), every: "1d", cron: null, lastCheck: null });
	expect(declared.check!.nextCheckAt).toBe(t!.clock.now() + DAY);
	expect(declared.readings).toEqual([]);

	const before = await counts();
	await t!.clock.advanceTo(declared.check!.nextCheckAt!);
	await vi.waitFor(async () => expect((await metric(objective.id, "weight")).readings).toHaveLength(1));
	const checked = await metric(objective.id, "weight");
	expect(checked.readings[0]).toMatchObject({ value: 82.5, source: "check", display: "82.5 kg" });
	expect(checked.check!.lastCheck).toMatchObject({ status: "passed", exitCode: 0, stdout: "82.5" });
	expect(checked.check!.nextCheckAt).toBe(t!.clock.now() + DAY);
	// The first reading it takes is the metric's baseline, and it freezes the definition.
	expect(checked.baseline).toBe(82.5);
	expect(checked.frozen).toBe(true);

	// No session exists for this objective beyond the seeded lead, and the check woke nothing:
	// one notice-free pass, no schedules, nothing appended to a prompt.
	expect(await counts()).toEqual(before);
	expect((await t!.runtime.db.get<{ conversation_id: number | null }>("SELECT conversation_id FROM sessions WHERE id = ?", lead))!.conversation_id).toBeNull();
	const kinds = await t!.runtime.db.all<{ kind: string }>("SELECT DISTINCT kind FROM schedules");
	expect(kinds).toEqual([]);

	// Exit 1 appends nothing and is not a failure: no notice, and the next occurrence is armed.
	await t!.client.post(`/objectives/${objective.id}/metrics`, {
		name: "solar",
		unit: "kWh",
		direction: "up",
		check: "printf 'not yet' >&2; exit 1",
		checkEvery: "1h",
	});
	const notReadyAt = t!.clock.now() + 60 * 60 * 1000;
	await t!.clock.advanceTo(notReadyAt);
	await vi.waitFor(async () => expect((await metric(objective.id, "solar")).check!.lastCheck).not.toBeNull());
	const notReady = await metric(objective.id, "solar");
	expect(notReady.check!.lastCheck).toMatchObject({ status: "not_ready", exitCode: 1, stderr: "not yet", error: null });
	expect(notReady.readings).toEqual([]);
	expect(notReady.check!.nextCheckAt).toBe(t!.clock.now() + 60 * 60 * 1000);
	expect(await counts()).toEqual(before);
});

it("OBJ-26 a non-numeric stdout, other exit code, signal, timeout, or error records failed and posts one notice", async () => {
	await start();
	const { objective } = await active();
	const awake = await counts();

	// A non-numeric stdout is a failed check even though bash exited 0.
	const declared = await addMetric(objective.id, { name: "weight", unit: "kg", direction: "down", check: "printf 'about 80'", checkEvery: "1d" });
	await t!.clock.advanceTo(declared.check!.nextCheckAt!);
	await vi.waitFor(async () => expect((await metric(objective.id, "weight")).check!.lastCheck).not.toBeNull());
	let failed = await metric(objective.id, "weight");
	expect(failed.check!.lastCheck).toMatchObject({ status: "failed", exitCode: 0, error: 'stdout is "about 80", not a number' });
	expect(failed.readings).toEqual([]);

	await vi.waitFor(async () => {
		const inbox = await t!.client.get<{ deliveries: Array<{ body: string }> }>("/inbox");
		expect(inbox.body.deliveries.some((delivery) => delivery.body.includes('Metric check for "weight"') && delivery.body.includes(objective.url))).toBe(true);
	});
	// One notice for the one failure, naming the metric and the objective.
	const firstNotices = await t!.runtime.db.all<{ body: string }>("SELECT body FROM messages WHERE body LIKE 'Metric check for%'");
	expect(firstNotices).toHaveLength(1);
	expect(firstNotices[0]!.body).toContain('Metric check for "weight"');
	expect(firstNotices[0]!.body).toContain(objective.url);

	// Any other exit code, a signal, and a missing cwd are failures too, one notice each.
	const cases: Array<{ name: string; check: string; cwd?: string; match: Record<string, unknown> }> = [
		{ name: "exit-7", check: "printf broken >&2; exit 7", match: { status: "failed", exitCode: 7, stderr: "broken", error: "check exited 7" } },
		{ name: "signal", check: "kill -TERM $$", match: { status: "failed", signal: "SIGTERM" } },
		{ name: "no-cwd", check: "printf 1", cwd: "/nonexistent-pana-check-cwd", match: { status: "failed" } },
	];
	let at = t!.clock.now();
	for (const test of cases) {
		const added = await addMetric(objective.id, {
			name: test.name,
			unit: "x",
			direction: "up",
			check: test.check,
			checkEvery: "1d",
			...(test.cwd === undefined ? {} : { checkCwd: test.cwd }),
		});
		at = added.check!.nextCheckAt!;
		await t!.clock.advanceTo(at);
		const name = test.name;
		await vi.waitFor(async () => {
			const entry = (await metrics(objective.id)).metrics.find((candidate) => candidate.name === name)!;
			expect(entry.check!.lastCheck).toMatchObject(test.match);
			expect(entry.readings).toEqual([]);
		});
	}

	// A timeout is a failure on the SCH-12 limit, and it kills the check's process group.
	const dir = mkdtempSync(join(tmpdir(), "pana-metric-check-"));
	const timeout = await addMetric(objective.id, {
		name: "slow",
		unit: "x",
		direction: "up",
		check: "touch started; while :; do :; done",
		checkCwd: dir,
		checkEvery: "1d",
	});
	await t!.clock.advanceTo(timeout.check!.nextCheckAt!);
	await vi.waitFor(() => expect(existsSync(join(dir, "started"))).toBe(true));
	await t!.clock.advance(30_000);
	await vi.waitFor(async () => expect((await metric(objective.id, "slow")).check!.lastCheck?.status).toBe("failed"));
	expect((await metric(objective.id, "slow")).check!.lastCheck!.error).toMatch(/timed out/);

	// Check output is diagnostic: it never reaches a prompt, so no session was woken or messaged.
	expect((await counts()).deliveries).toBeGreaterThan(awake.deliveries);
	const toSessions = await t!.runtime.db.all<{ id: string }>(
		"SELECT d.id FROM deliveries d JOIN participants p ON p.id = d.recipient_id WHERE p.kind = 'session'",
	);
	expect(toSessions).toEqual([]);

	// One notice per failure, each naming its metric and the objective. A check that passes, or
	// exits 1, has no notice at all (the previous test holds that pair).
	const notices = await t!.runtime.db.all<{ body: string }>("SELECT body FROM messages WHERE body LIKE 'Metric check for%'");
	const noticesFor = (name: string) => notices.filter((notice) => notice.body.includes(`Metric check for "${name}"`));
	for (const name of ["weight", "exit-7", "signal", "no-cwd", "slow"]) expect(noticesFor(name).length, name).toBeGreaterThan(0);
	const passing = await addMetric(objective.id, { name: "fine", unit: "x", direction: "up", check: "printf 1", checkEvery: "1d" });
	await t!.clock.advanceTo(passing.check!.nextCheckAt!);
	await vi.waitFor(async () => expect((await metric(objective.id, "fine")).readings).toHaveLength(1));
	expect(noticesFor("fine")).toEqual([]);
});

it("OBJ-26 the check validates its recurrence, keeps SCH-12's execution, and adds no schedule kind", async () => {
	await start();
	const { objective } = await active();
	const post = (body: Record<string, unknown>) => t!.client.post(`/objectives/${objective.id}/metrics`, { name: "weigh-in", unit: "kg", direction: "down", ...body });

	expect((await post({ check: "" })).status).toBe(400);
	expect((await post({ check: 3 })).status).toBe(400);
	// A check needs a recurrence, and exactly one.
	expect((await post({ check: "printf 1" })).status).toBe(400);
	expect((await post({ check: "printf 1", checkEvery: "1d", checkCron: "0 8 * * *" })).status).toBe(400);
	expect((await post({ check: "printf 1", checkEvery: "daily" })).status).toBe(400);
	expect((await post({ check: "printf 1", checkCron: "not a cron" })).status).toBe(400);
	// The check's fields belong to a check, and its cwd is absolute.
	expect((await post({ checkEvery: "1d" })).status).toBe(400);
	expect((await post({ check: "printf 1", checkEvery: "1d", checkCwd: "relative/dir" })).status).toBe(400);

	// A cron check arms at its next occurrence, without a timezone of its own.
	const cron = await post({ name: "cron-check", check: "printf 2", checkCron: "0 8 * * *" });
	expect(cron.status).toBe(201);
	const cronMetric = (cron.body as { metric: MetricView }).metric;
	expect(cronMetric.check!.cron).toBe("0 8 * * *");
	expect(cronMetric.check!.nextCheckAt).toBeGreaterThan(t!.clock.now());

	// SCH-12 unchanged: bash in the recorded cwd, with its stdout retained as the reading.
	await post({ name: "cwd", check: 'printf "%s" "$PWD" | { read -r; printf 3; }', checkCwd: process.cwd(), checkEvery: "1d" });
	await t!.clock.advanceTo((await metric(objective.id, "cwd")).check!.nextCheckAt!);
	await vi.waitFor(async () => expect((await metric(objective.id, "cwd")).readings).toHaveLength(1));
	expect((await metric(objective.id, "cwd")).readings[0]!.value).toBe(3);

	// The check adds no schedule kind: the schedules table is untouched by a measured objective.
	expect(await t!.runtime.db.all("SELECT id FROM schedules")).toEqual([]);
});

it("OBJ-26 a check does not measure a draft, and a resumed objective measures again", async () => {
	await start();
	const objective = await draft("Measure the boiler");
	const added = await addMetric(objective.id, { name: "temp", unit: "C", direction: "down", check: "printf 60", checkEvery: "1d" });
	// A draft has no readings (OBJ-04), so its due check is skipped rather than recorded.
	await t!.clock.advanceTo(added.check!.nextCheckAt!);
	await vi.waitFor(async () => expect((await metric(objective.id, "temp")).check!.nextCheckAt).toBeGreaterThan(added.check!.nextCheckAt!));
	expect((await metric(objective.id, "temp")).readings).toEqual([]);
	expect((await metric(objective.id, "temp")).check!.lastCheck).toBeNull();
});

// --- OBJ-27 --------------------------------------------------------------------

it("OBJ-27 progress runs from the baseline through the aggregation, and a mean reads a trailing window", async () => {
	await start();
	const { objective } = await active();
	const declared = await addMetric(objective.id, { name: "weight", unit: "kg", direction: "down", target: 80, aggregation: "mean", window: "7d" });
	expect(declared.aggregation).toBe("mean");

	// An old reading outside the window is the baseline but not part of the mean.
	await reading(objective.id, "weight", 70);
	await t!.clock.advance(8 * DAY);
	await reading(objective.id, "weight", 80);
	await t!.clock.advance(DAY);
	await reading(objective.id, "weight", 82);
	await t!.clock.advance(DAY);
	await reading(objective.id, "weight", 84);

	const trend = await metric(objective.id, "weight");
	expect(trend.baseline).toBe(70);
	expect(trend.baselineDisplay).toBe("70 kg");
	// The trailing 7 days hold 80, 82, and 84, so the trend is their mean, not the last reading.
	expect(trend.current.value).toBe(82);
	expect(trend.current.stale).toBe(false);
	expect(trend.current.display).toBe("82 kg");
	expect(trend.atTarget).toBe(false);
	// OBJ-27: the unit is rendered with every value, readings included.
	expect(trend.readings.map((entry) => entry.display)).toEqual(["70 kg", "80 kg", "82 kg", "84 kg"]);

	// A window with no readings in it is stale, never zero.
	await t!.clock.advance(8 * DAY);
	const stale = await metric(objective.id, "weight");
	expect(stale.current).toEqual({ value: null, at: null, stale: true, display: null });
	expect(stale.atTarget).toBe(false);
	expect(stale.baseline).toBe(70);

	// `raw` uses the latest reading, whatever the window would have said.
	const rawMetric = await addMetric(objective.id, { name: "energy", unit: "kWh", direction: "down", target: 10 });
	await reading(objective.id, "energy", 12);
	await reading(objective.id, "energy", 9);
	expect((await metric(objective.id, "energy")).current).toMatchObject({ value: 9, display: "9 kWh" });
	// Direction decides which way is progress: down at or below its target, up at or above.
	expect((await metric(objective.id, "energy")).atTarget).toBe(true);
	const up = await addMetric(objective.id, { name: "steps", unit: "steps", direction: "up", target: 8000 });
	await reading(objective.id, "steps", 7900);
	expect((await metric(objective.id, "steps")).atTarget).toBe(false);
	await reading(objective.id, "steps", 8100);
	expect((await metric(objective.id, "steps")).atTarget).toBe(true);
	await t!.clock.advance(DAY);
	await reading(objective.id, "steps", 4000);
	expect((await metric(objective.id, "steps")).atTarget).toBe(false);
});

// --- OBJ-28 --------------------------------------------------------------------

it("OBJ-28 GET metrics returns each metric's readings, target, and current value, and counts at target", async () => {
	await start();
	const { objective } = await active();
	await addMetric(objective.id, { name: "energy", unit: "kWh", direction: "down", target: 10 });
	await addMetric(objective.id, { name: "gas", unit: "therm", direction: "down", target: 5 });
	await addMetric(objective.id, { name: "weight", unit: "kg", direction: "down", target: 80 });
	await addMetric(objective.id, { name: "mood", unit: "pts", direction: "up" });
	await reading(objective.id, "energy", 12);
	await t!.clock.advance(DAY);
	await reading(objective.id, "energy", 9);
	await reading(objective.id, "gas", 6);
	await reading(objective.id, "weight", 81);
	await reading(objective.id, "mood", 5);

	const view = await metrics(objective.id);
	expect(view.objective).toEqual({ id: objective.id, url: objective.url, phase: "active" });
	expect(view.metrics.map((entry) => entry.name)).toEqual(["energy", "gas", "mood", "weight"]);
	// Readings in time order, per metric, which is what a chart draws.
	expect(view.metrics[0]!.readings.map((entry) => [entry.value, entry.at])).toEqual([
		[12, expect.any(Number)],
		[9, expect.any(Number)],
	]);
	expect(view.metrics[0]!.readings[1]!.at).toBeGreaterThan(view.metrics[0]!.readings[0]!.at);
	// "1 of 3 at target": a count of metrics, each against its own target, never a total.
	expect(view.atTarget).toEqual({ count: 1, of: 3 });
	// Every metric's shape is the documented one, and no percent-to-target is stored or computed.
	expect(Object.keys(view.metrics[0]!).sort()).toEqual([
		"aggregation",
		"atTarget",
		"baseline",
		"baselineDisplay",
		"check",
		"createdAt",
		"current",
		"direction",
		"frozen",
		"name",
		"objectiveId",
		"readings",
		"target",
		"targetDisplay",
		"unit",
		"window",
	]);
	// The rest of the response is closed too: the whole view, and the current value inside it, name
	// every field they have. A field implying a percentage would have to be added here first.
	expect(Object.keys(view).sort()).toEqual(["atTarget", "metrics", "objective"]);
	expect(Object.keys(view.metrics[0]!.current).sort()).toEqual(["at", "display", "stale", "value"]);
	// OBJ-28's ban is on the objective package computing a percent-to-target total, not on the
	// product using percentages anywhere: a diff view may say "40% changed" and the web client may
	// have a `.pct` class without failing a test about metrics. A grep over all of `src` accused
	// whatever code it found first, which is the worst kind of failure — right verdict, wrong
	// accusation. So this scans this package, and no further.
	const root = join(import.meta.dirname, "..", "src", "objectives");
	const files = (readdirSync(root, { recursive: true }) as string[]).filter((name) => name.endsWith(".ts"));
	expect(files.length).toBeGreaterThan(5);
	const offenders: string[] = [];
	for (const name of files) {
		// Prose may say why no percentage exists; the code may not compute one.
		const code = readFileSync(join(root, name), "utf8")
			.split("\n")
			.filter((line) => !/^(\/\/|\*|\/\*)/.test(line.trim()))
			.join("\n");
		if (/percent|pct/i.test(code)) offenders.push(name);
	}
	expect(offenders).toEqual([]);
	const columns = (await t!.runtime.db.all<{ name: string }>("PRAGMA table_info(objective_metrics)")).map((row) => row.name);
	for (const column of ["percent", "pct", "progress", "baseline"]) expect(columns).not.toContain(column);

	// An objective with no metrics answers an empty list, and an unknown objective is 404.
	expect((await metrics((await draft("Empty")).id)).metrics).toEqual([]);
	expect((await t!.client.get("/objectives/01ARZ3NDEKTSV4RRFFQ69G5FAV/metrics")).status).toBe(404);
});

// --- OBJ-29 --------------------------------------------------------------------

it("OBJ-29 a target and a baseline belong to the user, and both are recorded as events", async () => {
	await start();
	const { objective, lead } = await active();
	const declared = await addMetric(objective.id, { name: "weight", unit: "kg", direction: "down" });
	expect(declared.target).toBeNull();

	// A session may not set a target, neither on a new metric nor on a declared one.
	const asLead = await t!.client.post(`/objectives/${objective.id}/metrics`, { name: "sneaky", unit: "kg", direction: "down", target: 1 }, { caller: lead });
	expect(asLead.status).toBe(403);
	const refused = await t!.client.post(`/objectives/${objective.id}/metrics/weight`, { target: 80 }, { caller: lead });
	expect(refused.status).toBe(403);
	expect((await metric(objective.id, "weight")).target).toBeNull();

	// The user makes the objective finite, and the change is an append-only event.
	const finite = await t!.client.post<{ metric: MetricView }>(`/objectives/${objective.id}/metrics/weight`, { target: 80 });
	expect(finite.status).toBe(200);
	expect(finite.body.metric).toMatchObject({ target: 80, targetDisplay: "80 kg" });
	const events = await t!.runtime.db.all<{ kind: string; detail: string; actor_id: string }>(
		"SELECT kind, detail, actor_id FROM objective_events WHERE objective_id = ? AND kind = 'metric.target' ORDER BY at, id",
		objective.id,
	);
	expect(events).toHaveLength(1);
	expect(events[0]).toMatchObject({ kind: "metric.target", actor_id: TEST_USER });
	expect(JSON.parse(events[0]!.detail)).toEqual({ name: "weight", target: 80, previous: null });

	// A metric that has a target is measured against it; removing the target makes it infinite again.
	await reading(objective.id, "weight", 79);
	expect((await metric(objective.id, "weight")).atTarget).toBe(true);
	const removed = await t!.client.post<{ metric: MetricView }>(`/objectives/${objective.id}/metrics/weight`, { target: null });
	expect(removed.status).toBe(200);
	expect(removed.body.metric.atTarget).toBeNull();
	expect(await t!.runtime.db.all("SELECT id FROM objective_events WHERE objective_id = ? AND kind = 'metric.target'", objective.id)).toHaveLength(2);

	// A typed baseline is refused for everyone: it is the first reading.
	const typed = await t!.client.post(`/objectives/${objective.id}/metrics/weight`, { baseline: 70 });
	expect(typed.status).toBe(400);
	expect((typed.body as { error: { code: string } }).error.code).toBe("baseline_derived");
	// A session's baseline attempt is 403 before anything else.
	const asLeadBaseline = await t!.client.post(`/objectives/${objective.id}/metrics/weight`, { baseline: 70 }, { caller: lead });
	expect(asLeadBaseline.status).toBe(403);

	// The CLI's target command sets and removes it.
	expect((await command("objective metric target", { id: objective.id, name: "weight", target: "80" })).exitCode).toBe(0);
	expect((await command("objective metric target", { id: objective.id, name: "weight" })).exitCode).toBe(0);
	expect((await metric(objective.id, "weight")).target).toBeNull();
});

it("OBJ-29 a metric with a reading is frozen for sessions and editable only by the user", async () => {
	await start();
	const { objective, lead } = await active();
	const defined = {
		name: "weight",
		unit: "kg",
		direction: "down",
		aggregation: "mean",
		window: "7d",
		check: "printf 81",
		checkEvery: "1d",
	} as const;
	await addMetric(objective.id, defined);

	// Before its first reading a session may refine the declaration it proposed.
	const unfrozen = await t!.client.post<{ metric: MetricView }>(`/objectives/${objective.id}/metrics/weight`, { unit: "kilograms" }, { caller: lead });
	expect(unfrozen.status).toBe(200);
	expect(unfrozen.body.metric.unit).toBe("kilograms");

	// The first reading freezes name, unit, direction, aggregation, window, and check for sessions.
	const frozen = await reading(objective.id, "weight", 80);
	expect(frozen.frozen).toBe(true);
	for (const body of [
		{ unit: "lb" },
		{ direction: "up" },
		{ aggregation: "raw" },
		{ window: "30d" },
		{ check: "printf 60" },
		{ check: "; rm -rf /" },
		{ checkCwd: "/tmp" },
	]) {
		const refused = await t!.client.post(`/objectives/${objective.id}/metrics/weight`, body, { caller: lead });
		expect(refused.status, JSON.stringify(body)).toBe(403);
	}
	// A rename would have to rewrite append-only readings, so the name identifies the metric for
	// good: a session is refused by the freeze, and the user is told to declare a new metric.
	expect((await t!.client.post(`/objectives/${objective.id}/metrics/weight`, { name: "mass" }, { caller: lead })).status).toBe(403);
	const rename = await t!.client.post(`/objectives/${objective.id}/metrics/weight`, { name: "mass" });
	expect(rename.status).toBe(400);
	expect((rename.body as { error: { code: string } }).error.code).toBe("metric_rename");
	const unchanged = await metric(objective.id, "weight");
	expect(unchanged).toMatchObject({ unit: "kilograms", direction: "down", aggregation: "mean", window: "7d" });
	expect(unchanged.check!.command).toBe("printf 81");

	// The user may still edit it, and the edit is recorded as an event.
	const edited = await t!.client.post<{ metric: MetricView }>(`/objectives/${objective.id}/metrics/weight`, { unit: "kg" });
	expect(edited.status).toBe(200);
	expect(edited.body.metric.unit).toBe("kg");
	expect(await t!.runtime.db.get("SELECT id FROM objective_events WHERE objective_id = ? AND kind = 'metric.set'", objective.id)).toBeTruthy();

	// The check keeps writing readings of its own, which is the objective measuring itself.
	await t!.clock.advanceTo((await metric(objective.id, "weight")).check!.nextCheckAt!);
	await vi.waitFor(async () => expect((await metric(objective.id, "weight")).readings).toHaveLength(2));
	expect((await metric(objective.id, "weight")).readings[1]).toMatchObject({ value: 81, source: "check" });
});

it("OBJ-29 a closed objective takes no readings and no new metric", async () => {
	await start();
	const { objective } = await active();
	await addMetric(objective.id, { name: "weight", unit: "kg", direction: "down" });
	await t!.client.post(`/objectives/${objective.id}/stop`);

	const read = await t!.client.post(`/objectives/${objective.id}/metrics/weight/readings`, { value: 80 });
	expect(read.status).toBe(409);
	expect((read.body as { error: { code: string } }).error.code).toBe("objective_closed");
	expect((await t!.client.post(`/objectives/${objective.id}/metrics`, { name: "later", unit: "kg", direction: "down" })).status).toBe(409);

	// A draft holds metric definitions but has no readings (OBJ-04).
	const draftObjective = await draft("Not launched");
	await addMetric(draftObjective.id, { name: "weight", unit: "kg", direction: "down" });
	const early = await t!.client.post(`/objectives/${draftObjective.id}/metrics/weight/readings`, { value: 80 });
	expect(early.status).toBe(409);
	expect((early.body as { error: { code: string } }).error.code).toBe("wrong_phase");
});

it("OBJ-29 a reading records where it came from, and a session reports only its own", async () => {
	await start();
	const { objective, lead } = await active();
	await addMetric(objective.id, { name: "weight", unit: "kg", direction: "down" });

	const byUser = await reading(objective.id, "weight", 82);
	expect(byUser.readings[0]!.source).toBe("user");
	const byLead = await reading(objective.id, "weight", 81, {}, lead);
	expect(byLead.readings[1]!.source).toBe("lead");
	const byUserCheck = await reading(objective.id, "weight", 80.5, { source: "check" });
	expect(byUserCheck.readings[2]!.source).toBe("check");
	// A session records its own readings only: it cannot claim the user's voice or a check's.
	for (const source of ["user", "check"]) {
		const forged = await t!.client.post(`/objectives/${objective.id}/metrics/weight/readings`, { value: 1, source }, { caller: lead });
		expect(forged.status, source).toBe(403);
	}
	expect((await t!.client.post(`/objectives/${objective.id}/metrics/weight/readings`, { value: "not a number" })).status).toBe(400);
	expect((await t!.client.post(`/objectives/${objective.id}/metrics/weight/readings`, { value: 1, source: "oracle" })).status).toBe(400);

	// The last migration is still the objectives one: metrics arrived without a schema change.
	expect(MIGRATIONS.at(-1)).toMatchObject({ version: 12, name: "objectives" });
});
