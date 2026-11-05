// Checks are local bash commands, not model work. Never interpret their output as instructions.
//
// SCH-09..SCH-12: this is the one runner for both kinds of check — a schedule's condition and an
// objective metric's measurement. A check runs the way a session's `bash` runs, through
// `PanaExecutionEnv`: the child sees only `PANA_ENV_NAMES` and the checkout guard, never panad's
// own `process.env`. That matters because a check is defined once and then runs on cron with
// panad's identity; `bin/panad-service` injects the provider keys there, and no command pana runs
// on its own initiative may read them. Definition is the user's alone (see `store.ts` and
// `objectives/metrics.ts`); running it is this file's business.
//
// The constraints are unchanged: the recorded cwd, a 30-second timeout on the runtime clock,
// 8 KiB retained per stream, and a killed process group.

import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { constants } from "node:os";
import type { Clock, Runtime } from "../server/runtime.ts";
import type { CheckoutGuard } from "../config/index.ts";
import { PanaExecutionEnv } from "../extension/env.ts";

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
}

/** The host a check runs on, taken from the running panad. */
export function checkHost(runtime: Runtime): CheckHost {
	return {
		stateDir: runtime.paths.dir,
		protectCheckouts: runtime.config.tools.protectCheckouts,
		managedLayouts: runtime.config.worktreeAdapters,
	};
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
		stateDir: host.stateDir,
		protectCheckouts: host.protectCheckouts,
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
	// A run pana stopped has pana's reason for it; one that never started has the executor's.
	const failure = (error: string): CheckResult => ({
		checkedAt: clock.now(), status: "failed", exitCode: null, signal: null, stdout, stderr, error,
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
