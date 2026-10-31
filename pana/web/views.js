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

/**
 * UX-09: a thread's session participants with a wake pending, for the footer's scheduled chips.
 * A wake is a promise of later work, not work now, so these stay apart from the working set: the
 * soonest first, because that is the one the thread will get its next message from.
 */
export function scheduledOf(thread) {
	const participants = Array.isArray(thread?.participants) ? thread.participants : [];
	return participants
		.filter((participant) => participant?.kind === "session" && Number.isFinite(Number(participant.wake?.at)))
		.map((participant) => ({
			sessionId: String(participant.id ?? ""),
			url: String(participant.url ?? ""),
			at: Number(participant.wake.at),
			scheduleUrl: String(participant.wake.url ?? ""),
			subject: String(participant.wake.subject ?? ""),
			cron: participant.wake.cron === null || participant.wake.cron === undefined ? null : String(participant.wake.cron),
		}))
		.sort((a, b) => a.at - b.at || a.sessionId.localeCompare(b.sessionId));
}

/** How long until a pending wake, in the few words the scheduled chip has room for. */
export function untilLabel(at, now = Date.now()) {
	const ms = Number(at) - Number(now);
	if (!Number.isFinite(ms)) return "";
	if (ms <= 0) return "now";
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `in ${seconds}s`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `in ${minutes}m`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `in ${hours}h`;
	return `in ${Math.round(hours / 24)}d`;
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
		url: String(file?.url ?? ""),
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

/** Read-only diagnostics; check output is plain text, never prompt or HTML content. */
export function scheduleCheckView(schedule, formatTime = (time) => new Date(time).toLocaleString()) {
	const last = schedule.lastCheck;
	if (!schedule.check && !schedule.stopAfterSuccess && !last) return null;
	const statuses = { passed: "Passed", not_ready: "Not ready", failed: "Failed" };
	const status = last ? (statuses[last.status] ?? String(last.status)) : "Not checked yet";
	const lines = [
		"Check command:", schedule.check || "None (dispatch without a readiness check)",
		"", `Working directory: ${schedule.checkCwd ?? "Not configured"}`,
		`Stop after successful dispatch: ${schedule.stopAfterSuccess ? "Yes" : "No"}`,
		"", `Last check: ${last ? status : schedule.check ? "Not checked yet" : "No check recorded"}`,
	];
	if (last) lines.push(
		`Checked at: ${formatTime(last.checkedAt)}`,
		`Exit code: ${last.exitCode ?? "None"}`,
		`Signal: ${last.signal ?? "None"}`,
		`Error: ${last.error ?? "None"}`,
		"", "Standard output:", last.stdout || "(empty)",
		"", "Standard error:", last.stderr || "(empty)",
	);
	return { status, text: lines.join("\n") };
}

/**
 * One page of `GET /sessions/:id/transcript`: the entries oldest first, and the ID just before the
 * oldest one when older entries remain (UX-18). The route pages forward with `next` and backward
 * with `previous`; a window reads backward, from the newest entry.
 */
export function transcriptPage(body) {
	return {
		entries: Array.isArray(body?.entries) ? body.entries : [],
		previous: typeof body?.previous === "number" ? body.previous : undefined,
	};
}

// ---- Objectives (OBJ-39) ----------------------------------------------------------------------
// An objective is a goal, a charter, one lead, its members, and accounting (WP18). The list and the
// view read `GET /objectives` and `GET /objectives/:id`; the charter, the metrics, and each
// member's own session detail are their own reads, mapped here too.

/** OBJ-09: the six charter sections, in the order the charter renders them. */
export const CHARTER_SECTIONS = ["Scope", "Cancel", "Done", "Guidance", "Escalation", "Notes"];

/** OBJ-20..OBJ-22: a budget condition holding the objective, in the few words a badge has room for. */
export function holdingLabel(paused) {
	switch (paused) {
		case "budget_total":
			return "over its total budget";
		case "budget_day":
			return "over today's budget";
		case "domain_budget":
			return "domain budget spent";
		default:
			return "";
	}
}

/**
 * OBJ-03/OBJ-33: what is holding the objective. The derived state says whether anything is moving;
 * this says why it is not, which is the question a person looking at a quiet objective asks.
 */
export function holdingOf(objective) {
	if (typeof objective?.paused === "string" && objective.paused) return holdingLabel(objective.paused);
	if (objective?.awaitingUser) return "waiting for you";
	return "";
}

function amount(value) {
	const number = Number(value);
	return Number.isFinite(number) ? number : 0;
}

function optionalAmount(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function urlOf(person) {
	return String(person?.url ?? "");
}

/** One row of `GET /objectives` (OBJ-39): phase, derived state, holding condition, goal, lead, spend, runs. */
export function objectiveRow(objective) {
	const row = {
		id: String(objective?.id ?? ""),
		url: String(objective?.url ?? ""),
		goal: String(objective?.goal ?? "(no goal)"),
		phase: String(objective?.phase ?? "drafting"),
		/** OBJ-03: derived on read, null for a phase that is not `active`. */
		state: objective?.state === null || objective?.state === undefined ? null : String(objective.state),
		paused: typeof objective?.paused === "string" ? objective.paused : null,
		awaitingUser: Boolean(objective?.awaitingUser),
		holding: "",
		lead: urlOf(objective?.lead),
		spendTodayUsd: amount(objective?.spendTodayUsd),
		leadRunsToday: amount(objective?.leadRunsToday),
		dueAt: optionalAmount(objective?.dueAt),
		at: amount(objective?.updatedAt ?? objective?.createdAt),
	};
	row.holding = holdingOf(row);
	return row;
}

/**
 * OBJ-16..OBJ-24: the meters for money and runs. A null limit means the objective falls back to
 * the domain's configured default, which this app cannot read, so the meter says that instead of
 * drawing a bar against a limit it would have to invent.
 */
export function objectiveMeters(objective) {
	const limits = objective?.limits ?? {};
	const members = Array.isArray(objective?.members) ? objective.members : [];
	const active = members.filter((member) => isActiveMember(member?.state)).length;
	const meter = (id, label, value, limit, unit) => {
		const bounded = optionalAmount(limit);
		return {
			id,
			label,
			value: amount(value),
			limit: bounded,
			unit,
			share: bounded !== null && bounded > 0 ? Math.min(1, amount(value) / bounded) : null,
			// OBJ-20/OBJ-21: at or over the limit is what stops the objective, not only past it.
			over: bounded !== null && amount(value) >= bounded,
		};
	};
	return [
		meter("spend-today", "Spend today", objective?.spendTodayUsd, limits.maxDailyUsd, "usd"),
		meter("spend-total", "Spend in total", objective?.spendTotalUsd, limits.maxTotalUsd, "usd"),
		meter("runs-today", "Lead runs today", objective?.leadRunsToday, limits.maxDailyLeadTurns, "count"),
		meter("messages-today", "Messages to you today", objective?.userMessagesToday, limits.maxDailyUserMessages, "count"),
		meter("members", "Active members", active, limits.maxActiveMembers, "count"),
	];
}

/** OBJ-16: a member counts against the roster unless it is stopped or archived. */
export function isActiveMember(state) {
	return state !== "stopped" && state !== "archived";
}

/** One member of the roster: its session URL and its live state (UX-09). */
export function objectiveMember(member) {
	return {
		id: String(member?.id ?? ""),
		url: String(member?.url ?? ""),
		state: String(member?.state ?? "unknown"),
		lead: Boolean(member?.lead),
		stoppedBy: member?.stoppedBy === "user" || member?.stoppedBy === "objective" ? member.stoppedBy : null,
		profile: member?.profile === null || member?.profile === undefined ? null : String(member.profile),
	};
}

/** The message a `pana://` message URL names: the id rides in its query (REF-08). */
function messageIdOf(url) {
	const match = /[?&]message=([^&#]+)/.exec(String(url ?? ""));
	if (!match) return "";
	try {
		return decodeURIComponent(match[1]);
	} catch {
		return "";
	}
}

/** OBJ-33/OBJ-34: an open escalation, the message it asks in, and the thread whose answer clears it. */
export function objectiveEscalation(escalation) {
	return {
		id: String(escalation?.id ?? ""),
		scope: escalation?.scope === "member" ? "member" : "objective",
		member: urlOf(escalation?.member),
		url: String(escalation?.url ?? ""),
		messageId: messageIdOf(escalation?.url),
		threadUrl: String(escalation?.thread?.url ?? ""),
		threadId: String(escalation?.thread?.id ?? ""),
		timeoutAt: optionalAmount(escalation?.timeoutAt),
	};
}

/** OBJ-30: the newest report, which is a message in the objective's thread. */
export function objectiveReport(report) {
	if (!report || typeof report !== "object") return null;
	return {
		messageId: String(report.messageId ?? ""),
		url: String(report.url ?? ""),
		threadUrl: String(report.threadUrl ?? ""),
		sender: urlOf(report.sender),
		at: amount(report.createdAt),
		body: String(report.body ?? report.display ?? ""),
		revised: Boolean(report.revised),
		redacted: Boolean(report.redacted),
	};
}

/** OBJ-31: a linked file, with the name, size, and URL the view lists. */
export function objectiveArtifact(artifact) {
	return {
		id: String(artifact?.id ?? ""),
		name: String(artifact?.name ?? "file"),
		size: amount(artifact?.size),
		mediaType: artifact?.mediaType === null || artifact?.mediaType === undefined ? null : String(artifact.mediaType),
		url: String(artifact?.url ?? ""),
		addedAt: amount(artifact?.addedAt),
	};
}

/**
 * `GET /objectives/:id` (OBJ-39): everything the view shows about the objective itself. The charter,
 * the metrics, and each member's session are their own reads, mapped below.
 */
export function objectiveView(objective) {
	const view = {
		id: String(objective?.id ?? ""),
		url: String(objective?.url ?? ""),
		goal: String(objective?.goal ?? "(no goal)"),
		phase: String(objective?.phase ?? "drafting"),
		state: objective?.state === null || objective?.state === undefined ? null : String(objective.state),
		paused: typeof objective?.paused === "string" ? objective.paused : null,
		awaitingUser: Boolean(objective?.awaitingUser),
		holding: "",
		creator: urlOf(objective?.creator),
		proposedBy: urlOf(objective?.proposedBy) || null,
		lead: urlOf(objective?.lead) || null,
		thread: objective?.thread?.id ? { id: String(objective.thread.id), url: String(objective.thread.url ?? "") } : null,
		dueAt: optionalAmount(objective?.dueAt),
		autonomy: objective?.autonomy === "auto" ? "auto" : "manual",
		charterRev: amount(objective?.charterRev),
		limits: {
			maxDailyUsd: optionalAmount(objective?.limits?.maxDailyUsd),
			maxTotalUsd: optionalAmount(objective?.limits?.maxTotalUsd),
			wakeMinMinutes: optionalAmount(objective?.limits?.wakeMinMinutes),
			maxDailyLeadTurns: optionalAmount(objective?.limits?.maxDailyLeadTurns),
			maxDailyUserMessages: optionalAmount(objective?.limits?.maxDailyUserMessages),
			maxActiveMembers: optionalAmount(objective?.limits?.maxActiveMembers),
		},
		spendTodayUsd: amount(objective?.spendTodayUsd),
		spendTotalUsd: amount(objective?.spendTotalUsd),
		leadRunsToday: amount(objective?.leadRunsToday),
		userMessagesToday: amount(objective?.userMessagesToday),
		members: (Array.isArray(objective?.members) ? objective.members : []).map(objectiveMember),
		escalations: (Array.isArray(objective?.escalations) ? objective.escalations : []).map(objectiveEscalation),
		report: objectiveReport(objective?.report),
		artifacts: (Array.isArray(objective?.artifacts) ? objective.artifacts : []).map(objectiveArtifact),
		at: amount(objective?.updatedAt ?? objective?.createdAt),
	};
	view.meters = objectiveMeters(view);
	view.holding = holdingOf(view);
	return view;
}

/**
 * OBJ-28/OBJ-39: one metric's own line, its target, and its current value. There is no total across
 * metrics and no percent-to-target figure anywhere in this file, because a single averaged number
 * across mixed units becomes the only number the objective has.
 */
export function metricSeries(metric) {
	const readings = Array.isArray(metric?.readings) ? metric.readings : [];
	const points = readings
		.filter((reading) => Number.isFinite(Number(reading?.value)) && Number.isFinite(Number(reading?.at)))
		.map((reading) => ({ at: Number(reading.at), value: Number(reading.value), source: String(reading.source ?? "") }))
		// The route answers oldest first; sorting by time alone keeps that order for readings the
		// clock placed in the same millisecond, which a fast metric check can do.
		.sort((a, b) => a.at - b.at);
	const current = metric?.current ?? {};
	const check = metric?.check;
	return {
		name: String(metric?.name ?? ""),
		unit: String(metric?.unit ?? ""),
		direction: metric?.direction === "down" ? "down" : "up",
		target: optionalAmount(metric?.target),
		targetDisplay: metric?.targetDisplay === null || metric?.targetDisplay === undefined ? null : String(metric.targetDisplay),
		aggregation: metric?.aggregation === "mean" ? "mean" : "raw",
		window: metric?.window === null || metric?.window === undefined ? null : String(metric.window),
		baseline: optionalAmount(metric?.baseline),
		current: {
			value: optionalAmount(current.value),
			at: optionalAmount(current.at),
			// OBJ-27: a window with no readings is stale, never zero.
			stale: Boolean(current.stale),
			display: current.display === null || current.display === undefined ? null : String(current.display),
		},
		/** OBJ-27: at its target, false before the first reading, null with no target at all. */
		atTarget: metric?.atTarget === true ? true : metric?.atTarget === false ? false : null,
		frozen: Boolean(metric?.frozen),
		check: check
			? {
					command: String(check.command ?? ""),
					nextCheckAt: optionalAmount(check.nextCheckAt),
					lastCheck: check.lastCheck?.status === undefined ? null : String(check.lastCheck.status),
				}
			: null,
		points,
	};
}

/** `GET /objectives/:id/metrics` (OBJ-28): one series per metric and the count at target. */
export function metricsView(body) {
	const metrics = (Array.isArray(body?.metrics) ? body.metrics : []).map(metricSeries);
	return {
		objectiveId: String(body?.objective?.id ?? ""),
		url: String(body?.objective?.url ?? ""),
		phase: String(body?.objective?.phase ?? ""),
		// OBJ-28's "3 of 5 at target": a count of metrics, never a percentage.
		atTarget: { count: amount(body?.atTarget?.count), of: amount(body?.atTarget?.of) },
		metrics,
	};
}

function round(value) {
	return Math.round(value * 10) / 10;
}

/**
 * OBJ-28/OBJ-39: the drawing of one metric — a line through its readings and its target line —
 * in a box of the given size, with one value axis on which both are true. One chart per metric,
 * because an axis shared across mixed units would put a weight and a kilowatt-hour on one scale.
 */
export function metricChart(series, { width = 320, height = 64, pad = 6 } = {}) {
	const points = series?.points ?? [];
	const target = optionalAmount(series?.target);
	const values = points.map((point) => point.value);
	if (target !== null) values.push(target);
	if (values.length === 0) return { empty: true, line: "", target: null, min: null, max: null };
	let min = Math.min(...values);
	let max = Math.max(...values);
	// A flat metric, or a single reading, would divide by zero: open the axis around it.
	if (min === max) {
		min -= 1;
		max += 1;
	}
	const span = max - min;
	const first = points[0]?.at ?? 0;
	const last = points[points.length - 1]?.at ?? 0;
	const across = last - first;
	const inner = width - 2 * pad;
	const x = (point, index) => {
		if (across > 0) return pad + ((point.at - first) / across) * inner;
		if (points.length === 1) return width / 2;
		return pad + (index / (points.length - 1)) * inner;
	};
	const y = (value) => height - pad - ((value - min) / span) * (height - 2 * pad);
	const dots = points.map((point, index) => ({ x: round(x(point, index)), y: round(y(point.value)) }));
	return {
		empty: false,
		line: dots.map((dot) => `${dot.x},${dot.y}`).join(" "),
		// A single reading draws no line, so the view marks the one point it has.
		dots,
		target: target === null ? null : { y: round(y(target)), value: target },
		min,
		max,
		first: points[0]?.at ?? null,
		last: points[points.length - 1]?.at ?? null,
	};
}

/** `GET /objectives/:id/charter` (OBJ-09): every section's newest revision, and the revision to write from. */
export function charterView(body) {
	const sections = body?.sections ?? {};
	return {
		rev: amount(body?.rev),
		sections: CHARTER_SECTIONS.map((name) => {
			const section = sections[name] ?? null;
			return {
				name,
				body: section ? String(section.body ?? "") : "",
				rev: section ? amount(section.rev) : null,
				author: urlOf(section?.author),
				at: section ? optionalAmount(section.at) : null,
			};
		}),
		revisions: (Array.isArray(body?.revisions) ? body.revisions : []).map((revision) => ({
			id: String(revision?.id ?? ""),
			rev: amount(revision?.rev),
			section: String(revision?.section ?? ""),
			body: String(revision?.body ?? ""),
			author: urlOf(revision?.author),
			at: amount(revision?.at),
		})),
	};
}

/**
 * OBJ-09: the body of `POST /objectives/:id/charter`. `baseRev` is the revision the editor read,
 * so a charter that moved since then answers 409 instead of overwriting a change nobody saw.
 */
export function charterBody(section, body, baseRev) {
	const out = { section: String(section ?? ""), body: String(body ?? "") };
	if (typeof baseRev === "number" && Number.isFinite(baseRev)) out.baseRev = baseRev;
	return out;
}

/**
 * WAK-08 for an objective: its pending wakes, read from each member's own session detail, which is
 * where a session's pending wakes live. Ordered by next run, soonest first, like the session view.
 */
export function objectiveWakes(details) {
	const out = [];
	for (const detail of Array.isArray(details) ? details : []) {
		const session = detail?.session ?? {};
		const sessionId = String(session.id ?? "");
		for (const wake of Array.isArray(session.wakes) ? session.wakes : []) {
			if (!Number.isFinite(Number(wake?.nextAt))) continue;
			out.push({
				sessionId,
				sessionUrl: String(session.url ?? ""),
				id: String(wake.id ?? ""),
				url: String(wake.url ?? ""),
				subject: String(wake.subject ?? ""),
				at: amount(wake.nextAt),
				cron: wake.cron === null || wake.cron === undefined ? null : String(wake.cron),
			});
		}
	}
	return out.sort((a, b) => a.at - b.at || a.url.localeCompare(b.url));
}
