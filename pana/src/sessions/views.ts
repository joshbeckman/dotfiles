// What `session show`, `session search`, and the transcript route return (STA-03, STA-06, LIM-04).
//
// `waiting` is not stored. A session marked `running` reports `waiting` while its work sleeps,
// such as a retry backoff, or while a tool call waits on a child task. pi-durable's scheduler
// knows that, so it is read from `harness.inspect()` at request time.

import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { UsageDoc, type ConversationId, type UsageState } from "@earendil-works/pi-durable";
import type { SqliteValue } from "@earendil-works/chord/sqlite";
import { ApiError } from "../api/errors.ts";
import { decodeCursor, decodeOffset, pageOf, type Page } from "../api/pagination.ts";
import { sessionWakes, type ScheduleView } from "../schedules/store.ts";
import { searchSessions } from "../search/index.ts";
import type { Runtime } from "../server/runtime.ts";
import { usageCost } from "./budget.ts";
import { currentLive, type LiveView } from "./live.ts";
import { SESSION_STATES, type SessionRow, type SessionState } from "./runtime.ts";
// UX-09 keeps the `waiting` rule next to the state writer that publishes it.
import { waitingConversations } from "./state.ts";
import { directoryBytes, scratchPath } from "../scratch/index.ts";
export { waitingConversations };

export interface SessionView {
	id: string;
	url: string;
	state: SessionState;
	parent: string | null;
	parentUrl: string | null;
	depth: number;
	model: string | null;
	thinking: string | null;
	profile: string | null;
	cwd: string | null;
	conversationId: number | null;
	costUsd: number;
	createdAt: number;
	updatedAt: number;
}

export interface SessionDetail extends SessionView {
	/** Active wake schedules targeting this session, ordered by next dispatch time. */
	wakes: ScheduleView[];
	usage: UsageState;
	/** UX-12: the work in progress, so a window that opens mid-run shows it before any event. */
	live: LiveView | null;
	/** SCR-07: `bytes` is null when the directory does not exist. */
	scratch: { path: string; bytes: number | null };
}

export function sessionView(runtime: Runtime, row: SessionRow, waiting: Set<number>): SessionView {
	const state = row.state === "running" && row.conversation_id !== null && waiting.has(row.conversation_id) ? "waiting" : row.state;
	return {
		id: row.id,
		url: runtime.url({ kind: "session", id: row.id }),
		state,
		parent: row.parent,
		parentUrl: row.parent ? runtime.url({ kind: "session", id: row.parent }) : null,
		depth: row.depth,
		model: row.model,
		thinking: row.thinking,
		profile: row.profile,
		cwd: row.cwd,
		conversationId: row.conversation_id,
		costUsd: row.cost_usd,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export async function sessionRow(runtime: Runtime, id: string): Promise<SessionRow> {
	const row = await runtime.db.get<SessionRow>("SELECT * FROM sessions WHERE id = ?", id);
	if (!row) throw ApiError.notFound(`session ${id}`);
	return row;
}

/** LIM-04: `session show`, with cost read from pi-durable's `pi.usage`. */
export async function showSession(runtime: Runtime, id: string): Promise<SessionDetail> {
	const row = await sessionRow(runtime, id);
	const waiting = waitingConversations(await runtime.harness.inspect(ctx));
	const view = sessionView(runtime, row, waiting);
	const usage =
		row.conversation_id === null
			? undefined
			: await runtime.harness.snapshot(UsageDoc, row.conversation_id as ConversationId, ctx);
	const plain: UsageState = usage ? (JSON.parse(JSON.stringify(usage)) as UsageState) : { models: {}, tools: {} };
	const live = await currentLive(runtime, row.conversation_id);
	const path = scratchPath(runtime, id);
	return { ...view, costUsd: usageCost(plain), usage: plain, live, wakes: await sessionWakes(runtime, id), scratch: { path, bytes: await directoryBytes(path) } };
}

export interface SearchSessionsInput {
	query?: string;
	state?: string;
	parent?: string;
	limit?: number;
	cursor?: string | null;
}

export const SESSION_LIMIT = 100;

/** Rows read per query while filling a page whose filter runs in JavaScript (`waiting`). */
const SCAN_BATCH = 200;

/**
 * STA-06 and SRC-03: filter by state and parent, and by transcript text when `query` is set, one
 * page at a time (SCALE-03). Session IDs are ULIDs made on the runtime clock, so ID order is
 * creation order and the primary key serves each page. `waiting` is a `running` row whose work
 * sleeps (STA-03), so those two states filter in JavaScript after SQL narrows to `running`.
 */
export async function findSessions(runtime: Runtime, input: SearchSessionsInput): Promise<Page<SessionView & { snippet?: string }>> {
	if (input.state !== undefined && !(SESSION_STATES as readonly string[]).includes(input.state)) {
		throw ApiError.badRequest("invalid_state", `state must be one of ${SESSION_STATES.join(", ")}`);
	}
	const limit = input.limit ?? SESSION_LIMIT;
	const waiting = waitingConversations(await runtime.harness.inspect(ctx));
	const keep = (row: SessionRow) => {
		if (input.parent !== undefined && row.parent !== input.parent) return undefined;
		const view = sessionView(runtime, row, waiting);
		return input.state === undefined || view.state === input.state ? view : undefined;
	};

	if (input.query) return searchPage(runtime, input.query, input.cursor, limit, keep);

	const where: string[] = [];
	const params: SqliteValue[] = [];
	if (input.parent !== undefined) {
		where.push("parent = ?");
		params.push(input.parent);
	}
	if (input.state !== undefined) {
		where.push("state = ?");
		params.push(input.state === "waiting" ? "running" : input.state);
	}
	let before = decodeCursor(input.cursor, ["string"])?.[0] as string | undefined;
	const out: SessionView[] = [];
	for (;;) {
		const conditions = before === undefined ? where : [...where, "id < ?"];
		const rows = await runtime.db.all<SessionRow>(
			`SELECT * FROM sessions ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`,
			...params,
			...(before === undefined ? [] : [before]),
			SCAN_BATCH,
		);
		for (const row of rows) {
			const view = keep(row);
			if (view) out.push(view);
			if (out.length > limit) return pageOf(out, limit, (session) => [session.id]);
		}
		if (rows.length < SCAN_BATCH) return pageOf(out, limit, (session) => [session.id]);
		before = rows[rows.length - 1]!.id;
	}
}

/** Transcript search: hits in rank order, paged by offset. */
async function searchPage(
	runtime: Runtime,
	query: string,
	cursor: string | null | undefined,
	limit: number,
	keep: (row: SessionRow) => SessionView | undefined,
): Promise<Page<SessionView & { snippet: string }>> {
	const offset = decodeOffset(cursor);
	const hits = await searchSessions(runtime, query, { limit: 500 });
	const snippets = new Map<string, string>();
	for (const hit of hits) if (!snippets.has(hit.sessionId)) snippets.set(hit.sessionId, hit.snippet);
	const ids = [...snippets.keys()];
	if (ids.length === 0) return { items: [], nextCursor: null };
	const found = await runtime.db.all<SessionRow>(`SELECT * FROM sessions WHERE id IN (${ids.map(() => "?").join(",")})`, ...ids);
	const byId = new Map(found.map((row) => [row.id, row]));
	const matches: Array<SessionView & { snippet: string }> = [];
	for (const id of ids) {
		const row = byId.get(id);
		const view = row && keep(row);
		if (view) matches.push({ ...view, snippet: snippets.get(id)! });
	}
	return pageOf(matches.slice(offset, offset + limit + 1), limit, () => [offset + limit]);
}

export interface TranscriptView {
	session: string;
	entries: Array<{ id: number; kind: string; data?: unknown; model?: unknown }>;
	/** Forward paging: the newest entry in this page when entries follow it (`after` pages). */
	next?: number;
	/** Backward paging: the oldest entry in this page when entries precede it (`latest`/`before` pages). */
	previous?: number;
}

export interface TranscriptOptions {
	/** Entries after this entry ID, oldest first: forward paging from a known entry. */
	after?: number;
	/** Entries before this entry ID, the newest ones first read backward: backward paging. */
	before?: number;
	/** The newest entries, with no `before` boundary: what a window shows when it opens. */
	latest?: boolean;
	limit?: number;
}

/**
 * The session's transcript, oldest first, one page of `limit` entries. `after` pages forward from a
 * known entry and answers `next`; `latest` or `before` pages backward from the newest entry and
 * answers `previous`, so a window can open at the end of a long transcript without walking every
 * earlier page first (UX-18). Entries are oldest first in the body either way.
 */
export async function transcript(runtime: Runtime, id: string, options: TranscriptOptions = {}): Promise<TranscriptView> {
	const row = await sessionRow(runtime, id);
	if (row.conversation_id === null) return { session: id, entries: [] };
	const conversation = await runtime.harness.conversation(row.conversation_id as ConversationId, ctx);
	if (!conversation) return { session: id, entries: [] };
	const limit = Math.max(1, Math.min(options.limit ?? 500, 1000));
	const backward = options.before !== undefined || options.latest === true;
	if (backward && options.after !== undefined) {
		throw ApiError.badRequest("invalid_page", "after cannot be combined with before or latest");
	}
	const page = await conversation.entries(
		backward
			? { order: "descending", ...(options.before === undefined ? {} : { maxEntryId: (options.before - 1) as never }) }
			: { order: "ascending", ...(options.after === undefined ? {} : { minEntryId: (options.after + 1) as never }) },
		limit + 1,
		undefined,
		ctx,
	);
	const items = page.items.slice(0, limit);
	const entries = items.map((entry) => ({
		id: entry.id as number,
		kind: entry.kind,
		...(entry.data === undefined ? {} : { data: entry.data }),
		...(entry.model === undefined ? {} : { model: entry.model }),
	}));
	if (backward) entries.reverse();
	const view: TranscriptView = { session: id, entries };
	if (page.items.length <= limit || entries.length === 0) return view;
	// The extra entry proves another page exists on the side this page came from.
	if (backward) view.previous = entries[0]!.id;
	else view.next = entries[entries.length - 1]!.id;
	return view;
}
