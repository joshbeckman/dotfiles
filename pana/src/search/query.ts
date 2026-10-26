// FTS5 reads for thread and session search (SRC-01, SRC-03).
//
// Reads go straight to `runtime.db`; only writes need the `atomically`/`write` queue (see
// src/db/atomic.ts).

import { formatUrl } from "../ids/index.ts";
import type { Runtime } from "../server/runtime.ts";

export const DEFAULT_SEARCH_LIMIT = 25;

export interface ThreadHit {
	threadId: string;
	threadUrl: string;
	subject: string | null;
	/** The matching message; absent when the thread subject matched instead. */
	messageId?: string;
	messageUrl?: string;
	snippet: string;
	matched: "subject" | "message";
	createdAt: number;
}

export interface SessionHit {
	sessionId: string;
	sessionUrl: string;
	snippet: string;
}

export interface ThreadSummary {
	threadId: string;
	threadUrl: string;
	subject: string | null;
	createdAt: number;
}

export interface SearchOptions {
	limit?: number;
	/** Hits to skip, for the next page of a search (SCALE-03). */
	offset?: number;
}

/**
 * Turn free text into an FTS5 expression: every token is quoted as a phrase, and the tokens are
 * ANDed. Raw input never reaches MATCH, because `-`, `*`, `NEAR`, and an unbalanced quote are all
 * syntax to FTS5 and would turn a user's search text into a parse error.
 */
export function matchExpression(query: string): string | undefined {
	const terms = query
		.split(/\s+/)
		.map((term) => term.replace(/"/g, '""'))
		.filter((term) => /[\p{L}\p{N}]/u.test(term));
	if (terms.length === 0) return undefined;
	return terms.map((term) => `"${term}"`).join(" AND ");
}

/** Search thread subjects and message bodies. Subject hits come first, then message hits by rank. */
export async function searchThreads(runtime: Runtime, query: string, options: SearchOptions = {}): Promise<ThreadHit[]> {
	const match = matchExpression(query);
	if (!match) return [];
	// Subject hits come first, so a page past them needs the subject hits before it counted too.
	const limit = (options.limit ?? DEFAULT_SEARCH_LIMIT) + (options.offset ?? 0);

	const subjectRows = await runtime.db.all<{ threadId: string; subject: string | null; snippet: string; createdAt: number }>(
		`SELECT subjects_fts.thread_id AS threadId, t.subject AS subject,
		        snippet(subjects_fts, 0, '[', ']', '…', 12) AS snippet, t.created_at AS createdAt
		 FROM subjects_fts
		 JOIN threads t ON t.id = subjects_fts.thread_id
		 WHERE subjects_fts MATCH ?
		 ORDER BY rank
		 LIMIT ?`,
		match,
		limit,
	);

	const messageRows = await runtime.db.all<{
		threadId: string;
		messageId: string;
		subject: string | null;
		snippet: string;
		createdAt: number;
	}>(
		`SELECT messages_fts.thread_id AS threadId, messages_fts.message_id AS messageId, t.subject AS subject,
		        snippet(messages_fts, 0, '[', ']', '…', 12) AS snippet, m.created_at AS createdAt
		 FROM messages_fts
		 JOIN messages m ON m.id = messages_fts.message_id
		 JOIN threads t ON t.id = messages_fts.thread_id
		 WHERE messages_fts MATCH ?
		 ORDER BY rank
		 LIMIT ?`,
		match,
		limit,
	);

	const hits: ThreadHit[] = [
		...subjectRows.map((row) => ({
			threadId: row.threadId,
			threadUrl: formatUrl({ kind: "thread", id: row.threadId }, runtime.config.domain),
			subject: row.subject,
			snippet: row.snippet,
			matched: "subject" as const,
			createdAt: row.createdAt,
		})),
		...messageRows.map((row) => ({
			threadId: row.threadId,
			threadUrl: formatUrl({ kind: "thread", id: row.threadId }, runtime.config.domain),
			subject: row.subject,
			messageId: row.messageId,
			messageUrl: formatUrl({ kind: "message", id: row.messageId, thread: row.threadId }, runtime.config.domain),
			snippet: row.snippet,
			matched: "message" as const,
			createdAt: row.createdAt,
		})),
	];
	return hits.slice(options.offset ?? 0, limit);
}

/** Search the user and assistant text of session transcripts, indexed when each run settled. */
export async function searchSessions(runtime: Runtime, query: string, options: SearchOptions = {}): Promise<SessionHit[]> {
	const match = matchExpression(query);
	if (!match) return [];
	const rows = await runtime.db.all<{ sessionId: string; snippet: string }>(
		`SELECT sessions_fts.session_id AS sessionId, snippet(sessions_fts, 0, '[', ']', '…', 12) AS snippet
		 FROM sessions_fts
		 WHERE sessions_fts MATCH ?
		 ORDER BY rank
		 LIMIT ?`,
		match,
		options.limit ?? DEFAULT_SEARCH_LIMIT,
	);
	return rows.map((row) => ({
		sessionId: row.sessionId,
		sessionUrl: formatUrl({ kind: "session", id: row.sessionId }, runtime.config.domain),
		snippet: row.snippet,
	}));
}

export interface ListOptions {
	limit?: number;
	/** The ID of the last thread of the previous page; the list continues with older threads. */
	before?: string;
}

/**
 * Every thread, newest first. `GET /threads` without a query serves this. Thread IDs are ULIDs made
 * on the runtime clock when the thread is, so ID order is creation order and the primary key
 * index serves each page (SCALE-03).
 */
export async function listThreads(runtime: Runtime, options: ListOptions = {}): Promise<ThreadSummary[]> {
	const rows = await runtime.db.all<{ id: string; subject: string | null; createdAt: number }>(
		`SELECT id, subject, created_at AS createdAt FROM threads ${options.before === undefined ? "" : "WHERE id < ?"} ORDER BY id DESC LIMIT ?`,
		...(options.before === undefined ? [] : [options.before]),
		options.limit ?? DEFAULT_SEARCH_LIMIT,
	);
	return rows.map((row) => ({
		threadId: row.id,
		threadUrl: formatUrl({ kind: "thread", id: row.id }, runtime.config.domain),
		subject: row.subject,
		createdAt: row.createdAt,
	}));
}
