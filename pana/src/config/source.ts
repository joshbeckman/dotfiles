// Snapshot at module load, not on each settings request: source can move while panad lives.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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

export function readSourceRevision(directory = sourceDirectory): SourceRevision | null {
	try {
		const git = (...args: string[]) => execFileSync("git", ["-C", directory, ...args], {
			encoding: "utf8", timeout: 5000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
		});
		const sha = git("rev-parse", "HEAD").trim();
		const message = git("log", "-1", "--format=%B").trim();
		const diff = git("diff", "HEAD", "--", ".");
		const untracked = git("ls-files", "--others", "--exclude-standard", "-z", "--", ".").split("\0").filter(Boolean).sort();
		const hash = createHash("sha256").update(diff);
		// ls-files paths are relative to this directory unless --full-name is requested.
		for (const path of untracked) hash.update(path).update("\0").update(readFileSync(join(directory, path)));
		return { sha, message, dirty: diff.length > 0 || untracked.length > 0, fingerprint: hash.digest("hex") };
	} catch {
		// Packaged source may have no .git, and missing git must not break settings or startup.
		return null;
	}
}

export const runningRevision = readSourceRevision();
