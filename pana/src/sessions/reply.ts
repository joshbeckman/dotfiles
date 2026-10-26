// The auto-posted reply (RPL-01..RPL-05).
//
// An `onYield` hook on pi-durable's generation task runs once the model gives a final answer and
// before that answer commits. At that moment the transcript is exactly what the model saw: every
// input placed so far is in it, and mail that arrived too late is still queued. So the hook can
// decide the reply's head without reconstructing history afterwards.
//
// - Head: the newest message of the triggering thread whose delivery to this session is placed.
// - Moved: some newer message of that thread was delivered to the session but is not placed.
//   The reply is not posted. A `pana.note` write tells the model so; writes are placed before
//   queued inputs at the run's final boundary, so the next run reads the note, then the new mail.
//
// Rejected alternative: posting from the commit listener after the run settles. By then the next
// run may already have placed the new mail, and the listener cannot tell what the answer saw.
// A rerun after a crash calls the hook again; RPL-04's own-post check and the note's request ID
// keep it from posting or noting twice.

import type { Context } from "@earendil-works/chord";
import { GenerationTask, hook, LiveDoc, type HookApi, type HookRegistration, type SubmissionId } from "@earendil-works/pi-durable";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { ApiError } from "../api/errors.ts";
import type { Caller } from "../api/types.ts";
import type { Runtime } from "../server/runtime.ts";
import { respond } from "../threads/store.ts";
import { messageText } from "./runtime.ts";
import { NOTE_ENTRY_KIND, sessionConversation } from "./wake.ts";

export function createSessionHooks(getRuntime: () => Runtime): HookRegistration[] {
	return [
		hook(GenerationTask, {
			onYield: async (answer, api, context) => {
				await autoReply(getRuntime(), answer, api, context);
				return undefined;
			},
		}),
	];
}

interface DeliveryRow {
	id: string;
	message_id: string;
	thread_id: string;
	seq: number;
	sender_url: string;
	wake_submission_id: number | null;
}

async function placed(runtime: Runtime, submissionId: number | null, context: Context): Promise<boolean> {
	if (submissionId === null) return false;
	const submission = await runtime.harness.submission(submissionId as SubmissionId, context);
	const record = await submission?.status(context);
	return record?.type === "input" && record.entry !== undefined;
}

export async function autoReply(runtime: Runtime, answer: AssistantMessage, api: HookApi, context: Context): Promise<void> {
	const { db } = runtime;
	const session = await db.get<{ id: string }>("SELECT id FROM sessions WHERE conversation_id = ?", api.conversationId);
	if (!session) return;
	const live = await api.snapshot(LiveDoc, api.conversationId, context);
	const starterId = live?.run?.inputs[0];
	if (starterId === undefined) return;

	const starter = await db.get<DeliveryRow>(
		`SELECT d.id, d.message_id, d.thread_id, m.seq, d.wake_submission_id, '' AS sender_url
		   FROM deliveries d JOIN messages m ON m.id = d.message_id
		  WHERE d.recipient_id = ? AND d.wake_submission_id = ?`,
		session.id,
		starterId,
	);
	if (!starter) return;
	const threadId = starter.thread_id;

	// RPL-04: the session already posted to this thread during the run.
	const own = await db.get("SELECT 1 FROM messages WHERE thread_id = ? AND sender_id = ? AND seq > ? LIMIT 1", threadId, session.id, starter.seq);
	if (own) return;

	const text = messageText(answer).trim();
	if (text === "") return; // RPL-05

	// RPL-02: walk the session's newer deliveries in this thread, newest first, to the newest placed one.
	const deliveries = await db.all<DeliveryRow>(
		`SELECT d.id, d.message_id, d.thread_id, m.seq, d.wake_submission_id, p.url AS sender_url
		   FROM deliveries d
		   JOIN messages m ON m.id = d.message_id
		   JOIN participants p ON p.id = m.sender_id
		  WHERE d.recipient_id = ? AND d.thread_id = ? AND m.seq > ?
		  ORDER BY m.seq DESC`,
		session.id,
		threadId,
		starter.seq,
	);
	const unseen: DeliveryRow[] = [];
	for (const row of deliveries) {
		if (await placed(runtime, row.wake_submission_id, context)) break;
		unseen.unshift(row);
	}

	const caller: Caller = { kind: "session", id: session.id, url: runtime.url({ kind: "session", id: session.id }) };
	if (unseen.length === 0) {
		// Messages the session never receives, such as notices, do not move its head.
		const newest = await db.get<{ id: string }>("SELECT id FROM messages WHERE thread_id = ? ORDER BY seq DESC LIMIT 1", threadId);
		try {
			await respond(runtime, caller, threadId, { after: newest!.id, body: text });
			return;
		} catch (error) {
			// Only a stale head means the thread moved; a 409 for an archived participant does not.
			if (!(error instanceof ApiError) || error.status !== 409 || !("newer" in error.details)) throw error;
			// The thread moved between the check and the append: fall through and say so.
		}
	}
	await noteNotPosted(runtime, session.id, threadId, unseen, api, context);
}

/** RPL-03: tell the next run its reply was not posted, and which messages it has not read. */
async function noteNotPosted(runtime: Runtime, sessionId: string, threadId: string, unseen: DeliveryRow[], api: HookApi, context: Context): Promise<void> {
	const threadUrl = runtime.url({ kind: "thread", id: threadId });
	const lines = [
		`Your reply was not posted to ${threadUrl}: the thread moved while you worked.`,
		...(unseen.length > 0 ? ["New messages:"] : []),
		...unseen.map((row) => `- ${runtime.url({ kind: "message", id: row.message_id, thread: row.thread_id })} from ${row.sender_url}`),
		"Read the new messages, then answer again.",
	];
	const conversation = await sessionConversation(runtime, sessionId);
	await conversation.submit(
		{
			type: "write",
			requestId: `pana.note:${api.taskId}`,
			entry: {
				kind: NOTE_ENTRY_KIND,
				data: { threadId, messages: unseen.map((row) => row.message_id) },
				model: [{ role: "user", content: lines.join("\n"), timestamp: runtime.clock.now() }],
			},
		},
		context,
	);
}
