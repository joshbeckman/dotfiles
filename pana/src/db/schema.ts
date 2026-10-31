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
	{
		version: 11,
		name: "notice recipient memberships",
		// Older notices could deliver to a user without joining them to an existing thread.
		// Restore inbox visibility without changing read state or per-user archives.
		sql: `
			INSERT OR IGNORE INTO thread_participants (thread_id, participant_id, joined_at, joined_message_id)
			SELECT d.thread_id, d.recipient_id, d.created_at, d.message_id
			  FROM deliveries d
			  JOIN participants recipient ON recipient.id = d.recipient_id AND recipient.kind = 'user'
			  JOIN messages m ON m.id = d.message_id
			  JOIN participants sender ON sender.id = m.sender_id AND sender.kind = 'domain'
			 WHERE NOT EXISTS (SELECT 1 FROM thread_participants tp
			                    WHERE tp.thread_id = d.thread_id AND tp.participant_id = d.recipient_id)
			 ORDER BY d.created_at, m.seq;
		`,
	},
	{
		version: 12,
		name: "objectives",
		// WP18 in one migration (OBJ-02): the objectives packages ship in parallel and none of them
		// may add a migration, so this holds every table and column the whole package needs.
		// `src/objectives/` owns them.
		//
		// Nothing that is a function of other rows is stored: `running`, `idle`, `stranded` (OBJ-03),
		// the budget conditions (OBJ-20..22), and `awaiting_user` (OBJ-33) are derived on read.
		sql: `
			CREATE TABLE IF NOT EXISTS objectives (
				id                       TEXT PRIMARY KEY,
				goal                     TEXT NOT NULL,
				phase                    TEXT NOT NULL CHECK (phase IN ('drafting', 'active', 'stopped', 'done', 'archived')),
				creator_id               TEXT NOT NULL, -- the user, or the session that proposed the draft
				proposed_by              TEXT REFERENCES sessions(id), -- OBJ-04: the session that proposed it
				-- OBJ-05: launch sets these with the phase, so an active objective always has exactly one lead.
				lead_id                  TEXT REFERENCES sessions(id),
				thread_id                TEXT REFERENCES threads(id), -- the objective's thread: the user and the lead
				due_at                   INTEGER,
				autonomy                 TEXT NOT NULL DEFAULT 'manual' CHECK (autonomy IN ('manual', 'auto')),
				max_daily_usd            REAL,
				max_total_usd            REAL,
				wake_min_minutes         INTEGER,
				max_daily_lead_turns     INTEGER,
				max_daily_user_messages  INTEGER,
				max_active_members       INTEGER,
				charter_rev              INTEGER NOT NULL DEFAULT 0,
				-- OBJ-06 and OBJ-08: when the stranded and behind notices last posted, so neither
				-- repeats until the objective moves again. A notice record, not a state.
				stranded_noticed_at      INTEGER,
				behind_noticed_at        INTEGER,
				created_at               INTEGER NOT NULL,
				updated_at               INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS objectives_phase ON objectives(phase, created_at);
			CREATE INDEX IF NOT EXISTS objectives_creator ON objectives(creator_id, created_at);

			-- OBJ-09: append-only. The charter is the newest revision of each section.
			CREATE TABLE IF NOT EXISTS objective_charter_revisions (
				id            TEXT PRIMARY KEY,
				objective_id  TEXT NOT NULL REFERENCES objectives(id),
				rev           INTEGER NOT NULL,
				section       TEXT NOT NULL CHECK (section IN ('Scope', 'Cancel', 'Done', 'Guidance', 'Escalation', 'Notes')),
				body          TEXT NOT NULL,
				created_by    TEXT NOT NULL,
				created_at    INTEGER NOT NULL,
				UNIQUE (objective_id, rev)
			);
			CREATE INDEX IF NOT EXISTS objective_charter_section ON objective_charter_revisions(objective_id, section, rev);

			-- OBJ-25/26: one row per metric, with its optional check in the SCH-10 shape.
			-- check_command and window_spec steer clear of SQLite's CHECK and WINDOW keywords.
			CREATE TABLE IF NOT EXISTS objective_metrics (
				objective_id   TEXT NOT NULL REFERENCES objectives(id),
				name           TEXT NOT NULL,
				unit           TEXT NOT NULL,
				direction      TEXT NOT NULL CHECK (direction IN ('up', 'down')),
				target         REAL,
				aggregation    TEXT NOT NULL DEFAULT 'raw' CHECK (aggregation IN ('raw', 'mean')),
				window_spec    TEXT,
				check_command  TEXT,
				check_cwd      TEXT,
				check_every    TEXT,
				check_cron     TEXT,
				next_check_at  INTEGER,
				last_check     TEXT,
				frozen_at      INTEGER, -- OBJ-29: set by the first reading
				created_at     INTEGER NOT NULL,
				PRIMARY KEY (objective_id, name)
			);
			CREATE INDEX IF NOT EXISTS objective_metrics_checks ON objective_metrics(next_check_at) WHERE next_check_at IS NOT NULL;

			-- OBJ-25/27: append-only readings; no code path issues UPDATE or DELETE.
			CREATE TABLE IF NOT EXISTS metric_readings (
				id            TEXT PRIMARY KEY,
				objective_id  TEXT NOT NULL REFERENCES objectives(id),
				name          TEXT NOT NULL,
				at            INTEGER NOT NULL,
				value         REAL NOT NULL,
				source        TEXT NOT NULL CHECK (source IN ('lead', 'user', 'check'))
			);
			CREATE INDEX IF NOT EXISTS metric_readings_metric ON metric_readings(objective_id, name, at);

			-- OBJ-30: a report is a thread message plus this row, so reports keep revisions, redaction,
			-- deliveries, push, and FTS rather than starting a second append-only log.
			CREATE TABLE IF NOT EXISTS objective_reports (
				objective_id  TEXT NOT NULL REFERENCES objectives(id),
				message_id    TEXT NOT NULL REFERENCES messages(id),
				created_at    INTEGER NOT NULL,
				PRIMARY KEY (objective_id, message_id)
			);

			-- OBJ-31: an artifact is an uploaded file plus this row; unlinking never deletes the file.
			CREATE TABLE IF NOT EXISTS objective_files (
				objective_id  TEXT NOT NULL REFERENCES objectives(id),
				file_id       TEXT NOT NULL REFERENCES files(id),
				created_at    INTEGER NOT NULL,
				PRIMARY KEY (objective_id, file_id)
			);

			-- OBJ-23: every held or refused run records why. Append-only.
			CREATE TABLE IF NOT EXISTS objective_events (
				id            TEXT PRIMARY KEY,
				objective_id  TEXT NOT NULL REFERENCES objectives(id),
				at            INTEGER NOT NULL,
				kind          TEXT NOT NULL,
				detail        TEXT NOT NULL DEFAULT '{}',
				actor_id      TEXT
			);
			CREATE INDEX IF NOT EXISTS objective_events_objective ON objective_events(objective_id, at);

			-- OBJ-33/34: an escalation names its scope; a NULL member_id holds the whole objective.
			CREATE TABLE IF NOT EXISTS objective_escalations (
				id            TEXT PRIMARY KEY,
				objective_id  TEXT NOT NULL REFERENCES objectives(id),
				member_id     TEXT REFERENCES sessions(id),
				thread_id     TEXT REFERENCES threads(id),
				message_id    TEXT REFERENCES messages(id),
				state         TEXT NOT NULL CHECK (state IN ('open', 'cleared')),
				timeout_at    INTEGER,
				cleared_at    INTEGER,
				created_at    INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS objective_escalations_open ON objective_escalations(objective_id, state);

			-- OBJ-20/21: the local-day ledger domain_costs keeps, per objective. maxTotalUsd reads
			-- it as a lifetime sum.
			CREATE TABLE IF NOT EXISTS objective_costs (
				day           TEXT NOT NULL, -- YYYY-MM-DD in config.timezone
				objective_id  TEXT NOT NULL REFERENCES objectives(id),
				cost_usd      REAL NOT NULL DEFAULT 0,
				noticed_at    INTEGER,
				PRIMARY KEY (day, objective_id)
			);

			-- OBJ-15: objective_id, inherited at create the way depth is. OBJ-14: who stopped a
			-- member. OBJ-18: hold_until on the lead.
			--
			-- SQLite cannot add a column twice, and a migration is re-runnable (DB-03), so the table
			-- is rebuilt with the same rows rather than altered, as migration 7 rebuilt schedules.
			CREATE TABLE sessions_new (
				id                      TEXT PRIMARY KEY REFERENCES participants(id),
				conversation_id         INTEGER UNIQUE, -- pi-durable ConversationId (a number)
				state                   TEXT NOT NULL,
				parent                  TEXT REFERENCES sessions_new(id),
				depth                   INTEGER NOT NULL DEFAULT 0,
				model                   TEXT,
				thinking                TEXT,
				profile                 TEXT,
				cwd                     TEXT,
				created_at              INTEGER NOT NULL,
				updated_at              INTEGER NOT NULL,
				cost_usd                REAL NOT NULL DEFAULT 0,
				scratch_removed_at      INTEGER,
				scratch_removed_bytes   INTEGER,
				objective_id            TEXT REFERENCES objectives(id),
				stopped_by              TEXT CHECK (stopped_by IN ('user', 'objective')),
				hold_until              INTEGER
			);
			INSERT INTO sessions_new (id, conversation_id, state, parent, depth, model, thinking, profile, cwd,
			                          created_at, updated_at, cost_usd, scratch_removed_at, scratch_removed_bytes)
				SELECT id, conversation_id, state, parent, depth, model, thinking, profile, cwd,
				       created_at, updated_at, cost_usd, scratch_removed_at, scratch_removed_bytes
				  FROM sessions;
			DROP TABLE sessions;
			ALTER TABLE sessions_new RENAME TO sessions;
			CREATE INDEX IF NOT EXISTS sessions_state ON sessions(state);
			CREATE INDEX IF NOT EXISTS sessions_parent ON sessions(parent);
			CREATE INDEX IF NOT EXISTS sessions_objective ON sessions(objective_id);
		`,
	},
];

/** The highest migration number the code knows how to apply. */
export const SCHEMA_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);
