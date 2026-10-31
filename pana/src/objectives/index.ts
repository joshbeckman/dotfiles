// Objectives (WP18). An objective is stated work with a lifetime: a goal, a charter of standing
// instructions, one lead that coordinates, members that do the work, and accounting that stops it.
//
// This package owns the schema and the route surface the rest of WP18 builds on:
// - `schema.ts` — the stored shape and the package's vocabulary (the migration is version 12).
// - `state.ts` — reads, and the one derived display state every package reuses (OBJ-03).
// - `store.ts` — create (OBJ-01, OBJ-04).
// - `launch.ts` — launch in one transaction (OBJ-05).
// - `gates.ts` — stop, resume, done, archive (OBJ-07).
// - `view.ts` — the read shape (extend `showObjective` for a new field on `GET /objectives/:id`).
// - `brief.ts` — the lead's briefing seam (OBJ-32), a stub until the briefing package lands.
// - `handlers.ts` — HTTP, one line per route.
// - `cli.ts` — the `pana objective` command table.
//
// Later packages add `hold.ts`, `metrics.ts`, `brief.ts` (replacing the stub), `escalation.ts`, and
// `reports.ts` beside these, their routes to `src/api/routes.ts`, one handler line each to
// `handlers.ts`, and their commands to `cli.ts`.

export {
	CHARTER_SECTIONS,
	CLOSED_PHASES,
	OBJECTIVE_AUTONOMIES,
	OBJECTIVE_PHASES,
	autonomyValue,
	goalText,
	limitsOf,
	objectBody,
	optionalDueAt,
	optionalLimit,
	phaseFilter,
	type CharterSection,
	type ObjectiveAutonomy,
	type ObjectiveDisplayState,
	type ObjectiveEventKind,
	type ObjectiveLimits,
	type ObjectiveMemberRow,
	type ObjectivePhase,
	type ObjectiveRow,
} from "./schema.ts";
export {
	assertObjectiveOpen,
	closedObjectiveOf,
	loadObjective,
	objectiveId,
	objectiveMembers,
	objectiveRow,
	objectiveState,
	objectiveUrl,
	recordObjectiveEvent,
	sessionUrl,
	type ObjectiveEventInput,
} from "./state.ts";
export { createObjective, type CreateObjectiveInput, type CreatedObjective } from "./store.ts";
export { leadBriefing, type BriefingOptions } from "./brief.ts";
export { launchObjective } from "./launch.ts";
export { archiveObjective, finishObjective, resumeObjective, stopAllObjectives, stopObjective } from "./gates.ts";
export {
	listObjectives,
	objectiveView,
	showObjective,
	type ObjectiveListFilters,
	type ObjectiveListOptions,
	type ObjectiveMemberView,
	type ObjectivePersonView,
	type ObjectiveView,
} from "./view.ts";
