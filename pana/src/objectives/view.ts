// The objective view: one shape for `GET /objectives`, `GET /objectives/:id`, and the CLI.
//
// `objectiveView` is what a read shows. Later packages extend the show payload (OBJ-30's newest
// report, OBJ-31's artifacts, the escalation) by adding a field here in `showObjective`, and their
// own reads (metrics, brief) as their own routes. Nothing else in this package builds a view, so
// there is one place for those additions.

import { decodeCursor, pageOf, type Page } from "../api/pagination.ts";
import { isUlid } from "../ids/index.ts";
import type { Runtime } from "../server/runtime.ts";
import { sessionStates } from "../sessions/state.ts";
import { objectiveArtifacts, type ObjectiveArtifactView } from "./artifacts.ts";
import { newestReport, type ObjectiveReportView } from "./reports.ts";
import { limitsOf, type ObjectiveLimits, type ObjectiveMemberRow, type ObjectivePhase, type ObjectiveRow, type ObjectiveAutonomy, type ObjectiveDisplayState } from "./schema.ts";
import { leadRunsToday, objectiveCostToday, objectiveCostTotal, objectivePaused, objectiveUserMessagesToday, type ObjectivePaused } from "./limits.ts";
import { loadObjective, objectiveMembers, objectiveState, objectiveUrl, sessionUrl } from "./state.ts";

export interface ObjectivePersonView {
	id: string;
	url: string;
}

export interface ObjectiveMemberView {
	id: string;
	url: string;
	state: string;
	/** True for the objective's one lead (OBJ-05). */
	lead: boolean;
	/** OBJ-14: `user` or `objective` when this member was stopped, else null. */
	stoppedBy: "user" | "objective" | null;
}

export interface ObjectiveView {
	id: string;
	url: string;
	goal: string;
	phase: ObjectivePhase;
	/** OBJ-03: derived on read. Null for a phase that is not `active`. */
	state: ObjectiveDisplayState | null;
	/**
	 * OBJ-20..OBJ-22: the budget condition holding the objective, derived on read. `budget_total`
	 * outranks `budget_day`; `domain_budget` is LIM-03's backstop. Null when nothing holds it.
	 */
	paused: ObjectivePaused | null;
	/** OBJ-20/21, OBJ-24: today's and the lifetime spend, and today's lead runs and user messages. */
	spendTodayUsd: number;
	spendTotalUsd: number;
	leadRunsToday: number;
	userMessagesToday: number;
	creator: ObjectivePersonView;
	proposedBy: ObjectivePersonView | null;
	lead: ObjectivePersonView | null;
	thread: { id: string; url: string } | null;
	dueAt: number | null;
	autonomy: ObjectiveAutonomy;
	limits: ObjectiveLimits;
	charterRev: number;
	members: ObjectiveMemberView[];
	/**
	 * OBJ-30: the newest report, which the PWA shows as the objective's latest report. On
	 * `GET /objectives/:id` and `pana objective show`; the list leaves it out, because a page of
	 * objectives does not read every report body.
	 */
	report?: ObjectiveReportView | null;
	/** OBJ-31: the linked files, on `GET /objectives/:id` and `pana objective show` only. */
	artifacts?: ObjectiveArtifactView[];
	createdAt: number;
	updatedAt: number;
}

/** An ID as a person's URL: a ULID is a session, anything else the user. */
function person(runtime: Runtime, id: string | null): ObjectivePersonView | null {
	if (id === null) return null;
	return { id, url: isUlid(id) ? sessionUrl(runtime, id) : runtime.url({ kind: "user", id }) };
}

/** The stored view, from rows already in hand. */
export interface ObjectiveReadings {
	paused: ObjectivePaused | null;
	spendTodayUsd: number;
	spendTotalUsd: number;
	leadRunsToday: number;
	userMessagesToday: number;
}

const EMPTY_READINGS: ObjectiveReadings = { paused: null, spendTodayUsd: 0, spendTotalUsd: 0, leadRunsToday: 0, userMessagesToday: 0 };

export function objectiveView(
	runtime: Runtime,
	row: ObjectiveRow,
	members: readonly ObjectiveMemberRow[],
	state: ObjectiveDisplayState | null,
	states?: Map<string, string>,
	readings: ObjectiveReadings = EMPTY_READINGS,
): ObjectiveView {
	return {
		id: row.id,
		url: objectiveUrl(runtime, row.id),
		goal: row.goal,
		phase: row.phase,
		state,
		paused: readings.paused,
		spendTodayUsd: readings.spendTodayUsd,
		spendTotalUsd: readings.spendTotalUsd,
		leadRunsToday: readings.leadRunsToday,
		userMessagesToday: readings.userMessagesToday,
		creator: person(runtime, row.creator_id)!,
		proposedBy: person(runtime, row.proposed_by),
		lead: person(runtime, row.lead_id),
		thread: row.thread_id === null ? null : { id: row.thread_id, url: runtime.url({ kind: "thread", id: row.thread_id }) },
		dueAt: row.due_at,
		autonomy: row.autonomy,
		limits: limitsOf(row),
		charterRev: row.charter_rev,
		members: members.map((member) => ({
			id: member.id,
			url: member.url,
			state: states?.get(member.id) ?? member.state,
			lead: member.id === row.lead_id,
			stoppedBy: member.stopped_by,
		})),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

/**
 * `GET /objectives/:id`: the view with each member's current state, `waiting` included (STA-03),
 * the newest report (OBJ-30), and the linked artifacts (OBJ-31).
 */
export async function showObjective(runtime: Runtime, id: string): Promise<ObjectiveView> {
	const row = await loadObjective(runtime.db, id);
	const members = await objectiveMembers(runtime.db, row.id);
	const states = await sessionStates(runtime.db, runtime, members.map((member) => member.id));
	const state = await objectiveState(runtime.db, runtime, row);
	return {
		...objectiveView(runtime, row, members, state, states, await objectiveReadings(runtime, row)),
		report: await newestReport(runtime.db, runtime, row.id),
		artifacts: await objectiveArtifacts(runtime.db, runtime, row.id),
	};
}

/** OBJ-20..OBJ-24: the limits a read shows, from the same reads the admission gate uses. */
export async function objectiveReadings(runtime: Runtime, row: ObjectiveRow): Promise<ObjectiveReadings> {
	return {
		paused: await objectivePaused(runtime.db, runtime, row),
		spendTodayUsd: await objectiveCostToday(runtime.db, runtime, row.id),
		spendTotalUsd: await objectiveCostTotal(runtime.db, row.id),
		leadRunsToday: await leadRunsToday(runtime.db, runtime, row),
		userMessagesToday: await objectiveUserMessagesToday(runtime.db, runtime, row),
	};
}

export interface ObjectiveListFilters {
	phase?: ObjectivePhase;
	/** A username, a session ULID, or a same-domain URL; matched against `creator_id`. */
	creator?: string;
}

export interface ObjectiveListOptions extends ObjectiveListFilters {
	limit: number;
	cursor?: string | null;
}

/**
 * `GET /objectives`: newest first, paged by ULID like every other list (SCALE-03). The derived
 * state comes with each row, because the list shows it (OBJ-39).
 */
export async function listObjectives(runtime: Runtime, options: ObjectiveListOptions): Promise<Page<ObjectiveView>> {
	const where: string[] = [];
	const params: string[] = [];
	if (options.phase !== undefined) {
		where.push("phase = ?");
		params.push(options.phase);
	}
	if (options.creator !== undefined) {
		where.push("creator_id = ?");
		params.push(options.creator);
	}
	const before = decodeCursor(options.cursor, ["string"])?.[0] as string | undefined;
	const conditions = before === undefined ? where : [...where, "id < ?"];
	const rows = await runtime.db.all<ObjectiveRow>(
		`SELECT * FROM objectives ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`,
		...params,
		...(before === undefined ? [] : [before]),
		options.limit + 1,
	);
	const views: ObjectiveView[] = [];
	for (const row of rows) {
		const members = await objectiveMembers(runtime.db, row.id);
		views.push(objectiveView(runtime, row, members, await objectiveState(runtime.db, runtime, row), undefined, await objectiveReadings(runtime, row)));
	}
	return pageOf(views, options.limit, (view) => [view.id]);
}
