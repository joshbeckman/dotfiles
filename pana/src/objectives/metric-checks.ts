// Metric checks (OBJ-26): a metric's value read from the world, with no session involved.
//
// The check belongs to the metric definition, not to a reading, and it runs on `runtime.clock`
// with no agent awake: a daily measurement costs nothing and adds no schedule kind. Everything
// about how it runs is SCH-09 through SCH-12 unchanged — `bash --noprofile --norc -c`, the
// recorded check cwd, a 30-second timeout, 8 KiB retained per stream, a killed process group —
// because it uses the same runner (`src/schedules/check.ts`).
//
//   exit 0 + a number on stdout  -> append one reading with `source: "check"` (OBJ-25)
//   exit 1                       -> append nothing, record `not_ready`, post no notice
//   anything else                -> append nothing, record `failed`, post one notice to the user
//
// "Anything else" is a non-numeric stdout, any other exit code, a signal, a timeout, or an
// execution error (SCH-11). Check output is diagnostic: it lands in `lastCheck` and in the notice
// to the user, and never in a lead's prompt.
//
// One timer, like the schedule loop: it arms for the earliest `next_check_at`, claims a due check
// by moving that time forward inside one write (so a restart or a second timer cannot run the
// same occurrence twice), then runs it.

import { runCheck, type CheckResult } from "../schedules/check.ts";
import { nextCronAt, parseDuration } from "../schedules/store.ts";
import type { Runtime } from "../server/runtime.ts";
import { postNotice } from "../threads/index.ts";
import { registerMetricChecks, unregisterMetricChecks, type MetricRow } from "./metrics.ts";
import type { ObjectivePhase } from "./schema.ts";
import { objectiveUrl } from "./state.ts";

/** A due check joins its metric's definition to the objective that owns it. */
export interface DueMetricCheck extends MetricRow {
	phase: ObjectivePhase;
}

interface CheckRow extends MetricRow {
	phase: ObjectivePhase;
}

/** A number and nothing else. A check that prints prose has not measured anything. */
const NUMERIC = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** The metrics whose check is due now, oldest due first. */
export async function dueMetricChecks(runtime: Runtime, now: number): Promise<DueMetricCheck[]> {
	return runtime.db.all<DueMetricCheck>(
		`SELECT m.*, o.phase AS phase
		   FROM objective_metrics m JOIN objectives o ON o.id = m.objective_id
		  WHERE m.check_command IS NOT NULL AND m.next_check_at IS NOT NULL AND m.next_check_at <= ?
		  ORDER BY m.next_check_at, m.objective_id, m.name`,
		now,
	);
}

/** The earliest check any metric wants, skipping the ones already running. */
export async function nextMetricCheckAt(runtime: Runtime, excluding: readonly string[] = []): Promise<number | null> {
	const rows = await runtime.db.all<{ objective_id: string; name: string; next: number }>(
		"SELECT objective_id, name, next_check_at AS next FROM objective_metrics WHERE check_command IS NOT NULL AND next_check_at IS NOT NULL ORDER BY next_check_at, objective_id, name",
	);
	for (const row of rows) {
		if (excluding.includes(checkKey(row.objective_id, row.name))) continue;
		return row.next;
	}
	return null;
}

function checkKey(objective: string, name: string): string {
	return `${objective}/${name}`;
}

/** When this check runs next: the next cron occurrence, or one `check_every` from now. */
export function nextCheckTime(row: Pick<MetricRow, "check_every" | "check_cron">, timezone: string, now: number): number | null {
	if (row.check_cron !== null) return nextCronAt(row.check_cron, timezone, now);
	if (row.check_every !== null) {
		try {
			return now + parseDuration(row.check_every);
		} catch {
			return null;
		}
	}
	return null;
}

/**
 * Claim one occurrence: move `next_check_at` forward in the same write that confirms the row is
 * still the one we read. A second timer, a restart, or an edit mid-check loses the race cleanly.
 */
async function claimCheck(runtime: Runtime, row: DueMetricCheck, nextAt: number | null): Promise<CheckRow | undefined> {
	return runtime.db.write(async (tx) => {
		const current = await tx.get<CheckRow>(
			`SELECT m.*, o.phase AS phase
			   FROM objective_metrics m JOIN objectives o ON o.id = m.objective_id
			  WHERE m.objective_id = ? AND m.name = ?`,
			row.objective_id,
			row.name,
		);
		if (!current || current.next_check_at !== row.next_check_at || current.check_command !== row.check_command) return undefined;
		await tx.run(
			"UPDATE objective_metrics SET next_check_at = ? WHERE objective_id = ? AND name = ?",
			nextAt,
			row.objective_id,
			row.name,
		);
		return current;
	});
}

/**
 * OBJ-26: a passing check must print a number. Everything else that is not exit 1 is a failure,
 * recorded in SCH-10's shape so `lastCheck` means the same thing here as on a schedule.
 */
export function evaluated(result: CheckResult): { result: CheckResult; value: number | null } {
	if (result.status !== "passed") return { result, value: null };
	const text = result.stdout.trim();
	if (!NUMERIC.test(text)) {
		const saw = text.length === 0 ? "no number on stdout" : `stdout is ${JSON.stringify(text.slice(0, 80))}, not a number`;
		return { result: { ...result, status: "failed", error: saw }, value: null };
	}
	const value = Number(text);
	if (!Number.isFinite(value)) {
		return { result: { ...result, status: "failed", error: "stdout is not a finite number" }, value: null };
	}
	return { result, value };
}

/**
 * Save the diagnostic, and append the reading when the check measured something. The reading and
 * the frozen definition commit with it, so a metric never has a reading and an unfrozen
 * definition in between (OBJ-29).
 */
async function record(runtime: Runtime, row: CheckRow, result: CheckResult, value: number | null): Promise<void> {
	await runtime.db.atomically(async (tx) => {
		await tx.run(
			"UPDATE objective_metrics SET last_check = ? WHERE objective_id = ? AND name = ?",
			JSON.stringify(result),
			row.objective_id,
			row.name,
		);
		if (value === null) return;
		await tx.run(
			"INSERT INTO metric_readings (id, objective_id, name, at, value, source) VALUES (?, ?, ?, ?, ?, 'check')",
			runtime.newId(),
			row.objective_id,
			row.name,
			result.checkedAt,
			value,
		);
		await tx.run(
			"UPDATE objective_metrics SET frozen_at = ? WHERE objective_id = ? AND name = ? AND frozen_at IS NULL",
			result.checkedAt,
			row.objective_id,
			row.name,
		);
	});
}

/** OBJ-26/SCH-11: one notice to the user per failure, naming the metric and the objective. */
async function noticeFailure(runtime: Runtime, row: CheckRow, result: CheckResult): Promise<void> {
	const body = `Metric check for "${row.name}" on Objective ${objectiveUrl(runtime, row.objective_id)} failed: ${result.error ?? "unknown error"}. No reading was recorded.`;
	await postNotice(runtime, { to: [runtime.userUrl], body });
}

export interface MetricChecks {
	/** Cancel the timer, abort in-flight checks, and wait for them to settle. */
	close(): Promise<void>;
}

class CheckLoop implements MetricChecks {
	readonly #runtime: Runtime;
	readonly #report: (error: unknown, what: string) => void;
	#cancel: (() => void) | undefined;
	#chain: Promise<void> = Promise.resolve();
	#closed = false;
	#running = new Map<string, Promise<void>>();
	readonly #abort = new AbortController();

	constructor(runtime: Runtime, report: (error: unknown, what: string) => void) {
		this.#runtime = runtime;
		this.#report = report;
	}

	start(): void {
		registerMetricChecks(this.#runtime, this);
		void this.#kick();
	}

	/** A metric gained, lost, or moved its check: re-arm from the clock's current time. */
	refresh(): void {
		void this.#kick();
	}

	async close(): Promise<void> {
		this.#closed = true;
		this.#clear();
		unregisterMetricChecks(this.#runtime, this);
		this.#abort.abort();
		await this.#chain.catch(() => {});
		await Promise.all([...this.#running.values()].map((task) => task.catch(() => {})));
	}

	#kick(): Promise<void> {
		this.#chain = this.#chain
			.then(() => this.#fireDue())
			.catch((error) => this.#report(error, "metric checks"))
			.then(() => this.#arm())
			.catch((error) => this.#report(error, "metric check timer"));
		return this.#chain;
	}

	async #fireDue(): Promise<void> {
		this.#clear();
		if (this.#closed) return;
		const now = this.#runtime.clock.now();
		for (const row of await dueMetricChecks(this.#runtime, now)) {
			if (this.#closed) break;
			const key = checkKey(row.objective_id, row.name);
			if (this.#running.has(key)) continue;
			// Claim and run independently: a slow check must not hold up another metric.
			const task = this.#fire(row, now)
				.catch((error) => this.#report(error, `metric check ${row.name} on ${row.objective_id}`))
				.finally(() => {
					this.#running.delete(key);
					if (!this.#closed) void this.#kick();
				});
			this.#running.set(key, task);
		}
	}

	async #arm(): Promise<void> {
		this.#clear();
		if (this.#closed) return;
		const nextAt = await nextMetricCheckAt(this.#runtime, [...this.#running.keys()]);
		if (this.#closed || nextAt === null) return;
		const delay = Math.max(0, nextAt - this.#runtime.clock.now());
		// Not background: a due check must keep panad awake to run it, as a schedule does.
		this.#cancel = this.#runtime.clock.setTimer(() => void this.#kick(), delay, { background: false });
	}

	#clear(): void {
		this.#cancel?.();
		this.#cancel = undefined;
	}

	async #fire(row: DueMetricCheck, now: number): Promise<void> {
		const nextAt = nextCheckTime(row, this.#runtime.config.timezone, now);
		const claimed = await claimCheck(this.#runtime, row, nextAt);
		if (!claimed || this.#closed) return;
		// OBJ-04: a draft has no readings, and a closed objective stops measuring. The occurrence
		// is skipped, not replayed, so the next check is a full interval later.
		if (claimed.phase !== "active") return;
		const result = await runCheck(
			claimed.check_command!,
			claimed.check_cwd ?? process.cwd(),
			this.#runtime.clock,
			this.#abort.signal,
		);
		const measured = evaluated(result);
		await record(this.#runtime, claimed, measured.result, measured.value);
		// A cancelled check is a shutdown, not a failure the user should hear about.
		if (measured.result.status === "failed" && !this.#closed) {
			try {
				await noticeFailure(this.#runtime, claimed, measured.result);
			} catch (error) {
				this.#report(error, `metric check notice for ${claimed.name}`);
			}
		}
	}
}

/** Start the metric check loop: arm the timer for the earliest due check. */
export function startMetricChecks(runtime: Runtime, report: (error: unknown, what: string) => void): MetricChecks {
	const loop = new CheckLoop(runtime, report);
	loop.start();
	return loop;
}
