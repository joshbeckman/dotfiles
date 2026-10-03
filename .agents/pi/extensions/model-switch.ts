import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

// Input plus output list price per million tokens; undefined when the catalog
// has no price. Unknown is not cheap: an unpriced model needs Josh's request.
function price(model: { cost?: { input?: number; output?: number } } | undefined) {
	const total = (model?.cost?.input ?? 0) + (model?.cost?.output ?? 0);
	return total > 0 ? total : undefined;
}

type Ctx = Parameters<Parameters<ExtensionAPI["registerTool"]>[0]["execute"]>[4];

function listModels(ctx: Ctx): string {
	const current = ctx.model;
	const from = price(current);
	const k = (n: number) => (n >= 1_000_000 ? `${n / 1_000_000}M` : `${Math.round(n / 1000)}K`);
	const rows = ctx.modelRegistry
		.getAvailable()
		.filter((m) => ctx.modelRegistry.hasConfiguredAuth(m))
		.map((m) => {
			const to = price(m);
			const isCurrent = current && m.provider === current.provider && m.id === current.id;
			const free = isCurrent ? "current" : to !== undefined && from !== undefined && to <= from ? "yes" : "ask Josh";
			const cost = m.cost?.input || m.cost?.output ? `$${m.cost.input}/$${m.cost.output}` : "unknown";
			return { to, line: `| ${m.provider}/${m.id} | ${cost} | ${k(m.contextWindow)} | ${m.reasoning ? "yes" : "no"} | ${m.input.includes("image") ? "yes" : "no"} | ${free} |` };
		})
		.sort((a, b) => (a.to ?? Infinity) - (b.to ?? Infinity));
	return [
		`Current: ${current ? `${current.provider}/${current.id}` : "unknown"} at ${ctx.thinkingLevel ?? "unknown"} thinking.`,
		"Price is list input/output dollars per million tokens. \"Switch freely\" means no higher than the current price.",
		"",
		"| Model | Price | Context | Thinking | Images | Switch freely |",
		"| --- | --- | --- | --- | --- | --- |",
		...rows.map((r) => r.line),
	].join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "switch_model",
		label: "Switch Model",
		description:
			"Change the model, and optionally the thinking level, used for the rest of this Pi session. Josh's default for " +
			"new sessions is unchanged. Use only when Josh asks, or when the current model clearly can't do the task " +
			"(capability, context window, or input type). Switching to a model with a higher or unknown list price requires " +
			"that Josh explicitly asked for it in this session. Call with list: true first to see every authenticated model " +
			"with its price, context window, and whether you may switch to it without asking. The change applies from your " +
			"next model call and is recorded in the transcript.",
		parameters: Type.Object({
			list: Type.Optional(Type.Boolean({ description: "List available models instead of switching; other fields are ignored" })),
			model: Type.Optional(Type.String({ description: "provider/model-id, for example openai/gpt-5.6-sol" })),
			thinking: Type.Optional(Type.Union(LEVELS.map((level) => Type.Literal(level)))),
			reason: Type.Optional(Type.String({ description: "Why this session should switch, in one sentence" })),
			requestedByJosh: Type.Optional(
				Type.Boolean({ description: "True only if Josh explicitly asked for this model in this session" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const fail = (text: string) => ({ content: [{ type: "text" as const, text }], details: {}, isError: true });
			if (params.list) return { content: [{ type: "text" as const, text: listModels(ctx) }], details: {} };
			if (!params.model || !params.reason || params.requestedByJosh === undefined)
				return fail("Switching needs model, reason, and requestedByJosh. Use list: true to see the options.");
			const slash = params.model.indexOf("/");
			if (slash < 1) return fail("Give the model as provider/model-id.");
			const provider = params.model.slice(0, slash);
			const id = params.model.slice(slash + 1);
			const target = ctx.modelRegistry.find(provider, id);
			if (!target) {
					return fail(`Unknown model ${params.model}. Call switch_model with list: true to see the options.`);
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
