// OBJ-42: a draft's goal is the user's to correct until the objective launches. A goal is written
// once at `POST /objectives`; this is the only other write path for `objectives.goal`, and it
// refuses every phase but `drafting` because after launch the goal is the lead's instruction
// (OBJ-05, OBJ-32). Every write is one `objective_events` row naming both goals.

import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runPanaCommand } from "../src/cli/commands.ts";
import { OBJECTIVE_COMMANDS } from "../src/objectives/cli.ts";
import type { ObjectiveView } from "../src/objectives/index.ts";
import { sessionRuntime } from "../src/sessions/index.ts";
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

/** A session row, without a conversation: enough for the authorization check and a 403. */
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

interface GoalEvent {
	kind: string;
	detail: string;
	actor_id: string | null;
}

async function goalEvents(objectiveId: string): Promise<GoalEvent[]> {
	return t!.runtime.db.all<GoalEvent>(
		"SELECT kind, detail, actor_id FROM objective_events WHERE objective_id = ? AND kind = 'goal.set' ORDER BY at, id",
		objectiveId,
	);
}

it("OBJ-42 the user sets a draft's goal, one objective_events row names both goals, and the command writes the same route", async () => {
	await start();
	const objective = await draft("Cut the energy bill and dollars");
	expect(objective.phase).toBe("drafting");
	expect(objective.goal).toBe("Cut the energy bill and dollars");

	// The typo is fixed in place: same objective, new goal, and the history keeps both texts.
	const written = await t!.client.post<{ objective: ObjectiveView; change: { from: string; to: string } }>(`/objectives/${objective.id}/goal`, {
		goal: "Cut the energy bill",
	});
	expect(written.status, JSON.stringify(written.body)).toBe(200);
	expect(written.body.objective.id).toBe(objective.id);
	expect(written.body.objective.goal).toBe("Cut the energy bill");
	expect(written.body.objective.phase).toBe("drafting");
	expect(written.body.change).toEqual({ from: "Cut the energy bill and dollars", to: "Cut the energy bill" });
	expect((await view(objective.id)).goal).toBe("Cut the energy bill");

	const events = await goalEvents(objective.id);
	expect(events).toHaveLength(1);
	expect(JSON.parse(events[0]!.detail)).toEqual({ from: "Cut the energy bill and dollars", to: "Cut the energy bill" });
	expect(events[0]!.actor_id).toBe(TEST_USER);
	// OBJ-01/OBJ-04: setting a goal has no effects — no sessions, no thread, no schedules, no wakes.
	expect(await t!.runtime.db.get("SELECT count(*) AS n FROM sessions WHERE objective_id = ?", objective.id)).toEqual({ n: 0 });
	expect(await t!.runtime.db.get("SELECT thread_id, lead_id FROM objectives WHERE id = ?", objective.id)).toEqual({ thread_id: null, lead_id: null });
	expect(await t!.runtime.db.get("SELECT count(*) AS n FROM schedules")).toEqual({ n: 0 });

	// CLI parity: the command is the API, and a goal may come from a file the way `create`'s does.
	const set = await command("objective goal set", { id: objective.id, goal: "Cut the energy bill in half" });
	expect(set.exitCode, JSON.stringify(set.body)).toBe(0);
	expect((await view(objective.id)).goal).toBe("Cut the energy bill in half");
	expect(await goalEvents(objective.id)).toHaveLength(2);

	// A draft that is launched keeps the goal it was set to (OBJ-05 hands the lead this text).
	const launched = await t!.client.post<{ objective: ObjectiveView }>(`/objectives/${objective.id}/launch`);
	expect(launched.status, JSON.stringify(launched.body)).toBe(200);
	await t!.runtime.harness.waitForIdle(ctx);
	await sessionRuntime(t!.runtime).idle();
	expect((await view(objective.id)).goal).toBe("Cut the energy bill in half");
});

it("OBJ-42 a session gets 403, and any phase but drafting is 409 wrong_phase", async () => {
	await start([{ text: "I am the lead." }]);
	const objective = await draft("Wrong from the start");
	const member = await seedSession(objective.id);

	// The user only: a session's objective is a proposal, and the user decides what it says.
	const refused = await t!.client.post(`/objectives/${objective.id}/goal`, { goal: "A session's goal" }, { caller: member });
	expect(refused.status).toBe(403);
	expect((refused.body as { error: { code: string } }).error.code).toBe("forbidden");
	expect((await command("objective goal set", { id: objective.id, goal: "A session's goal" }, member)).exitCode).toBe(1);
	expect((await view(objective.id)).goal).toBe("Wrong from the start");
	expect(await goalEvents(objective.id)).toEqual([]);

	// Active: the goal is the lead's instruction and its members' context by then.
	await t!.client.post(`/objectives/${objective.id}/launch`);
	const active = await t!.client.post(`/objectives/${objective.id}/goal`, { goal: "A different job entirely" });
	expect(active.status).toBe(409);
	expect((active.body as { error: { code: string; phase: string } }).error).toMatchObject({ code: "wrong_phase", phase: "active" });
	expect((await command("objective goal set", { id: objective.id, goal: "A different job entirely" })).exitCode).toBe(3);

	await t!.client.post(`/objectives/${objective.id}/stop`);
	expect((await t!.client.post(`/objectives/${objective.id}/goal`, { goal: "A stopped job" })).status).toBe(409);
	expect((await t!.client.post(`/objectives/${objective.id}/done`)).status).toBe(200);
	expect((await t!.client.post(`/objectives/${objective.id}/goal`, { goal: "A done job" })).status).toBe(409);
	expect((await t!.client.post(`/objectives/${objective.id}/archive`)).status).toBe(200);
	expect((await t!.client.post(`/objectives/${objective.id}/goal`, { goal: "An archived job" })).status).toBe(409);
	expect((await view(objective.id)).goal).toBe("Wrong from the start");
	expect(await goalEvents(objective.id)).toEqual([]);
});

it("OBJ-42 a goal is required, and both or neither flag is the usage error create gives", async () => {
	await start();
	const objective = await draft("One goal, one text");

	// The API sees only text, so a body with no goal (or an empty one) is the 400 `create` answers.
	for (const body of [{}, { goal: "" }, { goal: "   " }, { goal: 7 }]) {
		const res = await t!.client.post(`/objectives/${objective.id}/goal`, body);
		expect(res.status, JSON.stringify(body)).toBe(400);
		expect((res.body as { error: { code: string } }).error.code, JSON.stringify(body)).toBe("missing_goal");
	}
	expect((await view(objective.id)).goal).toBe("One goal, one text");
	expect(await goalEvents(objective.id)).toEqual([]);

	// The flag rule is `create`'s: exactly one of --goal and --goal-file, and the CLI says which.
	for (const params of [{}, { goal: "inline", "goal-file": join(t!.dir, "goal.txt") }]) {
		const outcome = await command("objective goal set", { id: objective.id, ...params });
		expect(outcome.usage, JSON.stringify(outcome.body)).toBe(true);
		expect(outcome.exitCode).toBe(2);
		expect(outcome.message).toContain("give one of --goal TEXT or --goal-file PATH");
	}
	expect(await goalEvents(objective.id)).toEqual([]);

	// Every goal write, and none of the ones the CLI refused, is in the objective's history.
	writeFileSync(join(t!.dir, "goal.txt"), "Read from a file\n");
	const fromFile = await command("objective goal set", { id: objective.id, "goal-file": join(t!.dir, "goal.txt") });
	expect(fromFile.exitCode, JSON.stringify(fromFile.body)).toBe(0);
	expect((await view(objective.id)).goal).toBe("Read from a file\n");

	// The command is advertised with both forms, so `--help` names the file variant too.
	const spec = OBJECTIVE_COMMANDS.find((entry) => entry.path.join(" ") === "objective goal set");
	expect(spec?.usage).toBe("pana objective goal set OBJECTIVE --goal TEXT");
	expect(spec?.altUsage).toEqual(["pana objective goal set OBJECTIVE --goal-file PATH"]);
});
