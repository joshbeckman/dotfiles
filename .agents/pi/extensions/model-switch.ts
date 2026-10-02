import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

// Input plus output list price per million tokens; undefined when the catalog
// has no price. Unknown is not cheap: an unpriced model needs Josh's request.
function price(model: { cost?: { input?: number; output?: number } } | undefined) {
	const total = (model?.cost?.input ?? 0) + (model?.cost?.output ?? 0);
	return total > 0 ? total : undefined;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "switch_model",
		label: "Switch Model",
		description:
			"Change the model, and optionally the thinking level, used for the rest of this Pi session. Josh's default for " +
			"new sessions is unchanged. Use only when Josh asks, or when the current model clearly can't do the task " +
			"(capability, context window, or input type). Switching to a model with a higher or unknown list price requires " +
			"that Josh explicitly asked for it in this session. The change applies from your next model call and is recorded " +
			"in the transcript.",
		parameters: Type.Object({
			model: Type.String({ description: "provider/model-id, for example openai/gpt-5.6-sol" }),
			thinking: Type.Optional(Type.Union(LEVELS.map((level) => Type.Literal(level)))),
			reason: Type.String({ description: "Why this session should switch, in one sentence" }),
			requestedByJosh: Type.Boolean({ description: "True only if Josh explicitly asked for this model in this session" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const fail = (text: string) => ({ content: [{ type: "text" as const, text }], details: {}, isError: true });
			const slash = params.model.indexOf("/");
			if (slash < 1) return fail("Give the model as provider/model-id.");
			const provider = params.model.slice(0, slash);
			const id = params.model.slice(slash + 1);
			const target = ctx.modelRegistry.find(provider, id);
			if (!target) {
				const options = ctx.modelRegistry
					.getAvailable()
					.map((m) => `${m.provider}/${m.id}`)
					.slice(0, 40)
					.join(", ");
				return fail(`Unknown model ${params.model}. Available: ${options}`);
			}
			if (!ctx.modelRegistry.hasConfiguredAuth(target)) return fail(`${params.model} has no configured credentials.`);
			const before = ctx.model;
			const from = price(before);
			const to = price(target);
			if (!params.requestedByJosh && (to === undefined || from === undefined || to > from))
				return fail(
					`Refused: ${params.model} costs more than the current model, or its price is unknown. Ask Josh first.`,
				);
			if (!(await pi.setModel(target))) return fail(`Pi refused ${params.model}; its provider may not be authenticated.`);
			if (params.thinking) pi.setThinkingLevel(params.thinking);
			const summary =
				`Switched from ${before ? `${before.provider}/${before.id}` : "unknown"} to ${params.model}` +
				(params.thinking ? ` at ${pi.getThinkingLevel()} thinking` : "") +
				`. Reason: ${params.reason}`;
			return { content: [{ type: "text" as const, text: summary }], details: { from: before?.id, to: target.id } };
		},
	});
}
