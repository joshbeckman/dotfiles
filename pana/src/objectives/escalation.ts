// Escalation (OBJ-33, OBJ-34): a session asks the user to decide, and the runs it covers wait.
//
// An escalation is a message in the objective's thread plus an `objective_escalations` row naming
// its scope. A null `member_id` is the objective-wide scope. While one is open, `awaiting_user`
// holds the runs it covers: the lead for either scope, plus the named member for a member scope.
// The rest of the objective keeps working, so a decision the user takes a day to make blocks a
// decision rather than the whole objective.
//
// Clearing is a user message in the objective's thread, or the charter `Escalation` section's
// timeout elapsing. Both mark the row `cleared` and record `objective_events`. A cleared
// escalation's held deliveries are handed to `deliverHeld`, which delivers each exactly once.
//
// The hold's *mechanics* (the quiet interval, the budgets, the lead-turn cap) belong to
// `obj/lead-limits`; `admission.ts` is the seam where this module's hold and that one compose.

import type { SqliteExecutor } from "@earendil-works/chord/sqlite";
import { ApiError } from "../api/errors.ts";
import type { Caller } from "../api/types.ts";
import type { Runtime } from "../server/runtime.ts";
import { parseDuration } from "../schedules/store.ts";
import { announce, respondIn, type ThreadResult } from "../threads/index.ts";
import { charterSections } from "./charter.ts";
import { objectBody } from "./schema.ts";
import { loadObjective, objectiveId, objectiveMembers, objectiveRow, personView, recordObjectiveEvent, type ObjectivePersonView } from "./state.ts";

export interface EscalationRow {
	id: string;
	objective_id: string;
	/** Null for the objective-wide scope (OBJ-34). */
	member_id: string | null;
	thread_id: string;
	message_id: string;
	state: "open" | "cleared";
	timeout_at: number | null;
	cleared_at: number | null;
	created_at: number;
}

/** One open escalation as the view, the briefing, and the CLI show it. */
export interface EscalationView {
	id: string;
	scope: "objective" | "member";
	member: ObjectivePersonView | null;
	/** The thread it waits on, and the message the user answers. */
	thread: { id: string; url: string };
	url: string;
	createdAt: number;
	timeoutAt: number | null;
}

export function escalationView(runtime: Runtime, row: EscalationRow): EscalationView {
	return {
		id: row.id,
		scope: row.member_id === null ? "objective" : "member",
		member: row.member_id === null ? null : personView(runtime, row.member_id),
		thread: { id: row.thread_id, url: runtime.url({ kind: "thread", id: row.thread_id }) },
		url: runtime.url({ kind: "message", id: row.message_id, thread: row.thread_id }),
		createdAt: row.created_at,
		timeoutAt: row.timeout_at,
	};
}

/**
 * OBJ-33: the escalations still holding something — open, and not past its timeout. A timeout
 * that has elapsed stops holding the moment it passes, even before the sweeper marks the row.
 */
export async function openEscalations(db: SqliteExecutor, runtime: Runtime, objectiveId: string): Promise<EscalationRow[]> {
	const now = runtime.clock.now();
	return db.all<EscalationRow>(
		`SELECT * FROM objective_escalations
		  WHERE objective_id = ? AND state = 'open' AND (timeout_at IS NULL OR timeout_at > ?)
		  ORDER BY created_at, id`,
		objectiveId,
		now,
	);
}

/**
 * OBJ-33's timeout comes from the charter's `Escalation` section: a line such as `timeout: 24h`.
 * The section is Markdown, so the timeout is one convention inside it, and prose without a
 * `timeout:` line means the escalation waits until the user answers.
 */
export async function charterEscalationTimeout(db: SqliteExecutor, objectiveId: string): Promise<number | undefined> {
	const sections = await charterSections(db, objectiveId);
	const revision = sections.Escalation;
	if (revision === undefined) return undefined;
	for (const line of revision.body.split("\n")) {
		const match = /^\s*timeout\s*:\s*(\S+)\s*$/i.exec(line);
		if (match) {
			try {
				return parseDuration(match[1]);
			} catch {
				return undefined;
			}
		}
	}
	return undefined;
}

export interface EscalateInput {
	body?: unknown;
	member?: unknown;
}

function memberId(runtime: Runtime, value: unknown): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string") throw ApiError.badRequest("invalid_member", "member must be a session ID or URL");
	const text = value.trim();
	if (text.length === 0) return undefined;
	return text;
}

/**
 * `POST /objectives/:id/escalate` (OBJ-33, OBJ-34). The lead or the user may escalate; `--member`
 * names the member whose work the decision covers. No member, or a scope the caller cannot decide,
 * is the objective-wide form, which holds every lead run.
 */
export async function escalateObjective(
	runtime: Runtime,
	caller: Caller,
	value: string | null | undefined,
	raw: unknown,
): Promise<{ escalation: EscalationView; thread: ThreadResult["thread"] }> {
	const input = objectBody(raw) as EscalateInput;
	const id = objectiveId(value, runtime.config.domain);
	const row = await loadObjective(runtime.db, id);
	if (row.thread_id === null) {
		throw new ApiError(409, "not_launched", `objective ${id} has no thread to escalate in; the user launches it first`, { objective: id });
	}
	if (caller.kind === "session" && caller.id !== row.lead_id) {
		throw ApiError.forbidden(`session ${caller.id} does not lead objective ${id}`);
	}
	const body = typeof input.body === "string" ? input.body : "";
	if (body.trim().length === 0) throw ApiError.badRequest("missing_body", "an escalation needs --body TEXT or --body-file PATH");

	// OBJ-34: a member scope holds that member and the lead runs that would act on it. Naming a
	// session that is not a member is a usage error, not a silent widening of the hold.
	let member: string | null = null;
	const named = memberId(runtime, input.member);
	if (named !== undefined) {
		const members = await objectiveMembers(runtime.db, id);
		const found = members.find((candidate) => candidate.id === named || candidate.url === named);
		if (found === undefined) {
			throw ApiError.badRequest("invalid_member", `${named} is not a member of objective ${id}; escalate objective-wide by omitting --member`, { objective: id });
		}
		if (found.id === row.lead_id) throw ApiError.badRequest("invalid_member", `${named} is the lead; an escalation about the lead is objective-wide`, { objective: id });
		member = found.id;
	}

	const timeoutMs = await charterEscalationTimeout(runtime.db, id);
	const escalationId = runtime.newId();
	const recipients: string[] = [];
	const result = await runtime.db.atomically(async (tx) => {
		const current = await loadObjective(tx, id);
		if (current.thread_id === null) throw new ApiError(409, "not_launched", `objective ${id} has no thread`, { objective: id });
		const now = runtime.clock.now();
		const appended = await respondIn(tx, runtime, caller, current.thread_id, { body }, recipients);
		const timeoutAt = timeoutMs === undefined ? null : now + timeoutMs;
		await tx.run(
			`INSERT INTO objective_escalations (id, objective_id, member_id, thread_id, message_id, state, timeout_at, cleared_at, created_at)
			 VALUES (?, ?, ?, ?, ?, 'open', ?, NULL, ?)`,
			escalationId,
			id,
			member,
			current.thread_id,
			appended.message.id,
			timeoutAt,
			now,
		);
		await recordObjectiveEvent(tx, runtime, {
			objectiveId: id,
			kind: "escalated",
			actorId: caller.id,
			detail: {
				escalation: escalationId,
				scope: member === null ? "objective" : "member",
				...(member === null ? {} : { member }),
				thread: runtime.url({ kind: "thread", id: current.thread_id }),
				message: runtime.url({ kind: "message", id: appended.message.id, thread: current.thread_id }),
				...(timeoutAt === null ? {} : { timeoutAt }),
			},
		});
		return appended;
	});
	// PSH-03: the objective thread's users get the push, through the same announce every message uses.
	announce(runtime, "delivery", result, recipients);

	const escalation = await runtime.db.get<EscalationRow>("SELECT * FROM objective_escalations WHERE id = ?", escalationId);
	return { escalation: escalationView(runtime, escalation!), thread: result.thread };
}

/**
 * OBJ-33/34: does an open escalation hold this session's runs? The lead is held by either scope;
 * a member only by an escalation that names it. `tx` may be a transaction or the database.
 */
export async function escalationHold(
	db: SqliteExecutor,
	runtime: Runtime,
	sessionId: string,
): Promise<{ escalation: EscalationRow; view: EscalationView } | undefined> {
	const session = await db.get<{ objective_id: string | null }>("SELECT objective_id FROM sessions WHERE id = ?", sessionId);
	if (session?.objective_id === null || session?.objective_id === undefined) return undefined;
	const objective = await objectiveRow(db, session.objective_id);
	if (objective === undefined || objective.phase !== "active") return undefined;
	const open = await openEscalations(db, runtime, objective.id);
	if (open.length === 0) return undefined;
	if (objective.lead_id === sessionId) return { escalation: open[0]!, view: escalationView(runtime, open[0]!) };
	const scoped = open.find((row) => row.member_id === sessionId);
	return scoped === undefined ? undefined : { escalation: scoped, view: escalationView(runtime, scoped) };
}

export interface ClearEscalationsOptions {
	/** The objective whose escalations clear. */
	objectiveId: string;
	/** Only these escalations, for a timeout that reaches the one that ran out. Default: every open one. */
	ids?: readonly string[];
	/** Why: a user's message in the objective thread, or the charter's timeout. */
	reason: "user_message" | "timeout";
	/** The message that cleared it, when a message did. */
	messageId?: string;
}

/**
 * Mark every open escalation of an objective cleared and record why (OBJ-33). Returns the cleared
 * rows, so the caller can hand their held deliveries to `deliverHeld` after it commits.
 */
export async function clearEscalations(tx: SqliteExecutor, runtime: Runtime, options: ClearEscalationsOptions): Promise<EscalationRow[]> {
	const now = runtime.clock.now();
	const ids = options.ids;
	const open = await tx.all<EscalationRow>(
		`SELECT * FROM objective_escalations WHERE objective_id = ? AND state = 'open'${ids === undefined ? "" : ` AND id IN (${ids.map(() => "?").join(",")})`} ORDER BY created_at, id`,
		options.objectiveId,
		...(ids ?? []),
	);
	for (const row of open) {
		await tx.run("UPDATE objective_escalations SET state = 'cleared', cleared_at = ? WHERE id = ? AND state = 'open'", now, row.id);
		await recordObjectiveEvent(tx, runtime, {
			objectiveId: options.objectiveId,
			kind: "escalation.cleared",
			detail: {
				escalation: row.id,
				reason: options.reason,
				scope: row.member_id === null ? "objective" : "member",
				...(row.member_id === null ? {} : { member: row.member_id }),
				...(options.messageId === undefined ? {} : { message: options.messageId }),
			},
		});
	}
	return open;
}

/** The objective whose thread this is, for a user message that may clear its escalations. */
export async function objectiveOfThread(db: SqliteExecutor, threadId: string): Promise<string | undefined> {
	const row = await db.get<{ id: string }>("SELECT id FROM objectives WHERE thread_id = ?", threadId);
	return row?.id;
}

/**
 * OBJ-33: a user message in the objective's thread clears it. Called inside the append's
 * transaction, so the message and the clearing commit together. Returns how many cleared.
 */
export async function clearForUserMessage(tx: SqliteExecutor, runtime: Runtime, threadId: string, messageId: string): Promise<number> {
	const objectiveId = await objectiveOfThread(tx, threadId);
	if (objectiveId === undefined) return 0;
	return (await clearEscalations(tx, runtime, { objectiveId, reason: "user_message", messageId })).length;
}

/** Clear every escalation whose timeout has elapsed, recording the event. Returns how many. */
export async function clearDueEscalations(runtime: Runtime): Promise<number> {
	const now = runtime.clock.now();
	const due = await runtime.db.all<EscalationRow>("SELECT * FROM objective_escalations WHERE state = 'open' AND timeout_at IS NOT NULL AND timeout_at <= ?", now);
	let cleared = 0;
	for (const row of due) {
		await runtime.db.write(async (tx) => {
			const current = await tx.get<EscalationRow>("SELECT * FROM objective_escalations WHERE id = ? AND state = 'open'", row.id);
			if (!current || (current.timeout_at !== null && current.timeout_at > now)) return;
			cleared += (await clearEscalations(tx, runtime, { objectiveId: row.objective_id, ids: [row.id], reason: "timeout" })).length;
		});
	}
	return cleared;
}

export interface EscalationTimeouts {
	close(): Promise<void>;
}

/**
 * OBJ-33: clear escalations whose charter timeout has elapsed. A timer on `runtime.clock` — not a
 * sweeper over objective state — so the fake clock drives it in tests. `wake` is the session
 * runtime's `deliverHeld`, handed in here so this package does not import WP3.
 */
export function startEscalationTimeouts(
	runtime: Runtime,
	report: (error: unknown, what: string) => void,
	wake: () => Promise<number> = async () => 0,
): EscalationTimeouts {
	let closed = false;
	let cancel: (() => void) | undefined;
	let inFlight: Promise<void> | undefined;
	const tick = () => {
		if (closed) return;
		cancel = runtime.clock.setTimer(tick, TIMEOUT_TICK_MS, { background: false });
		if (inFlight) return;
		const run = (async () => {
			const cleared = await clearDueEscalations(runtime);
			// A cleared escalation's held deliveries are due now; deliver rather than leave them.
			if (cleared > 0) await wake();
		})();
		inFlight = run;
		run.catch((error) => report(error, "escalation timeout")).finally(() => {
			if (inFlight === run) inFlight = undefined;
		});
	};
	tick();
	return {
		async close() {
			closed = true;
			cancel?.();
			await inFlight?.catch(() => undefined);
		},
	};
}

/** How often an elapsed escalation timeout is noticed. A timeout is never more precise than this. */
export const TIMEOUT_TICK_MS = 60_000;
