// ISO-05: every `bash` call has a time limit. WAK-06: and none may sleep for a minute or more.
//
// pi-durable's `bash` runs without a timeout unless the model passes one, so one `grep -r` over
// HOME could hold a run for as long as it liked. The pana extension wraps whichever `bash` won
// and fills in `tools.bashTimeoutSec` when the call names no timeout. The limit stays in the tool
// rather than in `PanaExecutionEnv.exec`: the tool words its error from the timeout it was given,
// so a default applied below it would read "timed out after undefined seconds".
//
// A timeout kills the whole process group. `NodeExecutionEnv` starts each command detached, so
// the shell leads its own group, and its kill is `process.kill(-pid, "SIGKILL")`: a `grep` under
// `bash -c` dies with the shell.

import { wrapTool, type ToolRegistration, type Wrap } from "@earendil-works/pi-durable";
import { createBashTool } from "@earendil-works/pi-durable/tools";
import type { Runtime } from "../server/runtime.ts";

type BashArgs = { command: string; timeout?: number };

const TIMED_OUT = /^Command timed out after /;

/** WAK-06: the longest `sleep` a command may hold. Longer waits belong in a scheduled wake. */
export const MAX_SLEEP_SEC = 60;
const SLEEP = /(?:^|[\s;&|(`])sleep\s+((?:\d+(?:\.\d+)?[smhd]?\s*)+)/g;
const UNIT_SEC = { s: 1, m: 60, h: 3600, d: 86400 } as const;

/**
 * The longest single `sleep` in a command, in seconds. GNU `sleep 1m 30s` sums its arguments.
 *
 * Rejected alternative: refusing every poll loop. `until curl -s localhost:3000; do sleep 1;
 * done` waits for a local server the command itself started, which a wake cannot do; the bash
 * timeout bounds it.
 */
export function longestSleep(command: string): number {
	let longest = 0;
	for (const match of command.matchAll(SLEEP)) {
		let total = 0;
		for (const part of match[1]!.trim().split(/\s+/)) {
			const unit = part.at(-1) as keyof typeof UNIT_SEC;
			total += unit in UNIT_SEC ? Number(part.slice(0, -1)) * UNIT_SEC[unit] : Number(part);
		}
		longest = Math.max(longest, total);
	}
	return longest;
}

function refuseLongSleep(command: string): void {
	const seconds = longestSleep(command);
	if (seconds < MAX_SLEEP_SEC) return;
	throw new Error(
		`pana refused this command: it sleeps ${seconds} seconds. Do not wait inside bash for anything outside your run, ` +
			"such as CI, a review, a deploy, or another session. Schedule a wakeup instead: " +
			'pana_schedule_wake with in "10m" and a note saying what to check and which thread to reply in ' +
			`(CLI: pana schedule wake --in 10m --note TEXT), then end your run. Sleeps under ${MAX_SLEEP_SEC} seconds are allowed.`,
	);
}

export function bashTimeoutWrap(getRuntime: () => Runtime): Wrap {
	const wrap = wrapTool(createBashTool(), (bash) => ({
		...bash,
		description: `${bash.description} Without one, pana stops the command after its default limit.`,
		parameters: withTimeoutDescription(bash.parameters),
		async execute(args, api, context) {
			refuseLongSleep(args.command);
			if (args.timeout !== undefined) return bash.execute(args, api, context);
			const limit = getRuntime().config.tools.bashTimeoutSec;
			try {
				return await bash.execute({ ...args, timeout: limit } satisfies BashArgs, api, context);
			} catch (error) {
				if (error instanceof Error && TIMED_OUT.test(error.message)) {
					throw new Error(
						`Command timed out after ${limit} seconds, pana's default limit for a bash call, and was killed. ` +
							"Scope the command to a smaller directory (never all of HOME), or pass a longer timeout.",
					);
				}
				throw error;
			}
		},
	}));
	return wrap as unknown as Wrap;
}

/** The schema with the `timeout` description corrected: pi-durable's says there is no default. */
function withTimeoutDescription<T extends ToolRegistration["parameters"]>(schema: T): T {
	const properties = (schema as { properties?: Record<string, object> }).properties;
	if (!properties?.timeout) return schema;
	return {
		...schema,
		properties: {
			...properties,
			timeout: { ...properties.timeout, description: "Timeout in seconds (optional; pana applies a default limit)" },
		},
	};
}
