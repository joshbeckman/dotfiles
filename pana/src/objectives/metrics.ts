// Objective metrics (OBJ-25, OBJ-27, OBJ-28, OBJ-29).
//
// A metric is a declared measure: a slug name, a unit, a direction, an optional target, and an
// aggregation over append-only readings. Two numbers are derived on every read and stored nowhere:
//
// - the **baseline** is the metric's first reading, so nothing is ever typed into it;
// - the **current value** is the latest reading for `raw`, and the mean of the readings inside a
//   trailing window for `mean`, so a noisy daily measurement reads as a trend, not a sawtooth.
//
// `target: null` is the infinite case: the metric never finishes the objective and reports no
// progress (OBJ-25). A window with no readings in it reports the metric stale, never zero
// (OBJ-27). Progress is per metric and never aggregated into one number (OBJ-28).
//
// Readings are append-only: no code path issues UPDATE or DELETE on `metric_readings`, and
// `test/objective-metrics.test.ts` greps this source for one, as EDT-04 does for messages.
//
// The check columns live on the metric itself (OBJ-26); `metric-checks.ts` runs them on the
// scheduler's clock with no session. This file only declares and validates them.
//
// OBJ-29: a target is the user's to set or remove, and a session's attempt is 403. Once a metric
// has its first reading it is frozen for sessions — a lead that can redefine what it is measured
// against can report anything — and only the user may edit it afterwards.

import type { SqliteExecutor } from "@earendil-works/chord/sqlite";
import { isAbsolute } from "node:path";
import { ApiError } from "../api/errors.ts";
import type { Caller } from "../api/types.ts";
import { nextCronAt, parseDuration } from "../schedules/store.ts";
import type { CheckResult } from "../schedules/check.ts";
import type { Runtime } from "../server/runtime.ts";
import { CLOSED_PHASES, objectBody, type ObjectivePhase, type ObjectiveRow } from "./schema.ts";
import { loadObjective, objectiveId, objectiveUrl, recordObjectiveEvent } from "./state.ts";

export type MetricDirection = "up" | "down";
export type MetricAggregation = "raw" | "mean";
export type ReadingSource = "lead" | "user" | "check";

export const METRIC_DIRECTIONS: readonly MetricDirection[] = ["up", "down"];
export const METRIC_AGGREGATIONS: readonly MetricAggregation[] = ["raw", "mean"];
export const READING_SOURCES: readonly ReadingSource[] = ["lead", "user", "check"];

/** OBJ-25: a slug of [a-z0-9-], 1 to 40 long. */
export const METRIC_NAME = /^[a-z0-9-]{1,40}$/;

/** The `objective_metrics` row. `check_command` and `window_spec` avoid SQLite's keywords. */
export interface MetricRow {
	objective_id: string;
	name: string;
	unit: string;
	direction: MetricDirection;
	target: number | null;
	aggregation: MetricAggregation;
	window_spec: string | null;
	check_command: string | null;
	check_cwd: string | null;
	check_every: string | null;
	check_cron: string | null;
	next_check_at: number | null;
	last_check: string | null;
	frozen_at: number | null;
	created_at: number;
}

/** A `metric_readings` row. Append-only, so it has no `updated_at` (OBJ-25). */
export interface MetricReadingRow {
	objective_id: string;
	name: string;
	at: number;
	value: number;
	source: ReadingSource;
}

// --- Rendering -----------------------------------------------------------------

/**
 * OBJ-27: a unit renders with every value. Display rounds to at most three decimals so a mean
 * reads as `79.54 kg` rather than `79.54333333333334 kg`; the stored value keeps its precision.
 */
export function formatValue(unit: string, value: number): string {
	const rounded = Number(value.toFixed(3));
	const text = String(rounded);
	return unit.length === 0 ? text : `${text} ${unit}`;
}

// --- Reads ---------------------------------------------------------------------

export async function metricRows(db: SqliteExecutor, objective: string): Promise<MetricRow[]> {
	return db.all<MetricRow>("SELECT * FROM objective_metrics WHERE objective_id = ? ORDER BY name", objective);
}

export async function metricRow(db: SqliteExecutor, objective: string, name: string): Promise<MetricRow | undefined> {
	return db.get<MetricRow>("SELECT * FROM objective_metrics WHERE objective_id = ? AND name = ?", objective, name);
}

/** Every metric's readings in time order, oldest first, keyed by metric name (OBJ-28). */
async function readingsByName(db: SqliteExecutor, objective: string): Promise<Map<string, MetricReadingRow[]>> {
	const rows = await db.all<MetricReadingRow>(
		"SELECT objective_id, name, at, value, source FROM metric_readings WHERE objective_id = ? ORDER BY at, id",
		objective,
	);
	const grouped = new Map<string, MetricReadingRow[]>();
	for (const row of rows) {
		const list = grouped.get(row.name);
		if (list) list.push(row);
		else grouped.set(row.name, [row]);
	}
	return grouped;
}

export interface MetricReadingView {
	at: number;
	value: number;
	source: ReadingSource;
	/** The value with its unit, as every surface renders it (OBJ-27). */
	display: string;
}

/** OBJ-27: the aggregated value. `value: null` with `stale: true` means nothing to show. */
export interface MetricCurrentView {
	value: number | null;
	/** The time of the reading the value comes from, or of the newest reading in the window. */
	at: number | null;
	/** True when the aggregation has no readings in its scope, so the metric is stale, never zero. */
	stale: boolean;
	display: string | null;
}

/** The metric's check, in SCH-10's shape for `lastCheck` (OBJ-26). */
export interface MetricCheckView {
	command: string;
	cwd: string;
	every: string | null;
	cron: string | null;
	nextCheckAt: number | null;
	lastCheck: CheckResult | null;
}

export interface MetricView {
	objectiveId: string;
	name: string;
	unit: string;
	direction: MetricDirection;
	target: number | null;
	targetDisplay: string | null;
	aggregation: MetricAggregation;
	window: string | null;
	/** OBJ-25: the first reading, never a typed number. Null before the first reading. */
	baseline: number | null;
	baselineDisplay: string | null;
	current: MetricCurrentView;
	/** OBJ-27/28: at its target? Null with no target (the infinite case). */
	atTarget: boolean | null;
	/** OBJ-29: frozen for sessions since the first reading. Editable by the user alone. */
	frozen: boolean;
	/** Null when the metric has no check. */
	check: MetricCheckView | null;
	/** OBJ-28: every reading, in time order, oldest first. */
	readings: MetricReadingView[];
	createdAt: number;
}

export interface MetricsView {
	objective: { id: string; url: string; phase: ObjectivePhase };
	metrics: MetricView[];
	/**
	 * OBJ-28's "3 of 5 at target": a count of metrics, each against its own target. Never a
	 * percent-to-target total, which would average mixed units into one number.
	 */
	atTarget: { count: number; of: number };
}

/** A stored window, as milliseconds, or null when it cannot be read. A read never throws. */
function storedWindowMs(spec: string | null): number | null {
	if (spec === null) return null;
	try {
		return parseDuration(spec);
	} catch {
		return null;
	}
}

/** OBJ-27: the aggregated value of one metric at `now`. */
export function aggregate(row: MetricRow, readings: readonly MetricReadingRow[], now: number): MetricCurrentView {
	if (readings.length === 0) return { value: null, at: null, stale: true, display: null };
	const windowMs = row.aggregation === "mean" ? storedWindowMs(row.window_spec) : null;
	if (windowMs === null) {
		const latest = readings[readings.length - 1]!;
		return { value: latest.value, at: latest.at, stale: false, display: formatValue(row.unit, latest.value) };
	}
	const inside = readings.filter((reading) => reading.at >= now - windowMs);
	if (inside.length === 0) return { value: null, at: null, stale: true, display: null };
	const mean = inside.reduce((sum, reading) => sum + reading.value, 0) / inside.length;
	return { value: mean, at: inside[inside.length - 1]!.at, stale: false, display: formatValue(row.unit, mean) };
}

/** OBJ-07/OBJ-27: whether the metric is at its target. Null is the infinite case. */
function atTarget(row: MetricRow, current: MetricCurrentView): boolean | null {
	if (row.target === null) return null;
	if (current.value === null) return false;
	return row.direction === "up" ? current.value >= row.target : current.value <= row.target;
}

function parseLastCheck(row: MetricRow): CheckResult | null {
	if (row.last_check === null) return null;
	try {
		const parsed = JSON.parse(row.last_check) as CheckResult;
		return parsed && typeof parsed === "object" ? parsed : null;
	} catch {
		// A corrupt diagnostic stays opaque rather than failing the whole read.
		return null;
	}
}

/** One metric's view from rows already in hand. */
export function metricView(row: MetricRow, readings: readonly MetricReadingRow[], now: number): MetricView {
	const current = aggregate(row, readings, now);
	const first = readings[0];
	return {
		objectiveId: row.objective_id,
		name: row.name,
		unit: row.unit,
		direction: row.direction,
		target: row.target,
		targetDisplay: row.target === null ? null : formatValue(row.unit, row.target),
		aggregation: row.aggregation,
		window: row.window_spec,
		baseline: first?.value ?? null,
		baselineDisplay: first === undefined ? null : formatValue(row.unit, first.value),
		current,
		atTarget: atTarget(row, current),
		frozen: row.frozen_at !== null,
		check:
			row.check_command === null
				? null
				: {
						command: row.check_command,
						cwd: row.check_cwd ?? process.cwd(),
						every: row.check_every,
						cron: row.check_cron,
						nextCheckAt: row.next_check_at,
						lastCheck: parseLastCheck(row),
					},
		readings: readings.map((reading) => ({
			at: reading.at,
			value: reading.value,
			source: reading.source,
			display: formatValue(row.unit, reading.value),
		})),
		createdAt: row.created_at,
	};
}

/**
 * `GET /objectives/:id/metrics` (OBJ-28): each metric's readings in time order, its target, and
 * its current value, plus the count at target. Nothing here is a stored or derived percentage.
 */
export async function listMetrics(runtime: Runtime, value: string | null | undefined): Promise<MetricsView> {
	const id = objectiveId(value, runtime.config.domain);
	const objective = await loadObjective(runtime.db, id);
	const rows = await metricRows(runtime.db, id);
	const grouped = await readingsByName(runtime.db, id);
	const now = runtime.clock.now();
	const metrics = rows.map((row) => metricView(row, grouped.get(row.name) ?? [], now));
	const targeted = metrics.filter((metric) => metric.target !== null);
	return {
		objective: { id: objective.id, url: objectiveUrl(runtime, objective.id), phase: objective.phase },
		metrics,
		atTarget: { count: targeted.filter((metric) => metric.atTarget === true).length, of: targeted.length },
	};
}

/** One metric's current view, for the write routes' responses. */
async function freshMetric(runtime: Runtime, id: string, name: string): Promise<MetricView> {
	const row = await metricRow(runtime.db, id, name);
	if (!row) throw ApiError.notFound(`metric ${name} on objective ${id}`);
	const readings = await runtime.db.all<MetricReadingRow>(
		"SELECT objective_id, name, at, value, source FROM metric_readings WHERE objective_id = ? AND name = ? ORDER BY at, id",
		id,
		name,
	);
	return metricView(row, readings, runtime.clock.now());
}

// --- Input ---------------------------------------------------------------------

const CHECK_FIELDS = ["checkCwd", "checkEvery", "checkCron"] as const;

function present(input: Record<string, unknown>, field: string): boolean {
	const value = input[field];
	return value !== undefined && value !== null && value !== "";
}

function slug(value: unknown): string {
	if (typeof value !== "string" || !METRIC_NAME.test(value)) {
		throw ApiError.badRequest("invalid_name", "a metric name is a slug of [a-z0-9-], 1 to 40 long");
	}
	return value;
}

function unitText(value: unknown): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw ApiError.badRequest("missing_unit", "a metric needs a unit, such as kg, kWh, or minutes");
	}
	return value.replace(/\s+/g, " ").trim();
}

function direction(value: unknown): MetricDirection {
	if (typeof value === "string" && (METRIC_DIRECTIONS as readonly string[]).includes(value)) return value as MetricDirection;
	throw ApiError.badRequest("invalid_direction", `direction must be ${METRIC_DIRECTIONS.join(" or ")}, not ${String(value || "(none)")}`);
}

function aggregation(value: unknown): MetricAggregation {
	if (value === undefined || value === null || value === "") return "raw";
	if (typeof value === "string" && (METRIC_AGGREGATIONS as readonly string[]).includes(value)) return value as MetricAggregation;
	throw ApiError.badRequest("invalid_aggregation", `aggregation must be ${METRIC_AGGREGATIONS.join(" or ")}, not ${String(value)}`);
}

/** A target, or null for the infinite case (OBJ-25). */
function target(value: unknown): number | null {
	if (value === undefined || value === null || value === "") return null;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw ApiError.badRequest("invalid_target", `target must be a finite number, not ${String(value)}`);
	}
	return value;
}

function duration(value: unknown, field: string): string {
	if (typeof value !== "string") throw ApiError.badRequest(`invalid_${field}`, `${field} must be a duration such as 7d or 12h`);
	const text = value.trim();
	try {
		parseDuration(text);
	} catch {
		throw ApiError.badRequest(`invalid_${field}`, `${field} must be a duration such as 7d, 12h, or 30m, not ${String(value)}`);
	}
	return text;
}

function cronNext(runtime: Runtime, cron: string, now: number): number {
	const next = nextCronAt(cron, runtime.config.timezone, now);
	if (next === null) throw ApiError.badRequest("invalid_cron", `${cron} has no future run`);
	return next;
}

/** OBJ-25/OBJ-29: a window belongs to a mean, and a mean needs one. */
function windowFor(value: unknown, aggregate: MetricAggregation): string | null {
	if (value === undefined || value === null || value === "") {
		if (aggregate === "mean") throw ApiError.badRequest("missing_window", "a mean aggregation needs a window, such as 7d");
		return null;
	}
	if (aggregate !== "mean") throw ApiError.badRequest("invalid_window", "a window is used only with --aggregation mean");
	return duration(value, "window");
}

interface CheckDefinition {
	command: string;
	cwd: string;
	every: string | null;
	cron: string | null;
	nextAt: number;
}

/**
 * OBJ-26: the check is part of the metric definition, with the recurrence that runs it (no
 * schedule kind is added). Its first run is one interval after it is declared, so declaring a
 * metric never runs a command inside a request.
 */
function checkFor(runtime: Runtime, input: Record<string, unknown>, now: number): CheckDefinition | null {
	const command = input.check;
	// `null` clears a check; an absent key leaves it alone. A check that is given must be a command.
	if (command === undefined || command === null) {
		for (const field of CHECK_FIELDS) {
			if (present(input, field)) throw ApiError.badRequest("invalid_check", `${field} needs a check command`);
		}
		return null;
	}
	if (typeof command !== "string" || command.trim().length === 0) {
		throw ApiError.badRequest("invalid_check", "a check must be a nonempty bash command");
	}
	const every = present(input, "checkEvery") ? duration(input.checkEvery, "check_every") : null;
	const cron = present(input, "checkCron") ? String(input.checkCron).trim() : null;
	if (every !== null && cron !== null) throw ApiError.badRequest("both_times", "a check takes --check-every or --check-cron, not both");
	if (every === null && cron === null) throw ApiError.badRequest("missing_time", "a check needs --check-every or --check-cron");
	const cwd = present(input, "checkCwd") ? String(input.checkCwd).trim() : process.cwd();
	if (!isAbsolute(cwd)) throw ApiError.badRequest("invalid_check_cwd", "checkCwd must be an absolute directory path");
	const nextAt = cron === null ? now + parseDuration(every!) : cronNext(runtime, cron, now);
	return { command, cwd, every, cron, nextAt };
}

// --- Authority and phase --------------------------------------------------------

function wrongPhase(row: ObjectiveRow, expected: string): ApiError {
	return new ApiError(409, "wrong_phase", `objective ${row.id} is ${row.phase}; ${expected}`, { objective: row.id, phase: row.phase });
}

function closed(row: ObjectiveRow): ApiError {
	return new ApiError(409, "objective_closed", `objective ${row.id} is ${row.phase}; the user resumes it to change that`, {
		objective: row.id,
		phase: row.phase,
	});
}

/** A metric may be declared on a draft (OBJ-04) and on an active objective, never on a closed one. */
function assertDeclarable(row: ObjectiveRow): void {
	if (CLOSED_PHASES.includes(row.phase)) throw closed(row);
}

/** A draft has no readings (OBJ-04), and a closed objective stops measuring (OBJ-07). */
function assertMeasurable(row: ObjectiveRow): void {
	if (row.phase === "drafting") throw wrongPhase(row, "a draft has no readings; launch it first");
	if (CLOSED_PHASES.includes(row.phase)) throw closed(row);
}

function userOnly(caller: Caller, what: string): void {
	if (caller.kind !== "user") throw ApiError.forbidden(`only the user may ${what} a metric`);
}

// --- Writes --------------------------------------------------------------------

/**
 * `POST /objectives/:id/metrics` (OBJ-25): declare a metric. A target is the user's to set
 * (OBJ-29), so a session that sends one is refused before anything is written.
 */
export async function addMetric(runtime: Runtime, caller: Caller, value: string | null | undefined, raw: unknown): Promise<MetricView> {
	const input = objectBody(raw);
	const id = objectiveId(value, runtime.config.domain);
	const row = await loadObjective(runtime.db, id);
	assertDeclarable(row);
	if (present(input, "target")) userOnly(caller, "set a target on");
	assertNoTypedBaseline(caller, input);

	const name = slug(input.name);
	const now = runtime.clock.now();
	const unit = unitText(input.unit);
	const directionValue = direction(input.direction);
	const aggregationValue = aggregation(input.aggregation);
	const window = windowFor(input.window, aggregationValue);
	const targetValue = target(input.target);
	const check = checkFor(runtime, input, now);

	await runtime.db.atomically(async (tx) => {
		const existing = await metricRow(tx, id, name);
		// A metric that was declared again is 409 rather than a silent second definition.
		if (existing) throw new ApiError(409, "metric_exists", `objective ${id} already has a metric named ${name}`, { objective: id, name });
		await tx.run(
			`INSERT INTO objective_metrics (objective_id, name, unit, direction, target, aggregation, window_spec,
			                                check_command, check_cwd, check_every, check_cron, next_check_at, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			id,
			name,
			unit,
			directionValue,
			targetValue,
			aggregationValue,
			window,
			check?.command ?? null,
			check?.cwd ?? null,
			check?.every ?? null,
			check?.cron ?? null,
			check?.nextAt ?? null,
			now,
		);
		await recordObjectiveEvent(tx, runtime, {
			objectiveId: id,
			kind: "metric.add",
			actorId: caller.id,
			detail: { name, unit, direction: directionValue, target: targetValue, aggregation: aggregationValue, window, check: check?.command ?? null },
		});
	});
	notifyMetricChecksChanged(runtime);
	return freshMetric(runtime, id, name);
}

/** OBJ-25: a baseline is a metric's first reading, so whoever sends one is told so. */
function assertNoTypedBaseline(caller: Caller, input: Record<string, unknown>): void {
	// An explicit null or empty field is "no baseline", which is the derived one.
	if (input.baseline === undefined || input.baseline === null || input.baseline === "") return;
	if (caller.kind !== "user") userOnly(caller, "set a baseline on");
	throw ApiError.badRequest("baseline_derived", "a baseline is a metric's first reading; append a reading instead of typing one");
}

/** OBJ-25: the reading's `source` is the caller's to report, not another's to claim. */
function readingSource(caller: Caller, value: unknown): ReadingSource {
	if (value === undefined || value === null || value === "") return caller.kind === "user" ? "user" : "lead";
	if (typeof value !== "string" || !(READING_SOURCES as readonly string[]).includes(value)) {
		throw ApiError.badRequest("invalid_source", `source must be ${READING_SOURCES.join(", ")}`);
	}
	if (caller.kind === "session" && value !== "lead") {
		throw ApiError.forbidden("a session records its own readings; only the user may record a user or check reading");
	}
	return value as ReadingSource;
}

function readingValue(value: unknown): number {
	const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
	if (typeof number !== "number" || !Number.isFinite(number)) {
		throw ApiError.badRequest("invalid_value", `a reading is a number, not ${String(value ?? "(none)")}`);
	}
	return number;
}

/**
 * `POST /objectives/:id/metrics/:name/readings` (OBJ-25): append a reading. The first one becomes
 * the metric's baseline and freezes its definition for sessions (OBJ-29).
 */
export async function appendReading(
	runtime: Runtime,
	caller: Caller,
	value: string | null | undefined,
	name: string,
	raw: unknown,
): Promise<MetricView> {
	const input = objectBody(raw);
	const id = objectiveId(value, runtime.config.domain);
	const row = await loadObjective(runtime.db, id);
	assertMeasurable(row);
	const metric = slug(name);
	const reading = readingValue(input.value);
	const source = readingSource(caller, input.source);
	const now = runtime.clock.now();

	await runtime.db.atomically(async (tx) => {
		const existing = await metricRow(tx, id, metric);
		if (!existing) throw ApiError.notFound(`metric ${metric} on objective ${id}`);
		// OBJ-25: append only. There is no UPDATE or DELETE on metric_readings anywhere.
		await tx.run(
			"INSERT INTO metric_readings (id, objective_id, name, at, value, source) VALUES (?, ?, ?, ?, ?, ?)",
			runtime.newId(),
			id,
			metric,
			now,
			reading,
			source,
		);
		// OBJ-29: the first reading is what freezes the definition for sessions.
		await tx.run(
			"UPDATE objective_metrics SET frozen_at = ? WHERE objective_id = ? AND name = ? AND frozen_at IS NULL",
			now,
			id,
			metric,
		);
	});
	return freshMetric(runtime, id, metric);
}

interface DefinitionEdit {
	unit?: string;
	direction?: MetricDirection;
	aggregation?: MetricAggregation;
	window?: string | null;
	check?: CheckDefinition | null;
}

/**
 * `POST /objectives/:id/metrics/:name` (OBJ-29): set or remove the target, and edit the rest of
 * the definition. The user may edit a frozen metric; a session may not, and a session's target is
 * always 403, because a lead that can redefine what it is measured against can report anything.
 * Every target change appends an `objective_events` row.
 */
export async function setMetric(
	runtime: Runtime,
	caller: Caller,
	value: string | null | undefined,
	name: string,
	raw: unknown,
): Promise<MetricView> {
	const input = objectBody(raw);
	const id = objectiveId(value, runtime.config.domain);
	const row = await loadObjective(runtime.db, id);
	assertDeclarable(row);
	const metric = slug(name);
	const existing = await metricRow(runtime.db, id, metric);
	if (!existing) throw ApiError.notFound(`metric ${metric} on objective ${id}`);

	// A rename would have to rewrite append-only readings, so the name identifies the metric for
	// good. The frozen clause of OBJ-29 is satisfied in the stronger direction: nobody renames it.
	if (input.name !== undefined && slug(input.name) !== metric) {
		if (existing.frozen_at !== null && caller.kind !== "user") {
			throw ApiError.forbidden(`metric ${metric} has a reading, so its definition is frozen for sessions`);
		}
		throw ApiError.badRequest("metric_rename", `a metric's name is not editable; declare a new metric instead of renaming ${metric}`);
	}

	const targetTouched = input.target !== undefined;
	if (targetTouched) userOnly(caller, "set a target on");
	assertNoTypedBaseline(caller, input);

	const definitionTouched = ["unit", "direction", "aggregation", "window", "check", ...CHECK_FIELDS].some((field) => input[field] !== undefined);
	if (definitionTouched && existing.frozen_at !== null && caller.kind !== "user") {
		throw ApiError.forbidden(
			`metric ${metric} has a reading, so its definition is frozen for sessions; only the user may change it`,
		);
	}
	if (!targetTouched && !definitionTouched) return freshMetric(runtime, id, metric);

	const now = runtime.clock.now();
	const edit: DefinitionEdit = {};
	if (definitionTouched) {
		if (input.unit !== undefined) edit.unit = unitText(input.unit);
		if (input.direction !== undefined) edit.direction = direction(input.direction);
		if (input.aggregation !== undefined || input.window !== undefined) {
			const aggregate = input.aggregation === undefined ? existing.aggregation : aggregation(input.aggregation);
			edit.aggregation = aggregate;
			// Switching to `raw` drops the window the mean needed; a mean keeps or takes one.
			edit.window = aggregate === "raw" && input.window === undefined ? null : windowFor(input.window ?? existing.window_spec, aggregate);
		}
		const checkTouched = ["check", ...CHECK_FIELDS].some((field) => input[field] !== undefined);
		if (checkTouched) edit.check = checkFor(runtime, input, now);
	}

	const nextTarget = targetTouched ? target(input.target) : existing.target;
	const targetChanged = targetTouched && nextTarget !== existing.target;

	await runtime.db.atomically(async (tx) => {
		const sets: string[] = [];
		const params: (string | number | null)[] = [];
		const push = (column: string, value: string | number | null) => {
			sets.push(`${column} = ?`);
			params.push(value);
		};
		if (edit.unit !== undefined) push("unit", edit.unit);
		if (edit.direction !== undefined) push("direction", edit.direction);
		if (edit.aggregation !== undefined) push("aggregation", edit.aggregation);
		if (edit.window !== undefined) push("window_spec", edit.window);
		if (edit.check !== undefined) {
			push("check_command", edit.check?.command ?? null);
			push("check_cwd", edit.check?.cwd ?? null);
			push("check_every", edit.check?.every ?? null);
			push("check_cron", edit.check?.cron ?? null);
			push("next_check_at", edit.check?.nextAt ?? null);
		}
		if (targetTouched) push("target", nextTarget);
		if (sets.length > 0) {
			await tx.run(`UPDATE objective_metrics SET ${sets.join(", ")} WHERE objective_id = ? AND name = ?`, ...params, id, metric);
		}
		if (targetChanged) {
			await recordObjectiveEvent(tx, runtime, {
				objectiveId: id,
				kind: "metric.target",
				actorId: caller.id,
				detail: { name: metric, target: nextTarget, previous: existing.target },
			});
		}
		if (definitionTouched) {
			await recordObjectiveEvent(tx, runtime, {
				objectiveId: id,
				kind: "metric.set",
				actorId: caller.id,
				detail: {
					name: metric,
					unit: edit.unit,
					direction: edit.direction,
					aggregation: edit.aggregation,
					window: edit.window,
					check: edit.check === undefined ? undefined : (edit.check?.command ?? null),
				},
			});
		}
	});
	if (edit.check !== undefined) notifyMetricChecksChanged(runtime);
	return freshMetric(runtime, id, metric);
}

// --- The scheduler's bridge -----------------------------------------------------

interface MetricChecksHandle {
	refresh(): void;
}

const running = new WeakMap<Runtime, MetricChecksHandle>();

/** Called by `metric-checks.ts` when its loop starts and stops. */
export function registerMetricChecks(runtime: Runtime, handle: MetricChecksHandle): void {
	running.set(runtime, handle);
}

export function unregisterMetricChecks(runtime: Runtime, handle: MetricChecksHandle): void {
	if (running.get(runtime) === handle) running.delete(runtime);
}

/** A metric gained, lost, or moved its check: the check loop re-arms. A no-op without a loop. */
export function notifyMetricChecksChanged(runtime: Runtime): void {
	running.get(runtime)?.refresh();
}
