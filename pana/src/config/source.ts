// The source revision a settings read reports. Two rules keep it off the request path: a git
// snapshot is captured once at module load and then refreshed asynchronously behind a cache,
// and every local file the fingerprint covers is read only up to a fixed cap.
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface SourceRevision {
	sha: string;
	message: string;
	dirty: boolean;
	/** Includes local pana edits, even when HEAD has not changed. */
	fingerprint: string;
}

export const sourceDirectory = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** A cache entry this old is stale: the read answers from it and refreshes behind the response. */
export const SOURCE_REFRESH_MS = 10_000;

/** At most this much of one untracked file, and of all of them, enters the fingerprint. */
export const UNTRACKED_FILE_CAP = 256 * 1024;
export const UNTRACKED_TOTAL_CAP = 4 * 1024 * 1024;

const GIT_OPTIONS = { timeout: 5000, maxBuffer: 16 * 1024 * 1024 } as const;

interface GitSnapshot {
	sha: string;
	message: string;
	diff: string;
	untracked: string[];
}

interface UntrackedFile {
	path: string;
	/** -1 when the file vanished between `ls-files` and the read. */
	size: number;
	content?: Buffer;
}

// The four git values both readers ask for, in the order they ask; the blocking and asynchronous
// runners differ only in how they carry the answer back.
const GIT_ARGV = [
	["rev-parse", "HEAD"],
	["log", "-1", "--format=%B"],
	["diff", "--binary", "HEAD", "--", "."],
	// ls-files paths are relative to this directory unless --full-name is requested.
	["ls-files", "--others", "--exclude-standard", "-z", "--", "."],
] as const;

function snapshotOf([sha, message, diff, untracked]: [string, string, string, string]): GitSnapshot {
	return {
		sha: sha.trim(),
		message: message.trim(),
		diff,
		untracked: untracked.split("\0").filter(Boolean).sort(),
	};
}

/** Read at most the capped part of each untracked file, sharing one budget across all of them. */
function cappedSizes(sizes: number[]): boolean[] {
	const budget = { left: UNTRACKED_TOTAL_CAP };
	return sizes.map((size) => {
		const readable = size >= 0 && size <= UNTRACKED_FILE_CAP && size <= budget.left;
		if (readable) budget.left -= size;
		return readable;
	});
}

/**
 * Fold one untracked file into the hash without reading an unbounded file: its size always
 * counts, its content only while it fits the per-file cap and the budget left for the others.
 */
function noteUntracked(hash: ReturnType<typeof createHash>, file: UntrackedFile): void {
	hash.update(file.path).update("\0").update(String(file.size)).update("\0");
	if (file.content !== undefined) hash.update(file.content);
}

function revision(git: GitSnapshot, files: UntrackedFile[]): SourceRevision {
	const hash = createHash("sha256").update(git.diff);
	for (const file of files) noteUntracked(hash, file);
	return {
		sha: git.sha,
		message: git.message,
		dirty: git.diff.length > 0 || files.length > 0,
		fingerprint: hash.digest("hex"),
	};
}

/** A synchronous snapshot, for module load and tests. A request reports `cachedSourceRevision`. */
export function readSourceRevision(directory = sourceDirectory): SourceRevision | null {
	try {
		const run = (args: readonly string[]) => execFileSync("git", ["-C", directory, ...args], {
			encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...GIT_OPTIONS,
		});
		const gitSnapshot = snapshotOf(GIT_ARGV.map((args) => run(args)) as [string, string, string, string]);
		const sizes = gitSnapshot.untracked.map((path) => {
			try { return statSync(join(directory, path)).size; } catch { return -1; }
		});
		const readable = cappedSizes(sizes);
		const files = gitSnapshot.untracked.map((path, index): UntrackedFile => {
			const size = sizes[index]!;
			return readable[index] ? { path, size, content: readFileSync(join(directory, path)) } : { path, size };
		});
		return revision(gitSnapshot, files);
	} catch {
		// Packaged source may have no .git, and missing git must not break settings or startup.
		return null;
	}
}

/** The same snapshot without blocking the event loop, for the background refresh. */
export async function readSourceRevisionAsync(directory = sourceDirectory): Promise<SourceRevision | null> {
	const run = (args: readonly string[]) => new Promise<string>((resolve, reject) => {
		execFile("git", ["-C", directory, ...args], { encoding: "utf8", ...GIT_OPTIONS }, (error, stdout) =>
			error ? reject(error) : resolve(stdout));
	});
	try {
		const values: string[] = [];
		for (const args of GIT_ARGV) values.push(await run(args));
		const gitSnapshot = snapshotOf(values as [string, string, string, string]);
		const sizes: number[] = [];
		for (const path of gitSnapshot.untracked) {
			try { sizes.push((await stat(join(directory, path))).size); } catch { sizes.push(-1); }
		}
		const readable = cappedSizes(sizes);
		const files: UntrackedFile[] = [];
		for (const [index, path] of gitSnapshot.untracked.entries()) {
			const size = sizes[index]!;
			files.push(readable[index] ? { path, size, content: await readFile(join(directory, path)) } : { path, size });
		}
		return revision(gitSnapshot, files);
	} catch {
		return null;
	}
}

/** The revision this process started with (SET-02): it never moves, even as HEAD advances. */
export const runningRevision = readSourceRevision();

let snapshot: SourceRevision | null = runningRevision;
let capturedAt = Date.now();
let refreshing: Promise<void> | undefined;

/**
 * The latest source snapshot, for a settings read. It never waits on git: a stale cache still
 * answers the read, and the refresh runs behind the response.
 */
export function cachedSourceRevision(now = Date.now()): SourceRevision | null {
	if (now - capturedAt >= SOURCE_REFRESH_MS && !refreshing) {
		refreshing = readSourceRevisionAsync().then((next) => {
			// A transient failure keeps the last good snapshot rather than erasing it.
			if (next) snapshot = next;
			capturedAt = Date.now();
			refreshing = undefined;
		});
	}
	return snapshot;
}
