import type { AssistantMessage, AssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";

const RETRY_HINT = "(please retry your request)";
const AUTH_ERROR = /(?<![a-z0-9])401(?![a-z0-9])|\bAuthenticationError\b|\bunauthorized\b|\binvalid[ _-]+api[ _-]+key\b|\bapi[ _-]+key[ _-]+(?:is[ _-]+)?invalid\b|\bexpired[ _-]+(?:access[ _-]+|auth[ _-]+)?token\b|\b(?:access[ _-]+|auth[ _-]+)?token[ _-]+(?:has[ _-]+|is[ _-]+)?expired\b/i;
const FORBIDDEN = /(?<![a-z0-9])403(?![a-z0-9])/i;

/**
 * Let pi-durable own the retry budget, durable backoff and progress reporting, including for
 * authentication failures. pi-ai 1.4.0 has no classifier override: append its recognized
 * retry guidance as a compatibility bridge, retaining the provider's original diagnostic.
 * Its quota/billing exclusions still take precedence over that guidance.
 */
export function withAuthRetries(models: Models): Models {
	const messages = new WeakMap<AssistantMessage, AssistantMessage>();
	function annotate(message: AssistantMessage): AssistantMessage {
		const cached = messages.get(message);
		if (cached) return cached;
		const text = message.errorMessage;
		if (message.stopReason !== "error" || !text || !AUTH_ERROR.test(text) || FORBIDDEN.test(text) || text.includes(RETRY_HINT)) {
			return message;
		}
		const candidate = { ...message, errorMessage: `${text} ${RETRY_HINT}` };
		if (!isRetryableAssistantError(candidate)) return message;
		messages.set(message, candidate);
		return candidate;
	}

	function stream(source: AssistantMessageEventStream): AssistantMessageEventStream {
		// Do not start a second consumer or a detached pump: both result-only callers and
		// iterators must retain the source's completion, cancellation and rejection behavior.
		return new Proxy(source, {
			get(target, key) {
				if (key === "result") return () => target.result().then(annotate);
				if (key === Symbol.asyncIterator) return async function* () {
					for await (const event of target) {
						if (event.type !== "error") yield event;
						else {
							const error = annotate(event.error);
							yield error === event.error ? event : { ...event, error };
						}
					}
				};
				const value: unknown = Reflect.get(target, key, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	}

	// Own method properties let callers replace/spy on the adapter without changing the
	// original Models. The fallback delegates catalog/auth methods with their real receiver.
	const methods: Record<string, (...args: unknown[]) => unknown> = {};
	for (const key of ["stream", "streamSimple", "streamDeferred"] as const) {
		methods[key] = (...args) => stream(Reflect.apply(models[key], models, args));
	}
	for (const key of ["complete", "completeSimple", "fetchDeferred"] as const) {
		methods[key] = (...args) => (Reflect.apply(models[key], models, args) as Promise<AssistantMessage>).then(annotate);
	}
	return new Proxy(methods as unknown as Models, {
		get(target, key) {
			if (Object.hasOwn(target, key)) return Reflect.get(target, key, target);
			const value: unknown = Reflect.get(models, key, models);
			return typeof value === "function" ? value.bind(models) : value;
		},
	});
}
