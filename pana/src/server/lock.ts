// One panad per state directory (CFG-05). pi-durable has no cross-process locking, so panad
// must be the only process that opens pana.sqlite.

import { openSync, writeSync, closeSync, readFileSync, unlinkSync } from "node:fs";
import { ConfigError } from "../config/index.ts";

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but belongs to someone else.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function readPid(path: string): number | undefined {
	try {
		const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
		return Number.isFinite(pid) && pid > 0 ? pid : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Create `path` holding this PID. If another live panad holds it, raise exit code 1 naming
 * its PID. A stale file from a dead process is replaced. Returns a release function.
 */
export function acquirePidLock(path: string): () => void {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = openSync(path, "wx", 0o644);
			writeSync(fd, `${process.pid}\n`);
			closeSync(fd);
			let released = false;
			return () => {
				if (released) return;
				released = true;
				if (readPid(path) === process.pid) unlinkSync(path);
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const pid = readPid(path);
			if (pid !== undefined && alive(pid)) {
				throw new ConfigError(`panad is already running (pid ${pid})`, 1);
			}
			try {
				unlinkSync(path);
			} catch {
				// Another starter removed it first; retry the exclusive create.
			}
		}
	}
	throw new ConfigError(`could not acquire ${path}`, 1);
}
