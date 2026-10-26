// Session scratch directories and their sweep (SCR-01..SCR-07).
//
// Scratch is disposable and memory is durable. The sweep deletes scratch and never copies it into
// memory: the session decides what is worth keeping while it still has the context.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { isUlid } from "../ids/index.ts";
import type { Runtime } from "../server/runtime.ts";
import type { SessionState } from "../sessions/runtime.ts";

const run = promisify(execFile);

export const DAY_MS = 24 * 60 * 60 * 1000;
const SWEEP_EVERY_MS = DAY_MS;
const TRASH_PREFIX = ".removing-";
/** A session in these states may be using its scratch right now; nothing removes it. */
const WORKING: readonly SessionState[] = ["running", "waiting"];

export type ScratchReason = "archived" | "orphan" | "idle" | "over_total";

export interface ScratchRemoval {
	session: string;
	path: string;
	reason: ScratchReason;
	bytes: number | null;
}

export interface SweepResult {
	dryRun: boolean;
	removed: ScratchRemoval[];
	removedBytes: number;
}

interface Owner {
	state: SessionState;
	updated_at: number;
}

export function scratchPath(runtime: Runtime, sessionId: string): string {
	return join(runtime.paths.scratch, sessionId);
}

/** Make the session's scratch directory if it is missing, and return its path (SCR-01). */
export function ensureScratch(runtime: Runtime, sessionId: string): string {
	const path = scratchPath(runtime, sessionId);
	mkdirSync(path, { recursive: true });
	return path;
}

/**
 * The disk space a directory uses, or null when it does not exist.
 *
 * Rejected alternative: walking the tree in Node. A scratch can hold a cloned repo and its
 * `node_modules`; `du` sums that in C, and `-sk` means the same on macOS and Linux.
 */
export async function directoryBytes(path: string): Promise<number | null> {
	if (!existsSync(path)) return null;
	try {
		const { stdout } = await run("du", ["-sk", path], { maxBuffer: 1024 * 1024 });
		return parseDu(stdout);
	} catch (error) {
		// `du` still prints a total when some entry is unreadable, and exits 1.
		const stdout = (error as { stdout?: string }).stdout;
		return stdout ? parseDu(stdout) : null;
	}
}

function parseDu(stdout: string): number | null {
	const kib = Number.parseInt(stdout.trim().split(/\s+/)[0] ?? "", 10);
	return Number.isFinite(kib) ? kib * 1024 : null;
}

/** Why the sweep removes this scratch, or undefined to keep it. */
function reasonFor(owner: Owner | undefined, mtimeMs: number, now: number, ttlMs: number): ScratchReason | undefined {
	if (!owner) return now - mtimeMs >= ttlMs ? "orphan" : undefined;
	if (owner.state === "archived") return "archived";
	if (WORKING.includes(owner.state)) return undefined;
	return now - owner.updated_at >= ttlMs ? "idle" : undefined;
}

async function owner(runtime: Runtime, sessionId: string): Promise<Owner | undefined> {
	return runtime.db.get<Owner>("SELECT state, updated_at FROM sessions WHERE id = ?", sessionId);
}

function scratchEntries(runtime: Runtime): { id: string; path: string; mtimeMs: number }[] {
	if (!existsSync(runtime.paths.scratch)) return [];
	const entries = [];
	for (const entry of readdirSync(runtime.paths.scratch, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
		const path = join(runtime.paths.scratch, entry.name);
		entries.push({ id: entry.name, path, mtimeMs: statSync(path).mtimeMs });
	}
	return entries;
}

/**
 * Remove one scratch if `allowed` still holds. The check and the rename share a write
 * transaction, so a wake cannot start a run between them; the slow delete runs after the commit.
 */
async function remove(
	runtime: Runtime,
	removal: ScratchRemoval,
	allowed: (owner: Owner | undefined) => boolean,
): Promise<boolean> {
	const trash = join(runtime.paths.scratch, `${TRASH_PREFIX}${removal.session}-${runtime.newId()}`);
	let renamed = false;
	try {
		const applied = await runtime.db.write(async (tx) => {
			const row = await tx.get<Owner>("SELECT state, updated_at FROM sessions WHERE id = ?", removal.session);
			if (!allowed(row) || !existsSync(removal.path)) return false;
			renameSync(removal.path, trash);
			renamed = true;
			if (row) {
				await tx.run(
					"UPDATE sessions SET scratch_removed_at = ?, scratch_removed_bytes = ? WHERE id = ?",
					runtime.clock.now(),
					removal.bytes,
					removal.session,
				);
			}
			return true;
		});
		if (!applied) return false;
	} catch (error) {
		// A rolled-back transaction must not leave the session's files in the trash.
		if (renamed && existsSync(trash) && !existsSync(removal.path)) renameSync(trash, removal.path);
		throw error;
	}
	await rm(trash, { recursive: true, force: true });
	return true;
}

/** SCR-04: archiving a session removes its scratch. */
export async function removeArchivedScratch(runtime: Runtime, sessionId: string): Promise<void> {
	const path = scratchPath(runtime, sessionId);
	if (!existsSync(path)) return;
	const bytes = await directoryBytes(path);
	await remove(runtime, { session: sessionId, path, reason: "archived", bytes }, (row) => row?.state === "archived");
}

/** SCR-05: remove scratch that is archived, orphaned, idle past the TTL, or over the total cap. */
export async function sweepScratch(runtime: Runtime, options: { dryRun?: boolean } = {}): Promise<SweepResult> {
	const dryRun = options.dryRun === true;
	const now = runtime.clock.now();
	const ttlMs = runtime.config.scratch.ttlDays * DAY_MS;
	if (!dryRun) await clearTrash(runtime);

	const removed: ScratchRemoval[] = [];
	const kept: { id: string; path: string; owner: Owner }[] = [];
	for (const entry of scratchEntries(runtime)) {
		const row = isUlid(entry.id) ? await owner(runtime, entry.id) : undefined;
		const reason = reasonFor(row, entry.mtimeMs, now, ttlMs);
		if (reason === undefined) {
			if (row) kept.push({ id: entry.id, path: entry.path, owner: row });
			continue;
		}
		const removal = { session: entry.id, path: entry.path, reason, bytes: await directoryBytes(entry.path) };
		if (dryRun || (await remove(runtime, removal, (current) => reasonFor(current, entry.mtimeMs, runtime.clock.now(), ttlMs) !== undefined))) {
			removed.push(removal);
		}
	}

	const capMB = runtime.config.scratch.maxTotalMB;
	if (capMB !== undefined) {
		const cap = capMB * 1024 * 1024;
		const sized = [];
		let total = 0;
		for (const entry of kept) {
			const bytes = (await directoryBytes(entry.path)) ?? 0;
			total += bytes;
			sized.push({ ...entry, bytes });
		}
		// Longest idle first; a working session's scratch never counts as removable.
		const removable = sized.filter((entry) => !WORKING.includes(entry.owner.state)).sort((a, b) => a.owner.updated_at - b.owner.updated_at);
		for (const entry of removable) {
			if (total <= cap) break;
			const removal: ScratchRemoval = { session: entry.id, path: entry.path, reason: "over_total", bytes: entry.bytes };
			if (dryRun || (await remove(runtime, removal, (current) => current !== undefined && !WORKING.includes(current.state)))) {
				removed.push(removal);
				total -= entry.bytes;
			}
		}
	}

	return { dryRun, removed, removedBytes: removed.reduce((sum, removal) => sum + (removal.bytes ?? 0), 0) };
}

/** Finish deletes a crash interrupted after their transaction committed. */
async function clearTrash(runtime: Runtime): Promise<void> {
	if (!existsSync(runtime.paths.scratch)) return;
	for (const name of readdirSync(runtime.paths.scratch)) {
		if (name.startsWith(TRASH_PREFIX)) await rm(join(runtime.paths.scratch, name), { recursive: true, force: true });
	}
}

export interface ScratchSweeper {
	/** The sweep in progress, if any; tests await it. */
	current(): Promise<SweepResult> | undefined;
	close(): Promise<void>;
}

/** Sweep now, then every 24 hours on `runtime.clock` (SCR-05). */
export function startScratchSweeper(runtime: Runtime, report: (error: unknown, what: string) => void): ScratchSweeper {
	let closed = false;
	let cancel: (() => void) | undefined;
	let inFlight: Promise<SweepResult> | undefined;

	const kick = () => {
		if (closed) return;
		// The next sweep is armed before this one starts, so a slow `du` cannot delay it, and a
		// sweep still running when the timer fires is not doubled.
		// Not background: pi-durable reserves background timers for freeing memory, and the test
		// clock declines them. close() cancels this one, so it cannot hold panad open.
		cancel = runtime.clock.setTimer(kick, SWEEP_EVERY_MS, { background: false });
		if (inFlight) return;
		const sweep = sweepScratch(runtime);
		inFlight = sweep;
		sweep
			.catch((error) => report(error, "scratch sweep"))
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
