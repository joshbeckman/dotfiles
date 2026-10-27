// The scheduler (WP6): one timer on `runtime.clock` for the earliest active schedule.
//
// panad starts it after the handlers are merged and closes it on shutdown. It never uses
// `Date.now()` or `setTimeout`: tests drive it with the fake clock, including DST, because the
// timer and every `next_at` come from the same clock.
//
// Firing a schedule calls the merged `sessions.create` handler (WP3) with the schedule's
// creator as caller, so whatever session runtime is installed is the one that runs. A thread
// schedule calls the WP2 store. Failures become notices to the creator (SCH-06).

import type { Caller, Handlers } from "../api/types.ts";
import type { Runtime } from "../server/runtime.ts";
import { wakeScheduled } from "../sessions/wake.ts";
import { createThread, postNotice } from "../threads/index.ts";
import { runCheck } from "./check.ts";
import { registerScheduler, unregisterScheduler } from "./registry.ts";
import {
	activeSchedules,
	claimSchedule,
	creatorAddress,
	dueSchedules,
	finishSchedule,
	nextCronAt,
	nextDueAt,
	recordCheck,
	settleSchedule,
	completeSchedule,
	skipScheduleTo,
	type ScheduleRow,
} from "./store.ts";

export interface SchedulerOptions {
	runtime: Runtime;
	/** The merged handler table panad serves, so a fire uses the live `sessions.create`. */
	handlers: Handlers;
	/** Failures that do not stop panad, such as a notice that could not be posted. */
	onReport?: (error: unknown, what: string) => void;
}

export interface Scheduler {
	/** Stop the timer and settle anything already firing. */
	close(): Promise<void>;
}

class ScheduleLoop implements Scheduler {
	readonly #runtime: Runtime;
	readonly #handlers: Handlers;
	readonly #report: (error: unknown, what: string) => void;
	#handle: (() => void) | undefined;
	#chain: Promise<void> = Promise.resolve();
	#closed = false;
	#running = new Map<string, Promise<void>>();
	#abort = new AbortController();

	constructor(options: SchedulerOptions) {
		this.#runtime = options.runtime;
		this.#handlers = options.handlers;
		this.#report = options.onReport ?? (() => {});
	}

	async start(): Promise<void> {
		registerScheduler(this.#runtime, this);
		// SCH-05: settle what happened while panad was down before arming the timer. A broken
		// stored row must not stop panad from starting.
		try {
			await this.#recover();
		} catch (error) {
			this.#report(error, "schedule recovery");
		}
		await this.#kick();
	}

	async close(): Promise<void> {
		this.#closed = true;
		this.#clear();
		unregisterScheduler(this.#runtime, this);
		this.#abort.abort();
		await this.#chain.catch(() => {});
		await Promise.all(this.#running.values());
	}

	/** A schedule was created, updated, or deleted: re-arm from the clock's current time. */
	refresh(): void {
		void this.#kick();
	}

	/** Run every due schedule, then arm the next timer. Calls are serialized. */
	#kick(): Promise<void> {
		this.#chain = this.#chain
			.then(() => this.#fireDue())
			.catch((error) => this.#report(error, "scheduler"));
		return this.#chain;
	}

	async #fireDue(): Promise<void> {
		this.#clear();
		if (this.#closed) return;
		const now = this.#runtime.clock.now();
		for (const row of await dueSchedules(this.#runtime, now)) {
			if (this.#closed) break;
			if (this.#running.has(row.id)) continue;
			// Claim and execute independently: a slow check must not block unrelated schedules.
			const task = this.#fire(row, now)
				.catch((error) => this.#report(error, `schedule ${row.id}`))
				.finally(async () => {
					try {
						// Do not replay occurrences missed while this action/check was in flight.
						if (await settleSchedule(this.#runtime, row)) {
							await this.#notify(row, `Scheduled ${row.kind} ${this.#runtime.url({ kind: "schedule", id: row.id })} is done: ${row.cron} has no future run.`);
						}
					} catch (error) {
						this.#report(error, `schedule ${row.id} completion`);
					} finally {
						this.#running.delete(row.id);
						if (!this.#closed) void this.#kick();
					}
				});
			this.#running.set(row.id, task);
		}
		await this.#arm();
	}

	async #arm(): Promise<void> {
		this.#clear();
		if (this.#closed) return;
		const nextAt = await nextDueAt(this.#runtime, [...this.#running.keys()]);
		if (this.#closed || nextAt === null) return;
		const delay = Math.max(0, nextAt - this.#runtime.clock.now());
		this.#handle = this.#runtime.clock.setTimer(
			() => {
				void this.#kick();
			},
			delay,
			// Not background: a pending schedule must keep panad awake to fire it.
			{ background: false },
		);
	}

	#clear(): void {
		this.#handle?.();
		this.#handle = undefined;
	}

	/**
	 * Claim the schedule, then run it. A one-off becomes `done`; a cron moves to its next future
	 * time so a long sleep or a slow fire skips the missed occurrences instead of replaying them.
	 */
	async #fire(row: ScheduleRow, now: number): Promise<void> {
		const timezone = row.timezone ?? this.#runtime.config.timezone;
		const nextAt = row.cron ? nextCronAt(row.cron, timezone, now) : null;
		// A cron with no future run is finished, the same as a one-off that has run.
		const keepsRunning = row.cron !== null && nextAt !== null;
		const claimed = await claimSchedule(this.#runtime, row.id, keepsRunning ? "active" : "done", nextAt, row);
		if (!claimed || this.#closed) return;
		let delivered = false;
		try {
			if (row.check_command !== null) {
				const result = await runCheck(row.check_command, row.check_cwd!, this.#runtime.clock, this.#abort.signal);
				await recordCheck(this.#runtime, row.id, result);
				if (this.#closed) return;
				if (result.status === "failed") {
					this.#report(new Error(result.error ?? "check failed"), `schedule ${row.id} check`);
					await this.#notify(row, `Scheduled ${row.kind} ${this.#runtime.url({ kind: "schedule", id: row.id })} check failed: ${result.error}`);
				}
				if (result.status !== "passed") return;
				// Deletion or editing while the check ran cancels this occurrence.
				const current = await this.#runtime.db.get<ScheduleRow>("SELECT * FROM schedules WHERE id = ?", row.id);
				if (!current || current.state === "deleted" || current.revision !== row.revision || current.next_at !== nextAt) return;
			}
			if (this.#closed) return;
			// A recurring wake uses an occurrence-specific request ID (the one-shot ID stays stable).
			delivered = await this.#run(row);
			if (delivered && row.stop_after_success === 1) {
				await completeSchedule(this.#runtime, row.id, row.revision);
				return;
			}
		} catch (error) {
			this.#report(error, `schedule ${row.id}`);
			await this.#notify(row, `Scheduled ${row.kind} ${this.#runtime.url({ kind: "schedule", id: row.id })} failed: ${messageOf(error)}`);
			return;
		}
		// WAK-07: a wake is spent once its session has it. Anything else keeps its row, so a
		// `done` schedule is exactly one whose outcome is unknown or refused, never a normal fire.
		if (delivered && row.kind === "wake" && !row.cron) await finishSchedule(this.#runtime, row.id, row.revision);
		if (!keepsRunning && row.cron !== null) {
			await this.#notify(row, `Scheduled ${row.kind} ${this.#runtime.url({ kind: "schedule", id: row.id })} is done: ${row.cron} has no future run.`);
		}
	}

	/** Run one claimed schedule. Returns true when the action was successfully dispatched. */
	async #run(row: ScheduleRow): Promise<boolean> {
		const creator = await this.#caller(row.creator_id);
		const payload = JSON.parse(row.payload) as Record<string, unknown>;
		if (row.kind === "session") {
			await this.#createSession(creator, payload);
			return true;
		}
		if (row.kind === "wake") {
			return wakeScheduled(this.#runtime, { scheduleId: row.id, occurrence: row.cron ? row.next_at! : undefined, sessionId: String(payload.session), note: String(payload.note) });
		}
		await createThread(this.#runtime, creator, {
			to: payload.to,
			body: payload.body,
			subject: payload.subject,
		});
		return true;
	}

	/** SES-01: the session is created through the registered handler, as the schedule's creator. */
	async #createSession(caller: Caller, payload: Record<string, unknown>): Promise<void> {
		const handler = this.#handlers["sessions.create"];
		if (!handler) throw new Error("no sessions.create handler is registered");
		const result = await handler({
			runtime: this.#runtime,
			transport: "socket",
			caller,
			params: {},
			query: new URLSearchParams(),
			body: payload,
			rawBody: Buffer.alloc(0),
			headers: {},
		});
		if (result.status < 200 || result.status >= 300) {
			throw new Error(`sessions.create answered ${result.status}`);
		}
	}

	async #caller(participantId: string): Promise<Caller> {
		const row = await this.#runtime.db.get<{ id: string; kind: string; url: string }>(
			"SELECT id, kind, url FROM participants WHERE id = ?",
			participantId,
		);
		if (!row) throw new Error(`schedule creator ${participantId} is not a participant`);
		if (row.kind !== "user" && row.kind !== "session") {
			throw new Error(`schedule creator ${participantId} is not a user or a session`);
		}
		return { kind: row.kind, id: row.id, url: row.url };
	}

	/**
	 * SCH-05: on startup, a cron that should have run while panad was down skips to its next
	 * future time, and a one-off that passed is marked `missed`. Nothing fires late.
	 */
	async #recover(): Promise<void> {
		const now = this.#runtime.clock.now();
		for (const row of await activeSchedules(this.#runtime)) {
			const timezone = row.timezone ?? this.#runtime.config.timezone;
			if (row.cron) {
				if (row.next_at !== null && row.next_at > now) continue;
				const nextAt = nextCronAt(row.cron, timezone, now);
				if (nextAt === null) {
					if (await claimSchedule(this.#runtime, row.id, "done", null)) {
						await this.#notify(
							row,
							`Scheduled ${row.kind} ${this.#runtime.url({ kind: "schedule", id: row.id })} is done: ${row.cron} has no future run.`,
						);
					}
					continue;
				}
				await skipScheduleTo(this.#runtime, row.id, nextAt);
				continue;
			}
			if (row.next_at !== null && row.next_at > now) continue;
			// WAK-03: a session is waiting on its wake, so a late one still fires. Skipping it
			// would leave the session asleep with nothing to wake it.
			if (row.kind === "wake") {
				await this.#fire(row, now);
				continue;
			}
			if (await claimSchedule(this.#runtime, row.id, "missed", null)) {
				await this.#notify(
					row,
					`Scheduled ${row.kind} ${this.#runtime.url({ kind: "schedule", id: row.id })} was missed: its time passed while panad was down.`,
				);
			}
		}
	}

	async #notify(row: ScheduleRow, body: string): Promise<void> {
		try {
			await postNotice(this.#runtime, { to: [await creatorAddress(this.#runtime, row.creator_id)], body });
		} catch (error) {
			this.#report(error, `schedule ${row.id} notice`);
		}
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Start the scheduler: recover missed runs, then arm the timer. */
export async function startScheduler(options: SchedulerOptions): Promise<Scheduler> {
	const loop = new ScheduleLoop(options);
	await loop.start();
	return loop;
}
