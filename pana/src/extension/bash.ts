// ISO-05: every `bash` call has a time limit.
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

export function bashTimeoutWrap(getRuntime: () => Runtime): Wrap {
	const wrap = wrapTool(createBashTool(), (bash) => ({
		...bash,
		description: `${bash.description} Without one, pana stops the command after its default limit.`,
		parameters: withTimeoutDescription(bash.parameters),
		async execute(args, api, context) {
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
