import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Api, Model, AssistantMessage, ProviderResponse, ProviderStreams } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { createProvider, type MutableModels } from "@earendil-works/pi-ai/models";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { ProviderEnv } from "./models.ts";

const providerId = "shopify-router-openai";
// Keep the original provider ID so existing session model references keep working.
const transports: Record<string, ProviderStreams> = {
	"openai-responses": openAIResponsesApi(),
	"openai-completions": openAICompletionsApi(),
	"anthropic-messages": anthropicMessagesApi(),
	"google-generative-ai": googleGenerativeAIApi(),
};
type Endpoint = { path: string; api?: string };
type Entry = {
	id: string; name?: string; task?: string; overlay?: string;
	endpoints?: Endpoint[]; providers?: PriceRow[];
	capabilities?: { vision?: boolean; input_modalities?: string[]; reasoning?: boolean; reasoning_options?: Effort[] };
	limits?: Limits;
	router?: { apis?: Record<string, { limits?: Limits; reasoning_options?: Effort[] }> };
};
type Limits = { context_window: number; max_output_tokens: number };
type Effort = { type: string; values?: string[] };
const servedModelHeader = "shopify-auto-router-model";
const reasonHeader = "shopify-auto-router-reason";
const providerHeader = "x-shopify-proxy-provider";

type Price = { input: number; output: number; cached_input?: number; cache_write?: number; currency: string; unit_tokens: number };
type PriceRow = { provider_family?: string; pricing?: Price };
type Catalog = { data: Entry[] };

function header(headers: Record<string, string>, name: string): string | undefined {
	return Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1]?.trim();
}

export function priceRoutedMessage(message: AssistantMessage, headers: Record<string, string>, catalog: Catalog, requestedModel?: string): AssistantMessage {
	const served = header(headers, servedModelHeader) ?? (requestedModel?.startsWith("shopify/") ? undefined : requestedModel);
	if (!served) {
		console.error("panad: router did not identify the served model; cost is unknown");
		return message;
	}
	message.responseModel = served;
	if (header(headers, reasonHeader) === "cache_hit") {
		message.usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
		return message;
	}
	const rows = catalog.data.find((entry) => entry.id === served && !entry.overlay)?.providers?.filter((row) =>
		row.pricing?.currency === "USD" && Number.isFinite(row.pricing.unit_tokens) && row.pricing.unit_tokens > 0 &&
		Number.isFinite(row.pricing.input) && row.pricing.input >= 0 &&
		Number.isFinite(row.pricing.output) && row.pricing.output >= 0,
	) ?? [];
	const instance = header(headers, providerHeader)?.toLowerCase();
	const row = rows.filter((candidate) => candidate.provider_family && instance?.startsWith(candidate.provider_family.toLowerCase()))
		.sort((a, b) => (b.provider_family?.length ?? 0) - (a.provider_family?.length ?? 0))[0] ?? rows[0];
	if (!row?.pricing) {
		console.error(`panad: no USD price for routed model ${served}; cost is unknown`);
		return message;
	}
	const rate = row.pricing;
	const per = (tokens: number, price: number) => (tokens * price) / rate.unit_tokens;
	const input = per(message.usage.input, rate.input);
	const output = per(message.usage.output, rate.output);
	const cacheRead = per(message.usage.cacheRead, rate.cached_input ?? rate.input);
	const cacheWrite = per(message.usage.cacheWrite, rate.cache_write ?? rate.input);
	message.usage.cost = { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
	return message;
}

function pricedStream(source: AssistantMessageEventStream, getHeaders: () => Record<string, string>, catalogPath: string, requestedModel: string): AssistantMessageEventStream {
	const result = new AssistantMessageEventStream();
	void (async () => {
		for await (const event of source) {
			if (event.type === "done" || event.type === "error") {
				try {
					const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as Catalog;
					priceRoutedMessage(event.type === "done" ? event.message : event.error, getHeaders(), catalog, requestedModel);
				} catch (error) {
					console.error("panad: could not read router prices:", error instanceof Error ? error.message : String(error));
				}
			}
			result.push(event);
		}
		result.end(await source.result());
	})().catch((error) => {
		console.error("panad: router stream failed:", error instanceof Error ? error.message : String(error));
		result.end();
	});
	return result;
}

/** Register every catalog chat model, choosing a supported transport in preference order.
	* Embedding/audio/image-only entries have no agent chat transport and are excluded.
	* The catalog is a local snapshot; restart panad after refreshing it.
	*/
export function registerShopifyProvider(models: MutableModels, env: ProviderEnv): void {
	if (!env.SHOPIFY_PROXY_KEY?.trim()) return;
	const catalogPath = env.SHOPIFY_PI_LLM_CATALOG_PATH ?? join(homedir(), ".pi/agent/llm-catalog/catalog.json");
	const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as Catalog;
	if (!Array.isArray(catalog.data)) throw new Error("Invalid Shopify proxy catalog: data must be an array");
	const origin = env.SHOPIFY_PI_PROXY_ORIGIN ?? "https://proxy.shopify.ai";
	if (!/^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+shopify\.ai$/.test(origin)) {
		throw new Error("Refusing an untrusted Shopify AI Proxy origin");
	}
	const registered: Model<Api>[] = [];
	const ids = new Set<string>();
	for (const entry of catalog.data) {
		if (!entry.id || ids.has(entry.id) || (entry.task && entry.task !== "chat")) continue;
		const endpoint = ["openai-responses", "anthropic-messages", "openai-completions", "google-generate-content"]
			.flatMap(api => (entry.endpoints ?? []).filter(e => e.api === api && typeof e.path === "string"))
			.find(e => /^\/[a-zA-Z0-9/._:@-]+$/.test(e.path));
		if (!endpoint) continue;
		const api = endpoint.api === "google-generate-content" ? "google-generative-ai" : endpoint.api!;
		const routerApi = entry.router?.apis?.[endpoint.api!];
		const limits = routerApi?.limits ?? entry.limits;
		if (!Number.isSafeInteger(limits?.context_window) || limits!.context_window <= 0 ||
						!Number.isSafeInteger(limits?.max_output_tokens) || limits!.max_output_tokens <= 0) {
			throw new Error(`Missing chat limits for Shopify proxy model ${entry.id}`);
		}
		const efforts = (routerApi?.reasoning_options ?? entry.capabilities?.reasoning_options)
			?.find(option => option.type === "effort")?.values ?? [];
		const thinkingLevelMap = Object.fromEntries((["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const).map(level => {
			const value = level === "off" ? "none" : level;
			return [level, efforts.includes(value) ? value : null];
		}));
		const suffix = api === "openai-responses" ? "/responses" : api === "openai-completions" ? "/chat/completions" : api === "anthropic-messages" ? "/v1/messages" : `/models/${entry.id}:generateContent`;
		if (!endpoint.path.endsWith(suffix)) throw new Error(`Unexpected ${api} endpoint for ${entry.id}`);
		const rate = entry.providers?.find(row => row.pricing?.currency === "USD" && row.pricing.unit_tokens > 0)?.pricing;
		const perMillion = (value: number | undefined) => rate ? ((value ?? rate.input) * 1_000_000) / rate.unit_tokens : 0;
		registered.push({
			id: entry.id, name: entry.name ?? entry.id, provider: providerId, api,
			baseUrl: origin + endpoint.path.slice(0, -suffix.length),
			reasoning: efforts.some(value => value !== "none") || entry.capabilities?.reasoning === true,
			...(efforts.length ? { thinkingLevelMap } : {}),
			...(api === "anthropic-messages" && efforts.length ? { compat: { forceAdaptiveThinking: true } } : {}),
			input: entry.capabilities?.vision || entry.capabilities?.input_modalities?.includes("image") ? ["text", "image"] : ["text"],
			cost: { input: perMillion(rate?.input), output: perMillion(rate?.output), cacheRead: perMillion(rate?.cached_input), cacheWrite: perMillion(rate?.cache_write) },
			contextWindow: limits!.context_window, maxTokens: limits!.max_output_tokens,
		});
		ids.add(entry.id);
	}

	const routedApi: ProviderStreams = {
		stream(model, context, options) {
			let headers: Record<string, string> = {};
			const source = transports[model.api]!.stream(model, context, {
				...options,
				headers: { ...options?.headers, Authorization: `Bearer ${options?.apiKey}` },
				onResponse: async (response: ProviderResponse, responseModel) => {
					headers = response.headers;
					await options?.onResponse?.(response, responseModel);
				},
			});
			return pricedStream(source, () => headers, catalogPath, model.id);
		},
		streamSimple(model, context, options) {
			let headers: Record<string, string> = {};
			const source = transports[model.api]!.streamSimple(model, context, {
				...options,
				headers: { ...options?.headers, Authorization: `Bearer ${options?.apiKey}` },
				onResponse: async (response: ProviderResponse, responseModel) => {
					headers = response.headers;
					await options?.onResponse?.(response, responseModel);
				},
			});
			return pricedStream(source, () => headers, catalogPath, model.id);
		},
	};

	models.setProvider(createProvider({
		id: providerId,
		baseUrl: origin,
		auth: { apiKey: {
			name: "Shopify AI Proxy key",
			check: async ({ ctx }) => (await ctx.env("SHOPIFY_PROXY_KEY")) ? { source: "SHOPIFY_PROXY_KEY", type: "api_key" } : undefined,
			resolve: async ({ ctx }) => {
				const key = await ctx.env("SHOPIFY_PROXY_KEY");
				return key ? { auth: { apiKey: key }, source: "SHOPIFY_PROXY_KEY" } : undefined;
			},
		} },
		models: registered,
		api: routedApi,
	}));
}
