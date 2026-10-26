// Memory (MEM-01..09): a bare git repo of Markdown files, one worktree per writer, and a
// compare-and-swap `main`.
//
// Concurrency rule: a writer commits in its own worktree, rebases onto `main`, then moves `main`
// with `git update-ref refs/heads/main <new> <old>`. If another writer moved `main` in between,
// update-ref refuses and the writer rebases again. Nothing is locked, so two writers of different
// files both land.

import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { ApiError } from "../api/errors.ts";
import { formatUrl } from "../ids/index.ts";
import { gitOrThrow, runGit } from "./git.ts";

/** The identity of a memory writer: a session ULID or a username, with its `pana://` URL. */
export interface MemoryWriter {
	id: string;
	/** Author name on commits, e.g. `pana://test.example/users/tester`. */
	url: string;
}

export interface MemoryOptions {
	/** `memory.git`, the bare repo (CFG-04). */
	gitDir: string;
	/** `memory/worktrees` (CFG-04). */
	worktreesDir: string;
	/** The configured domain, for author emails. */
	domain: string;
	/** Runtime clock, so tests drive commit dates. */
	now(): number;
}

export interface Worktree {
	caller: string;
	path: string;
	branch: string;
	repo: string;
	created: boolean;
}

export interface MemoryCommit {
	hash: string;
	authorUrl: string;
	email: string;
	/** Author time, ISO 8601. */
	time: string;
	message: string;
}

export interface CommitResult {
	committed: boolean;
	path: string;
	branch: string;
	commit?: MemoryCommit;
}

export interface SearchHit {
	path: string;
	line: number;
	text: string;
}

export interface SearchResult {
	query: string;
	tree: string;
	results: SearchHit[];
	truncated: boolean;
}

export interface LogEntry {
	hash: string;
	authorUrl: string;
	email: string;
	time: string;
	message: string;
}

export interface MemoryFile {
	path: string;
	content: string;
	/** The `main` commit the content was read from. */
	commit: string;
}

export const MAIN = "main";
export const INIT_MESSAGE = "Initialize memory";

/** How many times a writer rebases and retries the compare-and-swap before giving up. */
const MAX_PUBLISH_ATTEMPTS = 8;
const MAX_SEARCH_FILES = 500;
const DEFAULT_SEARCH_LIMIT = 100;
const DEFAULT_LOG_LIMIT = 50;

const WRITER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Throw a 400 when a caller id cannot safely name a directory. */
export function assertWriterId(id: string): void {
	if (!WRITER_ID_RE.test(id) || id.includes("..")) {
		throw ApiError.badRequest("invalid_writer", `invalid memory writer id: ${id}`);
	}
}

/**
 * Normalize a memory path taken from a URL or request body. Rejects anything that could escape
 * the worktree or reach into `.git`.
 */
export function normalizeMemoryPath(input: string): string {
	const path = input.replace(/^\/+/, "").trim();
	if (path.length === 0) throw ApiError.badRequest("invalid_path", "memory path is empty");
	if (path.includes("\\") || path.includes("\0")) throw ApiError.badRequest("invalid_path", `invalid memory path: ${input}`);
	const parts = path.split("/");
	if (parts.some((part) => part === "" || part === "." || part === "..")) {
		throw ApiError.badRequest("invalid_path", `invalid memory path: ${input}`);
	}
	if (parts[0] === ".git") throw ApiError.badRequest("invalid_path", `invalid memory path: ${input}`);
	return parts.join("/");
}

function emailFor(id: string, domain: string): string {
	return `${id}@${domain}`;
}

/** `@<seconds> +0000`, the format git stores and prints back as ISO. */
function gitDate(ms: number): string {
	return `@${Math.floor(ms / 1000)} +0000`;
}

function identityEnv(writer: MemoryWriter, domain: string, ms: number): Record<string, string> {
	const email = emailFor(writer.id, domain);
	const date = gitDate(ms);
	return {
		GIT_AUTHOR_NAME: writer.url,
		GIT_AUTHOR_EMAIL: email,
		GIT_COMMITTER_NAME: writer.url,
		GIT_COMMITTER_EMAIL: email,
		GIT_AUTHOR_DATE: date,
		GIT_COMMITTER_DATE: date,
	};
}

/** Split `<tree>:<path>` prefixes from `git grep -l -z` output. */
function stripTreePrefix(record: string): string {
	const colon = record.indexOf(":");
	return colon === -1 ? record : record.slice(colon + 1);
}

export class Memory {
	readonly options: MemoryOptions;

	constructor(options: MemoryOptions) {
		this.options = options;
	}

	get gitDir(): string {
		return this.options.gitDir;
	}

	/**
	 * Make `memory.git` a bare repo whose `main` holds one empty commit (MEM-01). Idempotent, and
	 * safe if two panads race: the second `update-ref` finds the ref already created.
	 */
	async ensureRepo(): Promise<void> {
		const { gitDir, domain, now } = this.options;
		if ((await this.revParse("refs/heads/main", gitDir)) !== undefined) return;
		mkdirSync(gitDir, { recursive: true });
		await gitOrThrow(["init", "--bare", "--quiet", "--template=", "--initial-branch=main", gitDir]);
		if ((await this.revParse("refs/heads/main", gitDir)) !== undefined) return;

		const tree = (await gitOrThrow(["-C", gitDir, "hash-object", "-t", "tree", "--stdin"], { input: "" })).stdout.trim();
		const domainUrl = formatUrl({ kind: "domain", id: domain }, domain);
		const commit = await gitOrThrow(["-C", gitDir, "commit-tree", tree, "-m", INIT_MESSAGE], {
			env: {
				GIT_AUTHOR_NAME: domainUrl,
				GIT_AUTHOR_EMAIL: `pana@${domain}`,
				GIT_COMMITTER_NAME: domainUrl,
				GIT_COMMITTER_EMAIL: `pana@${domain}`,
				GIT_AUTHOR_DATE: gitDate(now()),
				GIT_COMMITTER_DATE: gitDate(now()),
			},
		});
		// An empty old value means "the ref must not exist", so this is a compare-and-swap too.
		await gitOrThrow(["-C", gitDir, "update-ref", `refs/heads/${MAIN}`, commit.stdout.trim(), ""]);
	}

	/**
	 * Per-worktree config lets each writer have its own git identity. With it on, git reads
	 * `core.bare` from the shared config in every worktree, so it must move to the bare repo's
	 * own `config.worktree` first, or every worktree would think it is bare.
	 */
	private async enableWorktreeConfig(): Promise<void> {
		const { gitDir } = this.options;
		const enabled = await runGit(["--git-dir", gitDir, "config", "--get", "extensions.worktreeConfig"]);
		if (enabled.stdout.trim() === "true") return;
		await gitOrThrow(["--git-dir", gitDir, "config", "extensions.worktreeConfig", "true"]);
		await runGit(["--git-dir", gitDir, "config", "--unset", "core.bare"]);
		await gitOrThrow(["--git-dir", gitDir, "config", "--worktree", "core.bare", "true"]);
	}

	/** The writer's worktree, created on `writer/<id>` from `main` if needed (MEM-02). */
	async worktree(writer: MemoryWriter): Promise<Worktree> {
		return serialize(`worktree/${writer.id}`, () => this.worktreeSerialized(writer));
	}

	private async worktreeSerialized(writer: MemoryWriter): Promise<Worktree> {
		assertWriterId(writer.id);
		await this.ensureRepo();
		const { gitDir, worktreesDir } = this.options;
		const path = join(worktreesDir, writer.id);
		const branch = `writer/${writer.id}`;
		const base = { caller: writer.id, path, branch, repo: gitDir };

		if (existsSync(join(path, ".git"))) return { ...base, created: false };

		mkdirSync(worktreesDir, { recursive: true });
		if (existsSync(path) && isDirectoryEmpty(path)) rmSync(path, { recursive: true, force: true });

		const hasBranch = (await this.revParse(`refs/heads/${branch}`, gitDir)) !== undefined;
		const add = () =>
			runGit(["-C", gitDir, "worktree", "add", "--quiet", ...(hasBranch ? [path, branch] : ["-b", branch, path, MAIN])]);
		let result = await add();
		if (result.code !== 0) {
			// A worktree whose directory was deleted stays registered and blocks `worktree add`.
			// Prune only after a failure, so a concurrent add is never unregistered mid-flight.
			await runGit(["-C", gitDir, "worktree", "prune"]);
			result = await add();
		}
		if (result.code !== 0) throw new Error(`git worktree add failed: ${result.stderr.trim()}`);
		// A writer may also run plain `git commit` in its worktree. Without its own identity that
		// commit would carry whatever global git identity the process has, e.g. the human's.
		await serialize("repo/worktree-config", () => this.enableWorktreeConfig());
		await gitOrThrow(["config", "--worktree", "user.name", writer.url], { cwd: path });
		await gitOrThrow(["config", "--worktree", "user.email", emailFor(writer.id, this.options.domain)], { cwd: path });
		return { ...base, created: true };
	}

	/**
	 * Stage everything, commit as the writer, rebase onto `main`, and move `main` with a
	 * compare-and-swap (MEM-03). No changes exits 0 with no commit (MEM-06). A rebase conflict
	 * aborts the rebase, leaves the commit on `writer/<id>`, and raises a 409 carrying the
	 * conflicting paths, which the CLI maps to exit 3 (MEM-04).
	 */
	async commit(writer: MemoryWriter, message: string): Promise<CommitResult> {
		const text = message.trim();
		if (text.length === 0) throw ApiError.badRequest("missing_message", "memory commit needs a message (-m)");
		// Two commits from one writer would race for the same branch; serialize them.
		return serialize(`branch/${writer.id}`, async () => {
			const worktree = await this.worktreeSerialized(writer);
			return this.commitSerialized(writer, text, worktree);
		});
	}

	private async commitSerialized(writer: MemoryWriter, message: string, worktree: Worktree): Promise<CommitResult> {
		await gitOrThrow(["add", "-A"], { cwd: worktree.path });
		const status = await gitOrThrow(["status", "--porcelain", "-z"], { cwd: worktree.path });
		if (status.stdout.length === 0) {
			// Commits made with plain `git commit` in the worktree still need publishing.
			const ahead = await gitOrThrow(["rev-list", "--count", `${MAIN}..HEAD`], { cwd: worktree.path });
			if (Number(ahead.stdout.trim()) === 0) return { committed: false, path: worktree.path, branch: worktree.branch };
			const commit = await this.publish(worktree);
			return { committed: true, path: worktree.path, branch: worktree.branch, commit };
		}

		await gitOrThrow(["commit", "--quiet", "--allow-empty", "--no-verify", "-m", message], {
			cwd: worktree.path,
			env: identityEnv(writer, this.options.domain, this.options.now()),
		});

		const commit = await this.publish(worktree);
		return { committed: true, path: worktree.path, branch: worktree.branch, commit };
	}

	/** Rebase the writer branch onto `main` and compare-and-swap `main` to it. */
	private async publish(worktree: Worktree): Promise<MemoryCommit> {
		const { gitDir } = this.options;
		for (let attempt = 0; attempt < MAX_PUBLISH_ATTEMPTS; attempt++) {
			const base = await this.revParse(`refs/heads/${MAIN}`, gitDir);
			if (base === undefined) throw new Error("memory.git has no main branch");

			const rebase = await runGit(["rebase", "--quiet", base], { cwd: worktree.path });
			if (rebase.code !== 0) {
				const paths = await unmergedPaths(worktree.path);
				await runGit(["rebase", "--abort"], { cwd: worktree.path });
				if (paths.length > 0) {
					throw new ApiError(409, "conflict", `memory rebase conflict in ${paths.join(", ")}`, {
						paths,
						branch: worktree.branch,
						path: worktree.path,
					});
				}
				throw new Error(`git rebase failed: ${rebase.stderr.trim()}`);
			}

			const head = await this.revParse("HEAD", worktree.path);
			if (head === undefined) throw new Error("memory worktree has no HEAD after rebase");
			const cas = await runGit(["-C", gitDir, "update-ref", `refs/heads/${MAIN}`, head, base]);
			if (cas.code === 0) return await this.commitInfo(head, worktree.path);
		}
		throw new ApiError(409, "contention", "main moved on every attempt; retry the memory commit", {
			branch: worktree.branch,
			path: worktree.path,
		});
	}

	private async commitInfo(hash: string, cwd: string): Promise<MemoryCommit> {
		const show = await gitOrThrow(["-C", cwd, "show", "-s", "--format=%an%x1f%ae%x1f%aI%x1f%s", hash]);
		const [authorUrl = "", email = "", time = "", message = ""] = show.stdout.replace(/\n$/, "").split("\x1f");
		return { hash, authorUrl, email, time, message };
	}

	/**
	 * Case-insensitive fixed-string search over `main`, returning path, line, and text (MEM-07).
	 *
	 * `git grep -z` writes NUL only after the path and the line number, so a single call cannot be
	 * split reliably; listing matching files first and re-running grep per file does, because the
	 * known `main:<path>:` prefix can be stripped exactly.
	 */
	async search(term: string, limit?: number): Promise<SearchResult> {
		const query = term.trim();
		if (query.length === 0) throw ApiError.badRequest("missing_query", "memory search needs a term");
		await this.ensureRepo();
		const { gitDir } = this.options;
		const capped = Math.max(1, Math.min(limit ?? DEFAULT_SEARCH_LIMIT, 1000));

		const list = await runGit(["-C", gitDir, "grep", "-l", "-z", "-i", "-F", "-I", "-e", query, MAIN]);
		if (list.code === 1) return { query, tree: MAIN, results: [], truncated: false };
		if (list.code !== 0) throw new Error(`git grep failed: ${list.stderr.trim()}`);

		const files = list.stdout
			.split("\0")
			.filter((record) => record.length > 0)
			.map(stripTreePrefix)
			.slice(0, MAX_SEARCH_FILES);

		const results: SearchHit[] = [];
		for (const file of files) {
			const grep = await runGit([
				"-C",
				gitDir,
				"grep",
				"-n",
				"-i",
				"-F",
				"-I",
				"--no-color",
				"-e",
				query,
				MAIN,
				"--",
				`:(literal)${file}`,
			]);
			if (grep.code !== 0) continue;
			const prefix = `${MAIN}:${file}:`;
			for (const line of grep.stdout.split("\n")) {
				if (!line.startsWith(prefix)) continue;
				const rest = line.slice(prefix.length);
				const colon = rest.indexOf(":");
				if (colon === -1) continue;
				const number = Number(rest.slice(0, colon));
				if (!Number.isFinite(number)) continue;
				results.push({ path: file, line: number, text: rest.slice(colon + 1) });
			}
		}
		results.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1));
		return { query, tree: MAIN, results: results.slice(0, capped), truncated: results.length > capped };
	}

	/** Commits on `main`, newest first, optionally limited to a path (MEM-08). */
	async log(options: { path?: string; limit?: number } = {}): Promise<LogEntry[]> {
		await this.ensureRepo();
		const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_LOG_LIMIT, 1000));
		const args = ["-C", this.options.gitDir, "log", `--max-count=${limit}`, "--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e", MAIN];
		if (options.path !== undefined && options.path.trim().length > 0) {
			args.push("--", `:(literal)${normalizeMemoryPath(options.path)}`);
		}
		const out = await gitOrThrow(args);
		return out.stdout
			.split("\x1e")
			.map((record) => record.replace(/^\n+|\n+$/g, ""))
			.filter((record) => record.length > 0)
			.map((record) => {
				const [hash = "", authorUrl = "", email = "", time = "", message = ""] = record.split("\x1f");
				return { hash, authorUrl, email, time, message };
			});
	}

	/** Every file on `main` with its size in bytes, sorted by path, for the PWA's Memory view. */
	async listFiles(): Promise<Array<{ path: string; size: number }>> {
		await this.ensureRepo();
		const out = await gitOrThrow(["-C", this.options.gitDir, "ls-tree", "-r", "-l", "-z", MAIN]);
		const files: Array<{ path: string; size: number }> = [];
		for (const record of out.stdout.split("\0")) {
			// `<mode> blob <hash> <size>\t<path>`
			const tab = record.indexOf("\t");
			if (tab === -1) continue;
			const [, type, , size] = record.slice(0, tab).trim().split(/\s+/);
			if (type !== "blob") continue;
			files.push({ path: record.slice(tab + 1), size: Number(size) });
		}
		return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	}

	/** Read a file from `main`, or undefined when it is not there. */
	async readFile(relativePath: string): Promise<MemoryFile | undefined> {
		const path = normalizeMemoryPath(relativePath);
		await this.ensureRepo();
		const commit = await this.revParse(`refs/heads/${MAIN}`, this.options.gitDir);
		if (commit === undefined) return undefined;
		const blob = await runGit(["-C", this.options.gitDir, "cat-file", "blob", `${MAIN}:${path}`]);
		if (blob.code !== 0) return undefined;
		return { path, content: blob.stdout, commit };
	}

	/** Write a file into the writer's worktree and commit it through the MEM-03 path (MEM-09). */
	async writeFile(writer: MemoryWriter, relativePath: string, content: string, message: string): Promise<CommitResult> {
		const path = normalizeMemoryPath(relativePath);
		const worktree = await this.worktree(writer);
		const target = resolve(worktree.path, path);
		if (!target.startsWith(worktree.path + sep)) {
			throw ApiError.badRequest("invalid_path", `invalid memory path: ${relativePath}`);
		}
		if (existsSync(target) && !isFile(target)) {
			throw ApiError.badRequest("invalid_path", `memory path is not a file: ${path}`);
		}
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, content);
		return this.commit(writer, message.length > 0 ? message : `Update ${path}`);
	}

	private async revParse(ref: string, cwd: string): Promise<string | undefined> {
		const result = await runGit(["-C", cwd, "rev-parse", "--verify", "--quiet", ref]);
		const value = result.stdout.trim();
		return result.code === 0 && value.length > 0 ? value : undefined;
	}
}

/** Build the memory service from the runtime contract. */
export function memoryFor(options: MemoryOptions): Memory {
	return new Memory(options);
}

async function unmergedPaths(cwd: string): Promise<string[]> {
	const result = await runGit(["diff", "--name-only", "--diff-filter=U", "-z"], { cwd });
	if (result.code !== 0) return [];
	return [...new Set(result.stdout.split("\0").filter((path) => path.length > 0))];
}

function isDirectoryEmpty(path: string): boolean {
	try {
		return readdirSync(path).length === 0;
	} catch {
		return false;
	}
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/** Chain work per key, so two commits from one writer never race for the same branch. */
const chains = new Map<string, Promise<unknown>>();

function serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
	const previous = chains.get(key) ?? Promise.resolve();
	const next = previous.then(work, work);
	chains.set(
		key,
		next.then(
			() => undefined,
			() => undefined,
		),
	);
	return next;
}

/** Initialize `memory.git` at startup (MEM-01). */
export function ensureMemoryRepo(gitDir: string, options: { domain: string; worktreesDir: string; now(): number }): Promise<void> {
	return new Memory({ gitDir, domain: options.domain, worktreesDir: options.worktreesDir, now: options.now }).ensureRepo();
}
