// WP18 foundation: the objectives schema, identity, launch, lifecycle gates, and route surface
// (OBJ-01..OBJ-05, OBJ-07, OBJ-17, OBJ-38). The packages that build on this one add their own tests here.

import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { matchRoute, ROUTES } from "../src/api/routes.ts";
import { COMMANDS, runPanaCommand } from "../src/cli/commands.ts";
import { renderHelp } from "../src/cli/help.ts";
import { main, type CliIo } from "../src/cli/index.ts";
import { MIGRATIONS, SCHEMA_VERSION } from "../src/db/schema.ts";
import { SimulatedCrash } from "../src/db/index.ts";
import { formatUrl, parseRef } from "../src/ids/index.ts";
import { OBJECTIVE_COMMANDS } from "../src/objectives/cli.ts";
import { admitRun, launchObjective, objectiveConditions, objectiveRow, sweepObjectives, type ObjectiveView } from "../src/objectives/index.ts";
import { dayStart, nextDayStart, recordCost } from "../src/sessions/budget.ts";
import { sessionRuntime } from "../src/sessions/index.ts";
import { FAKE_EPOCH, startTestPanad, TEST_USER, type TestPanad, type TestPanadOptions } from "./harness/index.ts";

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

async function runCli(argv: string[]): Promise<{ code: number; stdout: string }> {
	let stdout = "";
	const io: Partial<CliIo> = {
		env: { PANA_STATE: t?.dir ?? "/nonexistent" },
		stdin: Readable.from([]),
		stdout: { write: (chunk) => (stdout += chunk), isTTY: true },
		stderr: { write: () => {}, isTTY: true },
	};
	const code = await main(argv, io);
	return { code, stdout };
}

async function draft(goal = "Cut the energy bill", body: Record<string, unknown> = {}, caller?: string): Promise<ObjectiveView> {
	const made = await t!.client.post<{ objective: ObjectiveView }>("/objectives", { goal, ...body }, caller ? { caller } : {});
	expect(made.status).toBe(201);
	return made.body.objective;
}

/** A session row for an objective, without a conversation: enough for every read to see it. */
async function seedSession(objectiveId: string | null, state = "idle", holdUntil: number | null = null): Promise<string> {
	const id = t!.runtime.newId();
	const now = t!.clock.now();
	await t!.runtime.db.write(async (tx) => {
		await tx.run("INSERT INTO participants (id, kind, url, created_at) VALUES (?, 'session', ?, ?)", id, t!.runtime.url({ kind: "session", id }), now);
		await tx.run(
			"INSERT INTO sessions (id, state, depth, objective_id, hold_until, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?, ?)",
			id,
			state,
			objectiveId,
			holdUntil,
			now,
			now,
		);
	});
	return id;
}

/** Make a seeded objective active with this lead, without a launch. */
async function activate(objectiveId: string, leadId: string): Promise<void> {
	await t!.runtime.db.write((tx) =>
		tx.run("UPDATE objectives SET phase = 'active', lead_id = ?, updated_at = ? WHERE id = ?", leadId, t!.clock.now(), objectiveId),
	);
}

async function view(id: string): Promise<ObjectiveView> {
	const res = await t!.client.get<{ objective: ObjectiveView }>(`/objectives/${id}`);
	expect(res.status).toBe(200);
	return res.body.objective;
}

async function counts(): Promise<{ messages: number; deliveries: number; schedules: number; sessions: number }> {
	const one = async (sql: string) => (await t!.runtime.db.get<{ n: number }>(sql))!.n;
	return {
		messages: await one("SELECT count(*) AS n FROM messages"),
		deliveries: await one("SELECT count(*) AS n FROM deliveries"),
		schedules: await one("SELECT count(*) AS n FROM schedules"),
		sessions: await one("SELECT count(*) AS n FROM sessions"),
	};
}

/** Settle every run and every queued session job. */
async function settle(): Promise<void> {
	await t!.runtime.harness.waitForIdle(ctx);
	await sessionRuntime(t!.runtime).idle();
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

// --- OBJ-01 --------------------------------------------------------------------

it("OBJ-01 an objective is an identity with a pana:// URL that parseRef and formatUrl round-trip", async () => {
	await start();
	const id = t!.runtime.newId();
	const url = `pana://test.example/objectives/${id}`;
	expect(formatUrl({ kind: "objective", id }, "test.example")).toBe(url);
	expect(parseRef(url, "test.example")).toEqual({ kind: "objective", id });
	expect(parseRef(url)).toEqual({ kind: "objective", id });
	expect(() => parseRef(url, "other.example")).toThrow(/not other\.example/);

	const made = await t!.client.post<{ objective: ObjectiveView }>("/objectives", { goal: "Cut the energy bill" });
	expect(made.status).toBe(201);
	const objective = made.body.objective;
	expect(objective.phase).toBe("drafting");
	expect(objective.goal).toBe("Cut the energy bill");
	expect(objective.url).toBe(`pana://test.example/objectives/${objective.id}`);
	expect(objective.creator).toEqual({ id: TEST_USER, url: `pana://test.example/users/${TEST_USER}` });
	expect(parseRef(objective.url, "test.example")).toEqual({ kind: "objective", id: objective.id });

	// The CLI reaches the same routes, by ID and by URL.
	const shown = await command("objective show", { id: objective.url });
	expect(shown.exitCode).toBe(0);
	expect((shown.body as { objective: ObjectiveView }).objective.id).toBe(objective.id);
	const viaId = await command("objective show", { id: objective.id });
	expect((viaId.body as { objective: ObjectiveView }).objective.goal).toBe("Cut the energy bill");

	expect((await t!.client.post("/objectives", { goal: "   " })).status).toBe(400);
	const missing = await command("objective create", {});
	expect(missing.exitCode).toBe(2);
});

it("OBJ-01 listing filters by phase and creator and pages with limit and cursor", async () => {
	await start();
	for (const goal of ["one", "two", "three"]) await draft(goal);
	const made = await t!.client.post<{ objective: ObjectiveView }>("/objectives", { goal: "proposed" }, { caller: await seedSession(null) });
	expect(made.status).toBe(201);
	const proposed = made.body.objective;

	const first = await t!.client.get<{ objectives: ObjectiveView[]; nextCursor: string | null }>("/objectives?limit=2");
	expect(first.status).toBe(200);
	const listed = first.body.objectives;
	expect(listed).toHaveLength(2);
	expect(first.body.nextCursor).toBeTruthy();
	const second = await t!.client.get<{ objectives: ObjectiveView[]; nextCursor: string | null }>(
		`/objectives?limit=2&cursor=${encodeURIComponent(first.body.nextCursor!)}`,
	);
	expect(second.body.objectives).toHaveLength(2);
	const seen = [...listed, ...second.body.objectives].map((objective) => objective.id);
	expect(new Set(seen).size).toBe(4);
	expect(second.body.nextCursor).toBeNull();

	const byCreator = await t!.client.get<{ objectives: ObjectiveView[] }>(`/objectives?creator=${proposed.proposedBy!.id}`);
	expect(byCreator.body.objectives.map((objective) => objective.id)).toEqual([proposed.id]);
	const byPhase = await t!.client.get<{ objectives: ObjectiveView[] }>("/objectives?phase=drafting");
	expect(byPhase.body.objectives).toHaveLength(4);
	expect((await t!.client.get("/objectives?phase=imaginary")).status).toBe(400);
	expect((await t!.client.get("/objectives?limit=0")).status).toBe(400);

	const listed_cli = await command("objective list", { limit: "3" });
	expect(listed_cli.exitCode).toBe(0);
	expect((listed_cli.body as { objectives: ObjectiveView[] }).objectives).toHaveLength(3);
});

// --- OBJ-02 --------------------------------------------------------------------

const OBJECTIVE_TABLES = [
	"objectives",
	"objective_charter_revisions",
	"objective_metrics",
	"metric_readings",
	"objective_reports",
	"objective_files",
	"objective_events",
	"objective_escalations",
	"objective_costs",
];

it("OBJ-02 one migration at the end of MIGRATIONS adds every table the package needs", async () => {
	await start();
	const tables = (await t!.runtime.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")).map((row) => row.name);
	for (const table of OBJECTIVE_TABLES) expect(tables, table).toContain(table);

	const columns = async (table: string) =>
		(await t!.runtime.db.all<{ name: string }>(`PRAGMA table_info(${table})`)).map((row) => row.name);
	const objectives = await columns("objectives");
	for (const column of [
		"id",
		"goal",
		"phase",
		"creator_id",
		"proposed_by",
		"lead_id",
		"thread_id",
		"due_at",
		"autonomy",
		"max_daily_usd",
		"max_total_usd",
		"wake_min_minutes",
		"max_daily_lead_turns",
		"max_daily_user_messages",
		"max_active_members",
		"charter_rev",
		"created_at",
		"updated_at",
	]) {
		expect(objectives, column).toContain(column);
	}
	for (const column of ["objective_id", "stopped_by", "hold_until"]) expect(await columns("sessions"), column).toContain(column);
	for (const column of ["objective_id", "rev", "section", "body", "created_by", "created_at"]) {
		expect(await columns("objective_charter_revisions"), column).toContain(column);
	}
	for (const column of ["objective_id", "name", "unit", "direction", "target", "aggregation", "window_spec", "check_command", "check_cwd", "check_every", "check_cron", "next_check_at", "last_check", "frozen_at", "created_at"]) {
		expect(await columns("objective_metrics"), column).toContain(column);
	}
	for (const column of ["id", "objective_id", "name", "at", "value", "source"]) expect(await columns("metric_readings"), column).toContain(column);
	for (const column of ["objective_id", "message_id", "created_at"]) expect(await columns("objective_reports"), column).toContain(column);
	for (const column of ["objective_id", "file_id", "created_at"]) expect(await columns("objective_files"), column).toContain(column);
	for (const column of ["id", "objective_id", "at", "kind", "detail", "actor_id"]) expect(await columns("objective_events"), column).toContain(column);
	for (const column of ["id", "objective_id", "member_id", "thread_id", "message_id", "state", "timeout_at", "cleared_at", "created_at"]) {
		expect(await columns("objective_escalations"), column).toContain(column);
	}

	// It is the last migration, numbered, and the schema version follows it.
	const last = MIGRATIONS.at(-1)!;
	expect(last).toMatchObject({ version: 12, name: "objectives" });
	expect(SCHEMA_VERSION).toBe(12);
	expect(MIGRATIONS.map((migration) => migration.version)).toEqual(MIGRATIONS.map((_, index) => index + 1));

	// A database newer than the code still refuses to open (DB-03 holds for this version).
	await t!.runtime.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
	await t!.stop();
	await expect(startTestPanad({ stateDir: t!.dir })).rejects.toThrow(/newer than this build/);
	t = undefined;
});

it("OBJ-02 the migration leaves existing rows alone", async () => {
	const probe = await start();
	const thread = await probe.client.post<{ thread: { id: string } }>("/threads", { to: [], body: "before the migration" });
	const before = await probe.runtime.db.all("SELECT * FROM messages");
	await probe.stop();

	t = await start({ stateDir: probe.dir });
	expect(await t.runtime.db.all("SELECT * FROM messages")).toEqual(before);
	expect(await t.runtime.db.get("SELECT id FROM threads WHERE id = ?", thread.body.thread.id)).toEqual({ id: thread.body.thread.id });
});

it("OBJ-02 objective defaults live in config like every other default", async () => {
	const probe = await start();
	expect(probe.runtime.config.objectives).toEqual({ maxMembersPerRun: 8, maxDailyUserMessages: 10, wakeMinMinutes: 5 });
	await probe.stop();

	await probe.close();
	t = await start({ config: { objectives: { maxMembersPerRun: 3, wakeMinMinutes: 15 } } });
	expect(t.runtime.config.objectives.maxMembersPerRun).toBe(3);
	expect(t.runtime.config.objectives.wakeMinMinutes).toBe(15);
	expect(t.runtime.config.objectives.maxDailyUserMessages).toBe(10);
});

// --- OBJ-03 --------------------------------------------------------------------

it("OBJ-03 the display state is derived on read: running, idle, stranded, and never stored", async () => {
	await start();
	const objective = await draft("Watch the meter");
	const lead = await seedSession(objective.id);
	await activate(objective.id, lead);
	expect((await view(objective.id)).state).toBe("stranded");

	const member = await seedSession(objective.id, "running");
	expect((await view(objective.id)).state).toBe("running");
	await t!.runtime.db.write((tx) => tx.run("UPDATE sessions SET state = 'idle' WHERE id = ?", member));

	// A pending wake for a member, including the lead's hold (OBJ-18), reads as idle.
	const wake = await t!.client.post<{ schedule: { id: string } }>("/schedules", { kind: "wake", session: member, in: "1h", note: "Check the meter." });
	expect(wake.status).toBe(201);
	expect((await view(objective.id)).state).toBe("idle");
	await t!.client.delete(`/schedules/${wake.body.schedule.id}`);
	expect((await view(objective.id)).state).toBe("stranded");

	await t!.runtime.db.write((tx) => tx.run("UPDATE sessions SET hold_until = ? WHERE id = ?", t!.clock.now() + 60_000, lead));
	expect((await view(objective.id)).state).toBe("idle");
	await t!.runtime.db.write((tx) => tx.run("UPDATE sessions SET hold_until = NULL WHERE id = ?", lead));

	// A metric check due in the future is read ahead, so a measured objective is not stranded.
	await t!.runtime.db.write((tx) =>
		tx.run(
			"INSERT INTO objective_metrics (objective_id, name, unit, direction, next_check_at, created_at) VALUES (?, ?, ?, 'down', ?, ?)",
			objective.id,
			"kilowatt-hours",
			"kWh",
			t!.clock.now() + 3_600_000,
			t!.clock.now(),
		),
	);
	expect((await view(objective.id)).state).toBe("idle");
	await t!.runtime.db.write((tx) => tx.run("UPDATE objective_metrics SET next_check_at = ? WHERE objective_id = ?", t!.clock.now() - 1000, objective.id));
	expect((await view(objective.id)).state).toBe("stranded");

	// A phase that is not active has no display state: the phase is what a reader shows.
	expect((await view((await draft("A draft")).id)).state).toBeNull();
});

it("OBJ-03 no column and no write path stores running, idle, or stranded", async () => {
	await start();
	const columns = (await t!.runtime.db.all<{ name: string }>("PRAGMA table_info(objectives)")).map((row) => row.name);
	expect(columns).not.toContain("state");
	expect(columns).not.toContain("display_state");

	// The migration never stores a derived state, and the package writes only the phase.
	const sql = MIGRATIONS.find((migration) => migration.version === 12)!.sql.toLowerCase();
	for (const value of ["'running'", "'idle'", "'stranded'"]) expect(sql).not.toContain(value);

	const objective = await draft("Nothing stored");
	const lead = await seedSession(objective.id, "running");
	await activate(objective.id, lead);
	expect((await view(objective.id)).state).toBe("running");
	const row = await t!.runtime.db.get<{ phase: string; updated_at: number }>("SELECT phase, updated_at FROM objectives WHERE id = ?", objective.id);
	expect(row!.phase).toBe("active");
	expect(Object.keys(row!).sort()).toEqual(["phase", "updated_at"]);
});

// --- OBJ-04 --------------------------------------------------------------------

it("OBJ-04 a session's draft lands in drafting with proposed_by, and only the user launches it", async () => {
	await start({ script: [{ text: "Ready to propose." }, { text: "I am the lead." }] });
	const proposer = (await t!.client.post<{ session: { id: string } }>("/sessions", { prompt: "Think about the bill." })).body.session.id;
	await settle();
	const before = await counts();

	const objective = await draft("Cut the energy bill by 10%", {}, proposer);
	expect(objective.phase).toBe("drafting");
	expect(objective.proposedBy).toEqual({ id: proposer, url: `pana://test.example/sessions/${proposer}` });
	expect(objective.lead).toBeNull();
	expect(objective.thread).toBeNull();
	expect(objective.members).toEqual([]);
	// OBJ-04: drafting has no effects. Nothing was created, delivered, scheduled, or woken.
	expect(await counts()).toEqual(before);
	expect((await t!.client.post(`/objectives/${objective.id}/launch`, {}, { caller: proposer })).status).toBe(403);

	const launched = await t!.client.post<{ objective: ObjectiveView }>(`/objectives/${objective.id}/launch`);
	expect(launched.status).toBe(200);
	expect(launched.body.objective.phase).toBe("active");
	// Launching anything that is not a draft is 409.
	const again = await t!.client.post(`/objectives/${objective.id}/launch`);
	expect(again.status).toBe(409);
	expect((again.body as { error: { code: string } }).error.code).toBe("wrong_phase");
});

// --- OBJ-05 --------------------------------------------------------------------

it("OBJ-05 launch creates the objective's thread, its one lead at depth 0, and the lead's first run", async () => {
	await start({ script: [{ text: "I will coordinate." }] });
	const objective = await draft("Cut the energy bill by 10%");
	const launched = await t!.client.post<{ objective: ObjectiveView }>(`/objectives/${objective.id}/launch`);
	expect(launched.status).toBe(200);
	const active = launched.body.objective;
	expect(active.phase).toBe("active");
	const lead = active.lead!.id;

	const row = await t!.runtime.db.get<{ parent: string | null; depth: number; objective_id: string }>("SELECT parent, depth, objective_id FROM sessions WHERE id = ?", lead);
	expect(row).toEqual({ parent: null, depth: 0, objective_id: objective.id });
	// No objective is ever active without exactly one lead.
	const leads = await t!.runtime.db.all("SELECT id FROM sessions WHERE objective_id = ?", objective.id);
	expect(leads).toEqual([{ id: lead }]);

	// The objective's thread is between the user and the lead, and its first message is the lead's input.
	const thread = await t!.client.get<{ thread: { participants: Array<{ id: string }> } }>(`/threads/${active.thread!.id}`);
	expect(thread.body.thread.participants.map((participant) => participant.id).sort()).toEqual([lead, TEST_USER].sort());
	const first = (await inputs(lead)).find((text) => text.length > 0)!;
	expect(first).toContain("Cut the energy bill by 10%");
	expect(first).toContain(active.url);
	await settle();
	expect((await view(objective.id)).state).toBe("stranded");
});

it("OBJ-05 launch is one transaction: a crash before COMMIT leaves a draft and no lead", async () => {
	// Learn where the phase update falls inside the launch transaction.
	const probe = await start();
	const first = await draft("Probe");
	const statements: string[] = [];
	probe.runtime.db.faults = (sql) => statements.push(sql);
	expect((await probe.client.post(`/objectives/${first.id}/launch`)).status).toBe(200);
	probe.runtime.db.faults = undefined;
	const at = statements.findIndex((sql) => /^\s*UPDATE objectives SET phase/.test(sql));
	expect(at).toBeGreaterThan(0);
	await probe.stop();

	t = await start({ stateDir: probe.dir });
	const goal = "Crash before the phase moves";
	const second = await draft(goal);
	const threadsBefore = (await t.runtime.db.get<{ n: number }>("SELECT count(*) AS n FROM threads"))!.n;
	t.runtime.db.faults = (sql, index) => {
		if (index === at) throw new SimulatedCrash(index, sql);
	};
	const caller = { kind: "user" as const, id: TEST_USER, url: t.runtime.userUrl };
	await expect(launchObjective(t.runtime, caller, second.id)).rejects.toBeInstanceOf(SimulatedCrash);
	t.runtime.db.faults = undefined;
	expect(t.fatal).toEqual([]);
	await t.stop();

	const raw = await openNodeSqliteDatabase(join(t.dir, "pana.sqlite"));
	try {
		expect(await raw.get("SELECT phase, lead_id, thread_id FROM objectives WHERE id = ?", second.id)).toEqual({
			phase: "drafting",
			lead_id: null,
			thread_id: null,
		});
		expect(await raw.get("SELECT count(*) AS n FROM sessions WHERE objective_id = ?", second.id)).toEqual({ n: 0 });
		expect(await raw.get("SELECT count(*) AS n FROM threads")).toEqual({ n: threadsBefore });
	} finally {
		await raw.close();
	}
	t = undefined;
});

// --- OBJ-07 --------------------------------------------------------------------

it("OBJ-07 stopping an objective stops its members, records who stopped them, and cancels their wakes", async () => {
	await start({ script: [{ text: "I am the lead." }, { text: "Member at work." }] });
	const objective = await draft("Retire the boiler");
	await t!.client.post(`/objectives/${objective.id}/launch`);
	const lead = (await view(objective.id)).lead!.id;
	await settle();

	const member = await seedSession(objective.id, "idle");
	const wake = await t!.client.post<{ schedule: { id: string } }>("/schedules", { kind: "wake", session: member, in: "1h", note: "Check the boiler." });
	expect(wake.status).toBe(201);

	const stopped = await t!.client.post<{ objective: ObjectiveView }>(`/objectives/${objective.id}/stop`);
	expect(stopped.status).toBe(200);
	expect(stopped.body.objective.phase).toBe("stopped");
	for (const session of [lead, member]) {
		expect(await t!.runtime.db.get("SELECT state, stopped_by FROM sessions WHERE id = ?", session), session).toEqual({
			state: "stopped",
			stopped_by: "objective",
		});
	}
	expect(await t!.runtime.db.get("SELECT state FROM schedules WHERE id = ?", wake.body.schedule.id)).toEqual({ state: "deleted" });

	// A session may not stop or resume an objective; the user does.
	const proposer = await seedSession(objective.id);
	expect((await t!.client.post(`/objectives/${objective.id}/resume`, {}, { caller: proposer })).status).toBe(403);
	const resumed = await t!.client.post<{ objective: ObjectiveView }>(`/objectives/${objective.id}/resume`);
	expect(resumed.status).toBe(200);
	expect(resumed.body.objective.phase).toBe("active");
	expect((await t!.client.post(`/objectives/${objective.id}/stop`)).status).toBe(200);

	// `stop --all` reaches every active objective and leaves the drafts alone.
	const running = await draft("Actually running");
	await t!.client.post(`/objectives/${running.id}/launch`);
	await settle();
	const draft2 = await draft("Still a draft");
	const all = await command("objective stop", { all: true });
	expect(all.exitCode).toBe(0);
	expect((all.body as { objectives: ObjectiveView[] }).objectives.map((objective) => objective.id)).toEqual([running.id]);
	expect((await view(running.id)).phase).toBe("stopped");
	expect((await view(draft2.id)).phase).toBe("drafting");
	expect((await command("objective stop", { id: draft2.id })).exitCode).toBe(3);
});

it("OBJ-07 a closed objective refuses member creates and deliveries", async () => {
	await start({ script: [{ text: "I am the lead." }] });
	const objective = await draft("Closed shop");
	await t!.client.post(`/objectives/${objective.id}/launch`);
	const lead = (await view(objective.id)).lead!.id;
	await settle();
	await t!.client.post(`/objectives/${objective.id}/stop`);

	const created = await t!.client.post(`/sessions`, { prompt: "Do the work" }, { caller: lead });
	expect(created.status).toBe(409);
	expect((created.body as { error: { code: string; objective: string } }).error).toMatchObject({ code: "objective_closed", objective: objective.id });

	// A delivery to a member is refused, and the append rolls back with it.
	const messagesBefore = (await t!.runtime.db.get<{ n: number }>("SELECT count(*) AS n FROM messages"))!.n;
	const delivery = await t!.client.post(`/threads/${(await view(objective.id)).thread!.id}/messages`, {
		after: (await t!.runtime.db.get<{ id: string }>("SELECT id FROM messages WHERE thread_id = ? ORDER BY seq DESC LIMIT 1", (await view(objective.id)).thread!.id))!.id,
		body: "get back to work",
	});
	expect(delivery.status).toBe(409);
	expect((delivery.body as { error: { code: string } }).error.code).toBe("objective_closed");
	expect((await t!.runtime.db.get<{ n: number }>("SELECT count(*) AS n FROM messages"))!.n).toBe(messagesBefore);
});

it("OBJ-07 done needs every targeted metric at target and the user, or the charter's autonomy", async () => {
	await start({ script: [{ text: "I am the lead." }, { text: "and again" }] });
	const objective = await draft("Lose 5 kg");
	await t!.client.post(`/objectives/${objective.id}/launch`);
	const lead = (await view(objective.id)).lead!.id;
	await settle();
	const now = t!.clock.now();
	await t!.runtime.db.write((tx) =>
		tx.run(
			"INSERT INTO objective_metrics (objective_id, name, unit, direction, target, created_at) VALUES (?, 'weight', 'kg', 'down', 80, ?)",
			objective.id,
			now,
		),
	);

	// A target with no reading is not at its target.
	const short = await t!.client.post(`/objectives/${objective.id}/done`);
	expect(short.status).toBe(409);
	expect((short.body as { error: { code: string; metrics: unknown[] } }).error).toMatchObject({ code: "metric_behind" });
	expect((short.body as { error: { metrics: unknown[] } }).error.metrics).toEqual([{ name: "weight", target: 80, value: null }]);

	await t!.runtime.db.write((tx) =>
		tx.run("INSERT INTO metric_readings (id, objective_id, name, at, value, source) VALUES (?, ?, 'weight', ?, 79.5, 'check')", t!.runtime.newId(), objective.id, now),
	);
	// The user confirms by asking for it; a session cannot, on a manual objective.
	expect((await t!.client.post(`/objectives/${objective.id}/done`, {}, { caller: lead })).status).toBe(403);
	const done = await t!.client.post<{ objective: ObjectiveView }>(`/objectives/${objective.id}/done`);
	expect(done.status).toBe(200);
	expect(done.body.objective.phase).toBe("done");

	// `autonomy: auto` lets the lead finish by itself (OBJ-17: metrics at target, no members needed).
	const autonomous = await draft("Sweep the drive", { autonomy: "auto" });
	await t!.client.post(`/objectives/${autonomous.id}/launch`);
	const ownLead = (await view(autonomous.id)).lead!.id;
	await settle();
	const finished = await t!.client.post(`/objectives/${autonomous.id}/done`, {}, { caller: ownLead });
	expect(finished.status).toBe(200);
	expect((finished.body as { objective: ObjectiveView }).objective.phase).toBe("done");
});

it("OBJ-07 archive requires stopped or done, and cascades to member sessions through the REF-02 path", async () => {
	await start({ script: [{ text: "I am the lead." }] });
	const objective = await draft("Finishing touches");
	await t!.client.post(`/objectives/${objective.id}/launch`);
	const lead = (await view(objective.id)).lead!.id;
	await settle();
	const member = await seedSession(objective.id, "idle");
	expect(existsSync(join(t!.runtime.paths.scratch, lead))).toBe(true);

	const early = await t!.client.post(`/objectives/${objective.id}/archive`);
	expect(early.status).toBe(409);
	expect((early.body as { error: { code: string } }).error.code).toBe("wrong_phase");

	await t!.client.post(`/objectives/${objective.id}/stop`);
	const archived = await t!.client.post<{ objective: ObjectiveView }>(`/objectives/${objective.id}/archive`);
	expect(archived.status).toBe(200);
	expect(archived.body.objective.phase).toBe("archived");
	for (const session of [lead, member]) {
		expect(await t!.runtime.db.get("SELECT state FROM sessions WHERE id = ?", session)).toEqual({ state: "archived" });
	}
	// SCR-04: an archived session's scratch is gone, so archiving an objective sweeps it.
	expect(existsSync(join(t!.runtime.paths.scratch, lead))).toBe(false);
	// The user only: a session may not archive an objective.
	expect((await t!.client.post(`/objectives/${objective.id}/archive`, {}, { caller: member })).status).toBe(403);
});

// --- OBJ-38 --------------------------------------------------------------------

it("OBJ-38 pana objective --help lists every command, and every WP18 route is registered", async () => {
	await start();
	const help = renderHelp(COMMANDS, ["objective"]);
	for (const usage of [
		"pana objective create --goal TEXT",
		"pana objective create --goal-file PATH",
		"pana objective list [--phase PHASE] [--creator ADDR]",
		"pana objective show OBJECTIVE",
		"pana objective launch OBJECTIVE",
		"pana objective stop OBJECTIVE",
		"pana objective stop --all",
		"pana objective resume OBJECTIVE",
		"pana objective done OBJECTIVE",
		"pana objective archive OBJECTIVE",
		"pana objective charter set OBJECTIVE --section SECTION",
		"pana objective charter log OBJECTIVE [--section SECTION]",
		"pana objective metric add OBJECTIVE --name NAME --unit UNIT --direction up|down",
		"pana objective metric list OBJECTIVE",
		"pana objective metric set OBJECTIVE --name NAME --value V [--source S]",
		"pana objective metric target OBJECTIVE --name NAME [--target N]",
		"pana objective brief [OBJECTIVE]",
		"pana objective report OBJECTIVE",
		"pana objective escalate OBJECTIVE",
		"pana objective regenerate-lead OBJECTIVE --reason TEXT",
		"pana objective artifact add OBJECTIVE PATH",
		"pana objective artifact remove OBJECTIVE ID",
	]) {
		expect(help, usage).toContain(usage);
	}
	const root = await runCli(["--help"]);
	expect(root.code).toBe(0);
	expect(root.stdout).toContain("pana objective create --goal TEXT");
	const noun = await runCli(["objective", "--help"]);
	expect(noun.code).toBe(0);
	expect(noun.stdout).toContain("pana objective launch OBJECTIVE");

	const names = ROUTES.filter((route) => route.wp === "WP18").map((route) => route.name);
	expect(new Set(names).size).toBe(names.length);
	for (const name of [
		"objectives.create",
		"objectives.list",
		"objectives.show",
		"objectives.launch",
		"objectives.stop",
		"objectives.stopAll",
		"objectives.resume",
		"objectives.done",
		"objectives.archive",
		"objectives.charter.set",
		"objectives.charter.log",
		"objectives.metrics.add",
		"objectives.metrics.set",
		"objectives.metrics.readings",
		"objectives.metrics.list",
		"objectives.brief",
		"objectives.report",
		"objectives.escalate",
		"objectives.regenerateLead",
		"objectives.artifacts.add",
		"objectives.artifacts.remove",
	]) {
		expect(names, name).toContain(name);
	}

	// Every route the package registers has a handler by now: none answers 501 `not_implemented`.
	// A refusal here (a draft has no thread, an artifact names no file) is a real answer, not a hole.
	const objective = await draft("All routes wired");
	for (const [method, path] of [
		["GET", `/objectives/${objective.id}/brief`],
		["GET", `/objectives/${objective.id}/charter`],
		["GET", `/objectives/${objective.id}/metrics`],
		["POST", `/objectives/${objective.id}/report`],
		["POST", `/objectives/${objective.id}/escalate`],
		["POST", `/objectives/${objective.id}/regenerate-lead`],
		["POST", `/objectives/${objective.id}/artifacts`],
		["DELETE", `/objectives/${objective.id}/artifacts/anything`],
	] as const) {
		const res = await t!.client.request(method, path, { body: {} });
		expect(res.status, `${method} ${path}`).not.toBe(501);
		expect((res.body as { error?: { code: string } }).error?.code, `${method} ${path}`).not.toBe("not_implemented");
	}
});

it("OBJ-38 every objective command runs against panad without a usage error, and every route is in the API table", async () => {
	await start({
		script: [
			{ text: "lead one." },
			{ text: "lead two." },
			{ text: "lead three." },
			{ text: "lead four." },
			{ text: "lead five." },
			{ text: "lead six." },
			{ text: "lead seven." },
			{ text: "lead eight." },
		],
	});

	// Fixtures the commands act on: a launched objective with a thread, a draft to launch, an
	// active objective to stop and resume, an active one to finish and archive, and an artifact.
	const main = await draft("Every command");
	await t!.client.post(`/objectives/${main.id}/launch`);
	const toLaunch = await draft("Launch me");
	const toStop = await draft("Stop and resume me");
	await t!.client.post(`/objectives/${toStop.id}/launch`);
	const toFinish = await draft("Finish me");
	await t!.client.post(`/objectives/${toFinish.id}/launch`);
	await settle();

	const source = join(t!.dir, "artifact.txt");
	writeFileSync(source, "hello\n");
	const uploaded = await t!.client.request<{ file: { id: string } }>("POST", "/files?name=note.txt", {
		bytes: Buffer.from("already linked\n"),
		headers: { "content-type": "text/plain" },
	});
	expect(uploaded.status).toBe(201);
	const linked = await t!.client.post<{ artifact: { id: string } }>(`/objectives/${main.id}/artifacts`, { file: uploaded.body.file.id });
	expect(linked.status).toBe(201);

	// One entry per command in `OBJECTIVE_COMMANDS`, in the order the commands need to run.
	const runs: Record<string, Params> = {
		"objective create": { goal: "A command-created draft" },
		"objective list": {},
		"objective show": { id: main.id },
		"objective launch": { id: toLaunch.id },
		"objective stop": { id: toStop.id },
		"objective resume": { id: toStop.id },
		"objective done": { id: toFinish.id },
		"objective archive": { id: toFinish.id },
		"objective charter set": { id: main.id, section: "Notes", body: "Measured weekly." },
		"objective charter log": { id: main.id },
		"objective metric add": { id: main.id, name: "kilowatt-hours", unit: "kWh", direction: "down" },
		"objective metric list": { id: main.id },
		"objective metric set": { id: main.id, name: "kilowatt-hours", value: "296", source: "lead" },
		"objective metric target": { id: main.id, name: "kilowatt-hours", target: "300" },
		"objective brief": { id: main.id },
		"objective report": { id: main.id, body: "Week one: 296 kWh." },
		"objective escalate": { id: main.id, body: "Is 296 low enough?" },
		"objective regenerate-lead": { id: main.id, reason: "The lead stopped answering." },
		"objective artifact add": { id: main.id, path: source },
		"objective artifact remove": { id: main.id, file: linked.body.artifact.id },
	};
	// Every advertised command is exercised, and no command is left out of this list.
	expect(Object.keys(runs).sort()).toEqual(OBJECTIVE_COMMANDS.map((spec) => spec.path.join(" ")).sort());
	for (const [name, params] of Object.entries(runs)) {
		const outcome = await command(name, params);
		// Not a usage error: whatever panad answers, the flags and positionals parsed and the
		// request was built and sent. (Exit code 2 is also a 400, so `usage` is the exact flag.)
		expect(outcome.usage, `${name} ${JSON.stringify(outcome.body)}`).toBeUndefined();
	}
	// `stop --all` is the same command's other form (OBJ-07 covers what it stops).
	expect((await command("objective stop", { all: true })).exitCode).toBe(0);
	// `artifact add` uploads through `POST /files` in the CLI itself, so it needs the whole command.
	expect((await runCli(["objective", "artifact", "add", `pana://test.example/objectives/${main.id}`, source])).code).toBe(0);

	// Every WP18 route is in the SPEC API table (CONTRIBUTING, "Add a route"), which groups a
	// row's methods and its shared-prefix siblings, so both the table and the route are matched.
	const spec = readFileSync(join(import.meta.dirname, "..", "SPEC.md"), "utf8");
	const concrete = (path: string) => path.replace(/:\w+/g, "X");
	const table = spec
		.split("\n")
		.filter((line) => /^\| (GET|POST|DELETE)/.test(line))
		.flatMap((line) => {
			const [, methods, routes] = line.split("|").map((cell) => cell.trim());
			const items = [...routes!.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
			const firstSegments = items[0]!.split("/").filter(Boolean);
			return methods!.split(",").flatMap((method) =>
				items.map((item) => {
					const segments = item.split("/").filter(Boolean);
					const path = segments.length === 1 && firstSegments.length >= 3 ? `/${[...firstSegments.slice(0, -1), segments[0]].join("/")}` : item;
					return { method: method.trim(), path };
				}),
			);
		});
	for (const route of ROUTES.filter((entry) => entry.wp === "WP18")) {
		const listed = table.some((row) => matchRoute(row.method, concrete(row.path))?.route.name === route.name);
		expect(listed, `${route.method} ${route.pattern} is missing from the API table`).toBe(true);
	}
});

// --- OBJ-13..OBJ-24: membership, lineage, run admission, and limits ------------

interface SessionFacts {
	id: string;
	state: string;
	parent: string | null;
	depth: number;
	objective_id: string | null;
	stopped_by: "user" | "objective" | null;
	hold_until: number | null;
	cost_usd: number;
}

async function facts(id: string): Promise<SessionFacts> {
	const row = await t!.runtime.db.get<SessionFacts>(
		"SELECT id, state, parent, depth, objective_id, stopped_by, hold_until, cost_usd FROM sessions WHERE id = ?",
		id,
	);
	expect(row, `session ${id}`).toBeDefined();
	return row!;
}

/** Active wake schedules targeting a session, in the WAK-01 payload shape. */
async function wakesFor(sessionId: string): Promise<Array<{ id: string; next_at: number; payload: { session: string; note: string; hold?: boolean; condition?: string; heldNotes?: unknown[] } }>> {
	const rows = await t!.runtime.db.all<{ id: string; next_at: number; payload: string }>(
		`SELECT id, next_at, payload FROM schedules
		  WHERE kind = 'wake' AND state = 'active' AND json_extract(payload, '$.session') = ? ORDER BY next_at, id`,
		sessionId,
	);
	return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) as { session: string; note: string } }));
}

async function eventsFor(objectiveId: string, kind?: string): Promise<Array<{ kind: string; at: number; detail: Record<string, unknown> }>> {
	const rows = await t!.runtime.db.all<{ kind: string; at: number; detail: string }>(
		`SELECT kind, at, detail FROM objective_events WHERE objective_id = ? ${kind === undefined ? "" : "AND kind = ?"} ORDER BY at, id`,
		objectiveId,
		...(kind === undefined ? [] : [kind]),
	);
	return rows.map((row) => ({ ...row, detail: JSON.parse(row.detail) as Record<string, unknown> }));
}

async function delivery(messageId: string, sessionId: string) {
	return t!.runtime.db.get<{ read_at: number | null; wake_request_id: string | null; wake_submission_id: number | null }>(
		"SELECT read_at, wake_request_id, wake_submission_id FROM deliveries WHERE message_id = ? AND recipient_id = ?",
		messageId,
		sessionId,
	);
}

/** Notices the domain posted to the user, newest last. */
async function domainNotices(): Promise<string[]> {
	const rows = await t!.runtime.db.all<{ body: string }>(
		`SELECT m.body FROM messages m JOIN participants p ON p.id = m.sender_id WHERE p.kind = 'domain' ORDER BY m.created_at, m.seq`,
	);
	return rows.map((row) => row.body);
}

async function objectiveThreadHead(threadId: string): Promise<string> {
	return (await t!.runtime.db.get<{ id: string }>("SELECT id FROM messages WHERE thread_id = ? ORDER BY seq DESC LIMIT 1", threadId))!.id;
}

/** A session row for an objective with a chosen parent and stop reason, without a conversation. */
async function seedMember(objectiveId: string | null, options: { parent?: string | null; state?: string; stoppedBy?: "user" | "objective" | null } = {}): Promise<string> {
	const id = t!.runtime.newId();
	const now = t!.clock.now();
	const depth = options.parent === undefined || options.parent === null ? 1 : (await facts(options.parent)).depth + 1;
	await t!.runtime.db.write(async (tx) => {
		await tx.run("INSERT INTO participants (id, kind, url, created_at) VALUES (?, 'session', ?, ?)", id, t!.runtime.url({ kind: "session", id }), now);
		await tx.run(
			"INSERT INTO sessions (id, state, parent, depth, objective_id, stopped_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			id,
			options.state ?? "idle",
			options.parent ?? null,
			depth,
			objectiveId,
			options.stoppedBy ?? null,
			now,
			now,
		);
	});
	return id;
}

/** Launch an objective and return its lead. */
async function launchAndSettle(objective: ObjectiveView): Promise<string> {
	const launched = await t!.client.post<{ objective: ObjectiveView }>(`/objectives/${objective.id}/launch`);
	expect(launched.status).toBe(200);
	const lead = launched.body.objective.lead!.id;
	await settle();
	return lead;
}

it("OBJ-13 a member is the lead's child with a thread between them, the lead controls only what it created, and only the user archives", async () => {
	await start({
		script: [
			{ toolCalls: [{ name: "pana_session_create", args: { prompt: "member one" } }] },
			{ text: "member one is working." },
			{ text: "lead done." },
		],
	});
	const objective = await draft("Lead control");
	const lead = await launchAndSettle(objective);
	const member = (await view(objective.id)).members.find((entry) => entry.id !== lead)!;
	expect(member, "the lead created a member").toBeDefined();
	const memberRow = await facts(member.id);
	expect(memberRow.parent).toBe(lead);
	expect(memberRow.objective_id).toBe(objective.id);

	// A thread between the lead and the member.
	const threads = await t!.runtime.db.all<{ thread_id: string }>(
		"SELECT thread_id FROM thread_participants WHERE participant_id = ?",
		member.id,
	);
	const between = await t!.runtime.db.get<{ n: number }>(
		`SELECT COUNT(*) AS n FROM thread_participants WHERE thread_id = ? AND participant_id IN (?, ?)`,
		threads[0]!.thread_id,
		lead,
		member.id,
	);
	expect(between!.n).toBe(2);

	// The lead may stop, resume, and compact the member it created.
	const stopped = await t!.client.post(`/sessions/${member.id}/stop`, {}, { caller: lead });
	expect(stopped.status).toBe(200);
	expect((await facts(member.id)).stopped_by).toBe("objective");
	expect((await t!.client.post(`/sessions/${member.id}/resume`, {}, { caller: lead })).status, "the objective's stop is resumable").toBe(200);
	expect((await t!.client.post(`/sessions/${member.id}/compact`, {}, { caller: lead })).status).not.toBe(403);

	// It may not touch a member it did not create.
	const outsider = await seedMember(objective.id, { parent: member.id });
	expect((await t!.client.post(`/sessions/${outsider}/stop`, {}, { caller: lead })).status).toBe(403);
	expect((await t!.client.post(`/sessions/${outsider}/resume`, {}, { caller: lead })).status).toBe(403);
	expect((await t!.client.post(`/sessions/${outsider}/compact`, {}, { caller: lead })).status).toBe(403);

	// REF-02 stands: only the user archives.
	expect((await t!.client.post(`/sessions/${member.id}/archive`, {}, { caller: lead })).status).toBe(403);
	expect((await t!.client.post(`/sessions/${member.id}/archive`)).status).toBe(200);
	expect((await facts(member.id)).state).toBe("archived");
});

it("OBJ-14 a member the user stopped is inert to the objective, and the objective's own stop records objective", async () => {
	await start({
		script: [
			{ toolCalls: [{ name: "pana_session_create", args: { prompt: "member one" } }] },
			{ text: "member one is working." },
			{ text: "lead done." },
		],
	});
	const objective = await draft("Stop reasons");
	const lead = await launchAndSettle(objective);
	const member = (await view(objective.id)).members.find((entry) => entry.id !== lead)!;

	// The user's own stop records `user`, and the session view says so for the briefing.
	expect((await t!.client.post(`/sessions/${member.id}/stop`)).status).toBe(200);
	expect((await facts(member.id)).stopped_by).toBe("user");
	const shown = await t!.client.get<{ session: { stoppedBy: string | null } }>(`/sessions/${member.id}`);
	expect(shown.body.session.stoppedBy).toBe("user");

	// The lead may not resume it.
	const resumed = await t!.client.post(`/sessions/${member.id}/resume`, {}, { caller: lead });
	expect(resumed.status).toBe(403);
	expect((resumed.body as { error: { code: string } }).error.code).toBe("forbidden");
	expect((await facts(member.id)).state).toBe("stopped");

	// A delivery to it wakes nothing and stays unread, and a scheduled wake does not revive it.
	const thread = (
		await t!.runtime.db.get<{ thread_id: string }>("SELECT thread_id FROM thread_participants WHERE participant_id = ?", member.id)
	)!.thread_id;
	const head = await objectiveThreadHead(thread);
	const sent = await t!.client.post<{ message: { id: string } }>(`/threads/${thread}/messages`, { after: head, body: "back to work" }, { caller: lead });
	expect(sent.status).toBe(200);
	const wake = await t!.client.post<{ schedule: { id: string } }>("/schedules", { kind: "wake", session: member.id, in: "1m", note: "back to work" });
	expect(wake.status).toBe(201);
	await t!.clock.advance(120_000);
	expect((await facts(member.id)).state).toBe("stopped");
	expect(await delivery(sent.body.message.id, member.id)).toEqual({ read_at: null, wake_request_id: null, wake_submission_id: null });

	// The objective's own stop records `objective`, and a member it stopped may be resumed by the lead.
	expect((await t!.client.post(`/objectives/${objective.id}/stop`)).status).toBe(200);
	expect((await facts(lead)).stopped_by).toBe("objective");
	expect((await t!.client.post(`/objectives/${objective.id}/resume`)).status).toBe(200);
	expect((await t!.client.post(`/sessions/${lead}/resume`, {}, { caller: lead })).status).toBe(200);
	expect((await facts(lead)).state).not.toBe("stopped");
	expect((await facts(lead)).stopped_by).toBeNull();
});

it("OBJ-15 every session created for an objective inherits objective_id, names the objective in its prompt, and spends into the objective's rollup", async () => {
	await start({
		script: [
			{ toolCalls: [{ name: "pana_session_create", args: { prompt: "member one" } }], usage: { costUsd: 0.02 } },
			{ text: "member one is working.", usage: { costUsd: 0.02 } },
			{ text: "lead done.", usage: { costUsd: 0.02 } },
		],
	});
	const objective = await draft("Lineage");
	const lead = await launchAndSettle(objective);
	const member = (await view(objective.id)).members.find((entry) => entry.id !== lead)!;

	expect((await facts(member.id)).objective_id).toBe(objective.id);
	expect((await facts(lead)).objective_id).toBe(objective.id);
	const first = (await inputs(member.id))[0]!;
	expect(first).toContain(`pana://test.example/objectives/${objective.id}`);

	// Cost and run rollups filter on objective_id and always include the lead.
	const costs = await t!.runtime.db.get<{ total: number }>("SELECT SUM(cost_usd) AS total FROM sessions WHERE objective_id = ?", objective.id);
	expect(costs!.total).toBeGreaterThan(0);
	const shown = await view(objective.id);
	expect(shown.spendTotalUsd).toBeCloseTo(costs!.total, 5);
	expect(shown.spendTodayUsd).toBeCloseTo(costs!.total, 5);
	expect(shown.leadRunsToday).toBeGreaterThanOrEqual(1);
	// A session outside the objective spends nowhere near it.
	const outside = await seedMember(null, { state: "idle" });
	expect((await facts(outside)).objective_id).toBeNull();
});

it("OBJ-16 the roster bound refuses a member create with 402, and a lead run's member creates are capped", async () => {
	await start({
		config: { objectives: { maxMembersPerRun: 2 } },
		script: [
			{ toolCalls: [{ name: "pana_session_create", args: { prompt: "one" } }, { name: "pana_session_create", args: { prompt: "two" } }, { name: "pana_session_create", args: { prompt: "three" } }] },
			{ text: "member one." },
			{ text: "member two." },
			{ text: "lead done." },
		],
	});
	const objective = await draft("Roster");
	const lead = await launchAndSettle(objective);

	// The per-run cap refused the third create and posted exactly one notice for the run.
	const created = await eventsFor(objective.id, "member.created");
	expect(created).toHaveLength(2);
	const refused = await eventsFor(objective.id, "member.refused");
	expect(refused).toHaveLength(1);
	expect(refused[0]!.detail).toMatchObject({ limit: 2, session: lead });
	const notices = (await domainNotices()).filter((body) => body.includes("member creates"));
	expect(notices).toHaveLength(1);

	expect((await view(objective.id)).members).toHaveLength(3);
});

it("OBJ-16 maxActiveMembers bounds the roster: a create that would leave more members than the limit answers 402", async () => {
	await start({ script: [{ text: "lead one." }] });
	// The lead alone fills a limit of one.
	const objective = await draft("Small roster", { maxActiveMembers: 1 });
	const lead = await launchAndSettle(objective);
	const full = await t!.client.post(`/sessions`, { prompt: "the only member" }, { caller: lead });
	expect(full.status).toBe(402);
	expect((full.body as { error: { code: string } }).error.code).toBe("objective_roster_full");
	expect((full.body as { error: { maxActiveMembers: number } }).error.maxActiveMembers).toBe(1);
});

// --- OBJ-17 --------------------------------------------------------------------

it("OBJ-17 an objective with no members is measured, reported, and finished by its lone lead", async () => {
	await start({ script: [{ text: "I will watch the meter." }] });
	const objective = await draft("Watch the meter");
	await t!.client.post(`/objectives/${objective.id}/launch`);
	const lead = (await view(objective.id)).lead!.id;
	await settle();

	// The lead is the whole roster: nobody created a member, and with nothing pending the
	// objective is stranded like any other (OBJ-03).
	expect((await view(objective.id)).members.map((member) => member.id)).toEqual([lead]);
	expect((await view(objective.id)).state).toBe("stranded");

	// A memberless objective whose only work is a measurement: the lead declares the metric, the
	// user sets the target, and the user adds a check due tomorrow.
	expect((await command("objective metric add", { id: objective.id, name: "kilowatt-hours", unit: "kWh", direction: "down" }, lead)).exitCode).toBe(0);
	expect((await command("objective metric target", { id: objective.id, name: "kilowatt-hours", target: "300" })).exitCode).toBe(0);
	expect((await view(objective.id)).state).toBe("stranded");
	const checked = await t!.client.post(`/objectives/${objective.id}/metrics/kilowatt-hours`, { check: "printf 312", checkEvery: "1d" });
	expect(checked.status).toBe(200);
	// The future check is the only pending thing, and that reads `idle`, never `stranded`
	// (OBJ-03, OBJ-06): no member, no wake, and no notice.
	expect((await view(objective.id)).state).toBe("idle");
	expect((await sweepObjectives(t!.runtime)).stranded).toEqual([]);

	// A lone lead measures, and a target is not met by a number on the wrong side of it.
	expect((await command("objective metric set", { id: objective.id, name: "kilowatt-hours", value: "312" }, lead)).exitCode).toBe(0);
	const short = await t!.client.post(`/objectives/${objective.id}/done`);
	expect(short.status).toBe(409);
	expect((short.body as { error: { code: string } }).error.code).toBe("metric_behind");
	expect((await command("objective metric set", { id: objective.id, name: "kilowatt-hours", value: "296" }, lead)).exitCode).toBe(0);

	// It reports in the objective's thread, which is the objective's only log (OBJ-30).
	expect((await command("objective report", { id: objective.id, body: "Down to 296 kWh." }, lead)).exitCode).toBe(0);
	expect((await view(objective.id)).report).toMatchObject({ body: "Down to 296 kWh.", sender: { id: lead } });

	// `done` with every metric at target and no members needs nothing else, but the user's
	// confirmation still applies on a manual objective (OBJ-07).
	expect((await command("objective done", { id: objective.id }, lead)).exitCode).toBe(1);
	const done = await t!.client.post<{ objective: ObjectiveView }>(`/objectives/${objective.id}/done`);
	expect(done.status).toBe(200);
	expect(done.body.objective.phase).toBe("done");
});

it("OBJ-18 a lead's runs are held to wakeMinMinutes, coalesce into one run, and each held delivery arrives once, in order", async () => {
	await start({ config: { objectives: { wakeMinMinutes: 5 } }, script: [{ text: "lead one." }, { text: "lead two." }] });
	const objective = await draft("Quiet lead");
	const lead = await launchAndSettle(objective);
	const thread = (await view(objective.id)).thread!.id;
	const calls = t!.model.calls();

	const first = await t!.client.post<{ message: { id: string } }>(`/threads/${thread}/messages`, { after: await objectiveThreadHead(thread), body: "first held message" });
	expect(first.status).toBe(200);
	expect(await delivery(first.body.message.id, lead)).toEqual({ read_at: null, wake_request_id: null, wake_submission_id: null });

	await t!.clock.advance(60_000);
	const second = await t!.client.post<{ message: { id: string } }>(`/threads/${thread}/messages`, { after: await objectiveThreadHead(thread), body: "second held message" });
	expect(second.status).toBe(200);
	await t!.clock.settle();
	expect(t!.model.calls()).toBe(calls);
	expect(await delivery(second.body.message.id, lead)).toEqual({ read_at: null, wake_request_id: null, wake_submission_id: null });

	// The hold persists on the session and as one ordinary wake whose note names the deliveries.
	const started = await facts(lead);
	const holdUntil = started.hold_until!;
	expect(holdUntil).toBe(FAKE_EPOCH + 300_000);
	const wakes = await wakesFor(lead);
	expect(wakes).toHaveLength(1);
	expect(wakes[0]!.payload.hold).toBe(true);
	expect(wakes[0]!.next_at).toBe(holdUntil);
	expect(wakes[0]!.payload.note).toContain(first.body.message.id);
	expect(wakes[0]!.payload.note).toContain(second.body.message.id);
	const listed = await command("schedule list", { kind: "wake" });
	expect(listed.exitCode).toBe(0);
	expect(JSON.stringify(listed.body)).toContain(holdUntil.toString());

	// When the interval elapses, one run starts carrying both deliveries in order.
	await t!.clock.advanceTo(holdUntil);
	await settle();
	expect(t!.model.calls()).toBe(calls + 1);
	for (const message of [first.body.message.id, second.body.message.id]) {
		const row = await delivery(message, lead);
		expect(row!.read_at).not.toBeNull();
		expect(row!.wake_submission_id).not.toBeNull();
	}
	const transcript = (await inputs(lead)).join("\n");
	expect(transcript.indexOf("first held message")).toBeGreaterThanOrEqual(0);
	expect(transcript.indexOf("first held message")).toBeLessThan(transcript.indexOf("second held message"));
	expect((await facts(lead)).hold_until).toBeNull();
	expect(await wakesFor(lead)).toHaveLength(0);
});

it("OBJ-19 maxDailyLeadTurns caps lead runs per local day, holds deliveries, and notices once for the day", async () => {
	await start({ script: [{ text: "lead one." }, { text: "lead two." }] });
	const objective = await draft("Bounded turns", { maxDailyLeadTurns: 1 });
	const lead = await launchAndSettle(objective);
	const thread = (await view(objective.id)).thread!.id;
	expect((await view(objective.id)).leadRunsToday).toBe(1);

	const one = await t!.client.post<{ message: { id: string } }>(`/threads/${thread}/messages`, { after: await objectiveThreadHead(thread), body: "one more" });
	await t!.clock.advance(60_000);
	const two = await t!.client.post<{ message: { id: string } }>(`/threads/${thread}/messages`, { after: await objectiveThreadHead(thread), body: "and another" });
	await t!.clock.settle();

	// Both deliveries wait for the next local day, and the user was told once, not twice.
	for (const message of [one.body.message.id, two.body.message.id]) {
		expect((await delivery(message, lead))!.wake_submission_id).toBeNull();
	}
	const notices = (await domainNotices()).filter((body) => body.includes("lead runs today"));
	expect(notices).toHaveLength(1);
	expect(notices[0]).toContain(`pana://test.example/objectives/${objective.id}`);
	const resumedAt = nextDayStart(t!.clock.now(), "UTC");
	expect((await facts(lead)).hold_until).toBe(resumedAt);

	// The next local day admits the lead again, carrying both held deliveries.
	const calls = t!.model.calls();
	await t!.clock.advanceTo(resumedAt);
	await settle();
	expect(t!.model.calls()).toBe(calls + 1);
	for (const message of [one.body.message.id, two.body.message.id]) {
		expect((await delivery(message, lead))!.read_at).not.toBeNull();
	}
	expect((await domainNotices()).filter((body) => body.includes("lead runs today"))).toHaveLength(1);
	expect((await view(objective.id)).leadRunsToday).toBe(1);

	// SCH-08's day behavior decides the reset: the spring-forward local day is 23 hours long.
	const noon = Date.UTC(2026, 2, 8, 17, 0, 0);
	// The boundaries are found to the second (LIM-03 searches rather than using offsets).
	expect(Math.abs(nextDayStart(noon, "America/New_York") - dayStart(noon, "America/New_York") - 23 * 3_600_000)).toBeLessThan(2000);
});

it("OBJ-20 maxDailyUsd refuses every run, stops running members, notices once, and wakes at the next local day", async () => {
	await start();
	const objective = await draft("Day budget", { maxDailyUsd: 1 });
	const lead = await seedMember(objective.id, { state: "idle" });
	await activate(objective.id, lead);
	const member = await seedMember(objective.id, { parent: lead, state: "running" });

	// Spend $2 today on the lead: the objective crosses its $1 day budget.
	await t!.runtime.db.write((tx) => recordCost(tx, t!.runtime, lead, 2));
	await sessionRuntime(t!.runtime).enforceObjectiveBudget(objective.id);

	// Running members stop with the objective as the reason.
	expect(await facts(member)).toMatchObject({ state: "stopped", stopped_by: "objective" });
	const shown = await view(objective.id);
	expect(shown.paused).toBe("budget_day");
	expect(shown.state).toBe("idle");
	expect(shown.spendTodayUsd).toBeCloseTo(2, 5);

	// One notice names the objective URL and the resume time; a wake waits at the next local day.
	const notices = (await domainNotices()).filter((body) => body.includes("daily budget"));
	expect(notices).toHaveLength(1);
	expect(notices[0]).toContain(`pana://test.example/objectives/${objective.id}`);
	const resumes = nextDayStart(t!.clock.now(), "UTC");
	expect((await facts(lead)).hold_until).toBe(resumes);
	const wakes = await wakesFor(lead);
	expect(wakes).toHaveLength(1);
	expect(wakes[0]!.next_at).toBe(resumes);

	// No lead or member run starts, and no member is created.
	const admission = await t!.runtime.db.write((tx) => admitRun(tx, t!.runtime, lead, { kind: "delivery" }));
	expect(admission).toMatchObject({ admit: false, condition: "budget_day", until: resumes });
	const created = await t!.client.post(`/sessions`, { prompt: "more work" }, { caller: lead });
	expect(created.status).toBe(402);
	expect((created.body as { error: { code: string } }).error.code).toBe("objective_budget_day");

	// A second notice is not posted for the same day.
	await sessionRuntime(t!.runtime).enforceObjectiveBudget(objective.id);
	expect((await domainNotices()).filter((body) => body.includes("daily budget"))).toHaveLength(1);

	// At the next local day the day budget is clear again.
	await t!.clock.advanceTo(resumes);
	await t!.clock.settle();
	expect((await view(objective.id)).paused).toBeNull();
});

it("OBJ-21 maxTotalUsd holds until the user acts, outranks the day budget, and sets no wake", async () => {
	await start();
	const objective = await draft("Lifetime budget", { maxTotalUsd: 1, maxDailyUsd: 5 });
	const lead = await seedMember(objective.id, { state: "idle" });
	await activate(objective.id, lead);
	await t!.runtime.db.write(async (tx) => {
		await tx.run("INSERT INTO objective_costs (day, objective_id, cost_usd) VALUES ('2026-01-04', ?, 0.6)", objective.id);
		await tx.run("INSERT INTO objective_costs (day, objective_id, cost_usd) VALUES ('2026-01-05', ?, 0.6)", objective.id);
	});

	await sessionRuntime(t!.runtime).enforceObjectiveBudget(objective.id);
	const shown = await view(objective.id);
	expect(shown.paused).toBe("budget_total");
	expect(shown.spendTotalUsd).toBeCloseTo(1.2, 5);
	expect(shown.spendTodayUsd).toBeCloseTo(0.6, 5);
	// The lifetime budget sets no automatic wake and no hold: the user must act.
	expect(await wakesFor(lead)).toHaveLength(0);
	expect((await facts(lead)).hold_until).toBeNull();
	const notices = (await domainNotices()).filter((body) => body.includes("lifetime budget"));
	expect(notices).toHaveLength(1);
	expect(notices[0]).toContain(`pana://test.example/objectives/${objective.id}`);

	// At or over, no run starts.
	const admission = await t!.runtime.db.write((tx) => admitRun(tx, t!.runtime, lead, { kind: "delivery" }));
	expect(admission).toMatchObject({ admit: false, condition: "budget_total" });
	expect(admission.until).toBeUndefined();
});

it("OBJ-22 the domain budget pauses an active objective without waking it or calling it stranded", async () => {
	await start({ config: { budget: { sessionUsd: 100, domainDailyUsd: 0.01 } } });
	const objective = await draft("Domain budget");
	const lead = await seedMember(objective.id, { state: "idle" });
	await activate(objective.id, lead);

	await t!.runtime.db.write((tx) => recordCost(tx, t!.runtime, lead, 0.02));
	const shown = await view(objective.id);
	expect(shown.paused).toBe("domain_budget");
	// Nothing is running, yet the objective is not stranded: its limit holds it.
	expect(shown.state).toBe("idle");
	expect(await wakesFor(lead)).toHaveLength(0);
	expect((await facts(lead)).hold_until).toBeNull();

	const admission = await t!.runtime.db.write((tx) => admitRun(tx, t!.runtime, lead, { kind: "delivery" }));
	expect(admission).toMatchObject({ admit: false, condition: "domain_budget" });
});

it("OBJ-23 a held run records why and leaves its delivery queued, and a refused run never starts", async () => {
	await start({ config: { objectives: { wakeMinMinutes: 10 } }, script: [{ text: "lead one." }, { text: "lead two." }] });
	const objective = await draft("Hold records");
	const lead = await launchAndSettle(objective);
	const thread = (await view(objective.id)).thread!.id;
	const sent = await t!.client.post<{ message: { id: string } }>(`/threads/${thread}/messages`, { after: await objectiveThreadHead(thread), body: "wait for me" });
	await t!.clock.settle();

	const deliveryId = (await t!.runtime.db.get<{ id: string }>("SELECT id FROM deliveries WHERE message_id = ? AND recipient_id = ?", sent.body.message.id, lead))!.id;
	const held = await eventsFor(objective.id, "run.held");
	expect(held).toHaveLength(1);
	expect(held[0]!.detail).toMatchObject({ condition: "lead_quiet", session: lead, delivery: deliveryId });
	// The delivery is queued, not lost or dropped.
	expect(await delivery(sent.body.message.id, lead)).toEqual({ read_at: null, wake_request_id: null, wake_submission_id: null });

	// A refused run records its condition too.
	const budget = await draft("Refused records", { maxDailyUsd: 1 });
	const budgetLead = await seedMember(budget.id, { state: "idle" });
	await activate(budget.id, budgetLead);
	await t!.runtime.db.write((tx) => recordCost(tx, t!.runtime, budgetLead, 2));
	await t!.runtime.db.write((tx) => admitRun(tx, t!.runtime, budgetLead, { kind: "delivery", deliveryId: "delivery-1" }));
	const refused = await eventsFor(budget.id, "run.refused");
	expect(refused).toHaveLength(1);
	expect(refused[0]!.detail).toMatchObject({ condition: "budget_day", delivery: "delivery-1" });
});

it("OBJ-24 maxDailyUserMessages holds the lead's next run and says why in the conditions the briefing reads", async () => {
	await start({ script: [{ text: "here is my report." }, { text: "lead two." }] });
	const objective = await draft("Quiet objective", { maxDailyUserMessages: 1 });
	const lead = await launchAndSettle(objective);
	// The lead's answer to the launch is one message to the user today.
	const shown = await view(objective.id);
	expect(shown.userMessagesToday).toBe(1);

	const thread = (await view(objective.id)).thread!.id;
	const sent = await t!.client.post<{ message: { id: string } }>(`/threads/${thread}/messages`, { after: await objectiveThreadHead(thread), body: "please run" });
	await t!.clock.settle();
	expect((await delivery(sent.body.message.id, lead))!.wake_submission_id).toBeNull();
	expect((await facts(lead)).hold_until).toBe(nextDayStart(t!.clock.now(), "UTC"));

	const row = (await objectiveRow(t!.runtime.db, objective.id))!;
	const conditions = await objectiveConditions(t!.runtime.db, t!.runtime, row);
	expect(conditions.userMessagesToday).toBe(1);
	expect(conditions.maxDailyUserMessages).toBe(1);
	expect(conditions.holdUntil).toBe(nextDayStart(t!.clock.now(), "UTC"));
	// The lead's next run was not admitted for that reason.
	const admission = await t!.runtime.db.write((tx) => admitRun(tx, t!.runtime, lead, { kind: "delivery" }));
	expect(admission).toMatchObject({ admit: false, condition: "messages_day" });
});

it("OBJ-18 a scheduled wake joins the lead's hold, and its note arrives with the released run", async () => {
	await start({ config: { objectives: { wakeMinMinutes: 5 } }, script: [{ text: "lead one." }, { text: "lead two." }] });
	const objective = await draft("Wake hold");
	const lead = await launchAndSettle(objective);
	const created = await t!.client.post<{ schedule: { id: string } }>(
		"/schedules",
		{ kind: "wake", session: lead, in: "1m", note: "check the boiler" },
		{ caller: lead },
	);
	expect(created.status).toBe(201);

	// The wake fires inside the quiet interval and is held rather than starting a run.
	await t!.clock.advance(60_000);
	await settle();
	expect(t!.model.calls()).toBe(1);
	const wakes = await wakesFor(lead);
	expect(wakes).toHaveLength(1);
	expect(wakes[0]!.payload.hold).toBe(true);
	expect(wakes[0]!.payload.heldNotes).toHaveLength(1);
	expect((wakes[0]!.payload.heldNotes![0] as { note: string }).note).toContain("check the boiler");

	// At the hold time one run starts and carries the wake's note.
	const holdUntil = (await facts(lead)).hold_until!;
	await t!.clock.advanceTo(holdUntil);
	await settle();
	expect(t!.model.calls()).toBe(2);
	expect((await inputs(lead)).join("\n")).toContain("check the boiler");
});

it("OBJ-20 a lead stopped by the day budget is resumed by the next local day's wake, and its queued mail arrives then", async () => {
	await start({ script: [{ text: "spent.", usage: { costUsd: 0.02 } }, { text: "back at work." }] });
	const objective = await draft("Day budget end to end", { maxDailyUsd: 0.01 });
	const lead = await launchAndSettle(objective);

	// Crossing the day budget pauses the objective and sets the lead's hold at the next local day.
	const shown = await view(objective.id);
	expect(shown.paused).toBe("budget_day");
	const resumes = nextDayStart(t!.clock.now(), "UTC");
	expect((await facts(lead)).hold_until).toBe(resumes);

	// Mail that arrives while it is paused waits, unread and unwoken.
	const thread = (await view(objective.id)).thread!.id;
	const sent = await t!.client.post<{ message: { id: string } }>(`/threads/${thread}/messages`, { after: await objectiveThreadHead(thread), body: "tomorrow's work" });
	expect(sent.status).toBe(200);
	expect((await delivery(sent.body.message.id, lead))!.read_at).toBeNull();

	const calls = t!.model.calls();
	await t!.clock.advanceTo(resumes);
	await settle();
	expect(t!.model.calls()).toBe(calls + 1);
	expect(await facts(lead)).toMatchObject({ state: "idle", stopped_by: null, hold_until: null });
	expect((await delivery(sent.body.message.id, lead))!.read_at).not.toBeNull();
	expect((await view(objective.id)).paused).toBeNull();
});

it("OBJ-18 the hold survives a restart as an ordinary wake, and releases its delivery exactly once", async () => {
	await start({ config: { objectives: { wakeMinMinutes: 5 } }, script: [{ text: "lead one." }, { text: "lead two." }] });
	const objective = await draft("Restart hold");
	const lead = await launchAndSettle(objective);
	const thread = (await view(objective.id)).thread!.id;
	const sent = await t!.client.post<{ message: { id: string } }>(`/threads/${thread}/messages`, { after: await objectiveThreadHead(thread), body: "survive with me" });
	await t!.clock.settle();
	const holdUntil = (await facts(lead)).hold_until!;
	expect(holdUntil).toBeGreaterThan(t!.clock.now());

	const { clock, dir } = t!;
	await t!.stop();
	t = await start({ stateDir: dir, clock, script: [{ text: "lead after restart." }] });

	// Nothing delivers the held mail early, and the persisted wake still fires at the hold time.
	await t!.clock.advanceTo(holdUntil);
	await settle();
	expect((await delivery(sent.body.message.id, lead))!.read_at).not.toBeNull();
	expect((await facts(lead)).hold_until).toBeNull();
	expect(await wakesFor(lead)).toHaveLength(0);
	const transcript = (await inputs(lead)).join("\n");
	expect(transcript).toContain("survive with me");
	expect(transcript.split("survive with me")).toHaveLength(2);
});
