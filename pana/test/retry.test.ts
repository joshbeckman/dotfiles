import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage, AssistantMessageEvent, DeferredHandle } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { withAuthRetries } from "../src/server/retry.ts";

const hint = "(please retry your request)";
const faux = fauxProvider();
const provider = faux.provider;
const model = faux.models[0];
const context = { messages: [] };
const handle = {} as DeferredHandle;
function failure(text = "401 AuthenticationError: rejected"): AssistantMessage {
	return fauxAssistantMessage([], { stopReason: "error", errorMessage: text });
}
function fixture(message = failure()) {
	const models = createModels();
	models.setProvider(provider);
	const source = createAssistantMessageEventStream();
	const stream = vi.fn(function (this: unknown) {
		expect(this).toBe(models);
		return source;
	});
	const complete = vi.fn(async function (this: unknown) {
		expect(this).toBe(models);
		return message;
	});
	Object.assign(models, {
		stream, streamSimple: stream, streamDeferred: stream,
		complete, completeSimple: complete, fetchDeferred: complete,
	});
	return { models, wrapped: withAuthRetries(models), source, stream, complete, message };
}

const streamCalls = {
	stream: (models: ReturnType<typeof withAuthRetries>) => models.stream(model, context),
	streamSimple: (models: ReturnType<typeof withAuthRetries>) => models.streamSimple(model, context),
	streamDeferred: (models: ReturnType<typeof withAuthRetries>) => models.streamDeferred(model, handle),
};
const completeCalls = {
	complete: (models: ReturnType<typeof withAuthRetries>) => models.complete(model, context),
	completeSimple: (models: ReturnType<typeof withAuthRetries>) => models.completeSimple(model, context),
	fetchDeferred: (models: ReturnType<typeof withAuthRetries>) => models.fetchDeferred(model, handle),
};

describe("withAuthRetries", () => {
	it.each(Object.entries(streamCalls))("annotates %s terminal events and results consistently", async (_name, call) => {
		const { wrapped, source, message, stream } = fixture();
		const partial: AssistantMessageEvent = { type: "start", partial: message };
		source.push(partial);
		source.push({ type: "error", reason: "error", error: message });
		const adapted = call(wrapped);
		const result = await adapted.result(); // result-only consumers do not need iteration
		const events = [];
		for await (const event of adapted) events.push(event);
		expect(events[0]).toBe(partial);
		expect(events[1]).toEqual({ type: "error", reason: "error", error: result });
		expect(events[1]?.type === "error" && events[1].error).toBe(result);
		expect(result).toEqual({ ...message, errorMessage: `${message.errorMessage} ${hint}` });
		expect(message.errorMessage).not.toContain(hint);
		expect(isRetryableAssistantError(result)).toBe(true);
		expect(stream).toHaveBeenCalledTimes(1);
		expect(stream).toHaveBeenCalledWith(model, _name === "streamDeferred" ? handle : context);
	});

	it.each(Object.entries(completeCalls))("annotates %s without calling a second model", async (_name, call) => {
		const { wrapped, message, complete, stream } = fixture();
		const result = await call(wrapped);
		expect(result.errorMessage).toBe(`${message.errorMessage} ${hint}`);
		expect(complete).toHaveBeenCalledTimes(1);
		expect(complete).toHaveBeenCalledWith(model, _name === "fetchDeferred" ? handle : context);
		expect(stream).not.toHaveBeenCalled();
	});

	it.each([
		"HTTP 401", "AuthenticationError: rejected", "Unauthorized", "invalid API key",
		"API key is invalid", "invalid_api_key", "expired token", "access token has expired",
		"token is expired", "token_expired", "expired access token",
	])("recognizes narrow authentication failure: %s", async (text) => {
		const { wrapped } = fixture(failure(text));
		const result = await wrapped.completeSimple(model, context);
		expect(result.errorMessage).toBe(`${text} ${hint}`);
		expect(isRetryableAssistantError(result)).toBe(true);
	});

	it.each([
		"HTTP 403 Unauthorized", "403 AuthenticationError", "request abc401def failed", "request 1401 failed",
		"invalid request", "Provider is not configured", "authentication configuration missing",
		"401 insufficient_quota", "401 quota exceeded", "AuthenticationError: billing exhausted",
		"401 FreeUsageLimitError", "401 out of budget", `401 ${hint}`,
	])("leaves non-auth, forbidden, quota, or already annotated errors unchanged: %s", async (text) => {
		const message = failure(text);
		const { wrapped } = fixture(message);
		expect(await wrapped.completeSimple(model, context)).toBe(message);
	});

	it.each([
		"401 quota exhausted", "401 quota_exceeded", "401 insufficient balance",
		"AuthenticationError: insufficient_credits", "401 balance depleted", "401 credits_exhausted",
	])("does not introduce retries for account-limit wording: %s", async (text) => {
		const message = failure(text);
		expect(isRetryableAssistantError(message)).toBe(false);
		const { wrapped } = fixture(message);
		const result = await wrapped.completeSimple(model, context);
		expect(result).toBe(message);
		expect(isRetryableAssistantError(result)).toBe(false);
	});

	it("leaves unrelated terminal errors untouched and forwards request options", async () => {
		const { wrapped, source, message, stream } = fixture(failure("invalid request"));
		const terminal: AssistantMessageEvent = { type: "error", reason: "error", error: message };
		source.push(terminal);
		const options = { signal: new AbortController().signal, maxTokens: 123 };
		const adapted = wrapped.streamSimple(model, context, options);
		for await (const event of adapted) expect(event).toBe(terminal);
		expect(await adapted.result()).toBe(message);
		expect(stream).toHaveBeenCalledWith(model, context, options);
	});

	it.each(["stop", "aborted"] as const)("leaves %s messages and events untouched", async (stopReason) => {
		const message = { ...failure(), stopReason };
		const { wrapped, source } = fixture(message);
		const terminal: AssistantMessageEvent = stopReason === "aborted"
			? { type: "error", reason: "aborted", error: message }
			: { type: "done", reason: "stop", message };
		source.push(terminal);
		const adapted = wrapped.streamSimple(model, context);
		for await (const event of adapted) expect(event).toBe(terminal);
		expect(await adapted.result()).toBe(message);
	});

	it("does not duplicate guidance when decorated twice", async () => {
		const { wrapped } = fixture();
		const result = await withAuthRetries(wrapped).completeSimple(model, context);
		expect(result.errorMessage?.split(hint)).toHaveLength(2);
	});

	it("supports spying on and replacing the adapter's own methods", async () => {
		const { models, wrapped, complete } = fixture();
		const replacement = failure("replacement");
		const spy = vi.spyOn(wrapped, "completeSimple").mockResolvedValue(replacement);
		expect(await wrapped.completeSimple(model, context)).toBe(replacement);
		expect(spy).toHaveBeenCalledTimes(1);
		expect(models.completeSimple).toBe(complete);
		expect(complete).not.toHaveBeenCalled();
		spy.mockRestore();
		expect((await wrapped.completeSimple(model, context)).errorMessage).toContain(hint);
	});

	it("binds delegated methods to the underlying Models", () => {
		const { models, wrapped } = fixture();
		const getModel = wrapped.getModel;
		expect(getModel(provider.id, model.id)).toBe(models.getModel(provider.id, model.id));
		expect(wrapped.getProviders()).toEqual([provider]);
	});

	it("is lazy and propagates iterator and result rejections without a detached pump", async () => {
		const { wrapped, source } = fixture();
		const error = new Error("source failed");
		let consumed = false;
		Object.assign(source, {
			async *[Symbol.asyncIterator]() { consumed = true; throw error; },
			result: async () => { throw error; },
		});
		const adapted = wrapped.streamSimple(model, context);
		expect(consumed).toBe(false);
		await expect(adapted.result()).rejects.toBe(error);
		expect(consumed).toBe(false);
		await expect(adapted[Symbol.asyncIterator]().next()).rejects.toBe(error);
	});

	it("closes the underlying iterator when a consumer stops early", async () => {
		const { wrapped, source, message } = fixture();
		let closed = false;
		Object.assign(source, {
			async *[Symbol.asyncIterator]() {
				try { yield { type: "start", partial: message } as AssistantMessageEvent; }
				finally { closed = true; }
			},
		});
		for await (const _event of wrapped.streamSimple(model, context)) break;
		expect(closed).toBe(true);
	});
});
