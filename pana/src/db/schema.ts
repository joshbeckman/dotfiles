// Pana table definitions (DB-02). These live in the same SQLite file as pi-durable's
// `pi_`-prefixed tables (DB-01), so a pana write and the pi-durable write it causes share
// one connection and can commit together through one adapter transaction (DB-04).
//
// Migrations are numbered and idempotent (DB-03). Each migration is one SQL string applied
// inside a transaction when `PRAGMA user_version` is below its number. pi-durable does not
// use `user_version`, so pana owns it. Add a new migration to the end of this list; never
// edit or renumber an existing one.

export interface Migration {
	version: number;
	name: string;
	sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
	{
		version: 1,
		name: "initial",
		sql: `
			CREATE TABLE participants (
				id          TEXT PRIMARY KEY,
				kind        TEXT NOT NULL CHECK (kind IN ('user', 'session', 'domain')),
				url         TEXT NOT NULL UNIQUE,
				created_at  INTEGER NOT NULL
			);

			CREATE TABLE sessions (
				id              TEXT PRIMARY KEY REFERENCES participants(id),
				conversation_id INTEGER UNIQUE, -- pi-durable ConversationId (a number)
				state           TEXT NOT NULL,
				parent          TEXT REFERENCES sessions(id),
				depth           INTEGER NOT NULL DEFAULT 0,
				model           TEXT,
				thinking        TEXT,
				profile         TEXT,
				cwd             TEXT,
				created_at      INTEGER NOT NULL,
				updated_at      INTEGER NOT NULL
			);
			CREATE INDEX sessions_state ON sessions(state);
			CREATE INDEX sessions_parent ON sessions(parent);

			CREATE TABLE threads (
				id          TEXT PRIMARY KEY,
				subject     TEXT,
				created_by  TEXT NOT NULL,
				created_at  INTEGER NOT NULL
			);

			CREATE TABLE thread_participants (
				thread_id         TEXT NOT NULL REFERENCES threads(id),
				participant_id    TEXT NOT NULL REFERENCES participants(id),
				joined_at         INTEGER NOT NULL,
				joined_message_id TEXT,
				PRIMARY KEY (thread_id, participant_id)
			);

			CREATE TABLE messages (
				id          TEXT PRIMARY KEY,
				thread_id   TEXT NOT NULL REFERENCES threads(id),
				seq         INTEGER NOT NULL,
				sender_id   TEXT NOT NULL REFERENCES participants(id),
				body        TEXT NOT NULL,
				created_at  INTEGER NOT NULL,
				UNIQUE (thread_id, seq)
			);
			CREATE INDEX messages_thread ON messages(thread_id, seq);

			CREATE TABLE message_events (
				id          TEXT PRIMARY KEY,
				message_id  TEXT NOT NULL REFERENCES messages(id),
				kind        TEXT NOT NULL CHECK (kind IN ('message.revised', 'message.redacted')),
				body        TEXT,
				created_by  TEXT NOT NULL,
				created_at  INTEGER NOT NULL
			);
			CREATE INDEX message_events_message ON message_events(message_id, created_at);

			CREATE TABLE deliveries (
				id                 TEXT PRIMARY KEY,
				message_id         TEXT NOT NULL REFERENCES messages(id),
				thread_id          TEXT NOT NULL REFERENCES threads(id),
				recipient_id       TEXT NOT NULL REFERENCES participants(id),
				created_at         INTEGER NOT NULL,
				read_at            INTEGER,
				-- Outbox columns for the atomic wake (DB-04). A delivery that must wake a
				-- session carries a deterministic pi-durable request id; the sweeper submits
				-- it and records the resulting submission id. Idempotent on restart.
				wake_request_id    TEXT,
				wake_submission_id INTEGER, -- pi-durable SubmissionId (a number)
				UNIQUE (message_id, recipient_id)
			);
			CREATE INDEX deliveries_recipient ON deliveries(recipient_id, created_at);
			CREATE INDEX deliveries_pending_wake
				ON deliveries(wake_request_id)
				WHERE wake_request_id IS NOT NULL AND wake_submission_id IS NULL;

			CREATE TABLE files (
				id          TEXT PRIMARY KEY,
				name        TEXT NOT NULL,
				path        TEXT NOT NULL,
				size        INTEGER NOT NULL,
				media_type  TEXT,
				uploader_id TEXT NOT NULL REFERENCES participants(id),
				created_at  INTEGER NOT NULL
			);

			CREATE TABLE schedules (
				id          TEXT PRIMARY KEY,
				kind        TEXT NOT NULL CHECK (kind IN ('session', 'thread')),
				state       TEXT NOT NULL CHECK (state IN ('active', 'done', 'missed', 'deleted')),
				cron        TEXT,
				at          INTEGER,
				timezone    TEXT,
				creator_id  TEXT NOT NULL REFERENCES participants(id),
				payload     TEXT NOT NULL,
				next_at     INTEGER,
				created_at  INTEGER NOT NULL,
				updated_at  INTEGER NOT NULL
			);
			CREATE INDEX schedules_state ON schedules(state, next_at);

			CREATE TABLE push_subscriptions (
				id             TEXT PRIMARY KEY,
				participant_id TEXT NOT NULL REFERENCES participants(id),
				endpoint       TEXT NOT NULL UNIQUE,
				p256dh         TEXT NOT NULL,
				auth           TEXT NOT NULL,
				created_at     INTEGER NOT NULL
			);

			CREATE TABLE subjects (
				id          TEXT PRIMARY KEY,
				thread_id   TEXT NOT NULL REFERENCES threads(id),
				subject     TEXT NOT NULL,
				source      TEXT NOT NULL CHECK (source IN ('first-line', 'model', 'manual')),
				created_at  INTEGER NOT NULL
			);
			CREATE INDEX subjects_thread ON subjects(thread_id, created_at);

			CREATE VIRTUAL TABLE messages_fts USING fts5(
				body,
				message_id UNINDEXED,
				thread_id UNINDEXED
			);

			CREATE VIRTUAL TABLE sessions_fts USING fts5(
				body,
				session_id UNINDEXED
			);
		`,
	},
	{
		version: 2,
		name: "subject search index",
		// DB-02 lists FTS5 tables for messages and session transcripts only, so thread search
		// (SRC-01) has nowhere to match subjects. This adds the one missing index rather than
		// editing migration 1, which has shipped.
		sql: `
			CREATE VIRTUAL TABLE subjects_fts USING fts5(
				subject,
				thread_id UNINDEXED
			);
		`,
	},
];

/** The highest migration number the code knows how to apply. */
export const SCHEMA_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);
