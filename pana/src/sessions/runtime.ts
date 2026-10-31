// The session runtime: delivery, run settlement, states, and limits (DLV, STA, LIM).
//
// Three things drive a session:
// - The WP2 delivery hook, inside the append transaction, submits the wake (DLV-01..06).
// - A pi-durable commit listener sees runs settle and usage grow. It only records what changed;
//   a FIFO queue then updates state, indexes the transcript, posts failure notices, and applies
//   the budgets, each in its own transaction and in commit order.
// - The `onYield` hook in reply.ts posts the auto-reply before the answer commits (RPL).
//
// State is never cached in memory. A settled run sets the state from what pi-durable shows at
// processing time (a new run already started → `running`), so a late event cannot overwrite a
// newer one, and `stopped` and `archived` are only changed by stop, resume, and archive.

import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { SqliteExecutor } from "@earendil-works/chord/sqlite";
import {
	LiveDoc,
	type CommitPublication,
	type ConversationId,
	type EntryId,
	type EntryRecord,
	type LiveState,
	type SubmissionId,
	type SubmissionRecord,
	type UsageState,
} from "@earendil-works/pi-durable";
import { ApiError } from "../api/errors.ts";
import { clearForUserMessage } from "../objectives/escalation.ts";
import { admitRun, recordBudgetHold, recordRunEnded } from "../objectives/hold.ts";
import { objectivePaused } from "../objectives/limits.ts";
import { assertObjectiveOpen, objectiveRow } from "../objectives/state.ts";
import { assertNotSupersededLead, recordLeadFailure, regenerateOffer } from "../objectives/stranded.ts";
import { wakeRequestId, type PendingWake } from "../db/outbox.ts";
import { indexSessionRun, type TranscriptEntry } from "../search/index.ts";
import type { Runtime } from "../server/runtime.ts";
import { configureDelivery, type DeliveredEvent, type DeliveryHooks } from "../threads/delivery.ts";
import { postNotice } from "../threads/store.ts";
import { publish, subscriberCount } from "../web/index.ts";
import { nextDayStart, overDomainBudget, recordCost, usageCost } from "./budget.ts";
import { LiveFeed } from "./live.ts";
import { setSessionState } from "./state.ts";
import { MESSAGE_ENTRY_KIND, NOTE_ENTRY_KIND } from "./wake.ts";
import { removeArchivedScratch } from "../scratch/index.ts";
import { stopArchivedBrowser } from "../extension/browser.ts";

export type SessionState = "running" | "waiting" | "idle" | "failed" | "stopped" | "archived";
export const SESSION_STATES: readonly SessionState[] = ["running", "waiting", "idle", "failed", "stopped", "archived"];

/** The stored states a settled run or a recovery may replace. `stopped` and `archived` hold. */
const LIVE_STATES: readonly SessionState[] = ["running", "idle", "failed"];
/** Every stored state a session can leave, which is all of them but `archived` (STA-07). */
const UNARCHIVED_STATES: readonly SessionState[] = [...LIVE_STATES, "stopped"];

export interface SessionRow {
	id: string;
	conversation_id: number | null;
	state: SessionState;
	parent: string | null;
	depth: number;
	model: string | null;
	thinking: string | null;
	profile: string | null;
	cwd: string | null;
	created_at: number;
	updated_at: number;
	cost_usd: number;
	/** OBJ-15: the objective this session acts for, inherited at create. */
	objective_id: string | null;
	stopped_by: "user" | "objective" | null;
	hold_until: number | null;
	scratch_removed_at?: number | null;
	scratch_removed_bytes?: number | null;
}

type Report = (error: unknown, what: string) => void;

type Job = () => Promise<void>;

/** `UsageDoc`'s and `LiveDoc`'s kinds; the tokens do not expose them. */
const USAGE_DOC_KIND = "pi.usage";
const LIVE_DOC_KIND = "pi.live";

/** Unanswered reasons that are not a failure of the run itself. */
const NOT_FAILURES = new Set(["aborted", "reset"]);

export class SessionRuntime {
	readonly runtime: Runtime;
	readonly #report: Report;
	#queue: Promise<void> = Promise.resolve();
	#closed = false;
	#unsubscribe: (() => void) | undefined;
	#rollover: (() => void) | undefined;
	/** The message whose thread `rejectArchived` last passed. */
	#checkedMessage: string | undefined;
	readonly #live: LiveFeed;

	constructor(runtime: Runtime, report: Report) {
		this.runtime = runtime;
		this.#report = report;
		this.#live = new LiveFeed(runtime, (job, what) => this.enqueue(job, what));
	}

	start(): void {
		configureDelivery(this.runtime, this.hooks());
		this.#unsubscribe = this.runtime.harness.subscribeCommits((publication) => this.#onCommit(publication));
	}

	/**
	 * Startup work: runs that settled while nothing processed them, and mail held back. It is
	 * queued, not awaited, so a slow abort cannot hold up panad's listeners; `idle()` waits for it.
	 */
	recover(): void {
		this.enqueue(async () => {
			const running = await this.runtime.db.all<SessionRow>(
				"SELECT * FROM sessions WHERE state = 'running' AND conversation_id IS NOT NULL",
			);
			for (const session of running) await this.#reconcile(session);
		}, "startup reconcile");
		this.enqueue(() => this.#deliverHeldOrWait(), "held mail");
	}

	/** Resolves once every queued job has run. */
	async idle(): Promise<void> {
		let seen: Promise<void> | undefined;
		while (seen !== this.#queue) {
			seen = this.#queue;
			await seen;
		}
	}

	async close(): Promise<void> {
		this.#closed = true;
		this.#unsubscribe?.();
		this.#live.close();
		this.#rollover?.();
		this.#rollover = undefined;
		await this.#queue;
	}

	enqueue(job: Job, what = "session job"): void {
		if (this.#closed) return;
		this.#queue = this.#queue.then(async () => {
			if (this.#closed) return;
			try {
				await job();
			} catch (error) {
				if (!this.#closed) this.#report(error, what);
			}
		});
	}

	// --- Delivery (DLV) ----------------------------------------------------------

	hooks(): DeliveryHooks {
		return {
			onDelivered: async (tx, event, runtime) => {
				// One append calls this once per recipient, inside one transaction, so the thread's
				// check holds for all of them. Checking each time made a broadcast quadratic in its
				// participants (BENCH.md).
				if (this.#checkedMessage !== event.messageId) {
					await rejectArchived(tx, event);
					this.#checkedMessage = event.messageId;
				}
				if (event.recipientKind !== "session") return;
				// OBJ-07: a closed objective refuses deliveries to its members, so it cannot spend
				// by accident. The throw rolls back the append with it.
				await assertObjectiveOpen(tx, event.recipientId);
				// OBJ-33: a user's message in the objective's thread answers the escalation. Clearing
				// before admission means the message that clears it is also the run that carries it.
				if (event.senderKind === "user") {
					const cleared = await clearForUserMessage(tx, this.runtime, event.threadId, event.messageId);
					// After the message commits, hand whatever the escalation held to `deliverHeld`.
					if (cleared > 0) {
						this.runtime.db.afterCommit(() =>
							this.enqueue(async () => {
								await this.deliverHeld();
							}, "held deliveries"),
						);
					}
				}
				if (event.requestId === null) return;
				// OBJ-18..OBJ-24, OBJ-33/34: one admission choke point decides whether the run may
				// start, and escalation is one of its conditions (`hold.ts` asks
				// `objectiveRunHold` first). A held or refused delivery stays unread with no wake,
				// so `deliverHeld` finds it when the hold lifts or the next local day turns.
				const admission = await admitRun(tx, runtime, event.recipientId, {
					kind: "delivery",
					deliveryId: event.deliveryId,
					messageId: event.messageId,
				});
				if (!admission.admit) {
					await tx.run("UPDATE deliveries SET wake_request_id = NULL WHERE id = ?", event.deliveryId);
					// LIM-03 and OBJ-20: held mail is retried when the local day turns.
					if (admission.condition === "domain_budget" || admission.condition === "budget_day") this.#armRollover();
					return;
				}
				await wakeDelivery(tx, runtime, {
					deliveryId: event.deliveryId,
					messageId: event.messageId,
					threadId: event.threadId,
					recipientId: event.recipientId,
					requestId: event.requestId,
				});
			},
		};
	}

	/**
	 * Submit mail that never woke its session: queued while it was stopped, withdrawn by a stop,
	 * or held by the domain budget. Oldest first, so it arrives in order (STA-05).
	 */
	async deliverHeld(sessionId?: string): Promise<number> {
		const { db } = this.runtime;
		const rows = await db.all<{ id: string; message_id: string; thread_id: string; recipient_id: string }>(
			`SELECT d.id, d.message_id, d.thread_id, d.recipient_id
			   FROM deliveries d
			   JOIN sessions s ON s.id = d.recipient_id
			   JOIN messages m ON m.id = d.message_id
			  WHERE d.read_at IS NULL AND d.wake_request_id IS NULL AND d.wake_submission_id IS NULL
			    AND s.conversation_id IS NOT NULL AND s.state NOT IN ('stopped', 'archived')
			    -- OBJ-18: a hold wake owns its lead's release, so the budget rollover leaves it alone.
			    AND s.hold_until IS NULL
			    ${sessionId === undefined ? "" : "AND s.id = ?"}
			  ORDER BY m.created_at, m.seq, d.id`,
			...(sessionId === undefined ? [] : [sessionId]),
		);
		let delivered = 0;
		for (const row of rows) {
			const done = await db.atomically(async (tx) => {
				const current = await tx.get<{ state: string }>("SELECT state FROM sessions WHERE id = ?", row.recipient_id);
				if (current?.state === "stopped" || current?.state === "archived") return true;
				// OBJ-23, OBJ-33/34: the same gate that holds a fresh delivery also holds mail
				// retried here, so a cleared escalation's mail is carried from this one path.
				const admission = await admitRun(tx, this.runtime, row.recipient_id, { kind: "delivery", deliveryId: row.id, messageId: row.message_id });
				if (!admission.admit) return admission.condition === "domain_budget" || admission.condition === "budget_day" ? false : "skipped";
				// A fresh request ID: the delivery's first one may already name a settled submission.
				const requestId = `${wakeRequestId(row.id)}:${this.runtime.newId()}`;
				await tx.run("UPDATE deliveries SET wake_request_id = ? WHERE id = ?", requestId, row.id);
				await wakeDelivery(tx, this.runtime, {
					deliveryId: row.id,
					messageId: row.message_id,
					threadId: row.thread_id,
					recipientId: row.recipient_id,
					requestId,
				});
				delivered++;
				return true;
			});
			if (done === false) {
				this.#armRollover();
				break;
			}
		}
		return delivered;
	}

	async #deliverHeldOrWait(): Promise<void> {
		if (await overDomainBudget(this.runtime.db, this.runtime)) this.#armRollover();
		else await this.deliverHeld();
	}

	/** LIM-03: at the next local day, deliver the mail the budget held. */
	#armRollover(): void {
		if (this.#rollover || this.#closed) return;
		const { clock, config } = this.runtime;
		const now = clock.now();
		const at = nextDayStart(now, config.timezone);
		let cancel: (() => void) | undefined;
		const fire = () => {
			if (this.#rollover === stop) this.#rollover = undefined;
			this.enqueue(() => this.#deliverHeldOrWait(), "budget rollover");
		};
		const stop = () => cancel?.();
		this.#rollover = stop;
		cancel = clock.setTimer(fire, at - now, { background: false });
	}

	// --- Stop and resume (STA-04, STA-05) ----------------------------------------

	/**
	 * STA-04, OBJ-14: stop the session and record who did it. `user` is the user's own stop; a
	 * session stopping a member it created writes `objective`. A member the user stopped is inert
	 * to the objective until the user resumes it.
	 */
	async stop(sessionId: string, stoppedBy: "user" | "objective" | null = null): Promise<void> {
		const { db, harness } = this.runtime;
		const session = await db.get<SessionRow>("SELECT * FROM sessions WHERE id = ?", sessionId);
		if (!session) throw ApiError.notFound(`session ${sessionId}`);
		if (session.state === "archived") throw ApiError.stale(`session ${sessionId} is archived`, { session: sessionId });
		await db.write(async (tx) => {
			await setSessionState(tx, this.runtime, { sessionId, state: "stopped", from: UNARCHIVED_STATES });
			// OBJ-18: a stopped session is not waiting on a hold any more.
			await tx.run(
				"UPDATE sessions SET stopped_by = ?, hold_until = NULL, updated_at = ? WHERE id = ?",
				stoppedBy,
				this.runtime.clock.now(),
				sessionId,
			);
		});
		if (session.conversation_id === null) return;
		const conversation = await harness.conversation(session.conversation_id as ConversationId, ctx);
		if (!conversation) return;
		const pending = (await harness.inspect(ctx)).submissions
			.filter((s) => s.conversationId === conversation.id && s.type === "input" && s.status === "queued")
			.map((s) => s.id);
		await conversation.abort(ctx);
		// Mail the abort withdrew never reached the model: make it unread again so resume delivers it.
		for (const id of pending) {
			const record = await (await harness.submission(id, ctx))?.status(ctx);
			if (record?.status !== "unanswered" || record.entry !== undefined) continue;
			await db.write((tx) =>
				tx.run(
					`UPDATE deliveries SET read_at = NULL, wake_request_id = NULL, wake_submission_id = NULL
					  WHERE recipient_id = ? AND wake_submission_id = ?`,
					sessionId,
					id,
				),
			);
		}
	}

	async resume(sessionId: string): Promise<void> {
		const { db } = this.runtime;
		const session = await db.get<SessionRow>("SELECT * FROM sessions WHERE id = ?", sessionId);
		if (!session) throw ApiError.notFound(`session ${sessionId}`);
		// OBJ-35: a lead the user replaced cannot resume itself into the objective.
		await assertNotSupersededLead(db, sessionId);
		if (session.state === "archived") throw ApiError.stale(`session ${sessionId} is archived`, { session: sessionId });
		if (session.state === "stopped") {
			await db.write(async (tx) => {
				await setSessionState(tx, this.runtime, { sessionId, state: "idle", from: ["stopped"] });
				// OBJ-14: a resumed member is no longer recorded as stopped by anyone.
				await tx.run("UPDATE sessions SET stopped_by = NULL, hold_until = NULL, updated_at = ? WHERE id = ?", this.runtime.clock.now(), sessionId);
			});
		}
		if (await overDomainBudget(db, this.runtime)) {
			this.#armRollover();
			return;
		}
		await this.deliverHeld(sessionId);
	}

	/** STA-07: stop the session for good. Its threads become read-only. */
	async archive(sessionId: string, stoppedBy: "user" | "objective" | null = null): Promise<void> {
		const session = await this.runtime.db.get<SessionRow>("SELECT state FROM sessions WHERE id = ?", sessionId);
		if (!session) throw ApiError.notFound(`session ${sessionId}`);
		if (session.state === "archived") return;
		await this.stop(sessionId, stoppedBy);
		await this.runtime.db.write((tx) =>
			setSessionState(tx, this.runtime, { sessionId, state: "archived", from: UNARCHIVED_STATES }),
		);
		await removeArchivedScratch(this.runtime, sessionId);
		// ISO-07: the sweep would get to it, but an archived session never browses again.
		await stopArchivedBrowser(this.runtime, sessionId);
	}

	// --- Commits -------------------------------------------------------------------

	#onCommit(publication: CommitPublication): void {
		const settled = new Map<ConversationId, SubmissionRecord[]>();
		const usage = new Map<ConversationId, UsageState>();
		const entries: EntryRecord[] = [];
		const live = new Map<ConversationId, LiveState | null>();
		for (const change of publication.changes) {
			if (change.type === "entry") {
				entries.push(change.value);
			} else if (change.type === "submission") {
				const value = change.value;
				if (value.type !== "input" || value.entry === undefined) continue;
				if (value.status !== "done" && value.status !== "unanswered") continue;
				const list = settled.get(value.conversationId) ?? [];
				list.push(value);
				settled.set(value.conversationId, list);
			} else if (change.type === "document" && change.record.kind === USAGE_DOC_KIND && change.conversationId !== undefined && change.value) {
				usage.set(change.conversationId, change.value as UsageState);
			} else if (change.type === "document" && change.record.kind === LIVE_DOC_KIND && change.conversationId !== undefined) {
				live.set(change.conversationId, change.value as LiveState | null);
			}
		}
		for (const [conversationId, inputs] of settled) {
			this.enqueue(() => this.#settle(conversationId, inputs), "run settlement");
		}
		for (const [conversationId, value] of usage) {
			this.enqueue(() => this.#charge(conversationId, usageCost(value)), "cost update");
		}
		// WEB-06: an open Sessions view streams new transcript entries. With no window open there is
		// nothing to tell, and a window that opens later loads the transcript route instead.
		const watched = subscriberCount(this.runtime) > 0;
		if (entries.length > 0 && watched) {
			this.enqueue(() => this.#publishEntries(entries), "transcript event");
		}
		// UX-12: after the entries, so a window sees each committed entry before the live state
		// that no longer holds its in-progress block.
		if (watched) for (const [conversationId, value] of live) this.#live.note(conversationId, value);
	}

	/** Stream entries to the PWA in the transcript route's shape, oldest first. */
	async #publishEntries(entries: EntryRecord[]): Promise<void> {
		const sessions = new Map<number, string | undefined>();
		for (const entry of [...entries].sort((a, b) => a.id - b.id)) {
			if (!sessions.has(entry.conversationId)) {
				const row = await this.runtime.db.get<{ id: string }>("SELECT id FROM sessions WHERE conversation_id = ?", entry.conversationId);
				sessions.set(entry.conversationId, row?.id);
			}
			const sessionId = sessions.get(entry.conversationId);
			if (sessionId === undefined) continue;
			await publish(this.runtime, {
				kind: "session.entry",
				sessionId,
				entry: {
					id: entry.id as number,
					kind: entry.kind,
					...(entry.data === undefined ? {} : { data: entry.data }),
					...(entry.model === undefined ? {} : { model: entry.model }),
				},
			});
		}
	}

	/** A run ended: index it, set the state, and post a notice if it failed (STA-01, STA-02, SRC-03). */
	async #settle(conversationId: ConversationId, inputs: SubmissionRecord[]): Promise<void> {
		const { db, harness } = this.runtime;
		const session = await db.get<SessionRow>("SELECT * FROM sessions WHERE conversation_id = ?", conversationId);
		if (!session) return;
		const ordered = [...inputs].sort((a, b) => a.id - b.id);
		const starter = ordered[0]!;
		const failure = ordered.find((input) => input.status === "unanswered" && !NOT_FAILURES.has(input.reason));
		const answer = ordered.find((input) => input.status === "done")?.answer;

		const conversation = await harness.conversation(conversationId, ctx);
		const entries = conversation ? await runEntries(conversation, starter.entry as EntryId, answer) : [];
		const live = await harness.snapshot(LiveDoc, conversationId, ctx);
		const next: SessionState = live?.run !== undefined ? "running" : failure ? "failed" : "idle";

		const changed = await db.write(async (tx) => {
			await indexSessionRun(tx, { sessionId: session.id, entries: transcriptText(entries) });
			// OBJ-18, OBJ-19: the quiet interval and the run rollup read when a run ended.
			await recordRunEnded(tx, this.runtime, session, next);
			return setSessionState(tx, this.runtime, { sessionId: session.id, state: next, from: LIVE_STATES });
		});

		if (failure && changed) {
			const trigger = await triggeringDelivery(db, session.id, starter.id);
			const detail = failure.status === "unanswered" && failure.detail !== undefined ? `: ${String(failure.detail)}` : "";
			const reason = failure.status === "unanswered" ? failure.reason : "failed";
			// OBJ-36: a lead's failed run leaves the objective stranded, and its thread and message
			// are recorded so the user can read what happened before deciding to replace it.
			const lead = session.objective_id === null ? undefined : await leadObjective(db, session.objective_id, session.id);
			if (lead !== undefined) {
				await recordLeadFailure(this.runtime, {
					objectiveId: lead,
					sessionId: session.id,
					reason,
					...(trigger === undefined ? {} : { threadId: trigger.thread_id, messageId: trigger.message_id }),
				});
			}
			await postNotice(this.runtime, {
				body: [
					`Session ${this.runtime.url({ kind: "session", id: session.id })} failed (${reason}${detail}). Send it a message to try again.`,
					...(lead === undefined ? [] : [regenerateOffer(this.runtime, lead)]),
				].join("\n"),
				...(trigger ? { thread: trigger.thread_id } : {}),
			});
		}
	}

	/** After a restart, settle a session marked running whose run ended while nothing processed it. */
	async #reconcile(session: SessionRow): Promise<void> {
		const { db, harness } = this.runtime;
		const conversationId = session.conversation_id as ConversationId;
		const live = await harness.snapshot(LiveDoc, conversationId, ctx);
		if (live?.run !== undefined) return;
		if ((await harness.inspect(ctx)).submissions.some((s) => s.conversationId === conversationId)) return;
		const last = await db.get<{ wake_submission_id: number }>(
			`SELECT wake_submission_id FROM deliveries
			  WHERE recipient_id = ? AND wake_submission_id IS NOT NULL
			  ORDER BY created_at DESC, id DESC LIMIT 1`,
			session.id,
		);
		const record = last ? await (await harness.submission(last.wake_submission_id as SubmissionId, ctx))?.status(ctx) : undefined;
		if (record?.type === "input" && record.entry !== undefined && (record.status === "done" || record.status === "unanswered")) {
			await this.#settle(conversationId, [record]);
			return;
		}
		await db.write((tx) =>
			setSessionState(tx, this.runtime, { sessionId: session.id, state: "idle", from: ["running"] }),
		);
	}

	/** LIM-02, LIM-03: charge new spend, stop a session over its budget, and warn once per day. */
	async #charge(conversationId: ConversationId, total: number): Promise<void> {
		const { db, config } = this.runtime;
		const session = await db.get<SessionRow>("SELECT * FROM sessions WHERE conversation_id = ?", conversationId);
		if (!session) return;
		const update = await db.write((tx) => recordCost(tx, this.runtime, session.id, total));
		if (!update) return;
		const url = this.runtime.url({ kind: "session", id: session.id });
		if (update.sessionCost > config.budget.sessionUsd) {
			const current = await db.get<{ state: string }>("SELECT state FROM sessions WHERE id = ?", session.id);
			if (current && current.state !== "stopped" && current.state !== "archived") {
				await this.stop(session.id);
				await postNotice(this.runtime, {
					body: `Session ${url} was stopped: it spent $${update.sessionCost.toFixed(2)}, over its budget of $${config.budget.sessionUsd.toFixed(2)}.`,
					to: creatorOf(this.runtime, session),
				});
			}
		}
		if (update.dayCrossed) {
			await postNotice(this.runtime, {
				body: `Pana spent $${update.dayCost.toFixed(2)} today, over the daily budget of $${config.budget.domainDailyUsd.toFixed(2)}. No new runs start until tomorrow.`,
				to: config.user,
			});
			this.#armRollover();
		}
		// OBJ-20, OBJ-21: the objective's own budget may have crossed, the lead included.
		if (update.objectiveId !== null) await this.enforceObjectiveBudget(update.objectiveId);
	}

	/**
	 * OBJ-20, OBJ-21: at or over an objective's budget no run starts, running members stop with
	 * `stopped_by: objective`, one notice says why, and the day budget sets a wake at the next
	 * local day. The lifetime budget sets no wake: it holds until the user acts.
	 */
	async enforceObjectiveBudget(objectiveId: string): Promise<void> {
		const { db } = this.runtime;
		const row = await objectiveRow(db, objectiveId);
		if (!row || row.phase !== "active") return;
		const paused = await objectivePaused(db, this.runtime, row);
		// OBJ-22: the domain budget refuses new runs but stops nothing; LIM-03 already owns it.
		if (paused === null || paused === "domain_budget") return;
		const running = await db.all<{ id: string; stopped_by: "user" | "objective" | null }>(
			"SELECT id, stopped_by FROM sessions WHERE objective_id = ? AND state IN ('running', 'waiting')",
			objectiveId,
		);
		for (const member of running) {
			if (member.stopped_by === "user") continue;
			try {
				await this.stop(member.id, "objective");
			} catch (error) {
				this.#report(error, "objective budget stop");
			}
		}
		await db.write((tx) => recordBudgetHold(tx, this.runtime, row, paused));
	}
}

const runtimes = new WeakMap<Runtime, SessionRuntime>();

/** Start the session runtime for a panad. Call before the startup wake sweep and `harness.resume()`. */
export function startSessions(runtime: Runtime, report: Report = () => {}): SessionRuntime {
	const sessions = new SessionRuntime(runtime, report);
	runtimes.set(runtime, sessions);
	sessions.start();
	return sessions;
}

export function sessionRuntime(runtime: Runtime): SessionRuntime {
	const sessions = runtimes.get(runtime);
	if (!sessions) throw new Error("the session runtime is not running");
	return sessions;
}

// --- Helpers -------------------------------------------------------------------

/**
 * STA-07: a thread with an archived session is read-only. Every delivery checks the whole thread,
 * so the first one, before any wake has joined the transaction, rejects and rolls back the append.
 */
async function rejectArchived(tx: SqliteExecutor, event: DeliveredEvent): Promise<void> {
	const archived = await tx.get<{ id: string }>(
		`SELECT s.id FROM thread_participants tp JOIN sessions s ON s.id = tp.participant_id
		  WHERE tp.thread_id = ? AND s.state = 'archived' LIMIT 1`,
		event.threadId,
	);
	if (archived) throw ApiError.stale(`session ${archived.id} is archived`, { session: archived.id });
}

/** Submit one wake and record it: the submission, the read mark (DLV-03), and the `running` state (DLV-01). */
export async function wakeDelivery(tx: SqliteExecutor, runtime: Runtime, wake: PendingWake): Promise<void> {
	const submissionId = await runtime.wake(wake);
	const now = runtime.clock.now();
	await tx.run("UPDATE deliveries SET wake_submission_id = ?, read_at = COALESCE(read_at, ?) WHERE id = ?", submissionId, now, wake.deliveryId);
	await setSessionState(tx, runtime, { sessionId: wake.recipientId, state: "running", from: ["idle", "failed"] });
}

/** The thread of the delivery a submission carried, if it was a pana message. */
export async function triggeringThread(db: SqliteExecutor, sessionId: string, submissionId: SubmissionId | number): Promise<string | undefined> {
	return (await triggeringDelivery(db, sessionId, submissionId))?.thread_id;
}

/** The delivery a submission carried: the run's trigger, for a failure a reader can open (OBJ-36). */
export async function triggeringDelivery(
	db: SqliteExecutor,
	sessionId: string,
	submissionId: SubmissionId | number,
): Promise<{ thread_id: string; message_id: string } | undefined> {
	return db.get<{ thread_id: string; message_id: string }>(
		"SELECT thread_id, message_id FROM deliveries WHERE recipient_id = ? AND wake_submission_id = ?",
		sessionId,
		submissionId,
	);
}

/** The objective this session leads, or undefined when it is not that objective's lead. */
async function leadObjective(db: SqliteExecutor, objectiveId: string, sessionId: string): Promise<string | undefined> {
	const row = await db.get<{ id: string }>("SELECT id FROM objectives WHERE id = ? AND lead_id = ?", objectiveId, sessionId);
	return row?.id;
}

/** Who hears about a session: its parent session, or the user who made a top-level one. */
export function creatorOf(runtime: Runtime, session: Pick<SessionRow, "parent">): string {
	return session.parent ?? runtime.config.user;
}

type ConversationLike = NonNullable<Awaited<ReturnType<Runtime["harness"]["conversation"]>>>;

/** Entries from the run's first input to its answer, oldest first. */
async function runEntries(conversation: ConversationLike, from: EntryId, to: EntryId | undefined): Promise<EntryRecord[]> {
	const out: EntryRecord[] = [];
	let cursor;
	do {
		const page = await conversation.entries(
			{ minEntryId: from, ...(to === undefined ? {} : { maxEntryId: to }), order: "ascending" },
			200,
			cursor,
			ctx,
		);
		out.push(...page.items);
		cursor = page.next;
	} while (cursor !== undefined);
	return out;
}

const USER_KINDS = new Set(["pi.user", MESSAGE_ENTRY_KIND, NOTE_ENTRY_KIND]);

/** The user and assistant text of entries, for SRC-03. */
export function transcriptText(entries: readonly EntryRecord[]): TranscriptEntry[] {
	const out: TranscriptEntry[] = [];
	for (const entry of entries) {
		const role = entry.kind === "pi.assistant" ? "assistant" : USER_KINDS.has(entry.kind) ? "user" : undefined;
		if (!role) continue;
		const text = (entry.model ?? []).map(messageText).join("\n").trim();
		if (text) out.push({ id: String(entry.id), role, text });
	}
	return out;
}

/** The text blocks of a model message. */
export function messageText(message: { content?: unknown }): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } => typeof block === "object" && block !== null && block.type === "text")
		.map((block) => block.text)
		.join("");
}

