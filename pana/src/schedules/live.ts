// The bridge from a wake schedule to an open window (UX-09).
//
// A thread's footer names the sessions working in it, and the ones with a wake pending: a session
// asleep on a scheduled wake is otherwise indistinguishable from one that is merely idle, and the
// thread it takes part in will get work at a time the window cannot show. So each wake write —
// create, edit, delete, and the claim that moves a cron to its next occurrence — publishes
// `session.wake` with that session's new earliest wake, or null when it has none left.
//
// The query lives here rather than in the store, which imports this module: keeping the read next
// to its event leaves one direction of dependency, and the payload `session` is the only field a
// wake row carries to find its target.

import type { Runtime } from "../server/runtime.ts";
import { publish, type WebEvent } from "../web/index.ts";

/** A session's next pending wake, as a window shows it (UX-09). */
export interface NextWake {
	/** When the wake fires, epoch milliseconds. */
	at: number;
	/** The schedule's URL, so the chip can link to it. */
	url: string;
	subject: string;
	/** A recurring wake's cron expression; null for a one-off. */
	cron: string | null;
}

export interface SessionWakeEvent extends WebEvent {
	kind: "session.wake";
	sessionId: string;
	/** The session's earliest pending wake, or null when it has none. */
	wake: NextWake | null;
}

/** The earliest pending wake of each session, in one query. Sessions without one are absent. */
export async function nextWakes(runtime: Runtime, sessionIds: readonly string[]): Promise<Map<string, NextWake>> {
	const out = new Map<string, NextWake>();
	if (sessionIds.length === 0) return out;
	const rows = await runtime.db.all<{ id: string; session_id: string; subject: string | null; cron: string | null; next_at: number }>(
		`SELECT s.id AS id, json_extract(s.payload, '$.session') AS session_id, s.subject AS subject, s.cron AS cron, s.next_at AS next_at
		   FROM schedules s
		  WHERE s.kind = 'wake' AND s.state = 'active' AND s.next_at IS NOT NULL
		    AND json_extract(s.payload, '$.session') IN (${sessionIds.map(() => "?").join(",")})
		  ORDER BY s.next_at, s.id`,
		...sessionIds,
	);
	// The order puts each session's earliest first, so the first row kept per session is its next.
	for (const row of rows) {
		if (out.has(row.session_id)) continue;
		out.set(row.session_id, {
			at: row.next_at,
			url: runtime.url({ kind: "schedule", id: row.id }),
			subject: row.subject ?? "",
			cron: row.cron,
		});
	}
	return out;
}

/**
 * Publish each named session's current next wake after a write that changed it. A write already
 * committed by the time this is called, so the event cannot announce a time a rollback took away.
 * Errors are reported and swallowed: a window that misses an update still sees the truth when it
 * reopens the thread.
 */
export async function announceWakes(runtime: Runtime, sessionIds: readonly string[]): Promise<void> {
	const ids = [...new Set(sessionIds.filter((id) => typeof id === "string" && id !== ""))];
	if (ids.length === 0) return;
	let wakes: Map<string, NextWake>;
	try {
		wakes = await nextWakes(runtime, ids);
	} catch (error) {
		report(error);
		return;
	}
	for (const sessionId of ids) {
		const event: SessionWakeEvent = { kind: "session.wake", sessionId, wake: wakes.get(sessionId) ?? null };
		await publish(runtime, event, report);
	}
}

/** The session a wake schedule wakes, read from its stored payload. */
export function wakeSessionOf(payload: unknown): string | undefined {
	let parsed: unknown = payload;
	if (typeof payload === "string") {
		try {
			parsed = JSON.parse(payload);
		} catch {
			return undefined;
		}
	}
	const session = (parsed as { session?: unknown } | null)?.session;
	return typeof session === "string" && session !== "" ? session : undefined;
}

function report(error: unknown): void {
	console.error("panad: session wake event failed:", error instanceof Error ? error.message : error);
}
