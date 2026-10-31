// Objectives (WP18). An objective is stated work with a lifetime: a goal, a charter of standing
// instructions, one lead that coordinates, members that do the work, and accounting that stops it.
//
// This package owns the schema and the route surface the rest of WP18 builds on:
// - `schema.ts` — the stored shape and the package's vocabulary (the migration is version 12).
// - `state.ts` — reads, and the one derived display state every package reuses (OBJ-03).
// - `store.ts` — create (OBJ-01, OBJ-04).
// - `launch.ts` — launch in one transaction (OBJ-05).
// - `gates.ts` — stop, resume, done, archive (OBJ-07).
// - `metrics.ts` — declared metrics, append-only readings, and the derived baseline and current
//   value (OBJ-25, OBJ-27..OBJ-29).
// - `metric-checks.ts` — the metric check loop on `runtime.clock` with no session (OBJ-26).
// - `view.ts` — the read shape (extend `showObjective` for a new field on `GET /objectives/:id`).
// - `brief.ts` — the lead's briefing seam (OBJ-32), a stub until the briefing package lands.
// - `handlers.ts` — HTTP, one line per route.
// - `cli.ts` — the `pana objective` command table.
//
// This package's reports, artifacts, and notices:
// - `reports.ts` — a report is a message in the objective's thread plus its mark (OBJ-30).
// - `artifacts.ts` — an artifact is an uploaded file plus a link (OBJ-31).
// - `pace.ts` — the pace needed against the pace achieved for a `dueAt` (OBJ-08); the briefing
//   calls it rather than growing a second copy.
// - `sweep.ts` — the stranded notice (OBJ-06) and the behind notice (OBJ-08) on `runtime.clock`.
//
// Later packages add `hold.ts`, `brief.ts` (replacing the stub), and `escalation.ts` beside these,
// one handler line each to `handlers.ts`, and their commands to `cli.ts`.

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
export {
	admitRun,
	admitScheduledWake,
	heldDeliveries,
	holdLead,
	memberCreateGate,
	recordBudgetHold,
	recordRunEnded,
	releaseLeadHold,
	type HoldCondition,
	type RunAdmission,
	type RunIntent,
} from "./hold.ts";
export {
	lastLeadRunEnd,
	leadRunsToday,
	objectiveConditions,
	objectiveCostToday,
	objectiveCostTotal,
	objectivePaused,
	objectiveRunsToday,
	objectiveUserMessagesToday,
	type ObjectiveConditions,
	type ObjectivePaused,
} from "./limits.ts";
export { launchObjective } from "./launch.ts";
export { addArtifact, objectiveArtifacts, removeArtifact, type ObjectiveArtifactView } from "./artifacts.ts";
export {
	behindPaces,
	metricPaces,
	paceLine,
	paceNumber,
	paceOf,
	DAY_MS as PACE_DAY_MS,
	type MetricPace,
	type MetricReading,
	type PaceInput,
} from "./pace.ts";
export {
	newestReport,
	reportMessages,
	reportObjective,
	type ObjectiveReportView,
	type ReportInput,
} from "./reports.ts";
export {
	OBJECTIVE_SWEEP_MS,
	startObjectiveSweeper,
	sweepObjectives,
	type BudgetCondition,
	type ObjectiveNotice,
	type ObjectiveSweepOptions,
	type ObjectiveSweepResult,
	type ObjectiveSweeper,
} from "./sweep.ts";
export { archiveObjective, finishObjective, resumeObjective, stopAllObjectives, stopObjective } from "./gates.ts";
export {
	METRIC_AGGREGATIONS,
	METRIC_DIRECTIONS,
	METRIC_NAME,
	READING_SOURCES,
	addMetric,
	aggregate,
	appendReading,
	formatValue,
	listMetrics,
	metricRow,
	metricRows,
	metricView,
	setMetric,
	type MetricAggregation,
	type MetricCheckView,
	type MetricCurrentView,
	type MetricDirection,
	type MetricReadingRow,
	type MetricReadingView,
	type MetricRow,
	type MetricView,
	type MetricsView,
	type ReadingSource,
} from "./metrics.ts";
export {
	dueMetricChecks,
	evaluated,
	nextCheckTime,
	nextMetricCheckAt,
	startMetricChecks,
	type DueMetricCheck,
	type MetricChecks,
} from "./metric-checks.ts";
export {
	listObjectives,
	objectiveReadings,
	objectiveView,
	showObjective,
	type ObjectiveReadings,
	type ObjectiveListFilters,
	type ObjectiveListOptions,
	type ObjectiveMemberView,
	type ObjectivePersonView,
	type ObjectiveView,
} from "./view.ts";
