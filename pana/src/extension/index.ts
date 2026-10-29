// The pana pi-durable extension (WP4): system prompt sections, pana tools, the clean session
// environment, and the git hook directory. `createPanaRegistry` is what panad installs.

import { createRegistry, defineExtension, type Extension, type Registry } from "@earendil-works/pi-durable";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import type { Runtime } from "../server/runtime.ts";
import { createSessionHooks } from "../sessions/reply.ts";
import { nodeImages } from "./images.ts";
import { bashTimeoutWrap } from "./bash.ts";
import { createPanaSections } from "./prompt.ts";
import { createPanaTools } from "./tools.ts";

export { createPanaEnv, PanaExecutionEnv, panaShellEnv, PANA_ENV_NAMES } from "./env.ts";
// The command layer lives in src/cli/commands.ts so the CLI and the pana tools share one
// definition. Re-exported here, where WP4's callers already look for it.
export {
	CommandUsageError,
	PANA_COMMANDS,
	commandForTool,
	commandName,
	isCommandName,
	runPanaCli,
	runPanaCommand,
	usageFor,
	type CommandOutcome,
	type CommandParams,
	type CommandSpec,
	type PanaCommandName,
	type PanaToolName,
} from "../cli/commands.ts";
export { agentsFiles, fillPrompt, promptTemplate, PROMPT_PATH } from "./prompt.ts";

export const PANA_EXTENSION_NAME = "pana";
export const CODING_EXTENSION_NAME = "coding-tools";

/**
 * The `pana` extension: the six pana tools and the two prompt sections (ISO-01, TOL-01).
 * It carries nothing from `~/.pi/agent`; the registry installs it beside `CodingTools` only.
 */
export function createPanaExtension(getRuntime: () => Runtime): Extension {
	return defineExtension({
		name: PANA_EXTENSION_NAME,
		tools: createPanaTools(getRuntime),
		sections: createPanaSections(getRuntime),
		// WP3: the auto-posted reply runs where the pana tools do, so a session's extension
		// selection cannot drop one without the other.
		hooks: createSessionHooks(getRuntime),
		// ISO-05: the time limit decorates CodingTools' `bash`, so the registry keeps its two extensions.
		wraps: [bashTimeoutWrap(getRuntime)],
	});
}

/** panad's registry: `CodingTools` first, then `pana`, and nothing else (ISO-01). */
export function createPanaRegistry(getRuntime: () => Runtime): Registry {
	const registry = createRegistry();
	registry.install(createCodingTools({ images: nodeImages }));
	registry.install(createPanaExtension(getRuntime));
	return registry;
}
