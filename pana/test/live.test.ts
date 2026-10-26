// WP13: work in progress in the session view (UX-12) and the transcript renderer (UX-11). The
// browser checks live in test/browser/live.spec.ts; this file covers the server's `session.live`
// events and the PWA's pure view functions.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sessionRuntime } from "../src/sessions/index.ts";
import { activityOf, LIVE_INTERVAL_MS, LIVE_OUTPUT_BYTES, type LiveView, type SessionLiveEvent } from "../src/sessions/live.ts";
import { subscribeEvents, subscriberCount, type WebEvent } from "../src/web/events.ts";
import { startTestPanad, type TestPanad } from "./harness/index.ts";
import { elapsedLabel, entryRaw, entryView, liveActivityLabel } from "../web/views.js";

const MODEL = { defaultModel: "faux/faux-1", timezone: "UTC" };

let t: TestPanad | undefined;
const dirs: string[] = [];
afterEach(async () => {
	await t?.close();
	t = undefined;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pana-live-"));
	dirs.push(dir);
	return dir;
}

/** An in-process `/events` subscriber: every frame the hub writes, parsed, in order. */
function events(t: TestPanad): { frames: WebEvent[]; close: () => void } {
	const frames: WebEvent[] = [];
	const handlers: Array<() => void> = [];
	const res = {
		write(chunk: string) {
			for (const frame of chunk.split("\n\n")) {
				const line = frame.split("\n").find((row) => row.startsWith("data:"));
				if (line) frames.push(JSON.parse(line.slice(5).trim()) as WebEvent);
			}
			return true;
		},
		on(name: string, handler: () => void) {
			if (name === "close") handlers.push(handler);
			return this;
		},
	} as unknown as ServerResponse;
	subscribeEvents(t.runtime, res);
	return { frames, close: () => handlers.forEach((handler) => handler()) };
}

function lives(frames: WebEvent[], sessionId: string): SessionLiveEvent[] {
	return frames.filter((frame): frame is SessionLiveEvent => frame.kind === "session.live" && frame.sessionId === sessionId);
}

/** Step the fake clock until `check` holds, letting pi-durable's 100 ms progress commits land. */
async function until<T>(check: () => T | undefined | false | Promise<T | undefined | false>, what: string, stepMs = 50): Promise<T> {
	const end = Date.now() + 15_000;
	for (;;) {
		await t!.clock.advance(stepMs);
		await sessionRuntime(t!.runtime).idle();
		const value = await check();
		if (value) return value;
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

interface Created {
	session: { id: string; url: string };
	thread: { id: string };
}

describe("UX-12 live work in progress", () => {
	it("UX-12 a run streams its partial answer and running tool calls as throttled session.live events, then null", async () => {
		const dir = tempDir();
		const command = `echo started; while [ ! -f "${dir}/go" ]; do sleep 0.05; done; echo finished`;
		t = await startTestPanad({
			config: MODEL,
			script: [{ thinking: "Plan the check.", text: "Looking now.", toolCalls: [{ name: "bash", args: { command } }] }, { text: "all done" }],
		});
		const watch = events(t);
		const release = t.model.gate({ at: "end" });
		const res = await t.client.post<Created>("/sessions", { prompt: "check it", cwd: dir });
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		const sessionId = res.body.session.id;

		// The answer is held open after streaming: its partial carries thinking, text, and the call.
		const partial = await until(
			() => lives(watch.frames, sessionId).find((event) => (event.live?.generation?.blocks.length ?? 0) >= 3),
			"the partial answer",
		);
		expect(partial.url).toBe(res.body.session.url);
		expect(partial.live!.generation!.blocks).toEqual([
			{ type: "thinking", text: "Plan the check." },
			{ type: "text", text: "Looking now." },
			{ type: "toolCall", name: "bash", arguments: { command } },
		]);
		expect(partial.live!.activity).toBe("calling bash");

		// The answer lands; the tool runs, with its full arguments, start time, and streamed output.
		release();
		const running = await until(
			() => lives(watch.frames, sessionId).find((event) => event.live?.tools.some((tool) => tool.status === "running" && tool.output?.includes("started"))),
			"the running tool",
		);
		const tool = running.live!.tools[0]!;
		expect(tool).toMatchObject({ name: "bash", status: "running", arguments: { command } });
		expect(tool.startedAt).toBeTypeOf("number");
		expect(running.live!.activity).toBe("running bash");
		expect(running.live!.since).toBe(tool.startedAt);
		// The partial answer is gone: the assistant entry committed before the tool started.
		expect(running.live!.generation).toBeUndefined();
		const entryIndex = watch.frames.findIndex((frame) => frame.kind === "session.entry" && (frame.entry as { kind: string }).kind === "pi.assistant");
		expect(entryIndex).toBeGreaterThanOrEqual(0);
		expect(entryIndex).toBeLessThan(watch.frames.indexOf(running));

		// A window that opens now reads the same state from the routes.
		await t.clock.advance(180_000);
		const shown = (await t.client.get<{ session: { live: LiveView | null } }>(`/sessions/${sessionId}`)).body.session.live!;
		expect(shown.activity).toBe("running bash");
		expect(shown.tools[0]!.arguments).toEqual({ command });
		const thread = (
			await t.client.get<{ thread: { participants: Array<{ id: string; activity?: { activity: string; since: number; at: number } }> } }>(
				`/threads/${res.body.thread.id}`,
			)
		).body.thread;
		const activity = thread.participants.find((participant) => participant.id === sessionId)!.activity!;
		expect(activity.activity).toBe("running bash");
		expect(activity.at - activity.since).toBeGreaterThanOrEqual(180_000);
		expect(liveActivityLabel(activity, activity.at)).toBe("running bash · 3m");

		// The run ends: the last event clears the live state, after the committed entries.
		writeFileSync(join(dir, "go"), "");
		await until(async () => {
			const last = lives(watch.frames, sessionId).at(-1);
			return last?.live === null && (await t!.client.get<{ session: { state: string } }>(`/sessions/${sessionId}`)).body.session.state === "idle";
		}, "the run to end");
		const finalLive = watch.frames.lastIndexOf(lives(watch.frames, sessionId).at(-1)!);
		const lastEntry = watch.frames.findLastIndex((frame) => frame.kind === "session.entry");
		expect(lastEntry).toBeLessThan(finalLive);
		expect((await t.client.get<{ session: { live: LiveView | null } }>(`/sessions/${sessionId}`)).body.session.live).toBeNull();

		// Throttled: one session never publishes twice within the interval.
		const times = lives(watch.frames, sessionId).map((event) => event.at as number);
		for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(LIVE_INTERVAL_MS);
		watch.close();
	});

	it("UX-12 nothing is published or built while no window is subscribed", async () => {
		const dir = tempDir();
		t = await startTestPanad({ config: MODEL, script: [{ toolCalls: [{ name: "bash", args: { command: "echo hi" } }] }, { text: "done" }] });
		expect(subscriberCount(t.runtime)).toBe(0);
		const published: WebEvent[] = [];
		const res = await t.client.post<Created>("/sessions", { prompt: "go", cwd: dir });
		await until(async () => (await t!.client.get<{ session: { state: string } }>(`/sessions/${res.body.session.id}`)).body.session.state === "idle", "idle");
		// A subscriber that joins afterwards hears no stale live state for the finished run.
		const watch = events(t);
		await t.clock.advance(1000);
		await sessionRuntime(t.runtime).idle();
		published.push(...lives(watch.frames, res.body.session.id));
		expect(published).toEqual([]);
		watch.close();
	});

	it("UX-12 the activity names the running tool, and the chip label carries its elapsed time", () => {
		const base = { compacting: false, startedAt: 1_000 };
		expect(activityOf({ ...base, tools: [{ callId: "a", name: "bash", status: "running", startedAt: 5_000 }] })).toEqual({ activity: "running bash", since: 5_000 });
		expect(
			activityOf({
				...base,
				tools: [
					{ callId: "a", name: "bash", status: "running", startedAt: 5_000 },
					{ callId: "b", name: "read", status: "running" },
				],
			}).activity,
		).toBe("running bash +1");
		expect(activityOf({ ...base, tools: [], generation: { attempt: 1, blocks: [{ type: "thinking", text: "x" }] } }).activity).toBe("thinking");
		expect(activityOf({ ...base, tools: [], generation: { attempt: 1, blocks: [{ type: "text", text: "x" }] } }).activity).toBe("writing");
		expect(activityOf({ ...base, tools: [], generation: { attempt: 2, blocks: [], retryAt: 9, retryError: "429" } }).activity).toBe("waiting to retry");
		expect(activityOf({ ...base, tools: [], compacting: true }).activity).toBe("compacting");
		expect(activityOf({ ...base, tools: [] }).activity).toBe("working");

		expect(elapsedLabel(0)).toBe("0s");
		expect(elapsedLabel(42_000)).toBe("42s");
		expect(elapsedLabel(3 * 60_000 + 5_000)).toBe("3m");
		expect(elapsedLabel(65 * 60_000)).toBe("1h 5m");
		expect(liveActivityLabel({ activity: "thinking" }, 10)).toBe("thinking");
		expect(liveActivityLabel({ activity: "running bash", since: 0 }, 13 * 60_000)).toBe("running bash · 13m");
		expect(LIVE_OUTPUT_BYTES).toBeGreaterThan(0);
	});
});

describe("UX-11 transcript Markdown and raw source", () => {
	it("UX-11 assistant text and thinking are Markdown blocks, and the raw source keeps every character", () => {
		const entry = {
			id: 7,
			kind: "pi.assistant",
			model: [
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "Think **hard**.\n<!-- hidden note -->" },
						{ type: "text", text: "# Title\n\n<script>alert(1)</script>[link](pana://test.example/sessions/01J00000000000000000000000)" },
						{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
					],
				},
			],
		};
		const view = entryView(entry);
		expect(view.blocks.map((block: { type: string; markdown?: boolean }) => [block.type, Boolean(block.markdown)])).toEqual([
			["thinking", true],
			["text", true],
			["tool-call", false],
		]);
		const raw = entryRaw(entry);
		expect(raw).toContain("Think **hard**.\n<!-- hidden note -->");
		expect(raw).toContain("<script>alert(1)</script>[link](pana://test.example/sessions/01J00000000000000000000000)");
		expect(raw).toContain('"command": "ls"');

		// User and tool text stay plain: only the model's own prose is Markdown.
		const user = entryView({ id: 1, kind: "pi.user", model: [{ role: "user", content: "**not** markdown" }] });
		expect(user.blocks[0]).toEqual({ type: "text", text: "**not** markdown" });
		// An entry with only data shows that data raw too.
		expect(entryRaw({ id: 2, kind: "pana.note", data: { a: 1 } })).toContain('"a": 1');
	});
});
