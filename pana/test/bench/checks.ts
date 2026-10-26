// SCALE-02: what the bench proves from the database after panad stops. Every check returns the
// rows that break it, so a failure names its evidence.

import type { DatabaseSync as Database } from "node:sqlite";
import { answerBody, needsReply } from "./model.ts";

// Vitest's resolver drops the `node:` prefix of builtins it does not know, and `sqlite` is one.
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");

export interface CheckResult {
	name: string;
	ok: boolean;
	/** How many rows the check looked at. */
	checked: number;
	/** Up to ten offending rows. */
	failures: unknown[];
}

export interface ExpectedCounts {
	/** Sessions the run should have created, top level and children together. */
	sessions?: number;
}

function result(name: string, checked: number, failures: unknown[]): CheckResult {
	return { name, ok: failures.length === 0, checked, failures: failures.slice(0, 10) };
}

/** Run every SCALE-02 check against a stopped panad's database. */
export function checkDatabase(path: string, expected: ExpectedCounts = {}): CheckResult[] {
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		return runChecks(db, expected);
	} finally {
		db.close();
	}
}

function runChecks(db: Database, expected: ExpectedCounts): CheckResult[] {
	const all = (sql: string, ...params: Array<string | number>) => db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
	const count = (sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
	const out: CheckResult[] = [];

	const messages = count("SELECT COUNT(*) AS n FROM messages");

	// Every message reaches every other participant once. Bench threads never add participants,
	// so the expected set is the thread's participants without the sender.
	const missing = all(
		`SELECT m.id AS message, tp.participant_id AS recipient
		   FROM messages m
		   JOIN thread_participants tp ON tp.thread_id = m.thread_id AND tp.participant_id <> m.sender_id
		   LEFT JOIN deliveries d ON d.message_id = m.id AND d.recipient_id = tp.participant_id
		  WHERE d.id IS NULL
		  LIMIT 10`,
	);
	out.push(result("every message is delivered to every other participant", messages, missing));

	const extra = all(
		`SELECT d.id AS delivery, d.message_id AS message, d.recipient_id AS recipient
		   FROM deliveries d
		   JOIN messages m ON m.id = d.message_id
		   LEFT JOIN thread_participants tp ON tp.thread_id = d.thread_id AND tp.participant_id = d.recipient_id
		  WHERE tp.participant_id IS NULL OR d.recipient_id = m.sender_id
		  LIMIT 10`,
	);
	const duplicate = all(
		`SELECT message_id AS message, recipient_id AS recipient, COUNT(*) AS n
		   FROM deliveries GROUP BY message_id, recipient_id HAVING COUNT(*) > 1 LIMIT 10`,
	);
	const deliveries = count("SELECT COUNT(*) AS n FROM deliveries");
	out.push(result("no delivery is duplicated or misaddressed", deliveries, [...extra, ...duplicate]));

	// Every delivery to a session woke it exactly once: one pi-durable submission per request ID,
	// settled, and the delivery marked read (DLV-03).
	const sessionDeliveries = count("SELECT COUNT(*) AS n FROM deliveries d JOIN sessions s ON s.id = d.recipient_id");
	const unwoken = all(
		`SELECT d.id AS delivery, d.wake_request_id AS request, d.wake_submission_id AS submission, d.read_at AS readAt
		   FROM deliveries d JOIN sessions s ON s.id = d.recipient_id
		  WHERE d.wake_submission_id IS NULL OR d.read_at IS NULL
		  LIMIT 10`,
	);
	const sharedSubmission = all(
		`SELECT wake_submission_id AS submission, COUNT(*) AS n FROM deliveries
		  WHERE wake_submission_id IS NOT NULL GROUP BY wake_submission_id HAVING COUNT(*) > 1 LIMIT 10`,
	);
	const submissionsPerRequest = all(
		`SELECT d.id AS delivery, d.wake_request_id AS request, COUNT(p.id) AS submissions
		   FROM deliveries d
		   JOIN sessions s ON s.id = d.recipient_id
		   LEFT JOIN pi_submissions p ON p.conversation_id = s.conversation_id AND p.request_id = json_quote(d.wake_request_id)
		  GROUP BY d.id HAVING COUNT(p.id) <> 1
		  LIMIT 10`,
	);
	const unsettled = all(
		`SELECT d.id AS delivery, p.status AS status
		   FROM deliveries d JOIN pi_submissions p ON p.id = d.wake_submission_id
		  WHERE p.status <> 'done'
		  LIMIT 10`,
	);
	out.push(
		result("every delivery to a session wakes it exactly once and settles", sessionDeliveries, [
			...unwoken,
			...sharedSubmission,
			...submissionsPerRequest,
			...unsettled,
		]),
	);

	// Every message that asks for an answer gets exactly one, from the other side of its thread.
	const asks = all("SELECT id, thread_id AS thread, sender_id AS sender, body FROM messages").filter((row) => needsReply(String(row.body)));
	const answers = new Map<string, Array<{ sender: string; thread: string }>>();
	for (const row of all("SELECT thread_id AS thread, sender_id AS sender, body FROM messages WHERE body LIKE 'bench answer %'")) {
		const key = String(row.body);
		const list = answers.get(key) ?? [];
		list.push({ sender: String(row.sender), thread: String(row.thread) });
		answers.set(key, list);
	}
	const unanswered: unknown[] = [];
	for (const ask of asks) {
		const got = answers.get(answerBody(String(ask.id))) ?? [];
		if (got.length !== 1 || got[0]!.thread !== ask.thread || got[0]!.sender === ask.sender) {
			unanswered.push({ message: ask.id, thread: ask.thread, answers: got.length });
		}
	}
	out.push(result("every session run posts its reply exactly once", asks.length, unanswered));

	// A failed run, a budget stop, or an archived thread posts a notice; the bench expects none.
	const notices = all(
		"SELECT m.id AS message, m.body AS body FROM messages m JOIN participants p ON p.id = m.sender_id WHERE p.kind = 'domain' LIMIT 10",
	);
	out.push(result("no notices", messages, notices));

	const sessions = count("SELECT COUNT(*) AS n FROM sessions");
	const notIdle = all("SELECT id, state FROM sessions WHERE state <> 'idle' LIMIT 10");
	const wrongCount = expected.sessions === undefined || expected.sessions === sessions ? [] : [{ expected: expected.sessions, actual: sessions }];
	out.push(result("every session ends idle", sessions, [...wrongCount, ...notIdle]));

	const openSubmissions = all("SELECT id, conversation_id AS conversation, status FROM pi_submissions WHERE status IN ('queued', 'placed') LIMIT 10");
	out.push(result("no pi-durable submission is left open", count("SELECT COUNT(*) AS n FROM pi_submissions"), openSubmissions));

	return out;
}

export interface LoggedRequest {
	route: string | null;
	method: string;
	status: number;
	durationMs: number;
	caller: string | null;
}

/** The request log lines with a failure status: SCALE-02's "no request fails". */
export function failedRequests(lines: readonly LoggedRequest[]): CheckResult {
	const failures = lines.filter((line) => line.status >= 400);
	return result("no request fails", lines.length, failures);
}
