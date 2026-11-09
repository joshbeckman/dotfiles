// The box a session-authored check runs in (SCH-09, SCH-12, OBJ-26).
//
// A check is defined once and then runs on panad's own clock with panad's identity, long after
// the request that defined it returned. #201/#256 took panad's environment away from that run
// (see `check.ts`). A session may define a check, so this file takes the rest away: the check
// runs where the authoring session's own `bash` runs, in that session's box - its scratch, the
// worktrees it owns, its memory worktree - and nowhere else. The user's own check keeps the
// user's choice of cwd.
//
// The rule is stated once here and enforced twice from it: `planCheck` refuses a cwd outside the
// box with a 400 while the check is defined, and `boxRefusal` (called by `runCheck`) records a
// failure rather than executing somewhere else if a stored row ever names one.

import type { SqliteExecutor } from "@earendil-works/chord/sqlite";
import { isAbsolute, join } from "node:path";
import { ApiError } from "../api/errors.ts";
import type { Caller } from "../api/types.ts";
import { realPath, under } from "../extension/checkouts.ts";
import { ensureScratch } from "../scratch/index.ts";
import type { Runtime } from "../server/runtime.ts";
import { ownedPaths } from "../worktrees/ownership.ts";

/** The directories a session's commands may write: its scratch and every checkout it owns. */
export interface SessionBox {
	/** The session whose box it is. */
	id: string;
	/** Where the session's commands run when nobody names a directory: its scratch (SCR-01). */
	scratchDir: string;
	/** Every directory a check authored by this session may use as its cwd. */
	roots: readonly string[];
}

/** GUARD-03..07: the box of one session, read from panad's state rather than supplied. */
export function sessionBox(runtime: Runtime, sessionId: string): SessionBox {
	const scratchDir = join(runtime.paths.scratch, sessionId);
	return {
		id: sessionId,
		scratchDir,
		roots: [
			scratchDir,
			join(runtime.paths.dir, "worktrees", sessionId),
			join(runtime.paths.memoryWorktrees, sessionId),
			// GUARD-07: an adapter's trees live outside the state layout; the receipt names its owner.
			...ownedPaths(runtime.paths.dir, sessionId),
		].map(realPath),
	};
}

/** Why `cwd` is outside a session's box, or undefined when it is inside one of its roots. */
export function boxRefusal(box: SessionBox, cwd: string): string | undefined {
	const path = realPath(cwd);
	if (box.roots.some((root) => under(root, path))) return undefined;
	return (
		`${cwd} is outside session ${box.id}'s box, and a check a session defines runs only there: ` +
		`its scratch (${box.scratchDir}), a worktree it owns, or its memory worktree`
	);
}

/** The check a create or an update ends up with. */
export interface CheckPlan {
	command: string | null;
	cwd: string | null;
	/** The session whose box the check runs in; null is the user's own check. */
	author: string | null;
}

/** The fields that name a check, as an API body carries them. */
export interface CheckInput {
	check?: unknown;
	checkCwd?: unknown;
}

/**
 * SCH-09/OBJ-26: decide which check a write ends up with. This is the one place the user's rule
 * and a session's differ: the user may name any absolute cwd (panad's own when none is given),
 * while a session's check is confined to its box and defaults to its scratch. A write that
 * carries neither field leaves the stored check, its cwd, and its author alone.
 */
export function planCheck(runtime: Runtime, caller: Caller, input: CheckInput, existing: CheckPlan): CheckPlan {
	const author = caller.kind === "user" ? null : caller.id;
	if (input.check === undefined && input.checkCwd === undefined) return existing;
	const command = input.check === undefined ? existing.command : input.check;
	if (command !== null && (typeof command !== "string" || command.trim().length === 0)) {
		throw ApiError.badRequest("invalid_check", "--check must be a nonempty bash command");
	}
	if (command === null) {
		if (input.checkCwd !== undefined && input.checkCwd !== null && input.checkCwd !== "") {
			throw ApiError.badRequest("invalid_check_cwd", "--check-cwd requires --check");
		}
		return { command: null, cwd: null, author: null };
	}
	// A new command keeps a cwd only when the same author chose it inside a box it still owns.
	const keep = input.checkCwd === undefined && existing.command !== null && existing.cwd !== null && existing.author === author;
	const cwd = keep ? existing.cwd! : (input.checkCwd ?? (author === null ? process.cwd() : ensureScratch(runtime, author)));
	if (typeof cwd !== "string" || !isAbsolute(cwd)) {
		throw ApiError.badRequest("invalid_check_cwd", "--check-cwd requires --check and an absolute directory path");
	}
	if (author !== null) {
		const refusal = boxRefusal(sessionBox(runtime, author), cwd);
		if (refusal !== undefined) throw ApiError.badRequest("invalid_check_cwd", refusal);
	}
	return { command, cwd, author };
}

// --- Stored authorship ----------------------------------------------------------
//
// The author is stored beside the check, keyed by what owns the check, so a check's row is the
// same shape whether it is a schedule's or a metric's.

/** The scope key for a schedule's check. */
export function scheduleScope(scheduleId: string): string {
	return `schedule:${scheduleId}`;
}

/** The scope key for a metric's check. */
export function metricScope(objectiveId: string, name: string): string {
	return `metric:${objectiveId}/${name}`;
}

/** The session whose box a stored check runs in, or null for the user's check. */
export async function checkAuthor(db: SqliteExecutor, scope: string): Promise<string | null> {
	const row = await db.get<{ session_id: string }>("SELECT session_id FROM check_authors WHERE scope = ?", scope);
	return row?.session_id ?? null;
}

/** Record the session whose box a check runs in, or clear it for the user's own check. */
export async function saveCheckAuthor(tx: SqliteExecutor, scope: string, sessionId: string | null, now: number): Promise<void> {
	if (sessionId === null) await tx.run("DELETE FROM check_authors WHERE scope = ?", scope);
	else await tx.run(
		"INSERT OR REPLACE INTO check_authors (scope, session_id, updated_at) VALUES (?, ?, ?)",
		scope,
		sessionId,
		now,
	);
}
