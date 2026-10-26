import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTask, defineTool } from "@earendil-works/pi-durable";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FAKE_EPOCH, FAUX_MODEL, startTestPanad, TEST_DOMAIN, type TestPanad } from "./harness/index.ts";

let t: TestPanad | undefined;
afterEach(async () => {
	await t?.close();
	t = undefined;
});

const echo = defineTool({
	name: "echo",
	description: "Echo text",
	parameters: Type.Object({ text: Type.String() }),
	execute: async (args) => ({ output: [{ type: "text", text: `echo: ${args.text}` }] }),
});

const Reminder = defineTask<{ at: number }, { phase: "wait" } | { phase: "deliver" }, { firedAt: number }>({
	name: "test.reminder",
	version: 1,
	initial: () => ({ phase: "wait" }),
	phases: {
		wait: (task, runtime, context) => runtime.sleepUntil(task.input.at, { phase: "deliver" }, context),
		deliver: async (_task, runtime, context) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: { firedAt: runtime.now() } } }), context);
		},
	},
	abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

function testRegistry() {
	const registry = createRegistry();
	registry.install(defineExtension({ name: "test", tools: [echo], tasks: [Reminder] }));
	return registry;
}

describe("test harness", () => {
	it("TST-01 startTestPanad returns a running panad on a temp dir with a fake clock, a faux model, and a socket client", async () => {
		t = await startTestPanad({ script: [{ text: "Paris" }] });

		expect(t.dir.startsWith(tmpdir()) || t.dir.startsWith("/private" + tmpdir())).toBe(true);
		expect(t.dir).not.toContain(join(homedir(), ".local", "state", "pana"));
		expect(t.runtime.config.domain).toBe(TEST_DOMAIN);
		expect(t.runtime.clock).toBe(t.clock);
		expect(t.clock.now()).toBe(FAKE_EPOCH);

		// The socket client reaches panad: an unbuilt route answers with the contract's error shape.
		const res = await t.client.get("/inbox");
		expect(res.status).toBe(501);
		expect(res.body).toMatchObject({ error: { code: "not_implemented", route: "inbox.list" } });

		// The faux model answers through the Harness.
		const root = await t.runtime.harness.root(ctx, { agent: { model: FAUX_MODEL } });
		const settled = await (await root.submit({ type: "input", content: "capital of France?" }, ctx)).wait(ctx);
		expect(settled.status).toBe("done");
		expect(t.model.calls()).toBe(1);
	});

	it("TST-02 a faux script returns text, tool calls, failures, and usage with cost, per turn", async () => {
		t = await startTestPanad({
			registry: testRegistry(),
			script: [
				{ toolCalls: [{ name: "echo", args: { text: "hi" } }], usage: { input: 10, output: 5, costUsd: 0.5 } },
				{ text: "done", usage: { input: 20, output: 3, costUsd: 0.25 } },
				{ fail: "model exploded", usage: { costUsd: 0.125 } },
			],
		});
		const root = await t.runtime.harness.root(ctx, { agent: { model: FAUX_MODEL } });

		const first = await (await root.submit({ type: "input", content: "say hi" }, ctx)).wait(ctx);
		expect(first.status).toBe("done");
		const page = await root.entries({ order: "ascending" }, 100, undefined, ctx);
		const kinds = page.items.map((entry) => entry.kind);
		expect(kinds).toContain("pi.tool-result");
		const toolResult = page.items.find((entry) => entry.kind === "pi.tool-result");
		expect(JSON.stringify(toolResult)).toContain("echo: hi");
		const answer = page.items.filter((entry) => entry.kind === "pi.assistant").at(-1);
		expect(JSON.stringify(answer)).toContain("done");

		const second = await (await root.submit({ type: "input", content: "again" }, ctx)).wait(ctx);
		expect(second.status).toBe("unanswered");

		const usage = await t.runtime.harness.usage(ctx);
		const total = usage.models[`${FAUX_MODEL.provider}/${FAUX_MODEL.modelId}`];
		expect(total?.cost.total).toBeCloseTo(0.875);
		expect(total?.input).toBe(30);
		expect(total?.output).toBe(8);
	});

	it("TST-03 clock.advance(ms) fires due pi-durable sleeps and pana timers", async () => {
		t = await startTestPanad({ registry: testRegistry() });
		const { harness, clock } = t.runtime;
		const root = await harness.root(ctx, { agent: { model: FAUX_MODEL } });

		const due = t.clock.now() + 60_000;
		const taskId = await root.commit((tx) => tx.createTask(Reminder, { at: due }, { ownership: { kind: "conversation" } }), ctx);

		// A pana timer, as WP6 schedules will arm, on the same clock.
		const fired: number[] = [];
		clock.setTimer(() => fired.push(clock.now()), 30_000, { background: false });

		await t.clock.advance(29_999);
		expect(fired).toEqual([]);
		expect((await harness.getTask(taskId, ctx))?.state.status).not.toBe("terminal");

		await t.clock.advance(1);
		expect(fired).toEqual([FAKE_EPOCH + 30_000]);
		expect((await harness.getTask(taskId, ctx))?.state.status).not.toBe("terminal");

		await t.clock.advance(30_000);
		const settled = await harness.waitForTask(taskId, ctx);
		expect(settled.state.outcome).toEqual({ status: "completed", result: { firedAt: due } });
	});
});
