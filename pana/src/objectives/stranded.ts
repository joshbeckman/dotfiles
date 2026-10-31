// What a stranded or failed lead leaves behind (OBJ-36), and one rule a superseded lead must meet
// (OBJ-35).
//
// A failed lead never spends on its own replacement: nothing here regenerates. All this module does
// is record the failing run's thread and message in `objective_events`, so the user can read what
// happened before deciding, and refuse to let a lead that has a successor resume itself. It is
// written for the run settlement in `src/sessions/`, so it imports nothing from that package.

import type { SqliteExecutor } from "@earendil-works/chord/sqlite";
import { ApiError } from "../api/errors.ts";
import type { Runtime } from "../server/runtime.ts";
import { objectiveUrl, recordObjectiveEvent } from "./state.ts";

export interface LeadFailure {
	objectiveId: string;
	sessionId: string;
	/** The provider or runtime reason the run failed. */
	reason: string;
	/** The run's trigger: the thread and message a reader opens to see what happened. */
	threadId?: string;
	messageId?: string;
}

/** OBJ-36: record a failed lead run, with the URLs the user needs to read it. */
export async function recordLeadFailure(runtime: Runtime, failure: LeadFailure): Promise<void> {
	const thread = failure.threadId === undefined ? undefined : runtime.url({ kind: "thread", id: failure.threadId });
	const message = failure.threadId === undefined || failure.messageId === undefined ? undefined : runtime.url({ kind: "message", id: failure.messageId, thread: failure.threadId });
	const detail = {
		reason: failure.reason,
		session: runtime.url({ kind: "session", id: failure.sessionId }),
		...(thread === undefined ? {} : { thread }),
		...(message === undefined ? {} : { message }),
	};
	await runtime.db.write((tx) =>
		recordObjectiveEvent(tx, runtime, { objectiveId: failure.objectiveId, kind: "stranded", actorId: failure.sessionId, detail }),
	);
}

/**
 * OBJ-36: the stranded notice offers the user a regenerate. The notice itself belongs to OBJ-06's
 * package; this is the sentence it appends, so the offer and the command cannot drift apart.
 */
export function regenerateOffer(runtime: Runtime, objectiveId: string): string {
	return `Regenerate the lead with \`pana objective regenerate-lead ${objectiveUrl(runtime, objectiveId)} --reason TEXT\` to hand the briefing to a replacement.`;
}

/**
 * OBJ-35: a lead that has a successor cannot resume itself into the objective. A former lead is a
 * session carrying the objective with no session parent (leads are children of the user), whose id
 * is no longer `objectives.lead_id`. Members have a session parent, so the rule never touches them.
 */
export async function assertNotSupersededLead(db: SqliteExecutor, sessionId: string): Promise<void> {
	const row = await db.get<{ lead_id: string | null; parent: string | null }>(
		`SELECT o.lead_id AS lead_id, s.parent AS parent
		   FROM sessions s JOIN objectives o ON o.id = s.objective_id
		  WHERE s.id = ?`,
		sessionId,
	);
	if (row === undefined || row.parent !== null || row.lead_id === null || row.lead_id === sessionId) return;
	throw ApiError.forbidden(`session ${sessionId} was replaced as this objective's lead and cannot resume it`, {
		session: sessionId,
		lead: row.lead_id,
	});
}
