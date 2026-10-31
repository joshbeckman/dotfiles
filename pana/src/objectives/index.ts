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
// - `charter.ts` — the six sections and their append-only revisions (OBJ-09, OBJ-10).
// - `brief.ts` — the lead's briefing and the one charter renderer (OBJ-11, OBJ-12, OBJ-32, OBJ-37).
// - `escalation.ts` — asking the user to decide, and the scope of that hold (OBJ-33, OBJ-34).
// - `admission.ts` — the escalation half of `hold.ts`' `admitRun`, in its own shape (OBJ-33/34).
// - `lead.ts` — regenerating a failed lead (OBJ-35).
// - `stranded.ts` — what a failed lead leaves behind (OBJ-36).
// - `handlers.ts` — HTTP, one line per route.
// - `cli.ts` — the `pana objective` command table.
//
// This package's reports, artifacts, pace, and notices:
// - `reports.ts` — a report is a message in the objective's thread plus its mark (OBJ-30).
// - `artifacts.ts` — an artifact is an uploaded file plus a link (OBJ-31).
// - `pace.ts` — the pace needed against the pace achieved for a `dueAt` (OBJ-08).
// - `sweep.ts` — the stranded notice (OBJ-06) and the behind notice (OBJ-08) on `runtime.clock`.

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
	personView,
	recordObjectiveEvent,
	sessionUrl,
	type ObjectiveEventInput,
	type ObjectivePersonView,
} from "./state.ts";
export { createObjective, type CreateObjectiveInput, type CreatedObjective } from "./store.ts";
export {
	BRIEF_TITLE,
	MEMBER_SECTIONS,
	leadBriefing,
	leadRunInput,
	memberBriefing,
	renderCharter,
	type BriefingOptions,
	type CharterRenderOptions,
} from "./brief.ts";
export {
	charterLog,
	charterRevisions,
	charterSection,
	charterSections,
	charterText,
	optionalCharterSection,
	setCharter,
	type CharterRevisionRow,
	type CharterRevisionView,
	type CharterSectionView,
	type CharterView,
	type SetCharterInput,
} from "./charter.ts";
export {
	charterEscalationTimeout,
	clearDueEscalations,
	clearEscalations,
	clearForUserMessage,
	escalateObjective,
	escalationHold,
	escalationView,
	objectiveOfThread,
	openEscalations,
	startEscalationTimeouts,
	TIMEOUT_TICK_MS,
	type ClearEscalationsOptions,
	type EscalationRow,
	type EscalationView,
	type EscalateInput,
	type EscalationTimeouts,
} from "./escalation.ts";
export { objectiveRunHold } from "./admission.ts";
export { regenerateLead, type RegenerateInput } from "./lead.ts";
export { assertNotSupersededLead, recordLeadFailure, regenerateOffer, type LeadFailure } from "./stranded.ts";
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
	type ObjectiveNotice,
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
	type ObjectiveEscalationView,
	type ObjectiveListFilters,
	type ObjectiveListOptions,
	type ObjectiveMemberView,
	type ObjectiveReadings,
	type ObjectiveView,
} from "./view.ts";
