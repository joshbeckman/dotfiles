// The clean environment a session's `bash` runs in (ISO-03, ISO-04, HOK-01).
//
// pi-durable's `bash` always passes `inheritEnv: true`, which merges panad's `process.env`
// (provider credentials included) under the call's own variables. `PanaExecutionEnv` overrides
// `exec` to drop that inheritance, so the child sees exactly the variables built here.

import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { ExecutionEnv, ShellExecOptions, ShellExecResult, Result, ExecutionError } from "@earendil-works/pi-durable/env";
import type { Context } from "@earendil-works/chord";
import { homedir, userInfo } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { memoryFor } from "../memory/handlers.ts";
import { ensureScratch } from "../scratch/index.ts";
import type { Runtime } from "../server/runtime.ts";
import { browserScope } from "./browser.ts";

/** The only variables a pana session's commands see, besides git's own env-config pair. */
export const PANA_ENV_NAMES = [
	"PATH",
	"HOME",
	"USER",
	"LANG",
	"TERM",
	"PANA_SESSION",
	"PANA_STATE",
	"PANA_SCRATCH",
	"PANA_BROWSER_SESSION",
	"GIT_CONFIG_COUNT",
	"GIT_CONFIG_KEY_0",
	"GIT_CONFIG_VALUE_0",
] as const;

export interface PanaEnvOptions {
	cwd: string;
	/** The session's ULID, exported as `PANA_SESSION`; absent for a conversation that is not a session. */
	sessionId?: string;
	/** Pana's hook directory, set as `core.hooksPath` through `GIT_CONFIG_*` (HOK-01). */
	hooksDir: string;
	/**
	 * panad's state directory, exported as `PANA_STATE` so `pana` inside `bash` reaches this
	 * panad's socket even when it does not run on the default state directory.
	 */
	stateDir?: string;
	/** The session's scratch directory, exported as `PANA_SCRATCH` (SCR-01). */
	scratchDir?: string;
	/** Overrides `HOME`, for a host whose session home differs from panad's. Default: panad's `HOME`. */
	home?: string;
}

export const PANA_BIN = fileURLToPath(new URL("../../bin", import.meta.url));

/** Build the clean environment map. Values come from panad's own environment, never secrets. */
export function panaShellEnv(options: PanaEnvOptions): Record<string, string> {
	const env: Record<string, string> = {
		// pana's own bin comes first, so `pana` in a session is this panad's build, even when no
		// `pana` is installed on panad's PATH.
		PATH: `${PANA_BIN}:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"}`,
		HOME: options.home ?? process.env.HOME ?? fallbackHome(),
		USER: process.env.USER ?? fallbackUser(),
		LANG: process.env.LANG ?? "C.UTF-8",
		TERM: "dumb",
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: "core.hooksPath",
		GIT_CONFIG_VALUE_0: options.hooksDir,
	};
	if (options.sessionId) {
		env.PANA_SESSION = options.sessionId;
		// ISO-06: `bin/chrome-devtools` names this session's browser daemon with it.
		env.PANA_BROWSER_SESSION = browserScope(options.sessionId);
	}
	if (options.stateDir) env.PANA_STATE = options.stateDir;
	if (options.scratchDir) env.PANA_SCRATCH = options.scratchDir;
	return env;
}

function fallbackHome(): string {
	try {
		return userInfo().homedir;
	} catch {
		return "/tmp";
	}
}

function fallbackUser(): string {
	try {
		return userInfo().username;
	} catch {
		return "pana";
	}
}

/** A local environment whose commands see only `panaShellEnv`, never panad's own variables. */
export class PanaExecutionEnv extends NodeExecutionEnv {
	readonly panaEnv: Record<string, string>;

	constructor(options: PanaEnvOptions) {
		super({ cwd: options.cwd });
		this.panaEnv = panaShellEnv(options);
	}

	override exec(
		command: string | readonly string[],
		options: ShellExecOptions | undefined,
		context: Context,
	): Promise<Result<ShellExecResult, ExecutionError>> {
		return super.exec(
			command,
			{
				...options,
				inheritEnv: false,
				env: { ...this.panaEnv, ...options?.env },
			},
			context,
		);
	}
}

/**
 * The `env` option for `Harness.open`: one clean environment per conversation, resolving the
 * session from the conversation so `bash` can export `PANA_SESSION` and attribute commits.
 */
/**
 * A session's memory worktree is made on first use: the first prompt render or tool call. Making
 * it at session create put a `git worktree add` on every create, which serialized burst creates.
 */
async function ensureMemoryWorktree(runtime: Runtime, sessionId: string): Promise<void> {
	if (existsSync(join(runtime.paths.memoryWorktrees, sessionId, ".git"))) return;
	try {
		await memoryFor(runtime).worktree({ id: sessionId, url: runtime.url({ kind: "session", id: sessionId }) });
	} catch (error) {
		// The session can still work without memory; `pana memory` will retry and report.
		console.error(`panad: memory worktree for session ${sessionId}:`, error);
	}
}

export function createPanaEnv(getRuntime: () => Runtime) {
	return async (target: { conversationId: number; cwd?: string }): Promise<ExecutionEnv> => {
		const runtime = getRuntime();
		const row = await runtime.db.get<{ id: string }>("SELECT id FROM sessions WHERE conversation_id = ?", target.conversationId);
		if (row) await ensureMemoryWorktree(runtime, row.id);
		// SCR-01: made on every open, because a sweep may have removed it while the session was idle.
		const scratch = row ? ensureScratch(runtime, row.id) : undefined;
		return new PanaExecutionEnv({
			// SCR-02: a session with no cwd of its own runs in its scratch; never in panad's cwd.
			cwd: target.cwd ?? scratch ?? homedir(),
			sessionId: row?.id,
			scratchDir: scratch,
			hooksDir: runtime.paths.hooks,
			stateDir: runtime.paths.dir,
		});
	};
}
