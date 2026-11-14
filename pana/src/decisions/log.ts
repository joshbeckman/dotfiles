// One JSONL line per gate decision in `<state>/decisions.log` (DEC-08, PSH-10), so a threshold can
// be tuned from real traffic instead of a guess. Both gates share the file: the wake gate writes
// `wake.gate` lines and the push gate writes `push.gate` lines, so one reader sees every decision
// the decision model made.
//
// The request log (`panad.log`) belongs to requests and `src/stats/log.ts` reads it as such, so
// gate decisions get their own rotated file. It holds no message text: the decision, the
// probability, and the ids a reader can resolve. It rotates at `logs.maxBytes` and keeps
// `logs.keep`, the same bound as the other logs (OBS-06).

import { join } from "node:path";
import { RotatingLog } from "../logs/index.ts";
import type { Runtime } from "../server/runtime.ts";

export interface GateLogEntry {
	/**
	 * `wake.gate` for a wake decision, `wake.delivered_after_skip` when skipped mail is delivered
	 * late, `push.gate` for a push decision.
	 */
	event: "wake.gate" | "wake.delivered_after_skip" | "push.gate";
	messageId?: string;
	deliveryId?: string;
	recipientId?: string;
	/** Absent on a `failed` line, which has no answer to record. */
	probability?: number;
	decision?: "wake" | "skip" | "push" | "failed";
	/** Why the gate could not answer, on a `failed` line. */
	error?: string;
}

const logs = new WeakMap<Runtime, RotatingLog>();

function logFor(runtime: Runtime): RotatingLog {
	let log = logs.get(runtime);
	if (!log) {
		log = new RotatingLog({
			path: join(runtime.paths.dir, "decisions.log"),
			maxBytes: runtime.config.logs.maxBytes,
			keep: runtime.config.logs.keep,
		});
		logs.set(runtime, log);
	}
	return log;
}

/** Append one line. A failed write is dropped: a full disk must not change a delivery. */
export function logGateDecision(runtime: Runtime, entry: GateLogEntry): void {
	logFor(runtime).append(`${JSON.stringify({ ts: new Date(runtime.clock.now()).toISOString(), ...entry })}\n`);
}
