// Subjects and search (WP7). SUB-01..04 and SRC-01..03.
//
// Where WP2 and WP3 must call these:
// - WP2 thread create: `applyInitialSubject(tx, ...)` inside the create transaction, then
//   `scheduleSubject(runtime, threadId)` after it commits (SUB-01, SUB-02).
// - WP2 message append: `indexMessage(tx, ...)` in the same transaction as the insert (SRC-01).
// - WP2 revision: `reindexRevision(tx, ...)`; WP2 redaction: `removeRedacted(tx, messageId)` (SRC-02).
// - WP3 settled run: `indexSessionRun(tx, ...)` with the run's user and assistant text (SRC-03).
// - WP3 `sessions.search` handler: `searchSessions(runtime, query)` for `--query` (SRC-03).

export {
	indexMessage,
	indexSessionRun,
	reindexRevision,
	removeRedacted,
	type IndexedMessage,
	type SessionRun,
	type TranscriptEntry,
} from "./indexing.ts";
export {
	DEFAULT_SEARCH_LIMIT,
	participantFilterId,
	listThreads,
	matchExpression,
	searchSessions,
	searchThreads,
	type SearchOptions,
	type SessionHit,
	type ThreadHit,
	type ThreadSearchOptions,
	type ThreadSummary,
} from "./query.ts";
export {
	applyInitialSubject,
	awaitSubjectJobs,
	firstLineSubject,
	recordSubject,
	regenerateSubject,
	scheduleSubject,
	SUBJECT_MAX_LENGTH,
	SUBJECT_MAX_TOKENS,
	SUBJECT_SYSTEM_PROMPT,
	SubjectError,
	subjectHistory,
	type InitialSubjectOptions,
	type RecordSubjectOptions,
	type RegeneratedSubject,
	type SubjectErrorCode,
	type SubjectJobOptions,
	type SubjectRecord,
	type SubjectSource,
} from "./subjects.ts";
export { handlers } from "./handlers.ts";
