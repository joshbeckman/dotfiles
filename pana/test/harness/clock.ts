// A fake clock for pi-durable (`now`, `setTimer`) and pana's own timers (TST-03).
//
// Time moves only through `advance(ms)`. A timer that is already due, such as a zero-delay
// pacing timer, fires on the next macrotask without an advance, so a run never stalls waiting
// for a test to move time.

import type { Clock } from "../../src/server/runtime.ts";

interface Timer {
	seq: number;
	at: number;
	callback: () => void;
}

export interface FakeClock extends Clock {
	/** Move time forward, firing every timer due by the new time in order, and let the work they start settle. */
	advance(ms: number): Promise<void>;
	/** Move time to an absolute epoch-millisecond time. */
	advanceTo(at: number): Promise<void>;
	/** Let due timers and pending async work run without moving time. */
	settle(): Promise<void>;
	/** Timers armed and not yet fired. */
	pending(): number;
}

/** Default start time: a fixed instant so tests are deterministic. */
export const FAKE_EPOCH = Date.UTC(2026, 0, 5, 9, 0, 0);

export function createFakeClock(start = FAKE_EPOCH): FakeClock {
	let current = start;
	let seq = 0;
	const timers = new Map<number, Timer>();
	let drainScheduled = false;

	const nextDue = (limit: number): Timer | undefined => {
		let best: Timer | undefined;
		for (const timer of timers.values()) {
			if (timer.at > limit) continue;
			if (!best || timer.at < best.at || (timer.at === best.at && timer.seq < best.seq)) best = timer;
		}
		return best;
	};

	const fireDue = () => {
		for (let timer = nextDue(current); timer; timer = nextDue(current)) {
			timers.delete(timer.seq);
			timer.callback();
		}
	};

	const scheduleDrain = () => {
		if (drainScheduled) return;
		drainScheduled = true;
		setImmediate(() => {
			drainScheduled = false;
			fireDue();
		});
	};

	const ticks = async (n: number) => {
		for (let i = 0; i < n; i++) await new Promise<void>((resolve) => setImmediate(resolve));
	};

	const settle = async () => {
		// SQLite work in the adapter is synchronous, so a handful of macrotasks drains a commit chain.
		for (let round = 0; round < 50; round++) {
			await ticks(5);
			if (!nextDue(current)) return;
			fireDue();
		}
	};

	const clock: FakeClock = {
		now: () => current,
		setTimer: (callback, delayMs, options) => {
			// Background timers only free memory; declining them is allowed and keeps tests quiet.
			if (options?.background) return undefined;
			const timer: Timer = { seq: seq++, at: current + Math.max(0, delayMs), callback };
			timers.set(timer.seq, timer);
			if (timer.at <= current) scheduleDrain();
			return () => {
				timers.delete(timer.seq);
			};
		},
		advance: (ms) => clock.advanceTo(current + ms),
		advanceTo: async (target) => {
			await settle();
			for (let timer = nextDue(target); timer; timer = nextDue(target)) {
				timers.delete(timer.seq);
				current = Math.max(current, timer.at);
				timer.callback();
				await settle();
			}
			current = Math.max(current, target);
			await settle();
		},
		settle,
		pending: () => timers.size,
	};
	return clock;
}
