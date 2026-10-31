// The escalation half of run admission (OBJ-33, OBJ-34).
//
// `admitRun` in `hold.ts` is the one decision about whether a run may start. It asks this module
// first, so an escalation the user owes an answer on outranks a budget pause or a turn cap, and it
// answers in `admitRun`'s own shape (`RunAdmission`) rather than inventing a second one. There is
// one gate over one decision; a caller that reaches `admitRun` — the delivery hook, retried mail,
// a scheduled wake, a resume, a hold release — cannot start a covered run by another path.
//
// A held delivery stays unread with no wake request, so `deliverHeld` carries it exactly once when
// the escalation clears (OBJ-18's "held deliveries wait"). Clearing happens in `escalation.ts`: a
// user message in the objective's thread, or the charter's timeout.

import type { SqliteExecutor } from "@earendil-works/chord/sqlite";
import type { Runtime } from "../server/runtime.ts";
import { escalationHold } from "./escalation.ts";
import type { RunAdmission, RunIntent } from "./hold.ts";
import { recordObjectiveEvent } from "./state.ts";

/**
 * OBJ-33/34: does an open escalation hold this session's run? The lead is covered by either
 * scope; a member only by an escalation that names it. Returns nothing when no escalation covers
 * the session, so `admitRun` goes on to its own conditions.
 */
export async function objectiveRunHold(tx: SqliteExecutor, runtime: Runtime, sessionId: string, intent?: RunIntent): Promise<RunAdmission | undefined> {
	const hold = await escalationHold(tx, runtime, sessionId);
	if (hold === undefined) return undefined;
	// OBJ-23/34: record why the run waited, naming the scope and the message the user answers.
	await recordObjectiveEvent(tx, runtime, {
		objectiveId: hold.escalation.objective_id,
		kind: "run.held",
		detail: {
			condition: "awaiting_user",
			session: sessionId,
			escalation: hold.escalation.id,
			scope: hold.escalation.member_id === null ? "objective" : "member",
			...(hold.escalation.member_id === null ? {} : { member: hold.escalation.member_id }),
			...(intent?.deliveryId === undefined ? {} : { delivery: intent.deliveryId }),
		},
	});
	return {
		admit: false,
		objectiveId: hold.escalation.objective_id,
		lead: hold.lead,
		condition: "awaiting_user",
		// A timeout is when the hold lifts by itself; without one the user's answer is the only exit.
		...(hold.escalation.timeout_at === null ? {} : { until: hold.escalation.timeout_at }),
	};
}
