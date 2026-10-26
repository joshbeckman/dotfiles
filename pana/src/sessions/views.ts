// What `session show`, `session search`, and the transcript route return (STA-03, STA-06, LIM-04).
//
// `waiting` is not stored. A session marked `running` reports `waiting` while its work sleeps,
// such as a retry backoff, or while a tool call waits on a child task. pi-durable's scheduler
// knows that, so it is read from `harness.inspect()` at request time.

import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { UsageDoc, type ConversationId, type HarnessInspection, type UsageState } from "@earendil-works/pi-durable";
import { ApiError } from "../api/errors.ts";
import { searchSessions } from "../search/index.ts";
import type { Runtime } from "../server/runtime.ts";
import { usageCost } from "./budget.ts";
import { SESSION_STATES, type SessionRow, type SessionState } from "./runtime.ts";

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
	usage: UsageState;
}

/** Conversations whose work is asleep or waiting on a child task (STA-03). */
export function waitingConversations(inspection: HarnessInspection): Set<number> {
	const out = new Set<number>();
	for (const task of inspection.tasks) {
		const sleeping = task.state.kind === "sleeping";
		const onChild = task.record.kind === "pi.tool" && task.state.kind === "waiting";
		if (sleeping || onChild) out.add(task.record.conversationId);
	}
	return out;
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
	return { ...view, costUsd: usageCost(plain), usage: plain };
}

export interface SearchSessionsInput {
	query?: string;
	state?: string;
	parent?: string;
	limit?: number;
}

/** STA-06 and SRC-03: filter by state and parent, and by transcript text when `query` is set. */
export async function findSessions(runtime: Runtime, input: SearchSessionsInput): Promise<Array<SessionView & { snippet?: string }>> {
	if (input.state !== undefined && !(SESSION_STATES as readonly string[]).includes(input.state)) {
		throw ApiError.badRequest("invalid_state", `state must be one of ${SESSION_STATES.join(", ")}`);
	}
	const limit = input.limit ?? 100;
	let rows: SessionRow[];
	const snippets = new Map<string, string>();
	if (input.query) {
		const hits = await searchSessions(runtime, input.query, { limit: 500 });
		const ids: string[] = [];
		for (const hit of hits) {
			if (snippets.has(hit.sessionId)) continue;
			snippets.set(hit.sessionId, hit.snippet);
			ids.push(hit.sessionId);
		}
		if (ids.length === 0) return [];
		const found = await runtime.db.all<SessionRow>(`SELECT * FROM sessions WHERE id IN (${ids.map(() => "?").join(",")})`, ...ids);
		const byId = new Map(found.map((row) => [row.id, row]));
		rows = ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
	} else {
		rows = await runtime.db.all<SessionRow>("SELECT * FROM sessions ORDER BY created_at DESC, id DESC");
	}
	const waiting = waitingConversations(await runtime.harness.inspect(ctx));
	const out: Array<SessionView & { snippet?: string }> = [];
	for (const row of rows) {
		if (input.parent !== undefined && row.parent !== input.parent) continue;
		const view = sessionView(runtime, row, waiting);
		if (input.state !== undefined && view.state !== input.state) continue;
		const snippet = snippets.get(row.id);
		out.push(snippet === undefined ? view : { ...view, snippet });
		if (out.length >= limit) break;
	}
	return out;
}

export interface TranscriptView {
	session: string;
	entries: Array<{ id: number; kind: string; data?: unknown; model?: unknown }>;
	next?: number;
}

/** The session's transcript, oldest first, `limit` entries after entry `after`. */
export async function transcript(runtime: Runtime, id: string, options: { after?: number; limit?: number } = {}): Promise<TranscriptView> {
	const row = await sessionRow(runtime, id);
	if (row.conversation_id === null) return { session: id, entries: [] };
	const conversation = await runtime.harness.conversation(row.conversation_id as ConversationId, ctx);
	if (!conversation) return { session: id, entries: [] };
	const limit = Math.max(1, Math.min(options.limit ?? 500, 1000));
	const page = await conversation.entries(
		{ order: "ascending", ...(options.after === undefined ? {} : { minEntryId: (options.after + 1) as never }) },
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
	const view: TranscriptView = { session: id, entries };
	if (page.items.length > limit) view.next = entries[entries.length - 1]!.id;
	return view;
}
