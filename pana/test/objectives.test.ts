// WP18 foundation: the objectives schema, identity, launch, lifecycle gates, and route surface
// (OBJ-01..OBJ-05, OBJ-07, OBJ-38). The packages that build on this one add their own tests here.

import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { ROUTES } from "../src/api/routes.ts";
import { COMMANDS, runPanaCommand } from "../src/cli/commands.ts";
import { renderHelp } from "../src/cli/help.ts";
import { main, type CliIo } from "../src/cli/index.ts";
import { MIGRATIONS, SCHEMA_VERSION } from "../src/db/schema.ts";
import { SimulatedCrash } from "../src/db/index.ts";
import { formatUrl, parseRef } from "../src/ids/index.ts";
import { launchObjective, type ObjectiveView } from "../src/objectives/index.ts";
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

	// Every route a later package owns answers 501 `not_implemented` until it lands.
	const objective = await draft("Not built yet");
	for (const [method, path] of [
		["GET", `/objectives/${objective.id}/brief`],
		["GET", `/objectives/${objective.id}/charter`],
		["POST", `/objectives/${objective.id}/report`],
		["POST", `/objectives/${objective.id}/escalate`],
		["POST", `/objectives/${objective.id}/regenerate-lead`],
		["DELETE", `/objectives/${objective.id}/artifacts/anything`],
	] as const) {
		const res = await t!.client.request(method, path, method === "GET" ? {} : { body: {} });
		expect(res.status, `${method} ${path}`).toBe(501);
		expect((res.body as { error: { code: string } }).error.code).toBe("not_implemented");
	}
	// The CLI reports the same: a command whose route is unbuilt exits 1 (API-02).
	const brief = await command("objective brief", { id: objective.id });
	expect(brief.exitCode).toBe(1);
});
