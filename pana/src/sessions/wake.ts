// Submits a session wake for a delivery (DB-04 contract, DLV-01 owner: WP3).
//
// TODO(WP3): render the full `pana.message` input (DLV-02): sender, thread, and message URLs,
// subject, body, and attachment paths; pick steer or follow-up by sender (DLV-04, DLV-05).
// Keep `requestId: wake.requestId` so a retried wake never submits twice.

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { PendingWake, WakeSubmitter } from "../db/outbox.ts";
import type { Runtime } from "../server/runtime.ts";

export function defaultWakeSubmitter(runtime: () => Runtime): WakeSubmitter {
	return async (wake: PendingWake) => {
		const { db, harness, url } = runtime();
		const row = await db.get<{ conversation_id: number | null }>(
			"SELECT conversation_id FROM sessions WHERE id = ?",
			wake.recipientId,
		);
		if (row?.conversation_id == null) throw new Error(`session ${wake.recipientId} has no conversation`);
		const conversation = await harness.conversation(row.conversation_id as ConversationId, BACKGROUND_CONTEXT);
		if (!conversation) throw new Error(`conversation ${row.conversation_id} not found`);
		const message = url({ kind: "message", id: wake.messageId, thread: wake.threadId });
		const submission = await conversation.submit(
			{ type: "input", content: `New message: ${message}`, requestId: wake.requestId },
			BACKGROUND_CONTEXT,
		);
		return submission.id;
	};
}
