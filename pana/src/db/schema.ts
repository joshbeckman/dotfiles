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
	{
		version: 3,
		name: "session cost ledger",
		// LIM-02 and LIM-03 need spend per session and per local day. pi-durable's `pi.usage` only
		// holds a running total per conversation, so pana records the total it last saw on the
		// session and adds each increase to the day it was seen.
		sql: `
			ALTER TABLE sessions ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0;

			CREATE TABLE domain_costs (
				day         TEXT PRIMARY KEY, -- YYYY-MM-DD in config.timezone
				cost_usd    REAL NOT NULL DEFAULT 0,
				noticed_at  INTEGER
			);
		`,
	},
	{
		version: 4,
		name: "thread archives",
		// REF-03: archiving is per participant, not per thread, so it is a side table rather than a
		// column on `threads`. A row means that one participant hid the thread from their own inbox
		// and default thread list; a later delivery deletes it again (REF-04).
		sql: `
			CREATE TABLE thread_archives (
				thread_id      TEXT NOT NULL REFERENCES threads(id),
				participant_id TEXT NOT NULL REFERENCES participants(id),
				archived_at    INTEGER NOT NULL,
				PRIMARY KEY (thread_id, participant_id)
			);
			CREATE INDEX thread_archives_participant ON thread_archives(participant_id);
		`,
	},
	{
		version: 5,
		name: "delivery lookups",
		// SCALE-03 and BENCH.md. Finding the delivery behind a session's submission (the auto-reply
		// and the failure notice) read every delivery of the session through
		// `deliveries_recipient`. Counting a reader's unread messages per thread (REF-05) did the
		// same once per listed thread, which made one page of /threads take 60 ms with 14,000
		// deliveries. The unread index is partial, so it holds only what is still unread.
		sql: `
			CREATE INDEX deliveries_recipient_submission ON deliveries(recipient_id, wake_submission_id);
			CREATE INDEX deliveries_recipient_unread ON deliveries(recipient_id, thread_id) WHERE read_at IS NULL;
		`,
	},
	{
		version: 6,
		name: "scratch removals",
		// SCR-06: the pana prompt section tells a session when the sweep removed its scratch.
		sql: `
			ALTER TABLE sessions ADD COLUMN scratch_removed_at INTEGER;
			ALTER TABLE sessions ADD COLUMN scratch_removed_bytes INTEGER;
		`,
	},
	{
		version: 7,
		name: "wake schedules",
		// WAK-01: a schedule can wake an existing session. SQLite cannot alter a CHECK, so the
		// table is rebuilt with the same columns and rows.
		sql: `
			CREATE TABLE schedules_new (
				id          TEXT PRIMARY KEY,
				kind        TEXT NOT NULL CHECK (kind IN ('session', 'thread', 'wake')),
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
			INSERT INTO schedules_new SELECT id, kind, state, cron, at, timezone, creator_id, payload, next_at, created_at, updated_at FROM schedules;
			DROP TABLE schedules;
			ALTER TABLE schedules_new RENAME TO schedules;
			CREATE INDEX schedules_state ON schedules(state, next_at);
		`,
	},
	{
		version: 8,
		name: "schedule conditions",
		sql: `
			ALTER TABLE schedules ADD COLUMN check_command TEXT;
			ALTER TABLE schedules ADD COLUMN check_cwd TEXT;
			ALTER TABLE schedules ADD COLUMN stop_after_success INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE schedules ADD COLUMN last_check TEXT;
			ALTER TABLE schedules ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
		`,
	},
	{
		version: 9,
		name: "schedule subjects",
		sql: `
			ALTER TABLE schedules ADD COLUMN subject TEXT;
			ALTER TABLE schedules ADD COLUMN subject_source TEXT CHECK (subject_source IN ('first-line', 'model', 'manual'));
		`,
	},
	{
		version: 10,
		name: "participant thread discovery",
		// SRC-04: sparse membership filters must page the participant's threads, not scan the domain.
		sql: `CREATE INDEX thread_participants_participant_thread ON thread_participants(participant_id, thread_id);`,
	},
];

/** The highest migration number the code knows how to apply. */
export const SCHEMA_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);
