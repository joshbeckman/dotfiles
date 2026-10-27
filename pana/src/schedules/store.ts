// The schedule table (WP6, SCH-01..08).
//
// A schedule stores everything it needs at creation time: the cron expression or one-off
// instant, the timezone it was created in, and the payload (the prompt, or the thread body and
// recipients). Firing never re-reads a file or asks the caller anything, which is what makes
// SCH-04 hold: the body is fixed when the schedule is made, not when it runs.
//
// `next_at` is the only timing state. An active row with `next_at` in the past is due. Moving
// it forward is the claim that stops a second fire, so the scheduler reads and writes it inside
// one `db.write`.

import type { SqliteExecutor } from "@earendil-works/chord/sqlite";
import { Cron } from "croner";
import { ApiError } from "../api/errors.ts";
import { isUlid, parseRef } from "../ids/index.ts";
import { decodeCursor, pageOf, type Page } from "../api/pagination.ts";
import type { Caller } from "../api/types.ts";
import type { PersonView } from "../threads/store.ts";
import { addressList, messageBody } from "../threads/store.ts";
import type { Runtime } from "../server/runtime.ts";
import { notifySchedulesChanged } from "./registry.ts";

export type ScheduleKind = "session" | "thread" | "wake";
export type ScheduleState = "active" | "done" | "missed" | "deleted";

export interface ScheduleRow {
	id: string;
	kind: ScheduleKind;
	state: ScheduleState;
	cron: string | null;
	at: number | null;
	timezone: string | null;
	creator_id: string;
	payload: string;
	next_at: number | null;
	created_at: number;
	updated_at: number;
}

interface ScheduleJoinRow extends ScheduleRow {
	creator_url: string | null;
	creator_kind: string | null;
}

export interface ScheduleView {
	id: string;
	url: string;
	kind: ScheduleKind;
	state: ScheduleState;
	cron: string | null;
	at: number | null;
	timezone: string;
	creator: PersonView;
	/** The stored session or thread request, exactly as given when the schedule was made. */
	payload: Record<string, unknown>;
	nextAt: number | null;
	createdAt: number;
	updatedAt: number;
}

export interface ScheduleInput {
	kind?: unknown;
	cron?: unknown;
	at?: unknown;
	/** WAK-01: a delay such as `90s`, `5m`, `2h`, or `1d`, instead of `at`. */
	in?: unknown;
	timezone?: unknown;
	payload?: unknown;
	/** The CLI/PWA may also send prompt, body, to, subject at the top level. */
	prompt?: unknown;
	body?: unknown;
	to?: unknown;
	subject?: unknown;
	model?: unknown;
	thinking?: unknown;
	cwd?: unknown;
	profile?: unknown;
	/** WAK-01: the session a wake schedule wakes, and the note it hands that session. */
	session?: unknown;
	note?: unknown;
}

const KINDS: readonly ScheduleKind[] = ["session", "thread", "wake"];

// --- Input parsing -------------------------------------------------------------

function inputObject(value: unknown): ScheduleInput {
	if (value === undefined || value === null) return {};
	if (typeof value !== "object" || Array.isArray(value)) {
		throw ApiError.badRequest("invalid_body", "a schedule body must be a JSON object");
	}
	return value as ScheduleInput;
}

function scheduleKind(value: unknown): ScheduleKind {
	if (value === undefined || value === null || value === "") return "session";
	if (typeof value === "string" && (KINDS as readonly string[]).includes(value)) return value as ScheduleKind;
	throw ApiError.badRequest("invalid_kind", `schedule kind must be session, thread, or wake, got ${String(value)}`);
}

const DURATION_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** `--in 90s`, `5m`, `2h`, or `1d`, as milliseconds. */
export function parseDuration(value: unknown): number {
	const match = typeof value === "string" ? /^\s*(\d+(?:\.\d+)?)\s*([smhd])\s*$/.exec(value) : null;
	const ms = match ? Number(match[1]) * DURATION_MS[match[2] as keyof typeof DURATION_MS] : Number.NaN;
	if (!Number.isFinite(ms) || ms <= 0) {
		throw ApiError.badRequest("invalid_in", `--in must be a duration such as 90s, 5m, 2h, or 1d, got ${String(value)}`);
	}
	return ms;
}

function timezoneFor(value: unknown, fallback: string): string {
	const timezone = typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: timezone });
	} catch {
		throw ApiError.badRequest("invalid_timezone", `${timezone} is not a known timezone`);
	}
	return timezone;
}

function parseAt(value: unknown): number {
	const at = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Number.NaN;
	if (!Number.isFinite(at)) {
		throw ApiError.badRequest("invalid_at", `--at must be an ISO timestamp or epoch milliseconds, got ${String(value)}`);
	}
	return at;
}

function hasValue(value: unknown): boolean {
	return value !== undefined && value !== null && value !== "";
}

/** The next cron instant strictly after `from`, or null when the expression never runs again. */
export function nextCronAt(cron: string, timezone: string, from: number): number | null {
	let job: Cron;
	try {
		// `paused` keeps croner from arming its own timer: pana arms timers on `runtime.clock`.
		job = new Cron(cron, { timezone, paused: true });
	} catch (error) {
		throw ApiError.badRequest("invalid_cron", `bad cron expression: ${(error as Error).message}`);
	}
	const next = job.nextRun(new Date(from));
	return next ? next.getTime() : null;
}

interface Timing {
	cron: string | null;
	at: number | null;
	timezone: string;
	nextAt: number;
}

/** SCH-03: exactly one of cron or at, a future at, and a cron that has a next run. */
function scheduleTiming(input: ScheduleInput, fallbackTimezone: string, now: number): Timing {
	const cron = typeof input.cron === "string" && input.cron.trim().length > 0 ? input.cron.trim() : null;
	const hasAt = hasValue(input.at);
	if (cron && hasAt) {
		throw ApiError.badRequest("both_times", "a schedule takes --cron or --at, not both");
	}
	if (!cron && !hasAt) {
		throw ApiError.badRequest("missing_time", "a schedule needs --cron or --at");
	}
	const timezone = timezoneFor(input.timezone, fallbackTimezone);
	if (cron) {
		const nextAt = nextCronAt(cron, timezone, now);
		if (nextAt === null) {
			throw ApiError.badRequest("invalid_cron", `${cron} has no future run`);
		}
		return { cron, at: null, timezone, nextAt };
	}
	const at = parseAt(input.at);
	if (at <= now) {
		throw ApiError.badRequest("past_at", `--at ${new Date(at).toISOString()} is in the past`);
	}
	return { cron: null, at, timezone, nextAt: at };
}

/** The payload fields the CLI may send at the top level instead of under `payload`. */
const TOP_LEVEL_FIELDS = ["prompt", "body", "to", "subject", "model", "thinking", "cwd", "profile", "session", "note"] as const;

/**
 * The stored request. The PWA sends `payload: {prompt}`; the CLI may send the same fields at the
 * top level. Either way the object is stored whole, so `sessions.create` later receives exactly
 * what was scheduled.
 */
function schedulePayload(input: ScheduleInput, kind: ScheduleKind): Record<string, unknown> {
	const raw = input.payload !== undefined ? input.payload : pickPayloadFields(input);
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw ApiError.badRequest("invalid_payload", "a schedule payload must be a JSON object");
	}
	const payload = { ...(raw as Record<string, unknown>) };
	if (kind === "session") {
		if (typeof payload.prompt !== "string" || payload.prompt.trim().length === 0) {
			throw ApiError.badRequest("invalid_payload", "a session schedule needs a prompt");
		}
	} else if (kind === "wake") {
		if (typeof payload.note !== "string" || payload.note.trim().length === 0) {
			throw ApiError.badRequest("invalid_payload", "a wake needs a note: what to check, and where to reply");
		}
	} else {
		messageBody(payload.body);
		const to = addressList(payload.to, "to");
		if (to.length === 0) {
			throw ApiError.badRequest("invalid_payload", "a thread schedule needs at least one recipient in to");
		}
		payload.to = to;
	}
	return payload;
}

function pickPayloadFields(input: ScheduleInput): Record<string, unknown> {
	const payload: Record<string, unknown> = {};
	for (const field of TOP_LEVEL_FIELDS) {
		if (input[field] !== undefined) payload[field] = input[field];
	}
	return payload;
}

/** WAK-01: `in` becomes `at`, measured from now. */
function withDelay(input: ScheduleInput, now: number): ScheduleInput {
	if (!hasValue(input.in)) return input;
	if (hasValue(input.at) || hasValue(input.cron)) throw ApiError.badRequest("both_times", "give one of --in, --at, or --cron");
	return { ...input, at: now + parseDuration(input.in) };
}

/**
 * WAK-01: a session wakes only itself; the user may wake any session. The target must exist and
 * must not be archived, since an archived session never runs again.
 */
async function wakeTarget(runtime: Runtime, caller: Caller, value: unknown): Promise<string> {
	const named = typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
	let id: string;
	if (named === undefined) {
		if (caller.kind !== "session") throw ApiError.badRequest("missing_session", "name the session to wake with --session");
		id = caller.id;
	} else {
		const ref = isUlid(named) ? { kind: "session", id: named } : parseRef(named, runtime.config.domain);
		if (ref.kind !== "session") throw ApiError.badRequest("invalid_session", `${named} is not a session`);
		id = ref.id;
	}
	if (caller.kind === "session" && id !== caller.id) throw ApiError.forbidden("a session may schedule wakes only for itself");
	const row = await runtime.db.get<{ state: string }>("SELECT state FROM sessions WHERE id = ?", id);
	if (!row) throw ApiError.notFound(`session ${id}`);
	if (row.state === "archived") throw ApiError.stale(`session ${id} is archived`, { session: id });
	return id;
}

// --- Reads ---------------------------------------------------------------------

function scheduleView(row: ScheduleJoinRow, runtime: Runtime): ScheduleView {
	let payload: Record<string, unknown> = {};
	try {
		const parsed = JSON.parse(row.payload);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
	} catch {
		// A corrupt payload stays opaque rather than failing the whole list.
	}
	const creatorKind = row.creator_kind === "session" ? "session" : "user";
	return {
		id: row.id,
		url: runtime.url({ kind: "schedule", id: row.id }),
		kind: row.kind,
		state: row.state,
		cron: row.cron,
		at: row.at,
		timezone: row.timezone ?? runtime.config.timezone,
		creator: {
			id: row.creator_id,
			kind: creatorKind,
			url: row.creator_url ?? runtime.url({ kind: creatorKind, id: row.creator_id }),
		},
		payload,
		nextAt: row.next_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

const SELECT_SCHEDULE = `SELECT s.*, p.url AS creator_url, p.kind AS creator_kind
	FROM schedules s LEFT JOIN participants p ON p.id = s.creator_id`;

async function scheduleRow(tx: SqliteExecutor, id: string): Promise<ScheduleJoinRow> {
	const row = await tx.get<ScheduleJoinRow>(`${SELECT_SCHEDULE} WHERE s.id = ?`, id);
	if (!row || row.state === "deleted") throw ApiError.notFound(`schedule ${id}`);
	return row;
}

function kindFilter(value: string | null | undefined): ScheduleKind | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if ((KINDS as readonly string[]).includes(value)) return value as ScheduleKind;
	throw ApiError.badRequest("invalid_kind", `schedule kind must be session, thread, or wake, got ${value}`);
}

export async function showSchedule(runtime: Runtime, id: string): Promise<ScheduleView> {
	const row = await runtime.db.get<ScheduleJoinRow>(`${SELECT_SCHEDULE} WHERE s.id = ?`, id);
	if (!row || row.state === "deleted") throw ApiError.notFound(`schedule ${id}`);
	return scheduleView(row, runtime);
}

export const SCHEDULE_LIMIT = 100;

/** The list order, as a row value, so a cursor can resume strictly after one row (SCALE-03). */
const SCHEDULE_ORDER = "CASE s.state WHEN 'active' THEN 0 ELSE 1 END, s.next_at IS NULL, COALESCE(s.next_at, 0), s.created_at, s.id";

/** SCH-07: active first, then the next time they run, one page at a time. Deleted rows are gone. */
export async function listSchedules(
	runtime: Runtime,
	kind?: string | null,
	page: { limit?: number; cursor?: string | null } = {},
): Promise<Page<ScheduleView>> {
	const filter = kindFilter(kind);
	const limit = page.limit ?? SCHEDULE_LIMIT;
	const after = decodeCursor(page.cursor, ["number", "number", "number", "number", "string"]);
	const rows = await runtime.db.all<ScheduleJoinRow>(
		`${SELECT_SCHEDULE}
		  WHERE s.state <> 'deleted' ${filter ? "AND s.kind = ?" : ""} ${after ? `AND (${SCHEDULE_ORDER}) > (?, ?, ?, ?, ?)` : ""}
		  ORDER BY ${SCHEDULE_ORDER}
		  LIMIT ?`,
		...(filter ? [filter] : []),
		...(after ?? []),
		limit + 1,
	);
	const result = pageOf(rows, limit, (row) => [row.state === "active" ? 0 : 1, row.next_at === null ? 1 : 0, row.next_at ?? 0, row.created_at, row.id]);
	return { items: result.items.map((row) => scheduleView(row, runtime)), nextCursor: result.nextCursor };
}

// --- Writes --------------------------------------------------------------------

async function ensureParticipant(tx: SqliteExecutor, runtime: Runtime, now: number, caller: Caller): Promise<void> {
	const url = caller.url || runtime.url({ kind: caller.kind, id: caller.id });
	await tx.run(
		"INSERT OR IGNORE INTO participants (id, kind, url, created_at) VALUES (?, ?, ?, ?)",
		caller.id,
		caller.kind,
		url,
		now,
	);
}

export async function createSchedule(runtime: Runtime, caller: Caller, value: unknown): Promise<ScheduleView> {
	const input = withDelay(inputObject(value), runtime.clock.now());
	const now = runtime.clock.now();
	const kind = scheduleKind(input.kind);
	if (kind === "wake" && hasValue(input.cron)) {
		// A recurring self-wake would run, and spend, forever with nobody asking.
		throw ApiError.badRequest("invalid_cron", "a wake takes --in or --at, not --cron");
	}
	const timing = scheduleTiming(input, runtime.config.timezone, now);
	const payload = schedulePayload(input, kind);
	if (kind === "wake") payload.session = await wakeTarget(runtime, caller, payload.session);
	const id = runtime.newId();
	const view = await runtime.db.write(async (tx) => {
		await ensureParticipant(tx, runtime, now, caller);
		await tx.run(
			`INSERT INTO schedules (id, kind, state, cron, at, timezone, creator_id, payload, next_at, created_at, updated_at)
			 VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`,
			id,
			kind,
			timing.cron,
			timing.at,
			timing.timezone,
			caller.id,
			JSON.stringify(payload),
			timing.nextAt,
			now,
			now,
		);
		return scheduleView(await scheduleRow(tx, id), runtime);
	});
	notifySchedulesChanged(runtime);
	return view;
}

/**
 * Replace a schedule's timing and (when given) its payload, keeping the creator and ID. A
 * missing `payload` keeps the stored one, a missing `kind` keeps the stored kind, and an update
 * with neither `cron` nor `at` keeps the stored time and state, so editing only the prompt of an
 * `--at` schedule never moves or reactivates it.
 */
export async function updateSchedule(runtime: Runtime, id: string, value: unknown): Promise<ScheduleView> {
	const input = inputObject(value);
	const now = runtime.clock.now();
	const retime = hasValue(typeof input.cron === "string" ? input.cron.trim() : input.cron) || hasValue(input.at);
	const timing = retime ? scheduleTiming(input, runtime.config.timezone, now) : undefined;
	const view = await runtime.db.write(async (tx) => {
		const existing = await scheduleRow(tx, id);
		const kind = hasValue(input.kind) ? scheduleKind(input.kind) : existing.kind;
		const payload = input.payload === undefined ? JSON.parse(existing.payload) : schedulePayload(input, kind);
		const next = timing ?? { cron: existing.cron, at: existing.at, timezone: existing.timezone, nextAt: existing.next_at };
		await tx.run(
			`UPDATE schedules SET kind = ?, state = ?, cron = ?, at = ?, timezone = ?, payload = ?, next_at = ?, updated_at = ?
			  WHERE id = ?`,
			kind,
			timing ? "active" : existing.state,
			next.cron,
			next.at,
			next.timezone,
			JSON.stringify(payload),
			next.nextAt,
			now,
			id,
		);
		return scheduleView(await scheduleRow(tx, id), runtime);
	});
	notifySchedulesChanged(runtime);
	return view;
}

/** SCH-07: a deleted schedule never fires, because its state and `next_at` change in one write. */
export async function deleteSchedule(runtime: Runtime, id: string): Promise<void> {
	const now = runtime.clock.now();
	const deleted = await runtime.db.write(async (tx) => {
		const row = await tx.get<{ state: ScheduleState }>("SELECT state FROM schedules WHERE id = ?", id);
		if (!row || row.state === "deleted") return false;
		await tx.run("UPDATE schedules SET state = 'deleted', next_at = NULL, updated_at = ? WHERE id = ?", now, id);
		return true;
	});
	if (!deleted) throw ApiError.notFound(`schedule ${id}`);
	notifySchedulesChanged(runtime);
}

// --- Scheduler-facing reads and writes ------------------------------------------

export async function activeSchedules(runtime: Runtime): Promise<ScheduleRow[]> {
	return runtime.db.all<ScheduleRow>("SELECT * FROM schedules WHERE state = 'active' ORDER BY next_at, id");
}

export async function dueSchedules(runtime: Runtime, now: number): Promise<ScheduleRow[]> {
	return runtime.db.all<ScheduleRow>(
		"SELECT * FROM schedules WHERE state = 'active' AND next_at IS NOT NULL AND next_at <= ? ORDER BY next_at, id",
		now,
	);
}

/** The earliest `next_at` of any active schedule, or null when nothing is armed. */
export async function nextDueAt(runtime: Runtime): Promise<number | null> {
	const row = await runtime.db.get<{ next: number | null }>(
		"SELECT MIN(next_at) AS next FROM schedules WHERE state = 'active' AND next_at IS NOT NULL",
	);
	return row?.next ?? null;
}

/**
 * Claim one fire. Returns false when the schedule is no longer active (deleted or already fired),
 * so two clocks, or a delete that lands mid-fire, can never run it twice.
 */
export async function claimSchedule(runtime: Runtime, id: string, state: "active" | "done" | "missed", nextAt: number | null): Promise<boolean> {
	const now = runtime.clock.now();
	return runtime.db.write(async (tx) => {
		const row = await tx.get<{ state: ScheduleState }>("SELECT state FROM schedules WHERE id = ?", id);
		if (row?.state !== "active") return false;
		await tx.run("UPDATE schedules SET state = ?, next_at = ?, updated_at = ? WHERE id = ?", state, nextAt, now, id);
		return true;
	});
}

/**
 * WAK-07: retire a schedule that has finished its work, hidden from `list` and from
 * `GET /schedules/:id` the same way a user's delete is. The row stays in the table, so a spent
 * wake is still answerable from the database when someone asks whether it fired.
 */
export async function finishSchedule(runtime: Runtime, id: string): Promise<void> {
	const now = runtime.clock.now();
	await runtime.db.write(async (tx) => {
		await tx.run(
			"UPDATE schedules SET state = 'deleted', next_at = NULL, updated_at = ? WHERE id = ? AND state <> 'deleted'",
			now,
			id,
		);
	});
	notifySchedulesChanged(runtime);
}

/** SCH-05: move an active cron schedule to its next future time without firing it. */
export async function skipScheduleTo(runtime: Runtime, id: string, nextAt: number | null): Promise<void> {
	const now = runtime.clock.now();
	await runtime.db.write(async (tx) => {
		await tx.run("UPDATE schedules SET next_at = ?, updated_at = ? WHERE id = ? AND state = 'active'", nextAt, now, id);
	});
}

/** The creator's address, or the configured user when the schedule came from a session. */
export async function creatorAddress(runtime: Runtime, creatorId: string): Promise<string> {
	const row = await runtime.db.get<{ id: string; kind: string; url: string }>(
		"SELECT id, kind, url FROM participants WHERE id = ?",
		creatorId,
	);
	if (row && row.kind === "user") return row.url;
	return runtime.userUrl;
}
