import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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

const k = (n: number) => (n >= 1_000_000 ? `${n / 1_000_000}M` : `${Math.round(n / 1000)}K`);

// =============================================================================
// Benchmark data
// =============================================================================

// Capability comes from Benchmark Heaven's public API; price stays pi's own, since
// those are what Josh is actually billed and a second price source would disagree
// invisibly. The feed is cached because it is a third party and its scores move:
// the API docs record cat_science dropping ten points in a single release.

const SNAPSHOT_PATH =
	process.env.PI_MODEL_BENCHMARKS ?? join(homedir(), ".local/state/model-benchmarks/snapshot.json");
const SNAPSHOT_URL = "https://benchmarkheaven.com/api/models";
const SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Task classes, each a set of named benchmarks. The API's own category scores
// (cat_coding and friends) are documented but absent from the live feed, so these
// definitions are ours, and the output names the benchmarks that fed each score.
const CLASSES: Record<string, string[]> = {
	coding: ["aa_livecodebench", "aa_coding_index"],
	agentic: ["aa_tau2", "aa_terminalbench_hard", "aa_tau_banking"],
	science: ["aa_gpqa", "aa_hle"],
	long_context: ["aa_lcr"],
	general: ["aa_intelligence_index"],
};

type SnapshotModel = { id: string; benchmarks?: Record<string, number | null> };
type Snapshot = { generated_at?: string; models: SnapshotModel[] };
type Family = { benchmarks: Map<string, number> };

// pi ids and catalog ids disagree in four ways: the catalog suffixes a reasoning
// variant (::max, ::high, ::non-reasoning), it spells dots as dashes where pi's
// provider slugs sometimes use "p" (glm-5p3), it keeps dated aliases, and it has
// -latest routers. Every reading is tried, and a family aggregates all of its
// variants, so the score is the best recorded variant of that model.
function keys(id: string): string[] {
	const base = id.split("::")[0].toLowerCase();
	// pi ids can carry a provider path (accounts/fireworks/models/glm-5p3) where
	// the catalog has only the model name, so the last segment counts too.
	const names = [base, base.split("/").pop() ?? base];
	const out = new Set<string>();
	for (const name of names) {
		const stripped = [
			name,
			name.replace(/-\d{8}$/, ""),
			name.replace(/-\d{4}-\d{2}-\d{2}$/, ""),
			name.replace(/-latest$/, ""),
		];
		for (const candidate of stripped) {
			for (const dotted of [candidate, candidate.replace(/\./g, "p")]) {
				const key = dotted.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
				if (key) out.add(key);
			}
		}
	}
	return [...out];
}

function loadSnapshot(): { snapshot?: Snapshot; ageMs?: number } {
	try {
		const text = readFileSync(SNAPSHOT_PATH, "utf8");
		const snapshot = JSON.parse(text) as Snapshot;
		if (!Array.isArray(snapshot.models)) return {};
		const stamp = snapshot.generated_at ? Date.parse(snapshot.generated_at) : NaN;
		return { snapshot, ageMs: Number.isFinite(stamp) ? Date.now() - stamp : undefined };
	} catch {
		return {};
	}
}

// Fire and forget: a refresh must never delay or fail a recommendation, and the
// existing snapshot stays usable while it runs. Only the fields used here are kept,
// which also keeps the cache small and insulates it from unrelated feed changes.
function refreshSnapshot(): void {
	void (async () => {
		try {
			const response = await fetch(SNAPSHOT_URL, { signal: AbortSignal.timeout(30_000) });
			if (!response.ok) return;
			const feed = (await response.json()) as { generated_at?: string; models?: SnapshotModel[] };
			if (!Array.isArray(feed.models)) return;
			const trimmed: Snapshot = {
				generated_at: feed.generated_at,
				models: feed.models.map((model) => ({ id: model.id, benchmarks: model.benchmarks })),
			};
			mkdirSync(dirname(SNAPSHOT_PATH), { recursive: true });
			writeFileSync(SNAPSHOT_PATH, JSON.stringify(trimmed));
		} catch {
			// Offline, rate limited, or the feed changed shape: the cache stands.
		}
	})();
}

function families(snapshot: Snapshot): Map<string, Family> {
	const out = new Map<string, Family>();
	for (const model of snapshot.models) {
		for (const key of keys(model.id)) {
			const family = out.get(key) ?? { benchmarks: new Map<string, number>() };
			for (const [name, value] of Object.entries(model.benchmarks ?? {})) {
				if (typeof value !== "number") continue;
				family.benchmarks.set(name, Math.max(family.benchmarks.get(name) ?? -Infinity, value));
			}
			out.set(key, family);
		}
	}
	return out;
}

// Percentiles rather than raw values, because the benchmarks in one class are on
// different scales (aa_gpqa is 0-1, aa_coding_index is 0-100) and because a tier
// expressed as "top N% of reachable models" is then self-calibrating as the
// catalog moves.
function percentile(values: number[], value: number): number {
	const below = values.filter((other) => other <= value).length;
	return (below / values.length) * 100;
}

function listModels(ctx: Ctx): string {
	const current = ctx.model;
	const from = price(current);
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

function recommendModels(ctx: Ctx, params: RecommendParams): string {
	const { snapshot, ageMs } = loadSnapshot();
	if (!snapshot) {
		refreshSnapshot();
		return `No benchmark snapshot yet at ${SNAPSHOT_PATH}. One is being fetched; try again in a moment.`;
	}
	if (ageMs === undefined || ageMs > SNAPSHOT_MAX_AGE_MS) refreshSnapshot();

	const benchmarks = CLASSES[params.class as string];
	const byKey = families(snapshot);
	const reachable = ctx.modelRegistry
		.getAvailable()
		.filter((model) => ctx.modelRegistry.hasConfiguredAuth(model));

	// Map every reachable model to a benchmark family once, and note the ones the
	// catalog does not carry rather than quietly ranking a shorter list.
	const scored: Array<{ model: (typeof reachable)[number]; score: number; present: number; family?: string }> = [];
	const unmapped: string[] = [];
	const uncovered: string[] = [];
	const raw = new Map<string, number[]>();
	for (const model of reachable) {
		const family = keys(model.id).map((key) => byKey.get(key)).find(Boolean);
		if (!family) {
			unmapped.push(`${model.provider}/${model.id}`);
			continue;
		}
		const present = benchmarks.filter((name) => family.benchmarks.has(name));
		// Any measurement counts, and how many fed the score is shown per row.
		// Requiring the whole set instead would drop the newest models, whose
		// catalog entries are the sparsest: claude-opus-5-5 has aa_hle but no
		// aa_gpqa, so a strict rule would hide the strongest science candidate.
		if (present.length === 0) {
			uncovered.push(`${model.provider}/${model.id}`);
			continue;
		}
		for (const name of present) {
			raw.set(name, [...(raw.get(name) ?? []), family.benchmarks.get(name) as number]);
		}
		scored.push({ model, score: 0, present: present.length });
	}

	for (const entry of scored) {
		const family = keys(entry.model.id).map((key) => byKey.get(key)).find(Boolean) as Family;
		const scores = benchmarks
			.filter((name) => family.benchmarks.has(name))
			.map((name) => percentile(raw.get(name) as number[], family.benchmarks.get(name) as number));
		entry.score = scores.reduce((total, value) => total + value, 0) / scores.length;
	}

	// The tier is relative to the models pi can actually reach, which is the
	// population the choice is made from.
	const ordered = [...scored].map((entry) => entry.score).sort((a, b) => a - b);
	const cutoffPercent = Math.min(100, Math.max(0, params.topPercent ?? 5));
	const cutoff = ordered[Math.min(ordered.length - 1, Math.floor((ordered.length * (100 - cutoffPercent)) / 100))] ?? 0;

	const from = price(ctx.model);
	const qualifying = scored
		.filter((entry) => entry.score >= cutoff)
		.filter((entry) => entry.model.contextWindow >= (params.minContext ?? 0))
		.filter((entry) => !params.needsImages || entry.model.input.includes("image"))
		.filter((entry) => !params.needsThinking || entry.model.reasoning)
		.sort((a, b) => (price(a.model) ?? Infinity) - (price(b.model) ?? Infinity));

	const cost = (model: (typeof reachable)[number]) =>
		model.cost?.input || model.cost?.output ? `$${model.cost.input}/$${model.cost.output}` : "unknown";
	const rows = qualifying.slice(0, 10).map((entry) => {
		const to = price(entry.model);
		const free = to !== undefined && from !== undefined && to <= from ? "yes" : "ask Josh";
		return `| ${entry.model.provider}/${entry.model.id} | ${entry.score.toFixed(0)} | ${entry.present}/${benchmarks.length} | ${cost(entry.model)} | ${k(entry.model.contextWindow)} | ${free} |`;
	});

	const snapshotDate = snapshot.generated_at?.slice(0, 10) ?? "unknown date";
	return [
		`${params.class} candidates: ${qualifying.length} of ${scored.length} reachable models clear the top ${cutoffPercent}% (score >= ${cutoff.toFixed(0)}).`,
		`Benchmarks: ${benchmarks.join(", ")}. Score is a percentile among reachable models, best recorded variant per family.`,
		`Snapshot: ${snapshotDate}${ageMs !== undefined && ageMs > SNAPSHOT_MAX_AGE_MS ? " (stale, refreshing)" : ""}. Price is pi's list price, which is what you are billed.`,
		"",
		"| Model | Score | Inputs | Price | Context | Switch freely |",
		"| --- | --- | --- | --- | --- | --- |",
		...(rows.length ? rows : ["| no model clears that tier with those constraints | | | | | |"]),
		...(unmapped.length ? ["", `${unmapped.length} reachable models have no benchmark data: ${unmapped.slice(0, 8).join(", ")}${unmapped.length > 8 ? ", …" : ""}`] : []),
		...(uncovered.length ? [`${uncovered.length} have none of these benchmarks: ${uncovered.slice(0, 8).join(", ")}${uncovered.length > 8 ? ", …" : ""}`] : []),
		...(qualifying.some((entry) => entry.present < benchmarks.length)
			? [`${qualifying.filter((entry) => entry.present < benchmarks.length).length} of these were scored on fewer than all of the class's benchmarks; the Inputs column says how many.`]
			: []),
	].join("\n");
}

type RecommendParams = {
	class?: string;
	topPercent?: number;
	minContext?: number;
	needsImages?: boolean;
	needsThinking?: boolean;
};

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
			"next model call and is recorded in the transcript. " +
			"With class: 'coding' (or agentic, science, long_context, general) it instead ranks the models pi can reach by " +
			"their percentile on that class's benchmarks, keeping only those in the requested top tier and meeting any " +
			"minContext, needsImages, or needsThinking constraint, cheapest first. Use that to choose a cheaper model for a " +
			"task rather than guessing; it ranks, it does not authorize a price rise.",
		parameters: Type.Object({
			list: Type.Optional(Type.Boolean({ description: "List available models instead of switching; other fields are ignored" })),
			class: Type.Optional(
				Type.Union(Object.keys(CLASSES).map((name) => Type.Literal(name)), {
					description:
						"Task class to rank by instead of switching: which reachable models clear a tier on that class's benchmarks",
				}),
			),
			topPercent: Type.Optional(Type.Number({ description: "Tier as a percentage of reachable models, best first (default 5)" })),
			minContext: Type.Optional(Type.Number({ description: "Only consider models with at least this many tokens of context" })),
			needsImages: Type.Optional(Type.Boolean({ description: "Only consider models that accept image input" })),
			needsThinking: Type.Optional(Type.Boolean({ description: "Only consider models that support thinking" })),
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
			if (params.class) return { content: [{ type: "text" as const, text: recommendModels(ctx, params) }], details: {} };
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
