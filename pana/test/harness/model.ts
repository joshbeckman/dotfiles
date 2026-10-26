// A scripted faux model (TST-02). Each turn is one model response: text, tool calls, or a
// failure, with optional usage and cost. pi-ai's faux provider estimates usage with zero cost,
// so the stream is wrapped to replace usage with the turn's own.

import { createModels, type MutableModels } from "@earendil-works/pi-ai/models";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	type FauxContentBlock,
	type FauxProviderHandle,
	type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import type { AssistantMessage, AssistantMessageEvent, ToolCall, Usage } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

export interface TurnUsage {
	input?: number;
	output?: number;
	/** Total cost of the turn in US dollars. */
	costUsd?: number;
}

export interface ToolCallSpec {
	name: string;
	args?: ToolCall["arguments"];
	id?: string;
}

export type Turn =
	| { text: string; usage?: TurnUsage }
	| { toolCalls: ToolCallSpec[]; text?: string; usage?: TurnUsage }
	| { fail: string; usage?: TurnUsage };

export type Script = Turn[];

export const FAUX_MODEL = { provider: "faux", modelId: "faux-1" } as const;

export interface ScriptedModel {
	models: MutableModels;
	faux: FauxProviderHandle;
	/** The model reference to configure sessions with. */
	model: typeof FAUX_MODEL;
	/** Queue more turns after the current script. */
	append(turns: Script): void;
	/** Turns not yet consumed. */
	remaining(): number;
	/** Model requests made so far. */
	calls(): number;
}

function toUsage(spec: TurnUsage | undefined): Usage | undefined {
	if (!spec) return undefined;
	const input = spec.input ?? 0;
	const output = spec.output ?? 0;
	const total = spec.costUsd ?? 0;
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: total, cacheRead: 0, cacheWrite: 0, total },
	};
}

function toMessage(turn: Turn): AssistantMessage {
	if ("fail" in turn) {
		return fauxAssistantMessage([], { stopReason: "error", errorMessage: turn.fail });
	}
	if ("toolCalls" in turn) {
		const blocks: FauxContentBlock[] = [];
		if (turn.text) blocks.push(fauxText(turn.text));
		for (const call of turn.toolCalls) blocks.push(fauxToolCall(call.name, call.args ?? {}, call.id ? { id: call.id } : {}));
		return fauxAssistantMessage(blocks, { stopReason: "toolUse" });
	}
	return fauxAssistantMessage(turn.text);
}

function patch(event: AssistantMessageEvent, usage: Usage): AssistantMessageEvent {
	if (event.type === "done") return { ...event, message: { ...event.message, usage } };
	if (event.type === "error") return { ...event, error: { ...event.error, usage } };
	return event;
}

export function createScriptedModel(script: Script = []): ScriptedModel {
	const faux = fauxProvider();
	const usages: Array<Usage | undefined> = [];
	let consumed = 0;

	const load = (turns: Script, append: boolean) => {
		const steps: FauxResponseStep[] = turns.map(toMessage);
		usages.push(...turns.map((turn) => toUsage(turn.usage)));
		if (append) faux.appendResponses(steps);
		else faux.setResponses(steps);
	};
	load(script, false);

	const inner = faux.provider;
	const wrap = <F extends (...args: never[]) => ReturnType<typeof inner.streamSimple>>(stream: F): F =>
		((...args: Parameters<F>) => {
			const usage = usages[consumed++];
			const source = stream(...args);
			if (!usage) return source;
			const outer = createAssistantMessageEventStream();
			void (async () => {
				for await (const event of source) outer.push(patch(event, usage));
				const result = await source.result();
				outer.end({ ...result, usage });
			})();
			return outer;
		}) as F;

	const provider = {
		...inner,
		stream: wrap(inner.stream.bind(inner) as never),
		streamSimple: wrap(inner.streamSimple.bind(inner) as never),
	} as typeof inner;

	const models = createModels();
	models.setProvider(provider);

	return {
		models,
		faux,
		model: FAUX_MODEL,
		append: (turns) => load(turns, true),
		remaining: () => faux.getPendingResponseCount(),
		calls: () => faux.state.callCount,
	};
}
