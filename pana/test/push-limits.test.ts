import { describe, expect, it } from "vitest";
import { PUSH_CONCURRENCY, PUSH_QUEUE_LIMIT, withPushSlot } from "../src/push/limits.ts";

describe("process-wide push limit", () => {
	it("holds slots for actual work, removes cancelled waiters, and bounds the queue", async () => {
		const controller = new AbortController();
		const releases: Array<() => void> = [];
		let started = 0;
		const work = () => { started++; return new Promise<void>((resolve) => releases.push(resolve)); };
		const active = Array.from({ length: PUSH_CONCURRENCY }, () => withPushSlot(controller.signal, work));
		expect(started).toBe(PUSH_CONCURRENCY);
		const waiting = Array.from({ length: PUSH_QUEUE_LIMIT }, () => withPushSlot(controller.signal, work));
		await expect(withPushSlot(controller.signal, work)).rejects.toThrow("queue is full");
		// These transports ignore abort, so they must still occupy their slots.
		controller.abort(new Error("deadline"));
		const outcomes = await Promise.allSettled(waiting);
		expect(outcomes.every((outcome) => outcome.status === "rejected")).toBe(true);
		let nextStarted = false;
		const next = withPushSlot(new AbortController().signal, async () => { nextStarted = true; });
		await Promise.resolve();
		expect(nextStarted).toBe(false);
		releases[0]!();
		await next;
		expect(nextStarted).toBe(true);
		for (const release of releases.slice(1)) release();
		await Promise.all(active);
	});
});
