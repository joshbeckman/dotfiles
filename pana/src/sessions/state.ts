// The one place a session's stored state changes (UX-09, STA-01..05).
//
// Every write goes through `setSessionState`: a wake inside a message append, run settlement,
// restart recovery, stop, resume, archive, and a create that failed. It updates the row and, only
// after the transaction commits, publishes `session.state` on `/events`. Publishing inside the
// transaction would tell a window about a state that a rollback can still take away, so a failed
// append would leave a session shown as working forever.
//
// The event carries the session's URL and the threads it takes part in. A window then colors the
// indicator without another request and marks the thread's rows in the inbox and thread list.

import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { SqliteExecutor } from "@earendil-works/chord/sqlite";
import type { HarnessInspection } from "@earendil-works/pi-durable";
import type { Runtime } from "../server/runtime.ts";
import { publish, type WebEvent } from "../web/index.ts";
import type { SessionState } from "./runtime.ts";

export type { SessionState } from "./runtime.ts";

export interface SessionStateEvent extends WebEvent {
	kind: "session.state";
	sessionId: string;
	state: SessionState;
	/** The session's URL, so a window can color the indicator without another request. */
	url: string;
	/** The threads the session takes part in (UX-09). */
	threadIds: string[];
}

export interface SessionStateWrite {
	sessionId: string;
	state: SessionState;
	/** Apply only when the stored state is one of these, like `WHERE state IN (...)`. */
	from?: readonly SessionState[];
}

/** A session that is working in a thread, for that thread's row mark (UX-09). */
export interface WorkingSession {
	sessionId: string;
	url: string;
	state: SessionState;
}

/**
 * Set a session's stored state, and publish one `session.state` after the write's transaction
 * commits. Returns whether the write applied: a missing session, or a stored state outside
 * `from`, leaves the row alone. A write that stores the state it already held touches
 * `updated_at` and publishes nothing, because nothing changed for a window to show.
 */
export async function setSessionState(tx: SqliteExecutor, runtime: Runtime, write: SessionStateWrite): Promise<boolean> {
	const row = await tx.get<{ state: SessionState }>("SELECT state FROM sessions WHERE id = ?", write.sessionId);
	if (!row) return false;
	if (write.from !== undefined && !write.from.includes(row.state)) return false;
	await tx.run("UPDATE sessions SET state = ?, updated_at = ? WHERE id = ?", write.state, runtime.clock.now(), write.sessionId);
	if (row.state === write.state) return true;
	const threadIds = await tx.all<{ thread_id: string }>(
		"SELECT thread_id FROM thread_participants WHERE participant_id = ? ORDER BY thread_id",
		write.sessionId,
	);
	const event: SessionStateEvent = {
		kind: "session.state",
		sessionId: write.sessionId,
		state: write.state,
		url: runtime.url({ kind: "session", id: write.sessionId }),
		threadIds: threadIds.map((thread) => thread.thread_id),
	};
	runtime.db.afterCommit(() => {
		publish(runtime, event, report).catch(report);
	});
	return true;
}

function report(error: unknown): void {
	console.error("panad: session state event failed:", error instanceof Error ? error.message : error);
}

/**
 * UX-09: the working session participants of each thread, for the inbox and thread-list marks.
 * A stored `running` session also covers `waiting`, the state a run reports while its work sleeps
 * (STA-03), so the mark needs no harness inspection.
 */
export async function workingSessions(tx: SqliteExecutor, threadIds: readonly string[]): Promise<Map<string, WorkingSession[]>> {
	const out = new Map<string, WorkingSession[]>();
	if (threadIds.length === 0) return out;
	const rows = await tx.all<{ thread_id: string; id: string; url: string; state: SessionState }>(
		`SELECT tp.thread_id AS thread_id, p.id AS id, p.url AS url, s.state AS state
		   FROM thread_participants tp
		   JOIN participants p ON p.id = tp.participant_id
		   JOIN sessions s ON s.id = tp.participant_id
		  WHERE tp.thread_id IN (${threadIds.map(() => "?").join(",")}) AND s.state = 'running'
		  ORDER BY tp.thread_id, tp.joined_at, p.id`,
		...threadIds,
	);
	for (const row of rows) {
		const list = out.get(row.thread_id) ?? [];
		list.push({ sessionId: row.id, url: row.url, state: row.state });
		out.set(row.thread_id, list);
	}
	return out;
}

/** Conversations whose work is asleep or waiting on a child task (STA-03). */
export function waitingConversations(inspection: HarnessInspection): Set<number> {
	const out = new Set<number>();
	for (const task of inspection.tasks) {
		const sleeping = task.state.kind === "sleeping";
		const onChild = task.record.kind === "pi.tool" && task.state.kind === "waiting";
		if (sleeping || onChild) out.add(task.record.conversationId);
	}
	return out;
}

/**
 * UX-09: the current state of these sessions, with a `running` session reported as `waiting`
 * while its work sleeps, the same state `session show` reports (STA-03).
 */
export async function sessionStates(db: SqliteExecutor, runtime: Runtime, sessionIds: readonly string[]): Promise<Map<string, SessionState>> {
	const out = new Map<string, SessionState>();
	if (sessionIds.length === 0) return out;
	const waiting = waitingConversations(await runtime.harness.inspect(ctx));
	const rows = await db.all<{ id: string; state: SessionState; conversation_id: number | null }>(
		`SELECT id, state, conversation_id FROM sessions WHERE id IN (${sessionIds.map(() => "?").join(",")})`,
		...sessionIds,
	);
	for (const row of rows) {
		const asleep = row.conversation_id !== null && waiting.has(row.conversation_id);
		out.set(row.id, row.state === "running" && asleep ? "waiting" : row.state);
	}
	return out;
}
