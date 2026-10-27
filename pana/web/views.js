// Map panad's response shapes to what the PWA renders, and the PWA's forms to request bodies.
// These are the only places app.js reads a handler's fields, and Node tests run them against
// real handler output, so a shape change fails `npm test` instead of a blank screen.

/** One row of `GET /inbox` (`{participant, deliveries}`). */
export function inboxRow(delivery) {
	return {
		threadId: delivery.threadId,
		messageId: delivery.messageId,
		messageUrl: delivery.messageUrl,
		threadUrl: delivery.threadUrl,
		subject: delivery.subject ?? "(no subject)",
		sender: delivery.sender?.url ?? "",
		at: delivery.createdAt,
		read: delivery.readAt !== null && delivery.readAt !== undefined,
		// REF-05: the reader's unread count for the message's thread.
		unreadCount: count(delivery.unreadCount),
	};
}

/** One row of `GET /inbox?view=threads` (UX-03): a thread with its newest message. */
export function inboxThreadRow(thread) {
	const latest = thread.latest ?? {};
	return {
		threadId: thread.threadId,
		threadUrl: thread.threadUrl,
		subject: thread.subject ?? "(no subject)",
		participants: Array.isArray(thread.participants) ? thread.participants.map(person) : [],
		messageId: latest.messageId,
		messageUrl: latest.messageUrl,
		sender: person(latest.sender ?? {}),
		snippet: String(latest.snippet ?? ""),
		at: latest.createdAt,
		unreadCount: count(thread.unreadCount),
		archived: Boolean(thread.archived),
		working: workingOf(thread),
	};
}

/**
 * UX-09: `running` and `waiting` are the states that mean a session is working. `waiting` is not
 * stored; a sleeping run reports it (STA-03).
 */
export function isWorking(state) {
	return state === "running" || state === "waiting";
}

/** The working sessions of a list row or a thread, in the order the server named them (UX-09). */
export function workingOf(value) {
	const list = Array.isArray(value?.working) ? value.working : [];
	return list.filter((session) => isWorking(session?.state ?? "running")).map((session) => ({
		sessionId: String(session.sessionId ?? session.id ?? ""),
		url: String(session.url ?? ""),
		state: String(session.state ?? "running"),
	}));
}

/** A thread's session participants that are working now, for the indicator above the reply box (UX-09). */
export function workingParticipants(thread) {
	const participants = Array.isArray(thread?.participants) ? thread.participants : [];
	return participants
		.filter((participant) => participant?.kind === "session" && isWorking(participant.state))
		.map((participant) => ({ sessionId: String(participant.id ?? ""), url: String(participant.url ?? ""), state: String(participant.state) }));
}

function person(value) {
	return { url: String(value?.url ?? ""), kind: String(value?.kind ?? "") };
}

/**
 * The style guide palette (UX-06). The user is always blue and the domain's notices are black;
 * every session gets one of the other colors from a hash of its URL, so it keeps that color in
 * every thread and every window.
 */
export const PALETTE = {
	blue: "#002FA7",
	orange: "#FF7900",
	purple: "#903465",
	green: "#237F52",
	red: "#BD2024",
	yellow: "#FFCC00",
	black: "#0D0D0D",
};

export const SESSION_COLORS = ["orange", "purple", "green", "red", "yellow"];

/** FNV-1a: small, stable across browsers and Node, and spreads similar ULIDs apart. */
function hash(text) {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h;
}

/** The palette name for a participant: `{url, kind}` from a handler, or a bare URL. */
export function participantColor(participant) {
	const url = typeof participant === "string" ? participant : String(participant?.url ?? "");
	const kind = typeof participant === "string" ? kindOf(url) : String(participant?.kind || kindOf(url));
	if (kind === "user") return "blue";
	if (kind === "domain") return "black";
	return SESSION_COLORS[hash(url) % SESSION_COLORS.length];
}

function kindOf(url) {
	const match = /^pana:\/\/[^/?#]+(?:\/([a-z]+)\/)?/.exec(url);
	if (!match) return "";
	if (!match[1]) return "domain";
	return { users: "user", sessions: "session" }[match[1]] ?? match[1];
}

/** A short name for a participant URL: the username, `session` and the ID's tail, or the domain. */
export function refLabel(url) {
	const text = String(url ?? "");
	const match = /^pana:\/\/([^/?#]+)(?:\/([a-z]+)\/([^/?#]+))?/.exec(text);
	if (!match) return text;
	const [, domain, kind, id] = match;
	if (!kind) return domain;
	if (kind === "users") return id;
	if (kind === "sessions") return `session ${id.slice(-6)}`;
	return `${kind.replace(/s$/, "")} ${id.slice(-6)}`;
}

/** A list row's time: the clock time today, the month and day this year, the full date before. */
export function shortTime(at, now = Date.now(), locale = undefined) {
	const date = new Date(Number(at));
	if (Number.isNaN(date.getTime())) return "";
	const today = new Date(Number(now));
	if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
	if (date.getFullYear() === today.getFullYear()) return date.toLocaleDateString(locale, { month: "short", day: "numeric" });
	return date.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });
}

/** One row of `GET /threads`: a listing (`ThreadSummary`) or a search hit (`ThreadHit`). */
export function threadRow(thread) {
	return {
		id: thread.threadId,
		url: thread.threadUrl,
		subject: thread.subject ?? "(no subject)",
		snippet: thread.snippet,
		at: thread.createdAt,
		// REF-05 and REF-03.
		unreadCount: count(thread.unreadCount),
		archived: Boolean(thread.archived),
		working: workingOf(thread),
	};
}

/** A message from `GET /threads/:id` or a 409 refresh. */
export function messageView(message) {
	return {
		id: message.id,
		url: message.url,
		threadId: message.threadId,
		threadUrl: message.threadUrl,
		sender: message.sender?.url ?? "",
		senderKind: message.sender?.kind ?? "",
		at: message.createdAt,
		body: message.body ?? "",
		revised: Boolean(message.revised),
		redacted: Boolean(message.redacted),
	};
}

function count(value) {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** The text of one pi-ai message content: a string or a list of blocks. */
function contentText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const block of content) {
		if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
		else if (block?.type === "thinking" && typeof block.thinking === "string") parts.push(block.thinking);
		else if (block?.type === "toolCall") parts.push(`→ ${block.name} ${JSON.stringify(block.arguments ?? {})}`);
	}
	return parts.join("\n");
}

/**
 * The blocks of one message's content, in order. UX-11: the model's own text and thinking are
 * Markdown; what a user or a tool wrote stays plain text.
 */
function contentBlocks(content, markdown = false) {
	const prose = (type, text) => (markdown ? { type, text, markdown: true } : { type, text });
	if (typeof content === "string") return content ? [prose("text", content)] : [];
	if (!Array.isArray(content)) return [];
	const blocks = [];
	for (const block of content) {
		if (block?.type === "text" && typeof block.text === "string") blocks.push(prose("text", block.text));
		else if (block?.type === "thinking" && typeof block.thinking === "string") {
			blocks.push(prose("thinking", block.thinking));
		} else if (block?.type === "toolCall") {
			blocks.push({
				type: "tool-call",
				name: String(block.name ?? ""),
				callId: block.id,
				// The full arguments, not a summary: REF-09 shows them verbatim.
				arguments: block.arguments ?? {},
			});
		} else if (block?.type === "image") {
			blocks.push({ type: "image", mediaType: String(block.mimeType ?? "") });
		}
	}
	return blocks;
}

/** The usage of the turn an entry recorded, when the model reported one. */
function turnUsage(model) {
	for (const message of model) {
		if (message?.role !== "assistant" || typeof message.usage !== "object" || message.usage === null) continue;
		const usage = message.usage;
		return {
			input: Number(usage.input ?? 0),
			output: Number(usage.output ?? 0),
			costUsd: Number(usage.cost?.total ?? 0),
		};
	}
	return undefined;
}

/** The rendered text of one block, for a flat reading of the transcript. */
function blockText(block) {
	if (block.type === "tool-call") return `→ ${block.name} ${JSON.stringify(block.arguments ?? {})}`;
	if (block.type === "tool-result") return block.output;
	if (typeof block.text === "string") return block.text;
	return "";
}

const ENTRY_LABELS = {
	"pi.system": "system",
	"pi.compaction": "compaction",
	"pi.reset": "reset",
	"pi.tool-result": "tool result",
	"pana.message": "message",
	"pana.note": "note",
};

/**
 * One entry of `GET /sessions/:id/transcript`, or the `entry` of a `session.entry` event.
 * REF-09: thinking blocks, tool calls with their full arguments, tool results with their full
 * output, system and compaction entries, and per-turn usage all come through as `blocks`.
 */
export function entryView(entry) {
	const model = Array.isArray(entry.model) ? entry.model : [];
	const kind = String(entry.kind ?? "");
	const role = model[0]?.role ?? kind;
	const blocks = [];
	for (const message of model) {
		if (message?.role === "toolResult") {
			blocks.push({
				type: "tool-result",
				name: String(message.toolName ?? ""),
				callId: message.toolCallId,
				output: contentText(message.content),
				isError: Boolean(message.isError),
			});
			continue;
		}
		blocks.push(...contentBlocks(message?.content, message?.role === "assistant"));
	}
	if (blocks.length === 0 && entry.data !== undefined && entry.data !== null) {
		blocks.push({ type: "json", text: JSON.stringify(entry.data, null, 2) });
	}
	const text = blocks.map(blockText).filter(Boolean).join("\n");
	const usage = turnUsage(model);
	const view = { id: entry.id, kind, role, label: ENTRY_LABELS[kind] ?? kind, text, blocks };
	if (usage) view.usage = usage;
	return view;
}

/**
 * UX-11: an entry's exact source text, for its Raw toggle. Every string the model or a tool
 * wrote appears verbatim, so Markdown the renderer hides (comments, stripped HTML, link targets)
 * is still readable. Tool arguments and entry data, which are JSON, are shown as JSON.
 */
export function entryRaw(entry) {
	const parts = [];
	for (const message of Array.isArray(entry?.model) ? entry.model : []) {
		const content = message?.content;
		if (typeof content === "string") {
			parts.push(content);
			continue;
		}
		for (const block of Array.isArray(content) ? content : []) {
			if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
			else if (block?.type === "thinking" && typeof block.thinking === "string") parts.push(block.thinking);
			else if (block?.type === "toolCall") parts.push(`${block.name ?? ""} ${JSON.stringify(block.arguments ?? {}, null, 2)}`);
			else if (block?.type === "image") parts.push(`[image ${block.mimeType ?? ""}]`);
		}
	}
	if (entry?.data !== undefined && entry.data !== null) parts.push(JSON.stringify(entry.data, null, 2));
	return parts.join("\n\n");
}

/** UX-12: a short elapsed time for a working chip or a running tool: "42s", "3m", "1h 5m". */
export function elapsedLabel(ms) {
	const seconds = Math.max(0, Math.floor(Number(ms) / 1000) || 0);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** UX-12: what a working session is doing, with its elapsed time when its start is known. */
export function liveActivityLabel(live, now) {
	const activity = String(live?.activity ?? "working");
	return typeof live?.since === "number" ? `${activity} · ${elapsedLabel(now - live.since)}` : activity;
}

/** One commit of `GET /memory/log`. */
export function commitView(commit) {
	return { hash: commit.hash, short: String(commit.hash ?? "").slice(0, 8), author: commit.authorUrl, at: commit.time, message: commit.message };
}

/** One hit of `GET /memory/search`. */
export function memoryHitView(hit) {
	return { path: hit.path, text: `${hit.line}: ${hit.text}` };
}

/** One file of `GET /memory/files/*` (MEM-09). */
export function memoryFileView(file) {
	return {
		path: String(file?.path ?? ""),
		content: String(file?.content ?? ""),
		commit: String(file?.commit ?? ""),
	};
}

/** One file's diff inside `GET /memory/commits/:hash` (MEM-10). */
export function memoryCommitFileView(file) {
	return {
		path: String(file?.path ?? ""),
		status: String(file?.status ?? "modified"),
		additions: Number(file?.additions) || 0,
		deletions: Number(file?.deletions) || 0,
		binary: Boolean(file?.binary),
		patch: String(file?.patch ?? ""),
		truncated: Boolean(file?.truncated),
	};
}

/** `GET /memory/commits/:hash` for the commit view (MEM-10). The body excludes the subject. */
export function memoryCommitView(commit) {
	const message = String(commit?.message ?? "");
	const subject = String(commit?.subject ?? message.split("\n", 1)[0] ?? "");
	const body = message.startsWith(subject) ? message.slice(subject.length).replace(/^\s*\n/, "") : message;
	return {
		hash: String(commit?.hash ?? ""),
		short: String(commit?.short ?? commit?.hash ?? "").slice(0, 8),
		author: String(commit?.authorUrl ?? ""),
		at: commit?.time,
		subject,
		body,
		parents: Array.isArray(commit?.parents) ? commit.parents.map(String) : [],
		files: Array.isArray(commit?.files) ? commit.files.map(memoryCommitFileView) : [],
		truncated: Boolean(commit?.truncated),
	};
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
	// This labels the schedule, not a thread created by payload.subject.
	const subject = String(form.subject ?? "").trim();
	if (subject && (!editing || subject !== editing.subject)) body.subject = subject;
	else if (!subject && editing && form.subject !== undefined) body.subject = null;
	if (when) {
		if (ISO_DATE.test(when)) body.at = when;
		else body.cron = when;
	}
	return body;
}
