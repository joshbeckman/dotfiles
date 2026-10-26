// HTTP handlers owned by WP7: thread search (SRC-01) and the subject route (SUB-04).
//
// `GET /sessions?query=` (SRC-03) belongs to WP3's `sessions.search` handler, which calls
// `searchSessions` from this package; that route is not registered here.

import { ApiError } from "../api/errors.ts";
import type { Handlers } from "../api/types.ts";
import { DEFAULT_SEARCH_LIMIT, flag, listThreads, searchThreads, type ThreadSearchOptions } from "./query.ts";
import { regenerateSubject, SubjectError, subjectHistory } from "./subjects.ts";

const MAX_SEARCH_LIMIT = 100;

export const handlers: Handlers = {
	"threads.search": async (ctx) => {
		const query = (ctx.query.get("query") ?? "").trim();
		const limit = parseLimit(ctx.query.get("limit"));
		// REF-03 and REF-05: archive state and unread counts belong to the caller, so the route
		// asks for the caller's own view rather than the whole domain's.
		const options: ThreadSearchOptions = {
			limit,
			participantId: ctx.caller.id,
			archived: flag(ctx.query.get("archived")),
			unread: flag(ctx.query.get("unread")),
		};
		if (!query) return { status: 200, body: { threads: await listThreads(ctx.runtime, options) } };
		return { status: 200, body: { threads: await searchThreads(ctx.runtime, query, options) } };
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

function wantsRegeneration(body: unknown, query: string | null): boolean {
	if (typeof body === "object" && body !== null && (body as { regenerate?: unknown }).regenerate === true) return true;
	return query === "1" || query === "true";
}

function parseLimit(value: string | null): number {
	const limit = Number(value);
	if (!Number.isFinite(limit) || limit < 1) return DEFAULT_SEARCH_LIMIT;
	return Math.min(Math.floor(limit), MAX_SEARCH_LIMIT);
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
