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
	/** The reader's unread messages in this thread (REF-05). */
	unreadCount: number;
	/** True when the reader has this thread archived (REF-03). */
	archived: boolean;
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
	/** The reader's unread messages in this thread (REF-05). */
	unreadCount: number;
	/** True when the reader has this thread archived (REF-03). */
	archived: boolean;
}

export interface SearchOptions {
	limit?: number;
	/** Hits to skip, for the next page of a search (SCALE-03). */
	offset?: number;
}

export interface ThreadSearchOptions extends SearchOptions {
	/** The reader. Its archive state hides threads and its deliveries count as unread. */
	participantId?: string;
	/** Only archived threads. Default: only threads this participant has not archived (REF-03). */
	archived?: boolean;
	/** Only threads with unread messages for this participant (REF-05). */
	unread?: boolean;
	/** The ID of the last thread of the previous page; a list continues with older threads (SCALE-03). */
	before?: string;
}

/** True for `?archived=1`-style query values. */
export function flag(value: string | null | undefined): boolean {
	return value === "1" || value === "true" || value === "yes";
}

/**
 * The reader's view of a thread: its unread count and whether it is archived. Both are
 * subqueries on the outer `threads t`, so a list and a search share them.
 */
const READER_COLUMNS =
	"(SELECT COUNT(*) FROM deliveries d WHERE d.thread_id = t.id AND d.recipient_id = ? AND d.read_at IS NULL) AS unreadCount, " +
	"(SELECT COUNT(*) FROM thread_archives a WHERE a.thread_id = t.id AND a.participant_id = ?) AS archived";

const NO_READER_COLUMNS = "0 AS unreadCount, 0 AS archived";

/** The `AND ...` clauses that hide a participant's archived threads and filter for unread ones. */
function readerFilter(options: ThreadSearchOptions): { sql: string; params: string[] } {
	const clauses: string[] = [];
	const params: string[] = [];
	if (options.participantId === undefined) {
		if (options.archived) clauses.push("0");
		if (options.unread) clauses.push("0");
	} else {
		const not = options.archived ? "" : "NOT ";
		clauses.push(
			`${not}EXISTS (SELECT 1 FROM thread_archives a WHERE a.thread_id = t.id AND a.participant_id = ?)`,
		);
		params.push(options.participantId);
		if (options.unread) {
			clauses.push(
				`EXISTS (SELECT 1 FROM deliveries d WHERE d.thread_id = t.id AND d.recipient_id = ? AND d.read_at IS NULL)`,
			);
			params.push(options.participantId);
		}
	}
	return { sql: clauses.map((clause) => `AND ${clause}`).join(" "), params };
}

function readerParams(options: ThreadSearchOptions): string[] {
	return options.participantId === undefined ? [] : [options.participantId, options.participantId];
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
export async function searchThreads(runtime: Runtime, query: string, options: ThreadSearchOptions = {}): Promise<ThreadHit[]> {
	const match = matchExpression(query);
	if (!match) return [];
	// Subject hits come first, so a page past them needs the subject hits before it counted too.
	const limit = (options.limit ?? DEFAULT_SEARCH_LIMIT) + (options.offset ?? 0);
	const filter = readerFilter(options);
	const columns = options.participantId === undefined ? NO_READER_COLUMNS : READER_COLUMNS;

	const subjectRows = await runtime.db.all<{
		threadId: string;
		subject: string | null;
		snippet: string;
		createdAt: number;
		unreadCount: number;
		archived: number;
	}>(
		`SELECT subjects_fts.thread_id AS threadId, t.subject AS subject,
		        snippet(subjects_fts, 0, '[', ']', '…', 12) AS snippet, t.created_at AS createdAt, ${columns}
		 FROM subjects_fts
		 JOIN threads t ON t.id = subjects_fts.thread_id
		 WHERE subjects_fts MATCH ? ${filter.sql}
		 ORDER BY rank
		 LIMIT ?`,
		...(options.participantId === undefined ? [] : [options.participantId, options.participantId]),
		match,
		...filter.params,
		limit,
	);

	const messageRows = await runtime.db.all<{
		threadId: string;
		messageId: string;
		subject: string | null;
		snippet: string;
		createdAt: number;
		unreadCount: number;
		archived: number;
	}>(
		`SELECT messages_fts.thread_id AS threadId, messages_fts.message_id AS messageId, t.subject AS subject,
		        snippet(messages_fts, 0, '[', ']', '…', 12) AS snippet, m.created_at AS createdAt, ${columns}
		 FROM messages_fts
		 JOIN messages m ON m.id = messages_fts.message_id
		 JOIN threads t ON t.id = messages_fts.thread_id
		 WHERE messages_fts MATCH ? ${filter.sql}
		 ORDER BY rank
		 LIMIT ?`,
		...(options.participantId === undefined ? [] : [options.participantId, options.participantId]),
		match,
		...filter.params,
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
			unreadCount: row.unreadCount,
			archived: Boolean(row.archived),
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
			unreadCount: row.unreadCount,
			archived: Boolean(row.archived),
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

/**
 * Every thread this reader can see, newest first. `GET /threads` without a query serves this.
 * Thread IDs are ULIDs made on the runtime clock when the thread is, so ID order is creation
 * order and the primary key index serves each page (SCALE-03).
 */
export async function listThreads(runtime: Runtime, options: ThreadSearchOptions = {}): Promise<ThreadSummary[]> {
	const filter = readerFilter(options);
	const columns = options.participantId === undefined ? NO_READER_COLUMNS : READER_COLUMNS;
	const rows = await runtime.db.all<{
		id: string;
		subject: string | null;
		createdAt: number;
		unreadCount: number;
		archived: number;
	}>(
		`SELECT t.id AS id, t.subject AS subject, t.created_at AS createdAt, ${columns}
		   FROM threads t
		  WHERE 1 = 1 ${filter.sql} ${options.before === undefined ? "" : "AND t.id < ?"}
		  ORDER BY t.id DESC
		  LIMIT ?`,
		...readerParams(options),
		...filter.params,
		...(options.before === undefined ? [] : [options.before]),
		options.limit ?? DEFAULT_SEARCH_LIMIT,
	);
	return rows.map((row) => ({
		threadId: row.id,
		threadUrl: formatUrl({ kind: "thread", id: row.id }, runtime.config.domain),
		subject: row.subject,
		createdAt: row.createdAt,
		unreadCount: row.unreadCount,
		archived: Boolean(row.archived),
	}));
}
