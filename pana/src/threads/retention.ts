// Delivery retention (DB-05): drop the deliveries nobody will be handed again.
//
// The predicate is the whole design, and each clause is there because of a statement that would
// otherwise read the row (BENCH.md, "Retention"):
//
// - `read_at IS NOT NULL` — the unread counter and the inbox badge count only unread rows, so this
//   clause is what keeps them exact without a recount.
// - `wake_submission_id IS NULL` — a delivery that ever carried a wake is the row `reply.ts` looks
//   up to post a session's answer, and one of four lookups (`reply.ts`, the stop requeue,
//   `#reconcile`, `triggeringDelivery`). Dropping a woken row would break the reply path by
//   construction; this clause makes that unreachable rather than unlikely.
// - archived by that recipient — the live inbox lists read history too, and only the archived
//   view is allowed to forget it.
// - a user recipient — an inbox is a user's. A session can archive its own view of a thread
//   (`archiveThread` resolves the caller the same way an inbox read does), and its deliveries are
//   the ones `reply.ts`'s newer-delivery walk reads, so a session's mail is not this sweep's to
//   drop even when it was read without a wake (a retired objective's `settleUnread`). The wake
//   clause is the second line of defence, not the only one.
// - older than the window — the reader has had the thread's contents for a month.
//
// The sweep runs when panad starts and once a day after (server/index.ts), in bounded batches with
// a per-run cap, so it never holds a boot or a run. It never runs `VACUUM`: the space a deleted row
// leaves inside its page is reused by the next delivery, so the table plateaus instead of growing,
// and shrinking the file is a separate, explicit maintenance decision.

import type { SqliteExecutor } from "@earendil-works/chord/sqlite";
import type { Runtime } from "../server/runtime.ts";
import { lastChanges } from "./unread.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Rows per transaction: a batch of 50 held the write line 1.4–2.0 ms (BENCH.md). */
export const RETENTION_BATCH_SIZE = 200;
/** Batches per run, so a boot spends at most 4,000 rows catching up. The next run continues. */
export const RETENTION_MAX_BATCHES = 20;
/** How often the standing sweep runs once panad is up: the same 24 hours as the scratch sweep. */
const RETENTION_EVERY_MS = DAY_MS;

export interface RetentionOptions {
	/** Rows per transaction. */
	batchSize?: number;
	/** Batches this run may spend; the rest waits for the next sweep. */
	maxBatches?: number;
	/** The window in days, overriding `retention.readDeliveryDays`. `0` deletes nothing. */
	days?: number;
}

export interface RetentionResult {
	/** The window this run used; `0` means retention is off. */
	days: number;
	/** Deliveries read at or before this instant were eligible. */
	cutoff: number | null;
	deleted: number;
	batches: number;
	/** True when the per-run cap stopped a sweep that had more to do. */
	more: boolean;
}

/**
 * Delete one batch of eligible deliveries and report how many went. The `LIMIT` is what keeps the
 * write line short; no `ORDER BY`, because every row the predicate admits stays admitted, so any
 * order makes progress and a sort per batch would cost more than it saves.
 */
async function deleteBatch(tx: SqliteExecutor, cutoff: number, limit: number): Promise<number> {
	await tx.run(
		`DELETE FROM deliveries
     WHERE id IN (SELECT x.id FROM deliveries AS x
                   WHERE x.read_at IS NOT NULL
                     AND x.read_at <= ?
                     AND x.wake_submission_id IS NULL
                     AND EXISTS (SELECT 1 FROM thread_archives a
                                  WHERE a.thread_id = x.thread_id AND a.participant_id = x.recipient_id)
                     AND EXISTS (SELECT 1 FROM participants p
                                  WHERE p.id = x.recipient_id AND p.kind = 'user')
                   LIMIT ?)`,
		cutoff,
		limit,
	);
	return lastChanges(tx);
}

/**
 * One retention run: delete eligible deliveries in batches until there are none, the per-run cap
 * stops it, or retention is off. Idempotent — a second run over the same database deletes nothing.
 */
export async function sweepRetention(runtime: Runtime, options: RetentionOptions = {}): Promise<RetentionResult> {
	const days = options.days ?? runtime.config.retention.readDeliveryDays;
	const batchSize = Math.max(1, Math.trunc(options.batchSize ?? RETENTION_BATCH_SIZE));
	const maxBatches = Math.max(1, Math.trunc(options.maxBatches ?? RETENTION_MAX_BATCHES));
	if (!(days > 0)) return { days: 0, cutoff: null, deleted: 0, batches: 0, more: false };
	const cutoff = runtime.clock.now() - days * DAY_MS;
	let deleted = 0;
	let batches = 0;
	while (batches < maxBatches) {
		const count = await runtime.db.atomically((tx) => deleteBatch(tx, cutoff, batchSize));
		batches += 1;
		deleted += count;
		// A short batch is the last one: nothing eligible is left.
		if (count < batchSize) return { days, cutoff, deleted, batches, more: false };
	}
	return { days, cutoff, deleted, batches, more: true };
}

export interface RetentionSweeper {
	/** The run in flight, for a test or a shutdown that wants to wait for it. */
	current(): Promise<RetentionResult> | undefined;
	close(): Promise<void>;
}

/**
 * The standing sweep: run once now, then every 24 hours on `runtime.clock` (SCR-05's shape). The
 * next run is armed before this one starts, so a slow sweep cannot delay it, and a sweep still
 * running when the timer fires is not doubled. Not `background`: pi-durable reserves background
 * timers for freeing memory and the test clock declines them. `close()` cancels the timer and
 * waits for the run in flight, so a cap that stopped mid-way leaves a whole-batch database behind.
 *
 * With `retention.readDeliveryDays` at 0 the sweeper is inert: no timer, no query.
 */
export function startRetentionSweeper(runtime: Runtime, report: (error: unknown, what: string) => void): RetentionSweeper {
	if (!(runtime.config.retention.readDeliveryDays > 0)) {
		return { current: () => undefined, close: async () => {} };
	}
	let closed = false;
	let cancel: (() => void) | undefined;
	let inFlight: Promise<RetentionResult> | undefined;

	const kick = () => {
		if (closed) return;
		cancel = runtime.clock.setTimer(kick, RETENTION_EVERY_MS, { background: false });
		if (inFlight) return;
		const sweep = sweepRetention(runtime);
		inFlight = sweep;
		sweep
			.catch((error) => report(error, "delivery retention sweep"))
			.finally(() => {
				if (inFlight === sweep) inFlight = undefined;
			});
	};

	kick();
	return {
		current: () => inFlight,
		async close() {
			closed = true;
			cancel?.();
			await inFlight?.catch(() => undefined);
		},
	};
}
