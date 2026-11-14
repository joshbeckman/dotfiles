// One rendering of a delivered message, shared by the wake (DLV-02) and the wake gate (DEC-03).
//
// The gate has to judge the same text the session would receive, so both build it here rather
// than each keeping its own copy. Nothing here touches the clock, so rendering the same message
// twice gives identical text.
//
// The roster (CLI-09) is the one part the gate leaves out: it names the recipient as "(you)", so
// it differs per delivery, while the gate asks one question for every recipient of a message.

import type { SqliteExecutor } from "@earendil-works/chord/sqlite";
import { isAbsolute, join } from "node:path";
import type { Runtime } from "../server/runtime.ts";

export interface DeliveryText {
	senderUrl: string;
	threadUrl: string;
	/** Who is in the thread, when that is news (DLV-02, CLI-09). */
	participants?: string;
	messageUrl: string;
	subject: string | null;
	body: string;
	/** Local paths of the message's attachments, in body order. */
	attachments?: readonly string[];
}

/** The message a wake hands its session: sender, thread, message, subject, attachments, body. */
export function deliveryText(parts: DeliveryText): string {
	const lines = [
		"New message.",
		`From: ${parts.senderUrl}`,
		`Thread: ${parts.threadUrl}`,
	];
	if (parts.participants !== undefined) lines.push(`Participants: ${parts.participants}`);
	lines.push(`Message: ${parts.messageUrl}`, `Subject: ${parts.subject ?? ""}`);
	if (parts.attachments && parts.attachments.length > 0) {
		lines.push("Attachments:");
		for (const path of parts.attachments) lines.push(`- ${path}`);
	}
	lines.push("", parts.body);
	return lines.join("\n");
}

/** `pana://<domain>/files/<id>/<name>` references in a body, resolved to their paths on disk. */
export async function attachmentPaths(db: SqliteExecutor, runtime: Runtime, body: string): Promise<string[]> {
	const prefix = `pana://${runtime.config.domain}/files/`;
	const paths: string[] = [];
	const seen = new Set<string>();
	const pattern = new RegExp(`${escape(prefix)}([0-9A-HJKMNP-TV-Z]{26})/`, "g");
	for (const match of body.matchAll(pattern)) {
		const id = match[1]!;
		if (seen.has(id)) continue;
		seen.add(id);
		const file = await db.get<{ path: string }>("SELECT path FROM files WHERE id = ?", id);
		// WP2 records the path relative to the state directory (FIL-01).
		if (file) paths.push(isAbsolute(file.path) ? file.path : join(runtime.paths.dir, file.path));
	}
	return paths;
}

function escape(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Who is in the thread, named only when that is news: in the thread's first message, and in any
 * message that added a participant (a `--cc` join, THR-08). Repeating it on every message would
 * spend a line per delivery on a fact the session already read.
 */
export async function threadRoster(
	db: SqliteExecutor,
	message: { id: string; thread_id: string; seq: number },
	recipientId: string,
): Promise<string | undefined> {
	if (message.seq !== 1) {
		const joined = await db.get(
			"SELECT 1 FROM thread_participants WHERE thread_id = ? AND joined_message_id = ? LIMIT 1",
			message.thread_id,
			message.id,
		);
		if (!joined) return undefined;
	}
	const people = await db.all<{ id: string; url: string; role: string }>(
		`SELECT p.id, p.url, COALESCE(r.role, 'participant') AS role
		   FROM thread_participants tp
		   JOIN participants p ON p.id = tp.participant_id
		   LEFT JOIN thread_participant_roles r ON r.thread_id = tp.thread_id AND r.participant_id = tp.participant_id
		  WHERE tp.thread_id = ? ORDER BY tp.joined_at, p.id`,
		message.thread_id,
	);
	// A declared role rides along (CLI-09): a peer that says "reviewer" tells the others what it does.
	return people
		.map((person) => {
			const marks = [...(person.role === "participant" ? [] : [person.role]), ...(person.id === recipientId ? ["you"] : [])];
			return marks.length > 0 ? `${person.url} (${marks.join(", ")})` : person.url;
		})
		.join(", ");
}
