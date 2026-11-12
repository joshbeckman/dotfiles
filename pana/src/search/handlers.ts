// HTTP handlers owned by WP7: thread search (SRC-01) and the subject route (SUB-04).
//
// `GET /sessions?query=` (SRC-03) belongs to WP3's `sessions.search` handler, which calls
// `searchSessions` from this package; that route is not registered here.

import { ApiError } from "../api/errors.ts";
import { decodeCursor, decodeOffset, pageOf, parseLimit } from "../api/pagination.ts";
import type { Handlers, RequestContext } from "../api/types.ts";
import type { Runtime } from "../server/runtime.ts";
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
	role: string;
}

/** How big a thread is: how many messages it holds and when the newest one landed. */
interface ThreadSize {
	messageCount: number;
	/** The newest message's time; absent for a thread with no messages. */
	lastMessageAt: number | null;
}

/**
 * Per-thread message counts and the newest message time, for one page of threads. Counting is an
 * index range per thread over `messages_thread`, and the newest message is a seek by `seq`, so a
 * page of 25 costs about 0.2 ms at 10,000 threads (SCALE-03). Nothing is denormalized onto
 * `threads` for it: a `message_count` column would be state every writer has to keep true.
 */
async function threadSizes(runtime: Runtime, ids: readonly string[]): Promise<Map<string, ThreadSize>> {
	const sizes = new Map<string, ThreadSize>();
	if (ids.length === 0) return sizes;
	const rows = await runtime.db.all<{ threadId: string; messageCount: number; lastMessageAt: number | null }>(
		`SELECT t.id AS threadId,
		        (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id) AS messageCount,
		        newest.created_at AS lastMessageAt
		   FROM threads t
		   LEFT JOIN messages newest
		     ON newest.thread_id = t.id
		    AND newest.seq = (SELECT MAX(seq) FROM messages m2 WHERE m2.thread_id = t.id)
		  WHERE t.id IN (${ids.map(() => "?").join(",")})`,
		...ids,
	);
	for (const row of rows) sizes.set(row.threadId, { messageCount: row.messageCount, lastMessageAt: row.lastMessageAt ?? null });
	return sizes;
}

/** Shared membership, UX-09 working-session marks, and thread sizes, fetched once per page. */
async function withSharedMetadata<T extends { threadId: string }>(
	ctx: RequestContext,
	rows: readonly T[],
): Promise<Array<T & { working: WorkingSession[]; participants: DiscoveryParticipant[]; participantCount: number; messageCount: number; lastMessageAt: number | null }>> {
	const working = await workingSessions(ctx.runtime.db, rows.map((row) => row.threadId));
	const participants = new Map<string, DiscoveryParticipant[]>();
	const ids = [...new Set(rows.map((row) => row.threadId))];
	const sizes = await threadSizes(ctx.runtime, ids);
	if (ids.length > 0) {
		const people = await ctx.runtime.db.all<DiscoveryParticipant & { threadId: string }>(
			`SELECT tp.thread_id AS threadId, p.id, p.kind, p.url, COALESCE(r.role, 'participant') AS role FROM thread_participants tp
			 JOIN participants p ON p.id = tp.participant_id
			 LEFT JOIN thread_participant_roles r ON r.thread_id = tp.thread_id AND r.participant_id = tp.participant_id
			 WHERE tp.thread_id IN (${ids.map(() => "?").join(",")}) ORDER BY tp.joined_at, p.id`, ...ids,
		);
		for (const { threadId, ...person } of people) {
			const list = participants.get(threadId) ?? [];
			list.push(person);
			participants.set(threadId, list);
		}
	}
	const none: ThreadSize = { messageCount: 0, lastMessageAt: null };
	return rows.map((row) => {
		const members = participants.get(row.threadId) ?? [];
		const size = sizes.get(row.threadId) ?? none;
		return {
			...row,
			working: working.get(row.threadId) ?? [],
			participants: members,
			participantCount: members.length,
			messageCount: size.messageCount,
			lastMessageAt: size.lastMessageAt,
		};
	});
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
