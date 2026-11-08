// Reading the JSONL logs panad writes (OBS-01): `<state>/panad.log` for requests (SRV-01) and
// `<state>/client.log` for the PWA's own samples (OBS-03).
//
// A log grows until someone deletes it, so this reads a bounded tail: the newest `maxBytes` of
// the newest files, never the whole directory, and it says when it stopped before the beginning.
// Lines are append-only and chronological, and rotation renames a whole file rather than cutting
// one (src/logs/index.ts), so `<name>.1` continues where `<name>` begins and the window is one
// history: `<name>.N` … `<name>.1`, then `<name>`.

import { access, open } from "node:fs/promises";

/** How much of a log a summary reads by default: enough for weeks of traffic, cheap to parse. */
export const STATS_READ_BYTES = 8 * 1024 * 1024;

/** Rotated files probed at most, so a pathological state directory cannot spin the reader. */
const MAX_ROTATED = 16;

export interface LogTail {
	/** Complete lines, oldest first. A leading partial line is dropped, never parsed. */
	lines: string[];
	/** Bytes read. */
	bytes: number;
	/** True when older lines exist that this reading could not see, past the cap or past the files kept. */
	truncated: boolean;
}

interface Piece {
	text: string;
	bytes: number;
	/** True when the byte window cut this file's first line in half. */
	cut: boolean;
}

/** Read the last `maxBytes` of a log, across the files rotation left behind. A missing log is empty. */
export async function readLogTail(path: string, maxBytes = STATS_READ_BYTES): Promise<LogTail> {
	const pieces: Piece[] = [];
	let budget = Math.max(0, maxBytes);
	let bytes = 0;
	let truncated = false;
	for (let index = 0; ; index++) {
		if (budget <= 0) {
			// The budget ran out at a file boundary: anything older is history this reading cannot see.
			truncated = await exists(fileName(path, index));
			break;
		}
		if (index > MAX_ROTATED) {
			truncated = true;
			break;
		}
		const piece = await readTailOfFile(fileName(path, index), budget);
		if (piece === undefined) break;
		pieces.push(piece);
		bytes += piece.bytes;
		budget -= piece.bytes;
		if (piece.cut) {
			// The window cut this file's first line, so this is the oldest history it can reach.
			truncated = true;
			break;
		}
	}
	// Read newest first; the history runs oldest first.
	const ordered = [...pieces].reverse();
	let text = ordered.map((piece) => piece.text).join("");
	if (ordered[0]?.cut) {
		// The byte window cut the oldest line in half, so it is not a line.
		const newline = text.indexOf("\n");
		text = newline === -1 ? "" : text.slice(newline + 1);
	}
	const lines = text.split("\n").filter((line) => line.trim().length > 0);
	return { lines, bytes, truncated };
}

/** The name of one log file in the rotation: index 0 is the active file, then `<name>.1`, … */
function fileName(path: string, index: number): string {
	return index === 0 ? path : `${path}.${index}`;
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/** The last `maxBytes` of one file, or undefined when the file is not there. */
async function readTailOfFile(path: string, maxBytes: number): Promise<Piece | undefined> {
	let handle;
	try {
		handle = await open(path, "r");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	try {
		const { size } = await handle.stat();
		const start = Math.max(0, size - Math.max(0, maxBytes));
		const length = size - start;
		const buffer = Buffer.alloc(length);
		let read = 0;
		while (read < length) {
			const { bytesRead } = await handle.read(buffer, read, length - read, start + read);
			if (bytesRead === 0) break;
			read += bytesRead;
		}
		return { text: buffer.subarray(0, read).toString("utf8"), bytes: read, cut: start > 0 };
	} finally {
		await handle.close();
	}
}
