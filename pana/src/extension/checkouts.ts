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

/**
 * GUARD-06: the cheap admission check a `bash` call gets before it runs. The mount namespace
 * (GUARD-02) costs ~2 ms per protected checkout per call, which is a tax on every call that
 * cannot touch one; this check costs a handful of string operations, and it catches what
 * actually happened: a command that changes into the checkout and runs something there.
 *
 * What it refuses:
 * - `cd` or `pushd` into a checkout: a shell inside one can write anything.
 * - `git -C <checkout>` / `--git-dir <checkout>` unless the git subcommand only reads.
 * - a shell redirect into a checkout.
 * - a mutating command (`rm`, `mv`, `sed -i`, …) whose arguments name a checkout path.
 *
 * Reads that name their file stay allowed: `grep -n foo ~/dotfiles/pana/src/x.ts`.
 *
 * The one writing git command it admits is the fast-forward PRM-05 already permits a session to run
 * on explicit user request: `git -C <checkout> fetch`, `… pull --ff-only`, `… merge --ff-only`.
 * Nothing else opens: a pull or merge without `--ff-only` (or with `--no-ff`, `--rebase`,
 * `--autostash`, `--squash`) is refused, so a branch that cannot fast-forward fails in git instead
 * of being merged, rebased, or stashed by the guard's permission, and a `fetch` may not carry a
 * refspec into a local ref (the branch HEAD points at is the user's too).
 */
export function checkoutCommandRefusal(
	command: string,
	options: { cwd: string; home: string; checkouts: readonly string[] },
): string | undefined {
	if (options.checkouts.length === 0) return undefined;
	const checkouts = options.checkouts;
	const inside = (token: string): string | undefined => {
		const path = tokenTarget(token, options.cwd, options.home);
		if (path === undefined) return undefined;
		return checkouts.find((root) => under(root, path));
	};

	for (const match of command.matchAll(ENTER)) {
		const root = inside(match[1]!);
		if (root !== undefined) return refusedEntry(root);
	}

	// `-C` names the checkout for a read or for the fast-forward; `--git-dir` names no work tree, so
	// it stays read-only.
	for (const match of command.matchAll(GIT_C)) {
		const root = inside(match[1]!);
		if (root === undefined) continue;
		const refusal = gitRefusal(root, gitWords(command, match));
		if (refusal !== undefined) return refusal;
	}

	for (const match of command.matchAll(GIT_DIR)) {
		const root = inside(match[1]!);
		if (root === undefined) continue;
		const words = gitWords(command, match);
		if (!READ_ONLY_GIT.has(words[0] ?? "")) return refusedGit(root, words[0] ?? "");
	}

	for (const match of command.matchAll(REDIRECT)) {
		const root = inside(match[1]!);
		if (root !== undefined) return refusedEntry(root);
	}

	for (const match of command.matchAll(MUTATOR)) {
		for (const token of (match[1] ?? "").split(/\s+/)) {
			const root = inside(token);
			if (root !== undefined) return refusedEntry(root);
		}
	}
	return undefined;
}

/** `cd` into a checkout, or `pushd`: the whole shell is then inside it. */
const ENTER = /(?:^|[\s;&|(`])(?:cd|pushd)\s+("[^"]*"|'[^']*'|[^\s;&|()`]+)/g;
/** `git -C PATH`: how a session names the checkout for a read or a fast-forward. */
const GIT_C = /(?:^|[\s;&|(`])-C\s+("[^"]*"|'[^']*'|[^\s;&|()`]+)/g;
/** `git --git-dir PATH|--git-dir=PATH`, which reads only. */
const GIT_DIR = /(?:^|[\s;&|(`])--git-dir[=\s]("[^"]*"|'[^']*'|[^\s;&|()`]+)/g;
/** A shell redirect's target: `> path`, `>> path`. */
const REDIRECT = /(?:^|[^0-9<>])>>?\s*("[^"]*"|'[^']*'|[^\s;&|()`]+)/g;
/** A command that writes its arguments, with everything up to the next separator as its words. */
const MUTATOR =
	/(?:^|[\s;&|(`])(?:rm|mv|cp|ln|touch|mkdir|rmdir|tee|truncate|chmod|chown|dd|install|rsync|sed|perl|patch)\s+([^;&|`]*)/g;
/** Git subcommands that only read; `git -C <checkout> log` is how a session inspects the user's work. */
const READ_ONLY_GIT = new Set([
	"status",
	"log",
	"diff",
	"show",
	"blame",
	"grep",
	"rev-parse",
	"rev-list",
	"describe",
	"ls-files",
	"ls-tree",
	"cat-file",
	"remote",
	"branch",
	"tag",
	"worktree",
	"config",
	"check-ignore",
	"for-each-ref",
	"shortlog",
]);

/**
 * The subcommands a session may run in a checkout although they write, when they write only a
 * fast-forward (PRM-05): `fetch` moves remote-tracking refs and never the working tree, and
 * `pull`/`merge` are admitted below with `--ff-only` and nothing that turns them into a merge,
 * rebase or stash.
 */
const FAST_FORWARD_GIT = new Set(["pull", "merge"]);

/** A `pull`/`merge` flag that makes the command something other than a plain fast-forward. */
const NOT_FAST_FORWARD = /^(?:--(?:no-ff|ff|rebase|rebase-merges|autostash|squash|no-commit|abort|continue|quit)(?:=|$)|-r$|-n$)/;

/**
 * A `fetch` flag that writes a local ref instead of only fetching: `--force`/`-f` (alone or in a
 * bundle like `-fv`), which lets a refspec replace the branch HEAD points at; `--update-head-ok`,
 * which allows exactly that on the current branch; `--mirror`, which is `--prune --force` over every
 * ref; and `--prune-tags`, which deletes local tags. A plain `fetch`, `--all`, `--prune`, `--tags`,
 * `--depth`, `-v` and the rest stay admitted: they never move a branch or the working tree.
 */
const UNSAFE_FETCH = /^(?:--(?:force|update-head-ok|mirror|prune-tags)(?:=|$)|-[A-Za-z]*f[A-Za-z]*$)/;
/** A remote URL, which may carry a `:` (`https://…`, `git@host:path`) but is not a refspec. */
const REMOTE_URL = /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|[^/\s:]+@[^/\s:]+:)/;

/** The words of the git invocation `match` found, up to the next shell separator. */
function gitWords(command: string, match: RegExpMatchArray): string[] {
	const after = command.slice((match.index ?? 0) + match[0].length);
	const segment = after.split(/&&|\|\||[;|`\n()]/)[0] ?? "";
	return segment
		.trim()
		.split(/\s+/)
		.map((word) => word.replace(/^["']|["']$/g, ""))
		.filter((word) => word !== "");
}

/** Why this git invocation may not run against the checkout, or undefined when it may. */
function gitRefusal(root: string, words: readonly string[]): string | undefined {
	const subcommand = words[0] ?? "";
	if (READ_ONLY_GIT.has(subcommand)) return undefined;
	const args = words.slice(1);
	if (subcommand === "fetch") {
		// A refspec with a destination (`main:refs/heads/main`) moves a local ref, which is the
		// user's branch as far as this guard is concerned, so only the fetch itself is admitted.
		const writesRef = args.some((arg) => UNSAFE_FETCH.test(arg) || (arg.includes(":") && !REMOTE_URL.test(arg)));
		if (!writesRef) return undefined;
	} else if (FAST_FORWARD_GIT.has(subcommand)) {
		if (args.includes("--ff-only") && !args.some((flag) => NOT_FAST_FORWARD.test(flag))) return undefined;
	}
	return refusedGit(root, subcommand);
}

/** A shell word resolved to an absolute path, or undefined for a flag, a variable, or a non-path. */
function tokenTarget(token: string, cwd: string, home: string): string | undefined {
	let text = token.replace(/^["']|["']$/g, "").replace(/[),]+$/, "");
	if (text === "" || text.startsWith("-")) return undefined;
	// The session's HOME, not panad's: `~` in a session's shell is where its bash says it is.
	text = text.replace(/^\$\{?HOME\}?/, home).replace(/^~(?=\/|$)/, home);
	// A word still carrying a variable is not a path this check can resolve; `cd "$X"` is caught
	// by the mount (GUARD-02) rather than guessed at here.
	if (text.includes("$")) return undefined;
	return realPath(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(text) ? text : resolve(cwd, text));
}

/**
 * The refusal a writing git command gets. It teaches the fast-forward a session *may* run, the way
 * GUARD-01's names `pana worktree add`: a model told only "refused" retries variations of the same
 * command.
 */
function refusedGit(root: string, subcommand: string): string {
	const command = subcommand === "" ? "this command" : `\`git -C ${root} ${subcommand}\``;
	return (
		`pana refused this command: ${command} writes in ${root}, the user's primary checkout of a git ` +
		"repository, not a worktree. A fast-forward is the one write a session may run there, and only when " +
		`the user asked for it: \`git -C ${root} fetch <remote>\`, compare the incoming paths with the ` +
		"checkout's staged, unstaged, and untracked files (PRM-05), then run " +
		`\`git -C ${root} pull --ff-only --no-autostash <verified-remote> <inspected-commit>\`; ` +
		`\`git -C ${root} merge --ff-only <ref>\` is that same fast-forward after a separate fetch. Anything ` +
		`else belongs in a worktree: run \`pana worktree add ${root}\`, then \`cd\` to the path it prints and ` +
		"run the command there. Reading the checkout is still allowed by naming the file, as in " +
		`\`grep -n something ${root}/README.md\`.`
	);
}

function refusedEntry(root: string): string {
	return (
		`pana refused this command: it enters ${root}, the user's primary checkout of a git repository, ` +
		`not a worktree. Work in a worktree instead: run \`pana worktree add ${root}\`, then \`cd\` to the path ` +
		"it prints and run the command there. Reading the checkout is still allowed by naming the file, as in " +
		`\`grep -n something ${root}/README.md\`.`
	);
}
