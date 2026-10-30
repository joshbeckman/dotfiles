import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { LiveDoc, type ConversationId } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { panaSettings } from "../src/server/index.ts";
import { sessionRuntime } from "../src/sessions/index.ts";
import { startTestPanad, type Script, type TestPanad } from "./harness/index.ts";

let t: TestPanad | undefined;
afterEach(async () => { await t?.close(); t = undefined; });

async function start(script: Script) {
	t = await startTestPanad({
		script,
		config: { defaultModel: "faux/faux-1" },
		// Override the test harness's zero retries, using the actual panad defaults.
		settings: { retry: {} },
	});
	const created = await t.client.post<{ session: { id: string; conversationId: number }; thread: { id: string } }>("/sessions", { prompt: "go" });
	expect(created.status).toBe(201);
	return created.body;
}

async function live(id: number) {
	return t!.runtime.harness.snapshot(LiveDoc, id as ConversationId, ctx);
}

async function waiting(id: number, attempt: number) {
	await vi.waitFor(async () => {
		const state = await live(id);
		expect(state?.generation?.attempt).toBe(attempt);
		expect(state?.generation?.retry).toBeDefined();
	}, { timeout: 4000, interval: 5 });
	return (await live(id))!.generation!.retry!;
}

async function settled(id: string, state: string) {
	await vi.waitFor(async () => {
		await sessionRuntime(t!.runtime).idle();
		const shown = await t!.client.get<{ session: { state: string } }>(`/sessions/${id}`);
		expect(shown.body.session.state).toBe(state);
	}, { timeout: 4000, interval: 5 });
}

async function messages(thread: string) {
	return t!.runtime.db.all<{ body: string }>("SELECT body FROM messages WHERE thread_id = ? ORDER BY seq", thread);
}

function delay(attempt: number) { return Math.min(2000 * 2 ** (attempt - 1), 60_000); }

it("STA-08 supplies sixteen attempts by default and preserves live settings overrides", () => {
	let retry = { maxRetries: 2, baseDelayMs: 12 };
	const settings = panaSettings({ get retry() { return retry; } });
	expect(panaSettings().retry).toEqual({ enabled: true, maxRetries: 15, baseDelayMs: 2000, maxAgentDelayMs: 60_000 });
	expect(settings.retry).toMatchObject({ maxRetries: 2, baseDelayMs: 12, maxAgentDelayMs: 60_000 });
	retry = { maxRetries: 0, baseDelayMs: 25 };
	expect(settings.retry).toMatchObject({ maxRetries: 0, baseDelayMs: 25 });
	expect(panaSettings({ retry: { enabled: false } }).retry?.enabled).toBe(false);
});

describe("STA-08 bounded durable model retries", () => {
	it.each(["503 service unavailable", 'API error (401): 401 "AuthenticationError"'])("allows success on attempt sixteen after %s", async (failure) => {
		const { session, thread } = await start([...Array.from({ length: 15 }, () => ({ fail: failure })), { text: "recovered" }]);
		for (let attempt = 1; attempt <= 15; attempt++) {
			const retry = await waiting(session.conversationId, attempt);
			expect(t!.model.calls()).toBe(attempt);
			expect(retry.at - t!.clock.now()).toBe(delay(attempt));
			expect(retry.error).toContain(failure);
			expect(await messages(thread.id)).toHaveLength(1); // No premature failure notices.
			await t!.clock.advance(delay(attempt) - 1);
			expect(t!.model.calls()).toBe(attempt);
			await t!.clock.advance(1);
		}
		await settled(session.id, "idle");
		expect(t!.model.calls()).toBe(16);
		expect((await messages(thread.id)).map((m) => m.body)).toEqual(["go", "recovered"]);
	});

	it("exhausts one shared sixteen-attempt budget across transient and auth errors", async () => {
		const { session, thread } = await start([
			...Array.from({ length: 16 }, (_, i) => ({ fail: i % 2 ? "401 AuthenticationError" : "503 overloaded" })),
			{ text: "must not run" },
		]);
		for (let attempt = 1; attempt <= 15; attempt++) {
			await waiting(session.conversationId, attempt);
			await t!.clock.advance(delay(attempt));
		}
		await settled(session.id, "failed");
		expect(t!.model.calls()).toBe(16);
		expect(t!.model.remaining()).toBe(1);
		const notices = await messages(thread.id);
		expect(notices).toHaveLength(2);
		expect(notices[1]!.body).toContain("401 AuthenticationError");
		await t!.clock.advance(3_600_000);
		expect(t!.model.calls()).toBe(16); // No outer session retry loop.
	});

	it.each(["403 Forbidden", "400 malformed request", "401 billing quota exceeded", "401 quota exhausted", "401 quota_exceeded", "401 insufficient balance"])("does not retry %s", async (failure) => {
		const { session } = await start([{ fail: failure }, { text: "must not run" }]);
		await settled(session.id, "failed");
		expect(t!.model.calls()).toBe(1);
	});

	it("keeps the auth backoff and attempt budget across a daemon restart", async () => {
		const { session } = await start([{ fail: "401 AuthenticationError" }, { fail: "401 AuthenticationError" }, { text: "recovered" }]);
		const retry = await waiting(session.conversationId, 1);
		const previous = t!;
		await previous.clock.advance(1000);
		await previous.stop();
		t = await startTestPanad({ stateDir: previous.dir, clock: previous.clock, model: previous.model, settings: { retry: {} } });
		expect((await waiting(session.conversationId, 1)).at).toBe(retry.at);
		await t.clock.advance(999);
		expect(t.model.calls()).toBe(1);
		await t.clock.advance(1);
		const second = await waiting(session.conversationId, 2);
		expect(second.at - t.clock.now()).toBe(4000);
		await t.clock.advance(4000);
		await settled(session.id, "idle");
		expect(t.model.calls()).toBe(3);
	});

	it("stopping during auth backoff cancels the pending retry", async () => {
		const { session } = await start([{ fail: "401 AuthenticationError" }, { text: "must not run" }]);
		await waiting(session.conversationId, 1);
		expect((await t!.client.post(`/sessions/${session.id}/stop`)).status).toBe(200);
		await t!.clock.advance(3_600_000);
		await settled(session.id, "stopped");
		expect(t!.model.calls()).toBe(1);
	});
});
