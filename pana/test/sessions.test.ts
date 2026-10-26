import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { InboxDoc, LiveDoc, defineExtension, defineTool, type ConversationId, type SubmissionId } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPanaRegistry } from "../src/extension/index.ts";
import { sessionRuntime } from "../src/sessions/index.ts";
import { FAKE_EPOCH, startTestPanad, TEST_DOMAIN, TEST_USER, type Script, type TestPanad } from "./harness/index.ts";

interface Person {
	id: string;
	kind: string;
	url: string;
}

interface SessionBody {
	id: string;
	url: string;
	state: string;
	parent: string | null;
	parentUrl: string | null;
	depth: number;
	model: string | null;
	thinking: string | null;
	profile: string | null;
	cwd: string | null;
	conversationId: number;
	costUsd: number;
}

interface MessageBody {
	id: string;
	url: string;
	threadId: string;
	seq: number;
	sender: Person;
	body?: string;
	readAt?: number | null;
}

interface CreateBody {
	session: SessionBody;
	thread: { id: string; url: string; participants: Person[] };
	message: MessageBody;
}

interface ReadBody {
	messages: MessageBody[];
}

interface InboxBody {
	deliveries: Array<{ messageId: string; threadId: string; sender: Person; readAt: number | null; body?: string }>;
}

interface TranscriptBody {
	entries: Array<{ id: number; kind: string; data?: Record<string, unknown>; model?: Array<{ role: string; content: unknown }> }>;
}

let t: TestPanad | undefined;
const dirs: string[] = [];

afterEach(async () => {
	await t?.close();
	t = undefined;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A tool that holds its run open until the test lets it go, so mail can arrive mid-run. */
function gates() {
	const waiting: Array<() => void> = [];
	const hold = (signal: AbortSignal | undefined) =>
		new Promise<void>((resolve) => {
			waiting.push(resolve);
			signal?.addEventListener("abort", () => resolve(), { once: true });
		});
	const extension = defineExtension({
		name: "test-gate",
		tools: [
			defineTool({
				name: "gate",
				description: "Wait for the test.",
				parameters: Type.Object({}),
				execute: async (_args, _api, context) => {
					await hold(context.abortSignal);
					return { output: [{ type: "text", text: "gate open" }] };
				},
			}),
			defineTool({
				name: "gate_end",
				description: "Wait for the test, then end the run.",
				parameters: Type.Object({}),
				execute: async (_args, _api, context) => {
					await hold(context.abortSignal);
					return { output: [{ type: "text", text: "done" }], control: { terminate: true } };
				},
			}),
		],
	});
	return {
		extension,
		pending: () => waiting.length,
		open: () => {
			for (const resolve of waiting.splice(0)) resolve();
		},
	};
}

async function start(options: { script?: Script; config?: Record<string, unknown>; settings?: Record<string, unknown>; gate?: ReturnType<typeof gates> } = {}) {
	let registry;
	if (options.gate) {
		registry = createPanaRegistry(() => t!.runtime);
		registry.install(options.gate.extension);
	}
	t = await startTestPanad({
		script: options.script ?? [],
		config: { defaultModel: "faux/faux-1", timezone: "UTC", ...options.config },
		registry,
		settings: options.settings,
	});
	return t;
}

/** Let panad work until `check` holds. */
async function until<T>(check: () => Promise<T | undefined | null | false>, what = "condition"): Promise<T> {
	for (let i = 0; i < 400; i++) {
		await t!.clock.settle();
		const value = await check();
		if (value) return value;
		await sleep(5);
	}
	throw new Error(`timed out waiting for ${what}`);
}

async function create(body: Record<string, unknown>, caller?: string): Promise<CreateBody> {
	const res = await t!.client.post<CreateBody>("/sessions", body, caller ? { caller } : {});
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body;
}

async function show(id: string): Promise<SessionBody & { usage: { models: Record<string, { cost: { total: number } }> } }> {
	const res = await t!.client.get<{ session: SessionBody & { usage: { models: Record<string, { cost: { total: number } }> } } }>(`/sessions/${id}`);
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return res.body.session;
}

async function stateOf(id: string): Promise<string> {
	return (await show(id)).state;
}

async function settled(id: string, state = "idle"): Promise<void> {
	await until(async () => {
		await sessionRuntime(t!.runtime).idle();
		return (await stateOf(id)) === state;
	}, `session ${id} to be ${state}`);
}

async function messages(threadId: string): Promise<MessageBody[]> {
	const row = await t!.runtime.db.all<{ id: string; seq: number; sender_id: string; body: string }>(
		"SELECT id, seq, sender_id, body FROM messages WHERE thread_id = ? ORDER BY seq",
		threadId,
	);
	return row.map((m) => ({ id: m.id, url: "", threadId, seq: m.seq, sender: { id: m.sender_id, kind: "", url: "" }, body: m.body }));
}

async function entries(id: string): Promise<TranscriptBody["entries"]> {
	const res = await t!.client.get<TranscriptBody>(`/sessions/${id}/transcript`);
	expect(res.status).toBe(200);
	return res.body.entries;
}

function inputKinds(list: TranscriptBody["entries"]): string[] {
	return list.filter((e) => e.kind.startsWith("pana.")).map((e) => `${e.kind}:${String((e.data as { messageId?: string })?.messageId ?? "")}`);
}

async function respond(threadId: string, after: string, body: string, caller?: string) {
	return t!.client.post<{ message: MessageBody }>(`/threads/${threadId}/messages`, { after, body }, caller ? { caller } : {});
}

async function inbox(conversationId: number) {
	return t!.runtime.harness.snapshot(InboxDoc, conversationId as ConversationId, ctx);
}

async function live(conversationId: number) {
	return t!.runtime.harness.snapshot(LiveDoc, conversationId as ConversationId, ctx);
}

/** Insert a session that never wakes, to post as a second session. */
async function seedStoppedSession(): Promise<string> {
	const id = t!.runtime.newId();
	const now = t!.clock.now();
	await t!.runtime.db.write(async (tx) => {
		await tx.run("INSERT INTO participants (id, kind, url, created_at) VALUES (?, 'session', ?, ?)", id, `pana://${TEST_DOMAIN}/sessions/${id}`, now);
		await tx.run("INSERT INTO sessions (id, state, depth, created_at, updated_at) VALUES (?, 'stopped', 0, ?, ?)", id, now, now);
	});
	return id;
}

function makeRepo(): string {
	const repo = mkdtempSync(join(tmpdir(), "pana-wp3-repo-"));
	dirs.push(repo);
	const git = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] }).toString();
	git(["init", "-q", "-b", "main"]);
	git(["config", "user.name", "tester"]);
	git(["config", "user.email", `tester@${TEST_DOMAIN}`]);
	writeFileSync(join(repo, "README.md"), "hi\n");
	git(["add", "."]);
	git(["commit", "-q", "-m", "init"]);
	return repo;
}

describe("session create", () => {
	it("SES-01 session create makes a session, a thread with the caller and the session, and a first message from the caller", async () => {
		await start({ script: [{ text: "Paris" }] });
		const res = await create({ prompt: "what is the capital of france" });

		expect(res.session.url).toBe(`pana://${TEST_DOMAIN}/sessions/${res.session.id}`);
		expect(res.thread.participants.map((p) => p.id).sort()).toEqual([res.session.id, TEST_USER].sort());
		expect(res.message.body).toBe("what is the capital of france");
		expect(res.message.sender.id).toBe(TEST_USER);
		expect(res.message.threadId).toBe(res.thread.id);
		const row = await t!.runtime.db.get<{ conversation_id: number }>("SELECT conversation_id FROM sessions WHERE id = ?", res.session.id);
		expect(row?.conversation_id).toBe(res.session.conversationId);
	});

	it("SES-02 --to adds more participants to the new thread", async () => {
		await start({ script: [{ text: "ok" }] });
		const res = await create({ prompt: "hello", to: ["alice", "bob"] });
		expect(res.thread.participants.map((p) => p.id).sort()).toEqual([res.session.id, "alice", "bob", TEST_USER].sort());
		await settled(res.session.id);
		const alice = await t!.client.get<InboxBody>("/inbox?participant=alice");
		expect(alice.body.deliveries.map((d) => d.body)).toEqual(["ok", "hello"]);
	});

	it("SES-03 profile values apply, flags override them, and an unknown profile is a 400", async () => {
		await start({ script: [{ text: "one" }, { text: "two" }] });
		writeFileSync(
			join(t!.runtime.paths.profiles, "terse.json"),
			JSON.stringify({ model: "faux/faux-1", thinking: "high", instructions: "Answer in one word." }),
		);
		const a = await create({ prompt: "hi", profile: "terse" });
		expect(a.session).toMatchObject({ profile: "terse", thinking: "high", model: "faux/faux-1" });
		const conversation = await t!.runtime.harness.conversation(a.session.conversationId as ConversationId, ctx);
		const agent = await conversation!.agent(ctx);
		expect(agent.instructions).toBe("Answer in one word.");
		expect(agent.thinkingLevel).toBe("high");

		const b = await create({ prompt: "hi", profile: "terse", thinking: "low" });
		expect(b.session.thinking).toBe("low");

		const unknown = await t!.client.post<{ error: { code: string } }>("/sessions", { prompt: "hi", profile: "nope" });
		expect(unknown.status).toBe(400);
		expect(unknown.body.error.code).toBe("unknown_profile");

		const sessions = await t!.runtime.db.all("SELECT id FROM sessions");
		expect(sessions).toHaveLength(2);
	});

	it("SES-04 cwd worktree creates a git worktree under <state>/worktrees/<ulid> from the --cwd repo", async () => {
		await start({ script: [{ text: "ok" }] });
		const repo = makeRepo();
		writeFileSync(join(t!.runtime.paths.profiles, "isolated.json"), JSON.stringify({ cwd: "worktree" }));
		const res = await create({ prompt: "hi", profile: "isolated", cwd: repo });

		const path = join(t!.dir, "worktrees", res.session.id);
		expect(res.session.cwd).toBe(path);
		expect(existsSync(join(path, "README.md"))).toBe(true);
		const list = execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"]).toString();
		expect(list).toContain(path);
		const conversation = await t!.runtime.harness.conversation(res.session.conversationId as ConversationId, ctx);
		expect((await conversation!.agent(ctx)).cwd).toBe(path);

		const missing = await t!.client.post<{ error: { code: string } }>("/sessions", { prompt: "hi", profile: "isolated" });
		expect(missing.status).toBe(400);
		await settled(res.session.id);
	});

	it("SES-05 a session created by a session records its parent, at the parent's depth plus one", async () => {
		await start({ script: [{ text: "parent ok" }, { text: "child ok" }, { text: "parent ack" }] });
		const parent = await create({ prompt: "be a parent" });
		await settled(parent.session.id);

		const child = await create({ prompt: "be a child" }, parent.session.id);
		expect(child.session.parent).toBe(parent.session.id);
		expect(child.session.parentUrl).toBe(parent.session.url);
		expect(child.session.depth).toBe(1);
		expect(child.message.sender.id).toBe(parent.session.id);

		const search = await t!.client.get<{ sessions: SessionBody[] }>(`/sessions?parent=${parent.session.id}`);
		expect(search.body.sessions.map((s) => s.id)).toEqual([child.session.id]);
		await settled(child.session.id);
		await settled(parent.session.id);
	});
});

describe("session states", () => {
	it("STA-01 a new session is running until its first run settles, then idle", async () => {
		await start({ script: [{ text: "done" }] });
		const res = await create({ prompt: "go" });
		expect(res.session.state).toBe("running");
		await settled(res.session.id);
		expect(await stateOf(res.session.id)).toBe("idle");
	});

	it("STA-02 a run that ends unanswered sets failed and posts a notice in the triggering thread", async () => {
		await start({ script: [{ fail: "boom" }, { text: "recovered" }] });
		const res = await create({ prompt: "go" });
		await settled(res.session.id, "failed");
		const thread = await messages(res.thread.id);
		expect(thread).toHaveLength(2);
		expect(thread[1]!.sender.id).toBe(TEST_DOMAIN);
		expect(thread[1]!.body).toContain(res.session.url);
		expect(thread[1]!.body).toContain("boom");
		const user = await t!.client.get<InboxBody>("/inbox");
		expect(user.body.deliveries[0]!.sender.url).toBe(`pana://${TEST_DOMAIN}`);

		// A failed session wakes on mail (DLV-01).
		const again = await respond(res.thread.id, thread[1]!.id, "try again");
		expect(again.status).toBe(200);
		await settled(res.session.id);
		expect((await messages(res.thread.id)).at(-1)!.body).toBe("recovered");
	});

	it("STA-03 a session asleep on a timer reports waiting", async () => {
		await start({
			script: [{ fail: "overloaded" }, { text: "back" }],
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 60_000 } },
		});
		const res = await create({ prompt: "go" });
		await until(async () => (await stateOf(res.session.id)) === "waiting", "waiting");
		const search = await t!.client.get<{ sessions: SessionBody[] }>("/sessions?state=waiting");
		expect(search.body.sessions.map((s) => s.id)).toEqual([res.session.id]);

		await t!.clock.advance(120_000);
		await settled(res.session.id);
		expect((await messages(res.thread.id)).at(-1)!.body).toBe("back");
	});

	it("STA-04 session stop aborts the current run and sets stopped", async () => {
		const gate = gates();
		await start({ gate, script: [{ toolCalls: [{ name: "gate" }] }, { text: "never" }] });
		const res = await create({ prompt: "go" });
		await until(async () => gate.pending() > 0, "gate");

		const stopped = await t!.client.post<{ session: SessionBody }>(`/sessions/${res.session.id}/stop`);
		expect(stopped.status).toBe(200);
		expect(stopped.body.session.state).toBe("stopped");
		expect((await live(res.session.conversationId))?.run).toBeUndefined();
		await sessionRuntime(t!.runtime).idle();
		expect(await stateOf(res.session.id)).toBe("stopped");
		expect(t!.model.remaining()).toBe(1);
		expect(await messages(res.thread.id)).toHaveLength(1);
	});

	it("STA-05 session resume sets idle and delivers queued mail in order", async () => {
		await start({ script: [{ text: "first" }, { text: "r1" }, { text: "r2" }] });
		const res = await create({ prompt: "go" });
		await settled(res.session.id);
		await t!.client.post(`/sessions/${res.session.id}/stop`);

		let head = (await messages(res.thread.id)).at(-1)!.id;
		const m1 = await respond(res.thread.id, head, "m1");
		head = m1.body.message.id;
		const m2 = await respond(res.thread.id, head, "m2");
		await t!.clock.settle();
		expect(await stateOf(res.session.id)).toBe("stopped");

		const resumed = await t!.client.post<{ session: SessionBody }>(`/sessions/${res.session.id}/resume`);
		expect(resumed.status).toBe(200);
		expect(["idle", "running"]).toContain(resumed.body.session.state);
		await settled(res.session.id);

		const kinds = inputKinds(await entries(res.session.id)).filter((k) => k.startsWith("pana.message"));
		expect(kinds).toEqual([
			`pana.message:${res.message.id}`,
			`pana.message:${m1.body.message.id}`,
			`pana.message:${m2.body.message.id}`,
		]);
	});

	it("STA-06 session search --state returns only sessions in that state", async () => {
		await start({ script: [{ text: "a" }, { text: "b" }] });
		const a = await create({ prompt: "a" });
		await settled(a.session.id);
		const b = await create({ prompt: "b" });
		await settled(b.session.id);
		await t!.client.post(`/sessions/${b.session.id}/stop`);

		const stopped = await t!.client.get<{ sessions: SessionBody[] }>("/sessions?state=stopped");
		expect(stopped.body.sessions.map((s) => s.id)).toEqual([b.session.id]);
		const idle = await t!.client.get<{ sessions: SessionBody[] }>("/sessions?state=idle");
		expect(idle.body.sessions.map((s) => s.id)).toEqual([a.session.id]);
		const bad = await t!.client.get("/sessions?state=sleepy");
		expect(bad.status).toBe(400);
	});

	it("STA-07 archived sessions are read-only and messages to them return 409", async () => {
		await start({ script: [{ text: "ok" }] });
		const res = await create({ prompt: "go" });
		await settled(res.session.id);
		await sessionRuntime(t!.runtime).archive(res.session.id);
		expect(await stateOf(res.session.id)).toBe("archived");

		const head = (await messages(res.thread.id)).at(-1)!.id;
		const reply = await respond(res.thread.id, head, "hello?");
		expect(reply.status).toBe(409);
		const fresh = await t!.client.post("/threads", { to: [res.session.id], body: "new thread" });
		expect(fresh.status).toBe(409);
		expect(await messages(res.thread.id)).toHaveLength(2);
		expect((await t!.client.post(`/sessions/${res.session.id}/stop`)).status).toBe(409);
		expect((await t!.client.post(`/sessions/${res.session.id}/resume`)).status).toBe(409);
	});
});

describe("mail delivery", () => {
	it("DLV-01 a message to an idle session submits a pana.message input and the session becomes running", async () => {
		const gate = gates();
		await start({ gate, script: [{ text: "first" }, { toolCalls: [{ name: "gate" }] }, { text: "second" }] });
		const res = await create({ prompt: "go" });
		await settled(res.session.id);

		const head = (await messages(res.thread.id)).at(-1)!.id;
		const sent = await respond(res.thread.id, head, "more");
		expect(await stateOf(res.session.id)).toBe("running");
		const delivery = await t!.runtime.db.get<{ wake_submission_id: number }>(
			"SELECT wake_submission_id FROM deliveries WHERE message_id = ? AND recipient_id = ?",
			sent.body.message.id,
			res.session.id,
		);
		const record = await (await t!.runtime.harness.submission(delivery!.wake_submission_id as SubmissionId, ctx))!.status(ctx);
		expect(record.type).toBe("input");
		const list = await entries(res.session.id);
		expect(list.find((e) => e.data?.messageId === sent.body.message.id)?.kind).toBe("pana.message");

		await until(async () => gate.pending() > 0, "gate");
		gate.open();
		await settled(res.session.id);
	});

	it("DLV-02 the model input has sender, thread, and message URLs, the subject, the body, and attachment paths", async () => {
		await start({ script: [{ text: "seen" }] });
		const file = await t!.client.request<{ file: { id: string; url: string; path: string } }>("POST", "/files?name=cat.png", {
			bytes: Buffer.from([1, 2, 3]),
			headers: { "content-type": "image/png" },
		});
		expect(file.status).toBe(201);
		const body = `look at this\n\n![cat.png](${file.body.file.url})`;
		const res = await create({ prompt: body });
		await settled(res.session.id);

		const input = (await entries(res.session.id)).find((e) => e.kind === "pana.message")!;
		const text = String(input.model![0]!.content);
		expect(text).toContain(`From: ${t!.runtime.userUrl}`);
		expect(text).toContain(`Thread: ${res.thread.url}`);
		expect(text).toContain(`Message: ${res.message.url}`);
		expect(text).toContain("Subject: look at this");
		expect(text).toContain(body);
		expect(text).toContain(join(t!.dir, "files", file.body.file.id, "cat.png"));
	});

	it("DLV-03 delivery to a session marks the message read for it", async () => {
		await start({ script: [{ text: "ok" }] });
		const res = await create({ prompt: "go" });
		const view = await t!.client.get<InboxBody>(`/inbox?participant=${res.session.id}`);
		expect(view.body.deliveries).toHaveLength(1);
		expect(view.body.deliveries[0]!.readAt).not.toBeNull();
		await settled(res.session.id);
	});

	it("DLV-04 a message from a session to a running session queues as a follow-up and starts the next run", async () => {
		const gate = gates();
		await start({ gate, script: [{ toolCalls: [{ name: "gate" }] }, { text: "a1" }, { text: "a2" }] });
		const other = await seedStoppedSession();
		const res = await create({ prompt: "go", to: [other] });
		await until(async () => gate.pending() > 0, "gate");

		const sent = await respond(res.thread.id, res.message.id, "from another session", other);
		expect(sent.status).toBe(200);
		const queued = await inbox(res.session.conversationId);
		expect(queued?.items.map((item) => item.mode)).toEqual(["followUp"]);

		gate.open();
		await settled(res.session.id);
		const submissions = await t!.runtime.db.all<{ wake_submission_id: number }>(
			"SELECT wake_submission_id FROM deliveries WHERE recipient_id = ? ORDER BY created_at, id",
			res.session.id,
		);
		const answers = new Set<number>();
		for (const row of submissions) {
			const record = await (await t!.runtime.harness.submission(row.wake_submission_id as SubmissionId, ctx))!.status(ctx);
			expect(record.status).toBe("done");
			if (record.status === "done") answers.add(record.answer as number);
		}
		expect(answers.size).toBe(2);
	});

	it("DLV-05 a user's message to a running session steers after the tool round, or starts the next run if the run ends first", async () => {
		const gate = gates();
		await start({ gate, script: [{ toolCalls: [{ name: "gate" }] }, { text: "steered answer" }] });
		const res = await create({ prompt: "go" });
		await until(async () => gate.pending() > 0, "gate");
		const steer = await respond(res.thread.id, res.message.id, "also this");
		expect((await inbox(res.session.conversationId))?.items.map((item) => item.mode)).toEqual(["steer"]);
		gate.open();
		await settled(res.session.id);

		// One run: the steer is placed after the tool result and before the answer.
		const list = await entries(res.session.id);
		const order = list.map((e) => (e.kind === "pana.message" ? `msg:${String(e.data!.messageId)}` : e.kind)).filter((k) => k !== "pi.system");
		expect(order).toEqual([`msg:${res.message.id}`, "pi.assistant", "pi.tool-result", `msg:${steer.body.message.id}`, "pi.assistant"]);

		// The run ends before a steer is placed: the steer starts the next run.
		t!.model.append([{ toolCalls: [{ name: "gate_end" }] }, { text: "next run" }]);
		const head = (await messages(res.thread.id)).at(-1)!.id;
		const kick = await respond(res.thread.id, head, "end soon");
		await until(async () => gate.pending() > 0, "gate_end");
		const late = await respond(res.thread.id, kick.body.message.id, "late steer");
		gate.open();
		await settled(res.session.id);
		const kickRecord = await submissionFor(kick.body.message.id, res.session.id);
		const lateRecord = await submissionFor(late.body.message.id, res.session.id);
		expect(kickRecord.status).toBe("done");
		expect(lateRecord.status).toBe("done");
		expect(kickRecord.answer).not.toBe(lateRecord.answer);
		expect((await messages(res.thread.id)).at(-1)!.body).toBe("next run");
	});

	it("DLV-06 a message to a stopped session wakes nothing and stays unread", async () => {
		await start({ script: [{ text: "ok" }] });
		const res = await create({ prompt: "go" });
		await settled(res.session.id);
		await t!.client.post(`/sessions/${res.session.id}/stop`);
		const head = (await messages(res.thread.id)).at(-1)!.id;
		const sent = await respond(res.thread.id, head, "are you there");
		await t!.clock.settle();

		const row = await t!.runtime.db.get<{ read_at: number | null; wake_submission_id: number | null }>(
			"SELECT read_at, wake_submission_id FROM deliveries WHERE message_id = ? AND recipient_id = ?",
			sent.body.message.id,
			res.session.id,
		);
		expect(row).toEqual({ read_at: null, wake_submission_id: null });
		expect(await stateOf(res.session.id)).toBe("stopped");
		expect((await live(res.session.conversationId))?.run).toBeUndefined();
	});

	it("DLV-07 messages from a session to a thread do not wake that session", async () => {
		await start({ script: [{ text: "ok" }] });
		const res = await create({ prompt: "go" });
		await settled(res.session.id);
		const head = (await messages(res.thread.id)).at(-1)!.id;
		const own = await respond(res.thread.id, head, "a note from myself", res.session.id);
		expect(own.status).toBe(200);
		await t!.clock.settle();
		const rows = await t!.runtime.db.all("SELECT id FROM deliveries WHERE message_id = ? AND recipient_id = ?", own.body.message.id, res.session.id);
		expect(rows).toEqual([]);
		expect(await stateOf(res.session.id)).toBe("idle");
		expect(t!.model.calls()).toBe(1);
	});
});

async function submissionFor(messageId: string, sessionId: string) {
	const row = await t!.runtime.db.get<{ wake_submission_id: number }>(
		"SELECT wake_submission_id FROM deliveries WHERE message_id = ? AND recipient_id = ?",
		messageId,
		sessionId,
	);
	const record = await (await t!.runtime.harness.submission(row!.wake_submission_id as SubmissionId, ctx))!.status(ctx);
	return record as typeof record & { answer?: number };
}

describe("replies", () => {
	it("RPL-01 the final answer posts to the triggering thread from the session, and reaches the user's inbox", async () => {
		await start({ script: [{ text: "Paris" }] });
		const res = await create({ prompt: "what is the capital of france" });
		await settled(res.session.id);

		const read = await t!.client.get<ReadBody>(`/threads/${res.thread.id}`);
		expect(read.body.messages.map((m) => [m.sender.url, m.body])).toEqual([
			[t!.runtime.userUrl, "what is the capital of france"],
			[res.session.url, "Paris"],
		]);
		const user = await t!.client.get<InboxBody>("/inbox");
		expect(user.body.deliveries[0]).toMatchObject({ threadId: res.thread.id, body: "Paris", sender: { url: res.session.url } });
	});

	it("RPL-02 the auto-post's head is the newest message of the thread in the session's transcript", async () => {
		const gate = gates();
		await start({ gate, script: [{ toolCalls: [{ name: "gate" }] }, { text: "answer to both" }] });
		const res = await create({ prompt: "first" });
		await until(async () => gate.pending() > 0, "gate");
		const steer = await respond(res.thread.id, res.message.id, "second");
		gate.open();
		await settled(res.session.id);

		const thread = await messages(res.thread.id);
		expect(thread.map((m) => m.body)).toEqual(["first", "second", "answer to both"]);
		expect(thread[1]!.id).toBe(steer.body.message.id);
	});

	it("RPL-03 a thread that moved during the run gets no reply, and the next run reads a note and the new messages", async () => {
		const gate = gates();
		await start({ gate, script: [{ toolCalls: [{ name: "gate" }] }, { text: "stale answer" }, { text: "fresh answer" }] });
		const other = await seedStoppedSession();
		const res = await create({ prompt: "go", to: [other] });
		await until(async () => gate.pending() > 0, "gate");
		const moved = await respond(res.thread.id, res.message.id, "the plan changed", other);
		gate.open();
		await settled(res.session.id);

		const thread = await messages(res.thread.id);
		expect(thread.map((m) => m.body)).toEqual(["go", "the plan changed", "fresh answer"]);

		const list = await entries(res.session.id);
		const stale = list.findIndex((e) => e.kind === "pi.assistant" && JSON.stringify(e.model).includes("stale answer"));
		const after = list.slice(stale + 1).filter((e) => e.kind !== "pi.system");
		expect(after[0]!.kind).toBe("pana.note");
		const note = String(after[0]!.model![0]!.content);
		expect(note).toContain("not posted");
		expect(note).toContain(moved.body.message.url);
		expect(after[1]).toMatchObject({ kind: "pana.message", data: { messageId: moved.body.message.id } });
	});

	it("RPL-04 no auto-post when the session already posted to the triggering thread during the run", async () => {
		const gate = gates();
		await start({ gate, script: [{ toolCalls: [{ name: "gate" }] }, { text: "would repeat myself" }] });
		const res = await create({ prompt: "go" });
		await until(async () => gate.pending() > 0, "gate");
		const mid = await respond(res.thread.id, res.message.id, "posted mid-run", res.session.id);
		expect(mid.status).toBe(200);
		gate.open();
		await settled(res.session.id);
		expect((await messages(res.thread.id)).map((m) => m.body)).toEqual(["go", "posted mid-run"]);
	});

	it("RPL-05 an empty final answer posts nothing", async () => {
		await start({ script: [{ text: "   " }] });
		const res = await create({ prompt: "go" });
		await settled(res.session.id);
		expect(await messages(res.thread.id)).toHaveLength(1);
	});
});

describe("limits", () => {
	it("LIM-01 a session at spawnDepth gets 402 from session create", async () => {
		await start({ config: { spawnDepth: 1 }, script: [{ text: "root" }, { text: "child" }, { text: "root ack" }] });
		const root = await create({ prompt: "root" });
		await settled(root.session.id);
		const child = await create({ prompt: "child" }, root.session.id);
		expect(child.session.depth).toBe(1);
		await settled(child.session.id);

		const denied = await t!.client.post<{ error: { code: string; reason: string } }>("/sessions", { prompt: "grandchild" }, { caller: child.session.id });
		expect(denied.status).toBe(402);
		expect(denied.body.error).toMatchObject({ code: "over_budget", reason: "spawn_depth" });
		await settled(root.session.id);
	});

	it("LIM-02 a session whose cost passes budget.sessionUsd is stopped, and its creator gets a notice", async () => {
		await start({ config: { budget: { sessionUsd: 0.5 } }, script: [{ text: "pricey", usage: { costUsd: 1 } }] });
		const res = await create({ prompt: "go" });
		await settled(res.session.id, "stopped");
		const user = await t!.client.get<InboxBody>("/inbox");
		const notice = user.body.deliveries.find((d) => d.sender.url === `pana://${TEST_DOMAIN}`);
		expect(notice?.body).toContain(res.session.url);
		expect(notice?.body).toContain("budget");
	});

	it("LIM-03 over the domain's daily budget, no new runs start, session create is 402, the user is told, and runs resume the next day", async () => {
		await start({
			config: { budget: { domainDailyUsd: 1 } },
			script: [{ text: "expensive", usage: { costUsd: 2 } }, { text: "tomorrow" }],
		});
		const res = await create({ prompt: "go" });
		await settled(res.session.id);
		await sessionRuntime(t!.runtime).idle();

		const user = await t!.client.get<InboxBody>("/inbox");
		expect(user.body.deliveries.some((d) => d.sender.url === `pana://${TEST_DOMAIN}` && d.body?.includes("daily budget"))).toBe(true);
		const denied = await t!.client.post<{ error: { code: string } }>("/sessions", { prompt: "another" });
		expect(denied.status).toBe(402);

		const head = (await messages(res.thread.id)).at(-1)!.id;
		const held = await respond(res.thread.id, head, "keep going");
		await t!.clock.settle();
		expect(await stateOf(res.session.id)).toBe("idle");
		const row = await t!.runtime.db.get<{ read_at: number | null }>(
			"SELECT read_at FROM deliveries WHERE message_id = ? AND recipient_id = ?",
			held.body.message.id,
			res.session.id,
		);
		expect(row?.read_at).toBeNull();

		// FAKE_EPOCH is 09:00 UTC; the next local day starts 15 hours later.
		await t!.clock.advanceTo(FAKE_EPOCH + 15 * 3_600_000 + 1000);
		await sessionRuntime(t!.runtime).idle();
		await settled(res.session.id);
		expect((await messages(res.thread.id)).at(-1)!.body).toBe("tomorrow");
	});

	it("LIM-04 session show reports cost from pi-durable usage", async () => {
		await start({ script: [{ text: "one", usage: { costUsd: 0.25 } }, { text: "two", usage: { costUsd: 0.5 } }] });
		const res = await create({ prompt: "go" });
		await settled(res.session.id);
		const head = (await messages(res.thread.id)).at(-1)!.id;
		await respond(res.thread.id, head, "again");
		await settled(res.session.id);
		const detail = await show(res.session.id);
		expect(detail.costUsd).toBeCloseTo(0.75);
		expect(detail.usage.models["faux/faux-1"]!.cost.total).toBeCloseTo(0.75);
	});
});

describe("session runtime wiring", () => {
	it("SRC-03 a settled run is indexed for session search", async () => {
		await start({ script: [{ text: "the answer is quetzalcoatl" }] });
		const res = await create({ prompt: "name a feathered serpent" });
		await settled(res.session.id);
		const found = await t!.client.get<{ sessions: Array<SessionBody & { snippet: string }> }>("/sessions?query=quetzalcoatl");
		expect(found.body.sessions.map((s) => s.id)).toEqual([res.session.id]);
		expect(TEST_USER).toBe("tester");
	});
});

describe("restart", () => {
	it("STA-01 a session still marked running after a restart settles to idle", async () => {
		await start({ script: [{ text: "ok" }] });
		const res = await create({ prompt: "go" });
		await settled(res.session.id);
		await t!.runtime.db.write((tx) => tx.run("UPDATE sessions SET state = 'running' WHERE id = ?", res.session.id));
		const dir = t!.dir;
		await t!.stop();
		t = await startTestPanad({ stateDir: dir, config: { defaultModel: "faux/faux-1", timezone: "UTC" } });
		await settled(res.session.id);
		expect(await messages(res.thread.id)).toHaveLength(2);
	});
});
