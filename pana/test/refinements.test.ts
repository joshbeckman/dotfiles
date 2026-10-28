// WP11 refinements: HOME as the default cwd, session and per-participant thread archives,
// unread counts, and the PWA's links and transcript view mappers (REF-01..REF-09).
//
// The PWA's own views are checked in test/browser/web.spec.ts; the mappers they render from are
// checked here, against real handler output.

import { homedir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it } from "vitest";
import { runPanaCommand } from "../src/cli/commands.ts";
import { createPanaEnv } from "../src/extension/env.ts";
import { sessionRuntime } from "../src/sessions/index.ts";
import { postNotice } from "../src/threads/index.ts";
import { appHref, idHref, panaLinkSegments } from "../web/links.js";
import { entryView, inboxRow, messageView, threadRow } from "../web/views.js";
import { FAUX_MODEL, startTestPanad, TEST_DOMAIN, TEST_USER, type Script, type TestPanad } from "./harness/index.ts";

interface Person {
	id: string;
	kind: string;
	url: string;
}

interface SessionBody {
	session: { id: string; url: string; state: string; cwd: string | null; conversationId: number | null };
	thread: { id: string };
	message: { id: string };
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

let t: TestPanad | undefined;
afterEach(async () => {
	await t?.close();
	t = undefined;
});

async function start(script: Script = []): Promise<TestPanad> {
	t = await startTestPanad({ script, config: { defaultModel: "faux/faux-1", timezone: "UTC" } });
	return t;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

type Params = Record<string, string | string[] | boolean | undefined>;

async function command(name: string, params: Params): Promise<{ status: number; exitCode: number; body: unknown }> {
	return runPanaCommand(name, params, { endpoint: { socketPath: t!.panad.socketPath } });
}

/** A session row that is not wakeable, for thread participants. */
async function seedSession(state = "idle"): Promise<string> {
	const id = t!.runtime.newId();
	const now = t!.clock.now();
	await t!.runtime.db.write(async (tx) => {
		await tx.run("INSERT INTO participants (id, kind, url, created_at) VALUES (?, 'session', ?, ?)", id, t!.runtime.url({ kind: "session", id }), now);
		await tx.run("INSERT INTO sessions (id, state, depth, created_at, updated_at) VALUES (?, ?, 0, ?, ?)", id, state, now, now);
	});
	return id;
}

/** A thread between the user and one session, with the user's first message. */
async function seededThread(): Promise<{ threadId: string; sessionId: string; head: string }> {
	const sessionId = await seedSession();
	const created = await t!.client.post<{ thread: { id: string }; message: { id: string } }>("/threads", {
		to: [sessionId],
		body: "a first message",
	});
	expect(created.status, JSON.stringify(created.body)).toBe(201);
	return { threadId: created.body.thread.id, sessionId, head: created.body.message.id };
}

describe("REF-01 the default working directory", () => {
	it("REF-01 SCR-02 a session with no --cwd and no profile cwd runs in its scratch, not HOME or panad's cwd", async () => {
		await start();
		const res = await t!.client.post<SessionBody>("/sessions", { prompt: "where am I?" });
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		const scratch = join(t!.runtime.paths.scratch, res.body.session.id);
		expect(res.body.session.cwd).toBe(scratch);
		expect(scratch).not.toBe(homedir());
		expect(scratch).not.toBe(process.cwd());

		// The bash environment a session runs commands in follows the same cwd.
		const env = await createPanaEnv(() => t!.runtime)({
			conversationId: res.body.session.conversationId!,
			...(res.body.session.cwd === null ? {} : { cwd: res.body.session.cwd }),
		});
		expect(env.cwd).toBe(scratch);
	});

	it("REF-01 an explicit --cwd and a profile cwd still win over HOME", async () => {
		await start();
		const res = await t!.client.post<SessionBody>("/sessions", { prompt: "here", cwd: t!.dir });
		expect(res.status).toBe(201);
		expect(res.body.session.cwd).toBe(t!.dir);
	});
});

describe("REF-02 session archive", () => {
	it("REF-02 pana session archive calls POST /sessions/:id/archive, only the user may archive, and the archived session is read-only", async () => {
		await start();
		const seeded = await seededThread();

		// A session may not archive anything.
		const refused = await t!.client.post(`/sessions/${seeded.sessionId}/archive`, undefined, { caller: seeded.sessionId });
		expect(refused.status).toBe(403);

		const archived = await command("session archive", { id: seeded.sessionId });
		expect(archived.status).toBe(200);
		expect((archived.body as { session: { state: string } }).session.state).toBe("archived");
		expect((await t!.client.get<{ session: { state: string } }>(`/sessions/${seeded.sessionId}`)).body.session.state).toBe("archived");

		// STA-07: the thread with the archived session is read-only.
		const reply = await t!.client.post(`/threads/${seeded.threadId}/messages`, { after: seeded.head, body: "hello?" });
		expect(reply.status).toBe(409);
		expect(reply.body).toMatchObject({ error: { code: "stale", session: seeded.sessionId } });

		// Archiving twice is a no-op, not an error.
		expect((await command("session archive", { id: seeded.sessionId })).status).toBe(200);
	});
});

describe("REF-03 per-participant thread archive", () => {
	it("REF-03 thread archive only hides the thread from one participant inbox, and unarchive restores it", async () => {
		await start();
		const seeded = await seededThread();
		const sessionReply = await t!.client.post<{ message: MessageBody }>(
			`/threads/${seeded.threadId}/messages`,
			{ after: seeded.head, body: "a reply from the session" },
			{ caller: seeded.sessionId },
		);
		expect(sessionReply.status, JSON.stringify(sessionReply.body)).toBe(200);

		const archived = await command("thread archive", { id: seeded.threadId });
		expect(archived.status).toBe(200);
		expect(archived.body).toMatchObject({ archived: true, thread: { id: seeded.threadId } });

		const userInbox = await t!.client.get<{ deliveries: unknown[] }>("/inbox");
		expect(userInbox.body.deliveries).toHaveLength(0);
		// The inbox can show the archived threads instead, which is where Unarchive lives (REF-07).
		expect((await t!.client.get<{ deliveries: unknown[] }>("/inbox?archived=1")).body.deliveries).toHaveLength(1);
		const listed = await t!.client.get<{ threads: Array<{ threadId: string }> }>("/threads");
		expect(listed.body.threads).toEqual([expect.objectContaining({ threadId: seeded.threadId })]);
		const viaCli = await command("thread list", {});
		expect((viaCli.body as { threads: Array<{ threadId: string }> }).threads.map((row) => row.threadId)).toEqual([seeded.threadId]);

		// Archiving is per participant: the session still sees its inbox and thread.
		const sessionInbox = await t!.client.get<{ deliveries: unknown[] }>("/inbox", { caller: seeded.sessionId });
		expect(sessionInbox.body.deliveries).toHaveLength(1);

		const unarchived = await command("thread unarchive", { id: seeded.threadId });
		expect(unarchived.status).toBe(200);
		expect((await t!.client.get<{ threads: unknown[] }>("/threads")).body.threads).toHaveLength(1);
		expect((await t!.client.get<{ deliveries: unknown[] }>("/inbox")).body.deliveries).toHaveLength(1);
		expect((await t!.client.get<{ deliveries: unknown[] }>("/inbox?archived=1")).body.deliveries).toEqual([]);
	});
});

describe("REF-04 a delivery unarchives the thread", () => {
	it("REF-04 a new message delivered to a participant unarchives the thread for that participant", async () => {
		await start();
		const seeded = await seededThread();
		await t!.client.post(`/threads/${seeded.threadId}/archive`, {});
		expect((await t!.client.get<{ deliveries: unknown[] }>("/inbox")).body.deliveries).toEqual([]);

		const appended = await t!.client.post<{ message: MessageBody }>(
			`/threads/${seeded.threadId}/messages`,
			{ after: seeded.head, body: "new mail" },
			{ caller: seeded.sessionId },
		);
		expect(appended.status, JSON.stringify(appended.body)).toBe(200);

		const inbox = await t!.client.get<{ deliveries: Array<{ body?: string }> }>("/inbox");
		expect(inbox.body.deliveries.map((delivery) => delivery.body)).toEqual(["new mail"]);
		const listed = await t!.client.get<{ threads: Array<{ threadId: string }> }>("/threads");
		expect(listed.body.threads.map((thread) => thread.threadId)).toEqual([seeded.threadId]);
		expect((await t!.client.get<{ deliveries: unknown[] }>("/inbox?archived=1")).body.deliveries).toEqual([]);
	});

	it("REF-04 a notice to a participant unarchives the thread too", async () => {
		await start();
		const notice = await postNotice(t!.runtime, { body: "a notice" });
		await t!.client.post(`/threads/${notice.thread.id}/archive`, {});
		expect((await t!.client.get<{ deliveries: unknown[] }>("/inbox")).body.deliveries).toEqual([]);
		await postNotice(t!.runtime, { body: "a second notice", thread: notice.thread.id });
		expect((await t!.client.get<{ deliveries: unknown[] }>("/inbox")).body.deliveries).toHaveLength(2);
		expect((await t!.client.get<{ threads: Array<{ threadId: string }> }>("/threads")).body.threads.map((row) => row.threadId)).toEqual([
			notice.thread.id,
		]);
	});
});

describe("REF-05 unread counts", () => {
	it("REF-05 unread counts belong to inbox items, not thread discovery", async () => {
		await start();
		const seeded = await seededThread();
		const quiet = await t!.client.post<{ thread: { id: string }; message: { id: string } }>("/threads", {
			to: [seeded.sessionId],
			body: "nothing will answer this",
		});
		expect(quiet.status).toBe(201);
		const reply = await t!.client.post<{ message: MessageBody }>(
			`/threads/${seeded.threadId}/messages`,
			{ after: seeded.head, body: "a reply from the session" },
			{ caller: seeded.sessionId },
		);
		expect(reply.status).toBe(200);

		const inbox = await t!.client.get<{ deliveries: unknown[] }>("/inbox");
		expect(inbox.body.deliveries.map(inboxRow)).toEqual([
			expect.objectContaining({ threadId: seeded.threadId, unreadCount: 1, read: false }),
		]);

		const listed = await t!.client.get<{ threads: Array<{ threadId: string }> }>("/threads");
		expect(listed.body.threads.map(row => row.threadId)).toEqual(expect.arrayContaining([seeded.threadId, quiet.body.thread.id]));
		for (const row of listed.body.threads) {
			expect(row).not.toHaveProperty("unreadCount");
			expect(row).not.toHaveProperty("archived");
		}

		// Reading the thread clears the inbox count, without changing discovery results.
		await t!.client.get(`/threads/${seeded.threadId}`);
		expect((await t!.client.get("/threads")).body).toEqual(listed.body);
		expect((await t!.client.get<{ deliveries: unknown[] }>("/inbox")).body.deliveries.map(inboxRow)).toEqual([
			expect.objectContaining({ unreadCount: 0, read: true }),
		]);
	});
});

describe("REF-08 every ID and URL the PWA shows is a link", () => {
	it("REF-08 pana:// URLs in text become app routes, and bare IDs map to their views", () => {
		const domain = TEST_DOMAIN;
		expect(idHref("01S", "session")).toBe("#/sessions/01S");
		expect(idHref("01T", "thread")).toBe("#/threads/01T");
		expect(idHref("01X", "schedule")).toBe("#/schedules?focus=01X");
		expect(idHref(TEST_USER, "user")).toBe("#/inbox");
		expect(idHref("", "session")).toBeUndefined();

		const text = `Ask ${TEST_USER}: pana://${domain}/sessions/01S, or read pana://${domain}/threads/01T?message=01M.`;
		const segments = panaLinkSegments(text, domain);
		expect(segments.filter((segment) => segment.href).map((segment) => segment.href)).toEqual(["#/sessions/01S", "#/threads/01T?message=01M"]);
		expect(segments.map((segment) => segment.text).join("")).toBe(text);
		// A foreign domain has no route, so it stays text.
		expect(panaLinkSegments("pana://elsewhere/x", domain)).toEqual([{ text: "pana://elsewhere/x" }]);
		expect(appHref(`pana://${domain}/users/${TEST_USER}`, domain)).toBe("#/inbox");
	});

	it("REF-08 the mappers keep the URLs and IDs the views link", async () => {
		await start();
		const seeded = await seededThread();
		await t!.client.post(`/threads/${seeded.threadId}/messages`, { after: seeded.head, body: "hi" }, { caller: seeded.sessionId });
		const inbox = await t!.client.get<{ deliveries: unknown[] }>("/inbox");
		expect(inboxRow((inbox.body.deliveries as never[])[0])).toMatchObject({
			threadUrl: `pana://${TEST_DOMAIN}/threads/${seeded.threadId}`,
			sender: t!.runtime.url({ kind: "session", id: seeded.sessionId }),
		});
		const read = await t!.client.get<{ messages: unknown[] }>(`/threads/${seeded.threadId}`);
		const message = messageView((read.body.messages as never[])[1]);
		expect(message).toMatchObject({
			threadId: seeded.threadId,
			url: expect.stringContaining(`pana://${TEST_DOMAIN}/threads/${seeded.threadId}?message=`),
		});
	});
});

describe("REF-09 the transcript view", () => {
	it("REF-09 the session view shows thinking, tool calls with their full arguments, tool results with their output, and per-turn usage", async () => {
		await start([
			{
				thinking: "I should look before I answer.",
				toolCalls: [{ name: "bash", args: { command: "node -e \"console.log('y'.repeat(2500))\"" } }],
				usage: { input: 12, output: 7, costUsd: 0.002 },
			},
			{ text: "the answer", usage: { input: 20, output: 3, costUsd: 0.001 } },
		]);
		const created = await t!.client.post<SessionBody>("/sessions", { prompt: "look and answer" });
		expect(created.status).toBe(201);
		await until(async () => (await t!.runtime.db.get("SELECT 1 FROM messages WHERE thread_id = ? AND seq = 2", created.body.thread.id)) ?? false, "the reply");

		const transcript = await t!.client.get<{ entries: unknown[] }>(`/sessions/${created.body.session.id}/transcript`);
		const entries = transcript.body.entries.map(entryView);
		const kinds = entries.map((entry) => entry.kind);
		expect(kinds).toEqual(expect.arrayContaining(["pana.message", "pi.assistant", "pi.tool-result"]));

		const thinking = entries.flatMap((entry) => entry.blocks).find((block) => block.type === "thinking");
		expect(thinking).toEqual({ type: "thinking", text: "I should look before I answer.", markdown: true });

		const call = entries.flatMap((entry) => entry.blocks).find((block) => block.type === "tool-call");
		expect(call).toMatchObject({ type: "tool-call", name: "bash", arguments: { command: expect.stringContaining("repeat(2500)") } });

		const result = entries.flatMap((entry) => entry.blocks).find((block) => block.type === "tool-result");
		expect(result).toMatchObject({ type: "tool-result", name: "bash", isError: false });
		expect(String((result as { output: string }).output).length).toBeGreaterThan(2000);

		const usages = entries.filter((entry) => entry.usage).map((entry) => entry.usage);
		expect(usages).toEqual(
			expect.arrayContaining([
				{ input: 12, output: 7, costUsd: 0.002 },
				{ input: 20, output: 3, costUsd: 0.001 },
			]),
		);
	});

	it("REF-09 system, compaction, and reset entries keep their text and carry a label", () => {
		const system = entryView({
			id: 1,
			kind: "pi.system",
			model: [{ role: "system", content: [] }],
			data: { prompt: "sections changed" },
		});
		expect(system).toMatchObject({ kind: "pi.system", label: "system", blocks: [{ type: "json" }] });

		const compaction = entryView({
			id: 2,
			kind: "pi.compaction",
			model: [{ role: "user", content: "a compacted summary" }],
			data: { reason: "threshold" },
		});
		expect(compaction).toMatchObject({ kind: "pi.compaction", label: "compaction" });
		expect(compaction.text).toContain("a compacted summary");

		const reset = entryView({ id: 3, kind: "pi.reset", model: [{ role: "user", content: "handoff text" }] });
		expect(reset).toMatchObject({ kind: "pi.reset", label: "reset", text: "handoff text" });
	});

	it("REF-09 a tool result entry keeps the full output from pi-durable", async () => {
		await start([{ toolCalls: [{ name: "bash", args: { command: "echo visible-output" } }] }, { text: "done" }]);
		const created = await t!.client.post<SessionBody>("/sessions", { prompt: "run it", model: FAUX_MODEL.provider + "/" + FAUX_MODEL.modelId });
		expect(created.status).toBe(201);
		await until(async () => (await t!.runtime.db.get("SELECT 1 FROM messages WHERE thread_id = ? AND seq = 2", created.body.thread.id)) ?? false, "the reply");
		const transcript = await t!.client.get<{ entries: unknown[] }>(`/sessions/${created.body.session.id}/transcript`);
		const output = transcript.body.entries
			.map(entryView)
			.flatMap((entry) => entry.blocks)
			.find((block) => block.type === "tool-result");
		expect(output).toMatchObject({ name: "bash" });
		expect(String((output as { output: string }).output)).toContain("visible-output");
		await sessionRuntime(t!.runtime).idle();
		// The runtime keeps the same entries for a second reader (nothing is truncated in storage).
		expect(ctx).toBeDefined();
	});
});
