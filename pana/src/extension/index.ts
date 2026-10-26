// The pana pi-durable extension (WP4): system prompt sections, pana tools, the clean session
// environment, and the git hook directory. `createPanaRegistry` is what panad installs.

import { createRegistry, defineExtension, type Extension, type Registry } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { Runtime } from "../server/runtime.ts";
import { createPanaSections } from "./prompt.ts";
import { createPanaTools } from "./tools.ts";

export { createPanaEnv, PanaExecutionEnv, panaShellEnv, PANA_ENV_NAMES } from "./env.ts";
export { HOOK_DOMAIN_FILE, HOOK_RUNNER, STANDARD_HOOKS, commitTrailer, installGitHooks } from "./hooks.ts";
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
	});
}

/** panad's registry: `CodingTools` first, then `pana`, and nothing else (ISO-01). */
export function createPanaRegistry(getRuntime: () => Runtime): Registry {
	const registry = createRegistry();
	registry.install(CodingTools);
	registry.install(createPanaExtension(getRuntime));
	return registry;
}
