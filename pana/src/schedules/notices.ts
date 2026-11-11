// SCH-22: the one voice a schedule uses to tell its creator that something is wrong with it.
//
// A check that fails on every recurrence is a permanent condition, not a heartbeat: before this,
// each firing opened a fresh thread and posted it to the user, so a five-minute poll could fill an
// inbox with one hundred identical threads while the session that could repair the schedule never
// heard. Two rules replace that. The schedule speaks in one thread, and it speaks only when the
// news changes, so a repeated failure is silence and a new error is a message.
//
// The reader is the creator, because SCH-21 gives only the creator and the user the right to
// change a schedule. A session creator is delivered to through `postScheduleStatus`, which wakes
// it; a user creator gets the same mail without a wake, since a user is never woken by mail.

import type { Runtime } from "../server/runtime.ts";
import { postScheduleStatus } from "../threads/index.ts";
import { creatorAddress, recordScheduleNotice, scheduleNotice, type ScheduleRow } from "./store.ts";

/**
 * Post `body` to the schedule's creator unless it is exactly what the thread already says.
 * Returns true when a message was posted.
 */
export async function notifySchedule(runtime: Runtime, row: ScheduleRow, body: string): Promise<boolean> {
	const stored = await scheduleNotice(runtime, row.id);
	if (stored?.reason === body) return false;
	const result = await postScheduleStatus(runtime, {
		to: await creatorAddress(runtime, row.creator_id),
		thread: stored?.thread_id,
		// The subject is fixed when the thread opens; later posts keep it.
		subject: `Scheduled ${row.kind} ${runtime.url({ kind: "schedule", id: row.id })}`,
		body,
	});
	await recordScheduleNotice(runtime, row.id, result.thread.id, body);
	return true;
}
