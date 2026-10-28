// HTTP handlers owned by WP7: thread search (SRC-01) and the subject route (SUB-04).
//
// `GET /sessions?query=` (SRC-03) belongs to WP3's `sessions.search` handler, which calls
// `searchSessions` from this package; that route is not registered here.

import { ApiError } from "../api/errors.ts";
import { decodeCursor, decodeOffset, pageOf, parseLimit } from "../api/pagination.ts";
import type { Handlers, RequestContext } from "../api/types.ts";
import { workingSessions, type WorkingSession } from "../sessions/state.ts";
import { DEFAULT_SEARCH_LIMIT, participantFilterId, listThreads, searchThreads, type ThreadSearchOptions } from "./query.ts";
import { regenerateSubject, SubjectError, subjectHistory } from "./subjects.ts";

export const handlers: Handlers = {
	"threads.search": async (ctx) => {
		const query = (ctx.query.get("query") ?? "").trim();
		const limit = parseLimit(ctx.query.get("limit"), DEFAULT_SEARCH_LIMIT);
		const cursor = ctx.query.get("cursor");
		for (const name of ["archived", "includeArchived", "unread"]) {
			if (ctx.query.has(name)) throw ApiError.badRequest("invalid_filter", `${name} is not supported for thread discovery; personal state belongs to inbox views`);
		}
		const participant = ctx.query.get("participant");
		const options: ThreadSearchOptions = participant === null ? {} : {
			participantId: await participantFilterId(ctx.runtime, participant),
		};
		if (!query) {
			const before = decodeCursor(cursor, ["string"])?.[0] as string | undefined;
			const rows = await listThreads(ctx.runtime, { ...options, limit: limit + 1, ...(before === undefined ? {} : { before }) });
			const page = pageOf(rows, limit, (row) => [row.threadId]);
			return { status: 200, body: { threads: await withSharedMetadata(ctx, page.items), nextCursor: page.nextCursor } };
		}
		const offset = decodeOffset(cursor);
		const hits = await searchThreads(ctx.runtime, query, { ...options, limit: limit + 1, offset });
		const page = pageOf(hits, limit, () => [offset + limit]);
		return { status: 200, body: { threads: await withSharedMetadata(ctx, page.items), nextCursor: page.nextCursor } };
	},

	"threads.subject": async (ctx) => {
		const runtime = ctx.runtime;
		const threadId = ctx.params.id ?? "";
		const thread = await runtime.db.get<{ subject: string | null }>("SELECT subject FROM threads WHERE id = ?", threadId);
		if (!thread) throw ApiError.notFound(`thread ${threadId}`);
		const threadUrl = runtime.url({ kind: "thread", id: threadId });

		if (!wantsRegeneration(ctx.body, ctx.query.get("regenerate"))) {
			return {
				status: 200,
				body: { threadUrl, subject: thread.subject, history: await subjectHistory(runtime, threadId) },
			};
		}

		if (ctx.caller.kind !== "user") {
			throw ApiError.forbidden("only the user may regenerate a thread subject");
		}
		try {
			const { subject, previous } = await regenerateSubject(runtime, threadId);
			return {
				status: 200,
				body: { threadUrl, subject, previous, history: await subjectHistory(runtime, threadId) },
			};
		} catch (error) {
			throw asApiError(error);
		}
	},
};

interface DiscoveryParticipant {
	id: string;
	kind: "user" | "session" | "domain";
	url: string;
}

/** Shared membership and UX-09 working-session marks, fetched once per page. */
async function withSharedMetadata<T extends { threadId: string }>(ctx: RequestContext, rows: readonly T[]): Promise<Array<T & { working: WorkingSession[]; participants: DiscoveryParticipant[] }>> {
	const working = await workingSessions(ctx.runtime.db, rows.map((row) => row.threadId));
	const participants = new Map<string, DiscoveryParticipant[]>();
	const ids = [...new Set(rows.map((row) => row.threadId))];
	if (ids.length > 0) {
		const people = await ctx.runtime.db.all<DiscoveryParticipant & { threadId: string }>(
			`SELECT tp.thread_id AS threadId, p.id, p.kind, p.url FROM thread_participants tp
			 JOIN participants p ON p.id = tp.participant_id
			 WHERE tp.thread_id IN (${ids.map(() => "?").join(",")}) ORDER BY tp.joined_at, p.id`, ...ids,
		);
		for (const { threadId, ...person } of people) {
			const list = participants.get(threadId) ?? [];
			list.push(person);
			participants.set(threadId, list);
		}
	}
	return rows.map((row) => ({ ...row, working: working.get(row.threadId) ?? [], participants: participants.get(row.threadId) ?? [] }));
}

function wantsRegeneration(body: unknown, query: string | null): boolean {
	if (typeof body === "object" && body !== null && (body as { regenerate?: unknown }).regenerate === true) return true;
	return query === "1" || query === "true";
}

/** A subject failure is the caller's fault when the config or body is wrong, and upstream's otherwise. */
function asApiError(error: unknown): ApiError {
	if (error instanceof SubjectError) {
		return error.code === "model_failed"
			? new ApiError(502, error.code, error.message)
			: ApiError.badRequest(error.code, error.message);
	}
	return error instanceof ApiError ? error : new ApiError(500, "internal", error instanceof Error ? error.message : String(error));
}
