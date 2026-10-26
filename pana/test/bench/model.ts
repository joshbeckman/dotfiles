// The bench's faux model (SCALE-01, SCALE-02). A script of turns cannot drive hundreds of
// sessions whose runs interleave in an order nobody controls, so this model decides each turn
// from the transcript it is given. It never sees a counter or any state outside the request,
// which keeps it correct across steers, follow-ups, and restarts.
//
// Every bench message body is a directive:
//   bench reply TAG         answer with `bench answer <message ULID>`
//   bench spawn D B TAG     create B child sessions with `bench spawn D-1 B`, when D > 0, then answer
//   bench answer ULID       a session's answer; it needs no reply, so the run ends with empty text
//
// A run's first input is answered by its final text, which panad auto-posts (RPL-01). Any other
// message that joins the run as a steer is answered with `pana_reply` during the run.

import { createModels, createProvider, type MutableModels } from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxContentBlock } from "@earendil-works/pi-ai/providers/faux";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";

export const BENCH_MODEL = "faux/faux-1";

export interface BenchMessage {
	id: string;
	threadId: string;
	body: string;
}

export type Directive = { kind: "reply" } | { kind: "spawn"; depth: number; branch: number } | { kind: "answer" } | { kind: "other" };

export function directive(body: string): Directive {
	const words = body.trim().split(/\s+/);
	if (words[0] !== "bench") return { kind: "other" };
	if (words[1] === "reply") return { kind: "reply" };
	if (words[1] === "answer") return { kind: "answer" };
	if (words[1] === "spawn") {
		const depth = Number(words[2]);
		const branch = Number(words[3]);
		if (Number.isInteger(depth) && Number.isInteger(branch)) return { kind: "spawn", depth, branch };
	}
	return { kind: "other" };
}

export function needsReply(body: string): boolean {
	const kind = directive(body).kind;
	return kind === "reply" || kind === "spawn";
}

export function answerBody(messageId: string): string {
	return `bench answer ${messageId}`;
}

function text(message: Message): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } => typeof block === "object" && block !== null && block.type === "text")
		.map((block) => block.text)
		.join("");
}

const MESSAGE_URL = /^Message: pana:\/\/[^/]+\/threads\/([0-9A-Z]{26})\?message=([0-9A-Z]{26})$/m;

/** A `pana.message` input as the session runtime renders it (src/sessions/wake.ts). */
export function parseInput(message: Message): BenchMessage | undefined {
	if (message.role !== "user") return undefined;
	const content = text(message);
	if (!content.startsWith("New message.")) return undefined;
	const match = MESSAGE_URL.exec(content);
	if (!match) return undefined;
	const split = content.indexOf("\n\n");
	return { threadId: match[1]!, id: match[2]!, body: split < 0 ? "" : content.slice(split + 2) };
}

function isFinal(message: Message): boolean {
	return message.role === "assistant" && !(message as AssistantMessage).content.some((block) => block.type === "toolCall");
}

/** What the model answers, given the transcript of one request. */
export function respond(messages: readonly Message[]): AssistantMessage {
	let lastAssistant = -1;
	let lastFinal = -1;
	messages.forEach((message, index) => {
		if (message.role !== "assistant") return;
		lastAssistant = index;
		if (isFinal(message)) lastFinal = index;
	});
	const runInputs = messages.slice(lastFinal + 1).flatMap((message) => parseInput(message) ?? []);
	const starter = runInputs[0];
	const fresh = messages.slice(lastAssistant + 1).flatMap((message) => parseInput(message) ?? []);

	const calls: FauxContentBlock[] = [];
	for (const input of fresh) {
		const order = directive(input.body);
		if (order.kind === "spawn" && order.depth > 0) {
			for (let i = 0; i < order.branch; i++) {
				calls.push(fauxToolCall("pana_session_create", { prompt: `bench spawn ${order.depth - 1} ${order.branch} ${input.id}.${i}` }));
			}
		}
		if (input.id !== starter?.id && needsReply(input.body)) {
			calls.push(fauxToolCall("pana_reply", { thread: input.threadId, after: input.id, body: answerBody(input.id) }));
		}
	}
	if (calls.length > 0) return fauxAssistantMessage(calls, { stopReason: "toolUse" });
	const answer = starter && needsReply(starter.body) ? answerBody(starter.id) : "";
	return fauxAssistantMessage(answer === "" ? [] : [fauxText(answer)]);
}

export interface BenchModelOptions {
	/** Simulated model latency per request, in milliseconds. */
	latencyMs?: number;
}

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * A `Models` with one provider, `faux`, answering every request through `respond`.
 *
 * Rejected alternative: pi-ai's faux provider with `respond` as a response factory. It keeps the
 * last prompt of every session for its cache estimate and re-reads the whole prompt per request,
 * so at bench scale it adds memory and CPU that a real provider never puts in panad.
 */
export function createBenchModels(options: BenchModelOptions = {}): MutableModels {
	const latency = options.latencyMs ?? 0;
	const [model] = fauxProvider().models;
	const stream = (requestModel: typeof model, context: { messages: Message[] }) => {
		const out = createAssistantMessageEventStream();
		void (async () => {
			if (latency > 0) await new Promise((resolve) => setTimeout(resolve, latency));
			const message: AssistantMessage = {
				...respond(context.messages),
				api: requestModel.api,
				provider: requestModel.provider,
				model: requestModel.id,
				usage: ZERO_USAGE,
				timestamp: Date.now(),
			};
			out.push({ type: "start", partial: { ...message, content: [] } });
			out.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
			out.end(message);
		})();
		return out;
	};
	const provider = createProvider({
		id: model.provider,
		auth: { apiKey: { name: "Faux", resolve: async () => ({ auth: {} }) } },
		models: [model],
		api: { stream: stream as never, streamSimple: stream as never },
	} as never);
	const models = createModels();
	models.setProvider(provider);
	return models;
}
