// The clean environment a session's `bash` runs in (ISO-03, ISO-04).
//
// pi-durable's `bash` always passes `inheritEnv: true`, which merges panad's `process.env`
// (provider credentials included) under the call's own variables. `PanaExecutionEnv` overrides
// `exec` to drop that inheritance, so the child sees exactly the variables built here.

import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { err, ExecutionError, FileError } from "@earendil-works/pi-durable/env";
import type { ExecutionEnv, ShellExecOptions, ShellExecResult, Result } from "@earendil-works/pi-durable/env";
import type { Context } from "@earendil-works/chord";
import { spawnSync } from "node:child_process";
import { homedir, userInfo } from "node:os";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PanaDatabase } from "../db/atomic.ts";
import { memoryFor } from "../memory/handlers.ts";
import { ensureScratch } from "../scratch/index.ts";
import type { Runtime } from "../server/runtime.ts";
import { checkoutCommon, owners, type WorktreeOwner } from "../worktrees/ownership.ts";
import { browserScope } from "./browser.ts";
import type { CheckoutGuard } from "../config/index.ts";
import {
	primaryCheckoutOf,
	primaryCheckoutRefusal,
	primaryCheckouts,
	realPath,
	under,
} from "./checkouts.ts";

/** The only variables a pana session's commands see. Git config is left to the repository. */
export const PANA_ENV_NAMES = [
	"PATH",
	"HOME",
	"USER",
	"LANG",
	"TERM",
	"PANA_SESSION",
	"PANA_STATE",
	"PANA_SCRATCH",
	"PANA_BROWSER_SESSION",
] as const;

export interface PanaEnvOptions {
	cwd: string;
	/** The session's ULID, exported as `PANA_SESSION`; absent for a conversation that is not a session. */
	sessionId?: string;
	/**
	 * panad's state directory, exported as `PANA_STATE` so `pana` inside `bash` reaches this
	 * panad's socket even when it does not run on the default state directory.
	 */
	stateDir?: string;
	/** The session's scratch directory, exported as `PANA_SCRATCH` (SCR-01). */
	scratchDir?: string;
	/** Overrides `HOME`, for a host whose session home differs from panad's. Default: panad's `HOME`. */
	home?: string;
	/** File-path protection and optional filesystem isolation. `tools.protectCheckouts`. */
	protectCheckouts?: CheckoutGuard;
	/** Where to scan for primary checkouts (GUARD-04). HOME by default; a test names its own root. */
	checkoutRoots?: readonly string[];
	/** Managed tree roots, scanned independently of HOME depth. */
	managedRoots?: readonly string[];
	managedLayouts?: readonly { root: string; subdir?: string }[];
	/** Pana's database, which holds worktree ownership (GUARD-07). Absent: only the path rules apply. */
	db?: PanaDatabase;
}

export const PANA_BIN = fileURLToPath(new URL("../../bin", import.meta.url));

/** Build the clean environment map. Values come from panad's own environment, never secrets. */
export function panaShellEnv(options: PanaEnvOptions): Record<string, string> {
	const env: Record<string, string> = {
		// pana's own bin comes first, so `pana` in a session is this panad's build, even when no
		// `pana` is installed on panad's PATH.
		PATH: `${PANA_BIN}:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"}`,
		HOME: options.home ?? process.env.HOME ?? fallbackHome(),
		USER: process.env.USER ?? fallbackUser(),
		LANG: process.env.LANG ?? "C.UTF-8",
		TERM: "dumb",
	};
	if (options.sessionId) {
		env.PANA_SESSION = options.sessionId;
		// ISO-06: `bin/chrome-devtools` names this session's browser daemon with it.
		env.PANA_BROWSER_SESSION = browserScope(options.sessionId);
	}
	if (options.stateDir) env.PANA_STATE = options.stateDir;
	if (options.scratchDir) env.PANA_SCRATCH = options.scratchDir;
	return env;
}

function fallbackHome(): string {
	try {
		return userInfo().homedir;
	} catch {
		return "/tmp";
	}
}

function fallbackUser(): string {
	try {
		return userInfo().username;
	} catch {
		return "pana";
	}
}

/** The shell `unshare` runs a wrapped command in: bash where the machine has it, as pi-durable picks. */
const SHELL = existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";

/** Quote a path for the mount prologue. Paths come from a scan, but a `'` in one would still break it. */
function quote(path: string): string {
	return `'${path.replaceAll("'", `'\\''`)}'`;
}

/**
 * GUARD-02: what removes CAP_SYS_ADMIN from the command. `--map-root-user` maps the caller to uid 0
 * inside the namespace, which also grants it CAP_SYS_ADMIN over the mounts that are supposed to
 * confine it: it could `mount -o remount,bind,rw` one back to writable, or `mount --bind` an
 * ancestor directory over it and write through that. Dropping the capability takes both away, and
 * a nested user namespace cannot regain it over a mount that belongs to this one.
 */
const DROP_SYS_ADMIN = ["setpriv", "--bounding-set=-sys_admin", "--inh-caps=-sys_admin", "--"] as const;

/**
 * GUARD-02: the command, run in a mount namespace of its own with every primary checkout bound
 * read-only. A command cannot write to a read-only mount, so no pattern of `bash` defeats this.
 *
 * The mounts are set up in the namespace's shell, before the command: `unshare` needs no root
 * (`--map-root-user` maps the caller to uid 0 inside the namespace), and the bind of a mount point
 * onto itself followed by a read-only remount is the classic way to make an existing directory
 * read-only without moving it. Only then does the command's own shell start, one capability
 * poorer, so the mounts it inherited are not its to undo.
 */
export function namespaced(mounts: readonly string[], command: string | readonly string[]): string[] {
	const prologue = mounts
		.map((path) => `mount --bind ${quote(path)} ${quote(path)} && mount -o remount,bind,ro ${quote(path)} || true`)
		.join("; ");
	const argv = typeof command === "string" ? [SHELL, "-c", command] : command;
	return ["unshare", "--map-root-user", "--mount", SHELL, "-c", `${prologue}\nexec ${DROP_SYS_ADMIN.join(" ")} "$@"`, "pana", ...argv];
}

/**
 * Whether this host can build the wrapper at all: user namespaces to make the mounts in, and a
 * working capability drop for the command that follows. Probed once per process; a host with
 * `unshare` but no usable `setpriv` falls back exactly as macOS does, rather than running the
 * command with the capability that undoes its own mounts.
 */
let canSandbox: boolean | undefined;
export function sandboxSupported(): boolean {
	if (canSandbox === undefined) {
		const probe = spawnSync("unshare", ["--map-root-user", "--mount", ...DROP_SYS_ADMIN, "true"], { stdio: "ignore" });
		canSandbox = probe.status === 0;
	}
	return canSandbox;
}

/**
 * Whether the wrapper itself is what failed: no `unshare` (macOS), or user namespaces off.
 * The command is then run once more unwrapped, and the interpreter is not tried again.
 */
function namespaceUnavailable(error: ExecutionError): boolean {
	return error.code === "spawn_error" && /unshare/i.test(error.message);
}

/** A local environment whose commands see only `panaShellEnv`, never panad's own variables. */
export class PanaExecutionEnv extends NodeExecutionEnv {
	readonly panaEnv: Record<string, string>;
	/** The session's own cwd: writes under it are the session's business, even in a checkout (GUARD-05). */
	readonly sessionCwd: string;
	/** The session's HOME, which is what `~` means in its commands. */
	readonly home: string;
	readonly protectCheckouts: CheckoutGuard;
	/** GUARD-04: the roots the read-only scan covers. */
	readonly checkoutRoots: readonly string[];
	readonly stateDir?: string;
	readonly sessionId?: string;
	readonly managedRoots: readonly string[];
	readonly managedLayouts: readonly { root: string; subdir?: string }[];
	readonly db?: PanaDatabase;
	/** undefined until the first wrapped command says whether this machine can make a namespace. */
	private namespace: boolean | undefined = undefined;

	constructor(options: PanaEnvOptions) {
		super({ cwd: options.cwd });
		this.stateDir = options.stateDir;
		this.sessionId = options.sessionId;
		this.db = options.db;
		this.managedRoots = options.managedRoots ?? [];
		this.managedLayouts = options.managedLayouts ?? [];
		this.panaEnv = panaShellEnv(options);
		this.sessionCwd = realPath(options.cwd);
		this.home = options.home ?? homedir();
		this.protectCheckouts = options.protectCheckouts ?? "guard";
		this.checkoutRoots = options.checkoutRoots ?? [homedir()];
	}

	/** GUARD-01: the refusal for a write to `path`, or undefined when the write may proceed. */
	private async refusal(path: string): Promise<string | undefined> {
		if (this.protectCheckouts === "off") return undefined;
		const root = primaryCheckoutOf(path, true);
		if (root !== undefined && (await this.allowed(root))) return undefined;
		return root === undefined ? undefined : primaryCheckoutRefusal(path, root);
	}

	override async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		const refusal = await this.refusal(path);
		if (refusal !== undefined) return err(new FileError("permission_denied", refusal, path));
		return super.writeFile(path, content, context);
	}

	override async appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		const refusal = await this.refusal(path);
		if (refusal !== undefined) return err(new FileError("permission_denied", refusal, path));
		return super.appendFile(path, content, context);
	}

	override async truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
		const refusal = await this.refusal(path);
		if (refusal !== undefined) return err(new FileError("permission_denied", refusal, path));
		return super.truncateFile(path, size, context);
	}

	override async renameFile(
		sourcePath: string,
		destinationPath: string,
		context: Context,
	): Promise<Result<void, FileError>> {
		const refusal = (await this.refusal(sourcePath)) ?? (await this.refusal(destinationPath));
		if (refusal !== undefined) return err(new FileError("permission_denied", refusal, sourcePath));
		return super.renameFile(sourcePath, destinationPath, context);
	}

	override async remove(
		path: string,
		options: { recursive?: boolean; force?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>> {
		const refusal = await this.refusal(path);
		if (refusal !== undefined) return err(new FileError("permission_denied", refusal, path));
		return super.remove(path, options, context);
	}

	override async createDir(
		path: string,
		options: { recursive?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>> {
		const refusal = await this.refusal(path);
		if (refusal !== undefined) return err(new FileError("permission_denied", refusal, path));
		return super.createDir(path, options, context);
	}

	private async allowed(root: string, owned?: readonly WorktreeOwner[]): Promise<boolean> {
		if (this.stateDir && this.sessionId) {
			const state = realPath(this.stateDir);
			for (const group of [join(state, "worktrees"), join(state, "memory", "worktrees")]) {
				if (!under(group, root)) continue;
				const namespace = join(group, this.sessionId);
				// A symlink must not turn Alice's legacy ownership boundary into Bob's.
				return realPath(namespace) === namespace && under(namespace, root) && checkoutCommon(root) !== undefined;
			}
			// GUARD-07: ownership is read from pana's database, which only panad writes. A file under
			// the session's own state directory was a record any `bash` command could forge.
			if (!this.db) return false;
			const matching = (owned ?? (await owners(this.db))).filter((o) => under(o.path, root));
			if (matching.length) return matching.every((o) => o.session === this.sessionId && checkoutCommon(o.path) === o.common);
		}
		// A cwd inside this checkout is explicit authority; an ancestor of many checkouts is not.
		return under(root, this.sessionCwd);
	}

	private managedCheckouts(): string[] {
		const result: string[] = [];
		for (const layout of this.managedLayouts) {
			let entries: string[];
			try { entries = readdirSync(layout.root); } catch { continue; }
			for (const name of entries) {
				const path = realPath(join(layout.root, name, layout.subdir ?? ""));
				// Follow the configured layout exactly, even if subdir is deep or named build.
				if (primaryCheckoutOf(path, true) === path) result.push(path);
			}
		}
		return result;
	}

	private async checkouts(owned: readonly WorktreeOwner[]): Promise<string[]> {
		if (this.protectCheckouts === "off") return [];
		const roots = [...this.checkoutRoots, ...this.managedRoots];
		if (this.stateDir) roots.push(join(this.stateDir, "worktrees"), join(this.stateDir, "memory", "worktrees"));
		// Ownership registered a moment ago bypasses the scan TTL: a newly created peer tree is protected immediately.
		const registered = owned.map((o) => o.path);
		const found = [...new Set([...primaryCheckouts({ roots, depth: 5, includeLinked: true }), ...this.managedCheckouts(), ...registered])];
		const unowned: string[] = [];
		for (const root of found) if (!(await this.allowed(root, owned))) unowned.push(root);
		return unowned;
	}

	override async exec(
		command: string | readonly string[],
		options: ShellExecOptions | undefined,
		context: Context,
	): Promise<Result<ShellExecResult, ExecutionError>> {
		const execOptions = {
			...options,
			inheritEnv: false,
			env: { ...this.panaEnv, ...options?.env },
		};
		// Ownership is checked against actual paths, never inferred from shell command text.
		// In guard mode Bash isolation relies on the worktree workflow; sandbox additionally
		// mounts unowned checkouts read-only where the host supports user namespaces and a
		// capability drop, so the confined command cannot undo those mounts.
		let checkouts: string[] = [];
		if (this.protectCheckouts !== "off") {
			const owned = this.db ? await owners(this.db) : [];
			const cwdRoot = primaryCheckoutOf(this.cwd, true);
			if (cwdRoot && !(await this.allowed(cwdRoot, owned))) {
				return err(new ExecutionError("unknown", `pana refused execution in an unowned checkout: ${cwdRoot}. Use your own worktree as cwd.`));
			}
			if (this.protectCheckouts === "sandbox" && this.namespace !== false) checkouts = await this.checkouts(owned);
		}
		const mounts = this.protectCheckouts === "sandbox" && this.namespace !== false && sandboxSupported() ? checkouts : [];
		if (mounts.length === 0) return super.exec(command, execOptions, context);
		const result = await super.exec(namespaced(mounts, command), execOptions, context);
		if (result.ok || !namespaceUnavailable(result.error)) {
			if (result.ok) this.namespace = true;
			return result;
		}
		// No `unshare` on this host (macOS), or user namespaces are off: the file tools still guard
		// (GUARD-01), and a `bash` call runs as it did before, once. The next call skips the wrapper.
		this.namespace = false;
		return super.exec(command, execOptions, context);
	}
}

/**
 * The `env` option for `Harness.open`: one clean environment per conversation, resolving the
 * session from the conversation so `bash` can export `PANA_SESSION` and attribute commits.
 */
/**
 * A session's memory worktree is made on first use: the first prompt render or tool call. Making
 * it at session create put a `git worktree add` on every create, which serialized burst creates.
 */
async function ensureMemoryWorktree(runtime: Runtime, sessionId: string): Promise<void> {
	if (existsSync(join(runtime.paths.memoryWorktrees, sessionId, ".git"))) return;
	try {
		await memoryFor(runtime).worktree({ id: sessionId, url: runtime.url({ kind: "session", id: sessionId }) });
	} catch (error) {
		// The session can still work without memory; `pana memory` will retry and report.
		console.error(`panad: memory worktree for session ${sessionId}:`, error);
	}
}

export function createPanaEnv(getRuntime: () => Runtime) {
	return async (target: { conversationId: number; cwd?: string }): Promise<ExecutionEnv> => {
		const runtime = getRuntime();
		const row = await runtime.db.get<{ id: string }>("SELECT id FROM sessions WHERE conversation_id = ?", target.conversationId);
		if (row) await ensureMemoryWorktree(runtime, row.id);
		// SCR-01: made on every open, because a sweep may have removed it while the session was idle.
		const scratch = row ? ensureScratch(runtime, row.id) : undefined;
		return new PanaExecutionEnv({
			// SCR-02: a session with no cwd of its own runs in its scratch; never in panad's cwd.
			cwd: target.cwd ?? scratch ?? homedir(),
			sessionId: row?.id,
			scratchDir: scratch,
			stateDir: runtime.paths.dir,
			db: runtime.db,
			managedLayouts: runtime.config.worktreeAdapters,
			protectCheckouts: runtime.config.tools.protectCheckouts,
		});
	};
}
