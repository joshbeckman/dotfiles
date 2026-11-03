// GUARD-01..05: a session edits a worktree, never the user's primary checkout.
//
// The primary checkout is the user's own working copy: its branch, its index, its unpushed work.
// A session that edits it leaves changes the user never asked for, tests the wrong build (panad
// runs from it), and can commit to the user's branch by accident. Linked worktrees need ownership
// checks too; env.ts combines discovery here with receipts and legacy session namespaces.
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
export function primaryCheckoutOf(path: string, includeLinked = false): string | undefined {
	for (let dir = realPath(path); ; dir = dirname(dir)) {
		try {
			// A `.git` file is a linked worktree or a submodule: someone else's checkout, not the primary.
			const marker = statSync(join(dir, ".git"));
			return includeLinked || marker.isDirectory() ? dir : undefined;
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
	includeLinked?: boolean;
}

let cached: { key: string; at: number; checkouts: string[] } | undefined;

/** The primary checkouts under `roots`, cached for `SCAN_TTL_MS` (GUARD-04). */
export function primaryCheckouts(options: ScanOptions = {}, now = Date.now()): string[] {
	const roots = (options.roots ?? [homedir()]).map(realPath);
	const depth = options.depth ?? SCAN_DEPTH;
	const key = `${roots.join("\n")}|${depth}|${options.includeLinked ?? false}`;
	if (cached && cached.key === key && now - cached.at < SCAN_TTL_MS) return cached.checkouts;

	const found: string[] = [];
	for (const root of roots) walk(root, 0);
	cached = { key, at: now, checkouts: found };
	return found;

	function walk(dir: string, level: number): void {
		if (isPrimary(dir) || (options.includeLinked && primaryCheckoutOf(dir, true) === dir)) {
			found.push(dir);
			return;
		}
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
		`pana refused this write: ${path} is inside ${root}, a checkout not owned by this session. ` +
		`Work in your own worktree instead: run \`pana worktree add ${root}\`, then edit files ` +
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
	options: { cwd: string; home: string; checkouts: readonly string[]; noFastForward?: readonly string[] },
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
		const refusal = gitRefusal(root, gitWords(command, match), !options.noFastForward?.includes(root));
		if (refusal !== undefined) return refusal;
	}

	for (const match of command.matchAll(GIT_DIR)) {
		const root = inside(match[1]!);
		if (root === undefined) continue;
		const words = gitWords(command, match);
		if (!readOnlyGit(words)) return refusedGit(root, words[0] ?? "");
	}

	for (const match of command.matchAll(REDIRECT)) {
		const root = inside(match[1]!);
		if (root !== undefined) return refusedEntry(root);
	}

	for (const match of command.matchAll(MUTATOR)) {
		const after = command.slice((match.index ?? 0) + match[0].length);
		const words = shellWords(after);
		if (match[1] === "sed" && readOnlySed(words)) continue;
		// Script arguments may themselves name output files. Keep checking their path words,
		// and fail conservatively when expansion prevents literal argument classification.
		for (const word of words.length ? words : after.split(/\s+/)) {
			for (const token of [word, ...word.split(/\s+/)]) {
				const root = inside(token);
				if (root !== undefined) return refusedEntry(root);
			}
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
/** Candidate mutators; their arguments need quote-aware command boundaries. */
const MUTATOR =
	/(?:^|[\s;&|(`])(rm|mv|cp|ln|touch|mkdir|rmdir|tee|truncate|chmod|chown|dd|install|rsync|sed|perl|patch)\s+/g;
/** Only literal print scripts are admitted: absence of -i is not proof that sed cannot write. */
function readOnlySed(words: readonly string[]): boolean {
	const [option, script, ...files] = words;
	return option === "-n" && /^(?:[0-9]+(?:,(?:[0-9]+|\$))?)?p$/.test(script ?? "") &&
		files.length > 0 && files.every((file) => !file.startsWith("-"));
}

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
	"merge-base",
	"cherry",
	"name-rev",
	"show-ref",
	"count-objects",
	"diff-tree",
	"diff-index",
	"diff-files",
	"check-ignore",
	"for-each-ref",
	"shortlog",
]);

/**
 * Mixed-mode commands must opt into a known query, not merely avoid known write flags.
 * Unknown options stay refused (including future Git write modes). Both -C and --git-dir
 * use this classifier; neither spelling grants branch/config/worktree mutations.
 */
function readOnlyGit(words: readonly string[]): boolean {
	const [command, ...args] = words;
	// Several otherwise read-only commands can redirect their output themselves.
	if (args.some((arg) => /^--output(?:=|$)/.test(arg))) return false;
	if (READ_ONLY_GIT.has(command ?? "")) return true;
	switch (command) {
		case "branch":
		case "tag": {
			const branch = command === "branch";
			let listing = args.length === 0;
			let operands = false;
			let patterns = false;
			for (let i = 0; i < args.length; i++) {
				const arg = args[i]!;
				if (arg === "--list" || arg === "-l") { listing = true; patterns = true; continue; }
				if (arg === "--" && patterns) { operands ||= i + 1 < args.length; break; }
				if (branch && /^(?:--show-current|--all|--remotes|-[arv]+|--verbose)$/.test(arg)) {
					listing = true; continue;
				}
				if (/^--(?:contains|no-contains|merged|no-merged|points-at)(?:=|$)/.test(arg)) {
					listing = true; patterns = true;
					if (!arg.includes("=") && args[i + 1] && !args[i + 1]!.startsWith("-")) i++;
					continue;
				}
				if (/^--(?:format|sort|color|column)=/.test(arg) ||
					/^(?:--ignore-case|--column|--color|--no-column|--no-color)$/.test(arg)) continue;
				if (/^--(?:format|sort)$/.test(arg)) {
					if (!args[i + 1] || args[i + 1]!.startsWith("-")) return false;
					i++; continue;
				}
				if (!branch && /^-n[0-9]*$/.test(arg)) { listing = true; patterns = true; continue; }
				if (arg.startsWith("-")) return false;
				operands = true;
			}
			return (listing || !operands) && (!operands || patterns);
		}
		case "worktree":
			return args[0] === "list" && args.slice(1).every((arg) => ["--porcelain", "-z", "-v", "--verbose"].includes(arg));
		case "remote":
			while (args[0] === "-v" || args[0] === "--verbose") args.shift();
			if (args.every((arg) => arg === "-v" || arg === "--verbose")) return true;
			if (args[0] === "get-url") return args.slice(1).every((arg) => !arg.startsWith("-") || ["--all", "--push"].includes(arg));
			if (args[0] === "show") return args.slice(1).every((arg) => !arg.startsWith("-") || arg === "-n");
			return false;
		case "config": {
			let queries = 0;
			for (let i = 0; i < args.length; i++) {
				const arg = args[i]!;
				if (/^--(?:get|get-all|get-regexp|get-urlmatch|list)$/.test(arg) ||
					(i === 0 && ["get", "list"].includes(arg)) || arg === "-l") { queries++; continue; }
				if (/^--(?:local|global|system|worktree|show-origin|show-scope|includes|no-includes|null|name-only|names|bool|int|bool-or-int|path|expiry-date)$/.test(arg) ||
					arg === "-z" || (args[0] === "get" && arg === "--all") || /^--(?:type|default|file)=/.test(arg)) continue;
				if (["--type", "--default", "--file", "-f"].includes(arg)) {
					if (!args[i + 1] || args[i + 1]!.startsWith("-")) return false;
					i++; continue;
				}
				if (arg.startsWith("-")) return false;
			}
			return queries === 1;
		}
		default:
			return false;
	}
}

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
	return shellWords(command.slice((match.index ?? 0) + match[0].length));
}

/** Literal words up to the next unquoted command separator; expansions fail classification. */
function shellWords(after: string): string[] {
	// Keep quoted scripts/format strings intact: splitting inside one can hide later write flags.
	const words: string[] = [];
	let word = "";
	let started = false;
	let quote = "";
	for (let i = 0; i < after.length; i++) {
		const char = after[i]!;
		if (char === "\\" && quote !== "'") {
			if (i + 1 === after.length) return [];
			if (after[i + 1] === "\n") { i++; continue; }
			word += after[++i];
			started = true;
			continue;
		}
		// Expansions need a real shell; this admission check cannot classify their result.
		if ((char === "$" || char === "`") && quote !== "'") return [];
		// Unquoted glob/brace expansion can turn one option value into a value plus ref names.
		if (!quote && /[*?\[{}(]/.test(char)) return [];
		if (quote) {
			if (char === quote) quote = "";
			else word += char;
		} else if (char === '"' || char === "'") {
			quote = char;
			started = true;
		} else if (/[;&|\n()]/.test(char)) {
			break;
		} else if (/\s/.test(char)) {
			if (started) words.push(word);
			word = "";
			started = false;
		} else {
			word += char;
			started = true;
		}
	}
	if (quote) return [];
	if (started) words.push(word);
	return words;
}

/** Why this git invocation may not run against the checkout, or undefined when it may. */
function gitRefusal(root: string, words: readonly string[], fastForward = true): string | undefined {
	const subcommand = words[0] ?? "";
	if (readOnlyGit(words)) return undefined;
	const args = words.slice(1);
	if (!fastForward) return `pana refused this command: ${root} belongs to another session. ` +
		`The fast-forward exception does not apply. Run \`pana worktree add ${root}\` and use your own checkout.`;
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
		`pana refused this command: ${command} writes in ${root}, a checkout not owned by this session. ` +
		"A fast-forward is the one write a session may run there, and only when " +
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
		`pana refused this command: it enters ${root}, a checkout not owned by this session. ` +
		`Work in your own worktree instead: run \`pana worktree add ${root}\`, then \`cd\` to the path ` +
		"it prints and run the command there. Reading the checkout is still allowed by naming the file, as in " +
		`\`grep -n something ${root}/README.md\`.`
	);
}
