// The objective's limits, read from rows and never stored (OBJ-19..OBJ-24).
//
// This module is the one place the package answers "how much has this objective spent", "how
// many runs did its lead start today", and "how many messages did it send the user today". The
// admission choke point (`hold.ts`), the view, the briefing seam, and the budget enforcement all
// read the same answers, so they cannot disagree about whether a limit holds.
//
// The day is LIM-03's local day in `config.timezone`, found by search rather than offset
// arithmetic, so SCH-08's DST behavior applies here too.

import type { SqliteExecutor } from "@earendil-works/chord/sqlite";
import { localDay, localDayRange, overDomainBudget } from "../sessions/budget.ts";
import type { Runtime } from "../server/runtime.ts";
import type { EffectiveLimit, ObjectiveEffectiveLimits, ObjectiveRow } from "./schema.ts";

/**
 * The condition that stops an objective's runs (OBJ-20, OBJ-21, OBJ-22). `budget_total` outranks
 * `budget_day`; `domain_budget` is LIM-03's global backstop, which pauses every objective.
 */
export type ObjectivePaused = "budget_total" | "budget_day" | "domain_budget";

/** The local-day range every count in this file uses. */
export function objectiveDay(runtime: Runtime, at = runtime.clock.now()): { start: number; end: number; day: string } {
	const range = localDayRange(at, runtime.config.timezone);
	return { ...range, day: localDay(at, runtime.config.timezone) };
}

/** The objective's spend in the local day, from the per-day ledger (OBJ-20). */
export async function objectiveCostToday(db: SqliteExecutor, runtime: Runtime, objectiveId: string, at = runtime.clock.now()): Promise<number> {
	const row = await db.get<{ cost_usd: number }>(
		"SELECT cost_usd FROM objective_costs WHERE day = ? AND objective_id = ?",
		objectiveDay(runtime, at).day,
		objectiveId,
	);
	return row?.cost_usd ?? 0;
}

/** The objective's lifetime spend: every day's ledger row, the lead included (OBJ-21). */
export async function objectiveCostTotal(db: SqliteExecutor, objectiveId: string): Promise<number> {
	const row = await db.get<{ total: number | null }>(
		"SELECT SUM(cost_usd) AS total FROM objective_costs WHERE objective_id = ?",
		objectiveId,
	);
	return row?.total ?? 0;
}

/**
 * OBJ-20, OBJ-21, OBJ-22: the condition that pauses the objective, or null when it may run.
 * `budget_total` outranks `budget_day`, and both outrank the domain's backstop.
 */
export async function objectivePaused(db: SqliteExecutor, runtime: Runtime, row: ObjectiveRow): Promise<ObjectivePaused | null> {
	if (row.phase !== "active") return null;
	if (row.max_total_usd !== null && (await objectiveCostTotal(db, row.id)) >= row.max_total_usd) return "budget_total";
	if (row.max_daily_usd !== null && (await objectiveCostToday(db, runtime, row.id)) >= row.max_daily_usd) return "budget_day";
	if (await overDomainBudget(db, runtime)) return "domain_budget";
	return null;
}

/** The local-day window for an objective event kind, as a reusable SQL fragment's parameters. */
async function eventsToday(
	db: SqliteExecutor,
	runtime: Runtime,
	objectiveId: string,
	kind: string,
	predicate: string,
	...params: Array<string | number>
): Promise<number> {
	const { start, end } = objectiveDay(runtime);
	const row = await db.get<{ n: number }>(
		`SELECT COUNT(*) AS n FROM objective_events
		  WHERE objective_id = ? AND kind = ? AND at >= ? AND at < ? ${predicate}`,
		objectiveId,
		kind,
		start,
		end,
		...params,
	);
	return row?.n ?? 0;
}

/** OBJ-19: the lead's runs in the local day, one per run it started (`run.started` events). */
export async function leadRunsToday(db: SqliteExecutor, runtime: Runtime, row: ObjectiveRow, leadId = row.lead_id): Promise<number> {
	if (leadId === null) return 0;
	return eventsToday(db, runtime, row.id, "run.started", "AND json_extract(detail, '$.session') = ? AND json_extract(detail, '$.lead') = 1", leadId);
}

/** Every run the objective's sessions started in the local day, the lead included (OBJ-15's rollup). */
export async function objectiveRunsToday(db: SqliteExecutor, runtime: Runtime, row: ObjectiveRow): Promise<number> {
	return eventsToday(db, runtime, row.id, "run.started", "");
}

/**
 * OBJ-18: when the lead's last run ended, or null when it has never run. A run that ended while
 * another was already starting still counts: the quiet interval is between runs, not turns.
 */
export async function lastLeadRunEnd(db: SqliteExecutor, row: ObjectiveRow, leadId = row.lead_id): Promise<number | null> {
	if (leadId === null) return null;
	const found = await db.get<{ at: number | null }>(
		"SELECT MAX(at) AS at FROM objective_events WHERE objective_id = ? AND kind = 'run.ended' AND json_extract(detail, '$.session') = ?",
		row.id,
		leadId,
	);
	return found?.at ?? null;
}

/**
 * OBJ-24: messages delivered to the user in the local day by any session carrying the objective's
 * `objective_id`, the lead included. One message delivered to two users counts once.
 */
export async function objectiveUserMessagesToday(db: SqliteExecutor, runtime: Runtime, row: ObjectiveRow): Promise<number> {
	const { start, end } = objectiveDay(runtime);
	const found = await db.get<{ n: number }>(
		`SELECT COUNT(DISTINCT m.id) AS n
		   FROM messages m
		   JOIN sessions s ON s.id = m.sender_id
		   JOIN deliveries d ON d.message_id = m.id
		   JOIN participants p ON p.id = d.recipient_id AND p.kind = 'user'
		  WHERE s.objective_id = ? AND m.created_at >= ? AND m.created_at < ?`,
		row.id,
		start,
		end,
	);
	return found?.n ?? 0;
}

/** The limits a briefing or a test reads: each count beside the limit it is measured against. */
export interface ObjectiveConditions {
	paused: ObjectivePaused | null;
	leadRunsToday: number;
	maxDailyLeadTurns: number | null;
	userMessagesToday: number;
	maxDailyUserMessages: number;
	spendTodayUsd: number;
	maxDailyUsd: number | null;
	spendTotalUsd: number;
	maxTotalUsd: number | null;
	/** The lead's hold, when one is pending (OBJ-18, OBJ-19, OBJ-24). */
	holdUntil: number | null;
}

/**
 * OBJ-24: the briefing's own answer to "why is the lead not running", in one read. The briefing
 * package renders this; nothing here decides anything.
 */
export async function objectiveConditions(db: SqliteExecutor, runtime: Runtime, row: ObjectiveRow): Promise<ObjectiveConditions> {
	const hold = row.lead_id === null ? undefined : await db.get<{ hold_until: number | null }>("SELECT hold_until FROM sessions WHERE id = ?", row.lead_id);
	return {
		paused: await objectivePaused(db, runtime, row),
		leadRunsToday: await leadRunsToday(db, runtime, row),
		maxDailyLeadTurns: row.max_daily_lead_turns,
		userMessagesToday: await objectiveUserMessagesToday(db, runtime, row),
		maxDailyUserMessages: row.max_daily_user_messages ?? runtime.config.objectives.maxDailyUserMessages,
		spendTodayUsd: await objectiveCostToday(db, runtime, row.id),
		maxDailyUsd: row.max_daily_usd,
		spendTotalUsd: await objectiveCostTotal(db, row.id),
		maxTotalUsd: row.max_total_usd,
		holdUntil: hold?.hold_until ?? null,
	};
}

/**
 * OBJ-39: every limit as a meter must draw it — the value that applies, and where it came from.
 *
 * A limit an objective sets is the objective's (`objective`); one it leaves null falls back to the
 * domain's `config.objectives` where a default exists, which today is `wakeMinMinutes` (OBJ-18) and
 * `maxDailyUserMessages` (OBJ-24), and those gates resolve the fallback exactly as this does. The
 * rest have no default, so `none` means nothing bounds them. `budget.domainDailyUsd` is LIM-03's
 * backstop over every objective, not one objective's limit, so it is not here.
 */
export function effectiveLimits(runtime: Runtime, row: ObjectiveRow): ObjectiveEffectiveLimits {
	const one = (own: number | null, fallback: number | undefined): EffectiveLimit => {
		if (own !== null) return { value: own, source: "objective" };
		if (fallback !== undefined) return { value: fallback, source: "config" };
		return { value: null, source: "none" };
	};
	const config = runtime.config.objectives;
	return {
		maxDailyUsd: one(row.max_daily_usd, undefined),
		maxTotalUsd: one(row.max_total_usd, undefined),
		wakeMinMinutes: one(row.wake_min_minutes, config.wakeMinMinutes),
		maxDailyLeadTurns: one(row.max_daily_lead_turns, undefined),
		maxDailyUserMessages: one(row.max_daily_user_messages, config.maxDailyUserMessages),
		maxActiveMembers: one(row.max_active_members, undefined),
	};
}
