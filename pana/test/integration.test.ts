// WP10 integration: providers, schedule edits, and push, notices, and the live transcript wired
// to the real handlers (INT-01..INT-03).

import { createRequire } from "node:module";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setPushTransport, type PushMessage } from "../src/push/index.ts";
import { createProviderModels, hasModel } from "../src/server/models.ts";
import { detectTailscaleNames } from "../src/server/tailscale.ts";
import { sessionRuntime } from "../src/sessions/index.ts";
import { postNotice } from "../src/threads/index.ts";
import { commitView, entryView, inboxRow, memoryHitView, messageView, scheduleBody, scheduleWhen, threadRow } from "../web/views.js";
import { FAKE_EPOCH, startTestPanad, type Script, type TestPanad } from "./harness/index.ts";

// Vite resolves a static `node:sqlite` import as a package named `sqlite`.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

const DEEPSEEK = "fireworks/accounts/fireworks/models/deepseek-v4p1-flash-1017";

let t: TestPanad | undefined;
afterEach(async () => {
	setPushTransport(t?.runtime as never, undefined);
	await t?.close();
	t = undefined;
	vi.restoreAllMocks();
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

interface Created {
	session: { id: string; model: string };
	thread: { id: string };
	message: { id: string };
}

async function createSession(body: Record<string, unknown>): Promise<Created> {
	const res = await t!.client.post<Created>("/sessions", body);
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body;
}

async function subscribe(): Promise<void> {
	const res = await t!.tcp.post("/push/subscriptions", { endpoint: "https://push.example/int", keys: { p256dh: "p", auth: "a" } });
	expect(res.status).toBe(201);
}

/** Read through a second SQLite connection: it sees only committed rows. */
function committedMessage(dir: string, messageId: string): boolean {
	const db = new DatabaseSync(join(dir, "pana.sqlite"), { readOnly: true });
	try {
		return db.prepare("SELECT 1 AS found FROM messages WHERE id = ?").get(messageId) !== undefined;
	} finally {
		db.close();
	}
}

function openSse(port: number, token: string) {
	let buffer = "";
	const req = httpRequest({
		host: "127.0.0.1",
		port,
		path: "/events",
		headers: { authorization: `Bearer ${token}`, host: `127.0.0.1:${port}`, accept: "text/event-stream" },
	});
	req.on("response", (res: IncomingMessage) => res.on("data", (chunk: Buffer) => (buffer += chunk.toString("utf8"))));
	req.on("error", () => {});
	req.end();
	return {
		text: () => buffer,
		frames: () =>
			buffer
				.split("\n\n")
				.map((frame) => /^data: (.*)$/m.exec(frame)?.[1])
				.filter((data): data is string => data !== undefined)
				.map((data) => JSON.parse(data) as Record<string, unknown>),
		close: () => req.destroy(),
	};
}

describe("INT-01 model providers", () => {
	it("INT-01 registers every pi-ai provider whose credentials are in panad's environment", async () => {
		const none = await createProviderModels({});
		for (const id of ["fireworks", "anthropic", "openai"]) expect(none.getProvider(id)).toBeUndefined();

		const some = await createProviderModels({ FIREWORKS_API_KEY: "fw-test", ANTHROPIC_API_KEY: "ant-test", OPENAI_API_KEY: "  " });
		expect(some.getProvider("fireworks")).toBeDefined();
		expect(some.getProvider("anthropic")).toBeDefined();
		expect(some.getProvider("openai")).toBeUndefined();
		expect(hasModel(some, DEEPSEEK)).toBe(true);
		expect(hasModel(some, "openai/gpt-5")).toBe(false);
		expect(hasModel(some, "no-slash")).toBe(false);

		const openai = await createProviderModels({ OPENAI_API_KEY: "oa-test" });
		expect(openai.getProvider("openai")).toBeDefined();
		expect(openai.getModels("openai").length).toBeGreaterThan(0);
	});

	it("INT-01 a session with no model or profile model runs on config.defaultModel; an unregistered provider is a 400", async () => {
		await start([{ text: "Paris" }]);
		const created = await createSession({ prompt: "capital of France?" });
		expect(created.session.model).toBe("faux/faux-1");
		await until(async () => (await t!.runtime.db.get("SELECT 1 FROM messages WHERE thread_id = ? AND seq = 2", created.thread.id)) ?? false, "the reply");

		const res = await t!.client.post("/sessions", { prompt: "hi", model: DEEPSEEK });
		expect(res.status).toBe(400);
		expect(res.body).toMatchObject({ error: { code: "unknown_model", message: expect.stringContaining("no fireworks provider") } });
	});
});

describe("INT-02 schedule edits keep their time", () => {
	it("INT-02 an update with neither cron nor at keeps the stored time, kind, and state", async () => {
		await start();
		const at = new Date(FAKE_EPOCH + 3_600_000).toISOString();
		const created = await t!.client.post<{ schedule: { id: string; at: number; nextAt: number } }>("/schedules", {
			kind: "session",
			at,
			payload: { prompt: "one-off" },
		});
		expect(created.status).toBe(201);
		const { id } = created.body.schedule;

		const updated = await t!.client.post<{ schedule: { at: number; cron: string | null; nextAt: number; state: string; kind: string; payload: { prompt: string } } }>(
			`/schedules/${id}`,
			{ cron: "", payload: { prompt: "edited one-off" } },
		);
		expect(updated.status, JSON.stringify(updated.body)).toBe(200);
		expect(updated.body.schedule).toMatchObject({
			at: Date.parse(at),
			cron: null,
			nextAt: Date.parse(at),
			state: "active",
			kind: "session",
			payload: { prompt: "edited one-off" },
		});

		const cron = await t!.client.post<{ schedule: { id: string; nextAt: number } }>("/schedules", { cron: "0 9 * * *", prompt: "daily" });
		const kept = await t!.client.post<{ schedule: { cron: string; nextAt: number } }>(`/schedules/${cron.body.schedule.id}`, {
			payload: { prompt: "daily, edited" },
		});
		expect(kept.body.schedule).toMatchObject({ cron: "0 9 * * *", nextAt: cron.body.schedule.nextAt });

		// Sending a time still retimes it.
		const moved = await t!.client.post<{ schedule: { cron: string; at: number | null } }>(`/schedules/${id}`, { cron: "30 8 * * *" });
		expect(moved.body.schedule).toMatchObject({ cron: "30 8 * * *", at: null });
	});
});

describe("INT-02 the PWA reads the real handler shapes", () => {
	it("INT-02 every view mapper reads real responses from inbox, threads, sessions, memory, and schedules", async () => {
		await start([{ toolCalls: [{ name: "bash", args: { command: "true" } }] }, { text: "Paris." }]);
		const created = await createSession({ prompt: "What is the capital of France?" });
		const sessionUrl = t!.runtime.url({ kind: "session", id: created.session.id });
		await until(async () => (await t!.runtime.db.get("SELECT 1 FROM messages WHERE thread_id = ? AND seq = 2", created.thread.id)) ?? false, "the reply");

		const inbox = await t!.tcp.get<{ deliveries: unknown[] }>("/inbox");
		expect(inbox.body.deliveries.map(inboxRow)).toEqual([
			expect.objectContaining({ threadId: created.thread.id, subject: "What is the capital of France?", sender: sessionUrl, read: false }),
		]);

		const listing = await t!.tcp.get<{ threads: unknown[] }>("/threads");
		expect(listing.body.threads.map(threadRow)).toEqual([expect.objectContaining({ id: created.thread.id, subject: "What is the capital of France?" })]);
		const hits = await t!.tcp.get<{ threads: unknown[] }>("/threads?query=Paris");
		expect(hits.body.threads.map(threadRow)).toEqual([expect.objectContaining({ id: created.thread.id, snippet: expect.stringContaining("Paris") })]);

		const read = await t!.tcp.get<{ messages: unknown[] }>(`/threads/${created.thread.id}`);
		expect(read.body.messages.map(messageView)).toEqual([
			expect.objectContaining({ sender: t!.runtime.userUrl, body: "What is the capital of France?", revised: false, redacted: false }),
			expect.objectContaining({ sender: sessionUrl, body: "Paris." }),
		]);
		expect((await t!.tcp.get<{ deliveries: unknown[] }>("/inbox")).body.deliveries.map(inboxRow)[0]!.read).toBe(true);

		const transcript = await t!.tcp.get<{ entries: unknown[] }>(`/sessions/${created.session.id}/transcript`);
		const entries = transcript.body.entries.map(entryView);
		expect(entries).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "pana.message", role: "user", text: expect.stringContaining("What is the capital of France?") }),
				expect.objectContaining({ kind: "pi.assistant", role: "assistant", text: expect.stringContaining("→ bash") }),
				expect.objectContaining({ kind: "pi.assistant", role: "assistant", text: "Paris." }),
			]),
		);

		await t!.tcp.post("/memory/files/notes.md", { content: "hello memory\n" });
		const files = await t!.tcp.get<{ files: Array<{ path: string; size: number }> }>("/memory/files");
		expect(files.body.files).toEqual([{ path: "notes.md", size: 13 }]);
		const log = await t!.tcp.get<{ commits: unknown[] }>("/memory/log");
		expect(commitView(log.body.commits[0])).toMatchObject({ author: t!.runtime.userUrl, message: "Update notes.md" });
		const found = await t!.tcp.get<{ results: unknown[] }>("/memory/search?query=HELLO");
		expect(found.body.results.map(memoryHitView)).toEqual([{ path: "notes.md", text: "1: hello memory" }]);

		const at = new Date(FAKE_EPOCH + 86_400_000).toISOString();
		const made = await t!.tcp.post<{ schedule: { id: string; kind: string; cron: string | null; at: number | null; payload: Record<string, unknown> } }>(
			"/schedules",
			scheduleBody({ kind: "thread", when: at, text: "remember", to: "tester" }),
		);
		expect(made.status, JSON.stringify(made.body)).toBe(201);
		expect(scheduleWhen(made.body.schedule)).toBe(at);
		const edit = scheduleBody({ kind: "thread", when: "", text: "remember, edited", to: "" }, made.body.schedule);
		expect(edit).toEqual({ kind: "thread", payload: { body: "remember, edited", to: ["tester"] } });
		const updated = await t!.tcp.post<{ schedule: { at: number; payload: Record<string, unknown> } }>(`/schedules/${made.body.schedule.id}`, edit);
		expect(updated.status, JSON.stringify(updated.body)).toBe(200);
		expect(updated.body.schedule).toMatchObject({ at: Date.parse(at), payload: { body: "remember, edited" } });
		expect(scheduleBody({ kind: "session", when: "0 9 * * *", text: "daily" })).toEqual({ kind: "session", cron: "0 9 * * *", payload: { prompt: "daily" } });
	});
});

describe("INT-02 the PWA through Tailscale Serve", () => {
	it("INT-02 API-05 panad's entry point detects the tailnet name, so phones pass the Host check", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pana-tailscale-"));
		try {
			const fake = join(dir, "tailscale");
			writeFileSync(fake, `#!/bin/sh\necho '{"Self":{"DNSName":"Lantern.tailnet.ts.net."}}'\n`);
			chmodSync(fake, 0o755);
			expect(await detectTailscaleNames(fake)).toEqual(["lantern.tailnet.ts.net"]);
			expect(await detectTailscaleNames(join(dir, "missing"))).toEqual([]);
			const broken = join(dir, "broken");
			writeFileSync(broken, "#!/bin/sh\necho not json\n");
			chmodSync(broken, 0o755);
			expect(await detectTailscaleNames(broken)).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("INT-03 push, notices, and the live transcript", () => {
	it("INT-03 a delivery to the user pushes after its transaction commits", async () => {
		await start([{ text: "Paris." }]);
		await subscribe();
		const sent: Array<{ message: PushMessage; committed: boolean }> = [];
		setPushTransport(t!.runtime, async (_subscription, message) => {
			const row = await t!.runtime.db.get<{ id: string }>(
				"SELECT id FROM messages WHERE thread_id = ? ORDER BY seq DESC LIMIT 1",
				message.threadId ?? "",
			);
			sent.push({ message, committed: row !== undefined && committedMessage(t!.dir, row.id) });
		});

		const created = await createSession({ prompt: "What is the capital of France?" });
		// The user's own prompt is not delivered to the user.
		expect(sent).toHaveLength(0);
		await until(() => sent.length > 0, "the reply push");
		expect(sent).toHaveLength(1);
		expect(sent[0]!.committed).toBe(true);
		expect(sent[0]!.message).toMatchObject({ threadId: created.thread.id, body: "Paris.", title: "What is the capital of France?" });
	});

	it("INT-03 every notice pushes and opens its thread", async () => {
		await start();
		await subscribe();
		const sent: PushMessage[] = [];
		setPushTransport(t!.runtime, async (_subscription, message) => {
			sent.push(message);
		});
		const notice = await postNotice(t!.runtime, { body: "Budget warning" });
		await until(() => sent.length > 0, "the notice push");
		expect(sent[0]).toMatchObject({ threadId: notice.thread.id, body: "Budget warning" });
	});

	it("INT-03 a failed push does not roll back the message", async () => {
		await start();
		await subscribe();
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		let attempts = 0;
		setPushTransport(t!.runtime, async () => {
			attempts++;
			throw Object.assign(new Error("push service down"), { statusCode: 503 });
		});
		const notice = await postNotice(t!.runtime, { body: "still here" });
		await until(() => attempts > 0, "the push attempt");
		expect(committedMessage(t!.dir, notice.message.id)).toBe(true);
		const read = await t!.client.get<{ messages: Array<{ body: string }> }>(`/threads/${notice.thread.id}`);
		expect(read.body.messages.map((m) => m.body)).toEqual(["still here"]);
		expect(errors.mock.calls.some((call) => String(call[0]).includes("push failed"))).toBe(true);
	});

	it("INT-03 WEB-06 pi-durable commits stream the session transcript through /events", async () => {
		await start([{ toolCalls: [{ name: "bash", args: { command: "echo streamed-tool-output" } }] }, { text: "streamed answer" }]);
		const stream = openSse(t!.panad.tcpPort!, t!.panad.webToken);
		try {
			await until(() => stream.text().includes("event: hello"), "the hello frame");
			const created = await createSession({ prompt: "stream please" });
			await until(() => stream.text().includes("streamed answer"), "the answer entry");
			const entries = stream
				.frames()
				.filter((frame) => frame.kind === "session.entry" && frame.sessionId === created.session.id)
				.map((frame) => frame.entry as { id: number; kind: string });
			expect(entries.length).toBeGreaterThanOrEqual(3);
			const ids = entries.map((entry) => entry.id);
			expect([...ids].sort((a, b) => a - b)).toEqual(ids);
			expect(entries.map((entry) => entry.kind)).toContain("pana.message");
			expect(entries.map((entry) => entry.kind)).toContain("pi.assistant");
			expect(stream.text()).toContain("streamed-tool-output");

			// The live entries match what the transcript route returns.
			const transcript = await t!.client.get<{ entries: Array<{ id: number; kind: string }> }>(`/sessions/${created.session.id}/transcript`);
			const routeIds = transcript.body.entries.map((entry) => entry.id);
			for (const id of ids) expect(routeIds).toContain(id);
		} finally {
			stream.close();
		}
	});
});

describe("INT-06 docs", () => {
	it("INT-06 README's Run it section covers config.json, panad, the service, the CLI, and the PWA, with a model panad can run", async () => {
		const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
		const start = readme.indexOf("## Run it");
		expect(start).toBeGreaterThan(-1);
		const section = readme.slice(start, readme.indexOf("\n## ", start + 1));
		for (const needle of ["config.json", "pana/bin/panad", "launchctl bootstrap", "panad.service", "pana session create", "launch URL", "tailscale serve", "scripts/smoke"]) {
			expect(section).toContain(needle);
		}
		const config = JSON.parse(/```json\n([\s\S]*?)```/.exec(section)![1]!) as { defaultModel: string };
		expect(hasModel(await createProviderModels({ FIREWORKS_API_KEY: "fw-test" }), config.defaultModel)).toBe(true);
		const service = readFileSync(new URL("../../bin/panad-service", import.meta.url), "utf8");
		expect(/default_secrets='([^']*)'/.exec(service)![1]!.split(" ")).toContain("FIREWORKS_API_KEY");
	});
});
