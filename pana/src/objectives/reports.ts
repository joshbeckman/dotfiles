// Reports (OBJ-30).
//
// A report is an ordinary message in the objective's thread plus a row in `objective_reports`.
// That is the whole design: reports keep revisions (EDT-01..EDT-03), redaction, deliveries, push,
// and FTS because they are mail, and there is no second append-only log to keep in step.
//
// The message and the row commit in one transaction (`respondIn`, the same seam `createThreadIn`
// gives launch), so a report is never half written. A report has no stale-head check of its own:
// it appends at the head, because the caller is posting an update rather than replying to a
// message it read.

import type { SqliteExecutor } from "@earendil-works/chord/sqlite";
import { ApiError } from "../api/errors.ts";
import type { Caller } from "../api/types.ts";
import type { Runtime } from "../server/runtime.ts";
import { announce } from "../threads/announce.ts";
import { currentMessage, respondIn, type MessageView, type ThreadView } from "../threads/store.ts";
import { loadObjective, objectiveId } from "./state.ts";

/** One report as a reader sees it: the message, its current body, and where to open it. */
export interface ObjectiveReportView {
	messageId: string;
	/** The message's canonical URL. */
	url: string;
	threadId: string;
	threadUrl: string;
	sender: { id: string; url: string };
	createdAt: number;
	/** The current body; absent on a redacted message, which carries `display` instead. */
	body?: string;
	display?: string;
	revised: boolean;
	redacted: boolean;
}

export interface ReportInput {
	body?: unknown;
}

/**
 * `POST /objectives/:id/report` and `pana objective report` (OBJ-30): post as the caller and mark
 * the message. A draft has no thread (OBJ-04), so it has nowhere to report. After a stop the
 * objective's thread refuses deliveries to its members (OBJ-07), so a report there is refused too:
 * the last report is posted before the user stops or finishes the objective, which is the order a
 * lead's final report takes anyway.
 */
export async function reportObjective(
	runtime: Runtime,
	caller: Caller,
	value: string | null | undefined,
	input: ReportInput,
): Promise<{ thread: ThreadView; message: MessageView; report: ObjectiveReportView }> {
	const id = objectiveId(value, runtime.config.domain);
	const row = await loadObjective(runtime.db, id);
	const threadId = row.thread_id;
	if (threadId === null) {
		throw new ApiError(409, "wrong_phase", `objective ${id} is ${row.phase}; a report lands in the objective's thread, which launch creates`, {
			objective: id,
			phase: row.phase,
		});
	}

	const recipients: string[] = [];
	const now = runtime.clock.now();
	const result = await runtime.db.atomically(async (tx) => {
		const posted = await respondIn(tx, runtime, caller, threadId, { body: input.body }, recipients);
		await tx.run(
			"INSERT INTO objective_reports (objective_id, message_id, created_at) VALUES (?, ?, ?)",
			row.id,
			posted.message.id,
			now,
		);
		const report = await reportView(tx, runtime, posted.message.id);
		return { ...posted, report: report! };
	});
	// A report is mail: the other participants (the user, and the lead when a member reports) are
	// delivered and announced exactly as an ordinary message is.
	announce(runtime, "delivery", result, recipients);
	return result;
}

/**
 * The newest report for `GET /objectives/:id` and the PWA's latest-report card, or null when the
 * objective has none. Reads from `tx` so a caller inside a transaction sees its own write.
 */
export async function newestReport(tx: SqliteExecutor, runtime: Runtime, objectiveId: string): Promise<ObjectiveReportView | null> {
	const [newest] = await reportMessages(tx, runtime, objectiveId, 1);
	return newest ?? null;
}

/**
 * The last `limit` reports, newest first. The lead's briefing shows the last five (OBJ-32) and the
 * PWA links them; both read here so there is one report view.
 */
export async function reportMessages(
	tx: SqliteExecutor,
	runtime: Runtime,
	objectiveId: string,
	limit = 5,
): Promise<ObjectiveReportView[]> {
	const rows = await tx.all<{ message_id: string }>(
		"SELECT message_id FROM objective_reports WHERE objective_id = ? ORDER BY created_at DESC, message_id DESC LIMIT ?",
		objectiveId,
		limit,
	);
	const views: ObjectiveReportView[] = [];
	for (const row of rows) {
		const view = await reportView(tx, runtime, row.message_id);
		if (view) views.push(view);
	}
	return views;
}

/** One marked message, whether or not it is the newest, with its current revision. */
async function reportView(tx: SqliteExecutor, runtime: Runtime, messageId: string): Promise<ObjectiveReportView | null> {
	const row = await tx.get<{ thread_id: string; created_at: number; sender_id: string; url: string }>(
		`SELECT m.thread_id AS thread_id, m.created_at AS created_at, m.sender_id AS sender_id, p.url AS url
		   FROM messages m JOIN participants p ON p.id = m.sender_id
		  WHERE m.id = ?`,
		messageId,
	);
	if (!row) return null;
	const body = await currentMessage(tx, messageId);
	return {
		messageId,
		url: runtime.url({ kind: "message", id: messageId, thread: row.thread_id }),
		threadId: row.thread_id,
		threadUrl: runtime.url({ kind: "thread", id: row.thread_id }),
		sender: { id: row.sender_id, url: row.url },
		createdAt: row.created_at,
		revised: body?.revised ?? false,
		redacted: body?.redacted ?? false,
		...(body?.body === undefined ? {} : { body: body.body }),
		...(body?.display === undefined ? {} : { display: body.display }),
	};
}
