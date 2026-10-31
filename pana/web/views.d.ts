import type { ScheduleView } from "../src/schedules/store.ts";

// Types for the browser module `views.js`, which Node tests import directly.

export interface EntryUsage {
	input: number;
	output: number;
	costUsd: number;
}

export type EntryBlock =
	| { type: "text"; text: string; markdown?: true }
	| { type: "thinking"; text: string; markdown?: true }
	| { type: "tool-call"; name: string; callId?: string; arguments: Record<string, unknown> }
	| { type: "tool-result"; name: string; callId?: string; output: string; isError: boolean }
	| { type: "image"; mediaType: string }
	| { type: "json"; text: string };

export interface EntryView {
	id: number;
	kind: string;
	role: string;
	label: string;
	text: string;
	blocks: EntryBlock[];
	usage?: EntryUsage;
}

export function inboxRow(delivery: any): {
	threadId: string;
	messageId: string;
	messageUrl?: string;
	threadUrl?: string;
	subject: string;
	sender: string;
	at: number;
	read: boolean;
	unreadCount: number;
};
export interface PersonRef {
	url: string;
	kind: string;
}
/** UX-09: a session that is working in a thread. */
export interface WorkingSessionRef {
	sessionId: string;
	url: string;
	state: string;
}
export function isWorking(state: string): boolean;
export function workingOf(value: any): WorkingSessionRef[];
export function workingParticipants(thread: any): WorkingSessionRef[];
/** UX-09: a session participant with a wake pending, for the thread footer's scheduled chip. */
export interface ScheduledSessionRef {
	sessionId: string;
	url: string;
	at: number;
	scheduleUrl: string;
	subject: string;
	cron: string | null;
}
export function scheduledOf(thread: any): ScheduledSessionRef[];
export function untilLabel(at: number, now?: number): string;
export function inboxThreadRow(thread: any): {
	threadId: string;
	threadUrl?: string;
	subject: string;
	participants: PersonRef[];
	messageId?: string;
	messageUrl?: string;
	sender: PersonRef;
	snippet: string;
	at: number;
	unreadCount: number;
	archived: boolean;
	working: WorkingSessionRef[];
};
export const PALETTE: Record<"blue" | "orange" | "purple" | "green" | "red" | "yellow" | "black", string>;
export const SESSION_COLORS: string[];
export function participantColor(participant: string | { url?: string; kind?: string }): string;
export function refLabel(url: string): string;
export function shortTime(at: number, now?: number, locale?: string): string;
export function threadRow(thread: any): {
	id: string;
	url: string;
	subject: string;
	snippet?: string;
	at: number;
	working: WorkingSessionRef[];
};
export function messageView(message: any): {
	id: string;
	url?: string;
	threadId?: string;
	threadUrl?: string;
	sender: string;
	senderKind: string;
	at: number;
	body: string;
	revised: boolean;
	redacted: boolean;
};
export function entryView(entry: any): EntryView;
export function entryRaw(entry: any): string;
export function elapsedLabel(ms: number): string;
export function liveActivityLabel(live: { activity?: string; since?: number } | null | undefined, now: number): string;
export function commitView(commit: any): { hash: string; short: string; author: string; at: string; message: string };
export function memoryHitView(hit: any): { path: string; text: string };
export function memoryFileView(file: any): { path: string; url: string; content: string; commit: string };
export interface MemoryCommitFileView {
	path: string;
	status: string;
	additions: number;
	deletions: number;
	binary: boolean;
	patch: string;
	truncated: boolean;
}
export function memoryCommitFileView(file: any): MemoryCommitFileView;
export interface MemoryCommitDetailView {
	hash: string;
	short: string;
	author: string;
	at: unknown;
	subject: string;
	body: string;
	parents: string[];
	files: MemoryCommitFileView[];
	truncated: boolean;
}
export function memoryCommitView(commit: any): MemoryCommitDetailView;
export function scheduleWhen(schedule: { cron?: string | null; at?: number | null }): string;
export function scheduleBody(
	form: { subject?: string; kind?: string; when?: string; text?: string; to?: string },
	editing?: { subject?: string; kind?: string; payload?: Record<string, unknown> },
): { subject?: string | null; kind: string; payload: Record<string, unknown>; cron?: string; at?: string };

export function scheduleCheckView(
	schedule: Partial<Pick<ScheduleView, "check" | "checkCwd" | "stopAfterSuccess" | "lastCheck">>,
	formatTime?: (time: number) => string,
): { status: string; text: string } | null;

export interface TranscriptPageView {
	entries: any[];
	previous?: number;
}
export function transcriptPage(body: any): TranscriptPageView;

// ---- Objectives (OBJ-39) ----------------------------------------------------------------------

export const CHARTER_SECTIONS: string[];
export function holdingLabel(paused: string | null | undefined): string;
export function holdingOf(objective: any): string;
export interface ObjectiveRowView {
	id: string;
	url: string;
	goal: string;
	phase: string;
	state: string | null;
	paused: string | null;
	awaitingUser: boolean;
	holding: string;
	lead: string;
	spendTodayUsd: number;
	leadRunsToday: number;
	dueAt: number | null;
	at: number;
}
export function objectiveRow(objective: any): ObjectiveRowView;
export interface ObjectiveMeterView {
	id: string;
	label: string;
	value: number;
	limit: number | null;
	unit: "usd" | "count";
	/** OBJ-39: where the limit came from, so a reader can see a bar that is not the objective's own. */
	source: "objective" | "config" | "none";
	share: number | null;
	over: boolean;
}
export function objectiveMeters(objective: any): ObjectiveMeterView[];
export function isActiveMember(state: string | null | undefined): boolean;
export interface ObjectiveMemberView {
	id: string;
	url: string;
	state: string;
	lead: boolean;
	stoppedBy: "user" | "objective" | null;
	profile: string | null;
}
export function objectiveMember(member: any): ObjectiveMemberView;
export interface ObjectiveEscalationView {
	id: string;
	scope: "objective" | "member";
	member: string;
	url: string;
	messageId: string;
	threadUrl: string;
	threadId: string;
	timeoutAt: number | null;
}
export function objectiveEscalation(escalation: any): ObjectiveEscalationView;
export interface ObjectiveReportView {
	messageId: string;
	url: string;
	threadUrl: string;
	sender: string;
	at: number;
	body: string;
	revised: boolean;
	redacted: boolean;
}
export function objectiveReport(report: any): ObjectiveReportView | null;
export interface ObjectiveArtifactView {
	id: string;
	name: string;
	size: number;
	mediaType: string | null;
	url: string;
	addedAt: number;
}
export function objectiveArtifact(artifact: any): ObjectiveArtifactView;
export interface ObjectiveDetailView {
	id: string;
	url: string;
	goal: string;
	phase: string;
	state: string | null;
	paused: string | null;
	awaitingUser: boolean;
	holding: string;
	creator: string;
	proposedBy: string | null;
	lead: string | null;
	thread: { id: string; url: string } | null;
	dueAt: number | null;
	autonomy: "manual" | "auto";
	charterRev: number;
	limits: {
		maxDailyUsd: number | null;
		maxTotalUsd: number | null;
		wakeMinMinutes: number | null;
		maxDailyLeadTurns: number | null;
		maxDailyUserMessages: number | null;
		maxActiveMembers: number | null;
	};
	/** OBJ-39: each limit as a meter draws it — the value that applies, and where it came from. */
	effectiveLimits: Record<string, { value: number | null; source: "objective" | "config" | "none" }>;
	spendTodayUsd: number;
	spendTotalUsd: number;
	leadRunsToday: number;
	userMessagesToday: number;
	members: ObjectiveMemberView[];
	escalations: ObjectiveEscalationView[];
	report: ObjectiveReportView | null;
	artifacts: ObjectiveArtifactView[];
	meters: ObjectiveMeterView[];
	at: number;
}
export function objectiveView(objective: any): ObjectiveDetailView;
export interface MetricSeriesView {
	name: string;
	unit: string;
	direction: "up" | "down";
	target: number | null;
	targetDisplay: string | null;
	aggregation: "raw" | "mean";
	window: string | null;
	baseline: number | null;
	current: { value: number | null; at: number | null; stale: boolean; display: string | null };
	atTarget: boolean | null;
	frozen: boolean;
	check: { command: string; nextCheckAt: number | null; lastCheck: string | null } | null;
	points: Array<{ at: number; value: number; source: string }>;
}
export function metricSeries(metric: any): MetricSeriesView;
export interface MetricsView {
	objectiveId: string;
	url: string;
	phase: string;
	atTarget: { count: number; of: number };
	metrics: MetricSeriesView[];
}
export function metricsView(body: any): MetricsView;
export interface MetricChartView {
	empty: boolean;
	line: string;
	dots?: Array<{ x: number; y: number }>;
	target: { y: number; value: number } | null;
	min: number | null;
	max: number | null;
	first?: number | null;
	last?: number | null;
}
export function metricChart(series: MetricSeriesView | any, box?: { width?: number; height?: number; pad?: number }): MetricChartView;
export interface CharterSectionView {
	name: string;
	body: string;
	rev: number | null;
	author: string;
	at: number | null;
}
export interface CharterView {
	rev: number;
	sections: CharterSectionView[];
	revisions: Array<{ id: string; rev: number; section: string; body: string; author: string; at: number }>;
}
export function charterView(body: any): CharterView;
export function charterBody(section: string, body: string, baseRev?: number | null): { section: string; body: string; baseRev?: number };
export interface ObjectiveWakeView {
	sessionId: string;
	sessionUrl: string;
	id: string;
	url: string;
	subject: string;
	at: number;
	cron: string | null;
}
export function objectiveWakes(details: any[]): ObjectiveWakeView[];
