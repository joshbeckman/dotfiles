// WP17: sessions schedule their own wakeups instead of sleeping in bash (WAK-01..WAK-06).

import { afterEach, describe, expect, it } from "vitest";
import { runPanaCommand } from "../src/cli/commands.ts";
import { fillPrompt, promptTemplate } from "../src/extension/prompt.ts";
import { longestSleep, MAX_SLEEP_SEC } from "../src/extension/bash.ts";
import { sessionRuntime } from "../src/sessions/index.ts";
import { createFakeClock, FAKE_EPOCH, startTestPanad, type Script, type TestPanad } from "./harness/index.ts";

let t: TestPanad | undefined;
afterEach(async () => {
	await t?.close();
	t = undefined;
});

const MINUTE = 60_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function start(script: Script = [], extra: Parameters<typeof startTestPanad>[0] = {}): Promise<TestPanad> {
	t = await startTestPanad({ script, config: { defaultModel: "faux/faux-1", timezone: "UTC" }, ...extra });
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

interface Created {
	session: { id: string; conversationId: number };
	thread: { id: string };
}

/** A real session whose first run has answered. */
async function session(): Promise<Created> {
	const created = await t!.client.post<Created>("/sessions", { prompt: "watch PR 75" });
	expect(created.status, JSON.stringify(created.body)).toBe(201);
	await settled(created.body.session.id);
	return created.body;
}

async function wake(caller: string | undefined, params: Record<string, string>) {
	return runPanaCommand("schedule wake", params, { endpoint: { socketPath: t!.panad.socketPath }, ...(caller ? { caller } : {}) });
}

async function messageCount(threadId: string): Promise<number> {
	return (await t!.runtime.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?", threadId))!.n;
}

async function wakeEntries(sessionId: string): Promise<Array<{ kind: string; data?: unknown }>> {
	const transcript = await t!.client.get<{ entries: Array<{ kind: string; data?: unknown }> }>(`/sessions/${sessionId}/transcript`);
	return transcript.body.entries.filter((entry) => entry.kind === "pana.wake");
}

/** The pending wakes `pana schedule list --kind wake` shows, by id and state. */
async function listedWakes(): Promise<Array<{ id: string; state: string }>> {
	const listed = await runPanaCommand("schedule list", { kind: "wake" }, { endpoint: { socketPath: t!.panad.socketPath } });
	const body = listed.body as { schedules: Array<{ id: string; state: string }> };
	return body.schedules.map((schedule) => ({ id: schedule.id, state: schedule.state }));
}

describe("WAK-01 scheduling a wake", () => {
	it("WAK-01 a session wakes itself with --in; only the user names another session", async () => {
		await start([{ text: "watching" }, { text: "watching" }]);
		const own = await session();
		const other = await session();

		const scheduled = await wake(own.session.id, { in: "10m", note: "Check CI on PR 75" });
		expect(scheduled.exitCode, JSON.stringify(scheduled.body)).toBe(0);
		expect(scheduled.body).toMatchObject({
			schedule: { kind: "wake", state: "active", at: t!.clock.now() + 10 * MINUTE, payload: { session: own.session.id, note: "Check CI on PR 75" } },
		});

		const meddling = await wake(own.session.id, { in: "10m", note: "x", session: other.session.id });
		expect(meddling.status).toBe(403);

		const unnamed = await wake(undefined, { in: "10m", note: "x" });
		expect(unnamed.status).toBe(400);
		const byUser = await wake(undefined, { in: "1h", note: "x", session: other.session.id });
		expect(byUser.exitCode, JSON.stringify(byUser.body)).toBe(0);

		expect((await wake(own.session.id, { in: "soon", note: "x" })).status).toBe(400);
		const cron = await t!.client.post("/schedules", { kind: "wake", cron: "* * * * *", note: "x" }, { caller: own.session.id });
		expect(cron.status).toBe(400);
		expect((await t!.client.post("/schedules", { kind: "wake", in: "5m" }, { caller: own.session.id })).status).toBe(400);

		await runPanaCommand("session archive", { id: other.session.id }, { endpoint: { socketPath: t!.panad.socketPath } });
		expect((await wake(undefined, { in: "1h", note: "x", session: other.session.id })).status).toBe(409);
	});
});

describe("WAK-02 a wake fires", () => {
	it("WAK-02 the note reaches the session as input, it runs, and nothing is posted for it", async () => {
		await start([{ text: "I will check back" }, { text: "CI is green" }]);
		const created = await session();
		const id = created.session.id;
		const before = await messageCount(created.thread.id);

		expect((await wake(id, { in: "10m", note: "Check CI on PR 75; reply in the thread" })).exitCode).toBe(0);
		await t!.clock.advance(9 * MINUTE);
		expect(await wakeEntries(id)).toEqual([]);

		await t!.clock.advance(MINUTE);
		expect(await settled(id)).toBe("idle");
		const entries = await wakeEntries(id);
		expect(entries).toHaveLength(1);
		expect(t!.model.calls()).toBe(2);
		expect(JSON.stringify(entries)).toContain("Check CI on PR 75; reply in the thread");
		expect(await messageCount(created.thread.id)).toBe(before);
	});

	it("WAK-02 a stopped session is not woken", async () => {
		await start([{ text: "ok" }]);
		const created = await session();
		await t!.client.post(`/sessions/${created.session.id}/stop`);
		expect((await wake(undefined, { in: "5m", note: "x", session: created.session.id })).exitCode).toBe(0);
		await t!.clock.advance(5 * MINUTE);
		await settled(created.session.id);
		expect(await wakeEntries(created.session.id)).toEqual([]);
		expect(t!.model.calls()).toBe(1);
	});
});

describe("WAK-03 a missed wake", () => {
	it("WAK-03 a wake that came due while panad was down fires at startup", async () => {
		const clock = createFakeClock();
		await start([{ text: "ok" }, { text: "woke late" }], { clock });
		const created = await session();
		expect((await wake(created.session.id, { in: "10m", note: "late is better than never" })).exitCode).toBe(0);
		const dir = t!.dir;
		const model = t!.model;
		await t!.stop();
		await clock.advanceTo(FAKE_EPOCH + 60 * MINUTE);

		t = await startTestPanad({ stateDir: dir, clock, model, config: { defaultModel: "faux/faux-1", timezone: "UTC" } });
		expect(await settled(created.session.id)).toBe("idle");
		expect(await wakeEntries(created.session.id)).toHaveLength(1);
	});
});

describe("WAK-07 a wake that fires is spent", () => {
	it("WAK-07 a delivered wake is deleted, so the list shows only pending wakes", async () => {
		await start([{ text: "I will check back" }, { text: "CI is green" }]);
		const created = await session();
		const scheduled = await wake(created.session.id, { in: "10m", note: "Check CI on PR 75" });
		const id = (scheduled.body as { schedule: { id: string } }).schedule.id;

		expect(await listedWakes()).toHaveLength(1);
		await t!.clock.advance(10 * MINUTE);
		expect(await settled(created.session.id)).toBe("idle");
		expect(await wakeEntries(created.session.id)).toHaveLength(1);

		expect(await listedWakes()).toEqual([]);
		expect((await t!.client.get(`/schedules/${id}`)).status).toBe(404);
		expect((await t!.client.delete(`/schedules/${id}`)).status).toBe(404);
		expect(await t!.runtime.db.get("SELECT state, next_at FROM schedules WHERE id = ?", id)).toEqual({ state: "deleted", next_at: null });
	});

	it("WAK-07 a wake that reached no session keeps its row as done", async () => {
		await start([{ text: "ok" }]);
		const created = await session();
		await t!.client.post(`/sessions/${created.session.id}/stop`);
		const scheduled = await wake(undefined, { in: "5m", note: "x", session: created.session.id });
		const id = (scheduled.body as { schedule: { id: string } }).schedule.id;

		await t!.clock.advance(5 * MINUTE);
		await settled(created.session.id);
		expect(await wakeEntries(created.session.id)).toEqual([]);
		expect(await listedWakes()).toEqual([{ id, state: "done" }]);
	});
});

describe("WAK-05 WAK-06 no sleeping in bash", () => {
	it("WAK-06 longestSleep finds the longest sleep in a command", () => {
		expect(longestSleep("sleep 180; cd /tmp/pana-pr; gw pr checks 75")).toBe(180);
		expect(longestSleep("make && sleep 3m")).toBe(180);
		expect(longestSleep("sleep 1m 30s")).toBe(90);
		expect(longestSleep("sleep 2 && sleep 59")).toBe(59);
		expect(longestSleep("until curl -s localhost:3000; do sleep 1; done")).toBe(1);
		expect(longestSleep("echo nosleep 300; gsleep 100")).toBe(0);
	});

	it("WAK-06 bash refuses a command that sleeps a minute or more, and names the wake", async () => {
		await start([
			{ toolCalls: [{ name: "bash", args: { command: "sleep 180; echo waited" } }] },
			{ toolCalls: [{ name: "bash", args: { command: "sleep 0.1; echo short" } }] },
			{ text: "ok" },
		]);
		const created = await session();
		const transcript = await t!.client.get<{ entries: Array<{ kind: string }> }>(`/sessions/${created.session.id}/transcript`);
		const results = JSON.stringify(transcript.body.entries.filter((entry) => entry.kind === "pi.tool-result"));
		expect(results).toContain("sleeps 180 seconds");
		expect(results).toContain("pana schedule wake");
		expect(results).not.toContain("waited");
		expect(results).toContain("short");
	});

	it("WAK-05 the prompt says to schedule a wake instead of waiting", () => {
		const text = fillPrompt(promptTemplate(), { sessionUrl: "u", memoryPath: "m", domain: "d" });
		expect(text).toContain("## Waiting");
		expect(text).toContain("pana_schedule_wake");
		expect(text).toContain(`sleeps for ${MAX_SLEEP_SEC} seconds or more`);
		expect(text).not.toContain("{{");
	});
});
