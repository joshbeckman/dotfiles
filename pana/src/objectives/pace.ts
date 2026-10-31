// Pace against a deadline (OBJ-08).
//
// An objective may carry a `dueAt`. For each metric with a target, the pace it needs is the
// distance still to cover divided by the time still left; the pace it has is the distance covered
// since its baseline divided by the time since. When the achieved pace, carried to the deadline,
// falls short, the metric is `behind`, and the objective reports the condition `behind`.
//
// This module owns that arithmetic and nothing else, so the stranded sweep (OBJ-06) and the lead's
// briefing (OBJ-32, `obj/brief-escalation`) compute one number: the briefing calls `metricPaces`
// rather than growing a second copy. `behind` never blocks a run; it is a fact the lead and the
// user act on.
//
// The baseline is a metric's first reading and the current value is OBJ-27's, which `metrics.ts`
// derives (`raw` is the latest reading; `mean` is the mean over the trailing window). `metricPaces`
// reads through `metricView`, so a pace is always measured against the value every other surface
// shows rather than against a second copy of the aggregation rule.

import type { SqliteExecutor } from "@earendil-works/chord/sqlite";
import { metricRows, metricView, type MetricReadingRow } from "./metrics.ts";
import type { ObjectiveRow } from "./schema.ts";

export const DAY_MS = 24 * 60 * 60 * 1000;

export interface MetricReading {
	at: number;
	value: number;
}

export interface MetricPace {
	name: string;
	unit: string;
	direction: "up" | "down";
	target: number;
	baseline: number;
	current: number;
	/** Days from the baseline reading to the deadline. */
	spanDays: number;
	/** Days from the baseline reading to now. */
	elapsedDays: number;
	/** Days from now to the deadline; 0 once the deadline has passed. */
	remainingDays: number;
	/** The distance still to cover; 0 once the metric is at or past its target. */
	remaining: number;
	/** The distance a day it must average over the time left; `Infinity` when the deadline passed short of target. */
	requiredPerDay: number;
	/** The distance a day it has averaged so far; null before any time has passed. */
	achievedPerDay: number | null;
	/** True when the achieved pace, carried to the deadline, falls short of the target. */
	behind: boolean;
}

export interface PaceInput {
	name: string;
	unit: string;
	direction: "up" | "down";
	target: number;
	/** The first reading (OBJ-25). */
	baseline: MetricReading;
	/** The metric's current value (OBJ-27), and the time it is read at. */
	current: number;
	now: number;
	dueAt: number;
}

/**
 * One metric's pace (OBJ-08). Direction decides which way is progress: `up` means a larger value
 * is closer to the target, `down` a smaller one. A metric already at or past its target is never
 * behind, however little time is left.
 */
export function paceOf(input: PaceInput): MetricPace {
	const sign = input.direction === "up" ? 1 : -1;
	// Distances in the direction of progress, so one formula covers both directions.
	const needed = (input.target - input.baseline.value) * sign;
	const covered = (input.current - input.baseline.value) * sign;
	const spanDays = (input.dueAt - input.baseline.at) / DAY_MS;
	const elapsedDays = Math.max(0, (input.now - input.baseline.at) / DAY_MS);
	const remainingDays = Math.max(0, (input.dueAt - input.now) / DAY_MS);
	const remaining = Math.max(0, needed - covered);
	const achievedPerDay = elapsedDays > 0 ? covered / elapsedDays : null;
	let requiredPerDay: number;
	if (remaining <= 0) requiredPerDay = 0;
	else if (remainingDays <= 0) requiredPerDay = Infinity;
	else requiredPerDay = remaining / remainingDays;
	// A metric with no elapsed time has no achieved pace to compare; it is behind only when the
	// deadline has already passed short of its target. The epsilon keeps a metric exactly on pace
	// from flipping behind on floating-point noise.
	const behind = remaining > 0 && (remainingDays <= 0 || (achievedPerDay !== null && achievedPerDay + 1e-9 < requiredPerDay));
	return {
		name: input.name,
		unit: input.unit,
		direction: input.direction,
		target: input.target,
		baseline: input.baseline.value,
		current: input.current,
		spanDays,
		elapsedDays,
		remainingDays,
		remaining,
		requiredPerDay,
		achievedPerDay,
		behind,
	};
}

/**
 * Every targeted metric's pace against the objective's `dueAt`, ordered by name (OBJ-08). Empty
 * for an objective with no deadline, and for metrics with no target (the infinite case, OBJ-25).
 * A metric with no reading has no baseline, and one whose `mean` window holds nothing is stale
 * (OBJ-27); neither has a pace, so neither is left to accuse the objective of falling behind.
 */
export async function metricPaces(
	db: SqliteExecutor,
	row: Pick<ObjectiveRow, "id" | "due_at">,
	now: number,
): Promise<MetricPace[]> {
	if (row.due_at === null) return [];
	const metrics = (await metricRows(db, row.id)).filter((metric) => metric.target !== null);
	const paces: MetricPace[] = [];
	for (const metric of metrics) {
		const readings = await db.all<MetricReadingRow>(
			"SELECT objective_id, name, at, value, source FROM metric_readings WHERE objective_id = ? AND name = ? ORDER BY at, id",
			row.id,
			metric.name,
		);
		const view = metricView(metric, readings, now);
		const baseline = readings[0];
		if (baseline === undefined || view.current.value === null) continue;
		paces.push(
			paceOf({
				name: metric.name,
				unit: metric.unit,
				direction: metric.direction,
				target: metric.target as number,
				baseline: { at: baseline.at, value: baseline.value },
				current: view.current.value,
				now,
				dueAt: row.due_at,
			}),
		);
	}
	return paces;
}

/** The metrics with no path to their target (OBJ-08). Empty means the objective is on pace. */
export function behindPaces(paces: readonly MetricPace[]): MetricPace[] {
	return paces.filter((pace) => pace.behind);
}

/** A number a person reads: at most two decimals, no trailing zeros. */
export function paceNumber(value: number): string {
	if (!Number.isFinite(value)) return "∞";
	return String(Number(value.toFixed(2)));
}

/**
 * One metric's pace in a line, for the briefing and the notice: what it needs a day against what
 * it has moved. `direction` is carried by the numbers themselves, so "needs -0.5" reads as a
 * downward pace.
 */
export function paceLine(pace: MetricPace): string {
	if (pace.remaining <= 0) return `${pace.name} (${pace.unit}): at its ${paceNumber(pace.target)} target`;
	const need = pace.requiredPerDay === Infinity ? "no time left" : `${paceNumber(pace.requiredPerDay)} ${pace.unit}/day`;
	const have = pace.achievedPerDay === null ? "no pace yet" : `${paceNumber(pace.achievedPerDay)} ${pace.unit}/day`;
	return `${pace.name} (${pace.unit}): needs ${need}, has moved ${have}`;
}
