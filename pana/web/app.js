// The pana PWA (WEB-01..08, WP13). Plain ES modules, no framework: a hash router, one fetch
// wrapper, a renderer per section, and one keyboard module. The server owns auth (API-04); this
// file only carries the token.

import {
	CONFIRM_ARCHIVE_SESSION,
	CONFIRM_EDIT,
	CONFIRM_REDACT,
	TOKEN_KEY,
	appHref,
	idHref,
	newDraft,
	panaLinkSegments,
	routeFromHash,
	tokenFromInput,
} from "./links.js";
import { browserEnv, explainPush, subscribeToPush } from "./push.js";
import { nextCursor, pagePath, showMore } from "./pages.js";
import { createKeyReader, helpRows, isApplePlatform, isSubmitChord, isTextInput, moveSelection, sequenceLabel } from "./keys.js";
import {
	commitView,
	elapsedLabel,
	entryRaw,
	entryView,
	inboxThreadRow,
	isWorking,
	liveActivityLabel,
	memoryHitView,
	messageView,
	participantColor,
	refLabel,
	scheduleBody,
	scheduleWhen,
	shortTime,
	threadRow,
	workingParticipants,
} from "./views.js";
import { renderMessage } from "./render.js";

const $ = (id) => document.getElementById(id);

// The launch URL carries the token in the fragment. Store it, then clear the hash so a reload
// starts at a normal route. An installed app has its own storage, so a 403 opens the panel.
const launchToken = location.hash && !location.hash.startsWith("#/") ? location.hash.slice(1) : "";
if (launchToken) {
	localStorage.setItem(TOKEN_KEY, launchToken);
	history.replaceState(null, "", "/#/inbox");
}
let token = launchToken || localStorage.getItem(TOKEN_KEY) || "";

const APPLE = isApplePlatform(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent);

const state = {
	domain: "",
	domainResolved: undefined,
	section: "inbox",
	thread: null,
	threadArchived: false,
	session: null,
	draft: null,
	confirm: null,
	eventAbort: undefined,
	domainReady: undefined,
	/** The list a detail view returns to with Back (UX-08). */
	lastList: "#/inbox",
	/** threadId -> sessionId -> working session (UX-09), from responses and `session.state`. */
	working: new Map(),
	/**
	 * sessionId -> `{view, skew}` (UX-12): the work in progress from `session.live` or a response,
	 * and how far this clock runs ahead of panad's, so elapsed times are panad's.
	 */
	live: new Map(),
	push: undefined,
	workerError: "",
};

let statusTimer;
function status(text, error = false, link = undefined) {
	clearTimeout(statusTimer);
	const node = $("status");
	node.replaceChildren(document.createTextNode(text));
	if (link) {
		const anchor = document.createElement("a");
		anchor.href = link.href;
		anchor.textContent = link.label;
		anchor.dataset.testid = "status-link";
		node.append(" ", anchor);
	}
	node.classList.toggle("error", error);
	if (text && !error) {
		statusTimer = setTimeout(() => {
			node.textContent = "";
		}, 6000);
	}
}

function fail(error) {
	const message = error?.body?.error?.message ?? error?.message ?? String(error);
	status(message, true);
	if (error?.status === 403) showAuthorize();
}

// ---- HTTP -----------------------------------------------------------------------------------

async function raw(path, options = {}) {
	const headers = { ...(options.headers ?? {}) };
	if (token) headers.authorization = `Bearer ${token}`;
	const response = await fetch(path, { ...options, headers });
	return response;
}

async function api(method, path, body) {
	const options = { method };
	if (body !== undefined) {
		options.body = JSON.stringify(body);
		options.headers = { "content-type": "application/json" };
	}
	const response = await raw(path, options);
	const text = await response.text();
	let data;
	if (text) {
		try {
			data = JSON.parse(text);
		} catch {
			data = text;
		}
	}
	if (!response.ok) {
		const error = new Error(data?.error?.message ?? `${method} ${path} failed (${response.status})`);
		error.status = response.status;
		error.body = data;
		throw error;
	}
	return data;
}

async function fetchFile(path) {
	const response = await raw(path);
	if (!response.ok) {
		if (response.status === 403) showAuthorize();
		throw new Error(`file ${path} is not available`);
	}
	return response.blob();
}

// ---- Authorization --------------------------------------------------------------------------

function showAuthorize() {
	$("authorize").hidden = false;
}
function hideAuthorize() {
	$("authorize").hidden = true;
}

async function authorize(rawValue) {
	const candidate = tokenFromInput(rawValue);
	if (!candidate) {
		$("authorize-status").textContent = "That does not look like a launch URL or token.";
		return false;
	}
	const previous = token;
	token = candidate;
	try {
		await api("GET", "/push/key");
	} catch (error) {
		token = previous;
		$("authorize-status").textContent =
			error?.status === 403 ? "That token was rejected. Use the launch URL panad printed." : `Could not reach panad: ${error?.message ?? error}`;
		return false;
	}
	localStorage.setItem(TOKEN_KEY, candidate);
	$("authorize-status").textContent = "Authorized.";
	hideAuthorize();
	status("Authorized.");
	await boot();
	return true;
}

// ---- Live events (WEB-06) -------------------------------------------------------------------

function ensureDomain() {
	if (state.domainReady) return state.domainReady;
	state.domainReady = new Promise((resolve) => {
		const timer = setTimeout(resolve, 1000);
		state.domainResolved = () => {
			clearTimeout(timer);
			resolve();
		};
	});
	return state.domainReady;
}

function learnDomain(value) {
	if (state.domain) return;
	const match = /pana:\/\/([^/?#\s]+)/.exec(String(value ?? ""));
	if (match) {
		state.domain = match[1];
		state.domainResolved?.();
	}
}

function handleEvent(event) {
	if (event.kind === "hello") {
		if (typeof event.domain === "string") state.domain = event.domain;
		state.domainResolved?.();
		return;
	}
	// UX-09: who is working changes in the open thread and in the lists, without a reload.
	if (event.kind === "session.state" && typeof event.sessionId === "string") {
		applyStateEvent(event);
		return;
	}
	// UX-12: work in progress. It carries no entry, so it must not fall through to a reload.
	if (event.kind === "session.live" && typeof event.sessionId === "string") {
		rememberLive(event.sessionId, event.live, event.at);
		liveChanged(event.sessionId);
		return;
	}
	if (event.kind?.startsWith("session.") && event.sessionId && event.sessionId === state.session?.id) {
		if (event.entry) appendEntry(event.entry);
		else void loadTranscript();
		return;
	}
	if (event.kind !== "delivery" && event.kind !== "notice") return;
	// REF-06: the inbox list and the nav count both follow `/events`, even when another
	// section is open.
	void refreshUnread().catch(() => {});
	if (state.section === "inbox") void loadInbox();
	// Show new mail in the open thread, but only while no reply is drafted: reopening moves the
	// draft head, and a draft in progress must keep its head so a stale send gets WEB-07's 409.
	if (state.section === "threads" && event.threadId === state.thread?.id && !$("thread").hidden && !$("reply-body").value.trim()) {
		void openThread(state.thread.id).catch(fail);
	}
}

function handleChunk(chunk) {
	let data = "";
	for (const line of chunk.split("\n")) {
		if (line.startsWith("data:")) data += line.slice(5).trim();
	}
	if (!data) return;
	try {
		handleEvent(JSON.parse(data));
	} catch {
		// A malformed frame is not worth tearing the stream down for.
	}
}

let eventGeneration = 0;

async function startEvents() {
	if (!token) return;
	stopEvents();
	const generation = ++eventGeneration;
	const controller = new AbortController();
	state.eventAbort = controller;
	let retry = true;
	try {
		const response = await fetch("/events", {
			headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
			signal: controller.signal,
		});
		if (response.status === 403) {
			if (generation === eventGeneration) showAuthorize();
			return;
		}
		if (!response.ok || !response.body) return;
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			if (generation !== eventGeneration) return;
			buffer += decoder.decode(value, { stream: true });
			let boundary;
			while ((boundary = buffer.indexOf("\n\n")) >= 0) {
				handleChunk(buffer.slice(0, boundary));
				buffer = buffer.slice(boundary + 2);
			}
		}
	} catch {
		if (controller.signal.aborted || generation !== eventGeneration) retry = false;
	}
	if (retry && !controller.signal.aborted && generation === eventGeneration) setTimeout(() => void startEvents(), 3000);
}

function stopEvents() {
	eventGeneration++;
	state.eventAbort?.abort();
	state.eventAbort = undefined;
}

function appendEntry(entry) {
	const transcript = $("transcript");
	// A live entry can also arrive in the transcript a reload just fetched.
	if (entry.id !== undefined && transcript.querySelector(`[data-entry-id="${entry.id}"]`)) return;
	transcript.querySelector(".hint")?.remove();
	// Follow new entries only when the reader is already at the bottom, so reading back is undisturbed.
	const following = nearBottom();
	transcript.append(entryElement(entry));
	// UX-12: the committed entry replaces the in-progress block it came from.
	if (state.session && settleLive(state.session.id, entry)) renderLive();
	if (following) scrollToLatest();
}

function nearBottom() {
	const root = document.scrollingElement ?? document.documentElement;
	return root.scrollHeight - root.scrollTop - root.clientHeight < 120;
}

/** Opening a session lands on its newest entries; the sticky header keeps its controls in view. */
function scrollToLatest() {
	const root = document.scrollingElement ?? document.documentElement;
	root.scrollTop = root.scrollHeight;
}

// ---- Helpers --------------------------------------------------------------------------------

function asList(body, keys) {
	if (Array.isArray(body)) return body;
	if (!body || typeof body !== "object") return [];
	for (const key of keys) if (Array.isArray(body[key])) return body[key];
	return [];
}

function span(text, className) {
	const node = document.createElement("span");
	if (className) node.className = className;
	node.textContent = text;
	return node;
}

/**
 * One list row. The row is a focusable element with a click handler rather than a <button>,
 * because rows hold links (REF-08) and a button may not contain interactive content. Row actions
 * sit beside the row's text inside the same box (REF-07, UX-07).
 */
function item(title, meta, onClick, extra = {}) {
	const row = document.createElement("div");
	row.className = `item${extra.actions?.length ? " row" : ""}${extra.unread ? " unread" : ""}${extra.archived ? " archived" : ""}`;
	row.tabIndex = 0;
	row.setAttribute("role", "listitem");
	row.dataset.selectable = "";
	if (extra.testid) row.dataset.testid = extra.testid;
	if (extra.threadId) row.dataset.thread = extra.threadId;
	if (extra.sessionId) row.dataset.session = extra.sessionId;
	if (extra.id) row.dataset.id = extra.id;
	const main = document.createElement("div");
	main.className = "item-main";
	const titleEl = document.createElement("span");
	titleEl.className = "title";
	if (typeof title === "string") titleEl.textContent = title;
	else titleEl.append(title);
	main.append(titleEl);
	if (meta) {
		const metaEl = document.createElement("span");
		metaEl.className = "meta";
		for (const part of meta) {
			if (part === undefined || part === null || part === "") continue;
			if (part instanceof Node) metaEl.append(part);
			else metaEl.append(span(String(part)));
		}
		main.append(metaEl);
	}
	if (extra.below) main.append(extra.below);
	row.append(main);
	if (extra.aside) row.append(extra.aside);
	if (extra.actions?.length) {
		const actions = document.createElement("div");
		actions.className = "item-actions";
		actions.append(...extra.actions);
		row.append(actions);
	}
	row.addEventListener("click", (event) => {
		// A link or an action inside the row does its own thing.
		if (event.target?.closest?.("a, button")) return;
		onClick(event);
	});
	return row;
}

/** A link to an ID's own view (REF-08), or plain text when the ID has no view here. */
function refLink(value, kind, label, title) {
	const text = String(value ?? "");
	if (!text) return document.createTextNode("");
	const href = text.startsWith("pana://") ? appHref(text, state.domain) : idHref(text, kind);
	if (!href) return document.createTextNode(label ?? text);
	const anchor = document.createElement("a");
	anchor.href = href;
	anchor.textContent = label ?? text;
	if (title) anchor.title = title;
	anchor.dataset.testid = "ref-link";
	if (/^https?:/i.test(href)) {
		anchor.target = "_blank";
		anchor.rel = "noopener noreferrer";
	}
	return anchor;
}

/** A participant as a short, colored name that links to its view (REF-08, UX-06). */
function personLink(person) {
	const url = typeof person === "string" ? person : person.url;
	const link = refLink(url, "user", refLabel(url), url);
	const wrap = span("", "person");
	wrap.dataset.color = participantColor(person);
	wrap.append(link);
	return wrap;
}

/** Text with every `pana://` URL inside it turned into a link to its view (REF-08). */
function linkified(text) {
	const fragment = document.createDocumentFragment();
	for (const segment of panaLinkSegments(text, state.domain)) {
		if (!segment.href) {
			fragment.append(document.createTextNode(segment.text));
			continue;
		}
		const anchor = document.createElement("a");
		anchor.href = segment.href;
		anchor.textContent = segment.text;
		anchor.dataset.testid = "ref-link";
		fragment.append(anchor);
	}
	return fragment;
}

function when(value) {
	if (value === undefined || value === null || value === "") return "";
	const date = new Date(Number(value));
	return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function timeEl(value) {
	const node = document.createElement("time");
	node.className = "when";
	node.textContent = shortTime(value);
	node.title = when(value);
	const date = new Date(Number(value));
	if (!Number.isNaN(date.getTime())) node.dateTime = date.toISOString();
	return node;
}

function empty(container, text) {
	container.replaceChildren();
	const p = document.createElement("p");
	p.className = "hint";
	p.textContent = text;
	container.append(p);
}

function badge(text) {
	return span(text, `badge ${text}`);
}

function unreadBadge(count) {
	const node = span(`${count} unread`, "unread-count");
	node.dataset.testid = "unread-count";
	return node;
}

// ---- Working sessions (UX-09) ------------------------------------------------------------------

/** threadId -> sessionId -> the session that is working in that thread. */
function workingMap(threadId) {
	let map = state.working.get(threadId);
	if (!map) {
		map = new Map();
		state.working.set(threadId, map);
	}
	return map;
}

/** Take a thread's working set from a response, so a reload drops a session that stopped. */
function rememberWorking(threadId, working) {
	const map = workingMap(threadId);
	map.clear();
	for (const session of working ?? []) map.set(session.sessionId, session);
	return map;
}

/** A list row's small working mark. It stays in the row and hides when nothing works. */
function workingMark() {
	const mark = span("", "working-mark");
	mark.dataset.testid = "working-mark";
	mark.dataset.color = "blue";
	mark.title = "A session is working";
	mark.hidden = true;
	return mark;
}

/** Redraw one row's mark from the thread's working set, in the first working session's color. */
function syncWorkingMark(row, threadId = row.dataset.thread) {
	const mark = row.querySelector("[data-testid=working-mark]");
	if (!mark || !threadId) return;
	const working = [...workingMap(threadId).values()];
	mark.hidden = working.length === 0;
	if (working.length === 0) return;
	mark.dataset.color = participantColor({ url: working[0].url, kind: "session" });
	mark.title = `${working.map((session) => refLabel(session.url)).join(", ")} working`;
}

/** A window heard one session change state (UX-09). */
function applyStateEvent(event) {
	const next = String(event.state ?? "");
	const sessionId = String(event.sessionId);
	if (!isWorking(next) && state.live.delete(sessionId) && state.session?.id === sessionId) renderLive();
	// The open session's header follows too, so a finished run does not still read "running".
	if (state.session?.id === sessionId && next) {
		state.session.state = next;
		$("session-meta").querySelector(".badge")?.replaceWith(badge(next));
	}
	for (const threadId of Array.isArray(event.threadIds) ? event.threadIds.map(String) : []) {
		const map = workingMap(threadId);
		if (isWorking(next)) map.set(sessionId, { sessionId, url: String(event.url ?? ""), state: next });
		else map.delete(sessionId);
		workingChanged(threadId);
	}
}

function workingChanged(threadId) {
	for (const row of document.querySelectorAll(`[data-thread="${CSS.escape(threadId)}"]`)) syncWorkingMark(row, threadId);
	if (state.thread?.id === threadId) renderThreadWorking();
}

/** The bottom of a thread, just above the reply box: the sessions working now, in their colors. */
function renderThreadWorking() {
	const node = $("thread-working");
	const threadId = state.thread?.id;
	const working = threadId ? [...workingMap(threadId).values()] : [];
	node.replaceChildren();
	if (working.length === 0) {
		node.hidden = true;
		return;
	}
	node.append(span("Working", "working-label"));
	for (const session of working) node.append(workingChip(session));
	node.hidden = false;
}

function workingChip(session) {
	const chip = span("", "working-chip");
	chip.dataset.testid = "working-session";
	chip.dataset.session = session.sessionId;
	chip.dataset.color = participantColor({ url: session.url, kind: "session" });
	chip.title = `${refLabel(session.url)} is ${session.state}`;
	chip.append(span("", "working-dot"));
	chip.append(refLink(session.url, "session", refLabel(session.url)));
	// UX-12: what the session is doing, e.g. "running bash · 3m".
	const live = state.live.get(session.sessionId);
	if (live) {
		const activity = span("", "working-activity");
		activity.dataset.testid = "working-activity";
		tickingLabel(activity, live, (now) => liveActivityLabel(live.view, now));
		chip.append(activity);
	}
	return chip;
}

// ---- Work in progress (UX-12) -----------------------------------------------------------------

/** Keep a session's live view, with this clock's lead over panad's from the view's own time. */
function rememberLive(sessionId, view, at) {
	if (!view) {
		state.live.delete(sessionId);
		return;
	}
	const stamp = Number(view.at ?? at);
	state.live.set(sessionId, { view, skew: Number.isFinite(stamp) ? Date.now() - stamp : 0 });
}

/** A label that recomputes from panad's clock each second while it is on the page. */
function tickingLabel(node, live, render) {
	node.dataset.ticking = "true";
	node.__render = () => {
		node.textContent = render(Date.now() - live.skew);
	};
	node.__render();
}

setInterval(() => {
	for (const node of document.querySelectorAll("[data-ticking]")) node.__render?.();
}, 1000);

function liveChanged(sessionId) {
	if (state.session?.id === sessionId) renderLive();
	for (const [threadId, map] of state.working) if (map.has(sessionId)) workingChanged(threadId);
}

/**
 * A committed entry landed: drop the in-progress block it replaces, before the next `session.live`
 * says so. Returns whether anything was dropped.
 */
function settleLive(sessionId, entry) {
	const live = state.live.get(sessionId)?.view;
	if (!live) return false;
	let changed = false;
	if (entry.kind === "pi.assistant" && live.generation) {
		live.generation = undefined;
		changed = true;
	}
	const done = new Set();
	for (const message of Array.isArray(entry.model) ? entry.model : []) if (message?.role === "toolResult") done.add(message.toolCallId);
	if (done.size > 0 && Array.isArray(live.tools)) {
		const kept = live.tools.filter((tool) => !done.has(tool.callId));
		changed ||= kept.length !== live.tools.length;
		live.tools = kept;
	}
	return changed;
}

/** The open session's work in progress, below its committed transcript. */
function renderLive() {
	const node = $("transcript-live");
	const live = state.session ? state.live.get(state.session.id) : undefined;
	node.replaceChildren();
	const view = live?.view;
	const tools = Array.isArray(view?.tools) ? view.tools.filter((tool) => tool.status !== "done") : [];
	const blocks = Array.isArray(view?.generation?.blocks) ? view.generation.blocks : [];
	if (!view || (blocks.length === 0 && tools.length === 0 && !view.generation?.retryAt)) {
		node.hidden = true;
		return;
	}
	const following = nearBottom();
	if (view.generation && (blocks.length > 0 || view.generation.retryAt)) {
		const div = document.createElement("div");
		div.className = "entry live";
		div.dataset.testid = "live-generation";
		div.dataset.role = "assistant";
		const meta = span("", "entry-meta");
		tickingLabel(meta, live, (now) => ["assistant", "in progress", liveActivityLabel(view, now)].join(" · "));
		const body = document.createElement("div");
		body.className = "entry-body";
		for (const block of blocks) {
			if (block.type === "toolCall") {
				body.append(blockElement({ type: "tool-call", name: block.name, arguments: block.arguments }));
				continue;
			}
			// Live thinking stays open: watching it stream is the point of this block.
			const element = blockElement({ type: block.type, text: block.text, markdown: true }, { open: true });
			element.dataset.testid = block.type === "thinking" ? "live-thinking" : "live-text";
			body.append(element);
		}
		if (view.generation.retryAt) body.append(span(`Retrying: ${view.generation.retryError ?? "provider error"}`, "live-retry"));
		div.append(meta, body);
		node.append(div);
	}
	for (const tool of tools) node.append(liveToolElement(tool, live));
	node.hidden = false;
	// Output streams at the bottom, so its box shows the newest lines.
	for (const output of node.querySelectorAll(".live-output")) output.scrollTop = output.scrollHeight;
	if (following) scrollToLatest();
}

function liveToolElement(tool, live) {
	const div = document.createElement("div");
	div.className = "entry live";
	div.dataset.testid = "live-tool";
	div.dataset.role = "tool";
	div.dataset.tool = String(tool.name ?? "");
	div.dataset.callId = String(tool.callId ?? "");
	const meta = span("", "entry-meta");
	const label = tool.status === "running" ? "running" : "pending";
	if (typeof tool.startedAt === "number") {
		tickingLabel(meta, live, (now) => `${tool.name} · ${label} · ${elapsedLabel(now - tool.startedAt)}`);
	} else {
		meta.textContent = `${tool.name} · ${label}`;
	}
	meta.dataset.testid = "live-tool-meta";
	const body = document.createElement("div");
	body.className = "entry-body";
	body.append(blockElement({ type: "tool-call", name: tool.name, arguments: tool.arguments ?? {} }));
	const output = document.createElement("pre");
	output.className = "live-output";
	output.dataset.testid = "live-tool-output";
	const dropped = Number(tool.droppedBytes ?? 0);
	output.textContent = `${dropped > 0 ? `[${dropped} earlier bytes not shown]\n` : ""}${tool.output ?? ""}`;
	body.append(output);
	div.append(meta, body);
	return div;
}

// ---- Inbox (UX-03) --------------------------------------------------------------------------

// Live events can start several loads at once, and their answers can arrive out of order. Only
// the newest load may draw, or an older answer would leave a stale list or badge behind.
let unreadGeneration = 0;
let inboxGeneration = 0;

/** REF-06: the nav badge is the caller's unread delivery count across every thread. */
async function refreshUnread(archived = false, cursor) {
	const generation = archived ? -1 : ++unreadGeneration;
	const body = await api("GET", pagePath(`/inbox?view=threads${archived ? "&archived=1" : ""}`, cursor));
	const items = asList(body, ["threads"]);
	// SCALE-03: the inbox is paged, so the server counts the unread deliveries past this page too.
	const unread = typeof body?.unreadTotal === "number" ? body.unreadTotal : items.reduce((sum, thread) => sum + (thread.unreadCount ?? 0), 0);
	const badge = $("nav-inbox-count");
	// The archived view is not the inbox, so it never rewrites the badge.
	if (badge && generation === unreadGeneration) {
		badge.textContent = String(unread);
		badge.hidden = unread === 0;
	}
	return { items, unread, body };
}

async function loadInbox(cursor) {
	// REF-07: the same view shows the archived threads, so Unarchive has a home in the inbox.
	const showArchived = Boolean($("inbox-archived")?.checked);
	const generation = cursor ? inboxGeneration : ++inboxGeneration;
	const { items, body } = await refreshUnread(showArchived, cursor);
	if (generation !== inboxGeneration) return;
	const list = $("inbox-list");
	if (!cursor) list.replaceChildren();
	if (items.length === 0 && !cursor) {
		return empty(list, showArchived ? "No archived threads." : "No messages yet. Compose one to start a thread.");
	}
	for (const raw of items) list.append(inboxItem(inboxThreadRow(raw), showArchived));
	showMore(list, nextCursor(body), (next) => loadInbox(next).catch(fail));
}

function inboxItem(row, showArchived) {
	learnDomain(row.threadUrl);
	// The reader is in every thread of their own inbox, so the row names the others.
	const others = row.participants.filter((person) => person.kind !== "user");
	const people = span("", "people");
	for (const person of others) people.append(personLink(person));
	const snippet = document.createElement("span");
	snippet.className = "snippet";
	snippet.dataset.testid = "inbox-snippet";
	const who = span(`${row.sender.kind === "user" ? "You" : refLabel(row.sender.url)}: `, "snippet-sender");
	who.dataset.color = participantColor(row.sender);
	snippet.append(who, document.createTextNode(row.snippet));
	const aside = document.createElement("div");
	aside.className = "item-aside";
	aside.append(timeEl(row.at));
	const archive = showArchived
		? rowAction("inbox-unarchive", "Unarchive", () => void archiveThread(row.threadId, false))
		: rowAction("inbox-archive", "Archive", () => void archiveThread(row.threadId, true));
	const node = item(
		row.subject,
		[people, row.unreadCount > 0 ? unreadBadge(row.unreadCount) : undefined],
		() => {
			location.hash = `#/threads/${row.threadId}`;
		},
		{
			unread: row.unreadCount > 0,
			archived: showArchived,
			testid: "inbox-item",
			threadId: row.threadId,
			id: row.messageId,
			below: snippet,
			aside,
			actions: [archive],
		},
	);
	// UX-09: a row marks the thread while one of its sessions works.
	rememberWorking(row.threadId, row.working);
	node.querySelector(".title")?.append(workingMark());
	syncWorkingMark(node);
	return node;
}

function rowAction(testid, label, onClick) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "row-action";
	button.dataset.testid = testid;
	button.dataset.action = testid;
	button.textContent = label;
	button.addEventListener("click", (event) => {
		event.stopPropagation();
		onClick();
	});
	return button;
}

/** REF-07: archive or unarchive one thread, then refresh whatever list is showing. */
async function archiveThread(threadId, archived) {
	try {
		await api("POST", `/threads/${threadId}/${archived ? "archive" : "unarchive"}`, {});
		status(archived ? "Archived." : "Unarchived.");
		if (state.section === "threads" && state.thread?.id === threadId && !$("thread").hidden) await openThread(threadId);
		await refreshUnread().catch(() => {});
		if (state.section === "inbox") await loadInbox();
		else if (state.section === "threads" && $("thread").hidden) await searchThreads();
	} catch (error) {
		fail(error);
	}
}

// ---- Compose --------------------------------------------------------------------------------

async function submitCompose(event) {
	event.preventDefault();
	const to = $("compose-to")
		.value.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
	const body = $("compose-body").value;
	if (!body.trim()) return status("Write a message first.", true);
	const subject = $("compose-subject").value.trim();
	try {
		const created = await api("POST", "/sessions", {
			prompt: body,
			...(to.length > 0 ? { to } : {}),
			...(subject ? { subject } : {}),
		});
		const threadId = created?.thread?.id;
		const sessionId = created?.session?.id;
		$("compose-to").value = "";
		$("compose-subject").value = "";
		$("compose-body").value = "";
		status("Started a session.");
		location.hash = threadId ? `#/threads/${threadId}` : sessionId ? `#/sessions/${sessionId}` : "#/threads";
	} catch (error) {
		fail(error);
	}
}

// ---- Threads --------------------------------------------------------------------------------

async function searchThreads(event, cursor) {
	event?.preventDefault();
	const query = $("threads-query").value.trim();
	const params = new URLSearchParams();
	if (query) params.set("query", query);
	if ($("threads-archived")?.checked) params.set("archived", "1");
	if ($("threads-unread")?.checked) params.set("unread", "1");
	const suffix = params.toString();
	const body = await api("GET", pagePath(`/threads${suffix ? `?${suffix}` : ""}`, cursor));
	const list = $("threads-list");
	if (!cursor) list.replaceChildren();
	const threads = asList(body, ["threads"]);
	if (threads.length === 0 && !cursor) return empty(list, query ? `No threads match “${query}”.` : "No threads yet.");
	// A later page can hit a thread an earlier page listed.
	const seen = new Set([...list.querySelectorAll("[data-thread]")].map((element) => element.dataset.thread));
	for (const hit of threads) {
		const thread = threadRow(hit);
		// A search returns one hit per matching message; list each thread once.
		if (seen.has(thread.id)) continue;
		seen.add(thread.id);
		learnDomain(thread.url);
		const archive = rowAction(thread.archived ? "thread-unarchive" : "thread-archive", thread.archived ? "Unarchive" : "Archive", () =>
			void archiveThread(thread.id, !thread.archived),
		);
		const aside = document.createElement("div");
		aside.className = "item-aside";
		aside.append(timeEl(thread.at));
		const row = item(
			thread.subject,
			[thread.unreadCount > 0 ? unreadBadge(thread.unreadCount) : undefined, thread.archived ? badge("archived") : undefined, thread.snippet],
			() => {
				location.hash = `#/threads/${thread.id}`;
			},
			{ testid: "thread-item", threadId: thread.id, unread: thread.unreadCount > 0, archived: thread.archived, aside, actions: [archive] },
		);
		// UX-09: a row marks the thread while one of its sessions works.
		rememberWorking(thread.id, thread.working);
		row.querySelector(".title")?.append(workingMark());
		syncWorkingMark(row);
		list.append(row);
	}
	showMore(list, nextCursor(body), (next) => searchThreads(undefined, next).catch(fail));
}

async function messageElement(message, { focus }) {
	const view = messageView(message);
	learnDomain(view.sender);
	const article = document.createElement("article");
	article.className = "message";
	article.tabIndex = -1;
	article.dataset.testid = "message";
	article.dataset.id = view.id ?? "";
	article.dataset.sender = view.sender;
	// UX-06: the left border is the sender's own color in every thread.
	article.dataset.color = participantColor({ url: view.sender, kind: view.senderKind });

	const header = document.createElement("header");
	const sender = view.sender ? refLink(view.sender, "user", refLabel(view.sender), view.sender) : document.createTextNode("unknown sender");
	if (sender instanceof HTMLElement) {
		sender.dataset.testid = "message-sender";
		sender.classList.add("sender");
	}
	const messageLink = refLink(view.url ?? `${view.threadId}`, "thread", `#${String(view.id ?? "").slice(-6)}`);
	if (messageLink instanceof HTMLElement) messageLink.dataset.testid = "message-link";
	header.append(sender, timeEl(view.at), messageLink);
	if (view.revised) header.append(span("edited", "badge"));

	// UX-04: edit and redact are small secondary controls in the header, not full buttons.
	const actions = document.createElement("span");
	actions.className = "message-actions";
	for (const [action, label] of [
		["edit", "Edit"],
		["redact", "Redact"],
	]) {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "link-button";
		button.dataset.action = action;
		button.dataset.id = view.id ?? "";
		button.dataset.testid = `message-${action}`;
		button.textContent = label;
		button.addEventListener("click", () => startConfirm(action, view, article));
		actions.append(button);
	}
	header.append(actions);
	article.append(header);

	const body = document.createElement("div");
	body.className = "body";
	const { marked, DOMPurify } = window.MailRenderers ?? {};
	if (view.redacted) {
		body.textContent = "[redacted]";
		article.append(body);
	} else {
		article.append(body);
		await renderMessage(body, view.body, {
			marked,
			DOMPurify,
			domain: state.domain,
			fetchFile,
			ensureMermaid,
			idPrefix: `diagram-${view.id ?? "x"}`,
			dark: matchMedia("(prefers-color-scheme: dark)").matches,
		});
	}

	if (focus) article.classList.add("focus");
	return article;
}

/** Put the edit and redact form back in its hidden home before the messages are replaced. */
function parkConfirm() {
	$("confirm").hidden = true;
	$("edit-field").hidden = true;
	$("confirm-home").append($("confirm"));
	state.confirm = null;
}

async function openThread(id, focusMessage) {
	const body = await api("GET", `/threads/${id}`);
	const thread = body.thread;
	const messages = body.messages ?? [];
	state.thread = thread;
	state.threadArchived = Boolean(body.archived);
	learnDomain(thread?.url);

	const draft = newDraft({ id, messages });
	const stored = sessionStorage.getItem(`pana-draft:${id}`);
	if (stored) draft.body = stored;
	state.draft = draft;
	$("reply-body").value = draft.body;
	$("draft-head").textContent = draft.after ?? "(no messages yet)";
	$("stale").hidden = true;
	$("stale-new").replaceChildren();
	parkConfirm();

	$("thread-subject").textContent = thread?.subject ?? "(no subject)";
	const threadUrl = $("thread-url");
	threadUrl.replaceChildren(refLink(thread?.url ?? id, "thread"));
	// REF-08 and UX-06: participants are colored links to their own views.
	const participants = $("thread-participants");
	participants.replaceChildren();
	for (const participant of thread?.participants ?? []) {
		participants.append(personLink(typeof participant === "object" ? participant : { url: participant }));
	}
	// UX-09: the response says who is working now, so an opened thread is right before any event.
	const working = workingMap(id);
	working.clear();
	for (const session of workingParticipants(thread)) working.set(session.sessionId, session);
	// UX-12: what each working session is doing now; a fuller view from `session.live` is kept.
	for (const participant of thread?.participants ?? []) {
		if (participant?.kind !== "session") continue;
		if (!participant.activity) state.live.delete(participant.id);
		else if (!state.live.get(participant.id)?.view?.tools) rememberLive(participant.id, participant.activity);
	}
	renderThreadWorking();
	// REF-07: one toggle, labelled for the thread's state for this reader.
	const archiveButton = $("thread-archive");
	archiveButton.dataset.archived = String(Boolean(body.archived));
	archiveButton.textContent = body.archived ? "Unarchive" : "Archive";
	archiveButton.dataset.testid = body.archived ? "thread-unarchive" : "thread-archive";
	const container = $("thread-messages");
	container.replaceChildren();
	for (const message of messages) {
		container.append(await messageElement(message, { focus: message.id === focusMessage }));
	}
	if (messages.length === 0) empty(container, "No messages yet.");

	document.querySelector("#thread .back")?.setAttribute("href", state.lastList);
	$("threads-browse").hidden = true;
	$("threads-list").hidden = true;
	$("thread").hidden = false;
	// UX-05: land on the linked message, or else on the newest one.
	const target = (focusMessage && container.querySelector(".focus")) || container.querySelector("[data-testid=message]:last-of-type");
	if (target) {
		select(target, { scroll: false });
		target.scrollIntoView({ block: focusMessage ? "center" : "start" });
	}
	if (focusMessage) await api("POST", `/messages/${focusMessage}/read`).catch(() => {});
	// REF-06: reading the thread clears its unread count.
	await refreshUnread().catch(() => {});
}

async function submitReply(event) {
	event.preventDefault();
	const draft = state.draft;
	if (!draft) return status("Open a thread first.", true);
	const text = $("reply-body").value;
	if (!text.trim()) return status("Write a reply first.", true);
	draft.body = text;
	sessionStorage.setItem(`pana-draft:${draft.threadId}`, text);
	try {
		await api("POST", `/threads/${draft.threadId}/messages`, { body: text, after: draft.after });
	} catch (error) {
		if (error?.status === 409) {
			await showStale(error, draft);
			return;
		}
		return fail(error);
	}
	sessionStorage.removeItem(`pana-draft:${draft.threadId}`);
	status("Replied.");
	await openThread(draft.threadId);
}

/**
 * WEB-07: the draft's head is stale. Show the messages that arrived after it and keep the text
 * the user typed. The next send records the new head.
 */
async function showStale(error, draft) {
	const body = await api("GET", `/threads/${draft.threadId}`);
	const thread = body.thread;
	const messages = body.messages ?? [];
	const newerIds = new Set((Array.isArray(error?.body?.error?.newer) ? error.body.error.newer : []).map(String));
	const headIndex = messages.findIndex((message) => message.id === draft.after);
	const newer = headIndex === -1 ? messages.filter((message) => newerIds.has(message.id)) : messages.slice(headIndex + 1);
	const container = $("stale-new");
	container.replaceChildren();
	for (const message of newer) container.append(await messageElement(message, {}));
	$("stale").hidden = false;
	$("reply-body").value = $("reply-body").value || draft.body;
	state.thread = thread;
	const newest = messages[messages.length - 1]?.id;
	if (newest) {
		draft.after = newest;
		$("draft-head").textContent = newest;
	}
	status("The thread moved. Your draft is kept; the next reply lands after the new messages.");
}

/** WEB-08: the confirmation opens inside the message it acts on (UX-07). */
function startConfirm(action, message, article) {
	state.confirm = { action, messageId: message.id, original: message.body };
	$("confirm-text").textContent = action === "redact" ? CONFIRM_REDACT : CONFIRM_EDIT;
	$("edit-field").hidden = action !== "edit";
	$("edit-body").value = action === "edit" ? message.body : "";
	$("confirm-yes").textContent = action === "redact" ? "Redact" : "Save edit";
	(article ?? $("confirm-home")).append($("confirm"));
	$("confirm").hidden = false;
	if (action === "edit") $("edit-body").focus();
	else $("confirm-yes").focus();
}

async function confirmAction(event) {
	event?.preventDefault();
	const pending = state.confirm;
	if (!pending) return;
	const editBody = pending.action === "edit" ? $("edit-body").value : undefined;
	parkConfirm();
	try {
		if (pending.action === "redact") {
			await api("POST", `/messages/${pending.messageId}/redact`, {});
		} else {
			await api("POST", `/messages/${pending.messageId}/revisions`, { body: editBody });
		}
		status(pending.action === "redact" ? "Redacted." : "Edited.");
		if (state.thread) await openThread(state.thread.id, pending.messageId);
	} catch (error) {
		fail(error);
	}
}

function cancelAction() {
	parkConfirm();
}

// ---- Sessions -------------------------------------------------------------------------------

async function loadSessionList(query = "", cursor) {
	const body = await api("GET", pagePath(`/sessions?query=${encodeURIComponent(query)}`, cursor));
	const list = document.querySelector("#sessions-list");
	if (!cursor) list.replaceChildren();
	const sessions = asList(body, ["sessions"]);
	if (sessions.length === 0 && !cursor) return empty(list, query ? `No sessions match “${query}”.` : "No sessions yet.");
	for (const session of sessions) {
		learnDomain(session.url);
		const title = document.createDocumentFragment();
		const swatch = span("", "person");
		swatch.dataset.color = participantColor({ url: session.url ?? "", kind: "session" });
		swatch.append(refLink(session.url ?? session.id, "session", session.id, session.url));
		title.append(badge(session.state ?? "unknown"), swatch);
		const aside = document.createElement("div");
		aside.className = "item-aside";
		aside.append(timeEl(session.updatedAt));
		const row = item(
			title,
			[
				session.model,
				session.parent ? refLink(session.parentUrl ?? session.parent, "session", `parent ${refLabel(session.parentUrl ?? "") || session.parent}`) : undefined,
				cost(session.costUsd),
				session.snippet,
			],
			() => {
				location.hash = `#/sessions/${session.id}`;
			},
			{ testid: "session-item", sessionId: session.id, aside },
		);
		list.append(row);
	}
	showMore(list, nextCursor(body), (next) => loadSessionList(query, next).catch(fail));
}

async function openSession(id) {
	const [body, transcript] = await Promise.all([api("GET", `/sessions/${id}`), api("GET", `/sessions/${id}/transcript`)]);
	state.session = body.session;
	// REF-08: the session's own ID is a link to the session view, and the parent is a link to its.
	const title = $("session-title");
	// MOB-03: the short label, as everywhere else; the full ID is in the pana:// URL just below.
	title.replaceChildren(refLink(state.session.url ?? state.session.id, "session", refLabel(state.session.url ?? "") || state.session.id));
	const meta = $("session-meta");
	meta.replaceChildren(badge(state.session.state ?? "unknown"));
	const details = document.createElement("span");
	for (const part of [
		state.session.model,
		state.session.cwd,
		state.session.parent ? refLink(state.session.parentUrl ?? state.session.parent, "session", `parent ${state.session.parent}`) : undefined,
		cost(state.session.costUsd),
		scratchSize(state.session.scratch),
	]) {
		if (part === undefined || part === null || part === "") continue;
		if (details.childNodes.length > 0) details.append(" · ");
		if (part instanceof Node) details.append(part);
		else details.append(document.createTextNode(String(part)));
	}
	meta.append(" ", details);
	// Like a thread's header, the session's header shows its canonical pana:// URL.
	if (state.session.url) {
		const url = document.createElement("span");
		url.className = "hint";
		url.dataset.testid = "session-url";
		url.append(refLink(state.session.url, "session"));
		meta.append(" ", url);
	}
	const archive = $("session-archive");
	if (archive) {
		archive.hidden = state.session.state === "archived";
		archive.dataset.id = state.session.id;
	}
	document.querySelector("#session .back")?.setAttribute("href", state.lastList);
	$("session-confirm").hidden = true;
	$("sessions-browse").hidden = true;
	$("sessions-list").hidden = true;
	$("session").hidden = false;
	renderTranscript(asList(transcript, ["entries"]));
	rememberLive(state.session.id, body.session.live);
	renderLive();
	scrollToLatest();
}

function cost(usd) {
	return typeof usd === "number" ? `$${usd.toFixed(4)}` : undefined;
}

// SCR-07: the session's scratch size, absent when it has no scratch directory.
function scratchSize(scratch) {
	if (!scratch || typeof scratch.bytes !== "number") return undefined;
	const units = ["B", "KB", "MB", "GB", "TB"];
	let value = scratch.bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `scratch ${unit === 0 || value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function renderTranscript(entries) {
	const container = $("transcript");
	container.replaceChildren();
	for (const entry of entries) container.append(entryElement(entry));
	if (entries.length === 0) empty(container, "No transcript yet.");
}

/** A tool result's output is collapsed only when it is long (REF-09). */
const LONG_OUTPUT = 2000;

function entryElement(entry) {
	const view = entryView(entry);
	const div = document.createElement("div");
	div.className = "entry";
	div.dataset.testid = "entry";
	div.dataset.role = String(view.role);
	div.dataset.kind = String(view.kind);
	if (view.id !== undefined) div.dataset.entryId = String(view.id);
	const meta = document.createElement("span");
	meta.className = "entry-meta";
	meta.dataset.testid = "entry-meta";
	meta.textContent = [
		view.role,
		view.label && view.label !== view.role ? view.label : undefined,
		view.id !== undefined ? `#${view.id}` : undefined,
		view.usage ? `in ${view.usage.input} · out ${view.usage.output}` : undefined,
		view.usage && view.usage.costUsd > 0 ? cost(view.usage.costUsd) : undefined,
	]
		.filter(Boolean)
		.join(" · ");
	// UX-11: the exact source of the entry, built only when asked for.
	const toggle = document.createElement("button");
	toggle.type = "button";
	toggle.className = "link-button raw-toggle";
	toggle.dataset.testid = "entry-raw-toggle";
	toggle.textContent = "Raw";
	toggle.setAttribute("aria-pressed", "false");
	const body = document.createElement("div");
	body.className = "entry-body";
	for (const block of view.blocks ?? []) body.append(blockElement(block));
	toggle.addEventListener("click", () => {
		let raw = div.querySelector(":scope > .entry-raw");
		if (!raw) {
			raw = document.createElement("pre");
			raw.className = "entry-raw";
			raw.dataset.testid = "entry-raw";
			raw.textContent = entryRaw(entry);
			raw.hidden = true;
			div.append(raw);
		}
		const showing = raw.hidden;
		raw.hidden = !showing;
		body.hidden = showing;
		toggle.setAttribute("aria-pressed", String(showing));
		toggle.textContent = showing ? "Rendered" : "Raw";
	});
	const head = document.createElement("div");
	head.className = "entry-head";
	head.append(meta, toggle);
	div.append(head, body);
	return div;
}

/** UX-11: the model's text, as Markdown sanitized the same way as a thread message. */
function markdownElement(text, testid) {
	const node = document.createElement("div");
	node.className = "body markdown";
	if (testid) node.dataset.testid = testid;
	const { marked, DOMPurify } = window.MailRenderers ?? {};
	// The HTML is in place when this returns; only images and diagrams finish later.
	void renderMessage(node, text, {
		marked,
		DOMPurify,
		domain: state.domain,
		fetchFile,
		ensureMermaid,
		idPrefix: `transcript-diagram-${++diagramCount}`,
		dark: matchMedia("(prefers-color-scheme: dark)").matches,
	}).catch(() => {});
	return node;
}

let diagramCount = 0;

function blockElement(block, { open = false } = {}) {
	if (block.type === "thinking") {
		// REF-09: thinking is collapsed by default.
		if (!block.markdown) return details("details-thinking", "Thinking", block.text, { testid: "entry-thinking", open });
		const node = document.createElement("details");
		node.className = "details-thinking";
		node.dataset.testid = "entry-thinking";
		if (open) node.open = true;
		const summary = document.createElement("summary");
		summary.textContent = "Thinking";
		node.append(summary, markdownElement(block.text));
		return node;
	}
	if (block.type === "text" && block.markdown) return markdownElement(block.text, "entry-text");
	if (block.type === "tool-call") {
		const wrap = document.createElement("div");
		wrap.className = "tool-call";
		wrap.dataset.testid = "entry-tool-call";
		wrap.dataset.tool = block.name;
		const name = document.createElement("span");
		name.className = "tool-name";
		name.textContent = `→ ${block.name}`;
		const args = document.createElement("pre");
		args.className = "tool-args";
		args.textContent = JSON.stringify(block.arguments ?? {}, null, 2);
		wrap.append(name, args);
		return wrap;
	}
	if (block.type === "tool-result") {
		const result = details("details-tool-result", `Result: ${block.name || "tool"}`, block.output, {
			testid: "entry-tool-result",
			open: block.output.length <= LONG_OUTPUT,
		});
		result.dataset.tool = block.name ?? "";
		if (block.isError) result.classList.add("error");
		return result;
	}
	if (block.type === "image") {
		return span(`[image ${block.mediaType}]`, "block-image");
	}
	const pre = document.createElement("pre");
	pre.className = `block-${block.type}`;
	pre.append(linkified(block.text ?? ""));
	return pre;
}

/** A collapsible block: `open` follows the block's own rule, never the caller's. */
function details(className, summaryText, text, { testid, open = false } = {}) {
	const node = document.createElement("details");
	node.className = className;
	if (open) node.open = true;
	if (testid) node.dataset.testid = testid;
	const summary = document.createElement("summary");
	summary.textContent = summaryText;
	const pre = document.createElement("pre");
	pre.append(linkified(text ?? ""));
	node.append(summary, pre);
	return node;
}

async function loadTranscript() {
	if (!state.session) return;
	const transcript = await api("GET", `/sessions/${state.session.id}/transcript`);
	renderTranscript(asList(transcript, ["entries"]));
}

async function sessionAction(action) {
	const session = state.session;
	if (!session) return;
	try {
		await api("POST", `/sessions/${session.id}/${action}`, {});
		status(`${action === "stop" ? "Stopped" : action === "archive" ? "Archived" : "Compacted"} ${session.id}.`);
		await openSession(session.id);
	} catch (error) {
		fail(error);
	}
}

/** REF-02: archiving a session is permanent, so it asks first. */
function askArchiveSession() {
	const session = state.session;
	if (!session) return;
	$("session-confirm-text").textContent = CONFIRM_ARCHIVE_SESSION;
	$("session-confirm").hidden = false;
	$("session-confirm-yes").dataset.id = session.id;
	$("session-confirm-yes").focus();
}

async function confirmArchiveSession() {
	$("session-confirm").hidden = true;
	await sessionAction("archive");
}

// ---- Memory ---------------------------------------------------------------------------------

async function loadMemory() {
	const [worktree, listing] = await Promise.all([api("GET", "/memory/worktree"), api("GET", "/memory/files")]);
	$("memory-worktree").textContent = worktree?.path ? `Your worktree: ${worktree.path}` : "No memory worktree yet.";
	const files = asList(listing, ["files"]);
	const list = $("memory-files");
	list.replaceChildren();
	if (files.length === 0) {
		empty(list, "Memory is empty.");
	} else {
		for (const file of files) {
			const row = item(file.path, [`${file.size} B`], () => void openMemoryFile(file.path), {
				testid: "memory-file-item",
				id: file.path,
			});
			row.dataset.path = file.path;
			if (file.path === openMemoryPath) row.classList.add("focus");
			list.append(row);
		}
	}
	await loadMemoryLog();
}

async function loadMemoryLog() {
	const body = await api("GET", "/memory/log");
	const list = $("memory-log");
	list.replaceChildren();
	const commits = asList(body, ["commits"]);
	if (commits.length === 0) return empty(list, "No memory commits yet.");
	for (const raw of commits) {
		const commit = commitView(raw);
		const aside = document.createElement("div");
		aside.className = "item-aside";
		aside.append(timeEl(Date.parse(commit.at)));
		list.append(item(commit.message, [commit.author, commit.short], () => {}, { testid: "memory-commit", id: commit.hash, aside }));
	}
}

async function searchMemory(event) {
	event?.preventDefault();
	const query = $("memory-query").value.trim();
	if (!query) return status("Type words to search.", true);
	const body = await api("GET", `/memory/search?query=${encodeURIComponent(query)}`);
	const list = $("memory-results");
	list.replaceChildren();
	const results = asList(body, ["results"]);
	if (results.length === 0) return empty(list, `Nothing matches “${query}”.`);
	for (const result of results) {
		const hit = memoryHitView(result);
		const row = item(hit.path, [hit.text], () => void openMemoryFile(hit.path), { testid: "memory-result" });
		row.dataset.path = hit.path;
		list.append(row);
	}
}

function memoryPath(path) {
	return path.split("/").map(encodeURIComponent).join("/");
}

let openMemoryPath = "";

async function openMemoryFile(path) {
	if (!path) return;
	openMemoryPath = path;
	const file = await api("GET", `/memory/files/${memoryPath(path)}`);
	const content = file.content;
	$("memory-path").textContent = path;
	$("memory-file").textContent = content;
	$("memory-file").hidden = false;
	$("memory-edit").value = content;
	$("memory-open").hidden = false;
	for (const row of document.querySelectorAll("#memory-files .item")) row.classList.toggle("focus", row.dataset.path === path);
}

async function saveMemory(event) {
	event?.preventDefault();
	if (!openMemoryPath) return status("Open a memory file first.", true);
	try {
		await api("POST", `/memory/files/${memoryPath(openMemoryPath)}`, { content: $("memory-edit").value });
		$("memory-file").textContent = $("memory-edit").value;
		status("Saved and committed to main.");
		await loadMemory();
	} catch (error) {
		fail(error);
	}
}

async function createWorktree() {
	try {
		const created = await api("POST", "/memory/worktree", {});
		if (created?.path) $("memory-worktree").textContent = `Your worktree: ${created.path}`;
		status("Memory worktree ready.");
		await loadMemory();
	} catch (error) {
		fail(error);
	}
}

// ---- Schedules ------------------------------------------------------------------------------

let editingSchedule;

async function loadSchedules(focus, cursor) {
	const body = await api("GET", pagePath("/schedules", cursor));
	const list = $("schedules-list");
	if (!cursor) list.replaceChildren();
	const schedules = asList(body, ["schedules"]);
	if (schedules.length === 0 && !cursor) return empty(list, "No schedules yet.");
	for (const schedule of schedules) {
		const payload = schedule.payload ?? {};
		const meta = [
			// REF-08: a schedule ID is a link to the schedule view, which focuses its row.
			refLink(schedule.url ?? schedule.id, "schedule", schedule.id),
			payload.prompt ?? payload.body ?? payload.subject,
			`next ${when(schedule.nextAt)}`,
		];
		const edit = rowAction("schedule-edit", "Edit", () => startScheduleEdit(schedule));
		delete edit.dataset.action;
		const remove = rowAction("schedule-delete", "Delete", () => void deleteSchedule(schedule.id));
		remove.dataset.action = "delete-schedule";
		remove.dataset.id = schedule.id;
		remove.classList.add("danger");
		const row = item(`${schedule.kind} · ${schedule.cron ?? when(schedule.at)} · ${schedule.state}`, meta, () => startScheduleEdit(schedule), {
			testid: "schedule-item",
			id: schedule.id,
			actions: [edit, remove],
		});
		list.append(row);
	}
	showMore(list, nextCursor(body), (next) => loadSchedules(undefined, next).catch(fail));
	if (focus) {
		const row = [...document.querySelectorAll("#schedules-list .item")].find((el) => el.dataset.id === focus);
		if (row) {
			row.classList.add("focus");
			select(row);
			row.scrollIntoView({ block: "center" });
		}
	}
}

function startScheduleEdit(schedule) {
	editingSchedule = schedule;
	$("schedule-kind").value = schedule.kind;
	$("schedule-when").value = scheduleWhen(schedule);
	$("schedule-prompt").value = String(schedule.payload?.prompt ?? schedule.payload?.body ?? "");
	$("schedule-to").value = Array.isArray(schedule.payload?.to) ? schedule.payload.to.join(", ") : "";
	$("schedule-create").textContent = "Update";
	$("schedule-form-title").textContent = `Edit schedule ${refLabel(schedule.url ?? "") || schedule.id}`;
	$("schedule-cancel").hidden = false;
	status(`Editing ${schedule.id}.`);
	$("schedule-prompt").focus();
}

function resetScheduleForm() {
	editingSchedule = undefined;
	$("schedule-create").textContent = "Create";
	$("schedule-form-title").textContent = "New schedule";
	$("schedule-cancel").hidden = true;
	$("schedule-prompt").value = "";
	$("schedule-when").value = "";
	$("schedule-to").value = "";
}

async function createSchedule(event) {
	event.preventDefault();
	const text = $("schedule-prompt").value.trim();
	if (!text) return status("Write a prompt first.", true);
	const form = { kind: $("schedule-kind").value, when: $("schedule-when").value, text, to: $("schedule-to").value };
	if (!editingSchedule && !form.when.trim()) return status("Give a cron expression or a time.", true);
	const body = scheduleBody(form, editingSchedule);
	try {
		if (editingSchedule) await api("POST", `/schedules/${editingSchedule.id}`, body);
		else await api("POST", "/schedules", body);
		resetScheduleForm();
		status("Schedule saved.");
		await loadSchedules();
	} catch (error) {
		fail(error);
	}
}

async function deleteSchedule(id) {
	try {
		await api("DELETE", `/schedules/${id}`);
		status("Schedule deleted.");
		await loadSchedules();
	} catch (error) {
		fail(error);
	}
}

// ---- Renderer bundles -----------------------------------------------------------------------

let vendorLoading;
// The Markdown renderer is the agent-mail-web bundle. Loading it from JS removes any doubt
// about whether a deferred classic script has run before this module.
function ensureVendor() {
	if (window.MailRenderers) return Promise.resolve();
	if (!vendorLoading) {
		vendorLoading = new Promise((resolve, reject) => {
			const script = document.createElement("script");
			script.src = "/vendor.js";
			script.onload = () => resolve();
			script.onerror = () => reject(new Error("The renderer bundle failed to load."));
			document.head.append(script);
		}).catch((error) => {
			vendorLoading = undefined;
			throw error;
		});
	}
	return vendorLoading;
}

let mermaidLoading;
function ensureMermaid() {
	if (window.MailMermaid?.mermaid) return Promise.resolve(window.MailMermaid.mermaid);
	if (!mermaidLoading) {
		mermaidLoading = new Promise((resolve, reject) => {
			const script = document.createElement("script");
			script.src = "/mermaid-vendor.js";
			script.onload = () => {
				const lib = window.MailMermaid?.mermaid;
				if (lib) resolve(lib);
				else reject(new Error("The diagram bundle did not expose mermaid."));
			};
			script.onerror = () => reject(new Error("The diagram bundle failed to load."));
			document.head.append(script);
		}).catch((failure) => {
			document.querySelector('script[src="/mermaid-vendor.js"]')?.remove();
			mermaidLoading = undefined;
			throw failure;
		});
	}
	return mermaidLoading;
}

// ---- Push (PSH-02, UX-01) -------------------------------------------------------------------

function pushEnv() {
	return browserEnv({
		userAgent: navigator.userAgent,
		secure: window.isSecureContext,
		hasNotification: typeof Notification !== "undefined",
		hasServiceWorker: "serviceWorker" in navigator,
		hasPushManager: "PushManager" in window,
		standalone: matchMedia("(display-mode: standalone)").matches || navigator.standalone === true,
		origin: location.origin,
		host: location.host,
	});
}

/** The same app on `localhost`, for Safari, which ties notifications to a host name. */
function localhostUrl() {
	if (location.hostname !== "127.0.0.1" && location.hostname !== "[::1]") return undefined;
	return `${location.protocol}//localhost${location.port ? `:${location.port}` : ""}/#${token}`;
}

/** `Notification.requestPermission`, including the callback form older Safari still has. */
function requestNotificationPermission() {
	return new Promise((resolve) => {
		const promise = Notification.requestPermission(resolve);
		if (promise && typeof promise.then === "function") promise.then(resolve);
	});
}

function workerReady(ms) {
	return Promise.race([
		navigator.serviceWorker.ready,
		new Promise((_, reject) =>
			setTimeout(() => reject(new Error(state.workerError || `no active service worker after ${ms / 1000} s`)), ms),
		),
	]);
}

/**
 * Runs inside the click handler. `subscribeToPush` calls `requestPermission` before its first
 * await, so the prompt still has the click's user activation.
 */
async function enablePush({ quiet = false } = {}) {
	const env = pushEnv();
	const result = await subscribeToPush({
		env,
		permission: env.hasNotification ? Notification.permission : "denied",
		requestPermission: requestNotificationPermission,
		register: () => workerReady(10_000),
		getKey: async () => (await api("GET", "/push/key")).publicKey,
		post: (subscription) => api("POST", "/push/subscriptions", subscription),
	});
	state.push = result;
	if (quiet && result.subscribed) return result;
	const message = explainPush(result, env, { localhostUrl: localhostUrl() });
	status(message.text, !result.subscribed, message.link);
	return result;
}

function registerWorker() {
	if (!("serviceWorker" in navigator)) return;
	navigator.serviceWorker.register("/sw.js", { type: "module" }).catch((error) => {
		state.workerError = `the service worker failed to register: ${error?.message ?? error}`;
	});
	navigator.serviceWorker.addEventListener("message", (event) => {
		if (event.data?.type !== "open") return;
		const target = String(event.data.target ?? "");
		const hash = target.includes("#") ? target.slice(target.indexOf("#")) : target;
		if (hash.startsWith("#/")) location.hash = hash;
	});
}

// ---- Keyboard (UX-02, UX-08) ----------------------------------------------------------------

const keys = createKeyReader();

/** The rows or messages `j` and `k` move through in the view that is showing. */
function selectables() {
	const visible = (selector) => [...document.querySelectorAll(selector)].filter((el) => el.offsetParent !== null);
	switch (state.section) {
		case "inbox":
			return visible("#inbox-list [data-selectable]");
		case "threads":
			return $("thread").hidden ? visible("#threads-list [data-selectable]") : visible("#thread-messages [data-testid=message]");
		case "sessions":
			return $("session").hidden ? visible("#sessions-list [data-selectable]") : [];
		case "memory":
			return visible("#memory-results [data-selectable], #memory-files [data-selectable]");
		case "schedules":
			return visible("#schedules-list [data-selectable]");
		default:
			return [];
	}
}

function selected() {
	return document.querySelector(".selected");
}

function select(element, { scroll = true } = {}) {
	for (const node of document.querySelectorAll(".selected")) if (node !== element) node.classList.remove("selected");
	if (!element) return;
	element.classList.add("selected");
	if (scroll) element.scrollIntoView({ block: "nearest" });
}

function moveBy(action) {
	const items = selectables();
	const index = moveSelection(items.indexOf(selected()), items.length, action);
	if (index >= 0) select(items[index]);
}

function openSelection() {
	const element = selected();
	if (!element || !selectables().includes(element)) return;
	if (element.dataset.testid === "message") {
		element.querySelector("[data-testid=message-link]")?.click();
		return;
	}
	element.click();
}

function focusSearch() {
	const search = { threads: "threads-query", sessions: "sessions-query", memory: "memory-query" }[state.section];
	if (search && !$(search).closest("[hidden]")) {
		$(search).focus();
		$(search).select();
		return;
	}
	// The views without a search box search threads.
	location.hash = "#/threads";
	setTimeout(() => $("threads-query").focus(), 0);
}

function focusReply() {
	if (state.section === "threads" && !$("thread").hidden) {
		$("reply-body").focus();
		return;
	}
	const threadId = selected()?.dataset.thread;
	if (!threadId) return;
	location.hash = `#/threads/${threadId}`;
	const until = Date.now() + 5000;
	const wait = () => {
		if (!$("thread").hidden && state.thread?.id === threadId) $("reply-body").focus();
		else if (Date.now() < until) setTimeout(wait, 50);
	};
	wait();
}

function archiveKey() {
	if (state.section === "threads" && !$("thread").hidden && state.thread) {
		void archiveThread(state.thread.id, !state.threadArchived);
		return;
	}
	const row = selected();
	const threadId = row?.dataset.thread;
	if (!threadId) return;
	const archived = row.classList.contains("archived");
	void archiveThread(threadId, !archived);
}

function goBack() {
	if (!$("help").hidden) return toggleHelp(false);
	if (state.confirm) return cancelAction();
	if (!$("session-confirm").hidden) {
		$("session-confirm").hidden = true;
		return;
	}
	const detail = (state.section === "threads" && !$("thread").hidden) || (state.section === "sessions" && !$("session").hidden);
	if (detail) location.hash = state.lastList;
}

function renderHelp() {
	const table = $("help-keys");
	table.replaceChildren();
	const groups = [
		["page", "Outside a text box"],
		["input", "In a text box"],
	];
	for (const [scope, title] of groups) {
		const body = document.createElement("tbody");
		const head = document.createElement("tr");
		const th = document.createElement("th");
		th.colSpan = 2;
		th.scope = "colgroup";
		th.textContent = title;
		head.append(th);
		body.append(head);
		for (const row of helpRows(APPLE).filter((entry) => entry.scope === scope)) {
			const tr = document.createElement("tr");
			tr.dataset.action = row.action;
			const keysCell = document.createElement("td");
			keysCell.className = "keys";
			row.keys.forEach((label, index) => {
				if (index > 0) keysCell.append(" or ");
				label.split(" then ").forEach((key, step) => {
					if (step > 0) keysCell.append(" then ");
					const kbd = document.createElement("kbd");
					kbd.textContent = key;
					keysCell.append(kbd);
				});
			});
			const what = document.createElement("td");
			what.textContent = row.description;
			tr.append(keysCell, what);
			body.append(tr);
		}
		table.append(body);
	}
}

function toggleHelp(show = $("help").hidden) {
	if (show) renderHelp();
	$("help").hidden = !show;
	if (show) $("help-close").focus();
}

function runKey(action, { target, form }) {
	if (action === "submit") return form?.requestSubmit();
	if (action === "leave-input") return target?.blur?.();
	if (action === "help") return toggleHelp();
	if (action === "back") return goBack();
	if (!$("help").hidden) toggleHelp(false);
	if (action.startsWith("go:")) {
		location.hash = `#/${action.slice(3)}`;
		return;
	}
	switch (action) {
		case "next":
		case "previous":
			return moveBy(action);
		case "open":
			return openSelection();
		case "search":
			return focusSearch();
		case "reply":
			return focusReply();
		case "archive":
			return archiveKey();
	}
}

function onKeydown(event) {
	if (event.defaultPrevented || event.isComposing) return;
	const target = event.target instanceof Element ? event.target : document.activeElement;
	const inInput = isTextInput(target);
	const form = target?.closest?.("form") ?? null;
	// A focused button, link, or summary keeps its own Enter.
	if (!inInput && event.key === "Enter" && !isSubmitChord(event, APPLE) && target?.closest?.("button, a, summary")) return;
	const action = keys.press(event, { inInput, inForm: Boolean(form), apple: APPLE });
	if (!action) return;
	event.preventDefault();
	if (action !== "pending") runKey(action, { target, form });
}

// ---- Router ---------------------------------------------------------------------------------

function showSection(section) {
	state.section = section;
	// Compose has no nav item of its own: it is the Threads page's New button.
	const navSection = section === "compose" ? "threads" : section;
	for (const link of document.querySelectorAll("#nav a")) {
		if (link.dataset.section === navSection) link.setAttribute("aria-current", "page");
		else link.removeAttribute("aria-current");
	}
	for (const view of document.querySelectorAll(".view")) {
		view.hidden = view.id !== `view-${section}`;
	}
}

async function route() {
	const { section, id, query } = routeFromHash(location.hash);
	showSection(section);
	select(null);
	if (!id && section !== "compose") state.lastList = location.hash || "#/inbox";
	if (!token) {
		showAuthorize();
		return;
	}
	if (!state.domainReady) ensureDomain();
	await state.domainReady;
	try {
		switch (section) {
			case "inbox":
				await loadInbox();
				break;
			case "compose":
				$("compose-to").focus();
				break;
			case "threads":
				$("threads-browse").hidden = false;
				$("threads-list").hidden = false;
				$("thread").hidden = true;
				if (query.get("query")) $("threads-query").value = query.get("query");
				if (id) await openThread(id, query.get("message"));
				else await searchThreads();
				break;
			case "sessions":
				$("sessions-browse").hidden = false;
				$("sessions-list").hidden = false;
				$("session").hidden = true;
				if (id) await openSession(id);
				else await loadSessionList($("sessions-query").value.trim());
				break;
			case "memory":
				await loadMemory();
				break;
			case "schedules":
				await loadSchedules(query.get("focus") ?? undefined);
				break;
		}
	} catch (error) {
		fail(error);
	}
}

async function boot() {
	if (!token) {
		showAuthorize();
		return;
	}
	hideAuthorize();
	registerWorker();
	await ensureVendor().catch(() => {});
	// A returning user already allowed notifications; refresh or create the subscription
	// without asking again.
	if (typeof Notification !== "undefined" && Notification.permission === "granted" && "serviceWorker" in navigator) {
		void enablePush({ quiet: true });
	}
	void startEvents();
	await route();
}

// ---- Wiring ---------------------------------------------------------------------------------

for (const hint of document.querySelectorAll("[data-chord]")) hint.textContent = sequenceLabel(["Mod+Enter"], APPLE);

$("authorize-form").addEventListener("submit", (event) => {
	event.preventDefault();
	void authorize($("authorize-input").value);
});
$("compose-form").addEventListener("submit", (event) => void submitCompose(event));
$("threads-search").addEventListener("submit", (event) => void searchThreads(event));
$("sessions-search").addEventListener("submit", (event) => {
	event.preventDefault();
	void loadSessionList($("sessions-query").value.trim());
});
$("reply-form").addEventListener("submit", (event) => void submitReply(event));
$("reply-body").addEventListener("input", () => {
	const draft = state.draft;
	if (!draft) return;
	draft.body = $("reply-body").value;
	sessionStorage.setItem(`pana-draft:${draft.threadId}`, draft.body);
});
$("confirm").addEventListener("submit", (event) => void confirmAction(event));
$("confirm-no").addEventListener("click", cancelAction);
$("thread-archive").addEventListener("click", () => {
	const thread = state.thread;
	if (!thread) return;
	const button = $("thread-archive");
	void archiveThread(thread.id, button.dataset.archived !== "true");
});
$("session-confirm-yes").addEventListener("click", () => void confirmArchiveSession());
$("session-confirm-no").addEventListener("click", () => {
	$("session-confirm").hidden = true;
});
$("threads-archived").addEventListener("change", () => void searchThreads());
$("inbox-archived").addEventListener("change", () => void loadInbox());
$("threads-unread").addEventListener("change", () => void searchThreads());
$("memory-search").addEventListener("submit", (event) => void searchMemory(event));
$("memory-edit-form").addEventListener("submit", (event) => void saveMemory(event));
$("schedule-form").addEventListener("submit", (event) => void createSchedule(event));
$("schedule-cancel").addEventListener("click", () => {
	resetScheduleForm();
	status("");
});
$("enable-push").addEventListener("click", () => void enablePush());
$("show-help").addEventListener("click", () => toggleHelp(true));
$("help-close").addEventListener("click", () => toggleHelp(false));
$("help").addEventListener("click", (event) => {
	if (event.target === $("help")) toggleHelp(false);
});
document.addEventListener("keydown", onKeydown);
document.addEventListener("focusin", (event) => {
	const row = event.target?.closest?.("[data-selectable]");
	if (row) select(row, { scroll: false });
});
document.addEventListener("click", (event) => {
	const action = event.target?.closest?.("[data-action]")?.dataset.action;
	if (action === "stop" || action === "compact") void sessionAction(action);
	if (action === "archive-session") askArchiveSession();
	if (action === "reload") {
		if (state.session) void openSession(state.session.id);
		else void loadSessionList();
	}
	if (action === "create-worktree") void createWorktree();
});
window.addEventListener("hashchange", () => void route());
window.addEventListener("online", () => void startEvents());

// The thread from a notification click arrives as `?thread=<id>` (PSH-03).
const bootParams = new URLSearchParams(location.search);
if (bootParams.get("thread")) history.replaceState(null, "", `/#/threads/${bootParams.get("thread")}`);

// Exposed for the browser tests and for a human debugging a window.
window.__pana = {
	get state() {
		const current = selected();
		return {
			domain: state.domain,
			section: state.section,
			threadId: state.thread?.id,
			sessionId: state.session?.id,
			draft: state.draft ? { threadId: state.draft.threadId, after: state.draft.after } : undefined,
			confirm: state.confirm?.action,
			selected: current ? { testid: current.dataset.testid, id: current.dataset.id, thread: current.dataset.thread } : undefined,
			help: !$("help").hidden,
			push: state.push,
			apple: APPLE,
		};
	},
	enablePush,
};

void boot();
