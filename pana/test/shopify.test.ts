import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createProviderModels } from "../src/server/models.ts";
import { priceRoutedMessage } from "../src/server/shopify.ts";

const dirs: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const limits = { context_window: 100000, max_output_tokens: 10000 };
const pricing = { input: 0.08, output: 0.4, cached_input: 0.008, cache_write: 0.1, currency: "USD", unit_tokens: 1000000 };
function entry(id: string, api: string, path: string) {
	return { id, task: "chat", endpoints: [{ api, path }], limits, providers: [{ provider_family: "azure", pricing }] };
}
async function load(data: unknown[], extra: Record<string, string> = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pana-shopify-")); dirs.push(dir);
	const path = join(dir, "catalog.json"); writeFileSync(path, JSON.stringify({ data }));
	return createProviderModels({ SHOPIFY_PROXY_KEY: "test-not-a-real-key", SHOPIFY_PI_LLM_CATALOG_PATH: path, ...extra });
}
const luna = entry("gpt-6-luna", "openai-responses", "/v1/responses");

describe("Shopify proxy catalog", () => {
	it("registers all chat transports and preserves existing router references", async () => {
		const models = await load([
			luna,
			entry("shopify/auto-best", "openai-responses", "/v1/responses"),
			entry("claude", "anthropic-messages", "/apis/anthropic/v1/messages"),
			entry("gemini", "openai-completions", "/v1/chat/completions"),
			entry("shopify-auto", "google-generate-content", "/apis/google/v1/models/shopify-auto:generateContent"),
		]);
		expect(models.getModels("shopify-router-openai")).toHaveLength(5);
		expect(models.getModel("shopify-router-openai", "gpt-6-luna")).toMatchObject({ api: "openai-responses", baseUrl: "https://proxy.shopify.ai/v1", cost: { input: 0.08, output: 0.4 } });
		expect(models.getModel("shopify-router-openai", "claude")).toMatchObject({ api: "anthropic-messages", baseUrl: "https://proxy.shopify.ai/apis/anthropic" });
		expect(models.getModel("shopify-router-openai", "shopify-auto")).toMatchObject({ api: "google-generative-ai", baseUrl: "https://proxy.shopify.ai/apis/google/v1" });
		expect(await models.getAuth("shopify-router-openai")).toBeDefined();
	});
	it("dispatches authenticated requests to each exact catalog endpoint", async () => {
		const entries = [luna,
			entry("claude", "anthropic-messages", "/apis/anthropic/v1/messages"),
			entry("gemini", "openai-completions", "/v1/chat/completions"),
			entry("shopify-auto", "google-generate-content", "/apis/google/v1/models/shopify-auto:generateContent"),
		];
		const requests: Array<{ url: string; headers: Headers }> = [];
		vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
			requests.push({ url: input instanceof Request ? input.url : String(input), headers: new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)) });
			return new Response(JSON.stringify({ error: { message: "synthetic failure", type: "invalid_request_error" } }), { status: 400, headers: { "Content-Type": "application/json" } });
		});
		const models = await load(entries);
		for (const entry of entries) {
			const result = await models.completeSimple(models.getModel("shopify-router-openai", entry.id)!, {
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
			});
			expect(result.stopReason).toBe("error");
			const request = requests.at(-1)!;
			const url = new URL(request.url);
			const expectedPath = entry.id === "shopify-auto" ? "/apis/google/v1/models/shopify-auto:streamGenerateContent" : entry.endpoints[0]!.path;
			expect(url.origin + url.pathname).toBe("https://proxy.shopify.ai" + expectedPath);
			expect(request.headers.get("Authorization")).toBe("Bearer test-not-a-real-key");
		}
		expect(requests).toHaveLength(4);
	});

	it("prefers responses, maps catalog reasoning, vision and router-specific limits", async () => {
		const models = await load([{ ...luna,
			endpoints: [{ api: "openai-completions", path: "/v1/chat/completions" }, ...luna.endpoints],
			capabilities: { input_modalities: ["text", "image"], reasoning_options: [{ type: "effort", values: ["none", "low", "high"] }] },
		}, { ...entry("shopify/auto-best", "openai-responses", "/v1/responses"), limits: undefined,
			router: { apis: { "openai-responses": { limits } } },
		}]);
		expect(models.getModel("shopify-router-openai", "gpt-6-luna")).toMatchObject({ api: "openai-responses", input: ["text", "image"], reasoning: true, thinkingLevelMap: { off: "none", low: "low", medium: null, high: "high" } });
		expect(models.getModel("shopify-router-openai", "shopify/auto-best")?.contextWindow).toBe(100000);
	});
	it("excludes non-chat tasks and unsupported endpoints and deduplicates IDs", async () => {
		const models = await load([luna, luna, { ...luna, id: "image", task: "images" }, entry("unsupported", "other", "/v1/other")]);
		expect(models.getModels("shopify-router-openai").map(m => m.id)).toEqual(["gpt-6-luna"]);
	});
	it("does not require a catalog without a proxy key", async () => {
		const models = await createProviderModels({ SHOPIFY_PI_LLM_CATALOG_PATH: "/does/not/exist" });
		expect(models.getProvider("shopify-router-openai")).toBeUndefined();
	});
	it("rejects untrusted origins, malformed limits and endpoint suffixes", async () => {
		await expect(load([luna], { SHOPIFY_PI_PROXY_ORIGIN: "https://evil.example" })).rejects.toThrow("untrusted");
		await expect(load([{ ...luna, limits: { context_window: 0, max_output_tokens: 1 } }])).rejects.toThrow("Missing chat limits");
		await expect(load([entry("bad", "openai-responses", "/v1/not-responses")])).rejects.toThrow("Unexpected");
	});
});

function message(): AssistantMessage {
	return { role: "assistant", api: "openai-responses", provider: "shopify-router-openai", model: "shopify/auto-best", content: [], stopReason: "stop", timestamp: Date.now(), usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 20, totalTokens: 180, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
describe("Shopify usage pricing", () => {
	it("prices direct models without router headers", () => {
		const result = priceRoutedMessage(message(), {}, { data: [luna] }, "gpt-6-luna");
		expect(result.responseModel).toBe("gpt-6-luna");
		expect(result.usage.cost.total).toBeCloseTo(0.00003008);
	});
	it("uses served model and provider prices instead of the requested router", () => {
		const catalog = { data: [{ ...luna, providers: [...luna.providers, { provider_family: "bedrock", pricing: { ...pricing, input: 1 } }] }] };
		const result = priceRoutedMessage(message(), { "Shopify-Auto-Router-Model": "gpt-6-luna", "X-Shopify-Proxy-Provider": "bedrock-us" }, catalog, "shopify/auto-best");
		expect(result.responseModel).toBe("gpt-6-luna");
		expect(result.usage.cost.input).toBe(0.0001);
	});
	it("makes proxy cache hits free", () => {
		const result = priceRoutedMessage(message(), { "shopify-auto-router-model": "gpt-6-luna", "shopify-auto-router-reason": "cache_hit" }, { data: [luna] });
		expect(result.usage.cost.total).toBe(0);
	});
});
