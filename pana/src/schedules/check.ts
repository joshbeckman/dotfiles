// Checks are local bash commands, not model work. Never interpret their output as instructions.
//
// SCH-09..SCH-12: this is the one runner for both kinds of check — a schedule's condition and an
// objective metric's measurement. A check runs the way a session's `bash` runs, through
// `PanaExecutionEnv`: the child sees only `PANA_ENV_NAMES` and the checkout guard, never panad's
// own `process.env`. That matters because a check is defined once and then runs on cron with
// panad's identity; `bin/panad-service` injects the provider keys there, and no command pana runs
// on its own initiative may read them.
//
// A session may define a check, so a session's check runs in that session's box
// (`check-box.ts`): the same allowlisted environment with `PANA_SESSION` and `PANA_SCRATCH` set,
// the same guard, and a cwd inside the session's own roots. The user's check keeps the user's
// recorded cwd.
//
// The constraints are unchanged: a 30-second timeout on the runtime clock, 8 KiB retained per
// stream, and a killed process group.

import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { existsSync } from "node:fs";
import { constants } from "node:os";
import type { Clock, Runtime } from "../server/runtime.ts";
import type { CheckoutGuard } from "../config/index.ts";
import { PanaExecutionEnv } from "../extension/env.ts";
import { boxRefusal, sessionBox, type SessionBox } from "./check-box.ts";

export const CHECK_TIMEOUT_MS = 30_000;
export const CHECK_OUTPUT_BYTES = 8192;

export interface CheckResult {
	checkedAt: number;
	status: "passed" | "not_ready" | "failed";
	exitCode: number | null;
	signal: string | null;
	stdout: string;
	stderr: string;
	error: string | null;
}

/** What a check needs from panad to run like a session's `bash`: its state, and its guard. */
export interface CheckHost {
	/** panad's state directory: `PANA_STATE` for the check, and the worktree receipts the guard reads. */
	stateDir?: string;
	/** `tools.protectCheckouts`. The guard refuses a cwd in someone else's checkout. */
	protectCheckouts?: CheckoutGuard;
	/** Adapter layouts the guard also protects, as `createPanaEnv` passes them. */
	managedLayouts?: readonly { root: string; subdir?: string }[];
	/** Where to scan for primary checkouts (GUARD-04). HOME by default; a test names its own root. */
	checkoutRoots?: readonly string[];
	/** The authoring session's box, when a session defined the check (SCH-09). */
	box?: SessionBox;
}

/** The host a check runs on, taken from the running panad. */
export function checkHost(runtime: Runtime): CheckHost {
	return {
		stateDir: runtime.paths.dir,
		protectCheckouts: runtime.config.tools.protectCheckouts,
		managedLayouts: runtime.config.worktreeAdapters,
	};
}

/** A stored check: its command, the cwd recorded with it, and the session that authored it. */
export interface StoredCheck {
	command: string;
	cwd: string | null;
	/** Session ID, null for an explicit user author, or undefined when authority is unknown. */
	author: string | null | undefined;
}

/**
 * SCH-09: run a stored check on the host panad is. A session's check runs inside that session's
 * box; the user's check runs at its recorded cwd, or panad's own when none was recorded.
 */
export async function runStoredCheck(
	runtime: Runtime,
	stored: StoredCheck,
	clock: Clock,
	abort: AbortSignal,
): Promise<CheckResult> {
	if (stored.author === undefined) {
		return { checkedAt: clock.now(), status: "failed", exitCode: null, signal: null, stdout: "", stderr: "", error: "check author is missing; redefine the check to establish its authority" };
	}
	const box = stored.author === null ? undefined : sessionBox(runtime, stored.author);
	const cwd = stored.cwd ?? box?.scratchDir ?? process.cwd();
	return runCheck(stored.command, cwd, clock, abort, { ...checkHost(runtime), box });
}

/** The name of the signal behind an exit status the executor reported as `128 + n`. */
function signalName(exitCode: number): string | null {
	const number = exitCode - 128;
	for (const [name, value] of Object.entries(constants.signals)) {
		if (value === number) return name;
	}
	return null;
}

/**
 * Keep the first `CHECK_OUTPUT_BYTES` bytes of a stream, cut on a character boundary, and drop
 * whatever comes after: a check's output is diagnostic, not a file transfer.
 */
function retain(kept: string, text: string): string {
	const room = CHECK_OUTPUT_BYTES - Buffer.byteLength(kept);
	if (room <= 0) return kept;
	let bytes = 0;
	let end = 0;
	for (const character of text) {
		const size = Buffer.byteLength(character);
		if (bytes + size > room) break;
		bytes += size;
		end += character.length;
	}
	return kept + text.slice(0, end);
}

/**
 * Run one check and report what it did. pana stops it on the runtime clock, or when its owner is
 * shutting down; either way the run settles, and the process group dies with it.
 */
export async function runCheck(
	command: string,
	cwd: string,
	clock: Clock,
	abort: AbortSignal,
	host: CheckHost = {},
): Promise<CheckResult> {
	let stdout = "";
	let stderr = "";
	// A run pana stopped has pana's reason for it; one that never started has the executor's.
	const failure = (error: string): CheckResult => ({
		checkedAt: clock.now(), status: "failed", exitCode: null, signal: null, stdout, stderr, error,
	});
	// SCH-09: a session's check may not leave its box, even if the stored row says otherwise.
	const refusal = host.box === undefined ? undefined : boxRefusal(host.box, cwd);
	if (refusal !== undefined) return failure(refusal);
	// A swept scratch is a box that is gone: say so instead of reporting a spawn error.
	if (host.box !== undefined && !existsSync(cwd)) return failure(`the check's cwd ${cwd} does not exist; the session's box may have been removed`);
	// Set when pana stops the run rather than the command ending it; that reason is the error.
	let stopped: string | null = null;
	const control = new AbortController();
	const cancelTimer = clock.setTimer(() => {
		stopped ??= `check timed out after ${CHECK_TIMEOUT_MS}ms`;
		control.abort();
	}, CHECK_TIMEOUT_MS, { background: false });
	const cancel = () => {
		stopped ??= "check cancelled during scheduler shutdown";
		control.abort();
	};
	abort.addEventListener("abort", cancel, { once: true });
	if (abort.aborted) cancel();
	const env = new PanaExecutionEnv({
		cwd,
		sessionId: host.box?.id,
		scratchDir: host.box?.scratchDir,
		stateDir: host.stateDir,
		protectCheckouts: host.protectCheckouts,
		checkoutRoots: host.checkoutRoots,
		managedLayouts: host.managedLayouts,
	});
	const execution = await env
		.exec(
			command,
			{
				cwd,
				onOutput: (text, _context, info) => {
					if (info.stream === "stdout") stdout = retain(stdout, text);
					else stderr = retain(stderr, text);
				},
			},
			// The executor kills the process group when this context is cancelled, so a timeout or a
			// shutdown never leaves a check running behind panad.
			withAbortSignal(control.signal, BACKGROUND_CONTEXT),
		)
		.finally(() => {
			cancelTimer?.();
			abort.removeEventListener("abort", cancel);
		});
	if (stopped !== null) return failure(stopped);
	if (!execution.ok) return failure(execution.error.message);
	// A child the kernel killed has no exit status of its own; the executor reports the shell's
	// `128 + n`, which is where a check's own signal has always been read from.
	const exitCode = execution.value.exitCode;
	const signal = exitCode > 128 ? signalName(exitCode) : null;
	return {
		checkedAt: clock.now(),
		status: signal !== null || (exitCode !== 0 && exitCode !== 1) ? "failed" : exitCode === 0 ? "passed" : "not_ready",
		exitCode,
		signal,
		stdout,
		stderr,
		error: signal !== null ? `check terminated by ${signal}` : exitCode !== 0 && exitCode !== 1 ? `check exited ${exitCode}` : null,
	};
}
