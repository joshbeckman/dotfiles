// A minimal message append that wakes sessions, used to test DB-04. WP2 and WP3 own the real
// append and wake; this writes the same tables through the same `atomically` contract.

import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import type { PanaDatabase } from "../../src/db/atomic.ts";
import { wakeDeliveries, wakeRequestId, type PendingWake, type WakeSubmitter } from "../../src/db/outbox.ts";
import { FAUX_MODEL } from "./model.ts";

export interface Fixture {
	threadId: string;
	userId: string;
	sessions: Array<{ id: string; conversationId: number }>;
}

/** A user, `count` sessions with conversations, and a thread between all of them. */
export async function seedThread(
	db: PanaDatabase,
	harness: Harness,
	newId: () => string,
	now: number,
	options: { domain: string; user: string; count?: number },
): Promise<Fixture> {
	const sessions: Fixture["sessions"] = [];
	for (let i = 0; i < (options.count ?? 1); i++) {
		const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: FAUX_MODEL } }, ctx);
		sessions.push({ id: newId(), conversationId: conversation.id });
	}
	const threadId = newId();
	await db.write(async (tx) => {
		await tx.run(
			"INSERT OR IGNORE INTO participants (id, kind, url, created_at) VALUES (?, 'user', ?, ?)",
			options.user,
			`pana://${options.domain}/users/${options.user}`,
			now,
		);
		for (const session of sessions) {
			await tx.run(
				"INSERT INTO participants (id, kind, url, created_at) VALUES (?, 'session', ?, ?)",
				session.id,
				`pana://${options.domain}/sessions/${session.id}`,
				now,
			);
			await tx.run(
				"INSERT INTO sessions (id, conversation_id, state, depth, created_at, updated_at) VALUES (?, ?, 'idle', 0, ?, ?)",
				session.id,
				session.conversationId,
				now,
				now,
			);
		}
		await tx.run("INSERT INTO threads (id, subject, created_by, created_at) VALUES (?, 'test', ?, ?)", threadId, options.user, now);
		for (const id of [options.user, ...sessions.map((s) => s.id)]) {
			await tx.run("INSERT INTO thread_participants (thread_id, participant_id, joined_at) VALUES (?, ?, ?)", threadId, id, now);
		}
	});
	return { threadId, userId: options.user, sessions };
}

export interface Appended {
	messageId: string;
	wakes: PendingWake[];
}

/** Append a message from the user and wake every session in the thread, in one `atomically`. */
export async function appendAndWake(
	db: PanaDatabase,
	fixture: Fixture,
	newId: () => string,
	now: number,
	body: string,
	submit: WakeSubmitter,
	onPlanned?: (appended: Appended) => void,
): Promise<Appended> {
	const messageId = newId();
	const wakes: PendingWake[] = fixture.sessions.map((session) => {
		const deliveryId = newId();
		return { deliveryId, messageId, threadId: fixture.threadId, recipientId: session.id, requestId: wakeRequestId(deliveryId) };
	});
	const appended = { messageId, wakes };
	onPlanned?.(appended);
	await db.atomically(async (tx) => {
		await tx.run(
			"INSERT INTO messages (id, thread_id, seq, sender_id, body, created_at) VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE thread_id = ?), ?, ?, ?)",
			messageId,
			fixture.threadId,
			fixture.threadId,
			fixture.userId,
			body,
			now,
		);
		for (const wake of wakes) {
			await tx.run(
				"INSERT INTO deliveries (id, message_id, thread_id, recipient_id, created_at, wake_request_id) VALUES (?, ?, ?, ?, ?, ?)",
				wake.deliveryId,
				messageId,
				fixture.threadId,
				wake.recipientId,
				now,
				wake.requestId,
			);
		}
		await wakeDeliveries(tx, wakes, submit);
	});
	return appended;
}
