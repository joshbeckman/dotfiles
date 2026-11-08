// Reading the JSONL logs panad writes (OBS-01): `<state>/panad.log` for requests (SRV-01) and
// `<state>/client.log` for the PWA's own samples (OBS-03).
//
// A log grows until someone deletes it, so this reads a bounded tail: the last `maxBytes` of the
// file, never the whole file, and it says when it stopped before the beginning. Lines are
// append-only and chronological, so the tail is the newest window.

import { open } from "node:fs/promises";

/** How much of a log a summary reads by default: enough for weeks of traffic, cheap to parse. */
export const STATS_READ_BYTES = 8 * 1024 * 1024;

export interface LogTail {
	/** Complete lines, oldest first. A leading partial line is dropped, never parsed. */
	lines: string[];
	/** Bytes read. */
	bytes: number;
	/** True when the file is longer than `maxBytes`, so older lines were not read. */
	truncated: boolean;
}

/** Read the last `maxBytes` of a file and split it into lines. A missing file is empty, not an error. */
export async function readLogTail(path: string, maxBytes = STATS_READ_BYTES): Promise<LogTail> {
	let handle;
	try {
		handle = await open(path, "r");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { lines: [], bytes: 0, truncated: false };
		throw error;
	}
	try {
		const { size } = await handle.stat();
		const start = Math.max(0, size - maxBytes);
		const length = size - start;
		const buffer = Buffer.alloc(length);
		let read = 0;
		while (read < length) {
			const { bytesRead } = await handle.read(buffer, read, length - read, start + read);
			if (bytesRead === 0) break;
			read += bytesRead;
		}
		const truncated = start > 0;
		let text = buffer.subarray(0, read).toString("utf8");
		if (truncated) {
			// The first line is probably cut in half by the byte window, so drop it.
			const newline = text.indexOf("\n");
			text = newline === -1 ? "" : text.slice(newline + 1);
		}
		const lines = text.split("\n").filter((line) => line.trim().length > 0);
		return { lines, bytes: read, truncated };
	} finally {
		await handle.close();
	}
}
