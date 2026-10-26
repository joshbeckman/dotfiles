// Map panad's response shapes to what the PWA renders, and the PWA's forms to request bodies.
// These are the only places app.js reads a handler's fields, and Node tests run them against
// real handler output, so a shape change fails `npm test` instead of a blank screen.

/** One row of `GET /inbox` (`{participant, deliveries}`). */
export function inboxRow(delivery) {
	return {
		threadId: delivery.threadId,
		messageId: delivery.messageId,
		subject: delivery.subject ?? "(no subject)",
		sender: delivery.sender?.url ?? "",
		at: delivery.createdAt,
		read: delivery.readAt !== null && delivery.readAt !== undefined,
	};
}

/** One row of `GET /threads`: a listing (`ThreadSummary`) or a search hit (`ThreadHit`). */
export function threadRow(thread) {
	return {
		id: thread.threadId,
		url: thread.threadUrl,
		subject: thread.subject ?? "(no subject)",
		snippet: thread.snippet,
		at: thread.createdAt,
	};
}

/** A message from `GET /threads/:id` or a 409 refresh. */
export function messageView(message) {
	return {
		id: message.id,
		sender: message.sender?.url ?? "",
		at: message.createdAt,
		body: message.body ?? "",
		revised: Boolean(message.revised),
		redacted: Boolean(message.redacted),
	};
}

/** The text of one pi-ai message content: a string or a list of blocks. */
function contentText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const block of content) {
		if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
		else if (block?.type === "toolCall") parts.push(`→ ${block.name} ${JSON.stringify(block.arguments ?? {})}`);
	}
	return parts.join("\n");
}

/** One entry of `GET /sessions/:id/transcript`, or the `entry` of a `session.entry` event. */
export function entryView(entry) {
	const model = Array.isArray(entry.model) ? entry.model : [];
	const role = model[0]?.role ?? entry.kind;
	let text = model.map((message) => contentText(message.content)).filter(Boolean).join("\n");
	if (!text && entry.data !== undefined) text = JSON.stringify(entry.data);
	return { id: entry.id, kind: entry.kind, role, text };
}

/** One commit of `GET /memory/log`. */
export function commitView(commit) {
	return { hash: commit.hash, short: String(commit.hash ?? "").slice(0, 8), author: commit.authorUrl, at: commit.time, message: commit.message };
}

/** One hit of `GET /memory/search`. */
export function memoryHitView(hit) {
	return { path: hit.path, text: `${hit.line}: ${hit.text}` };
}

/** What the schedule form's "when" field shows: the cron expression, or the one-off time. */
export function scheduleWhen(schedule) {
	if (schedule.cron) return schedule.cron;
	if (typeof schedule.at === "number") return new Date(schedule.at).toISOString();
	return "";
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

/**
 * The body of `POST /schedules` or `POST /schedules/:id` from the form. An empty "when" sends
 * neither cron nor at, which keeps an edited schedule's stored time. An edit merges over the
 * stored payload, so a thread schedule keeps its recipients.
 */
export function scheduleBody(form, editing) {
	const when = String(form.when ?? "").trim();
	const kind = form.kind || "session";
	const base = editing && editing.kind === kind ? { ...(editing.payload ?? {}) } : {};
	const text = String(form.text ?? "");
	const payload = kind === "thread" ? { ...base, body: text } : { ...base, prompt: text };
	const to = String(form.to ?? "")
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
	if (kind === "thread" && to.length > 0) payload.to = to;
	const body = { kind, payload };
	if (when) {
		if (ISO_DATE.test(when)) body.at = when;
		else body.cron = when;
	}
	return body;
}
