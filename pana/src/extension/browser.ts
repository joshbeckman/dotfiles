// The browser daemon a session drives (ISO-06, ISO-07).
//
// `chrome-devtools` scopes a daemon with a hidden global `--sessionId`: its socket, its pid file,
// and its headless Chrome are all keyed by that id. Unscoped, every session and every checkout on
// one machine drive a single browser and a single page selection, so a sibling session's
// `new_page` steals the page under evaluation and its `close_page` can close the tab. The
// `bin/chrome-devtools` shim passes `PANA_BROWSER_SESSION` for every session's bash (ISO-06), and
// this module names that scope, finds the daemons it left behind, and stops them (ISO-07).
//
// A stop is cheap to get wrong in one direction only: the next `chrome-devtools` command starts a
// fresh daemon in about a second, where a kept daemon holds a headless Chrome for as long as the
// session sits idle. So the idle TTL here is minutes, not the days scratch uses.

import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { isUlid } from "../ids/index.ts";
import type { Runtime } from "../server/runtime.ts";
import type { SessionState } from "../sessions/runtime.ts";

const run = promisify(execFile);

/** A daemon's app name prefix, as `getSocketPath` in chrome-devtools-mcp builds it. */
const DAEMON_PREFIX = "chrome-devtools-mcp";

export const MINUTE_MS = 60 * 1000;

/** A session that has not run for this long gives its browser back. */
export const BROWSER_IDLE_MS = 10 * MINUTE_MS;

const SWEEP_EVERY_MS = BROWSER_IDLE_MS / 2;

/** A session in these states may be browsing right now; its daemon stays. */
const WORKING: readonly SessionState[] = ["running", "waiting"];

/**
 * The `--sessionId` a session's calls carry, exported as PANA_BROWSER_SESSION.
 *
 * It has to be hex. `assertValidSessionId` in chrome-devtools-mcp's `daemon/utils.js` rejects any
 * other id — `^[a-fA-F0-9-]+$` — on every command, before a daemon is even looked for, with
 * `Error: Invalid sessionId: …`. A ULID has letters past `f`, and so does a `pana-` prefix, so a
 * scope that spells the session id can never work. This is the session ULID's bytes in hex, so
 * `01HZZ…` becomes `3031485a5a…`: stable per session, valid, and reversible, because a sweep has
 * only a socket name to find the session that owns a daemon (ISO-07).
 */
export function browserScope(sessionId: string): string {
	return Buffer.from(sessionId, "utf8").toString("hex");
}

/** The shape chrome-devtools-mcp accepts for `--sessionId` (`assertValidSessionId`). */
export const SCOPE_PATTERN = /^[a-fA-F0-9-]+$/;

/**
 * The session a scope belongs to, or undefined for a scope this module did not make. The socket is
 * all a sweep has to go on, so the scope has to carry the session back to its row.
 */
export function scopeSession(scope: string): string | undefined {
	if (!/^(?:[0-9a-f]{2})+$/.test(scope)) return undefined;
	const session = Buffer.from(scope, "hex").toString("utf8");
	return isUlid(session) ? session : undefined;
}

export interface FoundBrowser {
	session: string;
	scope: string;
	socket: string;
}

export interface FindBrowsersOptions {
	/** Where the CLI keeps its sockets: `$XDG_RUNTIME_DIR`, else `/tmp` (daemon/utils.js). */
	dir?: string;
	/** The user id the CLI puts in a `/tmp` socket name. */
	uid?: number;
}

/**
 * Every scoped daemon on this machine. The CLI names a `/tmp` socket
 * `chrome-devtools-mcp-<scope>-<uid>.sock`, and an XDG one `<dir>/chrome-devtools-mcp-<scope>/server.sock`.
 */
export function findBrowsers(options: FindBrowsersOptions = {}): FoundBrowser[] {
	const dir = options.dir ?? process.env.XDG_RUNTIME_DIR ?? "/tmp";
	const uid = options.uid ?? process.getuid?.() ?? 0;
	if (!existsSync(dir)) return [];
	const found: FoundBrowser[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const match = entry.isDirectory()
			? new RegExp(`^${DAEMON_PREFIX}-(.+)$`).exec(entry.name)
			: new RegExp(`^${DAEMON_PREFIX}-(.+)-${uid}\\.sock$`).exec(entry.name);
		const scope = match?.[1];
		if (!scope) continue;
		const session = scopeSession(scope);
		if (!session) continue;
		found.push({ session, scope, socket: entry.isDirectory() ? join(dir, entry.name, "server.sock") : join(dir, entry.name) });
	}
	return found;
}

/** Stop one scope's daemon through the CLI. A missing CLI or a dead daemon is not an error. */
export async function stopBrowserDaemon(scope: string): Promise<void> {
	await run("chrome-devtools", ["--sessionId", scope, "stop"]).catch(() => undefined);
}

export type BrowserReason = "archived" | "idle" | "orphan";

export interface BrowserStop extends FoundBrowser {
	reason: BrowserReason;
}

export interface SweepBrowsersOptions {
	/** The daemons to consider; `findBrowsers()` by default. Tests pass their own. */
	browsers?: FoundBrowser[];
	/** How a daemon is stopped; the real CLI by default. Tests pass a recorder. */
	stop?: (scope: string) => Promise<void>;
	now?: number;
	idleMs?: number;
}

interface Owner {
	state: SessionState;
	updated_at: number;
}

/** Why this daemon is stopped, or undefined to keep it. */
function reasonFor(owner: Owner | undefined, now: number, idleMs: number): BrowserReason | undefined {
	if (!owner) return "orphan";
	if (owner.state === "archived") return "archived";
	if (WORKING.includes(owner.state)) return undefined;
	return now - owner.updated_at >= idleMs ? "idle" : undefined;
}

/** ISO-07: stop the daemons of archived sessions, of sessions idle past the TTL, and of no session. */
export async function sweepBrowsers(runtime: Runtime, options: SweepBrowsersOptions = {}): Promise<BrowserStop[]> {
	const now = options.now ?? runtime.clock.now();
	const idleMs = options.idleMs ?? BROWSER_IDLE_MS;
	const stop = options.stop ?? stopBrowserDaemon;
	const stopped: BrowserStop[] = [];
	for (const browser of options.browsers ?? findBrowsers()) {
		const owner = await runtime.db.get<Owner>("SELECT state, updated_at FROM sessions WHERE id = ?", browser.session);
		const reason = reasonFor(owner, now, idleMs);
		if (!reason) continue;
		await stop(browser.scope);
		stopped.push({ ...browser, reason });
	}
	return stopped;
}

/** ISO-07: archiving a session stops its browser now, rather than at the next sweep. */
export async function stopArchivedBrowser(
	runtime: Runtime,
	sessionId: string,
	options: { browsers?: FoundBrowser[]; stop?: (scope: string) => Promise<void> } = {},
): Promise<boolean> {
	const scope = browserScope(sessionId);
	const found = (options.browsers ?? findBrowsers()).find((browser) => browser.scope === scope);
	if (!found) return false;
	await (options.stop ?? stopBrowserDaemon)(scope);
	return true;
}

export interface BrowserSweeper {
	/** The sweep in progress, if any; tests await it. */
	current(): Promise<BrowserStop[]> | undefined;
	close(): Promise<void>;
}

/** Sweep now, then every five minutes on `runtime.clock` (ISO-07). */
export function startBrowserSweeper(
	runtime: Runtime,
	report: (error: unknown, what: string) => void,
	options: SweepBrowsersOptions = {},
): BrowserSweeper {
	let closed = false;
	let cancel: (() => void) | undefined;
	let inFlight: Promise<BrowserStop[]> | undefined;

	const kick = () => {
		if (closed) return;
		// Armed before the sweep starts, so a slow stop cannot delay the next one, and a sweep
		// still running when the timer fires is not doubled. Not background: the test clock
		// declines background timers, and close() cancels this one so it cannot hold panad open.
		cancel = runtime.clock.setTimer(kick, SWEEP_EVERY_MS, { background: false });
		if (inFlight) return;
		const sweep = sweepBrowsers(runtime, options);
		inFlight = sweep;
		sweep
			.catch((error) => report(error, "browser sweep"))
			.finally(() => {
				if (inFlight === sweep) inFlight = undefined;
			});
	};

	kick();
	return {
		current: () => inFlight,
		async close() {
			closed = true;
			cancel?.();
			await inFlight?.catch(() => undefined);
		},
	};
}
