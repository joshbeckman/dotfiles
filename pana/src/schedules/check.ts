// Checks are local bash commands, not model work. Never interpret their output as instructions.
import { spawn } from "node:child_process";
import type { Clock } from "../server/runtime.ts";

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

/** Kill the ordinary POSIX process group on timeout/shutdown; checks must not daemonize. */
export function runCheck(command: string, cwd: string, clock: Clock, abort: AbortSignal): Promise<CheckResult> {
	return new Promise((resolve) => {
		let stdout = Buffer.alloc(0);
		let stderr = Buffer.alloc(0);
		let error: string | null = null;
		let settled = false;
		let cancelTimer: (() => void) | undefined;
		const child = spawn("/bin/bash", ["--noprofile", "--norc", "-c", command], {
			cwd, env: process.env, detached: true, stdio: ["ignore", "pipe", "pipe"],
		});
		const append = (old: Buffer, data: Buffer) => Buffer.concat([old, data.subarray(0, Math.max(0, CHECK_OUTPUT_BYTES - old.length))]);
		child.stdout.on("data", (data: Buffer) => { stdout = append(stdout, data); });
		child.stderr.on("data", (data: Buffer) => { stderr = append(stderr, data); });
		const killGroup = () => {
			if (!child.pid) return;
			try { process.kill(-child.pid, "SIGKILL"); }
			catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ESRCH") error ??= String(cause); }
			// Also target the direct child in case cancellation raced process-group setup.
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		};
		const cancel = () => stop("check cancelled during scheduler shutdown");
		const finish = (exitCode: number | null, signal: string | null) => {
			if (settled) return;
			settled = true;
			cancelTimer?.();
			abort.removeEventListener("abort", cancel);
			killGroup();
			resolve({
				checkedAt: clock.now(),
				status: error || signal || (exitCode !== 0 && exitCode !== 1) ? "failed" : exitCode === 0 ? "passed" : "not_ready",
				exitCode, signal, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"),
				error: error ?? (signal ? `check terminated by ${signal}` : exitCode !== 0 && exitCode !== 1 ? `check exited ${exitCode}` : null),
			});
		};
		// A command can escape its process group and retain a pipe. Never wait for that pipe
		// to close on timeout/shutdown. Such detached children are outside this runner's scope.
		const stop = (reason: string) => {
			error = reason;
			killGroup();
			child.stdout.destroy();
			child.stderr.destroy();
			finish(child.exitCode, child.signalCode);
		};
		child.on("error", (cause) => { error = cause.message; });
		child.on("close", finish);
		cancelTimer = clock.setTimer(() => stop(`check timed out after ${CHECK_TIMEOUT_MS}ms`), CHECK_TIMEOUT_MS, { background: false });
		abort.addEventListener("abort", cancel, { once: true });
		if (abort.aborted) cancel();
	});
}
