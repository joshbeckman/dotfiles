// HTTP handlers owned by WP7: thread search (SRC-01) and the subject route (SUB-04).
//
// `GET /sessions?query=` (SRC-03) belongs to WP3's `sessions.search` handler, which calls
// `searchSessions` from this package; that route is not registered here.

import { ApiError } from "../api/errors.ts";
import { decodeCursor, decodeOffset, pageOf, parseLimit } from "../api/pagination.ts";
import type { Handlers, RequestContext } from "../api/types.ts";
import { workingSessions, type WorkingSession } from "../sessions/state.ts";
import { DEFAULT_SEARCH_LIMIT, flag, listThreads, searchThreads, type ThreadSearchOptions } from "./query.ts";
import { regenerateSubject, SubjectError, subjectHistory } from "./subjects.ts";

export const handlers: Handlers = {
	"threads.search": async (ctx) => {
		const query = (ctx.query.get("query") ?? "").trim();
		const limit = parseLimit(ctx.query.get("limit"), DEFAULT_SEARCH_LIMIT);
		const cursor = ctx.query.get("cursor");
		// REF-03 and REF-05: archive state and unread counts belong to the caller, so the route
		// asks for the caller's own view rather than the whole domain's.
		const options: ThreadSearchOptions = {
			participantId: ctx.caller.id,
			archived: flag(ctx.query.get("archived")),
			includeArchived: flag(ctx.query.get("includeArchived")),
			unread: flag(ctx.query.get("unread")),
		};
		if (!query) {
			const before = decodeCursor(cursor, ["string"])?.[0] as string | undefined;
			const rows = await listThreads(ctx.runtime, { ...options, limit: limit + 1, ...(before === undefined ? {} : { before }) });
			const page = pageOf(rows, limit, (row) => [row.threadId]);
			return { status: 200, body: { threads: await withWorking(ctx, page.items), nextCursor: page.nextCursor } };
		}
		const offset = decodeOffset(cursor);
		const hits = await searchThreads(ctx.runtime, query, { ...options, limit: limit + 1, offset });
		const page = pageOf(hits, limit, () => [offset + limit]);
		return { status: 200, body: { threads: await withWorking(ctx, page.items), nextCursor: page.nextCursor } };
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

/** UX-09: each row names the session participants that are working now, for its small mark. */
async function withWorking<T extends { threadId: string }>(ctx: RequestContext, rows: readonly T[]): Promise<Array<T & { working: WorkingSession[] }>> {
	const working = await workingSessions(ctx.runtime.db, rows.map((row) => row.threadId));
	return rows.map((row) => ({ ...row, working: working.get(row.threadId) ?? [] }));
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
