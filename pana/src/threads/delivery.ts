// The delivery hook seam between the WP2 store and the WP3 session runtime.
//
// The store calls `onDelivered` inside the append transaction, once per delivery row, after the
// row exists and before COMMIT. A hook that writes through `tx` therefore commits with the
// message, or rolls back with it. The default hook submits the pi-durable wake through
// `runtime.wake` and records the submission on the same delivery (DB-04).
//
// WP3 replaces the hook by assigning `runtime.delivery` before panad serves requests. The event
// carries every delivery, users included, with `requestId === null` for recipients that cannot
// wake, so a replacement never has to guess.

import type { SqliteExecutor } from "@earendil-works/chord/sqlite";
import type { Runtime } from "../server/runtime.ts";

export interface DeliveredEvent {
	deliveryId: string;
	messageId: string;
	threadId: string;
	recipientId: string;
	recipientKind: "user" | "session" | "domain";
	senderKind: "user" | "session" | "domain";
	/** `wakeRequestId(deliveryId)` when the recipient is a session that may wake, else null. */
	requestId: string | null;
	/** The recipient session's state, or undefined when the recipient is not a session. */
	sessionState?: string;
}

export interface DeliveryHooks {
	onDelivered(tx: SqliteExecutor, event: DeliveredEvent, runtime: Runtime): Promise<void>;
}

export const defaultDeliveryHooks: DeliveryHooks = {
	async onDelivered(tx, event, runtime) {
		if (event.requestId === null) return;
		const submissionId = await runtime.wake({
			deliveryId: event.deliveryId,
			messageId: event.messageId,
			threadId: event.threadId,
			recipientId: event.recipientId,
			requestId: event.requestId,
		});
		await tx.run("UPDATE deliveries SET wake_submission_id = ? WHERE id = ?", submissionId, event.deliveryId);
	},
};

/** A Runtime with WP3's delivery hook attached. */
export type RuntimeWithDelivery = Runtime & { delivery?: DeliveryHooks };

export function deliveryHooks(runtime: Runtime): DeliveryHooks {
	return (runtime as RuntimeWithDelivery).delivery ?? defaultDeliveryHooks;
}

/** Attach a replacement hook, for WP3 to call before panad serves requests. */
export function configureDelivery(runtime: Runtime, hooks: DeliveryHooks): void {
	(runtime as RuntimeWithDelivery).delivery = hooks;
}
