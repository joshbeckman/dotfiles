// FTS5 writes for thread messages and session transcripts (SRC-01..03).
//
// Every function takes the caller's transaction handle: WP2 and WP3 run the index write in the
// same `db.write`/`atomically` as the row it describes, so a crash never leaves the index ahead
// of the data. WP2 calls `indexMessage`, `reindexRevision`, and `removeRedacted`; WP3 calls
// `indexSessionRun` when a run settles.

import type { SqliteExecutor } from "@earendil-works/chord/sqlite";

export interface IndexedMessage {
	id: string;
	threadId: string;
	body: string;
}

export interface TranscriptEntry {
	/** A stable id for the entry, such as a pi-durable entry id. Re-indexing the same id replaces it. */
	id: string;
	role: "user" | "assistant";
	text: string;
}

export interface SessionRun {
	sessionId: string;
	entries: readonly TranscriptEntry[];
}

/** Add one message body to the thread index. Repeating a message id replaces its row. */
export async function indexMessage(tx: SqliteExecutor, message: IndexedMessage): Promise<void> {
	await tx.run("DELETE FROM messages_fts WHERE message_id = ?", message.id);
	await tx.run(
		"INSERT INTO messages_fts (body, message_id, thread_id) VALUES (?, ?, ?)",
		message.body,
		message.id,
		message.threadId,
	);
}

/**
 * Replace a revised message's text (SRC-02). Readers only see the newest revision, so only it is
 * indexed; the original body stays in `message_events` and stays out of the index.
 */
export async function reindexRevision(tx: SqliteExecutor, message: IndexedMessage): Promise<void> {
	await indexMessage(tx, message);
}

/** Drop a redacted message from the index (SRC-02). The row itself stays in `messages` (EDT-04). */
export async function removeRedacted(tx: SqliteExecutor, messageId: string): Promise<void> {
	await tx.run("DELETE FROM messages_fts WHERE message_id = ?", messageId);
}

/** Add the user and assistant text a settled run produced (SRC-03). */
export async function indexSessionRun(tx: SqliteExecutor, run: SessionRun): Promise<void> {
	for (const entry of run.entries) {
		const text = entry.text.trim();
		if (!text) continue;
		await tx.run(
			"INSERT OR REPLACE INTO sessions_fts (rowid, body, session_id) VALUES (?, ?, ?)",
			stableRowId(`${run.sessionId}:${entry.id}`),
			text,
			run.sessionId,
		);
	}
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_53 = (1n << 53n) - 1n;

/**
 * A deterministic rowid for a transcript entry.
 *
 * `sessions_fts` has no entry-id column (DB-02), so re-indexing a settled run after a restart must
 * replace its rows instead of appending copies. Deriving the FTS5 rowid from the entry id does that
 * without a second mapping table. The value stays inside 53 bits, which a JavaScript number holds
 * exactly, and never hits rowid 0.
 */
function stableRowId(key: string): number {
	let hash = FNV_OFFSET;
	for (const byte of new TextEncoder().encode(key)) {
		hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & 0xffffffffffffffffn;
	}
	const value = Number(hash & MASK_53);
	return value === 0 ? 1 : value;
}
