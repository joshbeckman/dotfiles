// Run admission for an objective (OBJ-23, OBJ-33, OBJ-34): one question, asked wherever a run
// would start, composed of every reason a run must wait.
//
// `obj/lead-limits` owns the hold's *mechanics*: the quiet interval (OBJ-18), the budgets
// (OBJ-20..22), and the lead-turn and message caps (OBJ-19, OBJ-24). It plugs in with
// `configureObjectiveRunAdmission`, and this module calls it after the escalation reason, so an
// escalation always holds the runs it covers even when lead-limits has also configured a hold.
//
// A held delivery stays unread and carries no wake request (`holdRun`), so `deliverHeld` delivers
// it exactly once when the hold clears (OBJ-18's "held deliveries wait"). A path that starts a
// run without a delivery — a scheduled wake, a hold's own wake — must ask `objectiveRunHold`
// before it submits; `obj/lead-limits` owns those paths.

import type { SqliteExecutor } from "@earendil-works/chord/sqlite";
import type { Runtime } from "../server/runtime.ts";
import { escalationHold, type EscalationRow, type EscalationView } from "./escalation.ts";
import { recordObjectiveEvent } from "./state.ts";

/** What would start a run. `deliveryId` is present when a message is behind it. */
export interface ObjectiveRunRequest {
	sessionId: string;
	deliveryId?: string;
	threadId?: string;
}

/** Why a run may not start. `kind` names the condition; `detail` is what the brief and events show. */
export interface RunHold {
	kind: "escalation" | (string & {});
	detail: Record<string, unknown>;
	escalation?: { row: EscalationRow; view: EscalationView };
}

/**
 * OBJ-18..24: the admission `obj/lead-limits` supplies. Returning a hold holds the run; returning
 * nothing admits it. It may write through `tx`, which commits with the delivery it is holding.
 */
export type ObjectiveRunAdmission = (tx: SqliteExecutor, runtime: Runtime, request: ObjectiveRunRequest) => Promise<RunHold | undefined>;

const admissions = new WeakMap<Runtime, ObjectiveRunAdmission>();

/** Replace the lead-limits half of admission. `obj/lead-limits` calls this before panad serves. */
export function configureObjectiveRunAdmission(runtime: Runtime, admission: ObjectiveRunAdmission | undefined): void {
	if (admission) admissions.set(runtime, admission);
	else admissions.delete(runtime);
}

/** OBJ-33/34: an escalation always holds what it covers, whatever else is configured. */
export async function objectiveRunHold(tx: SqliteExecutor, runtime: Runtime, request: ObjectiveRunRequest): Promise<RunHold | undefined> {
	const escalation = await escalationHold(tx, runtime, request.sessionId);
	if (escalation) {
		return {
			kind: "escalation",
			detail: {
				escalation: escalation.escalation.id,
				scope: escalation.escalation.member_id === null ? "objective" : "member",
				...(escalation.escalation.member_id === null ? {} : { member: escalation.escalation.member_id }),
				session: request.sessionId,
			},
			escalation: { row: escalation.escalation, view: escalation.view },
		};
	}
	return (await admissions.get(runtime)?.(tx, runtime, request)) ?? undefined;
}

/**
 * Hold a delivery: leave it unread and without a wake request, so no run starts for it now and a
 * later `deliverHeld` carries it exactly once. Records why (OBJ-23).
 */
export async function holdRun(tx: SqliteExecutor, runtime: Runtime, request: ObjectiveRunRequest, hold: RunHold): Promise<void> {
	const session = await tx.get<{ objective_id: string | null }>("SELECT objective_id FROM sessions WHERE id = ?", request.sessionId);
	if (request.deliveryId !== undefined) {
		await tx.run("UPDATE deliveries SET wake_request_id = NULL WHERE id = ?", request.deliveryId);
	}
	if (session?.objective_id === null || session?.objective_id === undefined) return;
	await recordObjectiveEvent(tx, runtime, {
		objectiveId: session.objective_id,
		kind: "run.held",
		detail: { ...hold.detail, ...(request.deliveryId === undefined ? {} : { delivery: request.deliveryId }), ...(request.threadId === undefined ? {} : { thread: request.threadId }) },
	});
}
