// The two notices that keep an objective honest, on `runtime.clock`.
//
// OBJ-06: every active objective with nothing to move it — no member `running` or `waiting`, no
// active wake or hold for any member, no metric check due in the future — is stranded, and the
// user is told once, by name, so a dead objective cannot sit silent. The state itself is
// `objectiveState` (OBJ-03), never derived again here, so the notice agrees with every read. It is
// not repeated until the objective has moved and stranded again, and it wakes nothing: a notice
// delivers to users only (NTC-01), so no session run starts.
//
// OBJ-08: an active objective with a `dueAt` and no path to it reports `behind`, separately from
// `stranded`, and the user is told once. `behind` blocks nothing; the arithmetic is `pace.ts`, and
// the briefing calls the same `metricPaces`.
//
// Both stamps are notice timestamps, not states (`stranded_noticed_at`, `behind_noticed_at`). A
// sweep that finds the condition gone clears its stamp, so "moved and stranded again" notices
// again.
//
// OBJ-22's rule — a condition that is not the objective's fault is not reported as stranded, and
// resolving it is the user's or the clock's business — applies to every standing condition, and
// none of them needs a hook here. A budget pause (OBJ-20..22) is already `idle` in
// `objectiveState` (it asks `limits.ts`'s `objectivePaused`), so the notice inherits it. An
// objective waiting on the user (OBJ-33) is the one hold the derived state does not carry, so the
// awaiting-user read below is the sweep's own.

import type { SqliteExecutor } from "@earendil-works/chord/sqlite";
import type { Runtime } from "../server/runtime.ts";
import { postNotice } from "../threads/store.ts";
import { behindPaces, metricPaces, paceLine, type MetricPace } from "./pace.ts";
import type { ObjectiveRow } from "./schema.ts";
import { objectiveState, objectiveUrl, recordObjectiveEvent } from "./state.ts";

/** OBJ-06: at least every five minutes, the ISO-07 interval. */
export const OBJECTIVE_SWEEP_MS = 5 * 60 * 1000;

export interface ObjectiveNotice {
	objective: string;
	/** The notice message. */
	message: string;
	messageUrl: string;
	/** What the notice says, for a log or a test. */
	body: string;
}

export interface ObjectiveSweepResult {
	stranded: ObjectiveNotice[];
	behind: ObjectiveNotice[];
}

/**
 * One pass of both notices. Split from the timer so a test can drive it directly and so panad's
 * startup sweep runs it once before the first interval.
 */
export async function sweepObjectives(runtime: Runtime): Promise<ObjectiveSweepResult> {
	const rows = await runtime.db.all<ObjectiveRow>("SELECT * FROM objectives WHERE phase = 'active' ORDER BY id");
	const result: ObjectiveSweepResult = { stranded: [], behind: [] };
	for (const row of rows) {
		const stranded = await strandIfStranded(runtime, row);
		if (stranded) result.stranded.push(stranded);
		const behind = await noticeIfBehind(runtime, row);
		if (behind) result.behind.push(behind);
	}
	return result;
}

/**
 * OBJ-06: post the stranded notice when the derived state says `stranded` and no standing
 * condition holds it. The state is read again here rather than trusted from a list, so a wake that
 * arrived mid-sweep is seen.
 */
async function strandIfStranded(runtime: Runtime, row: ObjectiveRow): Promise<ObjectiveNotice | undefined> {
	const now = runtime.clock.now();
	const stranded = await isStranded(runtime, row);
	if (!stranded) {
		if (row.stranded_noticed_at !== null) await clearStamp(runtime, row.id, "stranded_noticed_at");
		return undefined;
	}
	if (row.stranded_noticed_at !== null) return undefined;
	const body = strandedNotice(runtime, row);
	const notice = await postNotice(runtime, { thread: row.thread_id ?? undefined, body });
	await stamp(runtime, row, "stranded_noticed_at", now, {
		kind: "stranded",
		detail: { message: notice.message.id, messageUrl: notice.message.url },
	});
	return { objective: row.id, message: notice.message.id, messageUrl: notice.message.url, body };
}

/** OBJ-06 and OBJ-22: stranded means the derived state says so and no hold of its own applies. */
async function isStranded(runtime: Runtime, row: ObjectiveRow): Promise<boolean> {
	if ((await objectiveState(runtime.db, runtime, row)) !== "stranded") return false;
	if (await awaitingUser(runtime.db, row.id)) return false;
	return true;
}

/**
 * OBJ-08: post the behind notice once while an active objective with a `dueAt` has a targeted
 * metric with no path to it; clear the stamp when every metric is on pace again.
 */
async function noticeIfBehind(runtime: Runtime, row: ObjectiveRow): Promise<ObjectiveNotice | undefined> {
	const now = runtime.clock.now();
	const paces = row.due_at === null ? [] : behindPaces(await metricPaces(runtime.db, row, now));
	if (paces.length === 0) {
		if (row.behind_noticed_at !== null) await clearStamp(runtime, row.id, "behind_noticed_at");
		return undefined;
	}
	if (row.behind_noticed_at !== null) return undefined;
	const body = behindNotice(runtime, row, paces);
	const notice = await postNotice(runtime, { thread: row.thread_id ?? undefined, body });
	await stamp(runtime, row, "behind_noticed_at", now, {
		kind: "behind",
		detail: { message: notice.message.id, messageUrl: notice.message.url, metrics: paces.map((pace) => pace.name) },
	});
	return { objective: row.id, message: notice.message.id, messageUrl: notice.message.url, body };
}

/**
 * OBJ-33/34: an open escalation is the user's move, so the objective is held rather than stranded.
 * `obj/brief-escalation` owns the writes; this is the read the sweep needs to agree with it.
 */
async function awaitingUser(db: SqliteExecutor, objectiveId: string): Promise<boolean> {
	const row = await db.get<{ id: string }>(
		"SELECT id FROM objective_escalations WHERE objective_id = ? AND state = 'open' LIMIT 1",
		objectiveId,
	);
	return row !== undefined;
}

/** Record the notice stamp and why, in one write: never the stamp without the event, or the reverse. */
async function stamp(
	runtime: Runtime,
	row: ObjectiveRow,
	column: "stranded_noticed_at" | "behind_noticed_at",
	now: number,
	event: { kind: "stranded" | "behind"; detail: Record<string, unknown> },
): Promise<void> {
	await runtime.db.write(async (tx) => {
		await tx.run(`UPDATE objectives SET ${column} = ? WHERE id = ?`, now, row.id);
		await recordObjectiveEvent(tx, runtime, { objectiveId: row.id, kind: event.kind, detail: event.detail });
	});
}

/** The objective moved: drop the stamp so the next strand or slip notices again. */
async function clearStamp(runtime: Runtime, objectiveId: string, column: "stranded_noticed_at" | "behind_noticed_at"): Promise<void> {
	await runtime.db.write((tx) => tx.run(`UPDATE objectives SET ${column} = NULL WHERE id = ?`, objectiveId));
}

function day(at: number): string {
	return new Date(at).toISOString().slice(0, 10);
}

/** OBJ-06: name the objective and say why it stopped moving. */
function strandedNotice(runtime: Runtime, row: ObjectiveRow): string {
	const dayMs = 24 * 60 * 60 * 1000;
	const left = row.due_at === null ? "" : ` The objective was due ${day(row.due_at)} (${Math.max(0, Math.ceil((row.due_at - runtime.clock.now()) / dayMs))} days left).`;
	return [
		`Objective ${objectiveUrl(runtime, row.id)} is stranded: nothing will move it.`,
		`No member is running or waiting, no wake is scheduled for any member, and no metric check is due.${left}`,
		"Launch or wake a member, `pana objective regenerate-lead --reason TEXT`, or `pana objective stop` it.",
	].join("\n");
}

/** OBJ-08: name the objective, its deadline, and the pace each short metric needs against what it has. */
function behindNotice(runtime: Runtime, row: ObjectiveRow, paces: readonly MetricPace[]): string {
	const left = Math.max(0, Math.ceil((row.due_at! - runtime.clock.now()) / (24 * 60 * 60 * 1000)));
	const lines = paces.map((pace) => `- ${paceLine(pace)}`).join("\n");
	return [
		`Objective ${objectiveUrl(runtime, row.id)} is behind its ${day(row.due_at!)} deadline (${left} days left).`,
		lines,
		"Every metric with a target must reach it before this objective can be done. Nothing is blocked; the lead and the user act on this.",
	].join("\n");
}

export interface ObjectiveSweeper {
	/** The sweep in progress, if any; tests await it. */
	current(): Promise<ObjectiveSweepResult> | undefined;
	close(): Promise<void>;
}

/** Sweep now, then every five minutes on `runtime.clock`, the way the browser and scratch sweeps do. */
export function startObjectiveSweeper(runtime: Runtime, report: (error: unknown, what: string) => void): ObjectiveSweeper {
	let closed = false;
	let cancel: (() => void) | undefined;
	let inFlight: Promise<ObjectiveSweepResult> | undefined;

	const kick = () => {
		if (closed) return;
		// Armed before the sweep starts, so a slow pass cannot delay the next one, and a swap still
		// running when the timer fires is not doubled. Not background: the test clock declines
		// background timers, and close() cancels this one so it cannot hold panad open.
		cancel = runtime.clock.setTimer(kick, OBJECTIVE_SWEEP_MS, { background: false });
		if (inFlight) return;
		const sweep = sweepObjectives(runtime);
		inFlight = sweep;
		sweep
			.catch((error) => report(error, "objective sweep"))
			.finally(() => {
				if (inFlight === sweep) inFlight = undefined;
			});
	};

	kick();
	return {
		current: () => inFlight,
		async close() {
			closed = true;
			cancel?.();
			await inFlight?.catch(() => undefined);
		},
	};
}
