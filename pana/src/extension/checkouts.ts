// GUARD-01..05: a session edits a worktree, never the user's primary checkout.
//
// The primary checkout is the user's own working copy: its branch, its index, its unpushed work.
// A session that edits it leaves changes the user never asked for, tests the wrong build (panad
// runs from it), and can commit to the user's branch by accident. A linked worktree (`.git` is a
// file) and a session's own scratch are that session's to dirty; a primary checkout is not.
//
// `primaryCheckoutOf` answers "which primary checkout is this path in" for one path, which is the
// guard for the file tools. `primaryCheckouts` lists the checkouts under a root, which is what
// `exec` mounts read-only: a scan rather than a config list, so a repository the user clones
// tomorrow is protected without anyone updating config.json.

import { readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

/** How deep under a root the scan looks for a repository (GUARD-04). */
export const SCAN_DEPTH = 4;
/** How long the scan result serves. A new clone is protected within this window (GUARD-04). */
export const SCAN_TTL_MS = 10 * 60 * 1000;

/**
 * Directories a scan never enters. Each is either large and never a repository's root
 * (`node_modules`, `.cache`, a media library) or pana's own state, whose worktrees are the
 * legitimate places to write.
 */
const SKIP = new Set([
	"node_modules",
	"Library",
	"Applications",
	"Downloads",
	".Trash",
	".cache",
	".npm",
	".pnpm-store",
	".cargo",
	".rustup",
	".deno",
	".bun",
	".local",
	".venv",
	"venv",
	"dist",
	"build",
	"target",
]);

/**
 * `path` with every symlink resolved: through the deepest ancestor that exists, so a new file
 * under a symlinked directory still resolves (`~/pana/web/app.js` → `~/dotfiles/pana/web/app.js`).
 */
export function realPath(path: string): string {
	let absolute = resolve(path);
	const rest: string[] = [];
	for (;;) {
		try {
			const real = realpathSync(absolute);
			return rest.length === 0 ? real : join(real, ...rest.reverse());
		} catch {
			const parent = dirname(absolute);
			if (parent === absolute) return resolve(path);
			rest.push(absolute.slice(parent.length + 1));
			absolute = parent;
		}
	}
}

/** Whether `<dir>/.git` is a directory: the repo's own checkout, not a linked worktree. */
function isPrimary(dir: string): boolean {
	try {
		return statSync(join(dir, ".git")).isDirectory();
	} catch {
		return false;
	}
}

/**
 * The root of the primary checkout containing `path`, or undefined outside one (including inside
 * a linked worktree, whose `.git` is a file, and inside a scratch directory).
 */
export function primaryCheckoutOf(path: string): string | undefined {
	for (let dir = realPath(path); ; dir = dirname(dir)) {
		try {
			// A `.git` file is a linked worktree or a submodule: someone else's checkout, not the primary.
			return statSync(join(dir, ".git")).isDirectory() ? dir : undefined;
		} catch {
			// No `.git` here: keep walking up.
		}
		const parent = dirname(dir);
		if (parent === dir) return undefined;
	}
}

/** Whether `path` is `root` or under it. */
export function under(root: string, path: string): boolean {
	return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * The primary checkout a session may not write to, or undefined when the write is fine (GUARD-05).
 *
 * A session created in a checkout (`--cwd /home/josh/dotfiles`, the user's explicit choice) may
 * write there: the session's own cwd is the escape hatch, and its subtree is the whole hatch.
 */
export function blockedCheckout(path: string, sessionCwd: string | undefined): string | undefined {
	const root = primaryCheckoutOf(path);
	if (root === undefined) return undefined;
	if (sessionCwd !== undefined && under(root, realPath(sessionCwd))) return undefined;
	return root;
}

export interface ScanOptions {
	/** Where to look; HOME by default. */
	roots?: readonly string[];
	depth?: number;
}

let cached: { key: string; at: number; checkouts: string[] } | undefined;

/** The primary checkouts under `roots`, cached for `SCAN_TTL_MS` (GUARD-04). */
export function primaryCheckouts(options: ScanOptions = {}, now = Date.now()): string[] {
	const roots = (options.roots ?? [homedir()]).map(realPath);
	const depth = options.depth ?? SCAN_DEPTH;
	const key = `${roots.join("\n")}|${depth}`;
	if (cached && cached.key === key && now - cached.at < SCAN_TTL_MS) return cached.checkouts;

	const found: string[] = [];
	for (const root of roots) walk(root, 0);
	cached = { key, at: now, checkouts: found };
	return found;

	function walk(dir: string, level: number): void {
		if (isPrimary(dir)) found.push(dir);
		if (level >= depth) return;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			// Symlinks are skipped: `isDirectory` is false for them, which keeps the walk finite.
			if (!entry.isDirectory() || SKIP.has(entry.name)) continue;
			walk(join(dir, entry.name), level + 1);
		}
	}
}

/** Forget the scan. Tests use it; a long-lived panad does not need to. */
export function resetCheckoutScan(): void {
	cached = undefined;
}

/**
 * The error a file tool gets. It names the one command that fixes the situation, because a model
 * told only "refused" retries variations of the same write.
 */
export function primaryCheckoutRefusal(path: string, root: string): string {
	return (
		`pana refused this write: ${path} is inside ${root}, the user's primary checkout of a git repository, ` +
		`not a worktree. Work in a worktree of it instead: run \`pana worktree add ${root}\`, then edit files ` +
		"under the path it prints. Reading the checkout is still allowed, and a worktree is the same repository, " +
		"so its tests, builds, and git commands behave as they would here."
	);
}
