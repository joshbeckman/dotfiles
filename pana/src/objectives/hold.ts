// Run admission, the hold, and the budget gate (OBJ-18..OBJ-24).
//
// `admitRun` is the one place that decides whether a run may start. Every path that would start
// one calls it: the delivery hook, a scheduled wake, and a hold release. A gate added here holds
// for all of them, so no caller can bypass the limit by using another entry point. Session
// creation has its own gate (`memberCreateGate`) because a member create is a request that can
// answer 402 rather than a delivery that must stay queued.
//
// A refused or held run never drops its delivery: the caller leaves the delivery unread with no
// wake, and records a `run.held` or `run.refused` event naming the condition (OBJ-23). The lead's
// hold persists as `sessions.hold_until` plus one ordinary `wake` schedule at that time, whose
// payload names the held deliveries. There is no new schedule kind (OBJ-18).

import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { SqliteExecutor } from "@earendil-works/chord/sqlite";
import { ApiError } from "../api/errors.ts";
import { wakeRequestId } from "../db/outbox.ts";
import { announceWakes } from "../schedules/live.ts";
import { notifySchedulesChanged } from "../schedules/registry.ts";
import { nextDayStart, overDomainBudget } from "../sessions/budget.ts";
import { setSessionState } from "../sessions/state.ts";
import { MESSAGE_ENTRY_KIND, renderMessage, sessionConversation, submitScheduledWake, WAKE_ENTRY_KIND, type ScheduledWake } from "../sessions/wake.ts";
import type { Runtime } from "../server/runtime.ts";
import { postNotice } from "../threads/store.ts";
import { CLOSED_PHASES, type ObjectiveRow } from "./schema.ts";
import { objectiveDay, objectiveCostToday, objectiveCostTotal, objectivePaused, objectiveUserMessagesToday, lastLeadRunEnd, leadRunsToday, type ObjectivePaused } from "./limits.ts";
import { objectiveRow, objectiveUrl, recordObjectiveEvent } from "./state.ts";

/** Why a run is waiting, as the event and the hold record it (OBJ-23). */
export type HoldCondition = "lead_quiet" | "lead_turns_day" | "messages_day" | ObjectivePaused;

/** What `admitRun` decided. `admit: false` means no run starts and the delivery stays queued. */
export interface RunAdmission {
	admit: boolean;
	/** The objective the session acts for, when it acts for one. */
	objectiveId?: string;
	/** True when the session is the objective's lead. */
	lead?: boolean;
	condition?: HoldCondition | "objective_closed";
	/** When the hold lifts; absent when nothing will lift it automatically (a total budget). */
	until?: number;
	/** A refused request (a member create) surfaces this as its error. */
	refusal?: { status: number; code: string; message: string; details?: Record<string, unknown> };
}

export interface RunIntent {
	kind: "delivery" | "wake" | "resume" | "launch";
	deliveryId?: string;
	messageId?: string;
	scheduleId?: string;
	note?: string;
}

interface SessionRow {
	id: string;
	state: string;
	objective_id: string | null;
	hold_until: number | null;
}

const WAKEABLE = new Set(["idle", "failed"]);

/**
 * OBJ-23: the one admission choke point. Called inside the transaction that would start the run,
 * so a hold and its event commit with the delivery that triggered it, and a rollback takes both.
 *
 * A session already `running` or `waiting` does not start a run here: its delivery steers or
 * queues as a follow-up (DLV-04, DLV-05), so no limit applies and no run is counted.
 */
export async function admitRun(tx: SqliteExecutor, runtime: Runtime, sessionId: string, intent: RunIntent): Promise<RunAdmission> {
	const session = await tx.get<SessionRow>("SELECT id, state, objective_id, hold_until FROM sessions WHERE id = ?", sessionId);
	if (!session) return { admit: false, refusal: { status: 404, code: "not_found", message: `session ${sessionId}` } };
	if (session.state === "stopped" || session.state === "archived") return { admit: false, objectiveId: session.objective_id ?? undefined };
	if (!WAKEABLE.has(session.state)) return { admit: true, objectiveId: session.objective_id ?? undefined };

	if (session.objective_id === null) {
		// Not an objective: LIM-03 stays the only gate, and it only ever held deliveries, as before WP18.
		if (intent.kind === "delivery" && (await overDomainBudget(tx, runtime))) return { admit: false, condition: "domain_budget" };
		return { admit: true };
	}

	const row = await objectiveRow(tx, session.objective_id);
	if (!row) return { admit: true };
	if (CLOSED_PHASES.includes(row.phase)) {
		return {
			admit: false,
			objectiveId: row.id,
			condition: "objective_closed",
			refusal: {
				status: 409,
				code: "objective_closed",
				message: `objective ${row.id} is ${row.phase}; the user resumes it to change that`,
				details: { objective: row.id, phase: row.phase, session: sessionId },
			},
		};
	}

	// At launch the lead's first run starts before the phase and `lead_id` move in the same
	// transaction, so a drafting objective's single session is its lead.
	const lead =
		row.lead_id === sessionId ||
		(row.lead_id === null && (await tx.get<{ n: number }>("SELECT COUNT(*) AS n FROM sessions WHERE objective_id = ?", row.id))?.n === 1);
	const now = runtime.clock.now();
	const paused = await objectivePaused(tx, runtime, row);
	if (paused !== null) {
		const until = paused === "budget_total" ? undefined : nextDayStart(now, runtime.config.timezone);
		// OBJ-22: the domain budget wakes nothing; the LIM-03 rollover delivers held mail at the next day.
		if (lead && paused !== "domain_budget") await holdLead(tx, runtime, row, sessionId, { condition: paused, until, intent });
		await recordObjectiveEvent(tx, runtime, {
			objectiveId: row.id,
			kind: "run.refused",
			detail: { condition: paused, session: sessionId, ...deliveryDetail(intent) },
		});
		await noticeForCondition(tx, runtime, row, paused);
		return { admit: false, objectiveId: row.id, lead, condition: paused, until };
	}

	if (lead) {
		const turnLimit = row.max_daily_lead_turns;
		if (turnLimit !== null && (await leadRunsToday(tx, runtime, row, sessionId)) >= turnLimit) {
			const until = nextDayStart(now, runtime.config.timezone);
			await holdLead(tx, runtime, row, sessionId, { condition: "lead_turns_day", until, intent });
			// The notice is posted before this refusal is recorded, so its "already told" check
			// sees earlier notices only. One notice for the day, not one per delivery.
			await noticeForCondition(tx, runtime, row, "lead_turns_day");
			await recordObjectiveEvent(tx, runtime, {
				objectiveId: row.id,
				kind: "run.refused",
				detail: { condition: "lead_turns_day", session: sessionId, limit: turnLimit, ...deliveryDetail(intent) },
			});
			return { admit: false, objectiveId: row.id, lead, condition: "lead_turns_day", until };
		}

		const messageLimit = row.max_daily_user_messages ?? runtime.config.objectives.maxDailyUserMessages;
		const sent = await objectiveUserMessagesToday(tx, runtime, row);
		if (sent >= messageLimit) {
			const until = nextDayStart(now, runtime.config.timezone);
			await holdLead(tx, runtime, row, sessionId, { condition: "messages_day", until, intent });
			await recordObjectiveEvent(tx, runtime, {
				objectiveId: row.id,
				kind: "run.refused",
				detail: { condition: "messages_day", session: sessionId, limit: messageLimit, sent, ...deliveryDetail(intent) },
			});
			return { admit: false, objectiveId: row.id, lead, condition: "messages_day", until };
		}

		const quietMs = (row.wake_min_minutes ?? runtime.config.objectives.wakeMinMinutes) * 60_000;
		const lastEnd = await lastLeadRunEnd(tx, row, sessionId);
		if (lastEnd !== null && now < lastEnd + quietMs) {
			const until = lastEnd + quietMs;
			await holdLead(tx, runtime, row, sessionId, { condition: "lead_quiet", until, intent });
			await recordObjectiveEvent(tx, runtime, {
				objectiveId: row.id,
				kind: "run.held",
				detail: { condition: "lead_quiet", session: sessionId, until, ...deliveryDetail(intent) },
			});
			return { admit: false, objectiveId: row.id, lead, condition: "lead_quiet", until };
		}
	}

	await recordObjectiveEvent(tx, runtime, { objectiveId: row.id, kind: "run.started", detail: { session: sessionId, lead } });
	return { admit: true, objectiveId: row.id, lead };
}

/** A session's run ended: the quiet interval and the run rollup both read this (OBJ-18, OBJ-19). */
export async function recordRunEnded(tx: SqliteExecutor, runtime: Runtime, session: { id: string; objective_id: string | null }, state: string): Promise<void> {
	if (session.objective_id === null) return;
	const row = await objectiveRow(tx, session.objective_id);
	if (!row) return;
	await recordObjectiveEvent(tx, runtime, {
		objectiveId: row.id,
		kind: "run.ended",
		detail: { session: session.id, lead: row.lead_id === session.id, state },
	});
}

/**
 * OBJ-20, OBJ-21: after spend is recorded, stop what is running and say why once. The day budget
 * resumes at the next local day; the lifetime budget has no automatic wake and holds until the
 * user raises it or stops the objective. `budget_total` outranks `budget_day`.
 */
export async function recordBudgetHold(tx: SqliteExecutor, runtime: Runtime, row: ObjectiveRow, paused: ObjectivePaused): Promise<void> {
	const now = runtime.clock.now();
	const until = paused === "budget_total" ? undefined : nextDayStart(now, runtime.config.timezone);
	if (row.lead_id !== null) await holdLead(tx, runtime, row, row.lead_id, { condition: paused, until });
	else await clearHold(tx, runtime, row.lead_id);
	await noticeForCondition(tx, runtime, row, paused);
}

/**
 * OBJ-18: persist a lead's hold: `hold_until` on the session, and one ordinary wake schedule at
 * that time. A second hold keeps the later time, so a stronger condition cannot be shortened, and
 * a re-hold does not add a second wake.
 */
export async function holdLead(
	tx: SqliteExecutor,
	runtime: Runtime,
	row: ObjectiveRow,
	sessionId: string,
	input: { condition: HoldCondition; until?: number; intent?: RunIntent },
): Promise<number | null> {
	const now = runtime.clock.now();
	const current = await tx.get<{ hold_until: number | null }>("SELECT hold_until FROM sessions WHERE id = ?", sessionId);
	let until = input.until;
	if (until !== undefined && current?.hold_until != null && current.hold_until > until) until = current.hold_until;
	if (until === undefined) {
		await clearHold(tx, runtime, sessionId);
		return null;
	}
	const note = await holdNote(tx, runtime, row, sessionId, input);
	await tx.run("UPDATE sessions SET hold_until = ?, updated_at = ? WHERE id = ?", until, now, sessionId);
	await upsertHoldWake(tx, runtime, row, sessionId, until, note, input);
	runtime.db.afterCommit(() => {
		notifySchedulesChanged(runtime);
		void announceWakes(runtime, [sessionId]).catch(report);
	});
	return until;
}

/** OBJ-21: a lifetime budget has no automatic wake, so no hold wake may linger. */
async function clearHold(tx: SqliteExecutor, runtime: Runtime, sessionId: string | null): Promise<void> {
	if (sessionId === null) return;
	await tx.run("UPDATE sessions SET hold_until = NULL, updated_at = ? WHERE id = ?", runtime.clock.now(), sessionId);
	await tx.run(
		`UPDATE schedules SET state = 'deleted', next_at = NULL, updated_at = ?
		  WHERE kind = 'wake' AND state = 'active' AND json_extract(payload, '$.hold') = 1 AND json_extract(payload, '$.session') = ?`,
		runtime.clock.now(),
		sessionId,
	);
	runtime.db.afterCommit(() => {
		notifySchedulesChanged(runtime);
		void announceWakes(runtime, [sessionId]).catch(report);
	});
}

interface HoldWakeRow {
	id: string;
	revision: number;
	payload: string;
}

/** OBJ-18: the one ordinary wake that persists a hold. Its payload names what waited. */
async function upsertHoldWake(
	tx: SqliteExecutor,
	runtime: Runtime,
	row: ObjectiveRow,
	sessionId: string,
	until: number,
	note: string,
	input: { condition: HoldCondition; intent?: RunIntent },
): Promise<void> {
	const now = runtime.clock.now();
	const existing = await tx.get<HoldWakeRow>(
		`SELECT id, revision, payload FROM schedules
		  WHERE kind = 'wake' AND state = 'active'
		    AND json_extract(payload, '$.hold') = 1 AND json_extract(payload, '$.session') = ?
		  LIMIT 1`,
		sessionId,
	);
	const previous = existing ? (JSON.parse(existing.payload) as { heldNotes?: HeldNote[] }) : undefined;
	const heldNotes = mergeHeldNotes(previous?.heldNotes ?? [], input.intent, note);
	const payload = JSON.stringify({ session: sessionId, note, hold: true, condition: input.condition, objective: row.id, ...(heldNotes.length > 0 ? { heldNotes } : {}) });
	const timezone = runtime.config.timezone;
	if (existing) {
		await tx.run(
			"UPDATE schedules SET payload = ?, at = ?, next_at = ?, timezone = ?, updated_at = ?, revision = ? WHERE id = ?",
			payload,
			until,
			until,
			timezone,
			now,
			existing.revision + 1,
			existing.id,
		);
		return;
	}
	await tx.run(
		`INSERT INTO schedules (id, kind, state, cron, at, timezone, creator_id, payload, next_at, created_at, updated_at, subject, subject_source, revision)
		 VALUES (?, 'wake', 'active', NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', 0)`,
		runtime.newId(),
		until,
		timezone,
		sessionId,
		payload,
		until,
		now,
		now,
		"Objective hold",
	);
}

interface HeldNote {
	scheduleId: string;
	note: string;
}

/** A scheduled wake that was held keeps its note in the hold's payload, so it is not lost. */
function mergeHeldNotes(existing: HeldNote[], intent: RunIntent | undefined, note: string): HeldNote[] {
	const out = existing.map((item) => ({ ...item }));
	if (intent?.kind === "wake" && intent.scheduleId !== undefined && !out.some((item) => item.scheduleId === intent.scheduleId)) {
		out.push({ scheduleId: intent.scheduleId, note: intent.note ?? note });
	}
	return out;
}

/** The note `pana schedule list --kind wake` shows: what waited, and until when. */
async function holdNote(tx: SqliteExecutor, runtime: Runtime, row: ObjectiveRow, sessionId: string, input: { condition: HoldCondition; intent?: RunIntent }): Promise<string> {
	const held = await heldDeliveries(tx, sessionId);
	const lines = [
		`Objective ${objectiveUrl(runtime, row.id)} is holding this run (${input.condition}).`,
		...(held.length > 0 ? [`Held deliveries (${held.length}):`, ...held.map((item) => `- ${runtime.url({ kind: "message", id: item.messageId, thread: item.threadId })}`)] : []),
		...(input.intent?.kind === "wake" && input.intent.note !== undefined ? [`Held wakeup: ${input.intent.note}`] : []),
	];
	return lines.join("\n");
}

interface HeldDelivery {
	deliveryId: string;
	messageId: string;
	threadId: string;
}

/** Deliveries that are waiting for a run: unread, with no wake submitted (DLV-03, OBJ-18). */
export async function heldDeliveries(tx: SqliteExecutor, sessionId: string): Promise<HeldDelivery[]> {
	return tx.all<HeldDelivery>(
		`SELECT d.id AS deliveryId, d.message_id AS messageId, d.thread_id AS threadId
		   FROM deliveries d
		   JOIN messages m ON m.id = d.message_id
		  WHERE d.recipient_id = ? AND d.read_at IS NULL AND d.wake_submission_id IS NULL
		  ORDER BY m.created_at, m.seq, d.id`,
		sessionId,
	);
}

/** One notice per condition, keyed by the day (budget) or by the run (turns), and never repeated. */
async function noticeForCondition(tx: SqliteExecutor, runtime: Runtime, row: ObjectiveRow, condition: HoldCondition | ObjectivePaused): Promise<void> {
	const now = runtime.clock.now();
	const url = objectiveUrl(runtime, row.id);
	let body: string;
	if (condition === "budget_day") {
		const { day } = objectiveDay(runtime, now);
		const stamp = await tx.get<{ noticed_at: number | null }>("SELECT noticed_at FROM objective_costs WHERE day = ? AND objective_id = ?", day, row.id);
		if (stamp?.noticed_at != null) return;
		await tx.run("UPDATE objective_costs SET noticed_at = ? WHERE day = ? AND objective_id = ?", now, day, row.id);
		const spent = await objectiveCostToday(tx, runtime, row.id, now);
		const resumes = new Date(nextDayStart(now, runtime.config.timezone)).toISOString();
		body = `Objective ${url} is paused: it spent $${spent.toFixed(2)} of its $${(row.max_daily_usd ?? 0).toFixed(2)} daily budget. It resumes at ${resumes}.`;
	} else if (condition === "budget_total") {
		const prior = await tx.get<{ id: string }>("SELECT id FROM objective_events WHERE objective_id = ? AND kind = 'budget' AND json_extract(detail, '$.condition') = 'budget_total' LIMIT 1", row.id);
		if (prior) return;
		const spent = await objectiveCostTotal(tx, row.id);
		body = `Objective ${url} is paused: it has spent $${spent.toFixed(2)} of its $${(row.max_total_usd ?? 0).toFixed(2)} lifetime budget. Raise the budget or stop the objective to resume it.`;
	} else if (condition === "lead_turns_day") {
		const { start, end } = objectiveDay(runtime, now);
		const prior = await tx.get<{ id: string }>(
			"SELECT id FROM objective_events WHERE objective_id = ? AND kind = 'run.refused' AND json_extract(detail, '$.condition') = 'lead_turns_day' AND at >= ? AND at < ? LIMIT 1",
			row.id,
			start,
			end,
		);
		if (prior) return;
		const resumes = new Date(nextDayStart(now, runtime.config.timezone)).toISOString();
		body = `Objective ${url} has reached its limit of ${row.max_daily_lead_turns} lead runs today. It resumes at ${resumes}; messages wait until then.`;
	} else {
		return;
	}
	await recordObjectiveEvent(tx, runtime, { objectiveId: row.id, kind: condition.startsWith("budget") ? "budget" : "run.refused", detail: { condition } });
	runtime.db.afterCommit(() => {
		postNotice(runtime, { to: [runtime.config.user], body }).catch(report);
	});
}

/**
 * OBJ-14, OBJ-15, OBJ-16: the gate in front of a member create. The lead is the only session
 * that creates members; the roster bound and the per-run cap answer 402; a paused objective
 * refuses the create for the same reason it refuses a run.
 */
export async function memberCreateGate(db: SqliteExecutor, runtime: Runtime, objectiveId: string, parentId: string): Promise<{ run: string | null }> {
	const row = await objectiveRow(db, objectiveId);
	if (!row) throw ApiError.notFound(`objective ${objectiveId}`);
	if (row.lead_id !== parentId) {
		throw new ApiError(403, "objective_not_lead", `only the lead of objective ${row.id} creates members`, { objective: row.id, session: parentId });
	}
	const paused = await objectivePaused(db, runtime, row);
	if (paused !== null) {
		const code = paused === "budget_day" ? "objective_budget_day" : paused === "budget_total" ? "objective_budget_total" : "objective_domain_budget";
		throw new ApiError(402, code, `objective ${row.id} is paused: ${paused}`, { objective: row.id, condition: paused });
	}
	if (row.max_active_members !== null) {
		const active = await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sessions WHERE objective_id = ? AND state NOT IN ('stopped', 'archived')", row.id);
		if ((active?.n ?? 0) + 1 > row.max_active_members) {
			throw new ApiError(402, "objective_roster_full", `objective ${row.id} already has ${active?.n ?? 0} active members; its limit is ${row.max_active_members}`, {
				objective: row.id,
				members: active?.n ?? 0,
				maxActiveMembers: row.max_active_members,
			});
		}
	}
	const run = await currentLeadRun(db, row, parentId);
	const limit = runtime.config.objectives.maxMembersPerRun;
	const made = await db.get<{ n: number }>(
		"SELECT COUNT(*) AS n FROM objective_events WHERE objective_id = ? AND kind = 'member.created' AND json_extract(detail, '$.session') = ? AND COALESCE(json_extract(detail, '$.run'), 'none') = ?",
		row.id,
		parentId,
		run ?? "none",
	);
	if ((made?.n ?? 0) >= limit) {
		await refuseMemberCreate(runtime, row, parentId, run, limit);
		throw new ApiError(402, "objective_members_per_run", `objective ${row.id} allows ${limit} member creates in one lead run`, {
			objective: row.id,
			limit,
		});
	}
	return { run };
}

/** The run the lead is in now, as the newest `run.started` event it caused. */
async function currentLeadRun(db: SqliteExecutor, row: ObjectiveRow, leadId: string): Promise<string | null> {
	const found = await db.get<{ id: string }>(
		"SELECT id FROM objective_events WHERE objective_id = ? AND kind = 'run.started' AND json_extract(detail, '$.session') = ? ORDER BY at DESC, id DESC LIMIT 1",
		row.id,
		leadId,
	);
	return found?.id ?? null;
}

/** OBJ-16: record the excess and post one notice for the run, not one per attempt. */
async function refuseMemberCreate(runtime: Runtime, row: ObjectiveRow, leadId: string, run: string | null, limit: number): Promise<void> {
	const first = await runtime.db.write(async (tx) => {
		const prior = await tx.get<{ id: string }>(
			"SELECT id FROM objective_events WHERE objective_id = ? AND kind = 'member.refused' AND json_extract(detail, '$.session') = ? AND COALESCE(json_extract(detail, '$.run'), 'none') = ? LIMIT 1",
			row.id,
			leadId,
			run ?? "none",
		);
		if (prior) return false;
		await recordObjectiveEvent(tx, runtime, { objectiveId: row.id, kind: "member.refused", detail: { session: leadId, run, limit } });
		return true;
	});
	if (!first) return;
	await postNotice(runtime, {
		to: [runtime.config.user],
		body: `Objective ${objectiveUrl(runtime, row.id)}: a lead run reached its limit of ${limit} member creates. Later creates in that run are refused; the next run may create more.`,
	}).catch(report);
}

/**
 * OBJ-18, OBJ-23: a scheduled wake goes through the same gate as a delivery. A lead's wake is
 * merged into the lead's hold (its note is carried to the release). Any other session's wake
 * waits: the one-shot schedule is re-armed at the hold time rather than spent.
 */
export async function admitScheduledWake(runtime: Runtime, wake: ScheduledWake): Promise<boolean> {
	return runtime.db.write(async (tx) => {
		const session = await tx.get<{ state: string }>("SELECT state FROM sessions WHERE id = ?", wake.sessionId);
		if (!session || session.state === "stopped" || session.state === "archived") return false;
		const admission = await admitRun(tx, runtime, wake.sessionId, { kind: "wake", scheduleId: wake.scheduleId, note: wake.note });
		if (admission.admit) return submitScheduledWake(tx, runtime, wake);
		if (!admission.lead && admission.until !== undefined) {
			const now = runtime.clock.now();
			await tx.run(
				"UPDATE schedules SET state = 'active', at = ?, next_at = ?, updated_at = ? WHERE id = ? AND kind = 'wake' AND state = 'done'",
				admission.until,
				admission.until,
				now,
				wake.scheduleId,
			);
			runtime.db.afterCommit(() => notifySchedulesChanged(runtime));
		}
		return false;
	});
}

/**
 * OBJ-18: release a hold. The scheduler calls this when a hold wake fires. Held deliveries are
 * delivered in order as one run, exactly once, and the hold's own note rides along so a wake that
 * waited is not lost. The gates run again, so a condition that still holds re-holds.
 */
export async function releaseLeadHold(runtime: Runtime, input: { sessionId: string; scheduleId: string; note?: string }): Promise<boolean> {
	return runtime.db.atomically(async (tx) => {
		const session = await tx.get<SessionRow & { conversation_id: number | null }>(
			"SELECT id, state, objective_id, hold_until, conversation_id FROM sessions WHERE id = ?",
			input.sessionId,
		);
		if (!session || session.state === "archived") return false;
		// OBJ-14: the user's stop is inert; the objective's own budget stop is resumed when the hold
		// lifts (OBJ-20 sets a wake at the next local day exactly so the lead may run again).
		if (session.state === "stopped") {
			const stoppedBy = await tx.get<{ stopped_by: "user" | "objective" | null }>("SELECT stopped_by FROM sessions WHERE id = ?", input.sessionId);
			if (stoppedBy?.stopped_by === "user") return false;
			await tx.run("UPDATE sessions SET state = 'idle', stopped_by = NULL, updated_at = ? WHERE id = ?", runtime.clock.now(), input.sessionId);
		}
		if (session.hold_until !== null && session.hold_until > runtime.clock.now()) return false;
		const held = await heldDeliveries(tx, input.sessionId);
		if (held.length === 0 && input.note === undefined) return false;
		if (session.objective_id !== null) {
			const row = await objectiveRow(tx, session.objective_id);
			if (row && CLOSED_PHASES.includes(row.phase)) {
				await tx.run("UPDATE sessions SET hold_until = NULL, updated_at = ? WHERE id = ?", runtime.clock.now(), input.sessionId);
				return false;
			}
		}
		// The gates run again: a condition that still holds re-holds and this run does not start.
		const admission = await admitRun(tx, runtime, input.sessionId, { kind: "resume" });
		if (!admission.admit) return false;

		const now = runtime.clock.now();
		await tx.run("UPDATE sessions SET hold_until = NULL, updated_at = ? WHERE id = ?", now, input.sessionId);
		const conversation = await sessionConversation(runtime, input.sessionId);
		if (held.length > 0) {
			const rendered: string[] = [];
			let firstData: Record<string, string | number> = { deliveryId: held[0]!.deliveryId, messageId: held[0]!.messageId, threadId: held[0]!.threadId, seq: 0, sender: "" };
			for (const [index, item] of held.entries()) {
				const message = await renderMessage(tx, runtime, item);
				rendered.push(message.content);
				if (index === 0) firstData = message.data;
			}
			const content = [
				...rendered,
				...(input.note === undefined ? [] : ["", "Also held while the objective waited:", input.note]),
			].join("\n\n");
			const submission = await conversation.submit(
				{
					type: "input",
					content,
					whenBusy: "steer",
					entry: { kind: MESSAGE_ENTRY_KIND, data: { ...firstData, held: held.length } },
					requestId: `pana.hold:${input.scheduleId}:${now}`,
				},
				ctx,
			);
			for (const item of held) {
				await tx.run(
					"UPDATE deliveries SET wake_request_id = ?, wake_submission_id = ?, read_at = COALESCE(read_at, ?) WHERE id = ?",
					wakeRequestId(item.deliveryId),
					submission.id,
					now,
					item.deliveryId,
				);
			}
		} else {
			await conversation.submit(
				{
					type: "input",
					content: ["Objective hold released.", ...(input.note === undefined ? [] : ["", input.note]), "", "Nothing you write at the end of this run is posted. Reply with pana_reply where your note says, if anything changed that someone needs to know."].join("\n"),
					whenBusy: "followUp",
					entry: { kind: WAKE_ENTRY_KIND, data: { scheduleId: input.scheduleId } },
					requestId: `pana.hold:${input.scheduleId}:${now}`,
				},
				ctx,
			);
		}
		await setSessionState(tx, runtime, { sessionId: input.sessionId, state: "running", from: ["idle", "failed"] });
		return true;
	});
}

function deliveryDetail(intent: RunIntent): Record<string, unknown> {
	return intent.deliveryId === undefined ? {} : { delivery: intent.deliveryId };
}

function report(error: unknown): void {
	console.error("panad: objective hook failed:", error instanceof Error ? error.message : error);
}
