// The bridge from a schedule write to the running scheduler's timer.
//
// A schedule created through the API must arm the timer at once, but the handlers and the store
// must not import the scheduler (the scheduler imports the store). The scheduler registers
// itself against its runtime here, and `notifySchedulesChanged` tells it to re-arm. Keying by
// `Runtime` keeps two panad instances in one process apart.

import type { Runtime } from "../server/runtime.ts";

export interface SchedulerHandle {
	/** Re-read the earliest active time and re-arm the timer. */
	refresh(): void;
}

const running = new WeakMap<Runtime, SchedulerHandle>();

export function registerScheduler(runtime: Runtime, handle: SchedulerHandle): void {
	running.set(runtime, handle);
}

export function unregisterScheduler(runtime: Runtime, handle: SchedulerHandle): void {
	if (running.get(runtime) === handle) running.delete(runtime);
}

/** Called after a schedule is created, updated, or deleted. A no-op without a scheduler. */
export function notifySchedulesChanged(runtime: Runtime): void {
	running.get(runtime)?.refresh();
}
