// Submits a session wake for a delivery (DB-04 contract; DLV-01, DLV-02, DLV-04, DLV-05).
//
// The input is a `pana.message` entry. Its text carries everything the model needs to answer
// without a tool call: the sender, thread, and message URLs, the subject, the body, and the local
// path of every attached file. A user's message steers a busy session; any other sender's
// message waits as a follow-up. `requestId: wake.requestId` makes a retried wake a no-op.

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { SqliteExecutor } from "@earendil-works/chord/sqlite";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { PendingWake, WakeSubmitter } from "../db/outbox.ts";
import { leadRunInput } from "../objectives/brief.ts";
import { firstLineSubject } from "../search/subjects.ts";
import type { Runtime } from "../server/runtime.ts";
import { attachmentPaths, deliveryText, threadRoster } from "../threads/render.ts";
import { setSessionState } from "./state.ts";

export const MESSAGE_ENTRY_KIND = "pana.message";
export const NOTE_ENTRY_KIND = "pana.note";
export const WAKE_ENTRY_KIND = "pana.wake";

/** What a `pana.message` entry stores, so readers find the message without parsing text. */
export interface MessageEntryData {
	deliveryId: string;
	messageId: string;
	threadId: string;
	seq: number;
	sender: string;
	[key: string]: string | number;
}

export interface RenderedMessage {
	content: string;
	data: MessageEntryData;
	senderKind: "user" | "session" | "domain";
}

interface MessageRow {
	id: string;
	thread_id: string;
	seq: number;
	body: string;
	sender_url: string;
	sender_kind: "user" | "session" | "domain";
	subject: string | null;
}

/** The current body of a message: its newest revision, or nothing once redacted. */
async function currentBody(db: SqliteExecutor, row: MessageRow): Promise<string | undefined> {
	const event = await db.get<{ kind: string; body: string | null }>(
		"SELECT kind, body FROM message_events WHERE message_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
		row.id,
	);
	if (event?.kind === "message.redacted") return undefined;
	if (event?.kind === "message.revised") return event.body ?? "";
	return row.body;
}

/** Render one delivered message as model input (DLV-02). */
export async function renderMessage(
	db: SqliteExecutor,
	runtime: Runtime,
	wake: Pick<PendingWake, "deliveryId" | "messageId" | "recipientId">,
): Promise<RenderedMessage> {
	const row = await db.get<MessageRow>(
		`SELECT m.id, m.thread_id, m.seq, m.body, p.url AS sender_url, p.kind AS sender_kind, t.subject
		   FROM messages m
		   JOIN participants p ON p.id = m.sender_id
		   JOIN threads t ON t.id = m.thread_id
		  WHERE m.id = ?`,
		wake.messageId,
	);
	if (!row) throw new Error(`message ${wake.messageId} is missing`);
	const body = await currentBody(db, row);
	const paths = body === undefined ? [] : await attachmentPaths(db, runtime, body);
	return {
		content: deliveryText({
			senderUrl: row.sender_url,
			threadUrl: runtime.url({ kind: "thread", id: row.thread_id }),
			// CLI-09: the roster rides along on the thread's first message and on a message that adds
			// a participant, with each declared role beside its URL.
			participants: await threadRoster(db, row, wake.recipientId),
			messageUrl: runtime.url({ kind: "message", id: row.id, thread: row.thread_id }),
			// A thread's first message is delivered before WP2 records its subject (SUB-01), which is that message's first line.
			subject: row.subject ?? (row.seq === 1 ? firstLineSubject(row.body) : ""),
			body: body ?? "[redacted]",
			attachments: paths,
		}),
		senderKind: row.sender_kind,
		data: {
			deliveryId: wake.deliveryId,
			messageId: row.id,
			threadId: row.thread_id,
			seq: row.seq,
			sender: row.sender_url,
		},
	};
}

/** The pi-durable conversation of a session. */
export async function sessionConversation(runtime: Runtime, sessionId: string) {
	const row = await runtime.db.get<{ conversation_id: number | null }>("SELECT conversation_id FROM sessions WHERE id = ?", sessionId);
	if (row?.conversation_id == null) throw new Error(`session ${sessionId} has no conversation`);
	const conversation = await runtime.harness.conversation(row.conversation_id as ConversationId, BACKGROUND_CONTEXT);
	if (!conversation) throw new Error(`conversation ${row.conversation_id} not found`);
	return conversation;
}

export function defaultWakeSubmitter(getRuntime: () => Runtime): WakeSubmitter {
	return async (wake: PendingWake) => {
		const runtime = getRuntime();
		const conversation = await sessionConversation(runtime, wake.recipientId);
		const rendered = await renderMessage(runtime.db, runtime, wake);
		// OBJ-32: a lead's run starts with the briefing, then the message that woke it — except when
		// the message is itself a briefing (launch's first input, a regenerate's handoff).
		const content = await leadRunInput(runtime, wake.recipientId, rendered.content, wake.messageId);
		const submission = await conversation.submit(
			{
				type: "input",
				content,
				whenBusy: rendered.senderKind === "user" ? "steer" : "followUp",
				entry: { kind: MESSAGE_ENTRY_KIND, data: rendered.data },
				requestId: wake.requestId,
			},
			BACKGROUND_CONTEXT,
		);
		return submission.id;
	};
}

export interface ScheduledWake {
	/** Cron occurrence time makes repeated wakes distinct without changing the schedule URL. */
	occurrence?: number;
	scheduleId: string;
	sessionId: string;
	note: string;
}

/**
 * WAK-02: hand a scheduled wake's note to its session as input, like a delivered message. A
 * stopped or archived session stays as it is: the user stopped it, and a wake must not restart
 * it. Returns whether the session was woken.
 *
 * Nothing is posted for the session when the run ends (RPL-01 finds no delivery behind it), so
 * the note says where to reply and the session replies with `pana_reply`.
 */
export async function wakeScheduled(runtime: Runtime, wake: ScheduledWake): Promise<boolean> {
	return runtime.db.write(async (tx) => {
		const row = await tx.get<{ state: string }>("SELECT state FROM sessions WHERE id = ?", wake.sessionId);
		if (!row || row.state === "stopped" || row.state === "archived") return false;
		return submitScheduledWake(tx, runtime, wake);
	});
}

/**
 * The submit half of a wake, for a caller that has already made its own decision in the same
 * transaction (OBJ-18: the scheduler's admission for an objective's session).
 */
export async function submitScheduledWake(tx: SqliteExecutor, runtime: Runtime, wake: ScheduledWake): Promise<boolean> {
	const conversation = await sessionConversation(runtime, wake.sessionId);
	const scheduleUrl = runtime.url({ kind: "schedule", id: wake.scheduleId });
	// OBJ-32: a lead's every run starts with the briefing, a scheduled wake included.
	const content = await leadRunInput(
		runtime,
		wake.sessionId,
		[
			"Scheduled wakeup.",
			`Schedule: ${scheduleUrl}`,
			"Nothing you write at the end of this run is posted. Reply with pana_reply where your note says, if anything changed that someone needs to know.",
			"",
			wake.note,
		].join("\n"),
	);
	await conversation.submit(
		{
			type: "input",
			content,
			whenBusy: "followUp",
			entry: { kind: WAKE_ENTRY_KIND, data: { scheduleId: wake.scheduleId } },
			requestId: `pana.wake:${wake.scheduleId}${wake.occurrence === undefined ? "" : `:${wake.occurrence}`}`,
		},
		BACKGROUND_CONTEXT,
	);
	await setSessionState(tx, runtime, { sessionId: wake.sessionId, state: "running", from: ["idle", "failed"] });
	return true;
}
