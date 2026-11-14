// The push gate (PSH-06..PSH-09): one `noul` question over a rendered delivery, asked before the
// user's phone is buzzed.
//
// Every delivery to the user used to push: a session's one-line status report and a question only
// Josh can answer both interrupted him. The gate asks the same System One model the wake gate asks,
// over the same text the wake renders, and pushes only a delivery that is likely to be waiting on
// him. Skipping a push is silence, never a lost message: the SSE publish is unconditional and the
// delivery is unread in the inbox either way.
//
// It fails open in every direction. No `decisionModel`, no provider, no key, a timeout, a malformed
// answer, or any other error returns `undefined`, and the caller pushes as it always has: a phone
// that stays quiet for a message he wanted costs more than a buzz for one he did not.
//
// The question and the threshold are measured against this domain's own mail
// (`pana/docs/push-gate.md`): ten wordings, two runs each, 816 deduped deliveries, 200 of them
// hand-labeled, and the read times of every delivery as a cross-check.

import { decide, DecisionError, type DecisionQuestions } from "./index.ts";
import { logGateDecision } from "./log.ts";
import type { Runtime } from "../server/runtime.ts";

/** The question's name in the request and the answer map. */
export const PUSH_QUESTION = "delivery_needs_push";

/**
 * Push only at or above this probability, and stay quiet below it.
 *
 * Chosen from the measured cost curve, not by taste. On the 200 hand-labeled deliveries a missed
 * push costs three times a useless one (a miss delays an answer; a useless push spends attention
 * every time, and the message is still unread in the inbox). At that weighting the wording below
 * costs 67.5 mistakes per 200 messages at 0.6, against 157 for pushing everything; 0.5 and 0.7 are
 * both worse (72.5 and 75). The gate keeps paying until a missed push is worth about five useful
 * ones (10x: 276 against 157).
 */
export const PUSH_GATE_THRESHOLD = 0.6;

/**
 * The question, in the wording that measured best. It starts from the plain interruption question,
 * which alone ranked mail at 0.72 AUC, and adds the clause that fixed its one systematic miss: a
 * report that a pull request is open and green *is* a request ("merge it"), and the plain wording
 * read it as finished work. With that clause the ranking rose to 0.81 on both runs.
 */
const QUESTION: DecisionQuestions[string] = {
	type: "noul",
	instructions:
		"Does this message need to interrupt the recipient now with a notification on their phone? Answer yes when waiting until they next open the app would cost them something, including when a pull request is open and waiting on their merge, a decision only they can make, or work blocked on them. Answer no when the message can wait.",
	criteria: {
		true: "Waiting would delay something the recipient has to do or decide, including a merge or an approval that is waiting on them.",
		false: "The message can wait until the recipient next opens the app.",
	},
};

export interface PushDecision {
	probability: number;
	/** False when the delivery is below the threshold, which skips the push. */
	push: boolean;
}

/** Delivery id to its decision. A delivery absent from the plan pushes as before. */
export type PushGatePlan = ReadonlyMap<string, PushDecision>;

/**
 * Decide whether each delivery of one message pushes. Returns `undefined` when the gate is off or
 * cannot answer, which means every delivery pushes as it does today.
 *
 * A failure is logged rather than swallowed: a wrong endpoint or a missing key otherwise looks
 * exactly like a gate that keeps answering "push", and nobody sees it (`messageId` makes the line
 * findable).
 */
export async function planPushGate(
	runtime: Runtime,
	text: string,
	deliveryIds: readonly string[],
	messageId?: string,
): Promise<PushGatePlan | undefined> {
	if (!runtime.config.decisionModel || deliveryIds.length === 0) return undefined;
	let probability: number;
	try {
		const answers = await decide(runtime, text, { [PUSH_QUESTION]: QUESTION });
		probability = answers[PUSH_QUESTION]!;
	} catch (error) {
		// PSH-09: fail open. The failure is the absence of a plan, and the caller pushes normally.
		const reason = error instanceof DecisionError ? `${error.code}: ${error.message}` : String((error as Error).message ?? error);
		logGateDecision(runtime, {
			event: "push.gate",
			...(messageId === undefined ? {} : { messageId }),
			decision: "failed",
			error: reason,
		});
		return undefined;
	}
	const push = probability >= PUSH_GATE_THRESHOLD;
	const plan = new Map<string, PushDecision>();
	for (const deliveryId of deliveryIds) plan.set(deliveryId, { probability, push });
	return plan;
}
