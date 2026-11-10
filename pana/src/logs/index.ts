// Rotation for the two logs panad appends to (OBS-06): the request log (SRV-01) and the client
// log (OBS-03). Both are JSONL and append-only, and nothing ever removed a line, so both grew
// until someone deleted them by hand.
//
// A log rotates by rename: when the next line would pass `maxBytes`, the file becomes
// `<name>.1` (shifting the older ones up, and dropping the oldest beyond `keep`) and a new file
// starts at zero. Nothing is truncated in the middle of a line, so every rotated file is valid
// JSONL on its own, and `src/stats/log.ts` reads across them as one continuous history.
//
// `maxBytes: 0` turns rotation off and keeps the old behaviour: one file, growing.

import { appendFileSync, existsSync, renameSync, statSync, unlinkSync } from "node:fs";

export interface RotatingLogOptions {
	path: string;
	/** Rotate when the file would pass this size. `0` never rotates. */
	maxBytes: number;
	/** Previous files to keep as `<name>.1` … `<name>.<keep>`. At least 1, so nothing is dropped outright. */
	keep: number;
	onError?: (error: unknown) => void;
}

export class RotatingLog {
	readonly path: string;
	readonly maxBytes: number;
	readonly keep: number;
	#onError: ((error: unknown) => void) | undefined;
	/** Bytes in the active file. Read from disk once, then counted as this process appends. */
	#bytes: number | undefined;

	constructor(options: RotatingLogOptions) {
		this.path = options.path;
		this.maxBytes = Math.max(0, Math.trunc(options.maxBytes));
		this.keep = Math.max(1, Math.trunc(options.keep));
		this.#onError = options.onError;
	}

	/** The size the active file is believed to hold. A failed stat is zero, and the write reports the real error. */
	size(): number {
		if (this.#bytes === undefined) {
			try {
				this.#bytes = statSync(this.path).size;
			} catch {
				this.#bytes = 0;
			}
		}
		return this.#bytes;
	}

	/**
	 * Append text, rotating first if it would pass the limit. A write failure is reported and
	 * dropped: a full disk must not fail the request or the page that produced the line.
	 */
	append(text: string): boolean {
		if (text.length === 0) return false;
		const bytes = Buffer.byteLength(text);
		try {
			// Rotate before writing, never after: a file is renamed at a line boundary.
			if (this.maxBytes > 0 && this.size() > 0 && this.size() + bytes > this.maxBytes && !this.rotate()) return false;
			// 0600: the request log names sessions and the paths they opened (CFG-04), and a
			// rotated file keeps the mode of the file it was renamed from.
			appendFileSync(this.path, text, { mode: 0o600 });
			this.#bytes = this.size() + bytes;
			return true;
		} catch (error) {
			// The file may have moved or been rewritten under us; the next append re-reads it.
			this.#bytes = undefined;
			this.#onError?.(error);
			return false;
		}
	}

	/** Rename the active file to `<name>.1`, shifting older ones up, and start a new one. */
	rotate(): boolean {
		try {
			for (let index = this.keep; index >= 1; index--) {
				const from = index === 1 ? this.path : `${this.path}.${index - 1}`;
				const to = `${this.path}.${index}`;
				if (index === this.keep && existsSync(to)) unlinkSync(to);
				if (existsSync(from)) renameSync(from, to);
			}
			this.#bytes = 0;
			return true;
		} catch (error) {
			this.#bytes = undefined;
			this.#onError?.(error);
			return false;
		}
	}
}
