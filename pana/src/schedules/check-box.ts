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
import { primaryCheckoutOf, realPath, under } from "../extension/checkouts.ts";
import { ensureScratch } from "../scratch/index.ts";
import type { Runtime } from "../server/runtime.ts";
import { checkoutCommon, ownedPaths } from "../worktrees/ownership.ts";

/** The paths that define a session's check box. Resolve their provenance on every use. */
export interface SessionBox {
	id: string;
	state: string;
	scratchDir: string;
}

export function sessionBox(runtime: Runtime, sessionId: string): SessionBox {
	return { id: sessionId, state: realPath(runtime.paths.dir), scratchDir: join(runtime.paths.scratch, sessionId) };
}

/** Why `cwd` is outside the box, or undefined when its current provenance is valid. */
export function boxRefusal(box: SessionBox, cwd: string): string | undefined {
	const scratch = join(box.state, "scratch", box.id);
	const worktrees = join(box.state, "worktrees", box.id);
	const memory = join(box.state, "memory", "worktrees", box.id);
	// Do not canonicalize a session namespace into its target: a replaced namespace must grant
	// nothing. Resolve the state root separately so system aliases like macOS /var remain valid.
	const localRoots = [scratch, worktrees, memory].filter((root) => realPath(root) === root);
	const external = ownedPaths(box.state, box.id);
	const path = realPath(cwd);
	const checkout = primaryCheckoutOf(path, true);
	const ownsCheckout = checkout === undefined || external.includes(checkout) ||
		[worktrees, memory].some((root) => localRoots.includes(root) && under(root, checkout) &&
			(root !== worktrees || checkout !== root) && checkoutCommon(checkout) !== undefined);
	if (ownsCheckout && [...localRoots, ...external].some((root) => under(root, path))) return undefined;
	return (
		`${cwd} is outside session ${box.id}'s box, and a check a session defines runs only there: ` +
		`its scratch (${box.scratchDir}), a worktree it owns, or its memory worktree`
	);
}

/** The check a create or an update ends up with. */
export interface CheckPlan {
	command: string | null;
	cwd: string | null;
	/** Session ID, null for an explicit user author, or undefined when authority is unknown. */
	author: string | null | undefined;
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
	if (existing.command !== null && existing.author === undefined && input.check === undefined) {
		throw ApiError.badRequest("missing_check_author", "redefine the check command to establish its author");
	}
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
	const needsScratch = !keep && input.checkCwd == null && author !== null;
	const cwd = keep ? existing.cwd! : (input.checkCwd ?? (author === null ? process.cwd() : join(runtime.paths.scratch, author)));
	if (typeof cwd !== "string" || !isAbsolute(cwd)) {
		throw ApiError.badRequest("invalid_check_cwd", "--check-cwd requires --check and an absolute directory path");
	}
	if (author !== null) {
		const refusal = boxRefusal(sessionBox(runtime, author), cwd);
		if (refusal !== undefined) throw ApiError.badRequest("invalid_check_cwd", refusal);
	}
	if (needsScratch) ensureScratch(runtime, author!);
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

// Empty cannot be a session ID. Older databases stored no row for a user check, which is
// indistinguishable from a lost session author; those checks must be explicitly redefined.
const USER_AUTHOR = "";

/** Null is an explicit user author; undefined means unknown and must never run as the user. */
export async function checkAuthor(db: SqliteExecutor, scope: string): Promise<string | null | undefined> {
	const row = await db.get<{ session_id: string }>("SELECT session_id FROM check_authors WHERE scope = ?", scope);
	if (!row) return undefined;
	return row.session_id === USER_AUTHOR ? null : row.session_id;
}

/** Store an explicit author, preserve unknown authority, or remove it with the check. */
export async function saveCheckAuthor(tx: SqliteExecutor, scope: string, author: string | null | undefined, now: number, hasCheck = true): Promise<void> {
	if (!hasCheck) await tx.run("DELETE FROM check_authors WHERE scope = ?", scope);
	else if (author !== undefined) await tx.run(
		"INSERT OR REPLACE INTO check_authors (scope, session_id, updated_at) VALUES (?, ?, ?)",
		scope,
		author ?? USER_AUTHOR,
		now,
	);
}
