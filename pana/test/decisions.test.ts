// WP23: the decision model and the wake gate (DEC-01..DEC-09).
//
// The decision transport is faked the way push is (`setDecisionTransport`), so no test reaches
// the network or needs a key. A gated message is a message from one session to another; the user's
// own mail is never gated.

import { readFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/config/index.ts";
import { DECISION_TIMEOUT_MS, SYSTEM_ONE_PATH, decide, setDecisionTransport, type DecisionRequest } from "../src/decisions/index.ts";
import { WAKE_GATE_THRESHOLD, WAKE_QUESTION } from "../src/decisions/gate.ts";
import { sweepWakes } from "../src/db/outbox.ts";
import { sessionRuntime } from "../src/sessions/index.ts";
import type { Runtime } from "../src/server/runtime.ts";
import { startTestPanad, type TestPanad } from "./harness/index.ts";

let t: TestPanad | undefined;
afterEach(async () => {
	await t?.close();
	t = undefined;
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Created {
	session: { id: string; conversationId: number };
	thread: { id: string };
}

async function start(config: Record<string, unknown> = {}, turns = 8): Promise<TestPanad> {
	t = await startTestPanad({
		script: Array.from({ length: turns }, () => ({ text: "ok" })),
		config: { defaultModel: "faux/faux-1", timezone: "UTC", ...config },
	});
	return t;
}

async function settled(sessionId: string): Promise<string> {
	for (let i = 0; i < 400; i++) {
		await t!.clock.settle();
		await sessionRuntime(t!.runtime).idle();
		const row = await t!.runtime.db.get<{ state: string }>("SELECT state FROM sessions WHERE id = ?", sessionId);
		if (row && row.state !== "running" && row.state !== "waiting") return row.state;
		await sleep(5);
	}
	throw new Error(`session ${sessionId} never settled`);
}

/** A real session whose first run has answered. */
async function session(prompt: string): Promise<Created> {
	const created = await t!.client.post<Created>("/sessions", { prompt });
	expect(created.status, JSON.stringify(created.body)).toBe(201);
	await settled(created.body.session.id);
	return created.body;
}

async function head(threadId: string): Promise<string> {
	const row = await t!.runtime.db.get<{ id: string }>("SELECT id FROM messages WHERE thread_id = ? ORDER BY seq DESC LIMIT 1", threadId);
	return row!.id;
}

/** Make `joiner` a participant of `host`'s thread, as the user's message. */
async function addToThread(host: Created, joiner: Created): Promise<void> {
	const res = await t!.client.post(`/threads/${host.thread.id}/messages`, { after: await head(host.thread.id), body: "meet", cc: [joiner.session.id] });
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	await settled(joiner.session.id);
	await settled(host.session.id);
}

/** A session's reply in a thread, the path the wake gate sits on. */
async function replyAs(threadId: string, sessionId: string, body: string) {
	const res = await t!.client.post<{ message: { id: string } }>(
		`/threads/${threadId}/messages`,
		{ after: await head(threadId), body },
		{ caller: sessionId },
	);
	return res;
}

/**
 * Answer the wake gate with `probability`, and the push gate with 1 so it keeps out of the way. The
 * counter counts wake questions only: these tests are about the wake gate, and every delivery to
 * the user now also carries a push question (PSH-06).
 */
function answer(probability: number): { calls: number } {
	const counter = { calls: 0 };
	setDecisionTransport(t!.runtime, async (request) => {
		const answers: Record<string, { type: "noul"; noul: number }> = {};
		for (const name of Object.keys(request.questions)) {
			answers[name] = { type: "noul", noul: name === WAKE_QUESTION ? probability : 1 };
		}
		if (WAKE_QUESTION in request.questions) counter.calls++;
		return { answers };
	});
	return counter;
}

interface DeliveryRow {
	read_at: number | null;
	wake_request_id: string | null;
	wake_submission_id: number | null;
}

async function delivery(messageId: string, recipientId: string): Promise<DeliveryRow | undefined> {
	return t!.runtime.db.get<DeliveryRow>(
		"SELECT read_at, wake_request_id, wake_submission_id FROM deliveries WHERE message_id = ? AND recipient_id = ?",
		messageId,
		recipientId,
	);
}

async function stateOf(sessionId: string): Promise<string> {
	return (await t!.runtime.db.get<{ state: string }>("SELECT state FROM sessions WHERE id = ?", sessionId))!.state;
}

/** Every gate line in the state directory, oldest first; a missing file is no lines yet. */
function gateLines(): Array<{ event: string; messageId?: string; probability?: number; decision?: string; error?: string }> {
	try {
		return readFileSync(joinPath(t!.dir, "decisions.log"), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	} catch {
		return [];
	}
}

/**
 * The gate lines for one message. A session's own end-of-run answer is a message from a session
 * too, so the thread carries other decisions beside the one a test posted.
 */
function gateLinesFor(messageId: string) {
	return gateLines().filter((line) => line.event === "wake.gate" && line.messageId === messageId);
}

describe("DEC-01 decisionModel configuration", () => {
	it("DEC-01 decisionModel is an optional nonempty model reference string and is unset by default", () => {
		const bare = parseConfig({ domain: "test.example", user: "tester" });
		expect(bare.decisionModel).toBeUndefined();
		expect(parseConfig({ domain: "test.example", user: "tester", decisionModel: "fireworks/accounts/fireworks/models/rune" }).decisionModel)
			.toBe("fireworks/accounts/fireworks/models/rune");
		expect(() => parseConfig({ domain: "test.example", user: "tester", decisionModel: "" })).toThrow(/decisionModel/);
		expect(() => parseConfig({ domain: "test.example", user: "tester", decisionModel: 7 })).toThrow(/decisionModel/);
	});

	it("DEC-01 an unset decisionModel changes nothing: the message wakes and no decision is asked", async () => {
		await start();
		const a = await session("watch");
		const b = await session("wait");
		await addToThread(a, b);
		const asked = answer(0.01);

		const sent = await replyAs(a.thread.id, b.session.id, "Thanks!");
		expect(sent.status, JSON.stringify(sent.body)).toBe(200);
		await settled(a.session.id);

		const row = await delivery(sent.body.message.id, a.session.id);
		expect(row?.wake_submission_id).not.toBeNull();
		expect(asked.calls).toBe(0);
		expect(gateLines()).toEqual([]);
	});
});

describe("DEC-02 the decision client", () => {
	it("DEC-02 decide posts to <baseUrl>/v1/systemone with the model, state, and noul questions", async () => {
		const runtime = {
			config: { decisionModel: "fireworks/accounts/fireworks/models/rune" },
			models: {
				getProvider: (id: string) => (id === "fireworks" ? { id: "fireworks", baseUrl: "https://api.fireworks.ai/inference" } : undefined),
				getAuth: async () => ({ auth: { apiKey: "fk-auth" } }),
			},
			clock: { now: () => 0, setTimer: () => () => {} },
		} as unknown as Runtime;
		const sent: Array<{ url: string; init: RequestInit }> = [];
		vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
			sent.push({ url, init });
			return new Response(JSON.stringify({ answers: { q: { type: "noul", noul: 0.42 } } }), { status: 200 });
		});

		const answers = await decide(runtime, "a rendered delivery", { q: { type: "noul", instructions: "does it need action?" } });

		expect(answers).toEqual({ q: 0.42 });
		expect(sent).toHaveLength(1);
		// The provider base URL stops at the API root, and the native protocol lives under /v1:
		// `/inference/systemone` is a 404 on the live API, `/inference/v1/systemone` answers.
		expect(sent[0]!.url).toBe("https://api.fireworks.ai/inference/v1/systemone");
		expect(sent[0]!.url).toBe(`https://api.fireworks.ai/inference${SYSTEM_ONE_PATH}`);
		expect(sent[0]!.init.headers).toMatchObject({ authorization: "Bearer fk-auth" });
		expect(JSON.parse(String(sent[0]!.init.body))).toMatchObject({
			model: "accounts/fireworks/models/rune",
			state: "a rendered delivery",
			questions: { q: { type: "noul", instructions: "does it need action?" } },
		});
	});

	it("DEC-02 decide falls back to the provider key in panad's environment", async () => {
		const runtime = {
			config: { decisionModel: "fireworks/rune" },
			models: {
				getProvider: () => ({ id: "fireworks", baseUrl: "https://api.fireworks.ai/inference/" }),
				getAuth: async () => undefined,
			},
			clock: { now: () => 0, setTimer: () => () => {} },
		} as unknown as Runtime;
		vi.stubEnv("FIREWORKS_API_KEY", "fk-env");
		const headers: unknown[] = [];
		vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
			headers.push(init.headers);
			return new Response(JSON.stringify({ answers: { q: { type: "noul", noul: 0.1 } } }), { status: 200 });
		});

		expect(await decide(runtime, "state", { q: { type: "noul", instructions: "?" } })).toEqual({ q: 0.1 });
		expect(headers[0]).toMatchObject({ authorization: "Bearer fk-env" });
	});

	it("DEC-02 an unset or unknown decisionModel is a typed error and a malformed answer fails", async () => {
		const missing = { config: {}, models: { getProvider: () => undefined }, clock: { now: () => 0, setTimer: () => () => {} } } as unknown as Runtime;
		await expect(decide(missing, "s", { q: { type: "noul", instructions: "?" } })).rejects.toMatchObject({ code: "no_decision_model" });

		const unknown = {
			config: { decisionModel: "nope/rune" },
			models: { getProvider: () => undefined },
			clock: { now: () => 0, setTimer: () => () => {} },
		} as unknown as Runtime;
		await expect(decide(unknown, "s", { q: { type: "noul", instructions: "?" } })).rejects.toMatchObject({ code: "unknown_model" });

		const runtime = {
			config: { decisionModel: "faux/rune" },
			models: { getProvider: () => ({ id: "faux" }) },
			clock: { now: () => 0, setTimer: () => () => {} },
		} as unknown as Runtime;
		setDecisionTransport(runtime, async () => ({ answers: {} }));
		await expect(decide(runtime, "s", { q: { type: "noul", instructions: "?" } })).rejects.toMatchObject({ code: "decision_failed" });
	});
});

describe("DEC-04 the probability threshold", () => {
	it("DEC-04 a low probability skips the wake while the mail stays unread and queued", async () => {
		await start({ decisionModel: "faux/rune" });
		const a = await session("watch");
		const b = await session("wait");
		await addToThread(a, b);
		const asked = answer(WAKE_GATE_THRESHOLD / 2);

		const sent = await replyAs(a.thread.id, b.session.id, "Acknowledged, thanks!");
		expect(sent.status, JSON.stringify(sent.body)).toBe(200);
		await t!.clock.settle();
		await sessionRuntime(t!.runtime).idle();

		expect(asked.calls).toBe(1);
		expect(await delivery(sent.body.message.id, a.session.id)).toEqual({ read_at: null, wake_request_id: null, wake_submission_id: null });
		expect(await stateOf(a.session.id)).toBe("idle");
		const inbox = await t!.client.get<{ unreadTotal: number }>("/inbox", { caller: a.session.id });
		expect(inbox.body.unreadTotal).toBe(1);
		// DEC-08: one line per decision, with the probability.
		const lines = gateLinesFor(sent.body.message.id);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({ probability: WAKE_GATE_THRESHOLD / 2, decision: "skip" });
	});

	it("DEC-04 a high probability wakes as before", async () => {
		await start({ decisionModel: "faux/rune" });
		const a = await session("watch");
		const b = await session("wait");
		await addToThread(a, b);
		answer(0.9);

		const sent = await replyAs(a.thread.id, b.session.id, "Please review PR 75 before Friday.");
		expect(sent.status, JSON.stringify(sent.body)).toBe(200);
		await settled(a.session.id);

		const row = await delivery(sent.body.message.id, a.session.id);
		expect(row?.wake_submission_id).not.toBeNull();
		expect(gateLinesFor(sent.body.message.id)).toEqual([expect.objectContaining({ probability: 0.9, decision: "wake" })]);
	});
});

describe("DEC-05 what is never gated", () => {
	it("DEC-05 an objective lead's wake is never gated", async () => {
		await start({ decisionModel: "faux/rune" });
		const a = await session("lead");
		const b = await session("wait");
		await addToThread(a, b);
		// The lead's wake carries its briefing (OBJ-32), so a low answer must not skip it.
		await t!.runtime.db.write(async (tx) => {
			await tx.run(
				"INSERT INTO objectives (id, goal, phase, creator_id, lead_id, thread_id, created_at, updated_at) VALUES (?, ?, 'active', ?, ?, ?, ?, ?)",
				t!.runtime.newId(),
				"ship it",
				t!.runtime.config.user,
				a.session.id,
				a.thread.id,
				t!.clock.now(),
				t!.clock.now(),
			);
		});
		const asked = answer(0.01);

		const sent = await replyAs(a.thread.id, b.session.id, "Acknowledged, thanks!");
		expect(sent.status, JSON.stringify(sent.body)).toBe(200);
		await settled(a.session.id);

		expect(asked.calls).toBe(0);
		expect((await delivery(sent.body.message.id, a.session.id))?.wake_submission_id).not.toBeNull();
	});

	it("DEC-05 a message from the user always wakes, whatever the decision model answers", async () => {
		await start({ decisionModel: "faux/rune" });
		const a = await session("watch");
		const asked = answer(0.01);

		const sent = await t!.client.post<{ message: { id: string } }>(`/threads/${a.thread.id}/messages`, {
			after: await head(a.thread.id),
			body: "Thanks!",
		});
		expect(sent.status, JSON.stringify(sent.body)).toBe(200);
		await settled(a.session.id);

		expect(asked.calls).toBe(0);
		expect((await delivery(sent.body.message.id, a.session.id))?.wake_submission_id).not.toBeNull();
	});
});

describe("DEC-06 fail open", () => {
	it("DEC-06 a failed decision wakes as before", async () => {
		await start({ decisionModel: "faux/rune" });
		const a = await session("watch");
		const b = await session("wait");
		await addToThread(a, b);
		let calls = 0;
		setDecisionTransport(t!.runtime, async (request) => {
			// Only the wake question counts; the push gate asks about the same delivery (PSH-06).
			if (WAKE_QUESTION in request.questions) calls++;
			throw new Error("provider error");
		});

		const sent = await replyAs(a.thread.id, b.session.id, "Thanks!");
		expect(sent.status, JSON.stringify(sent.body)).toBe(200);
		await settled(a.session.id);

		expect(calls).toBe(1);
		expect((await delivery(sent.body.message.id, a.session.id))?.wake_submission_id).not.toBeNull();
		// DEC-08: a gate that cannot answer leaves a line, so a broken key or endpoint is visible.
		expect(gateLinesFor(sent.body.message.id)).toEqual([
			expect.objectContaining({ decision: "failed", error: expect.stringContaining("provider error") }),
		]);
	});

	it("DEC-06 a timeout wakes as before", async () => {
		await start({ decisionModel: "faux/rune" });
		const a = await session("watch");
		const b = await session("wait");
		await addToThread(a, b);
		setDecisionTransport(
			t!.runtime,
			(_request: DecisionRequest, signal: AbortSignal) =>
				new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
		);

		const pending = replyAs(a.thread.id, b.session.id, "Thanks!");
		await t!.clock.advance(DECISION_TIMEOUT_MS + 100);
		const sent = await pending;
		expect(sent.status, JSON.stringify(sent.body)).toBe(200);
		await settled(a.session.id);

		expect((await delivery(sent.body.message.id, a.session.id))?.wake_submission_id).not.toBeNull();
	});

	it("DEC-06 a missing model or key wakes as before", async () => {
		await start({ decisionModel: "nope/rune" });
		const a = await session("watch");
		const b = await session("wait");
		await addToThread(a, b);
		// No transport: the default one resolves the provider and finds nothing registered.
		const sent = await replyAs(a.thread.id, b.session.id, "Thanks!");
		expect(sent.status, JSON.stringify(sent.body)).toBe(200);
		await settled(a.session.id);
		expect((await delivery(sent.body.message.id, a.session.id))?.wake_submission_id).not.toBeNull();
	});
});

describe("DEC-07 and DEC-09 the skipped delivery", () => {
	it("DEC-07 mail the gate skipped is delivered later on a resume", async () => {
		await start({ decisionModel: "faux/rune" });
		const a = await session("watch");
		const b = await session("wait");
		await addToThread(a, b);
		answer(0.01);
		const sent = await replyAs(a.thread.id, b.session.id, "FYI, no action needed.");
		await t!.clock.settle();
		expect(await delivery(sent.body.message.id, a.session.id)).toMatchObject({ read_at: null, wake_submission_id: null });

		const resumed = await t!.client.post(`/sessions/${a.session.id}/resume`);
		expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
		await settled(a.session.id);

		expect((await delivery(sent.body.message.id, a.session.id))?.read_at).not.toBeNull();
		expect(gateLines().filter((line) => line.event === "wake.delivered_after_skip")).toEqual([
			expect.objectContaining({ probability: 0.01, recipientId: a.session.id }),
		]);
	});

	it("DEC-09 a retried wake reuses the recorded answer and submits once", async () => {
		await start({ decisionModel: "faux/rune" });
		const a = await session("watch");
		const b = await session("wait");
		await addToThread(a, b);
		const asked = answer(0.9);
		const sent = await replyAs(a.thread.id, b.session.id, "Please review this.");
		await settled(a.session.id);
		const row = await delivery(sent.body.message.id, a.session.id);
		expect(row?.wake_request_id).toMatch(/^pana\.delivery:/);
		const firstSubmission = row?.wake_submission_id;
		expect(firstSubmission).not.toBeNull();
		const decided = await t!.runtime.db.get<{ probability: number }>(
			"SELECT d.probability FROM delivery_wake_decisions d JOIN deliveries l ON l.id = d.delivery_id WHERE l.message_id = ? AND l.recipient_id = ?",
			sent.body.message.id,
			a.session.id,
		);
		expect(decided).toEqual({ probability: 0.9 });

		// A crash between the decision and the submission record: the startup sweep retries it.
		await t!.runtime.db.write(async (tx) => {
			await tx.run("UPDATE deliveries SET wake_submission_id = NULL WHERE message_id = ? AND recipient_id = ?", sent.body.message.id, a.session.id);
		});
		expect(await sweepWakes(t!.runtime.db, t!.runtime.wake)).toBe(1);

		// pi-durable answers a repeated request id with the submission it already holds, so the
		// retried wake is the same one and the decision model was never asked again.
		expect((await delivery(sent.body.message.id, a.session.id))?.wake_submission_id).toBe(firstSubmission);
		expect(asked.calls).toBe(1);
	});
});
