// The lead's briefing (OBJ-32) and the one charter renderer (OBJ-11, OBJ-12, OBJ-37).
//
// `leadBriefing` is the input every lead run starts with, and the whole of a new lead's handoff.
// It renders only what the database holds, in a fixed order, so rendering twice for the same rows
// gives identical text (the PRM-04 pattern). Nothing here reads the clock for relative wording:
// times are absolute, so a re-render of the same state does not drift.
//
// OBJ-12: `Scope` is guidance, and the briefing says so. What a member may touch in the world is
// its profile, its working directory, and the credentials its `bash` carries (ISO-03), so the
// member roster names each member's profile. No code path reads `Scope` as a permission check.
//
// Money, lead runs, user messages, and the hold are `limits.ts`' answers, and each metric's value is
// `metrics.ts`' aggregation: this file renders them and never counts or averages on its own, so the
// briefing cannot disagree with the gate that stopped a run or the chart a reader sees. The report
// rows are the one field still owned by a package landing later (obj/metrics' report writes).

import type { SqliteExecutor } from "@earendil-works/chord/sqlite";
import { nextDayStart } from "../sessions/budget.ts";
import type { Runtime } from "../server/runtime.ts";
import { heldDeliveries } from "./hold.ts";
import { objectiveConditions, type ObjectiveConditions } from "./limits.ts";
import { listMetrics, type MetricView } from "./metrics.ts";
import { behindPaces, metricPaces, paceLine } from "./pace.ts";
import { CHARTER_SECTIONS, type CharterSection, type ObjectiveMemberRow, type ObjectiveRow } from "./schema.ts";
import { objectiveMembers, objectiveState, objectiveUrl, sessionUrl } from "./state.ts";
import { charterSections, type CharterRevisionRow } from "./charter.ts";
import { escalationView, openEscalations } from "./escalation.ts";

/** The first line of every briefing. A handoff message is recognised by it, so a lead's own
 * briefing is not prepended a second time to the run that carries it (see `leadRunInput`). */
export const BRIEF_TITLE = "# Objective briefing";

export interface BriefingOptions {
	/** True for the launch input, before any run has happened. */
	firstRun?: boolean;
	/** A regenerate hands a new lead the briefing: who it replaces, and why. */
	handoff?: { previousLead: string; reason: string };
}

export interface CharterRenderOptions {
	/** `lead` renders all six sections; `member` renders Scope and Guidance (OBJ-11). */
	audience: "lead" | "member";
}

const EMPTY_SECTION = "_Empty: an empty section grants nothing. Escalate to the user rather than assuming permission._";

/** OBJ-11: what an empty section means to the run reading it. */
function emptySection(section: CharterSection): string {
	if (section === "Cancel") return "_Empty: nothing is cancelled, and an empty section grants nothing. Escalate to the user rather than assuming permission._";
	if (section === "Escalation") return "_Empty: no timeout. An escalation waits until the user answers._";
	return EMPTY_SECTION;
}

/** OBJ-11: `Scope` and `Guidance` are what a member starts with. */
export const MEMBER_SECTIONS: readonly CharterSection[] = ["Scope", "Guidance"];

function sectionText(sections: Record<CharterSection, CharterRevisionRow | undefined>, section: CharterSection): string[] {
	const revision = sections[section];
	const body = revision?.body.trim();
	const lines = [`### ${section}`, body === undefined || body.length === 0 ? emptySection(section) : body];
	if (revision !== undefined) lines.push("", `_Last written ${iso(revision.created_at)} by ${revision.created_by} (revision ${revision.rev})._`);
	return lines;
}

/**
 * OBJ-11: one renderer, two audiences. Deterministic: the sections come in canonical order and
 * nothing is read from the clock.
 */
export function renderCharter(sections: Record<CharterSection, CharterRevisionRow | undefined>, options: CharterRenderOptions): string {
	const wanted = options.audience === "member" ? MEMBER_SECTIONS : CHARTER_SECTIONS;
	const blocks: string[] = [];
	for (const section of wanted) blocks.push(sectionText(sections, section).join("\n"));
	return blocks.join("\n\n");
}

/** The ISO-03 paragraph both audiences get: what a charter can and cannot do. */
const SCOPE_IS_GUIDANCE = [
	"`Scope` is guidance, not a sandbox. What a member may touch in the world is its profile, its",
	"working directory, and the credentials its `bash` carries (ISO-03) — nothing here reads `Scope`",
	"as a permission check. When an objective's work reaches beyond its repository, give its members",
	"a profile that holds only the intended tools and credentials.",
].join("\n");

function iso(at: number): string {
	return new Date(at).toISOString();
}

function money(value: number): string {
	return `$${value.toFixed(2)}`;
}

/**
 * OBJ-20..OBJ-24: money today and in total, lead runs today, and messages to the user today, all
 * from `limits.ts` — the same reads the admission gate and the objective view use. `held` counts the
 * deliveries `hold.ts` would release: unread, with no run carrying them.
 */
async function conditionsOf(
	db: SqliteExecutor,
	runtime: Runtime,
	row: ObjectiveRow,
	members: readonly ObjectiveMemberRow[],
): Promise<ObjectiveConditions & { held: number; leadRunsTotal: number }> {
	const conditions = await objectiveConditions(db, runtime, row);
	let held = 0;
	for (const member of members) held += (await heldDeliveries(db, member.id)).length;
	// OBJ-19's limit is per day; the lifetime count is history, not a limit, and comes from the
	// same `run.started` events the daily count uses rather than a second definition of a run.
	const total = await db.get<{ n: number }>(
		"SELECT COUNT(*) AS n FROM objective_events WHERE objective_id = ? AND kind = 'run.started' AND json_extract(detail, '$.lead') = 1",
		row.id,
	);
	return { ...conditions, held, leadRunsTotal: total?.n ?? 0 };
}

/** OBJ-25..OBJ-28: every metric as `metrics.ts` derives it, current value and target included. */
async function metricsOf(runtime: Runtime, row: ObjectiveRow): Promise<{ metrics: MetricView[]; atTarget: { count: number; of: number } }> {
	const listed = await listMetrics(runtime, row.id);
	return { metrics: listed.metrics, atTarget: listed.atTarget };
}

interface WakeBrief {
	session: string;
	nextAt: number;
}

async function pendingWakes(db: SqliteExecutor, members: readonly ObjectiveMemberRow[]): Promise<WakeBrief[]> {
	if (members.length === 0) return [];
	const ids = members.map((member) => member.id);
	const rows = await db.all<{ session: string; next_at: number }>(
		`SELECT json_extract(payload, '$.session') AS session, next_at
		   FROM schedules
		  WHERE kind = 'wake' AND state = 'active' AND next_at IS NOT NULL
		    AND json_extract(payload, '$.session') IN (${ids.map(() => "?").join(",")})
		  ORDER BY next_at, id`,
		...ids,
	);
	return rows.map((row) => ({ session: row.session, nextAt: row.next_at }));
}

interface ReportBrief {
	id: string;
	at: number;
	body: string | null;
	redacted: boolean;
}

async function lastReports(db: SqliteExecutor, objectiveId: string): Promise<ReportBrief[]> {
	const rows = await db.all<{ id: string; created_at: number; body: string; redacted: number }>(
		`SELECT m.id AS id, r.created_at AS created_at, m.body AS body,
		        EXISTS (SELECT 1 FROM message_events e WHERE e.message_id = m.id AND e.kind = 'message.redacted') AS redacted
		   FROM objective_reports r JOIN messages m ON m.id = r.message_id
		  WHERE r.objective_id = ?
		  ORDER BY r.created_at DESC, m.id DESC LIMIT 5`,
		objectiveId,
	);
	return rows.map((row) => ({ id: row.id, at: row.created_at, body: row.body, redacted: row.redacted === 1 }));
}

function limitLine(label: string, spent: number, limit: number | null, unit: (value: number) => string): string {
	return limit === null ? `${label}: ${unit(spent)} (no limit)` : `${label}: ${unit(spent)} of ${unit(limit)}`;
}

/**
 * OBJ-32: render the input a lead run starts with. Deterministic for a given database state.
 */
export async function leadBriefing(runtime: Runtime, row: ObjectiveRow, options: BriefingOptions = {}): Promise<string> {
	const db = runtime.db;
	const url = objectiveUrl(runtime, row.id);
	const members = (await objectiveMembers(db, row.id)).map((member) => ({ ...member, lead: member.id === row.lead_id }));
	const sections = await charterSections(db, row.id);
	const conditions = await conditionsOf(db, runtime, row, members);
	const metrics = await metricsOf(runtime, row);
	// OBJ-08: pace against `dueAt` is `pace.ts`' arithmetic, computed once for the notice and here.
	const paces = await metricPaces(db, row, runtime.clock.now());
	const behind = new Set(behindPaces(paces).map((pace) => pace.name));
	const wakes = await pendingWakes(db, members);
	const escalations = (await openEscalations(db, runtime, row.id)).map((open) => escalationView(runtime, open));
	const reports = await lastReports(db, row.id);

	const lines: string[] = [BRIEF_TITLE, ""];
	const state = await objectiveState(db, runtime, row);
	lines.push(`Objective: ${row.goal}`, `Objective URL: ${url}`, `Phase: ${row.phase}${state === null ? "" : ` (reads ${state})`}`);
	lines.push(`Charter revision: ${row.charter_rev}`);
	lines.push(`Due: ${row.due_at === null ? "none" : iso(row.due_at)}`);
	if (options.firstRun === true) lines.push("", "This is your first run as the lead of this objective.");
	if (options.handoff !== undefined) {
		lines.push(
			"",
			`You are the new lead of this objective. You replace ${options.handoff.previousLead}, which the user retired for this reason:`,
			options.handoff.reason,
			`The previous lead's session is stopped and archived; its transcript stays readable at ${sessionUrl(runtime, options.handoff.previousLead)}.`,
		);
	}

	// OBJ-37: what a lead is for. The same words every run, so the instruction cannot be lost.
	lines.push(
		"",
		"## How you work",
		"",
		`- You coordinate; you hold no durable output of your own. You own no worktree or branch: create members for the work that produces or changes something.`,
		`- Keep objective state in the charter's \`Notes\` (write it with \`pana objective charter set --section Notes\`); you may write no other section.`,
		"- Keep durable understanding in memory, as any session does.",
		"- Answer with `pana_reply`. When you cannot decide without the user, escalate with `pana objective escalate`; an empty charter section grants nothing.",
		`- This objective: ${url}.`,
	);

	lines.push("", "## Holding conditions", "");
	const holding: string[] = [];
	if (row.phase !== "active") holding.push(`The objective is ${row.phase}: no run starts until the user changes that.`);
	for (const escalation of escalations) {
		const scope = escalation.scope === "objective" ? "Objective-wide" : `For member ${escalation.member?.url ?? ""}`;
		holding.push(
			`${scope} escalation waits on the user at ${escalation.url} in ${escalation.thread.url} (raised ${iso(escalation.createdAt)}${escalation.timeoutAt === null ? ", no timeout" : `, times out ${iso(escalation.timeoutAt)}`}).`,
		);
	}
	if (conditions.paused !== null) {
		const resumes = conditions.paused === "budget_total" ? "until the user raises the budget or resumes it" : `until ${iso(nextDayStart(runtime.clock.now(), runtime.config.timezone))}`;
		holding.push(`The objective is paused (${conditions.paused}): no run starts ${resumes}.`);
	}
	if (conditions.holdUntil !== null && conditions.holdUntil > runtime.clock.now()) {
		holding.push(`Your next run is held until ${iso(conditions.holdUntil)} (OBJ-18's quiet interval or a cap).`);
	}
	if (conditions.held > 0) {
		holding.push(`${conditions.held} ${conditions.held === 1 ? "delivery is" : "deliveries are"} held, waiting for a run that may carry them.`);
	}
	lines.push(...(holding.length === 0 ? ["No holding condition."] : holding.map((line) => `- ${line}`)));

	lines.push("", "## Charter", "");
	lines.push(renderCharter(sections, { audience: "lead" }));
	lines.push("", SCOPE_IS_GUIDANCE);

	lines.push("", "## Members", "");
	if (members.length === 0) lines.push("No members yet. You are the only session on this objective.");
	for (const member of members) {
		const parts = [`${member.lead ? "lead" : "member"} ${member.url}: ${member.state}`];
		parts.push(`profile ${member.profile ?? "default"}`);
		if (member.stopped_by === "user") parts.push("stopped by the user — inert to the objective; do not revive it");
		if (member.stopped_by === "objective") parts.push("stopped by the objective — you may resume it");
		lines.push(`- ${parts.join("; ")}.`);
	}

	lines.push("", "## Limits and spend", "");
	lines.push(`- ${limitLine("Money today", conditions.spendTodayUsd, conditions.maxDailyUsd, money)}`);
	lines.push(`- ${limitLine("Money in total", conditions.spendTotalUsd, conditions.maxTotalUsd, money)}`);
	lines.push(`- ${limitLine("Lead runs today", conditions.leadRunsToday, conditions.maxDailyLeadTurns, String)} (your runs that started today)`);
	lines.push(`- Lead runs in total: ${conditions.leadRunsTotal}`);
	lines.push(
		`- ${limitLine("Messages to the user today", conditions.userMessagesToday, conditions.maxDailyUserMessages, String)} (sent by this objective's sessions)`,
	);
	lines.push(
		`- Members active: ${members.filter((member) => member.state !== "stopped" && member.state !== "archived").length}${row.max_active_members === null ? " (no limit)" : ` of ${row.max_active_members}`}`,
	);
	lines.push(`- Quiet interval between your runs: ${row.wake_min_minutes ?? runtime.config.objectives.wakeMinMinutes} minutes`);
	lines.push(`- Held deliveries: ${conditions.held}`);

	lines.push("", "## Metrics", "");
	if (metrics.metrics.length === 0) lines.push("No metrics declared.");
	else lines.push(`At target: ${metrics.atTarget.count} of ${metrics.atTarget.of}.`);
	for (const metric of metrics.metrics) {
		const target = metric.targetDisplay === null ? "no target (the infinite case)" : `target ${metric.targetDisplay}`;
		const current = metric.current.value === null ? "no readings in its window (stale)" : `${metric.current.display} as of ${iso(metric.current.at ?? runtime.clock.now())}`;
		const at = metric.atTarget === null ? "" : metric.atTarget ? "; at target" : "; short of target";
		lines.push(`- ${metric.name} (${metric.direction} is progress, ${metric.aggregation}${metric.window === null ? "" : ` over ${metric.window}`}): ${current}; ${target}${at}`);
	}

	lines.push("", "## Pace", "");
	if (row.due_at === null) lines.push("No deadline: this objective has no `dueAt`.");
	else if (paces.length === 0) lines.push("No targeted metric has a pace yet (no deadline-relative reading).");
	for (const pace of paces) lines.push(`- ${paceLine(pace)}${behind.has(pace.name) ? " — behind" : ""}`);

	lines.push("", "## Pending wakes", "");
	if (wakes.length === 0) lines.push("None.");
	for (const wake of wakes) lines.push(`- ${sessionUrl(runtime, wake.session)} at ${iso(wake.nextAt)}`);

	lines.push("", "## Awaiting the user", "");
	if (escalations.length === 0) lines.push("Nothing: no escalation is open.");
	for (const escalation of escalations) {
		lines.push(`- ${escalation.scope === "objective" ? "Objective-wide" : `Member ${escalation.member?.url ?? ""}`}: ${escalation.url} (thread ${escalation.thread.url}).`);
	}

	lines.push("", "## Last reports", "");
	if (reports.length === 0) lines.push("No reports yet.");
	for (const report of reports) {
		const excerpt = report.redacted || report.body === null ? "[redacted]" : firstLine(report.body);
		const link = row.thread_id === null ? report.id : runtime.url({ kind: "message", id: report.id, thread: row.thread_id });
		lines.push(`- ${iso(report.at)} ${link}: ${excerpt}`);
	}

	lines.push(
		"",
		"---",
		"Nothing you write at the end of a run is posted unless it answers a message: use `pana_reply`.",
	);
	return `${lines.join("\n")}\n`;
}

function firstLine(text: string): string {
	const line = text.replace(/\s+/g, " ").trim();
	const cut = line.indexOf(". ");
	return cut === -1 ? line.slice(0, 160) : line.slice(0, cut + 1);
}

/**
 * OBJ-11: a new member's first input carries `Scope` and `Guidance`. `createSession` appends this
 * to the prompt the lead wrote, so the member starts with the charter it works under.
 */
export async function memberBriefing(runtime: Runtime, objectiveId: string): Promise<string> {
	const row = await runtime.db.get<ObjectiveRow>("SELECT * FROM objectives WHERE id = ?", objectiveId);
	if (!row) return "";
	const sections = await charterSections(runtime.db, objectiveId);
	return [
		`# Objective charter (${objectiveUrl(runtime, row.id)})`,
		"",
		`Objective: ${row.goal}`,
		"",
		renderCharter(sections, { audience: "member" }),
		"",
		SCOPE_IS_GUIDANCE,
	].join("\n");
}

/**
 * OBJ-32: the briefing is the lead's input on *every* run, not only the first. A wake that carries
 * a message or a note starts with the briefing unless what arrived is itself a briefing (launch's
 * first message, or a regenerate's handoff), which is recognised by its title.
 */
export async function leadRunInput(runtime: Runtime, sessionId: string, arrival: string, messageId?: string): Promise<string> {
	const session = await runtime.db.get<{ objective_id: string | null }>("SELECT objective_id FROM sessions WHERE id = ?", sessionId);
	if (session?.objective_id === null || session?.objective_id === undefined) return arrival;
	const row = await runtime.db.get<ObjectiveRow>("SELECT * FROM objectives WHERE id = ?", session.objective_id);
	if (!row || row.lead_id !== sessionId) return arrival;
	if (messageId !== undefined) {
		const message = await runtime.db.get<{ body: string }>("SELECT body FROM messages WHERE id = ?", messageId);
		if (message?.body.trimStart().startsWith(BRIEF_TITLE)) return arrival;
	}
	if (arrival.trimStart().startsWith(BRIEF_TITLE)) return arrival;
	return `${await leadBriefing(runtime, row)}\n\n---\n\n${arrival}`;
}
