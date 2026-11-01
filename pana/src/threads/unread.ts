// The unread counter (REF-06). `unreadTotal` used to be a COUNT over the reader's unread
// deliveries, which read every one of them: 3.2 ms at 13,859 unread, the largest pana-owned
// statement in a bench run. The counter here is a cache of that COUNT, and this module is its one
// holder: every write that can change an unread delivery goes through one of these helpers, and
// nothing else writes `unread_counts`.
//
// Two counts per participant, because the inbox reads both: deliveries in threads the participant
// has not archived, and deliveries in threads they have. A delivery moves between them when the
// thread is archived or unarchived, and a new delivery always lands in the unarchived bucket by
// the end of the append that creates it, since REF-04 unarchives the thread for its recipient.
//
// The helper shapes follow what each write knows: a single delivery arrives or is read (a delta),
// a thread changes bucket (its own unread rows, counted), and the rare multi-row writes (a stop
// that returns queued mail to unread, an archive that settles it) recompute the one participant
// they touch. `test/unread-counter.test.ts` holds the invariant against the SQL after every step
// of a randomized sequence, including after a reopen.

import type { SqliteExecutor } from "@earendil-works/chord/sqlite";

export interface UnreadCounts {
	/** Unread deliveries in threads this participant has not archived. */
	unarchived: number;
	/** Unread deliveries in threads this participant has archived. */
	archived: number;
}

/** The same COUNT the inbox used to run, over one participant, split by the archived bucket. */
const COUNT_SQL = `
	SELECT
	  (SELECT COUNT(*) FROM deliveries d
	    WHERE d.recipient_id = ? AND d.read_at IS NULL
	      AND NOT EXISTS (SELECT 1 FROM thread_archives a WHERE a.thread_id = d.thread_id AND a.participant_id = d.recipient_id)) AS unarchived,
	  (SELECT COUNT(*) FROM deliveries d
	    WHERE d.recipient_id = ? AND d.read_at IS NULL
	      AND EXISTS (SELECT 1 FROM thread_archives a WHERE a.thread_id = d.thread_id AND a.participant_id = d.recipient_id)) AS archived`;

/** REF-06's number, as one row read: the reader's unread deliveries, archived or not. */
export async function unreadTotal(tx: SqliteExecutor, participantId: string, archived: boolean): Promise<number> {
	const row = await tx.get<UnreadCounts>("SELECT unarchived, archived FROM unread_counts WHERE participant_id = ?", participantId);
	// No row means nothing unread: migration 14 backfills every participant that has any, and
	// `noteUnread` creates the row on the first delivery.
	if (row === undefined) return 0;
	return archived ? row.archived : row.unarchived;
}

/** The whole counter, for a caller comparing it with `COUNT(*)` (and for the migration's tests). */
export async function unreadCounts(tx: SqliteExecutor, participantId: string): Promise<UnreadCounts> {
	return (await tx.get<UnreadCounts>("SELECT unarchived, archived FROM unread_counts WHERE participant_id = ?", participantId)) ?? { unarchived: 0, archived: 0 };
}

/** Create the row if this participant has none: the first delivery, or the first recount. */
async function ensureRow(tx: SqliteExecutor, participantId: string): Promise<void> {
	await tx.run("INSERT INTO unread_counts (participant_id, unarchived, archived) VALUES (?, 0, 0) ON CONFLICT(participant_id) DO NOTHING", participantId);
}

/**
 * `delta` deliveries arrived unread in this thread (a new one, or mail a stop returned), into the
 * bucket the thread is in now. One statement: the bucket comes from `thread_archives` by primary
 * key, and the row is created on first use.
 */
export async function noteUnread(tx: SqliteExecutor, participantId: string, threadId: string, delta = 1): Promise<void> {
	if (delta === 0) return;
	await tx.run(
		`INSERT INTO unread_counts (participant_id, unarchived, archived)
		 VALUES (?,
		         CASE WHEN EXISTS (SELECT 1 FROM thread_archives WHERE participant_id = ? AND thread_id = ?) THEN 0 ELSE ? END,
		         CASE WHEN EXISTS (SELECT 1 FROM thread_archives WHERE participant_id = ? AND thread_id = ?) THEN ? ELSE 0 END)
		 ON CONFLICT(participant_id) DO UPDATE SET
		   unarchived = unread_counts.unarchived + excluded.unarchived,
		   archived   = unread_counts.archived + excluded.archived`,
		participantId,
		participantId,
		threadId,
		delta,
		participantId,
		threadId,
		delta,
	);
}

/** `count` deliveries of this thread went from unread to read, in the bucket the thread is in. */
export async function noteRead(tx: SqliteExecutor, participantId: string, threadId: string, count: number): Promise<void> {
	await noteUnread(tx, participantId, threadId, -count);
}

/** The thread changed bucket: move its unread deliveries with it. Archives are rare and per-thread. */
export async function moveUnread(tx: SqliteExecutor, participantId: string, threadId: string, toArchived: boolean): Promise<void> {
	const found = await tx.get<{ n: number }>("SELECT COUNT(*) AS n FROM deliveries WHERE recipient_id = ? AND thread_id = ? AND read_at IS NULL", participantId, threadId);
	const count = found?.n ?? 0;
	if (count === 0) return;
	await ensureRow(tx, participantId);
	const [from, to] = toArchived ? ["unarchived", "archived"] : ["archived", "unarchived"];
	await tx.run(`UPDATE unread_counts SET ${from} = ${from} - ?, ${to} = ${to} + ? WHERE participant_id = ?`, count, count, participantId);
}

/**
 * Recompute this participant's counter from the deliveries themselves. For the rare writes that
 * touch an open-ended set of rows (a stop returning queued mail to unread), where a per-row delta
 * would cost more than the truth is worth.
 */
export async function recountUnread(tx: SqliteExecutor, participantId: string): Promise<UnreadCounts> {
	const row = (await tx.get<UnreadCounts>(COUNT_SQL, participantId, participantId))!;
	await tx.run(
		`INSERT INTO unread_counts (participant_id, unarchived, archived) VALUES (?, ?, ?)
		 ON CONFLICT(participant_id) DO UPDATE SET unarchived = excluded.unarchived, archived = excluded.archived`,
		participantId,
		row.unarchived,
		row.archived,
	);
	return row;
}

/** How many rows the statement just run changed, for the callers whose WHERE already says `read_at IS NULL`. */
export async function lastChanges(tx: SqliteExecutor): Promise<number> {
	return (await tx.get<{ n: number }>("SELECT changes() AS n"))!.n;
}

/** Every unread delivery of this participant became read: both buckets are zero. */
export async function clearUnread(tx: SqliteExecutor, participantId: string): Promise<void> {
	await tx.run("UPDATE unread_counts SET unarchived = 0, archived = 0 WHERE participant_id = ?", participantId);
}
