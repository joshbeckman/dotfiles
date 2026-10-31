// Reading an objective: its row, its members, and the state every read derives (OBJ-03).
//
// This module touches only the database. Lifecycle operations that stop, resume, or archive
// sessions live in `gates.ts`, so `src/sessions/` can import the closed-objective checks below
// without a cycle.
//
// OBJ-03: `running`, `idle`, and `stranded` are computed here on every read and stored nowhere.
// Later packages reuse `objectiveState` for the list, the view, the briefing, and the stranded
// notice rather than deriving their own.

import type { SqliteExecutor } from "@earendil-works/chord/sqlite";
import { ApiError } from "../api/errors.ts";
import { isUlid, parseRef, RefError } from "../ids/index.ts";
import type { Runtime } from "../server/runtime.ts";
import { CLOSED_PHASES, type ObjectiveDisplayState, type ObjectiveEventKind, type ObjectiveMemberRow, type ObjectivePhase, type ObjectiveRow } from "./schema.ts";

/** An objective ID from a bare ULID or a `pana://<domain>/objectives/<id>` URL. */
export function objectiveId(value: string | null | undefined, domain: string): string {
	const text = (value ?? "").trim();
	if (isUlid(text)) return text;
	try {
		const ref = parseRef(text, domain);
		if (ref.kind === "objective") return ref.id;
	} catch (error) {
		if (error instanceof RefError) throw ApiError.badRequest(error.code, error.message);
		throw error;
	}
	throw ApiError.badRequest("invalid_objective", `${text || "(empty)"} is not an objective`);
}

export async function objectiveRow(db: SqliteExecutor, id: string): Promise<ObjectiveRow | undefined> {
	return db.get<ObjectiveRow>("SELECT * FROM objectives WHERE id = ?", id);
}

/** The objective or a 404. */
export async function loadObjective(db: SqliteExecutor, id: string): Promise<ObjectiveRow> {
	const row = await objectiveRow(db, id);
	if (!row) throw ApiError.notFound(`objective ${id}`);
	return row;
}

/** A session's `pana://` URL, for a view that names its lead and members. */
export function sessionUrl(runtime: Runtime, id: string): string {
	return runtime.url({ kind: "session", id });
}

export function objectiveUrl(runtime: Runtime, id: string): string {
	return runtime.url({ kind: "objective", id });
}

/** The lead and every member: the sessions carrying this objective's `id` (OBJ-15). */
export async function objectiveMembers(db: SqliteExecutor, objectiveId: string): Promise<ObjectiveMemberRow[]> {
	return db.all<ObjectiveMemberRow>(
		`SELECT s.id AS id, p.url AS url, s.state AS state, s.parent AS parent, s.objective_id AS objective_id,
		        s.stopped_by AS stopped_by, s.hold_until AS hold_until
		   FROM sessions s
		   JOIN participants p ON p.id = s.id
		  WHERE s.objective_id = ?
		  ORDER BY s.created_at, s.id`,
		objectiveId,
	);
}

/**
 * OBJ-03: the display state of an objective.
 *
 * `running` when any member session is `running` or `waiting`; else `idle` when an active wake
 * targets a member (or the lead is under a hold, which persists as one, OBJ-18) or a metric check
 * is due in the future (OBJ-26, read ahead so a measured objective is not called stranded between
 * checks); else `stranded`. A phase other than `active` has no display state: the phase is what a
 * reader shows.
 */
export async function objectiveState(db: SqliteExecutor, runtime: Runtime, row: ObjectiveRow): Promise<ObjectiveDisplayState | null> {
	if (row.phase !== "active") return null;
	const members = await objectiveMembers(db, row.id);
	if (members.some((member) => member.state === "running" || member.state === "waiting")) return "running";
	if (members.some((member) => member.hold_until !== null && member.hold_until > runtime.clock.now())) return "idle";
	if (await hasPendingWake(db, members.map((member) => member.id))) return "idle";
	if (await hasFutureCheck(db, row.id, runtime.clock.now())) return "idle";
	return "stranded";
}

/** A pending wake for any of these sessions, in the WAK-01 payload shape. A hold counts. */
async function hasPendingWake(db: SqliteExecutor, sessionIds: readonly string[]): Promise<boolean> {
	if (sessionIds.length === 0) return false;
	const row = await db.get<{ id: string }>(
		`SELECT id FROM schedules
		  WHERE kind = 'wake' AND state = 'active' AND next_at IS NOT NULL
		    AND json_extract(payload, '$.session') IN (${sessionIds.map(() => "?").join(",")})
		  LIMIT 1`,
		...sessionIds,
	);
	return row !== undefined;
}

/** A metric check the scheduler will run in the future (OBJ-26). */
async function hasFutureCheck(db: SqliteExecutor, objectiveId: string, now: number): Promise<boolean> {
	const row = await db.get<{ name: string }>(
		"SELECT name FROM objective_metrics WHERE objective_id = ? AND next_check_at IS NOT NULL AND next_check_at > ? LIMIT 1",
		objectiveId,
		now,
	);
	return row !== undefined;
}

/**
 * OBJ-07: the objective a session acts for, when that objective is closed, so a caller can refuse
 * a member create or a delivery with 409 `objective_closed`. Undefined for a session outside an
 * objective, or one whose objective is still drafting or active.
 */
export async function closedObjectiveOf(db: SqliteExecutor, sessionId: string): Promise<{ id: string; phase: ObjectivePhase } | undefined> {
	const row = await db.get<{ id: string; phase: ObjectivePhase }>(
		`SELECT o.id AS id, o.phase AS phase
		   FROM sessions s JOIN objectives o ON o.id = s.objective_id
		  WHERE s.id = ?`,
		sessionId,
	);
	if (!row || !CLOSED_PHASES.includes(row.phase)) return undefined;
	return row;
}

/** OBJ-07: refuse work for a closed objective, naming the phase so the caller can say why. */
export async function assertObjectiveOpen(db: SqliteExecutor, sessionId: string): Promise<void> {
	const closed = await closedObjectiveOf(db, sessionId);
	if (!closed) return;
	throw new ApiError(409, "objective_closed", `objective ${closed.id} is ${closed.phase}; the user resumes it to change that`, {
		objective: closed.id,
		phase: closed.phase,
		session: sessionId,
	});
}

export interface ObjectiveEventInput {
	objectiveId: string;
	kind: ObjectiveEventKind | (string & {});
	detail?: Record<string, unknown>;
	actorId?: string | null;
}

/** OBJ-23: record why something happened. Append-only; never updated or deleted. */
export async function recordObjectiveEvent(tx: SqliteExecutor, runtime: Runtime, input: ObjectiveEventInput): Promise<string> {
	const id = runtime.newId();
	await tx.run(
		"INSERT INTO objective_events (id, objective_id, at, kind, detail, actor_id) VALUES (?, ?, ?, ?, ?, ?)",
		id,
		input.objectiveId,
		runtime.clock.now(),
		input.kind,
		JSON.stringify(input.detail ?? {}),
		input.actorId ?? null,
	);
	return id;
}
