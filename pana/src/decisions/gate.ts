// The wake gate (DEC-03..DEC-07): one `noul` question over a rendered delivery, asked before a
// session's wake is submitted.
//
// A wake renders the whole message into a frontier turn, so an acknowledgment from another
// session buys a full one. The gate asks a System One model whether this delivery needs action and
// skips only a delivery that is very unlikely to. Everything that is not a plain session message
// bypasses it: the user's own mail, schedule wakes, an objective lead's run, and notices all wake
// as they always have, and so does a retried delivery.
//
// It fails open in every direction. No `decisionModel`, no provider, no key, a timeout, a malformed
// answer, or any other error returns `undefined`, and the caller wakes as before: a dropped wake
// costs more than a cheap turn.
//
// The decision is made once per delivery, before the append transaction, and it never runs inside
// one. The result is recorded on the delivery (`delivery_wake_decisions`) and the caller logs one
// line per recipient, so a retry reuses the answer instead of asking again.

import { decide, DecisionError, type DecisionQuestions } from "./index.ts";
import { logGateDecision } from "./log.ts";
import type { Runtime } from "../server/runtime.ts";

/** The question's name in the request and the answer map. */
export const WAKE_QUESTION = "delivery_needs_action";

/**
 * Skip a wake only below this probability. A System One model is calibrated, so a low answer is
 * ordinary mail that needs no action; 0.15 keeps the odd false negative rare, and the cost of one
 * is a wake that arrives on the next real wake or resume.
 */
export const WAKE_GATE_THRESHOLD = 0.15;

/**
 * The question, in the wording that measured best against a labeled corpus of this domain's
 * session mail (see `pana/docs/wake-gate.md`): it asks for a request, question, assignment, or
 * decision to follow *anywhere* in the message, including inside a status report, because an ask
 * buried mid-paragraph was the old wording's commonest miss. Courtesy still answers no.
 */
const QUESTION: DecisionQuestions[string] = {
	type: "noul",
	instructions:
		"Does the receiving session need to act on this message? Answer yes when it asks the session to do, answer, decide, fix, review, rebase, merge, or produce something; when it assigns work; when it states an interface or decision the session must follow; or when it asks a question. Status reports that request nothing, acknowledgments, agreements, thanks, and sign-offs need no action.",
	criteria: {
		true: "Somewhere in the message is a request, a question, an assignment, or a decision the recipient must follow, even when the message is mostly a status report.",
		false: "The message reports status, agrees, thanks, or signs off, and asks the recipient for nothing.",
	},
};

export interface GateDecision {
	probability: number;
	/** False when the delivery is below the threshold, which skips the wake. */
	wake: boolean;
}

/** Recipient id to its decision. A recipient absent from the plan wakes as before. */
export type WakeGatePlan = ReadonlyMap<string, GateDecision>;

/**
 * Decide whether each recipient of one delivery needs action. Returns `undefined` when the gate is
 * off or cannot answer, which means every recipient wakes as it does today.
 *
 * A failure is logged, not swallowed silently: a wrong endpoint or a missing key otherwise looks
 * exactly like a gate that keeps answering "wake", and nobody sees it. `messageId` is only there
 * to make that line findable.
 */
export async function planWakeGate(
	runtime: Runtime,
	text: string,
	recipients: readonly string[],
	messageId?: string,
): Promise<WakeGatePlan | undefined> {
	if (!runtime.config.decisionModel || recipients.length === 0) return undefined;
	let probability: number;
	try {
		const answers = await decide(runtime, text, { [WAKE_QUESTION]: QUESTION });
		probability = answers[WAKE_QUESTION]!;
	} catch (error) {
		// DEC-06: fail open. The failure is the absence of a plan, and the caller wakes normally.
		// DEC-08: one line says so, because a gate that cannot answer leaves no other trace.
		const reason = error instanceof DecisionError ? `${error.code}: ${error.message}` : String((error as Error).message ?? error);
		logGateDecision(runtime, {
			event: "wake.gate",
			...(messageId === undefined ? {} : { messageId }),
			decision: "failed",
			error: reason,
		});
		return undefined;
	}
	const wake = probability >= WAKE_GATE_THRESHOLD;
	const plan = new Map<string, GateDecision>();
	for (const recipient of recipients) plan.set(recipient, { probability, wake });
	return plan;
}
