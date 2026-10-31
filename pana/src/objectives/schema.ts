// The objective's stored shape and the vocabulary the whole package shares (OBJ-01..OBJ-03).
//
// One migration (`src/db/schema.ts`, version 12) holds every table and column WP18 needs, because
// the packages that build on this one ship in parallel and none of them may add one. This file
// says what those columns mean; `state.ts` derives what is never stored.
//
// Nothing here is a state a function of other rows: `running`, `idle`, and `stranded` (OBJ-03),
// `paused` (OBJ-20..22), and `awaiting_user` (OBJ-33) are computed on read.

import { ApiError } from "../api/errors.ts";

/** The stored phase (OBJ-03). A check constraint holds this list in the migration. */
export type ObjectivePhase = "drafting" | "active" | "stopped" | "done" | "archived";
export const OBJECTIVE_PHASES: readonly ObjectivePhase[] = ["drafting", "active", "stopped", "done", "archived"];

/** The phases where an objective starts nothing and accepts no member work (OBJ-07). */
export const CLOSED_PHASES: readonly ObjectivePhase[] = ["stopped", "done", "archived"];

/**
 * The display state a read derives from other rows (OBJ-03). Never stored, never a phase:
 * `running` when a member is `running` or `waiting`, else `idle` while a wake or a metric check
 * is scheduled, else `stranded`. `null` for a phase that is not `active`, where the phase is what
 * a reader shows.
 */
export type ObjectiveDisplayState = "running" | "idle" | "stranded";

/** OBJ-07: `auto` lets a session finish the objective without the user's confirmation. */
export type ObjectiveAutonomy = "manual" | "auto";
export const OBJECTIVE_AUTONOMIES: readonly ObjectiveAutonomy[] = ["manual", "auto"];

/** OBJ-09: exactly these sections, in this order, stored in this canonical spelling. */
export const CHARTER_SECTIONS = ["Scope", "Cancel", "Done", "Guidance", "Escalation", "Notes"] as const;
export type CharterSection = (typeof CHARTER_SECTIONS)[number];

/** The per-objective limits (OBJ-16..OBJ-24). A null limit falls back to the config default. */
export interface ObjectiveLimits {
	maxDailyUsd: number | null;
	maxTotalUsd: number | null;
	wakeMinMinutes: number | null;
	maxDailyLeadTurns: number | null;
	maxDailyUserMessages: number | null;
	maxActiveMembers: number | null;
}

/** Where an effective limit comes from (OBJ-39: a meter names its limit's source). */
export type ObjectiveLimitSource = "objective" | "config" | "none";

/**
 * One limit as a gate applies it: the value that actually bites, and where it came from. A limit an
 * objective does not set falls back to `config.objectives` where a default exists (OBJ-18, OBJ-24),
 * and `none` means nothing bounds it at all. `value` is null exactly when `source` is `none`.
 */
export interface EffectiveLimit {
	value: number | null;
	source: ObjectiveLimitSource;
}

/** Every limit, each with the value that applies to this objective and where it came from. */
export type ObjectiveEffectiveLimits = Record<keyof ObjectiveLimits, EffectiveLimit>;

/** The `objectives` row. */
export interface ObjectiveRow {
	id: string;
	goal: string;
	phase: ObjectivePhase;
	creator_id: string;
	proposed_by: string | null;
	lead_id: string | null;
	thread_id: string | null;
	due_at: number | null;
	autonomy: ObjectiveAutonomy;
	max_daily_usd: number | null;
	max_total_usd: number | null;
	wake_min_minutes: number | null;
	max_daily_lead_turns: number | null;
	max_daily_user_messages: number | null;
	max_active_members: number | null;
	charter_rev: number;
	stranded_noticed_at: number | null;
	behind_noticed_at: number | null;
	created_at: number;
	updated_at: number;
}

/** A session acting for an objective: the lead and every member carry the objective's `id`. */
export interface ObjectiveMemberRow {
	id: string;
	url: string;
	state: string;
	parent: string | null;
	objective_id: string | null;
	stopped_by: "user" | "objective" | null;
	hold_until: number | null;
	/** OBJ-12: what a member may touch in the world is its profile, cwd, and bash credentials. */
	profile: string | null;
	created_at: number;
}

/** The event kinds the package records on `objective_events` (OBJ-23). Later packages add theirs. */
export type ObjectiveEventKind =
	| "created"
	| "launched"
	| "stopped"
	| "resumed"
	| "done"
	| "archived"
	| "charter.set"
	| "metric.target"
	| "run.refused"
	| "run.held"
	| "run.started"
	| "run.ended"
	| "member.created"
	| "member.refused"
	| "budget"
	| "escalated"
	| "escalation.cleared"
	| "regenerated"
	| "stranded"
	| "behind";

// --- Input ---------------------------------------------------------------------

function objectBody(value: unknown): Record<string, unknown> {
	if (value === undefined || value === null) return {};
	if (typeof value !== "object" || Array.isArray(value)) {
		throw ApiError.badRequest("invalid_body", "request body must be a JSON object");
	}
	return value as Record<string, unknown>;
}

export { objectBody };

/** A non-empty goal. `--goal-file` is read by the CLI, so the API only ever sees the text. */
export function goalText(value: unknown): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw ApiError.badRequest("missing_goal", "an objective needs --goal TEXT or --goal-file PATH");
	}
	return value;
}

/** An optional positive number, or null: a limit of zero would stop the objective at birth. */
export function optionalLimit(value: unknown, field: string): number | null {
	if (value === undefined || value === null || value === "") return null;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw ApiError.badRequest(`invalid_${field}`, `${field} must be a positive number`);
	}
	return value;
}

/** An optional `dueAt`: epoch milliseconds or an ISO timestamp. */
export function optionalDueAt(value: unknown): number | null {
	if (value === undefined || value === null || value === "") return null;
	if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (!Number.isNaN(parsed)) return parsed;
	}
	throw ApiError.badRequest("invalid_due_at", "dueAt must be an ISO timestamp or epoch milliseconds");
}

export function autonomyValue(value: unknown): ObjectiveAutonomy {
	if (value === undefined || value === null || value === "") return "manual";
	if (typeof value !== "string" || !(OBJECTIVE_AUTONOMIES as readonly string[]).includes(value)) {
		throw ApiError.badRequest("invalid_autonomy", `autonomy must be ${OBJECTIVE_AUTONOMIES.join(" or ")}`);
	}
	return value as ObjectiveAutonomy;
}

/** A phase filter for `GET /objectives`. */
export function phaseFilter(value: string | undefined): ObjectivePhase | undefined {
	if (value === undefined || value === "") return undefined;
	if (!(OBJECTIVE_PHASES as readonly string[]).includes(value)) {
		throw ApiError.badRequest("invalid_phase", `phase must be one of ${OBJECTIVE_PHASES.join(", ")}`);
	}
	return value as ObjectivePhase;
}

export function limitsOf(row: ObjectiveRow): ObjectiveLimits {
	return {
		maxDailyUsd: row.max_daily_usd,
		maxTotalUsd: row.max_total_usd,
		wakeMinMinutes: row.wake_min_minutes,
		maxDailyLeadTurns: row.max_daily_lead_turns,
		maxDailyUserMessages: row.max_daily_user_messages,
		maxActiveMembers: row.max_active_members,
	};
}
