// Session wakes recorded on deliveries (DB-04).
//
// A delivery that must wake a session carries `wake_request_id`, a deterministic pi-durable
// `requestId`. `wakeDeliveries` submits each wake and records the submission ID in the same
// transaction. In the normal path that whole transaction is `PanaDatabase.atomically`, so the
// message, its deliveries, and the submissions commit together.
//
// `sweepWakes` retries wakes that have a request ID but no submission ID. It runs at startup and
// covers the one case `atomically` cannot roll back: an error after a pi-durable commit joined.
// pi-durable returns the existing submission for a repeated `requestId`, so a retry never
// submits twice.

import type { SqliteExecutor } from "@earendil-works/chord/sqlite";
import type { PanaDatabase } from "./atomic.ts";

export interface PendingWake {
	deliveryId: string;
	messageId: string;
	threadId: string;
	recipientId: string;
	requestId: string;
}

/**
 * Submits one wake to pi-durable and returns the submission ID (a pi-durable `SubmissionId`,
 * which is a number). Must pass `requestId` through.
 */
export type WakeSubmitter = (wake: PendingWake) => Promise<number>;

/** The pi-durable request ID for a delivery's wake. Stable, so retries deduplicate. */
export function wakeRequestId(deliveryId: string): string {
	return `pana.delivery:${deliveryId}`;
}

/** Submit each wake and record its submission ID, using `tx` for the bookkeeping. */
export async function wakeDeliveries(tx: SqliteExecutor, wakes: readonly PendingWake[], submit: WakeSubmitter): Promise<void> {
	for (const wake of wakes) {
		const submissionId = await submit(wake);
		await tx.run("UPDATE deliveries SET wake_submission_id = ? WHERE id = ?", submissionId, wake.deliveryId);
	}
}

/** Deliveries with a wake request that has no recorded submission. */
export async function pendingWakes(db: SqliteExecutor): Promise<PendingWake[]> {
	return db.all<PendingWake>(
		`SELECT id AS deliveryId, message_id AS messageId, thread_id AS threadId,
		        recipient_id AS recipientId, wake_request_id AS requestId
		   FROM deliveries
		  WHERE wake_request_id IS NOT NULL AND wake_submission_id IS NULL
		  ORDER BY created_at, id`,
	);
}

/**
 * Retry every pending wake. A wake that fails stays pending for the next sweep and goes to
 * `onError`; the others still run. Returns how many it submitted.
 */
export async function sweepWakes(
	db: PanaDatabase,
	submit: WakeSubmitter,
	onError: (error: unknown, wake: PendingWake) => void = () => {},
): Promise<number> {
	let submitted = 0;
	for (const wake of await pendingWakes(db)) {
		try {
			await db.atomically((tx) => wakeDeliveries(tx, [wake], submit));
			submitted++;
		} catch (error) {
			onError(error, wake);
		}
	}
	return submitted;
}
