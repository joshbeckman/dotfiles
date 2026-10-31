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
// Fields owned by packages landing beside this one are rendered when their rows exist and marked
// where they do not: the daily cost ledger (`objective_costs`, obj/lead-limits), the metric
// aggregation (`metric_readings`' latest value is OBJ-32's "latest value"; OBJ-27's windowed
// aggregate is obj/metrics), and the report rows (obj/metrics). None of them is invented here.

import type { SqliteExecutor } from "@earendil-works/chord/sqlite";
import { localDay } from "../sessions/budget.ts";
import type { Runtime } from "../server/runtime.ts";
import { CHARTER_SECTIONS, type CharterSection, type ObjectiveMemberRow, type ObjectiveRow } from "./schema.ts";
import { objectiveMembers, objectiveState, objectiveUrl, sessionUrl } from "./state.ts";
import { charterSections, type CharterRevisionRow } from "./charter.ts";
import { escalationView, openEscalations, type EscalationView } from "./escalation.ts";

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

interface MemberSpend {
	leadRunsToday: number;
	leadRunsTotal: number;
	costTotal: number;
	costToday: number;
}

/**
 * Money and lead runs for the objective. Lifetime money is the sum of every session's cost
 * (`sessions.cost_usd`, which OBJ-15's rollup always includes the lead in). Today's money reads
 * `objective_costs`, the per-local-day ledger `obj/lead-limits` keeps (OBJ-20); until that package
 * writes it, today reads zero and the total is still right. Lead runs are the lead's deliveries
 * that a run carried, which is one run per delivery OBJ-18 does not coalesce; `obj/lead-limits`
 * owns the exact count OBJ-19 caps and should replace `leadRunCounts` when it lands.
 */
async function spendOf(db: SqliteExecutor, runtime: Runtime, row: ObjectiveRow): Promise<MemberSpend> {
	const total = await db.get<{ total: number }>("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM sessions WHERE objective_id = ?", row.id);
	const todayRow = await db.get<{ total: number }>("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM objective_costs WHERE objective_id = ? AND day = ?", row.id, localDay(runtime.clock.now(), runtime.config.timezone));
	return { costTotal: total?.total ?? 0, costToday: todayRow?.total ?? 0, ...(await leadRunCounts(db, runtime, row)) };
}

async function leadRunCounts(db: SqliteExecutor, runtime: Runtime, row: ObjectiveRow): Promise<{ leadRunsToday: number; leadRunsTotal: number }> {
	if (row.lead_id === null) return { leadRunsToday: 0, leadRunsTotal: 0 };
	const start = localDayStart(runtime);
	const total = await db.get<{ n: number }>("SELECT count(*) AS n FROM deliveries WHERE recipient_id = ? AND wake_submission_id IS NOT NULL", row.lead_id);
	const today = await db.get<{ n: number }>(
		"SELECT count(*) AS n FROM deliveries WHERE recipient_id = ? AND wake_submission_id IS NOT NULL AND created_at >= ?",
		row.lead_id,
		start,
	);
	return { leadRunsTotal: total?.n ?? 0, leadRunsToday: today?.n ?? 0 };
}

/** The first millisecond of the local day, by search, the way the budget day is found (LIM-03). */
function localDayStart(runtime: Runtime): number {
	const now = runtime.clock.now();
	const day = localDay(now, runtime.config.timezone);
	let lo = now - 26 * 3_600_000;
	let hi = now;
	while (hi - lo > 1000) {
		const mid = Math.floor((lo + hi) / 2);
		if (localDay(mid, runtime.config.timezone) === day) hi = mid;
		else lo = mid;
	}
	return hi;
}

interface MetricBrief {
	name: string;
	unit: string;
	direction: "up" | "down";
	target: number | null;
	latest: { value: number; at: number; source: string } | null;
}

async function metricsOf(db: SqliteExecutor, objectiveId: string): Promise<MetricBrief[]> {
	const metrics = await db.all<{ name: string; unit: string; direction: "up" | "down"; target: number | null }>(
		"SELECT name, unit, direction, target FROM objective_metrics WHERE objective_id = ? ORDER BY name",
		objectiveId,
	);
	const out: MetricBrief[] = [];
	for (const metric of metrics) {
		const latest = await db.get<{ value: number; at: number; source: string }>(
			"SELECT value, at, source FROM metric_readings WHERE objective_id = ? AND name = ? ORDER BY at DESC, id DESC LIMIT 1",
			objectiveId,
			metric.name,
		);
		out.push({ ...metric, latest: latest ?? null });
	}
	return out;
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

async function heldDeliveries(db: SqliteExecutor, members: readonly ObjectiveMemberRow[]): Promise<number> {
	if (members.length === 0) return 0;
	const ids = members.map((member) => member.id);
	const row = await db.get<{ n: number }>(
		`SELECT count(*) AS n FROM deliveries
		  WHERE recipient_id IN (${ids.map(() => "?").join(",")})
		    AND read_at IS NULL AND wake_submission_id IS NULL`,
		...ids,
	);
	return row?.n ?? 0;
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
	const spend = await spendOf(db, runtime, row);
	const metrics = await metricsOf(db, row.id);
	const wakes = await pendingWakes(db, members);
	const escalations = (await openEscalations(db, runtime, row.id)).map((open) => escalationView(runtime, open));
	const reports = await lastReports(db, row.id);
	const held = await heldDeliveries(db, members);
	const lead = members.find((member) => member.lead);

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
	if (lead?.hold_until !== null && lead?.hold_until !== undefined && lead.hold_until > runtime.clock.now()) {
		holding.push(`Your next run is held until ${iso(lead.hold_until)} (OBJ-18's quiet interval).`);
	}
	if (held > 0) holding.push(`${held} ${held === 1 ? "delivery is" : "deliveries are"} held, waiting for a run that may carry them.`);
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
	const limits = row;
	lines.push(`- ${limitLine("Money today", spend.costToday, limits.max_daily_usd, money)}`);
	lines.push(`- ${limitLine("Money in total", spend.costTotal, limits.max_total_usd, money)}`);
	lines.push(`- ${limitLine("Lead runs today", spend.leadRunsToday, limits.max_daily_lead_turns, String)}`);
	lines.push(`- Lead runs in total: ${spend.leadRunsTotal}`);
	// OBJ-24's message count is obj/lead-limits' ledger; this build has no row to read, so it says so
	// rather than claiming zero.
	lines.push(
		`- Messages to the user today: not counted by this build (limit ${limits.max_daily_user_messages ?? runtime.config.objectives.maxDailyUserMessages})`,
	);
	lines.push(
		`- Members active: ${members.filter((member) => member.state !== "stopped" && member.state !== "archived").length}${limits.max_active_members === null ? " (no limit)" : ` of ${limits.max_active_members}`}`,
	);
	lines.push(`- Quiet interval between your runs: ${limits.wake_min_minutes ?? runtime.config.objectives.wakeMinMinutes} minutes`);
	lines.push(`- Held deliveries: ${held}`);

	lines.push("", "## Metrics", "");
	if (metrics.length === 0) lines.push("No metrics declared.");
	for (const metric of metrics) {
		const target = metric.target === null ? "no target (the infinite case)" : `target ${metric.target} ${metric.unit}`;
		const latest = metric.latest === null ? "no readings yet" : `latest ${metric.latest.value} ${metric.unit} at ${iso(metric.latest.at)} (${metric.latest.source})`;
		lines.push(`- ${metric.name} (${metric.direction} is progress): ${latest}; ${target}`);
	}

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
