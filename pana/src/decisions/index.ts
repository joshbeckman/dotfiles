// The decision model (DEC-01, DEC-02): a System One model that reads one state and answers typed
// questions with calibrated probabilities instead of generating text. Fireworks serves one as
// `accounts/fireworks/models/rune`; the native protocol is `POST <baseUrl>/v1/systemone` with a
// `state` and a map of questions, and a `noul` question answers the probability of yes. A
// provider's base URL stops at its API root (`https://api.fireworks.ai/inference`), so the
// version segment belongs to the path and not to the base URL: `/inference/systemone` is a 404,
// `/inference/v1/systemone` answers.
//
// Nothing in pana asks a decision model to write prose. `decide` returns probabilities keyed by
// question name, and a caller acts on them; see `gate.ts` for the wake gate, the one caller today.
//
// Credentials stay in panad's environment. The provider comes from `runtime.models`, which panad
// built from its own env (src/server/models.ts); the base URL and the key come from that
// provider's auth context. When the provider resolves no key, the key panad's environment holds
// for it (`FIREWORKS_API_KEY` for `fireworks`) is the fallback. Pana writes no key to disk.
//
// `setDecisionTransport` replaces the wire call, the way `setPushTransport` does for Web Push, so
// tests never reach the network and no test needs a real key.
//
// One short deadline (about 2 seconds) bounds the call. A decision is an optimization: a caller
// must treat every error as "no answer" and carry on, never as a reason to stop work. `decide`
// therefore throws a typed `DecisionError` and takes no part in any transaction.

import type { Runtime } from "../server/runtime.ts";

/** One question's answer from a System One state. A `noul` question answers "yes" probability. */
export type DecisionQuestions = Record<
	string,
	{ type: "noul"; instructions: string; criteria?: { true: string; false: string } }
>;

export interface DecisionRequest {
	providerId: string;
	/** The model path within the provider, e.g. `accounts/fireworks/models/rune`. */
	modelId: string;
	state: string;
	questions: DecisionQuestions;
}

/**
 * Sends one decision request and returns the parsed response body. The default transport resolves
 * the provider's base URL and key; a test transport answers from a script.
 */
export type DecisionTransport = (request: DecisionRequest, signal: AbortSignal) => Promise<unknown>;

export type DecisionErrorCode = "no_decision_model" | "unknown_model" | "decision_failed" | "decision_timeout";

export class DecisionError extends Error {
	readonly code: DecisionErrorCode;
	constructor(code: DecisionErrorCode, message: string) {
		super(message);
		this.name = "DecisionError";
		this.code = code;
	}
}

/** The one deadline. A wake is worth waiting a moment for, and never longer than this. */
export const DECISION_TIMEOUT_MS = 2_000;

/** The native System One protocol's path under a provider's API root (DEC-02). */
export const SYSTEM_ONE_PATH = "/v1/systemone";

const transports = new WeakMap<Runtime, DecisionTransport>();

/** Replace the sender for this panad. Tests use it to answer without the network. */
export function setDecisionTransport(runtime: Runtime, transport: DecisionTransport | undefined): void {
	if (transport) transports.set(runtime, transport);
	else transports.delete(runtime);
}

/** `provider/model-id` split, or a `no_decision_model`/`unknown_model` error. */
export function decisionModelRef(runtime: Runtime): { providerId: string; modelId: string } {
	const ref = runtime.config.decisionModel;
	if (!ref) throw new DecisionError("no_decision_model", "config.json has no decisionModel");
	const slash = ref.indexOf("/");
	// `accounts/fireworks/models/rune` sits after the provider, so only the first slash separates them.
	if (slash <= 0 || slash === ref.length - 1) {
		throw new DecisionError("unknown_model", `decisionModel ${ref} is not a provider/model-id reference`);
	}
	return { providerId: ref.slice(0, slash), modelId: ref.slice(slash + 1) };
}

/** The environment key a provider's credentials conventionally live under: `FIREWORKS_API_KEY`. */
export function providerEnvKey(providerId: string): string {
	return `${providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
}

function transportFor(runtime: Runtime): DecisionTransport {
	const custom = transports.get(runtime);
	if (custom) return custom;
	return async (request, signal) => {
		const provider = runtime.models.getProvider(request.providerId);
		if (!provider) throw new DecisionError("unknown_model", `no provider matches decisionModel ${runtime.config.decisionModel}`);
		const auth = await runtime.models.getAuth(request.providerId).catch(() => undefined);
		const apiKey = auth?.auth.apiKey ?? process.env[providerEnvKey(request.providerId)];
		if (!apiKey) {
			throw new DecisionError("decision_failed", `no API key for provider ${request.providerId}`);
		}
		const baseUrl = (auth?.auth.baseUrl ?? provider.baseUrl ?? "").replace(/\/+$/u, "");
		if (!baseUrl) throw new DecisionError("decision_failed", `provider ${request.providerId} has no base URL`);
		const response = await fetch(`${baseUrl}${SYSTEM_ONE_PATH}`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
			body: JSON.stringify({ model: request.modelId, state: request.state, questions: request.questions }),
			signal,
		});
		if (!response.ok) throw new DecisionError("decision_failed", `decision model answered ${response.status}`);
		return await response.json();
	};
}

/**
 * Ask the configured decision model one state's questions and return the "yes" probability for
 * each by name. Throws `DecisionError`; a caller must fail open.
 */
export async function decide(runtime: Runtime, state: string, questions: DecisionQuestions): Promise<Record<string, number>> {
	const { providerId, modelId } = decisionModelRef(runtime);
	if (!runtime.models.getProvider(providerId)) {
		throw new DecisionError("unknown_model", `no provider matches decisionModel ${runtime.config.decisionModel}`);
	}
	const controller = new AbortController();
	// DEC-02: the one short deadline, on the runtime clock so a fake clock drives it too.
	const cancel = runtime.clock.setTimer(() => controller.abort(), DECISION_TIMEOUT_MS, { background: false });
	let body: unknown;
	try {
		body = await transportFor(runtime)({ providerId, modelId, state, questions }, controller.signal);
	} catch (error) {
		if (controller.signal.aborted) throw new DecisionError("decision_timeout", `decision model took longer than ${DECISION_TIMEOUT_MS}ms`);
		if (error instanceof DecisionError) throw error;
		throw new DecisionError("decision_failed", `decision model failed: ${(error as Error).message}`);
	} finally {
		cancel?.();
	}
	return parseAnswers(body, Object.keys(questions));
}

/** `{ answers: { name: { type: "noul", noul: 0.2 } } }` to `{ name: 0.2 }`. */
function parseAnswers(body: unknown, names: readonly string[]): Record<string, number> {
	const answers = (body as { answers?: unknown } | null)?.answers;
	if (typeof answers !== "object" || answers === null || Array.isArray(answers)) {
		throw new DecisionError("decision_failed", "decision model returned no answers");
	}
	const probabilities: Record<string, number> = {};
	for (const name of names) {
		const answer = (answers as Record<string, unknown>)[name] as { type?: unknown; noul?: unknown } | undefined;
		if (!answer || typeof answer !== "object" || answer.type !== "noul" || typeof answer.noul !== "number" || !Number.isFinite(answer.noul)) {
			throw new DecisionError("decision_failed", `decision model did not answer ${name} as a noul question`);
		}
		probabilities[name] = answer.noul;
	}
	return probabilities;
}
