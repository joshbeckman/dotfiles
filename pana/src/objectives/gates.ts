// The lifecycle gates (OBJ-07).
//
// A stopped, done, or archived objective starts no member run (`assertObjectiveOpen` in state.ts,
// called where a session is created and where a delivery would wake one), accepts no member
// create (409 `objective_closed`), and refuses deliveries to its members (409), so a closed
// objective cannot spend by accident. The user resumes it to change that.
//
// Stopping stops the running members and cancels their wakes; archiving cascades to the member
// sessions through the REF-02 path, so their scratch is swept (SCR-04). Obj004's draft has no
// lead, so `stop` and `resume` and `finish` only accept the phases above.

import { ApiError } from "../api/errors.ts";
import type { Caller } from "../api/types.ts";
import { deleteSchedule } from "../schedules/store.ts";
import { sessionRuntime } from "../sessions/index.ts";
import type { Runtime } from "../server/runtime.ts";
import type { ObjectivePhase, ObjectiveRow } from "./schema.ts";
import { loadObjective, objectiveId, objectiveMembers, recordObjectiveEvent } from "./state.ts";
import { showObjective, type ObjectiveView } from "./view.ts";

const ARCHIVABLE_PHASES: readonly ObjectivePhase[] = ["stopped", "done"];

function userOnly(caller: Caller, what: string): void {
	if (caller.kind !== "user") throw ApiError.forbidden(`only the user may ${what} an objective`);
}

function wrongPhase(row: ObjectiveRow, expected: string): ApiError {
	return new ApiError(409, "wrong_phase", `objective ${row.id} is ${row.phase}; ${expected}`, {
		objective: row.id,
		phase: row.phase,
	});
}

async function setPhase(runtime: Runtime, row: ObjectiveRow, phase: ObjectivePhase, kind: string, caller: Caller, detail: Record<string, unknown> = {}): Promise<void> {
	const now = runtime.clock.now();
	await runtime.db.atomically(async (tx) => {
		await tx.run("UPDATE objectives SET phase = ?, updated_at = ? WHERE id = ?", phase, now, row.id);
		await recordObjectiveEvent(tx, runtime, { objectiveId: row.id, kind, actorId: caller.id, detail });
	});
}

/** Members a lifecycle operation reaches: every session carrying the objective, lead included. */
async function liveMembers(runtime: Runtime, objectiveId: string) {
	const members = await objectiveMembers(runtime.db, objectiveId);
	return members.filter((member) => member.state !== "archived" && member.state !== "stopped");
}

/** Active wakes that target any of these sessions (WAK-01's payload shape). */
async function memberWakes(runtime: Runtime, sessionIds: readonly string[]): Promise<string[]> {
	if (sessionIds.length === 0) return [];
	const rows = await runtime.db.all<{ id: string }>(
		`SELECT id FROM schedules
		  WHERE kind = 'wake' AND state = 'active'
		    AND json_extract(payload, '$.session') IN (${sessionIds.map(() => "?").join(",")})`,
		...sessionIds,
	);
	return rows.map((row) => row.id);
}

/**
 * `pana objective stop` (OBJ-07): the user only. Sets `stopped`, stops the members that are not
 * already stopped or archived (recording that the objective stopped them, OBJ-14), cancels their
 * wakes, and records why.
 */
export async function stopObjective(runtime: Runtime, caller: Caller, value: string | null | undefined): Promise<ObjectiveView> {
	userOnly(caller, "stop");
	const id = objectiveId(value, runtime.config.domain);
	const row = await loadObjective(runtime.db, id);
	if (row.phase !== "active") throw wrongPhase(row, "only an active objective can be stopped");

	const members = await liveMembers(runtime, id);
	const wakes = await memberWakes(runtime, members.map((member) => member.id));
	await setPhase(runtime, row, "stopped", "stopped", caller, { members: members.map((member) => member.id), wakes });

	for (const member of members) {
		// The runtime's stop aborts the run and queues nothing; the objective records why (OBJ-14),
		// so a member the user stopped keeps `user` and stays inert.
		await sessionRuntime(runtime).stop(member.id, "objective");
	}
	for (const wake of wakes) await deleteSchedule(runtime, wake);
	return showObjective(runtime, id);
}

/** `pana objective stop --all` (OBJ-07): stop every active objective, newest last. */
export async function stopAllObjectives(runtime: Runtime, caller: Caller): Promise<ObjectiveView[]> {
	userOnly(caller, "stop");
	const rows = await runtime.db.all<ObjectiveRow>("SELECT * FROM objectives WHERE phase = 'active' ORDER BY id");
	const stopped: ObjectiveView[] = [];
	for (const row of rows) stopped.push(await stopObjective(runtime, caller, row.id));
	return stopped;
}

/** `pana objective resume` (OBJ-07): a stopped objective becomes active again. */
export async function resumeObjective(runtime: Runtime, caller: Caller, value: string | null | undefined): Promise<ObjectiveView> {
	userOnly(caller, "resume");
	const id = objectiveId(value, runtime.config.domain);
	const row = await loadObjective(runtime.db, id);
	if (row.phase !== "stopped") throw wrongPhase(row, "only a stopped objective can be resumed");
	await setPhase(runtime, row, "active", "resumed", caller);
	return showObjective(runtime, id);
}

interface MetricRow {
	name: string;
	direction: "up" | "down";
	target: number | null;
}

/**
 * The metrics that are not yet at their target (OBJ-07, OBJ-27). A metric with no target is the
 * infinite case and never blocks `done`; a metric with a target and no reading is not at it.
 */
async function metricsBehind(runtime: Runtime, objectiveId: string): Promise<Array<{ name: string; target: number; value: number | null }>> {
	const metrics = await runtime.db.all<MetricRow>(
		"SELECT name, direction, target FROM objective_metrics WHERE objective_id = ? AND target IS NOT NULL ORDER BY name",
		objectiveId,
	);
	const behind: Array<{ name: string; target: number; value: number | null }> = [];
	for (const metric of metrics) {
		const reading = await runtime.db.get<{ value: number }>(
			"SELECT value FROM metric_readings WHERE objective_id = ? AND name = ? ORDER BY at DESC, id DESC LIMIT 1",
			objectiveId,
			metric.name,
		);
		const value = reading?.value ?? null;
		const target = metric.target as number;
		const at = value !== null && (metric.direction === "up" ? value >= target : value <= target);
		if (!at) behind.push({ name: metric.name, target, value });
	}
	return behind;
}

/**
 * `pana objective done` (OBJ-07, OBJ-17): every metric with a target must be at that target, and
 * the user confirms — or the charter says `autonomy: auto`, which lets the lead finish by itself.
 * An objective with no members and no targets needs nothing else.
 */
export async function finishObjective(runtime: Runtime, caller: Caller, value: string | null | undefined): Promise<ObjectiveView> {
	const id = objectiveId(value, runtime.config.domain);
	const row = await loadObjective(runtime.db, id);
	if (row.phase !== "active" && row.phase !== "stopped") throw wrongPhase(row, "only an active or stopped objective can be done");
	const behind = await metricsBehind(runtime, id);
	if (behind.length > 0) {
		throw new ApiError(409, "metric_behind", `objective ${id} has metrics short of their target`, { objective: id, metrics: behind });
	}
	if (row.autonomy !== "auto") userOnly(caller, "finish");
	await setPhase(runtime, row, "done", "done", caller, { autonomy: row.autonomy });
	return showObjective(runtime, id);
}

/**
 * `pana objective archive` (OBJ-07): `archived` requires `stopped` or `done`. The member sessions
 * go through the REF-02 path, so their scratch is swept (SCR-04) and their threads stay readable.
 */
export async function archiveObjective(runtime: Runtime, caller: Caller, value: string | null | undefined): Promise<ObjectiveView> {
	userOnly(caller, "archive");
	const id = objectiveId(value, runtime.config.domain);
	const row = await loadObjective(runtime.db, id);
	if (!ARCHIVABLE_PHASES.includes(row.phase)) throw wrongPhase(row, "only a stopped or done objective can be archived");

	const members = await objectiveMembers(runtime.db, id);
	await setPhase(runtime, row, "archived", "archived", caller, { members: members.map((member) => member.id) });
	for (const member of members) {
		// An archived member is already done; a stopped one is archived here too, so its scratch goes.
		if (member.state === "archived") continue;
		await sessionRuntime(runtime).archive(member.id);
	}
	return showObjective(runtime, id);
}
