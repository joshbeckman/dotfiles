// Spend: per-session and per-local-day cost (LIM-02, LIM-03, LIM-04).
//
// pi-durable keeps a running `pi.usage` total per conversation. Pana stores the total it last
// saw on `sessions.cost_usd` and adds each increase to `domain_costs` for the local day it was
// seen, in `config.timezone`. A day boundary is found by search rather than offset arithmetic,
// so DST and odd zones need no special cases.

import type { SqliteExecutor } from "@earendil-works/chord/sqlite";
import type { UsageState } from "@earendil-works/pi-durable";
import type { Runtime } from "../server/runtime.ts";

type UsageLike = { cost?: { total?: number } } | undefined;

/** Total cost in US dollars across a conversation's model and tool usage. */
export function usageCost(usage: Readonly<UsageState> | undefined | null): number {
	if (!usage) return 0;
	let total = 0;
	for (const bucket of [usage.models, usage.tools]) {
		for (const entry of Object.values(bucket ?? {})) total += (entry as UsageLike)?.cost?.total ?? 0;
	}
	return total;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** `YYYY-MM-DD` of `at` in `timezone`. */
export function localDay(at: number, timezone: string): string {
	let format = formatters.get(timezone);
	if (!format) {
		format = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
		formatters.set(timezone, format);
	}
	return format.format(new Date(at));
}

/** The first millisecond (to the second) after `at` that falls on another local day. */
export function nextDayStart(at: number, timezone: string): number {
	const today = localDay(at, timezone);
	let lo = at;
	let hi = at + 48 * 3_600_000;
	while (hi - lo > 1000) {
		const mid = Math.floor((lo + hi) / 2);
		if (localDay(mid, timezone) === today) lo = mid;
		else hi = mid;
	}
	return hi;
}

export function today(runtime: Runtime): string {
	return localDay(runtime.clock.now(), runtime.config.timezone);
}

/** Today's domain spend. */
export async function domainCostToday(db: SqliteExecutor, runtime: Runtime): Promise<number> {
	const row = await db.get<{ cost_usd: number }>("SELECT cost_usd FROM domain_costs WHERE day = ?", today(runtime));
	return row?.cost_usd ?? 0;
}

/** LIM-03: today's spend has passed `budget.domainDailyUsd`. */
export async function overDomainBudget(db: SqliteExecutor, runtime: Runtime): Promise<boolean> {
	return (await domainCostToday(db, runtime)) > runtime.config.budget.domainDailyUsd;
}

export interface CostUpdate {
	sessionCost: number;
	dayCost: number;
	/** True when this update is the first to see today's spend over budget. */
	dayCrossed: boolean;
}

/** Record a session's new usage total and charge any increase to today. */
export async function recordCost(tx: SqliteExecutor, runtime: Runtime, sessionId: string, total: number): Promise<CostUpdate | undefined> {
	const row = await tx.get<{ cost_usd: number }>("SELECT cost_usd FROM sessions WHERE id = ?", sessionId);
	if (!row) return undefined;
	const delta = total - row.cost_usd;
	const day = today(runtime);
	if (delta > 0) {
		await tx.run("UPDATE sessions SET cost_usd = ? WHERE id = ?", total, sessionId);
		await tx.run(
			"INSERT INTO domain_costs (day, cost_usd) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET cost_usd = cost_usd + excluded.cost_usd",
			day,
			delta,
		);
	}
	const dayRow = await tx.get<{ cost_usd: number; noticed_at: number | null }>("SELECT cost_usd, noticed_at FROM domain_costs WHERE day = ?", day);
	const dayCost = dayRow?.cost_usd ?? 0;
	const dayCrossed = dayCost > runtime.config.budget.domainDailyUsd && dayRow?.noticed_at == null;
	if (dayCrossed) await tx.run("UPDATE domain_costs SET noticed_at = ? WHERE day = ?", runtime.clock.now(), day);
	return { sessionCost: Math.max(total, row.cost_usd), dayCost, dayCrossed };
}
