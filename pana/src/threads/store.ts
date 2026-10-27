// The thread, message, delivery, inbox, and notice store (THR, EDT, INB, NTC).
//
// Every write runs through `runtime.db.atomically`, so the head check, the message insert, its
// deliveries, and the wake hook share one serialized transaction. That is what makes THR-07 hold:
// two concurrent responds both check the head inside their own transaction, and the second one
// sees the first one's append.
//
// `messages` is append-only (EDT-04). Readers compute the current body from the newest
// `message_events` row; the original text stays in `messages.body` and every revision in
// `message_events`.

import type { SqliteExecutor } from "@earendil-works/chord/sqlite";
import { ApiError } from "../api/errors.ts";
import type { Caller } from "../api/types.ts";
import { decodeCursor, pageOf } from "../api/pagination.ts";
import { wakeRequestId } from "../db/outbox.ts";
import { isUlid, parseRef, RefError } from "../ids/index.ts";
import {
	applyInitialSubject,
	indexMessage,
	recordSubject,
	reindexRevision,
	removeRedacted,
	scheduleSubject,
} from "../search/index.ts";
import type { Runtime } from "../server/runtime.ts";
import { sessionStates, workingSessions, type SessionState, type WorkingSession } from "../sessions/state.ts";
import { liveActivities } from "../sessions/live.ts";
import { announce } from "./announce.ts";
import { deliveryHooks } from "./delivery.ts";

export type ParticipantKind = "user" | "session" | "domain";

export interface ParticipantRecord {
	id: string;
	kind: ParticipantKind;
	url: string;
	created_at: number;
}

export interface ThreadRecord {
	id: string;
	subject: string | null;
	created_by: string;
	created_at: number;
}

export interface MessageRecord {
	id: string;
	thread_id: string;
	seq: number;
	sender_id: string;
	body: string;
	created_at: number;
}

export interface FileRecord {
	id: string;
	name: string;
	path: string;
	size: number;
	media_type: string | null;
	uploader_id: string;
	created_at: number;
}

export interface PersonView {
	id: string;
	kind: ParticipantKind;
	url: string;
}

export interface ParticipantView extends PersonView {
	joinedAt: number;
	joinedMessageId: string | null;
	/** A session's current state; absent for the user and the domain (UX-09). */
	state?: SessionState;
	/** What a working session is doing now, e.g. "running bash", and since when (UX-12). */
	activity?: { activity: string; since?: number; at: number };
}

export interface MessageView {
	id: string;
	url: string;
	threadId: string;
	threadUrl: string;
	seq: number;
	sender: PersonView;
	createdAt: number;
	/** The current body. Absent on a redacted message (EDT-03). */
	body?: string;
	revised: boolean;
	redacted: boolean;
	/** `[redacted]` for a redacted message, so a renderer has something to show. */
	display?: string;
	/** The reader's delivery read time, when the reader received the message. */
	readAt?: number | null;
}

export interface ThreadView {
	id: string;
	url: string;
	subject: string | null;
	createdBy: PersonView;
	createdAt: number;
	participants: ParticipantView[];
}

export interface ArchiveState {
	thread: ThreadView;
	/** True when the caller has this thread archived (REF-03). */
	archived: boolean;
	participant: PersonView;
}

export interface InboxRecipient {
	id: string;
	kind: ParticipantKind;
	url: string;
	readAt: number | null;
}

export interface InboxDelivery {
	id: string;
	messageId: string;
	messageUrl: string;
	threadId: string;
	threadUrl: string;
	subject: string | null;
	sender: PersonView;
	recipients: InboxRecipient[];
	createdAt: number;
	deliveredAt: number;
	readAt: number | null;
	body?: string;
	revised: boolean;
	redacted: boolean;
	display?: string;
	/** The reader's unread messages in this thread (REF-05). */
	unreadCount: number;
}

export interface ThreadResult {
	thread: ThreadView;
	message: MessageView;
}

interface MessageRowWithSender extends MessageRecord {
	sender_url: string;
	sender_kind: ParticipantKind;
}

interface DeliveryRecipientRow {
	id: string;
	kind: ParticipantKind;
	url: string;
	conversation_id: number | null;
	state: string | null;
}

interface MessageEventRow {
	message_id: string;
	kind: string;
	body: string | null;
}

// --- Input parsing -------------------------------------------------------------

export interface CreateThreadInput {
	to?: unknown;
	body?: unknown;
	subject?: unknown;
}

export interface RespondInput {
	after?: unknown;
	body?: unknown;
	cc?: unknown;
}

/** A comma-separated string or an array of them, trimmed. Anything else is a 400. */
export function addressList(value: unknown, field = "addresses"): string[] {
	if (value === undefined || value === null) return [];
	const parts: unknown[] = Array.isArray(value) ? value : [value];
	const out: string[] = [];
	for (const part of parts) {
		if (typeof part !== "string") throw ApiError.badRequest(`invalid_${field}`, `${field} must be strings`);
		for (const piece of part.split(",")) {
			const trimmed = piece.trim();
			if (trimmed.length > 0) out.push(trimmed);
		}
	}
	return out;
}

export function messageBody(value: unknown): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw ApiError.badRequest("invalid_body", "a message needs a non-empty body");
	}
	return value;
}

/** A `--after` value: a bare message ULID or a message URL. Missing is a 400 (THR-03). */
function messageRefId(runtime: Runtime, value: unknown): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw ApiError.badRequest("missing_after", "respond requires --after MESSAGE");
	}
	const text = value.trim();
	if (isUlid(text)) return text;
	try {
		const ref = parseRef(text, runtime.config.domain);
		if (ref.kind === "message") return ref.id;
	} catch (error) {
		if (error instanceof RefError) throw ApiError.badRequest(error.code, error.message);
		throw error;
	}
	throw ApiError.badRequest("invalid_after", `--after must name a message, got ${text}`);
}

// --- Participants --------------------------------------------------------------

async function ensureUser(tx: SqliteExecutor, runtime: Runtime, now: number, username: string): Promise<ParticipantRecord> {
	const url = runtime.url({ kind: "user", id: username });
	await tx.run("INSERT OR IGNORE INTO participants (id, kind, url, created_at) VALUES (?, 'user', ?, ?)", username, url, now);
	return { id: username, kind: "user", url, created_at: now };
}

async function ensureDomain(tx: SqliteExecutor, runtime: Runtime, now: number): Promise<ParticipantRecord> {
	const id = runtime.config.domain;
	await tx.run("INSERT OR IGNORE INTO participants (id, kind, url, created_at) VALUES (?, 'domain', ?, ?)", id, runtime.domainUrl, now);
	return { id, kind: "domain", url: runtime.domainUrl, created_at: now };
}

async function ensureCaller(tx: SqliteExecutor, runtime: Runtime, now: number, caller: Caller): Promise<ParticipantRecord> {
	if (caller.kind === "user") return ensureUser(tx, runtime, now, caller.id);
	const existing = await tx.get<ParticipantRecord>("SELECT * FROM participants WHERE id = ?", caller.id);
	if (existing) return existing;
	const url = runtime.url({ kind: "session", id: caller.id });
	await tx.run("INSERT INTO participants (id, kind, url, created_at) VALUES (?, 'session', ?, ?)", caller.id, url, now);
	return { id: caller.id, kind: "session", url, created_at: now };
}

/**
 * Resolve one address to an existing participant. Users are created on demand; a session must
 * already exist. A thread, file, or schedule URL is not a participant address.
 */
async function participantFor(tx: SqliteExecutor, runtime: Runtime, now: number, raw: string): Promise<ParticipantRecord> {
	let ref;
	try {
		ref = parseRef(raw, runtime.config.domain);
	} catch (error) {
		if (error instanceof RefError) throw ApiError.badRequest(error.code, error.message);
		throw error;
	}
	if (ref.kind === "user") return ensureUser(tx, runtime, now, ref.id);
	if (ref.kind !== "session") {
		throw ApiError.badRequest("invalid_recipient", `${raw} is not a participant address`);
	}
	const session = await tx.get<{ id: string }>("SELECT id FROM sessions WHERE id = ?", ref.id);
	if (!session) throw ApiError.notFound(`session ${ref.id}`);
	const existing = await tx.get<ParticipantRecord>("SELECT * FROM participants WHERE id = ?", ref.id);
	if (existing) return existing;
	const url = runtime.url(ref);
	await tx.run("INSERT INTO participants (id, kind, url, created_at) VALUES (?, 'session', ?, ?)", ref.id, url, now);
	return { id: ref.id, kind: "session", url, created_at: now };
}

async function threadParticipants(tx: SqliteExecutor, threadId: string): Promise<ParticipantView[]> {
	const rows = await tx.all<{
		id: string;
		kind: ParticipantKind;
		url: string;
		joined_at: number;
		joined_message_id: string | null;
	}>(
		`SELECT p.id AS id, p.kind AS kind, p.url AS url, tp.joined_at AS joined_at,
		        tp.joined_message_id AS joined_message_id
		   FROM thread_participants tp
		   JOIN participants p ON p.id = tp.participant_id
		  WHERE tp.thread_id = ?
		  ORDER BY tp.joined_at, p.id`,
		threadId,
	);
	return rows.map((row) => ({
		id: row.id,
		kind: row.kind,
		url: row.url,
		joinedAt: row.joined_at,
		joinedMessageId: row.joined_message_id,
	}));
}

async function person(tx: SqliteExecutor, id: string): Promise<PersonView> {
	const row = await tx.get<ParticipantRecord>("SELECT * FROM participants WHERE id = ?", id);
	if (!row) throw new Error(`participant ${id} is missing`);
	return { id: row.id, kind: row.kind, url: row.url };
}

async function threadView(tx: SqliteExecutor, runtime: Runtime, threadId: string): Promise<ThreadView> {
	const thread = await tx.get<ThreadRecord>("SELECT * FROM threads WHERE id = ?", threadId);
	if (!thread) throw ApiError.notFound(`thread ${threadId}`);
	return {
		id: thread.id,
		url: runtime.url({ kind: "thread", id: thread.id }),
		subject: thread.subject,
		createdBy: await person(tx, thread.created_by),
		createdAt: thread.created_at,
		participants: await threadParticipants(tx, thread.id),
	};
}

// --- Message views -------------------------------------------------------------

async function latestEvents(tx: SqliteExecutor, ids: readonly string[]): Promise<Map<string, MessageEventRow>> {
	const latest = new Map<string, MessageEventRow>();
	if (ids.length === 0) return latest;
	const placeholders = ids.map(() => "?").join(",");
	const rows = await tx.all<MessageEventRow>(
		`SELECT message_id, kind, body FROM message_events
		  WHERE message_id IN (${placeholders})
		  ORDER BY created_at, id`,
		...ids,
	);
	for (const row of rows) latest.set(row.message_id, row);
	return latest;
}

function applyEvent(body: string | null, event: MessageEventRow | undefined): Pick<MessageView, "body" | "revised" | "redacted" | "display"> {
	if (event?.kind === "message.redacted") return { redacted: true, revised: false, display: "[redacted]" };
	if (event?.kind === "message.revised") return { body: event.body ?? undefined, revised: true, redacted: false };
	return { body: body ?? undefined, revised: false, redacted: false };
}

async function readTimes(tx: SqliteExecutor, readerId: string | undefined, ids: readonly string[]): Promise<Map<string, number | null>> {
	const times = new Map<string, number | null>();
	if (!readerId || ids.length === 0) return times;
	const placeholders = ids.map(() => "?").join(",");
	const rows = await tx.all<{ message_id: string; read_at: number | null }>(
		`SELECT message_id, read_at FROM deliveries WHERE recipient_id = ? AND message_id IN (${placeholders})`,
		readerId,
		...ids,
	);
	for (const row of rows) times.set(row.message_id, row.read_at);
	return times;
}

async function messageViews(
	tx: SqliteExecutor,
	runtime: Runtime,
	rows: readonly MessageRowWithSender[],
	readerId?: string,
): Promise<MessageView[]> {
	const ids = rows.map((row) => row.id);
	const events = await latestEvents(tx, ids);
	const read = await readTimes(tx, readerId, ids);
	return rows.map((row) => {
		const view: MessageView = {
			id: row.id,
			url: runtime.url({ kind: "message", id: row.id, thread: row.thread_id }),
			threadId: row.thread_id,
			threadUrl: runtime.url({ kind: "thread", id: row.thread_id }),
			seq: row.seq,
			sender: { id: row.sender_id, kind: row.sender_kind, url: row.sender_url },
			createdAt: row.created_at,
			...applyEvent(row.body, events.get(row.id)),
		};
		if (read.has(row.id)) view.readAt = read.get(row.id) ?? null;
		return view;
	});
}

async function messageRow(tx: SqliteExecutor, messageId: string): Promise<MessageRowWithSender> {
	const row = await tx.get<MessageRowWithSender>(
		`SELECT m.*, p.url AS sender_url, p.kind AS sender_kind
		   FROM messages m JOIN participants p ON p.id = m.sender_id
		  WHERE m.id = ?`,
		messageId,
	);
	if (!row) throw ApiError.notFound(`message ${messageId}`);
	return row;
}

async function messageView(tx: SqliteExecutor, runtime: Runtime, messageId: string, readerId?: string): Promise<MessageView> {
	return (await messageViews(tx, runtime, [await messageRow(tx, messageId)], readerId))[0]!;
}

// --- Append and deliver --------------------------------------------------------

interface AppendOptions {
	messageId: string;
	threadId: string;
	sender: ParticipantRecord;
	body: string;
	now: number;
	/** Collects the URL of every recipient, for `announce` after the transaction commits. */
	recipients?: string[];
}

/**
 * Insert one message and its deliveries. `messageId` is chosen by the caller so `--cc` rows can
 * record it as their `joined_message_id` (THR-08). The wake hook runs inside the caller's
 * transaction for every delivery row.
 */
async function appendMessage(tx: SqliteExecutor, runtime: Runtime, options: AppendOptions): Promise<MessageView> {
	const seq = (await tx.get<{ seq: number }>("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages WHERE thread_id = ?", options.threadId))!.seq;
	await tx.run(
		"INSERT INTO messages (id, thread_id, seq, sender_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)",
		options.messageId,
		options.threadId,
		seq,
		options.sender.id,
		options.body,
		options.now,
	);
	await indexMessage(tx, { id: options.messageId, threadId: options.threadId, body: options.body });

	const recipients = await tx.all<DeliveryRecipientRow>(
		`SELECT tp.participant_id AS id, p.kind AS kind, p.url AS url,
		        s.conversation_id AS conversation_id, s.state AS state
		   FROM thread_participants tp
		   JOIN participants p ON p.id = tp.participant_id
		   LEFT JOIN sessions s ON s.id = tp.participant_id
		  WHERE tp.thread_id = ? AND tp.participant_id <> ?
		  ORDER BY tp.joined_at, p.id`,
		options.threadId,
		options.sender.id,
	);

	const hooks = deliveryHooks(runtime);
	for (const recipient of recipients) {
		const deliveryId = runtime.newId();
		const requestId =
			recipient.kind === "session" && recipient.conversation_id !== null && wakeable(recipient.state)
				? wakeRequestId(deliveryId)
				: null;
		await tx.run(
			"INSERT INTO deliveries (id, message_id, thread_id, recipient_id, created_at, wake_request_id) VALUES (?, ?, ?, ?, ?, ?)",
			deliveryId,
			options.messageId,
			options.threadId,
			recipient.id,
			options.now,
			requestId,
		);
		options.recipients?.push(recipient.url);
		// REF-04: new mail shows the thread again for the participant who receives it.
		await setThreadArchived(tx, options.threadId, recipient.id, false, options.now);
		await hooks.onDelivered(
			tx,
			{
				deliveryId,
				messageId: options.messageId,
				threadId: options.threadId,
				recipientId: recipient.id,
				recipientKind: recipient.kind,
				senderKind: options.sender.kind,
				requestId,
				sessionState: recipient.state ?? undefined,
			},
			runtime,
		);
	}

	return messageView(tx, runtime, options.messageId, options.sender.id);
}

/**
 * A stopped or archived session queues mail but does not wake (DLV-06). Everything else wakes,
 * as long as it has a pi-durable conversation to submit to.
 */
function wakeable(state: string | null): boolean {
	return state !== null && state !== "stopped" && state !== "archived";
}

// --- Threads -------------------------------------------------------------------

export async function createThread(runtime: Runtime, caller: Caller, input: CreateThreadInput): Promise<ThreadResult> {
	const body = messageBody(input.body);
	const addresses = addressList(input.to, "recipients");
	const now = runtime.clock.now();
	const explicitSubject = typeof input.subject === "string" && input.subject.trim().length > 0;

	const recipients: string[] = [];
	const result = await runtime.db.atomically(async (tx) => {
		const sender = await ensureCaller(tx, runtime, now, caller);
		const members = new Map<string, ParticipantRecord>([[sender.id, sender]]);
		for (const raw of addresses) {
			const resolved = await participantFor(tx, runtime, now, raw);
			members.set(resolved.id, resolved);
		}

		const threadId = runtime.newId();
		await tx.run("INSERT INTO threads (id, subject, created_by, created_at) VALUES (?, NULL, ?, ?)", threadId, sender.id, now);
		for (const member of members.values()) {
			await tx.run("INSERT INTO thread_participants (thread_id, participant_id, joined_at) VALUES (?, ?, ?)", threadId, member.id, now);
		}

		const message = await appendMessage(tx, runtime, {
			messageId: runtime.newId(),
			threadId,
			sender,
			body,
			now,
			recipients,
		});
		if (explicitSubject) {
			await recordSubject(tx, { threadId, subject: input.subject as string, source: "manual", id: runtime.newId(), now });
		} else {
			await applyInitialSubject(tx, { threadId, body, id: runtime.newId(), now });
		}
		return { thread: await threadView(tx, runtime, threadId), message };
	});
	announce(runtime, "delivery", result, recipients);
	// SUB-02: the model job runs in the background, after the create transaction commits.
	scheduleSubject(runtime, result.thread.id);
	return result;
}

/**
 * Append a message after a known head (THR-03..THR-09). The membership, head, cc, and insert
 * checks all run in the same serialized transaction, so a concurrent respond either sees the
 * new head and gets 409, or comes first.
 */
export async function respond(runtime: Runtime, caller: Caller, threadId: string, input: RespondInput): Promise<ThreadResult> {
	const afterId = messageRefId(runtime, input.after);
	const body = messageBody(input.body);
	const cc = addressList(input.cc, "cc");
	const now = runtime.clock.now();
	const recipients: string[] = [];

	const result = await runtime.db.atomically(async (tx) => {
		const thread = await tx.get<ThreadRecord>("SELECT * FROM threads WHERE id = ?", threadId);
		if (!thread) throw ApiError.notFound(`thread ${threadId}`);

		const sender = await ensureCaller(tx, runtime, now, caller);
		const member = await tx.get("SELECT 1 FROM thread_participants WHERE thread_id = ? AND participant_id = ?", threadId, sender.id);
		if (!member) {
			if (caller.kind !== "user") {
				throw ApiError.forbidden(`session ${sender.id} is not a participant of thread ${threadId}`);
			}
			await tx.run("INSERT INTO thread_participants (thread_id, participant_id, joined_at) VALUES (?, ?, ?)", threadId, sender.id, now);
		}

		const after = await tx.get<MessageRecord>("SELECT * FROM messages WHERE id = ?", afterId);
		if (!after) throw ApiError.notFound(`message ${afterId}`);
		if (after.thread_id !== threadId) {
			throw ApiError.badRequest("wrong_thread", `message ${afterId} is not in thread ${threadId}`);
		}
		const head = (await tx.get<{ seq: number }>("SELECT COALESCE(MAX(seq), 0) AS seq FROM messages WHERE thread_id = ?", threadId))!.seq;
		if (after.seq < head) {
			const newer = await tx.all<{ id: string }>("SELECT id FROM messages WHERE thread_id = ? AND seq > ? ORDER BY seq", threadId, after.seq);
			throw ApiError.stale(`thread ${threadId} moved`, {
				thread: threadId,
				after: afterId,
				newer: newer.map((row) => row.id),
			});
		}

		const messageId = runtime.newId();
		for (const raw of cc) {
			const added = await participantFor(tx, runtime, now, raw);
			await tx.run(
				"INSERT OR IGNORE INTO thread_participants (thread_id, participant_id, joined_at, joined_message_id) VALUES (?, ?, ?, ?)",
				threadId,
				added.id,
				now,
				messageId,
			);
		}

		const message = await appendMessage(tx, runtime, { messageId, threadId, sender, body, now, recipients });
		return { thread: await threadView(tx, runtime, threadId), message };
	});
	announce(runtime, "delivery", result, recipients);
	return result;
}

/** Resolve who is reading: the caller, or a named participant the user is allowed to act for. */
async function readerFor(tx: SqliteExecutor, runtime: Runtime, caller: Caller, participant: string | undefined, now: number): Promise<ParticipantRecord> {
	if (participant === undefined || participant === "") {
		return ensureCaller(tx, runtime, now, caller);
	}
	const target = await participantFor(tx, runtime, now, participant);
	if (caller.kind !== "user" && target.id !== caller.id) {
		throw ApiError.forbidden("a session may only read its own inbox");
	}
	return target;
}

async function markThreadRead(tx: SqliteExecutor, readerId: string, threadId: string, now: number): Promise<void> {
	await tx.run(
		"UPDATE deliveries SET read_at = ? WHERE recipient_id = ? AND thread_id = ? AND read_at IS NULL",
		now,
		readerId,
		threadId,
	);
}

/**
 * THR-10: messages in order with current revisions, and the caller's deliveries marked read.
 * UX-09: each session participant carries its current state, so an opened thread shows who is
 * working before any event arrives. The state is read after the transaction, because it needs
 * the harness inspection that tells a sleeping run from a busy one (STA-03).
 */
export async function readThread(
	runtime: Runtime,
	caller: Caller,
	threadId: string,
): Promise<{ thread: ThreadView; messages: MessageView[]; archived: boolean; canArchive: boolean }> {
	const now = runtime.clock.now();
	const read = await runtime.db.atomically(async (tx) => {
		const thread = await threadView(tx, runtime, threadId);
		const reader = await ensureCaller(tx, runtime, now, caller);
		// THR-11: reading by reference does not require (or grant) participation.
		const rows = await tx.all<MessageRowWithSender>(
			`SELECT m.*, p.url AS sender_url, p.kind AS sender_kind
			   FROM messages m JOIN participants p ON p.id = m.sender_id
			  WHERE m.thread_id = ?
			  ORDER BY m.seq`,
			threadId,
		);
		const archived = await isThreadArchived(tx, threadId, reader.id);
		await markThreadRead(tx, reader.id, threadId, now);
		return {
			thread,
			messages: await messageViews(tx, runtime, rows, reader.id),
			archived,
			canArchive: thread.participants.some((participant) => participant.id === reader.id),
		};
	});
	const sessions = read.thread.participants.filter((participant) => participant.kind === "session");
	const states = await sessionStates(runtime.db, runtime, sessions.map((participant) => participant.id));
	const working = sessions.map((participant) => participant.id).filter((id) => states.get(id) === "running" || states.get(id) === "waiting");
	const activities =
		working.length === 0
			? new Map()
			: await liveActivities(
					runtime,
					await runtime.db.all<{ id: string; conversationId: number | null }>(
						`SELECT id, conversation_id AS conversationId FROM sessions WHERE id IN (${working.map(() => "?").join(",")})`,
						...working,
					),
				);
	const participants = read.thread.participants.map((participant) => {
		if (participant.kind !== "session" || !states.has(participant.id)) return participant;
		const activity = activities.get(participant.id);
		return { ...participant, state: states.get(participant.id)!, ...(activity ? { activity } : {}) };
	});
	return { ...read, thread: { ...read.thread, participants } };
}

// --- Messages ------------------------------------------------------------------

export interface ReadMessageOptions {
	/** The user may read as a session by naming it. */
	participant?: string;
	/** Mark the reader's delivery read and return the message (INB-02). */
	markRead?: boolean;
}

export async function readMessage(runtime: Runtime, caller: Caller, messageId: string, options: ReadMessageOptions = {}): Promise<{ message: MessageView }> {
	const now = runtime.clock.now();
	return runtime.db.atomically(async (tx) => {
		const row = await messageRow(tx, messageId);
		const reader = await readerFor(tx, runtime, caller, options.participant, now);
		// THR-11: nonmembers may read, but only the reader's own delivery can be marked.
		if (options.markRead) {
			await tx.run(
				"UPDATE deliveries SET read_at = ? WHERE recipient_id = ? AND message_id = ? AND read_at IS NULL",
				now,
				reader.id,
				messageId,
			);
		}
		return { message: (await messageViews(tx, runtime, [row], reader.id))[0]! };
	});
}

async function appendEvent(runtime: Runtime, caller: Caller, messageId: string, kind: "message.revised" | "message.redacted", body: string | null): Promise<{ message: MessageView }> {
	const now = runtime.clock.now();
	return runtime.db.atomically(async (tx) => {
		const row = await messageRow(tx, messageId);
		const reader = await ensureCaller(tx, runtime, now, caller);
		await tx.run(
			"INSERT INTO message_events (id, message_id, kind, body, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			runtime.newId(),
			messageId,
			kind,
			body,
			reader.id,
			now,
		);
		if (kind === "message.revised") {
			await reindexRevision(tx, { id: messageId, threadId: row.thread_id, body: body ?? row.body });
		} else {
			await removeRedacted(tx, messageId);
		}
		return { message: (await messageViews(tx, runtime, [row], reader.id))[0]! };
	});
}

/** EDT-01..EDT-05: a user-only event row. No delivery, no wake. */
export async function reviseMessage(runtime: Runtime, caller: Caller, messageId: string, value: unknown): Promise<{ message: MessageView }> {
	if (caller.kind !== "user") throw ApiError.forbidden("only the user may revise a message");
	return appendEvent(runtime, caller, messageId, "message.revised", messageBody(value));
}

export async function redactMessage(runtime: Runtime, caller: Caller, messageId: string): Promise<{ message: MessageView }> {
	if (caller.kind !== "user") throw ApiError.forbidden("only the user may redact a message");
	return appendEvent(runtime, caller, messageId, "message.redacted", null);
}

// --- Archive and unread (REF-03, REF-04, REF-05) --------------------------------

/**
 * Hide or show one thread for one participant. Archiving is per participant: another participant
 * of the same thread keeps seeing it (REF-03). Re-archiving updates the time; a delivery calls
 * this with `false`, because new mail shows the thread again (REF-04).
 */
async function setThreadArchived(tx: SqliteExecutor, threadId: string, participantId: string, archived: boolean, now: number): Promise<void> {
	if (!archived) {
		await tx.run("DELETE FROM thread_archives WHERE thread_id = ? AND participant_id = ?", threadId, participantId);
		return;
	}
	await tx.run(
		`INSERT INTO thread_archives (thread_id, participant_id, archived_at) VALUES (?, ?, ?)
		 ON CONFLICT (thread_id, participant_id) DO UPDATE SET archived_at = excluded.archived_at`,
		threadId,
		participantId,
		now,
	);
}

/** True when this participant has the thread archived. */
export async function isThreadArchived(tx: SqliteExecutor, threadId: string, participantId: string): Promise<boolean> {
	const row = await tx.get("SELECT 1 AS found FROM thread_archives WHERE thread_id = ? AND participant_id = ?", threadId, participantId);
	return row !== undefined;
}

/** The participant's unread deliveries per thread, for one reader (REF-05). */
async function unreadCounts(
	tx: SqliteExecutor,
	participantId: string,
	threadIds: readonly string[],
): Promise<Map<string, number>> {
	const counts = new Map<string, number>();
	for (const id of new Set(threadIds)) counts.set(id, 0);
	if (counts.size === 0) return counts;
	const placeholders = [...counts.keys()].map(() => "?").join(",");
	const rows = await tx.all<{ thread_id: string; n: number }>(
		`SELECT thread_id, COUNT(*) AS n FROM deliveries
		  WHERE recipient_id = ? AND read_at IS NULL AND thread_id IN (${placeholders})
		  GROUP BY thread_id`,
		participantId,
		...counts.keys(),
	);
	for (const row of rows) counts.set(row.thread_id, row.n);
	return counts;
}

/**
 * REF-03: archive a thread for one participant. The participant is the caller, or a named one
 * the user may act for, the same rule the inbox uses.
 */
export async function archiveThread(runtime: Runtime, caller: Caller, threadId: string, options: { participant?: string; archived: boolean }): Promise<ArchiveState> {
	const now = runtime.clock.now();
	return runtime.db.atomically(async (tx) => {
		const thread = await threadView(tx, runtime, threadId);
		const participant = await readerFor(tx, runtime, caller, options.participant, now);
		const member = await tx.get("SELECT 1 FROM thread_participants WHERE thread_id = ? AND participant_id = ?", threadId, participant.id);
		if (!member) throw ApiError.forbidden(`${participant.url} is not a participant of thread ${threadId}`);
		await setThreadArchived(tx, threadId, participant.id, options.archived, now);
		return {
			thread,
			archived: options.archived,
			participant: { id: participant.id, kind: participant.kind, url: participant.url },
		};
	});
}

// --- Inbox ---------------------------------------------------------------------

interface InboxRow {
	delivery_id: string;
	message_id: string;
	thread_id: string;
	created_at: number;
	delivered_at: number;
	read_at: number | null;
	subject: string | null;
	sender_id: string;
	sender_kind: ParticipantKind;
	sender_url: string;
	body: string;
}

export interface InboxOptions {
	/** List the threads this participant archived instead of the ones still showing (REF-07). */
	archived?: boolean;
	limit?: number;
	cursor?: string | null;
}

export const INBOX_LIMIT = 50;

/**
 * INB-01 and INB-03: one participant's deliveries, newest first, one page at a time (SCALE-03).
 * Deliveries share their message's `created_at`, and delivery IDs grow in append order, so
 * `(created_at, id)` orders the inbox and walks the `deliveries_recipient` index.
 */
export async function inbox(
	runtime: Runtime,
	caller: Caller,
	participant?: string,
	options: InboxOptions = {},
): Promise<{ participant: PersonView; deliveries: InboxDelivery[]; unreadTotal: number; nextCursor: string | null }> {
	const now = runtime.clock.now();
	const archivedFilter = options.archived ? "EXISTS" : "NOT EXISTS";
	const limit = options.limit ?? INBOX_LIMIT;
	const after = decodeCursor(options.cursor, ["number", "string"]);
	return runtime.db.atomically(async (tx) => {
		const reader = await readerFor(tx, runtime, caller, participant, now);
		const fetched = await tx.all<InboxRow>(
			`SELECT d.id AS delivery_id, d.message_id AS message_id, d.thread_id AS thread_id,
			        d.created_at AS delivered_at, d.read_at AS read_at,
			        m.body AS body, m.created_at AS created_at,
			        t.subject AS subject,
			        p.id AS sender_id, p.kind AS sender_kind, p.url AS sender_url
			   FROM deliveries d
			   JOIN messages m ON m.id = d.message_id
			   JOIN threads t ON t.id = d.thread_id
			   JOIN participants p ON p.id = m.sender_id
			  WHERE d.recipient_id = ?
			    AND ${archivedFilter} (SELECT 1 FROM thread_archives a WHERE a.thread_id = d.thread_id AND a.participant_id = d.recipient_id)
			        ${after ? "AND d.created_at <= ? AND (d.created_at < ? OR d.id < ?)" : ""}
			  ORDER BY d.created_at DESC, d.id DESC
			  LIMIT ?`,
			reader.id,
			...(after ? [after[0]!, after[0]!, after[1]!] : []),
			limit + 1,
		);
		const { items: rows, nextCursor } = pageOf(fetched, limit, (row) => [row.delivered_at, row.delivery_id]);
		const events = await latestEvents(tx, rows.map((row) => row.message_id));
		const unread = await unreadCounts(
			tx,
			reader.id,
			rows.map((row) => row.thread_id),
		);
		const messageIds = [...new Set(rows.map((row) => row.message_id))];
		const recipients =
			messageIds.length === 0
				? []
				: await tx.all<{ message_id: string; id: string; kind: ParticipantKind; url: string; read_at: number | null }>(
						`SELECT d.message_id AS message_id, p.id AS id, p.kind AS kind, p.url AS url, d.read_at AS read_at
						   FROM deliveries d
						   JOIN participants p ON p.id = d.recipient_id
						  WHERE d.message_id IN (${messageIds.map(() => "?").join(",")})
						  ORDER BY d.message_id, d.id`,
						...messageIds,
					);
		// REF-06 counts every unread delivery, and a page holds only some of them (SCALE-03).
		const unreadTotal = (await tx.get<{ n: number }>(
			`SELECT COUNT(*) AS n FROM deliveries d
			  WHERE d.recipient_id = ? AND d.read_at IS NULL
			    AND ${archivedFilter} (SELECT 1 FROM thread_archives a WHERE a.thread_id = d.thread_id AND a.participant_id = d.recipient_id)`,
			reader.id,
		))!.n;
		const byMessage = new Map<string, InboxRecipient[]>();
		for (const row of recipients) {
			const list = byMessage.get(row.message_id) ?? [];
			list.push({ id: row.id, kind: row.kind, url: row.url, readAt: row.read_at });
			byMessage.set(row.message_id, list);
		}

		return {
			participant: { id: reader.id, kind: reader.kind, url: reader.url },
			deliveries: rows.map((row) => ({
				id: row.delivery_id,
				messageId: row.message_id,
				messageUrl: runtime.url({ kind: "message", id: row.message_id, thread: row.thread_id }),
				threadId: row.thread_id,
				threadUrl: runtime.url({ kind: "thread", id: row.thread_id }),
				subject: row.subject,
				sender: { id: row.sender_id, kind: row.sender_kind, url: row.sender_url },
				recipients: byMessage.get(row.message_id) ?? [],
				createdAt: row.created_at,
				deliveredAt: row.delivered_at,
				readAt: row.read_at,
				unreadCount: unread.get(row.thread_id) ?? 0,
				...applyEvent(row.body, events.get(row.message_id)),
			})),
			unreadTotal,
			nextCursor,
		};
	});
}

// --- Thread inbox (UX-03) --------------------------------------------------------

export interface InboxThread {
	threadId: string;
	threadUrl: string;
	subject: string | null;
	participants: PersonView[];
	/** The newest message in the thread, whoever sent it. */
	latest: {
		messageId: string;
		messageUrl: string;
		sender: PersonView;
		createdAt: number;
		snippet: string;
		revised: boolean;
		redacted: boolean;
	};
	/** The reader's unread messages in this thread (REF-05). */
	unreadCount: number;
	archived: boolean;
	/** Session participants that are working right now (UX-09). */
	working: WorkingSession[];
}

export const SNIPPET_LENGTH = 140;

/** One line of a message body for a list row: whitespace collapsed, cut at a word near `max`. */
export function snippetOf(body: string | undefined, max = SNIPPET_LENGTH): string {
	const text = String(body ?? "").replace(/\s+/g, " ").trim();
	if (text.length <= max) return text;
	const cut = text.slice(0, max);
	const space = cut.lastIndexOf(" ");
	return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

interface InboxThreadRow {
	thread_id: string;
	subject: string | null;
	last_at: number;
	last_id: string;
}

/**
 * UX-03: one row per thread the reader participates in, newest activity first, with the latest
 * message and the reader's unread count. Unlike the delivery inbox, a thread whose latest message
 * the reader sent still shows: activity, not mail, orders it.
 *
 * The latest message is found per thread at read time. A `last_message_at` column kept up to
 * date on every append would make a page an index range scan, but it is one more piece of state
 * that every writer must maintain; the per-thread lookup measured about 10 ms at 10,000 threads,
 * well under SCALE-03's 100 ms.
 */
export async function inboxThreads(
	runtime: Runtime,
	caller: Caller,
	participant?: string,
	options: InboxOptions = {},
): Promise<{ participant: PersonView; threads: InboxThread[]; unreadTotal: number; nextCursor: string | null }> {
	const now = runtime.clock.now();
	const archivedFilter = options.archived ? "EXISTS" : "NOT EXISTS";
	const limit = options.limit ?? INBOX_LIMIT;
	const after = decodeCursor(options.cursor, ["number", "string"]);
	return runtime.db.atomically(async (tx) => {
		const reader = await readerFor(tx, runtime, caller, participant, now);
		const fetched = await tx.all<InboxThreadRow>(
			`SELECT x.thread_id AS thread_id, x.subject AS subject, m.created_at AS last_at, m.id AS last_id
			   FROM (SELECT tp.thread_id AS thread_id, t.subject AS subject,
			                (SELECT MAX(seq) FROM messages WHERE thread_id = tp.thread_id) AS last_seq
			           FROM thread_participants tp
			           JOIN threads t ON t.id = tp.thread_id
			          WHERE tp.participant_id = ?
			            AND ${archivedFilter} (SELECT 1 FROM thread_archives a WHERE a.thread_id = tp.thread_id AND a.participant_id = tp.participant_id)) x
			   JOIN messages m ON m.thread_id = x.thread_id AND m.seq = x.last_seq
			  ${after ? "WHERE m.created_at < ? OR (m.created_at = ? AND x.thread_id < ?)" : ""}
			  ORDER BY m.created_at DESC, x.thread_id DESC
			  LIMIT ?`,
			reader.id,
			...(after ? [after[0]!, after[0]!, after[1]!] : []),
			limit + 1,
		);
		const { items: rows, nextCursor } = pageOf(fetched, limit, (row) => [row.last_at, row.thread_id]);
		const threadIds = rows.map((row) => row.thread_id);
		const messageIds = rows.map((row) => row.last_id);
		const inList = (ids: readonly string[]) => ids.map(() => "?").join(",");
		const messages =
			messageIds.length === 0
				? []
				: await tx.all<{ id: string; body: string; sender_id: string; sender_kind: ParticipantKind; sender_url: string }>(
						`SELECT m.id AS id, m.body AS body, p.id AS sender_id, p.kind AS sender_kind, p.url AS sender_url
						   FROM messages m JOIN participants p ON p.id = m.sender_id
						  WHERE m.id IN (${inList(messageIds)})`,
						...messageIds,
					);
		const byId = new Map(messages.map((message) => [message.id, message]));
		const events = await latestEvents(tx, messageIds);
		const members =
			threadIds.length === 0
				? []
				: await tx.all<{ thread_id: string; id: string; kind: ParticipantKind; url: string }>(
						`SELECT tp.thread_id AS thread_id, p.id AS id, p.kind AS kind, p.url AS url
						   FROM thread_participants tp JOIN participants p ON p.id = tp.participant_id
						  WHERE tp.thread_id IN (${inList(threadIds)})
						  ORDER BY tp.thread_id, tp.joined_at, p.id`,
						...threadIds,
					);
		const participantsOf = new Map<string, PersonView[]>();
		for (const member of members) {
			const list = participantsOf.get(member.thread_id) ?? [];
			list.push({ id: member.id, kind: member.kind, url: member.url });
			participantsOf.set(member.thread_id, list);
		}
		const unread = await unreadCounts(tx, reader.id, threadIds);
		const working = await workingSessions(tx, threadIds);
		const unreadTotal = (await tx.get<{ n: number }>(
			`SELECT COUNT(*) AS n FROM deliveries d
			  WHERE d.recipient_id = ? AND d.read_at IS NULL
			    AND ${archivedFilter} (SELECT 1 FROM thread_archives a WHERE a.thread_id = d.thread_id AND a.participant_id = d.recipient_id)`,
			reader.id,
		))!.n;
		return {
			participant: { id: reader.id, kind: reader.kind, url: reader.url },
			threads: rows.map((row) => {
				const message = byId.get(row.last_id)!;
				const current = applyEvent(message.body, events.get(row.last_id));
				return {
					threadId: row.thread_id,
					threadUrl: runtime.url({ kind: "thread", id: row.thread_id }),
					subject: row.subject,
					participants: participantsOf.get(row.thread_id) ?? [],
					latest: {
						messageId: row.last_id,
						messageUrl: runtime.url({ kind: "message", id: row.last_id, thread: row.thread_id }),
						sender: { id: message.sender_id, kind: message.sender_kind, url: message.sender_url },
						createdAt: row.last_at,
						snippet: current.redacted ? "[redacted]" : snippetOf(current.body),
						revised: current.revised,
						redacted: current.redacted,
					},
					unreadCount: unread.get(row.thread_id) ?? 0,
					archived: Boolean(options.archived),
					working: working.get(row.thread_id) ?? [],
				};
			}),
			unreadTotal,
			nextCursor,
		};
	});
}

// --- Notices -------------------------------------------------------------------

export interface NoticeInput {
	body?: unknown;
	/** Recipients. Users only; a named session is ignored (NTC-01). */
	to?: unknown;
	/**
	 * Post in this existing thread instead of a new one, as STA-02 needs for a failed run. The
	 * notice goes to the thread's users and to `to`; the domain does not join the thread, so later
	 * messages never deliver to it.
	 */
	thread?: string;
}

/**
 * NTC-01: post as the domain URL `pana://<domain>`. A notice delivers to users only, carries no
 * wake request, and never calls the delivery hook, so it can never wake a session.
 */
export async function postNotice(runtime: Runtime, input: NoticeInput): Promise<ThreadResult> {
	const body = messageBody(input.body);
	const addresses = addressList(input.to, "recipients");
	const now = runtime.clock.now();
	const delivered: string[] = [];

	const result = await runtime.db.atomically(async (tx) => {
		const sender = await ensureDomain(tx, runtime, now);
		const recipients = new Map<string, ParticipantRecord>();
		for (const raw of addresses) {
			const resolved = await participantFor(tx, runtime, now, raw);
			if (resolved.kind === "user") recipients.set(resolved.id, resolved);
		}
		const existing = input.thread;
		if (existing !== undefined) {
			const thread = await tx.get<ThreadRecord>("SELECT * FROM threads WHERE id = ?", existing);
			if (!thread) throw ApiError.notFound(`thread ${existing}`);
			const users = await tx.all<ParticipantRecord>(
				`SELECT p.* FROM thread_participants tp JOIN participants p ON p.id = tp.participant_id
				  WHERE tp.thread_id = ? AND p.kind = 'user' ORDER BY tp.joined_at, p.id`,
				existing,
			);
			for (const user of users) recipients.set(user.id, user);
		}
		if (recipients.size === 0) {
			const user = await ensureUser(tx, runtime, now, runtime.config.user);
			recipients.set(user.id, user);
		}

		const threadId = existing ?? runtime.newId();
		if (existing === undefined) {
			await tx.run("INSERT INTO threads (id, subject, created_by, created_at) VALUES (?, NULL, ?, ?)", threadId, sender.id, now);
			for (const member of [sender, ...recipients.values()]) {
				await tx.run("INSERT INTO thread_participants (thread_id, participant_id, joined_at) VALUES (?, ?, ?)", threadId, member.id, now);
			}
		}

		const messageId = runtime.newId();
		const seq = (await tx.get<{ seq: number }>("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages WHERE thread_id = ?", threadId))!.seq;
		await tx.run(
			"INSERT INTO messages (id, thread_id, seq, sender_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			messageId,
			threadId,
			seq,
			sender.id,
			body,
			now,
		);
		await indexMessage(tx, { id: messageId, threadId, body });
		if (existing === undefined) await applyInitialSubject(tx, { threadId, body, id: runtime.newId(), now });
		for (const recipient of recipients.values()) {
			await tx.run(
				"INSERT INTO deliveries (id, message_id, thread_id, recipient_id, created_at) VALUES (?, ?, ?, ?, ?)",
				runtime.newId(),
				messageId,
				threadId,
				recipient.id,
				now,
			);
			delivered.push(recipient.url);
			// REF-04: a notice is a message too, so it unarchives the thread for its recipient.
			await setThreadArchived(tx, threadId, recipient.id, false, now);
		}

		return { thread: await threadView(tx, runtime, threadId), message: await messageView(tx, runtime, messageId) };
	});
	announce(runtime, "notice", result, delivered);
	return result;
}
