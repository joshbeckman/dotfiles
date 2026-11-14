// PSH-06..PSH-10: the push gate.
//
// Every delivery to the user used to push. The gate asks one System One question over the rendered
// delivery and skips the push below `PUSH_GATE_THRESHOLD`, while the SSE publish and the unread
// inbox entry stay unconditional. The decision transport is faked the way the wake gate's tests
// fake it, so nothing here reaches the network and no key is needed.

import { readFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setDecisionTransport, type DecisionRequest } from "../src/decisions/index.ts";
import { PUSH_GATE_THRESHOLD, PUSH_QUESTION } from "../src/decisions/push.ts";
import { setPushTransport, type PushMessage } from "../src/push/index.ts";
import { sessionRuntime } from "../src/sessions/index.ts";
import { announce, postNotice } from "../src/threads/index.ts";
import { startTestPanad, type TestPanad } from "./harness/index.ts";

let t: TestPanad | undefined;
afterEach(async () => {
	setPushTransport(t?.runtime as never, undefined);
	setDecisionTransport(t?.runtime as never, undefined);
	await t?.close();
	t = undefined;
	vi.restoreAllMocks();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function start(config: Record<string, unknown> = {}): Promise<TestPanad> {
	t = await startTestPanad({
		script: Array.from({ length: 8 }, () => ({ text: "ok" })),
		config: { defaultModel: "faux/faux-1", timezone: "UTC", ...config },
	});
	return t;
}

async function until<T>(check: () => Promise<T | undefined | null | false> | T | undefined | null | false, what: string): Promise<T> {
	for (let i = 0; i < 400; i++) {
		await t!.clock.settle();
		await sessionRuntime(t!.runtime).idle();
		const value = await check();
		if (value) return value;
		await sleep(5);
	}
	throw new Error(`timed out waiting for ${what}`);
}

/** One subscription, so a push that happens is observable. */
async function subscribe(): Promise<void> {
	const res = await t!.tcp.post("/push/subscriptions", { endpoint: "https://push.example/gate", keys: { p256dh: "p", auth: "a" } });
	expect(res.status).toBe(201);
}

/** Record every push that reaches the transport. */
function pushes(): PushMessage[] {
	const sent: PushMessage[] = [];
	setPushTransport(t!.runtime, async (_subscription, message) => {
		sent.push(message);
	});
	return sent;
}

/** Answer the push question with `probability` and count the questions asked. */
function answer(probability: number): { calls: number } {
	const counter = { calls: 0 };
	setDecisionTransport(t!.runtime, async (request: DecisionRequest) => {
		const answers: Record<string, { type: "noul"; noul: number }> = {};
		for (const name of Object.keys(request.questions)) {
			answers[name] = { type: "noul", noul: name === PUSH_QUESTION ? probability : 1 };
		}
		if (PUSH_QUESTION in request.questions) counter.calls++;
		return { answers };
	});
	return counter;
}

interface Created {
	session: { id: string };
	thread: { id: string };
	message: { id: string };
}

/** A session whose thread holds the user, so its messages are delivered to him. */
async function session(prompt: string): Promise<Created> {
	const created = await t!.client.post<Created>("/sessions", { prompt });
	expect(created.status, JSON.stringify(created.body)).toBe(201);
	for (let i = 0; i < 400; i++) {
		await t!.clock.settle();
		await sessionRuntime(t!.runtime).idle();
		const row = await t!.runtime.db.get<{ state: string }>("SELECT state FROM sessions WHERE id = ?", created.body.session.id);
		if (row && row.state !== "running" && row.state !== "waiting") break;
		await sleep(5);
	}
	return created.body;
}

async function head(threadId: string): Promise<string> {
	const row = await t!.runtime.db.get<{ id: string }>("SELECT id FROM messages WHERE thread_id = ? ORDER BY seq DESC LIMIT 1", threadId);
	return row!.id;
}

/** A session's message to the user's thread: the path the push gate sits on. */
async function reply(threadId: string, sessionId: string, body: string): Promise<{ message: { id: string } | null }> {
	const res = await t!.client.post<{ message: { id: string } | null }>(
		`/threads/${threadId}/messages`,
		{ after: await head(threadId), body },
		{ caller: sessionId },
	);
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return res.body;
}

function logLines(): Array<Record<string, unknown>> {
	try {
		return readFileSync(joinPath(t!.dir, "decisions.log"), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	} catch {
		return [];
	}
}

function pushLines(messageId: string): Array<Record<string, unknown>> {
	return logLines().filter((line) => line.event === "push.gate" && line.messageId === messageId);
}

describe("PSH-06 a skipped push is silence, not a lost message", () => {
	it("PSH-06 a delivery below the threshold does not push, stays unread in the inbox, and streams anyway", async () => {
		await start({ decisionModel: "faux/rune" });
		await subscribe();
		const sent = pushes();
		const created = await session("would you check the gate?");
		const asked = answer(PUSH_GATE_THRESHOLD / 2);
		sent.length = 0;

		const posted = await reply(created.thread.id, created.session.id, "Acknowledged, nothing to do.");
		await t!.clock.settle();
		await sessionRuntime(t!.runtime).idle();

		expect(asked.calls).toBeGreaterThan(0);
		expect(sent).toEqual([]);
		// The message is durable, delivered, and unread: a skipped push loses nothing.
		const row = await t!.runtime.db.get<{ read_at: number | null }>(
			"SELECT read_at FROM deliveries WHERE message_id = ? AND recipient_id = ?",
			posted.message!.id,
			t!.runtime.config.user,
		);
		expect(row?.read_at).toBeNull();
		const read = await t!.client.get<{ messages: Array<{ body: string }> }>(`/threads/${created.thread.id}`);
		expect(read.body.messages.map((message) => message.body)).toContain("Acknowledged, nothing to do.");
	});
});

describe("PSH-07 the gate asks one question over the wake's own rendering", () => {
	it("PSH-07 a delivery at or above the threshold pushes, and the question carries the delivery frame", async () => {
		await start({ decisionModel: "faux/rune" });
		await subscribe();
		const sent = pushes();
		const created = await session("tell me when it is done");
		answer(PUSH_GATE_THRESHOLD);
		sent.length = 0;
		let state = "";
		setDecisionTransport(t!.runtime, async (request: DecisionRequest) => {
			if (PUSH_QUESTION in request.questions) state = request.state;
			const answers: Record<string, { type: "noul"; noul: number }> = {};
			for (const name of Object.keys(request.questions)) answers[name] = { type: "noul", noul: name === PUSH_QUESTION ? PUSH_GATE_THRESHOLD : 1 };
			return { answers };
		});

		const posted = await reply(created.thread.id, created.session.id, "Done: the build is green and ready for your merge.");
		await until(() => sent.length > 0, "the push");

		expect(sent[0]).toMatchObject({ threadId: created.thread.id, body: "Done: the build is green and ready for your merge." });
		// PSH-07: the state is the rendered delivery a wake would carry, frame included.
		expect(state).toContain("New message.");
		expect(state).toContain(`Thread: ${t!.runtime.url({ kind: "thread", id: created.thread.id })}`);
		expect(state).toContain(`Message: ${t!.runtime.url({ kind: "message", id: posted.message!.id, thread: created.thread.id })}`);
		expect(state).toContain("Subject:");
		expect(state).toContain("Done: the build is green and ready for your merge.");
	});
});

describe("PSH-08 what the gate never touches", () => {
	it("PSH-08 a message from the user is never gated", async () => {
		await start({ decisionModel: "faux/rune" });
		await subscribe();
		const sent = pushes();
		const created = await session("hello");
		const asked = answer(0);
		sent.length = 0;

		// The user replying in a thread his session is in: nobody else is delivered to, and he is
		// never pushed for his own words.
		const res = await t!.client.post(`/threads/${created.thread.id}/messages`, { after: await head(created.thread.id), body: "mine" });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		await t!.clock.settle();

		expect(sent).toEqual([]);
		expect(asked.calls).toBe(0);
	});

	it("PSH-08 a domain delivery (an objective escalation) is never gated", async () => {
		await start({ decisionModel: "faux/rune" });
		await subscribe();
		const sent = pushes();
		const asked = answer(0);
		sent.length = 0;

		// OBJ-33: an escalation is a domain message whose whole purpose is to reach him.
		const escalation = await t!.runtime.db.get<{ id: string }>("SELECT id FROM participants WHERE kind = 'domain' LIMIT 1");
		const threadId = await t!.runtime.db.get<{ id: string }>("SELECT id FROM threads LIMIT 1");
		const domainUrl = t!.runtime.url({ kind: "domain", id: escalation?.id ?? "domain" });
		announce(
			t!.runtime,
			"delivery",
			{
				thread: { id: threadId?.id ?? "thread", subject: "Objective needs you" },
				message: { id: "message", body: "An objective is held until you answer.", sender: { kind: "domain", url: domainUrl } },
			} as never,
			[{ deliveryId: "delivery", url: t!.runtime.userUrl }],
		);
		await until(() => sent.length > 0, "the escalation push");
		expect(sent).toHaveLength(1);
		expect(asked.calls).toBe(0);
	});

	it("PSH-08 a notice always pushes and asks nothing", async () => {
		await start({ decisionModel: "faux/rune" });
		await subscribe();
		const sent = pushes();
		const asked = answer(0);
		sent.length = 0;

		// `postNotice` carries a failed run, a budget stop, and a metric-check failure: none of
		// those may arrive silently, whatever the decision model would answer.
		const notice = await postNotice(t!.runtime, { body: "Session pana://beacon.joshbeckman.org/sessions/x failed (budget). Send it a message to try again." });
		await until(() => sent.length > 0, "the notice push");

		expect(sent).toHaveLength(1);
		expect(asked.calls).toBe(0);
		expect(pushLines(notice.message.id)).toEqual([]);
	});

	it("PSH-08 a retried delivery reuses the recorded answer instead of asking again", async () => {
		await start({ decisionModel: "faux/rune" });
		await subscribe();
		const sent = pushes();
		const asked = answer(PUSH_GATE_THRESHOLD / 2);
		const created = await session("a thread");
		const posted = await reply(created.thread.id, created.session.id, "Status: nothing needed.");
		await t!.clock.settle();
		const first = asked.calls;
		expect(sent).toEqual([]);

		// The same delivery is announced again, as a retried delivery would be.
		const result = await t!.client.get<{ thread: unknown; messages: Array<{ id: string; body: string }> }>(`/threads/${created.thread.id}`);
		expect(result.status).toBe(200);
		const delivery = await t!.runtime.db.get<{ id: string }>("SELECT id FROM deliveries WHERE message_id = ? AND recipient_id = ?", posted.message!.id, t!.runtime.config.user);
		announce(
			t!.runtime,
			"delivery",
			{
				thread: { id: created.thread.id, subject: "a thread" },
				message: { id: posted.message!.id, body: "Status: nothing needed.", sender: { kind: "session", url: created.session.id } },
			} as never,
			[{ deliveryId: delivery!.id, url: t!.runtime.userUrl }],
		);
		await t!.clock.settle();
		await sleep(20);

		expect(asked.calls).toBe(first);
		expect(sent).toEqual([]);
		const recorded = await t!.runtime.db.get<{ probability: number; push: number }>(
			"SELECT probability, push FROM delivery_push_decisions WHERE delivery_id = ?",
			delivery!.id,
		);
		expect(recorded).toEqual({ probability: PUSH_GATE_THRESHOLD / 2, push: 0 });
	});
});

describe("PSH-09 the gate fails open", () => {
	it("PSH-09 a failed question still pushes, and the failure leaves a line", async () => {
		await start({ decisionModel: "faux/rune" });
		await subscribe();
		const sent = pushes();
		const created = await session("say something");
		setDecisionTransport(t!.runtime, async (request: DecisionRequest) => {
			if (PUSH_QUESTION in request.questions) throw new Error("provider error");
			const answers: Record<string, { type: "noul"; noul: number }> = {};
			for (const name of Object.keys(request.questions)) answers[name] = { type: "noul", noul: 1 };
			return { answers };
		});
		sent.length = 0;

		const posted = await reply(created.thread.id, created.session.id, "Something.");
		await until(() => sent.length > 0, "the push after a failed question");

		expect(sent).toHaveLength(1);
		expect(pushLines(posted.message!.id)).toEqual([
			expect.objectContaining({ decision: "failed", error: expect.stringContaining("provider error") }),
		]);
	});

	it("PSH-09 an unset decisionModel pushes every delivery and asks nothing", async () => {
		await start();
		await subscribe();
		const sent = pushes();
		const asked = answer(0);
		const created = await session("anything");
		sent.length = 0;

		await reply(created.thread.id, created.session.id, "Status report.");
		await until(() => sent.length > 0, "the ungated push");

		expect(sent).toHaveLength(1);
		expect(asked.calls).toBe(0);
	});
});

describe("PSH-10 one JSONL line per decision, and a failed write changes nothing", () => {
	it("PSH-10 a decision is one line with the probability and the ids", async () => {
		await start({ decisionModel: "faux/rune" });
		await subscribe();
		pushes();
		const created = await session("log please");
		answer(PUSH_GATE_THRESHOLD);

		const posted = await reply(created.thread.id, created.session.id, "Answer for you.");
		await until(() => pushLines(posted.message!.id).length > 0, "the push log line");

		const lines = pushLines(posted.message!.id);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({ event: "push.gate", decision: "push", probability: PUSH_GATE_THRESHOLD, messageId: posted.message!.id });
		expect(typeof lines[0]!.deliveryId).toBe("string");
		expect(JSON.stringify(lines[0])).not.toContain("Answer for you.");
	});

	it("PSH-10 a log or record write that fails does not change the delivery", async () => {
		await start({ decisionModel: "faux/rune" });
		await subscribe();
		const sent = pushes();
		const created = await session("write please");
		sent.length = 0;
		answer(PUSH_GATE_THRESHOLD / 2);
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		// A full disk: the decision record and the log line cannot be written.
		const dir = t!.dir;
		vi.spyOn(t!.runtime.db, "write").mockRejectedValue(new Error("disk full"));
		vi.spyOn(t!.runtime.paths, "dir", "get").mockReturnValue(joinPath(dir, "missing-directory"));

		const posted = await reply(created.thread.id, created.session.id, "Between a rock and a hard place.");
		await t!.clock.settle();
		await sessionRuntime(t!.runtime).idle();

		// The delivery is committed, unread, and readable: the failed writes changed nothing.
		const row = await t!.runtime.db.get<{ read_at: number | null }>(
			"SELECT read_at FROM deliveries WHERE message_id = ? AND recipient_id = ?",
			posted.message!.id,
			t!.runtime.config.user,
		);
		expect(row?.read_at).toBeNull();
		const read = await t!.client.get<{ messages: Array<{ body: string }> }>(`/threads/${created.thread.id}`);
		expect(read.body.messages.map((message) => message.body)).toContain("Between a rock and a hard place.");
		expect(sent).toEqual([]);
		expect(errors).toHaveBeenCalled();
	});
});
