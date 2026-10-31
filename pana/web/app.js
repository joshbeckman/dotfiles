// The pana PWA (WEB-01..08, WP13). Plain ES modules, no framework: a hash router, one fetch
// wrapper, a renderer per section, and one keyboard module. The server owns auth (API-04); this
// file only carries the token.

import {
	CONFIRM_ARCHIVE_SESSION,
	CONFIRM_EDIT,
	CONFIRM_REDACT,
	TOKEN_KEY,
	appendReference,
	appHref,
	idHref,
	memoryCommitHref,
	memoryEditHref,
	memoryFileHref,
	newDraft,
	panaLinkSegments,
	referenceFor,
	routeFromHash,
	takeClickTarget,
	tokenFromInput,
} from "./links.js";
import { browserEnv, explainPush, subscribeToPush } from "./push.js";
import { nextCursor, pagePath, showMore } from "./pages.js";
import { HITS_PER_STORE, hitHash, matchCommands, paletteCommands, paletteHits } from "./palette.js";
import { createKeyReader, helpRows, isApplePlatform, isSubmitChord, isTextInput, moveSelection, sequenceLabel } from "./keys.js";
import {
	charterBody,
	charterView,
	commitView,
	elapsedLabel,
	entryRaw,
	entryView,
	inboxThreadRow,
	isWorking,
	liveActivityLabel,
	memoryCommitView,
	memoryFileView,
	memoryHitView,
	messageView,
	metricChart,
	metricsView,
	objectiveRow,
	objectiveView,
	objectiveWakes,
	participantColor,
	refLabel,
	scheduleBody,
	scheduleCheckView,
	scheduleWhen,
	scheduledOf,
	shortTime,
	threadRow,
	transcriptPage,
	untilLabel,
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
	threadCanArchive: false,
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
	/** How far this clock runs ahead of panad's, from the last event's `at`, so scheduled times agree. */
	clockSkew: 0,
	push: undefined,
	workerError: "",
};

/** panad's idea of now, falling back to this clock before any event has said. */
function serverNow() {
	return Date.now() - state.clockSkew;
}

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
	return decode(await raw(path, options), method, path);
}

/** Parse a response the way `api` does, error body and all. */
async function decode(response, method, path) {
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

/**
 * FIL-07: one blob URL per file path, kept for the life of the window. A thread renders the same
 * picture in several messages, and every new message or archive redraws the open thread; neither
 * should read those bytes again.
 */
const fileUrls = new Map();

// ---- Attachments ----------------------------------------------------------------------------

/** FIL-01 from the browser: the bytes go to the same route `--attach` uploads to. */
async function uploadFile(file) {
	const body = await file.arrayBuffer();
	const response = await raw(`/files?name=${encodeURIComponent(file.name)}`, {
		method: "POST",
		headers: { "content-type": file.type || "application/octet-stream" },
		body,
	});
	const data = await decode(response, "POST", "/files");
	return data.file;
}

/**
 * FIL-06: upload each file, then append its Markdown reference to the body (FIL-02), so the
 * composer shows exactly the message it will send. The `input` event keeps a reply draft saved.
 */
async function attachFiles(textarea, files) {
	let count = 0;
	for (const file of files) {
		if (!file || typeof file.name !== "string") continue;
		status(`Uploading ${file.name}…`);
		const { name, url, mediaType } = await uploadFile(file);
		textarea.value = appendReference(textarea.value, referenceFor({ name, url, mediaType }));
		count += 1;
	}
	if (count === 0) return 0;
	textarea.dispatchEvent(new Event("input"));
	textarea.focus();
	textarea.setSelectionRange(textarea.value.length, textarea.value.length);
	status(count === 1 ? "Attached 1 file." : `Attached ${count} files.`);
	return count;
}

/** FIL-06: a button, a drop anywhere on the composer, and a screenshot pasted into the body. */
function wireAttach(formId, buttonId, inputId, bodyId) {
	const form = $(formId);
	const button = $(buttonId);
	const input = $(inputId);
	const body = $(bodyId);
	const upload = async (files) => {
		button.disabled = true;
		try {
			await attachFiles(body, files);
		} catch (error) {
			fail(error);
		} finally {
			button.disabled = false;
		}
	};
	button.addEventListener("click", () => input.click());
	input.addEventListener("change", () => {
		const files = [...input.files];
		// Clear the input first, so choosing the same file twice still fires `change`.
		input.value = "";
		if (files.length > 0) void upload(files);
	});
	form.addEventListener("dragover", (event) => {
		if (![...(event.dataTransfer?.types ?? [])].includes("Files")) return;
		event.preventDefault();
		form.classList.add("dropping");
	});
	form.addEventListener("dragleave", (event) => {
		if (!form.contains(event.relatedTarget)) form.classList.remove("dropping");
	});
	form.addEventListener("drop", (event) => {
		const files = [...(event.dataTransfer?.files ?? [])];
		if (files.length === 0) return;
		event.preventDefault();
		form.classList.remove("dropping");
		void upload(files);
	});
	body.addEventListener("paste", (event) => {
		const files = [...(event.clipboardData?.files ?? [])];
		if (files.length === 0) return;
		event.preventDefault();
		void upload(files);
	});
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

// Patch labels only: reopening a thread would disturb reply drafts, focus, and scroll.
function applyThreadSubject(threadId, subject) {
	if (state.thread?.id === threadId) {
		state.thread.subject = subject;
		$("thread-subject").textContent = subject;
	}
	for (const row of document.querySelectorAll("[data-thread]")) {
		if (row.dataset.thread === threadId) {
			const label = row.querySelector(".thread-subject-label");
			if (label) label.textContent = subject;
		}
	}
}

function handleEvent(event) {
	// Every event carries panad's `at`; keeping the difference means a scheduled time counts down
	// against panad's clock even when the two machines disagree, as a test's fake clock does.
	if (Number.isFinite(Number(event.at))) state.clockSkew = Date.now() - Number(event.at);
	if (event.kind === "thread.subject" && typeof event.threadId === "string" && typeof event.subject === "string") {
		applyThreadSubject(event.threadId, event.subject);
		return;
	}
	if (event.kind === "hello") {
		if (typeof event.domain === "string") state.domain = event.domain;
		state.domainResolved?.();
		return;
	}
	// UX-09: who is working changes in the open thread and in the lists, without a reload.
	if (event.kind === "session.state" && typeof event.sessionId === "string") {
		applyStateEvent(event);
		// OBJ-39/UX-09: an objective's roster follows the same events, so a member's state is live.
		applyObjectiveStateEvent(event);
		return;
	}
	// UX-09: a session's next wake moved, so the open thread's scheduled chip follows without a reload.
	if (event.kind === "session.wake" && typeof event.sessionId === "string") {
		applyWakeEvent(event);
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

/** Machine tokens use mono; surrounding labels keep the UI's proportional font. */
function referenceText(label) {
	const fragment = document.createDocumentFragment();
	const text = String(label);
	// A canonical address is one token, including its path and query.
	const tokens = text.startsWith("pana://")
		? /^pana:\/\/\S+$/g
		: /\b[0-9A-HJKMNP-TV-Z]{26}\b|(?<=session )[0-9A-HJKMNP-TV-Z]{6}\b|(?<=#)[0-9A-HJKMNP-TV-Z]{6}\b/g;
	let start = 0;
	for (const match of text.matchAll(tokens)) {
		fragment.append(text.slice(start, match.index), span(match[0], "identifier"));
		start = match.index + match[0].length;
	}
	fragment.append(text.slice(start));
	return fragment;
}

/** A link to an ID's own view (REF-08), or plain text when the ID has no view here. */
function refLink(value, kind, label, title) {
	const text = String(value ?? "");
	if (!text) return document.createTextNode("");
	const href = text.startsWith("pana://") ? appHref(text, state.domain) : idHref(text, kind);
	if (!href) return document.createTextNode(label ?? text);
	const anchor = document.createElement("a");
	anchor.href = href;
	// Usernames are human labels, even if one happens to resemble an ID.
	if (/\/users\//.test(text) && label !== undefined && label !== text) anchor.textContent = label;
	else anchor.append(referenceText(label ?? text));
	if (title) anchor.title = title;
	anchor.dataset.testid = "ref-link";
	if (/^https?:/i.test(href)) {
		anchor.target = "_blank";
		anchor.rel = "noopener noreferrer";
	}
	return anchor;
}

/** Self-identifiers copy their URL; references elsewhere still navigate (UX-17). */
function copyLink(value, kind, label) {
	const link = refLink(value, kind, label);
	if (!(link instanceof HTMLAnchorElement)) return link;
	return copyingLink(link, value);
}

function copyingLink(link, url) {
	link.title = "Copy URL to clipboard";
	link.setAttribute("aria-label", `Copy URL: ${link.textContent}`);
	link.dataset.copyUrl = url;
	link.addEventListener("click", async (event) => {
		if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
		event.preventDefault();
		event.stopPropagation();
		try {
			if (!navigator.clipboard?.writeText) throw new Error("Clipboard is unavailable in this browser.");
			await navigator.clipboard.writeText(url);
			status("URL copied to clipboard.");
		} catch (error) {
			status(`Could not copy URL: ${error.message} You can copy the link manually.`, true);
		}
	});
	return link;
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
		anchor.classList.add("identifier");
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

function badge(text, kind = "") {
	return span(text, `badge ${text} ${kind}`.trim());
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
		$("session-meta").querySelector(".badge")?.replaceWith(badge(next, "state-badge"));
	}
	for (const threadId of Array.isArray(event.threadIds) ? event.threadIds.map(String) : []) {
		const map = workingMap(threadId);
		if (isWorking(next)) map.set(sessionId, { sessionId, url: String(event.url ?? ""), state: next });
		else map.delete(sessionId);
		workingChanged(threadId);
	}
}

/** A window heard a session's next wake change: patch the open thread's participant and redraw. */
function applyWakeEvent(event) {
	const participant = state.thread?.participants?.find((each) => each?.kind === "session" && each.id === event.sessionId);
	if (!participant) return;
	if (event.wake && Number.isFinite(Number(event.wake.at))) participant.wake = event.wake;
	else delete participant.wake;
	renderThreadWorking();
}

function workingChanged(threadId) {
	for (const row of document.querySelectorAll(`[data-thread="${CSS.escape(threadId)}"]`)) syncWorkingMark(row, threadId);
	if (state.thread?.id === threadId) renderThreadWorking();
}

/**
 * The bottom of a thread, just above the reply box: the sessions working now, in their colors,
 * and the ones with a wake pending — work to come, at a time the chip names (UX-09).
 */
function renderThreadWorking() {
	const node = $("thread-working");
	const threadId = state.thread?.id;
	const working = threadId ? [...workingMap(threadId).values()] : [];
	const scheduled = state.thread ? scheduledOf(state.thread) : [];
	node.replaceChildren();
	if (working.length === 0 && scheduled.length === 0) {
		node.hidden = true;
		return;
	}
	// One line each: working and scheduled are different claims, and flat would read as one list.
	if (working.length > 0) {
		const line = span("", "working-group");
		line.append(span("Working", "working-label"));
		for (const session of working) line.append(workingChip(session));
		node.append(line);
	}
	if (scheduled.length > 0) {
		const line = span("", "working-group");
		line.append(span("Scheduled", "working-label scheduled-label"));
		for (const wake of scheduled) line.append(scheduledChip(wake));
		node.append(line);
	}
	node.hidden = false;
}

/** A session with a wake pending: who, and how long until it wakes. The time links to the schedule. */
function scheduledChip(wake) {
	const chip = span("", "working-chip scheduled-chip");
	chip.dataset.testid = "scheduled-session";
	chip.dataset.session = wake.sessionId;
	chip.dataset.color = participantColor({ url: wake.url, kind: "session" });
	const repeating = wake.cron ? ` (${wake.cron})` : "";
	const subject = wake.subject ? `: ${wake.subject}` : "";
	chip.append(span("", "working-dot scheduled-mark"));
	chip.append(refLink(wake.url, "session", refLabel(wake.url)));
	const at = refLink(wake.scheduleUrl, "schedule", untilLabel(wake.at));
	if (at instanceof HTMLAnchorElement) at.className = "scheduled-when";
	else at.textContent = untilLabel(wake.at);
	// The countdown keeps ticking while the page is open, like the working chip's elapsed time.
	tickUntil(at, wake.at);
	chip.append(at);
	chip.title = `${refLabel(wake.url)} wakes ${when(wake.at)}${repeating}${subject}`;
	return chip;
}

/** A label that recomputes from panad's clock each second while it is on the page. */
function tickUntil(node, at) {
	node.dataset.ticking = "true";
	node.__render = () => {
		node.textContent = untilLabel(at, serverNow());
	};
	node.__render();
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

/** REF-06: the nav dot signals unread mail; its label includes the total across every thread. */
async function refreshUnread(archived = false, cursor) {
	const generation = archived ? -1 : ++unreadGeneration;
	const body = await api("GET", pagePath(`/inbox?view=threads${archived ? "&archived=1" : ""}`, cursor));
	const items = asList(body, ["threads"]);
	// SCALE-03: the inbox is paged, so the server counts the unread deliveries past this page too.
	const unread = typeof body?.unreadTotal === "number" ? body.unreadTotal : items.reduce((sum, thread) => sum + (thread.unreadCount ?? 0), 0);
	const badge = $("nav-inbox-count");
	// The archived view is not the inbox, so it never rewrites the badge.
	if (badge && generation === unreadGeneration) {
		const label = unread === 0 ? "No unread messages" : `${unread} unread ${unread === 1 ? "message" : "messages"}`;
		badge.setAttribute("aria-label", label);
		badge.title = label;
		badge.parentElement.title = label;
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
	if (row.sender.kind !== "user") who.replaceChildren(referenceText(`${refLabel(row.sender.url)}: `));
	who.dataset.color = participantColor(row.sender);
	snippet.append(who, document.createTextNode(row.snippet));
	const aside = document.createElement("div");
	aside.className = "item-aside";
	aside.append(timeEl(row.at));
	const archive = showArchived
		? rowAction("inbox-unarchive", "Unarchive", () => void archiveThread(row.threadId, false))
		: rowAction("inbox-archive", "Archive", () => void archiveThread(row.threadId, true));
	const node = item(
		span(row.subject, "thread-subject-label"),
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

/**
 * REF-07: archive or unarchive one thread, then refresh whatever list is showing. `leave` is for
 * the thread that is open: rather than redraw it, go back to the list it was opened from, the way
 * `u` would.
 */
async function archiveThread(threadId, archived, { leave = false } = {}) {
	try {
		await api("POST", `/threads/${threadId}/${archived ? "archive" : "unarchive"}`, {});
		status(archived ? "Archived." : "Unarchived.");
		const open = state.section === "threads" && state.thread?.id === threadId && !$("thread").hidden;
		await refreshUnread().catch(() => {});
		if (open && leave) {
			location.hash = state.lastList;
			return;
		}
		if (open) await openThread(threadId);
		else if (state.section === "inbox") await loadInbox();
		else if (state.section === "threads") await searchThreads();
	} catch (error) {
		fail(error);
	}
}

/**
 * UX-16: ask the subject model for a new subject and swap it in without reloading the thread. The
 * route keeps the old subject in the thread's history (SUB-04) and answers with the new one.
 */
async function regenerateThreadSubject() {
	const thread = state.thread;
	if (!thread) return;
	const button = $("thread-subject-regenerate");
	button.disabled = true;
	button.textContent = "Regenerating…";
	try {
		const body = await api("POST", `/threads/${thread.id}/subject`, { regenerate: true });
		applyThreadSubject(thread.id, body.subject ?? "(no subject)");
		status("Subject regenerated.");
	} catch (error) {
		// The route names the cause. The usual one is a config.json with no subjectModel, which is
		// the user's to fix, so say how rather than echoing a failure.
		if (error?.body?.error?.code === "no_subject_model") status("Set subjectModel in config.json to regenerate a subject.", true);
		else fail(error);
	} finally {
		button.disabled = false;
		button.textContent = "Regenerate subject";
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
	if (event) status("");
	const query = $("threads-query").value.trim();
	const params = new URLSearchParams();
	if (query) params.set("query", query);
	const participant = $("threads-participant").value.trim();
	if (participant) params.set("participant", participant);
	const suffix = params.toString();
	const list = $("threads-list");
	let body;
	try {
		body = await api("GET", pagePath(`/threads${suffix ? `?${suffix}` : ""}`, cursor));
	} catch (error) {
		// A failed filter must not leave unrelated rows looking like successful matches.
		if (!cursor) empty(list, "Unable to load threads.");
		throw error;
	}
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
		const aside = document.createElement("div");
		aside.className = "item-aside";
		aside.append(timeEl(thread.at));
		const row = item(
			span(thread.subject, "thread-subject-label"),
			[thread.snippet],
			() => {
				location.hash = `#/threads/${thread.id}`;
			},
			{ testid: "thread-item", threadId: thread.id, aside },
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
	const messageLink = copyLink(view.url ?? `pana://${state.domain}/threads/${view.threadId}?message=${view.id}`, "thread", `#${String(view.id ?? "").slice(-6)}`);
	if (messageLink instanceof HTMLElement) messageLink.dataset.testid = "message-link";
	header.append(sender, timeEl(view.at), messageLink);
	if (view.revised) header.append(span("edited", "badge"));

	// UX-04: edit and redact are small secondary controls, folded into one quiet menu per message
	// so a thread of messages reads as prose rather than a column of repeated links.
	const menu = document.createElement("details");
	menu.className = "message-menu";
	menu.dataset.testid = "message-menu";
	const summary = document.createElement("summary");
	summary.className = "message-menu-summary";
	summary.textContent = "⋯";
	summary.title = "Actions for this message";
	summary.ariaLabel = "Actions for this message";
	menu.append(summary);
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
		button.addEventListener("click", () => {
			menu.open = false;
			startConfirm(action, view, article);
		});
		actions.append(button);
	}
	menu.append(actions);
	// One menu at a time, and Escape closes it instead of leaving the thread. Closing the others
	// on the click keeps a single menu open even though the summary's own toggle lands later.
	summary.addEventListener("click", () => closeMessageMenus(menu));
	menu.addEventListener("keydown", (event) => {
		if (event.key !== "Escape" || !menu.open) return;
		event.preventDefault();
		event.stopPropagation();
		menu.open = false;
		summary.focus();
	});
	header.append(menu);
	article.append(header);

	const body = document.createElement("div");
	body.className = "body prose";
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
			cache: fileUrls,
			ensureMermaid,
			idPrefix: `diagram-${view.id ?? "x"}`,
			dark: matchMedia("(prefers-color-scheme: dark)").matches,
		});
	}

	if (focus) article.classList.add("focus");
	return article;
}

/** Close any message's action menu except the one named; a click elsewhere or Escape does this. */
function closeMessageMenus(except) {
	for (const menu of document.querySelectorAll(".message-menu[open]")) if (menu !== except) menu.open = false;
}

/** Put the edit and redact form back in its hidden home before the messages are replaced. */
function parkConfirm() {
	$("confirm").hidden = true;
	$("edit-field").hidden = true;
	$("confirm-home").append($("confirm"));
	state.confirm = null;
}

// Invalidate in-flight rendering on navigation or a newer refresh of the same thread.
let threadRenderVersion = 0;
const THREAD_PAGE_SIZE = 30;

async function openThread(id, focusMessage) {
	const version = ++threadRenderVersion;
	const current = () => version === threadRenderVersion && state.section === "threads";
	const body = await api("GET", `/threads/${id}`);
	if (!current()) return;
	const thread = body.thread;
	const messages = body.messages ?? [];
	state.thread = thread;
	state.threadArchived = Boolean(body.archived);
	state.threadCanArchive = Boolean(body.canArchive);
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
	threadUrl.replaceChildren(copyLink(thread?.url ?? `pana://${state.domain}/threads/${id}`, "thread"));
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
	archiveButton.hidden = !state.threadCanArchive;
	archiveButton.dataset.archived = String(Boolean(body.archived));
	archiveButton.textContent = body.archived ? "Unarchive" : "Archive";
	archiveButton.dataset.testid = body.archived ? "thread-unarchive" : "thread-archive";
	const container = $("thread-messages");
	container.replaceChildren();
	// Parse and hydrate only one page, not years of history before the first paint. Keep the
	// full response for draft.after and stale-reply handling; the wire/API contract is unchanged.
	const linkedIndex = focusMessage ? messages.findIndex((message) => message.id === focusMessage) : -1;
	let start = linkedIndex < 0 ? Math.max(0, messages.length - THREAD_PAGE_SIZE) : Math.max(0, linkedIndex - Math.floor(THREAD_PAGE_SIZE / 2));
	let end = Math.min(messages.length, start + THREAD_PAGE_SIZE);
	start = Math.max(0, end - THREAD_PAGE_SIZE);
	async function renderRange(from, to) {
		const fragment = document.createDocumentFragment();
		for (const message of messages.slice(from, to)) {
			const article = await messageElement(message, { focus: message.id === focusMessage });
			if (!current()) return null;
			fragment.append(article);
		}
		return fragment;
	}
	function historyButtons() {
		container.querySelectorAll(":scope > [data-history]").forEach((button) => button.remove());
		for (const direction of ["earlier", "later"]) {
			const remaining = direction === "earlier" ? start : messages.length - end;
			if (!remaining) continue;
			const button = document.createElement("button");
			button.type = "button";
			button.className = "more";
			button.dataset.history = direction;
			button.dataset.testid = `thread-${direction}`;
			button.textContent = `Load ${Math.min(THREAD_PAGE_SIZE, remaining)} ${direction} messages (${remaining} remaining)`;
			button.addEventListener("click", async () => {
				const retainFocus = document.activeElement === button;
				// Serialize history loads so repeated clicks cannot duplicate a range.
				container.querySelectorAll(":scope > [data-history]").forEach((node) => { node.disabled = true; });
				try {
					const from = direction === "earlier" ? Math.max(0, start - THREAD_PAGE_SIZE) : end;
					const to = direction === "earlier" ? start : Math.min(messages.length, end + THREAD_PAGE_SIZE);
					const fragment = await renderRange(from, to);
					if (!current() || !fragment) return;
					const firstNew = fragment.firstElementChild;
					const anchor = container.querySelector(".message");
					const top = anchor?.getBoundingClientRect().top;
					if (direction === "earlier") {
						container.insertBefore(fragment, anchor);
						start = from;
					} else {
						container.append(fragment);
						end = to;
					}
					historyButtons();
					if (retainFocus) (container.querySelector(`[data-history="${direction}"]`) ?? firstNew)?.focus({ preventScroll: true });
					// Preserve the reader's position when older content is inserted above them.
					if (direction === "earlier" && anchor) window.scrollBy(0, anchor.getBoundingClientRect().top - top);
				} catch (error) {
					if (current()) { historyButtons(); fail(error); }
				}
			});
			if (direction === "earlier") container.prepend(button);
			else container.append(button);
		}
	}
	const initial = await renderRange(start, end);
	if (!current() || !initial) return;
	container.append(initial);
	historyButtons();
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

const SESSION_STATES = ["running", "waiting", "idle", "failed", "stopped", "archived"];
let sessionListRequest = 0;

async function loadSessionList(query = "", cursor, filter = $("sessions-state").value) {
	const request = ++sessionListRequest;
	const params = new URLSearchParams({ query });
	if (filter) params.set("state", filter);
	const body = await api("GET", pagePath(`/sessions?${params}`, cursor));
	if (request !== sessionListRequest) return;
	const list = document.querySelector("#sessions-list");
	if (!cursor) list.replaceChildren();
	const sessions = asList(body, ["sessions"]);
	if (sessions.length === 0 && !cursor) {
		const noun = filter ? `${filter} sessions` : "sessions";
		return empty(list, query ? `No ${noun} match “${query}”.` : filter ? `No ${noun}.` : "No sessions yet.");
	}
	for (const session of sessions) {
		learnDomain(session.url);
		const title = document.createDocumentFragment();
		const swatch = span("", "person");
		swatch.dataset.color = participantColor({ url: session.url ?? "", kind: "session" });
		swatch.append(refLink(session.url ?? session.id, "session", session.id, session.url));
		title.append(badge(session.state ?? "unknown", "state-badge"), swatch);
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
	showMore(list, nextCursor(body), (next) => loadSessionList(query, next, filter).catch(fail));
}

async function openSession(id) {
	// UX-18: a newer open or reload makes this one's late response stale.
	const version = ++transcriptVersion;
	const [body, transcript] = await Promise.all([
		api("GET", `/sessions/${id}`),
		fetchTranscriptPage(id, { latest: "1", limit: String(TRANSCRIPT_PAGE_SIZE) }),
	]);
	if (version !== transcriptVersion) return;
	state.session = body.session;
	// UX-17: the session's own ID copies its URL; the parent remains a navigation link.
	const title = $("session-title");
	// MOB-03: the short label, as everywhere else; the full ID is in the pana:// URL just below.
	title.replaceChildren(copyLink(state.session.url ?? `pana://${state.domain}/sessions/${state.session.id}`, "session", refLabel(state.session.url ?? "") || state.session.id));
	const meta = $("session-meta");
	meta.replaceChildren(badge(state.session.state ?? "unknown", "state-badge"));
	// MOB-05: each fact is its own node, so a phone can put the working directory on its own row
	// instead of letting one long sentence break inside a model ID or a path.
	const facts = document.createElement("span");
	facts.className = "session-facts";
	facts.dataset.testid = "session-facts";
	for (const [name, part] of [
		["model", state.session.model],
		["cwd", state.session.cwd],
		["parent", state.session.parent ? refLink(state.session.parentUrl ?? state.session.parent, "session", `parent ${state.session.parent}`) : undefined],
		["cost", cost(state.session.costUsd)],
		["scratch", scratchSize(state.session.scratch)],
		["wakes", `scheduled wakes: ${state.session.wakes?.length ?? 0}`],
	]) {
		if (part === undefined || part === null || part === "") continue;
		const fact = document.createElement("span");
		fact.className = `fact fact-${name}`;
		// The row can ellipsize a path or a model on a narrow screen; the title keeps it whole.
		if (typeof part === "string") fact.title = part;
		if (part instanceof Node) fact.append(part);
		else fact.textContent = String(part);
		facts.append(fact);
	}
	meta.append(facts);
	// Like a thread's header, the session's header shows its canonical pana:// URL.
	if (state.session.url) {
		const url = document.createElement("span");
		url.className = "hint session-url";
		url.dataset.testid = "session-url";
		url.append(copyLink(state.session.url, "session"));
		meta.append(url);
	}
	renderSessionWakes();
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
	transcriptWindow = { previous: transcript.previous, pages: 1 };
	renderTranscript(transcript.entries);
	rememberLive(state.session.id, body.session.live);
	renderLive();
	scrollToLatest();
}

function renderSessionWakes() {
	const section = $("session-wakes");
	section.replaceChildren();
	const wakes = state.session?.wakes ?? [];
	// MOB-05: a phone hides an empty list rather than spending two lines above the transcript.
	section.dataset.empty = String(wakes.length === 0);
	if (wakes.length === 0) {
		section.append(span("No scheduled wakes.", "hint"));
		return;
	}
	const heading = document.createElement("h3");
	heading.textContent = `Scheduled wakes (${wakes.length})`;
	const list = document.createElement("ul");
	for (const wake of wakes) {
		const row = document.createElement("li");
		row.append(refLink(wake.url, "schedule", wake.subject || "Untitled wake"), " · ");
		const time = document.createElement("time");
		time.dateTime = new Date(wake.nextAt).toISOString();
		time.textContent = when(wake.nextAt);
		row.append(time);
		if (wake.cron) row.append(span(` · recurring (${wake.cron})`, "hint"));
		list.append(row);
	}
	section.append(heading, list);
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
	renderHistoryControls();
	for (const entry of entries) container.append(entryElement(entry));
	if (entries.length === 0) empty(container, "No transcript yet.");
}

// UX-18: an open transcript shows its newest entries, then loads older ones a page at a time.
const TRANSCRIPT_PAGE_SIZE = 30;
/** Large enough that loading a whole transcript normally takes one request per 500 entries. */
const TRANSCRIPT_ALL_PAGE_SIZE = 500;
/** Bumped by every open and reload, so a late page from the previous window cannot render. */
let transcriptVersion = 0;
/** The open window: the oldest loaded entry ID (for `before`) and how many pages are loaded. */
let transcriptWindow = { previous: undefined, pages: 0 };

/** One transcript page from the route, oldest first, plus the cursor toward older entries. */
async function fetchTranscriptPage(id, params) {
	const query = new URLSearchParams(params);
	return transcriptPage(await api("GET", `/sessions/${id}/transcript?${query}`));
}

/** UX-18: "load older" while history remains, and "load all" once a page has been loaded. */
function renderHistoryControls() {
	const container = $("transcript");
	container.querySelector(":scope > [data-history]")?.remove();
	if (transcriptWindow.previous === undefined) return;
	const controls = document.createElement("div");
	controls.className = "transcript-history";
	controls.dataset.history = "";
	controls.dataset.testid = "transcript-history";
	const older = document.createElement("button");
	older.type = "button";
	older.className = "more";
	older.dataset.testid = "transcript-earlier";
	older.textContent = "Load older entries";
	older.addEventListener("click", () => void loadOlderTranscript({ all: false }));
	controls.append(older);
	if (transcriptWindow.pages > 1) {
		const all = document.createElement("button");
		all.type = "button";
		all.className = "more";
		all.dataset.testid = "transcript-earlier-all";
		all.textContent = "Load all older entries";
		all.addEventListener("click", () => void loadOlderTranscript({ all: true }));
		controls.append(all);
	}
	container.prepend(controls);
}

/**
 * UX-18: fetch the page before the window's oldest entry, or every page before it, and prepend
 * them without moving the entry the reader is looking at.
 */
async function loadOlderTranscript({ all = false } = {}) {
	const id = state.session?.id;
	if (!id || transcriptWindow.previous === undefined) return;
	const version = transcriptVersion;
	const container = $("transcript");
	const anchor = container.querySelector(":scope > .entry");
	const top = anchor?.getBoundingClientRect().top;
	const focused = document.activeElement?.dataset?.testid;
	const fromControls = focused === "transcript-earlier" || focused === "transcript-earlier-all";
	for (const button of container.querySelectorAll("[data-history] button")) button.disabled = true;
	status(all ? "Loading the whole transcript…" : "Loading older entries…");
	let collected = [];
	let previous = transcriptWindow.previous;
	let pages = 0;
	try {
		while (previous !== undefined) {
			const pageSize = all ? TRANSCRIPT_ALL_PAGE_SIZE : TRANSCRIPT_PAGE_SIZE;
			const page = await fetchTranscriptPage(id, { before: String(previous), limit: String(pageSize) });
			if (version !== transcriptVersion) return;
			// Pages arrive newest first; the oldest page goes in front, so the window stays ascending.
			collected = [...page.entries, ...collected];
			previous = page.previous;
			pages += 1;
			if (!all) break;
		}
		transcriptWindow = { previous, pages: transcriptWindow.pages + pages };
		const fragment = document.createDocumentFragment();
		for (const entry of collected) fragment.append(entryElement(entry));
		const first = fragment.firstElementChild;
		container.insertBefore(fragment, anchor);
		renderHistoryControls();
		// A keyboard reader keeps their place: the same control, or the newly loaded entries when
		// nothing older is left. A mouse click leaves focus where it was.
		const again = container.querySelector(`[data-history] [data-testid="${focused === "transcript-earlier-all" ? "transcript-earlier-all" : "transcript-earlier"}"]`);
		if (fromControls && again) again.focus({ preventScroll: true });
		else if (fromControls && first) {
			first.setAttribute("tabindex", "-1");
			first.focus({ preventScroll: true });
		}
		if (anchor) window.scrollBy(0, anchor.getBoundingClientRect().top - top);
		status(collected.length === 0 ? "No older entries." : `Loaded ${collected.length} older ${collected.length === 1 ? "entry" : "entries"}.`);
	} catch (error) {
		if (version !== transcriptVersion) return;
		renderHistoryControls();
		fail(error);
	}
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
	node.className = "body markdown prose";
	if (testid) node.dataset.testid = testid;
	const { marked, DOMPurify } = window.MailRenderers ?? {};
	// The HTML is in place when this returns; only images and diagrams finish later.
	void renderMessage(node, text, {
		marked,
		DOMPurify,
		domain: state.domain,
		fetchFile,
		cache: fileUrls,
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
	await openSession(state.session.id);
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
//
// One thing at a time (MEM-10, MEM-11): the browse view (files and the log), one file, one
// commit, or the full-view editor. A file view keeps no list and no editor beside it, because
// the same screen is a phone.

/** Where a memory detail view goes back to: the browse view unless a file history opened it. */
let memoryBack = "#/memory";
/** The file being edited; "" while creating a new one. */
let memoryEditingPath = "";
let memoryEditorLoad = 0;
let memoryEditorReady = false;

function showMemoryDetail(which) {
	memoryEditorLoad++; // Invalidate pending editor reads when navigating to any memory view.
	memoryEditorReady = false;
	$("memory-browse").hidden = which !== "browse";
	$("memory-file-view").hidden = which !== "file";
	$("memory-edit-view").hidden = which !== "edit";
	$("memory-commit-view").hidden = which !== "commit";
}

function fileSize(bytes) {
	const size = Number(bytes) || 0;
	if (size < 1024) return `${size} B`;
	if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
	return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

async function loadMemory() {
	showMemoryDetail("browse");
	const [worktree, listing] = await Promise.all([api("GET", "/memory/worktree"), api("GET", "/memory/files")]);
	$("memory-worktree").textContent = worktree?.path ? `Your worktree: ${worktree.path}` : "No memory worktree yet.";
	const files = asList(listing, ["files"]);
	const list = $("memory-files");
	list.replaceChildren();
	if (files.length === 0) {
		empty(list, "Memory is empty.");
	} else {
		for (const file of files) {
			const row = item(file.path, [fileSize(file.size)], () => {
				memoryBack = "#/memory";
				location.hash = memoryFileHref(file.path);
			}, { testid: "memory-file-item", id: file.path });
			row.dataset.path = file.path;
			list.append(row);
		}
	}
	const body = await api("GET", "/memory/log");
	memoryLogRows($("memory-log"), asList(body, ["commits"]), (commit) => {
		memoryBack = "#/memory";
		location.hash = memoryCommitHref(commit.hash);
	});
}

/** A log's rows. `onOpen` receives the mapped commit; each row also links its author. */
function memoryLogRows(list, commits, onOpen, testid = "memory-commit") {
	list.replaceChildren();
	if (commits.length === 0) return empty(list, "No memory commits yet.");
	for (const raw of commits) {
		const commit = commitView(raw);
		const aside = document.createElement("div");
		aside.className = "item-aside";
		aside.append(timeEl(Date.parse(commit.at)));
		const author = refLink(commit.author, "user", refLabel(commit.author), commit.author);
		list.append(item(commit.message, [author, span(commit.short, "commit-hash")], () => onOpen(commit), { testid, id: commit.hash, aside }));
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
		const row = item(hit.path, [hit.text], () => {
			memoryBack = "#/memory";
			location.hash = memoryFileHref(hit.path);
		}, { testid: "memory-result" });
		row.dataset.path = hit.path;
		list.append(row);
	}
}

function memoryPath(path) {
	return path.split("/").map(encodeURIComponent).join("/");
}

async function openMemoryFile(path, showSource = false) {
	if (!path) return loadMemory();
	showMemoryDetail("file");
	$("memory-path").textContent = path;
	$("memory-delete").dataset.path = path;
	$("memory-delete-confirmation").hidden = true;
	$("memory-edit-link").href = memoryEditHref(path);
	$("memory-file-back").href = memoryBack || "#/memory";
	const meta = $("memory-file-meta");
	meta.replaceChildren();
	$("memory-file-log").replaceChildren();
	$("memory-file-history-section").hidden = true;

	const file = memoryFileView(await api("GET", `/memory/files/${memoryPath(path)}`));
	$("memory-path").replaceChildren(copyLink(file.url, "memory", path));
	const markdown = /\.(?:md|markdown|mdown|mkd|mdx)$/i.test(path);
	const raw = showSource || !markdown;
	const body = $("memory-file");
	body.classList.toggle("memory-markdown", !raw);
	body.classList.toggle("raw", raw);
	body.replaceChildren();
	// A Markdown file reads as prose; Source shows the exact bytes an editor will open.
	const source = $("memory-source");
	source.hidden = !markdown;
	source.textContent = raw ? "Rendered" : "Source";
	source.dataset.href = raw ? memoryFileHref(path) : `${memoryFileHref(path)}?source=1`;
	if (raw) {
		body.textContent = file.content;
	} else {
		await ensureVendor();
		const { marked, DOMPurify } = window.MailRenderers ?? {};
		await renderMessage(body, file.content, {
			marked,
			DOMPurify,
			domain: state.domain,
			fetchFile,
			cache: fileUrls,
			ensureMermaid,
			idPrefix: `memory-${file.commit.slice(0, 8)}`,
			dark: matchMedia("(prefers-color-scheme: dark)").matches,
		});
	}

	meta.append(span(`main @ ${file.commit.slice(0, 8)}`, "commit-hash"));
	const history = asList(await api("GET", `/memory/log?path=${encodeURIComponent(path)}&limit=10`), ["commits"]);
	const latest = history[0] ? commitView(history[0]) : undefined;
	if (latest) {
		meta.append(refLink(latest.author, "user", refLabel(latest.author), latest.author), timeEl(Date.parse(latest.at)));
	}
	$("memory-file-history-section").hidden = history.length === 0;
	memoryLogRows($("memory-file-log"), history, (commit) => {
		memoryBack = memoryFileHref(path);
		location.hash = memoryCommitHref(commit.hash);
	}, "memory-file-commit");
}

/** The classes a `git show` patch line gets. Headers first: `+++`/`---` are not additions. */
function patchLineClass(line) {
	if (/^(diff --git|index |old mode |new mode |deleted file mode |new file mode |similarity index |rename |--- |\+\+\+ |Binary files |\\ No newline)/.test(line)) return "meta";
	if (line.startsWith("@@")) return "hunk";
	if (line.startsWith("+")) return "add";
	if (line.startsWith("-")) return "del";
	return "context";
}

function patchElement(text) {
	const pre = document.createElement("pre");
	pre.className = "patch";
	for (const line of text.split("\n")) {
		const node = document.createElement("span");
		node.className = `patch-line ${patchLineClass(line)}`;
		node.textContent = line;
		pre.append(node);
	}
	return pre;
}

function commitFileElement(file) {
	const section = document.createElement("section");
	section.className = "commit-file";
	section.dataset.path = file.path;
	const head = document.createElement("header");
	head.className = "commit-file-head";
	head.append(span(file.path, "commit-file-path"), badge(file.status));
	if (file.binary) head.append(span("binary", "hint"));
	else head.append(span(`+${file.additions} −${file.deletions}`, "commit-stat"));
	section.append(head);
	if (file.patch.length > 0) section.append(patchElement(file.patch));
	else section.append(span(file.binary ? "Binary file" : "No textual changes", "hint"));
	if (file.truncated) section.append(span("Patch truncated — open the file in git to see the rest.", "hint"));
	return section;
}

async function openMemoryCommit(hash) {
	if (!hash) return loadMemory();
	showMemoryDetail("commit");
	$("memory-commit-back").href = memoryBack || "#/memory";
	const commit = memoryCommitView(await api("GET", `/memory/commits/${encodeURIComponent(hash)}`));
	$("memory-commit-subject").textContent = commit.subject || "(no subject)";
	const meta = $("memory-commit-meta");
	meta.replaceChildren(
		span(commit.short, "commit-hash"),
		refLink(commit.author, "user", refLabel(commit.author), commit.author),
		timeEl(Date.parse(commit.at)),
		span(commit.files.length === 1 ? "1 file" : `${commit.files.length} files`),
	);
	const message = $("memory-commit-message");
	message.textContent = commit.body;
	message.hidden = commit.body.length === 0;
	const files = $("memory-commit-files");
	files.replaceChildren();
	if (commit.files.length === 0) {
		empty(files, "This commit changed no files (a merge or an empty commit).");
	} else {
		for (const file of commit.files) files.append(commitFileElement(file));
	}
	if (commit.truncated) files.append(span("A patch was cut short for this screen; the commit itself is complete.", "hint"));
}

// ---- The memory editor ----------------------------------------------------------------------
// CodeMirror 6 in a pana-built bundle (web/memory-editor-vendor.js), loaded only when someone
// edits: the browse view stays a few files, and the editor is ready by the time they type.

let editorLoading;
function ensureMemoryEditor() {
	if (window.PanaMemoryEditor) return Promise.resolve(window.PanaMemoryEditor);
	if (!editorLoading) {
		editorLoading = new Promise((resolve, reject) => {
			const script = document.createElement("script");
			script.src = "/memory-editor-vendor.js";
			script.onload = () => {
				if (window.PanaMemoryEditor) resolve(window.PanaMemoryEditor);
				else reject(new Error("The editor bundle did not expose an editor."));
			};
			script.onerror = () => reject(new Error("The editor bundle failed to load."));
			document.head.append(script);
		}).catch((error) => {
			document.querySelector('script[src="/memory-editor-vendor.js"]')?.remove();
			editorLoading = undefined;
			throw error;
		});
	}
	return editorLoading;
}

let memoryEditor;
let memoryBaseCommit = null;

async function openMemoryEditor(path) {
	showMemoryDetail("edit");
	const load = memoryEditorLoad;
	$("memory-save").disabled = true;
	memoryEditingPath = path;
	const creating = path.length === 0;
	$("memory-edit-title").textContent = creating ? "New file" : path;
	$("memory-edit-back").href = creating ? "#/memory" : memoryFileHref(path);
	$("memory-path-field").hidden = !creating;
	$("memory-path-input").value = path;
	let content = "";
	let baseCommit = null; // New files are create-only, never accidental overwrites.
	if (!creating) {
		const file = memoryFileView(await api("GET", `/memory/files/${memoryPath(path)}`));
		content = file.content;
		baseCommit = file.commit;
	}

	if (load !== memoryEditorLoad) return;
	const parent = $("memory-editor");
	if (!memoryEditor) empty(parent, "Loading editor…");
	const lib = await ensureMemoryEditor();
	if (load !== memoryEditorLoad) return;
	if (!memoryEditor) {
		parent.replaceChildren();
		memoryEditor = lib.create(parent, () => {});
		// CodeMirror handles Enter itself, so the submit chord is caught before the editor can
		// claim it; the document-level keymap (UX-02) never sees it otherwise.
		parent.addEventListener(
			"keydown",
			(event) => {
				if (!isSubmitChord(event, APPLE)) return;
				event.preventDefault();
				$("memory-edit-form").requestSubmit();
			},
			true,
		);
	}
	memoryEditor.load(content);
	memoryBaseCommit = baseCommit; // Install the content and its token together.
	memoryEditorReady = true;
	$("memory-save").disabled = false;
	if (creating) $("memory-path-input").focus();
	else memoryEditor.focus();
}

async function saveMemory(event) {
	event?.preventDefault();
	const typed = $("memory-path-input").value.trim().replace(/^\/+/, "");
	const path = memoryEditingPath || typed;
	if (!path) {
		status("Give the file a path first.", true);
		$("memory-path-input").focus();
		return;
	}
	if (!memoryEditor || !memoryEditorReady) return status("The editor is still loading.", true);
	const save = $("memory-save");
	save.disabled = true;
	try {
		await api("POST", `/memory/files/${memoryPath(path)}`, { content: memoryEditor.value(), baseCommit: memoryBaseCommit });
		status("Saved and committed to main.");
		memoryBack = "#/memory";
		location.hash = memoryFileHref(path);
	} catch (error) {
		fail(error);
	} finally {
		save.disabled = false;
	}
}

async function deleteMemory() {
	const button = $("memory-delete-confirm");
	const path = $("memory-delete").dataset.path;
	if (!path || button.disabled) return;
	button.disabled = true;
	try {
		await api("DELETE", `/memory/files/${memoryPath(path)}`);
		status("Deleted and committed to main. Git history is preserved.");
		memoryBack = "#/memory";
		location.hash = "#/memory";
	} catch (error) {
		fail(error);
	} finally {
		button.disabled = false;
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
let schedulesRequest = 0;

async function loadSchedules(focus, cursor) {
	const request = ++schedulesRequest;
	const kind = $("schedules-kind").value;
	const list = $("schedules-list");
	if (!cursor) list.replaceChildren();
	let body;
	try {
		body = await api("GET", pagePath(kind ? `/schedules?kind=${kind}` : "/schedules", cursor));
		if (focus && !asList(body, ["schedules"]).some((schedule) => schedule.id === focus)) {
			const shown = await api("GET", `/schedules/${encodeURIComponent(focus)}`);
			body.schedules.unshift(shown.schedule);
		}
	} catch (error) {
		if (request === schedulesRequest) throw error;
		return;
	}
	// Changing filters invalidates pending responses, including Load more from the old kind.
	if (request !== schedulesRequest) return;
	const schedules = asList(body, ["schedules"]);
	if (schedules.length === 0 && !cursor) return empty(list, kind ? `No ${kind} schedules yet.` : "No schedules yet.");
	for (const schedule of schedules) {
		// A focused schedule can have been fetched ahead of its normal list page.
		if ([...list.children].some((row) => row.dataset.id === schedule.id)) continue;
		const payload = schedule.payload ?? {};
		const checkView = scheduleCheckView(schedule, when);
		const meta = [
			// UX-17: a schedule's own ID copies its URL without starting an edit.
			copyLink(schedule.url ?? `pana://${state.domain}/schedules/${schedule.id}`, "schedule", schedule.id),
			// WAK-04: a wake names the session it wakes.
			schedule.kind === "wake" && typeof payload.session === "string" ? refLink(payload.session, "session", `wakes ${payload.session.slice(-6)}`) : undefined,
			`${schedule.kind} · ${schedule.cron ?? when(schedule.at)} · ${schedule.state}`,
			`next ${when(schedule.nextAt)}`,
			schedule.check ? "Conditional" : undefined,
			schedule.stopAfterSuccess ? "Stops after successful dispatch" : undefined,
			schedule.check || schedule.lastCheck ? `Last check: ${checkView.status}` : undefined,
		];
		const edit = rowAction("schedule-edit", "Edit", () => startScheduleEdit(schedule));
		delete edit.dataset.action;
		const remove = rowAction("schedule-delete", "Delete", () => void deleteSchedule(schedule.id));
		remove.dataset.action = "delete-schedule";
		remove.dataset.id = schedule.id;
		remove.classList.add("danger");
		// A wake is made by a session for itself; the schedule form edits session and thread schedules only.
		const wake = schedule.kind === "wake";
		const content = details("schedule-content", "Full prompt / message / note", String(payload.prompt ?? payload.body ?? payload.note ?? ""), { testid: "schedule-content" });
		const below = document.createElement("div");
		below.append(content);
		if (checkView) below.append(details("schedule-content", "Run conditions / check details", checkView.text, { testid: "schedule-conditions" }));
		// Disclosures are independent of the row's edit action (including keyboard activation).
		below.addEventListener("click", (event) => event.stopPropagation());
		below.addEventListener("keydown", (event) => event.stopPropagation());
		const row = item(schedule.subject || "Untitled schedule", meta, wake ? () => {} : () => startScheduleEdit(schedule), {
			testid: "schedule-item",
			id: schedule.id,
			below,
			actions: wake ? [remove] : [edit, remove],
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
	$("schedule-subject").value = schedule.subject ?? "";
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
	$("schedule-subject").value = "";
	$("schedule-prompt").value = "";
	$("schedule-when").value = "";
	$("schedule-to").value = "";
}

async function createSchedule(event) {
	event.preventDefault();
	const text = $("schedule-prompt").value.trim();
	if (!text) return status("Write a prompt first.", true);
	const form = { subject: $("schedule-subject").value, kind: $("schedule-kind").value, when: $("schedule-when").value, text, to: $("schedule-to").value };
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

// ---- Objectives (OBJ-39) ---------------------------------------------------------------------
// A list of objectives and the one view a person uses to watch and steer one: goal, charter,
// metrics, the newest report, artifacts, the roster, money and runs, the pending wakes, and the
// escalation. Every action that spends money or retires a session asks first.

const OBJECTIVE_PHASES = ["drafting", "active", "stopped", "done", "archived"];
const SVG_NS = "http://www.w3.org/2000/svg";
/** UX-09: a member's state changes arrive as `session.state`; one re-read follows a burst of them. */
const OBJECTIVE_REFRESH_MS = 400;

let objectiveListRequest = 0;
/** The objective the view is showing: its view, metrics, charter, and each member's session detail. */
let objectiveDetail = null;
/** Which read the view is drawing: a slower answer from an older objective must not overwrite it. */
let objectiveVersion = 0;
/** The action a pending confirmation guards: `launch`, `stop`, or `regenerate`. */
let objectivePending = null;
let objectiveRefresh;

async function loadObjectives(cursor) {
	const request = ++objectiveListRequest;
	const phase = $("objectives-phase").value;
	const body = await api("GET", pagePath(phase ? `/objectives?phase=${encodeURIComponent(phase)}` : "/objectives", cursor));
	if (request !== objectiveListRequest) return;
	const list = $("objectives-list");
	if (!cursor) list.replaceChildren();
	const rows = asList(body, ["objectives"]);
	if (rows.length === 0 && !cursor) {
		return empty(
			list,
			phase
				? `No ${phase} objectives.`
				: "No objectives yet. An objective is stated work with a lifetime: a goal, a charter of standing instructions, one lead session that coordinates, members that do the work, and money and runs that stop it. A draft costs nothing until it is launched.",
		);
	}
	for (const raw of rows) {
		const row = objectiveRow(raw);
		learnDomain(row.url);
		const title = document.createDocumentFragment();
		title.append(span(row.phase, "badge phase-badge"), " ");
		// OBJ-03: the derived state, which is a function of other rows and never stored.
		if (row.state) title.append(span(row.state, "badge state-badge"), " ");
		if (row.holding) title.append(span(row.holding, "badge holding-badge"), " ");
		title.append(linkified(row.goal));
		const meta = [
			row.lead ? refLink(row.lead, "session", `lead ${refLabel(row.lead)}`, row.lead) : "no lead yet",
			`spent ${cost(row.spendTodayUsd)} today`,
			`${row.leadRunsToday} ${row.leadRunsToday === 1 ? "run" : "runs"} today`,
			row.dueAt ? `due ${shortTime(row.dueAt)}` : undefined,
		];
		const aside = document.createElement("div");
		aside.className = "item-aside";
		aside.append(timeEl(row.at));
		list.append(
			item(title, meta, () => {
				location.hash = `#/objectives/${row.id}`;
			}, { testid: "objective-item", id: row.id, aside }),
		);
	}
	showMore(list, nextCursor(body), (next) => loadObjectives(next).catch(fail));
}

/**
 * WAK-08: a wake belongs to a session, so each member's own session detail is where the objective's
 * pending wakes and live states come from; the roster and the wakes then read what the session
 * view reads, rather than a second definition of either.
 */
async function memberSessions(members) {
	const details = await Promise.all(
		members
			.filter((member) => member.id)
			.map((member) => api("GET", `/sessions/${encodeURIComponent(member.id)}`).catch(() => undefined)),
	);
	return details.filter((detail) => detail?.session);
}

async function openObjective(id) {
	const version = ++objectiveVersion;
	clearTimeout(objectiveRefresh);
	const [shown, metrics, charter] = await Promise.all([
		api("GET", `/objectives/${encodeURIComponent(id)}`),
		api("GET", `/objectives/${encodeURIComponent(id)}/metrics`),
		api("GET", `/objectives/${encodeURIComponent(id)}/charter`),
	]);
	if (version !== objectiveVersion) return;
	const view = objectiveView(shown.objective);
	learnDomain(view.url);
	const members = await memberSessions(view.members);
	if (version !== objectiveVersion) return;
	objectiveDetail = { view, metrics: metricsView(metrics), charter: charterView(charter), members };
	objectivePending = null;
	$("objective-confirm").hidden = true;
	$("objectives-browse").hidden = true;
	$("objectives-list").hidden = true;
	$("objective").hidden = false;
	renderObjective();
}

/** OBJ-03: after a member's state changes, the derived state and the meters are re-read, not guessed. */
async function refreshObjective() {
	const current = objectiveDetail;
	if (!current || $("objective").hidden) return;
	const version = objectiveVersion;
	const shown = await api("GET", `/objectives/${encodeURIComponent(current.view.id)}`);
	if (!objectiveDetail || objectiveDetail !== current || version !== objectiveVersion) return;
	const view = objectiveView(shown.objective);
	const members = await memberSessions(view.members);
	if (!objectiveDetail || objectiveDetail !== current || version !== objectiveVersion) return;
	current.view = view;
	current.members = members;
	// The charter editor and the charts are left alone: neither is a function of a session's state,
	// and redrawing them would take the cursor out of someone's writing.
	current.view.meters = view.meters;
	renderObjectiveHead();
	renderObjectiveMeters();
	renderObjectiveMembers();
	renderObjectiveWakes();
	renderObjectiveEscalation();
}

function scheduleObjectiveRefresh() {
	clearTimeout(objectiveRefresh);
	objectiveRefresh = setTimeout(() => void refreshObjective().catch(() => {}), OBJECTIVE_REFRESH_MS);
}

function renderObjective() {
	renderObjectiveHead();
	renderObjectiveMeters();
	renderObjectiveMetrics();
	renderObjectiveCharter();
	renderObjectiveReport();
	renderObjectiveArtifacts();
	renderObjectiveMembers();
	renderObjectiveWakes();
	renderObjectiveEscalation();
}

function renderObjectiveHead() {
	const view = objectiveDetail.view;
	$("objective-goal").textContent = view.goal;
	const meta = $("objective-meta");
	meta.replaceChildren(badge(view.phase, "state-badge"));
	if (view.state) meta.append(badge(view.state, "state-badge"));
	if (view.holding) {
		const holding = span(view.holding, "badge holding-badge");
		holding.dataset.testid = "objective-holding";
		meta.append(holding);
	}
	if (view.lead) meta.append(refLink(view.lead, "session", `lead ${refLabel(view.lead)}`, view.lead));
	// OBJ-05: an active objective always has its own thread, and that is where its mail is.
	if (view.thread) meta.append(refLink(view.thread.url, "thread", "thread", view.thread.url));
	if (view.proposedBy) meta.append(span(`proposed by ${refLabel(view.proposedBy)}`, "hint"));
	meta.append(span(view.autonomy === "auto" ? "autonomy: auto" : "autonomy: manual", "hint"));
	if (view.dueAt) meta.append(span(`due ${when(view.dueAt)}`, "hint"));
	const url = document.createElement("span");
	url.className = "hint objective-url";
	url.dataset.testid = "objective-url";
	url.append(copyLink(view.url || `pana://${state.domain}/objectives/${view.id}`, "objective"));
	meta.append(url);
	// OBJ-07/OBJ-35: the actions each phase offers. Launch is the user's alone, and a draft is the
	// only phase that launches; regenerate replaces a lead, so it needs an active objective.
	$("objective-launch").hidden = view.phase !== "drafting";
	$("objective-stop").hidden = view.phase !== "active";
	$("objective-regenerate").hidden = view.phase !== "active" || !view.lead;
	$("objective-charter-rev").textContent = `revision ${view.charterRev}`;
}

/** OBJ-20..OBJ-24: money and runs against the limits that stop the objective. */
function renderObjectiveMeters() {
	const container = $("objective-meters");
	container.replaceChildren();
	for (const meter of objectiveDetail.view.meters) {
		const row = document.createElement("div");
		row.className = "meter";
		row.dataset.testid = "objective-meter";
		row.dataset.meter = meter.id;
		const head = document.createElement("div");
		head.className = "meter-head";
		head.append(span(meter.label, "meter-label"));
		const value = document.createElement("span");
		value.className = "meter-value";
		value.dataset.testid = "objective-meter-value";
		value.textContent = meterText(meter);
		if (meter.over) value.dataset.over = "true";
		head.append(value);
		// OBJ-39: say where the number came from, so a bar that is not the objective's own is named.
		row.dataset.source = meter.source;
		if (meter.source !== "objective") head.append(span(meterSourceLabel(meter), "meter-source"));
		row.append(head);
		if (meter.share !== null) {
			const bar = document.createElement("div");
			bar.className = "meter-bar";
			bar.setAttribute("role", "img");
			bar.setAttribute("aria-label", `${meter.label}: ${value.textContent}`);
			const fill = document.createElement("div");
			fill.className = "meter-fill";
			fill.style.width = `${Math.round(meter.share * 100)}%`;
			if (meter.over) fill.dataset.over = "true";
			bar.append(fill);
			row.append(bar);
		}
		container.append(row);
	}
}

/**
 * A meter's reading (OBJ-20..OBJ-24, OBJ-39). The limit is the effective one: the objective's own,
 * the domain's configured default, or nothing. `meterSourceLabel` names the second and third.
 */
function meterText(meter) {
	const shown = meter.unit === "usd" ? (value) => cost(value) : (value) => String(value);
	if (meter.limit === null) return `${shown(meter.value)} · no limit`;
	return `${shown(meter.value)} of ${shown(meter.limit)}`;
}

/** Where a meter's limit came from, in the small print a reader sees beside the number. */
function meterSourceLabel(meter) {
	if (meter.source === "config") return "from the domain's config";
	return "no limit set";
}

/**
 * OBJ-28: one chart per metric, each with its own line and its target line. The count under the
 * heading is a count of metrics at their own targets, never a percent-to-target total.
 */
function renderObjectiveMetrics() {
	const container = $("objective-metrics");
	container.replaceChildren();
	const view = objectiveDetail.metrics;
	$("objective-at-target").textContent = view.atTarget.of === 0 ? "no metric has a target" : `${view.atTarget.count} of ${view.atTarget.of} at target`;
	if (view.metrics.length === 0) {
		return empty(container, "No metrics. A metric is a name, a unit, and a direction; its first reading sets its baseline, and a target makes the objective finite.");
	}
	for (const series of view.metrics) {
		const figure = document.createElement("figure");
		figure.className = "metric";
		figure.dataset.testid = "objective-metric";
		figure.dataset.metric = series.name;
		const caption = document.createElement("figcaption");
		caption.append(span(series.name, "metric-name"));
		const current = span(
			series.current.stale ? "no reading in its window" : series.current.display ?? "no readings yet",
			"metric-current",
		);
		current.dataset.testid = "metric-current";
		caption.append(current);
		caption.append(
			span(series.targetDisplay === null ? "no target" : `target ${series.targetDisplay}`, "hint metric-target-label"),
		);
		if (series.atTarget === true) caption.append(span("at target", "badge"));
		caption.title = [
			series.baseline === null ? "no baseline yet" : `baseline ${series.baselineDisplay ?? series.baseline}`,
			series.aggregation === "mean" && series.window ? `mean over ${series.window}` : "latest reading",
			series.check ? `checked from the world${series.check.lastCheck ? ` (last check ${series.check.lastCheck})` : ""}` : undefined,
		]
			.filter(Boolean)
			.join(" · ");
		figure.append(caption, metricChartElement(series));
		container.append(figure);
	}
}

/** One metric's drawing: its line through its readings, and its target line across the box. */
function metricChartElement(series) {
	const box = { width: 320, height: 64, pad: 6 };
	const chart = metricChart(series, box);
	const svg = document.createElementNS(SVG_NS, "svg");
	svg.setAttribute("viewBox", `0 0 ${box.width} ${box.height}`);
	svg.setAttribute("preserveAspectRatio", "none");
	svg.setAttribute("role", "img");
	svg.setAttribute("aria-label", `${series.name}: ${series.current.display ?? "no readings"}${series.targetDisplay === null ? "" : `, target ${series.targetDisplay}`}`);
	svg.classList.add("metric-chart");
	svg.dataset.testid = "metric-chart";
	if (!chart.empty && chart.target !== null) {
		const target = document.createElementNS(SVG_NS, "line");
		target.setAttribute("x1", "0");
		target.setAttribute("x2", String(box.width));
		target.setAttribute("y1", String(chart.target.y));
		target.setAttribute("y2", String(chart.target.y));
		target.setAttribute("class", "metric-target");
		svg.append(target);
	}
	if (!chart.empty) {
		const line = document.createElementNS(SVG_NS, "polyline");
		line.setAttribute("points", chart.line);
		line.setAttribute("class", "metric-line");
		line.dataset.testid = "metric-line";
		svg.append(line);
		// A metric read once has one point and no line: mark it, so it is not an empty chart.
		for (const dot of chart.dots ?? []) {
			if ((chart.dots ?? []).length > 1) break;
			const mark = document.createElementNS(SVG_NS, "circle");
			mark.setAttribute("cx", String(dot.x));
			mark.setAttribute("cy", String(dot.y));
			mark.setAttribute("r", "3");
			mark.setAttribute("class", "metric-dot");
			svg.append(mark);
		}
	}
	return svg;
}

/**
 * OBJ-09/OBJ-10: the charter, one block per section with its newest revision. The user edits any
 * section; `Notes` is also where the lead keeps its own writing.
 */
function renderObjectiveCharter() {
	const container = $("objective-charter");
	container.replaceChildren();
	for (const section of objectiveDetail.charter.sections) {
		const block = document.createElement("section");
		block.className = "charter-section";
		block.dataset.testid = "charter-section";
		block.dataset.section = section.name;
		const head = document.createElement("header");
		head.className = "charter-section-head";
		const title = document.createElement("h4");
		title.textContent = section.name;
		head.append(title);
		head.append(
			span(
				section.rev === null ? "never written" : `revision ${section.rev} · ${refLabel(section.author)} · ${shortTime(section.at)}`,
				"hint",
			),
		);
		const edit = document.createElement("button");
		edit.type = "button";
		edit.className = "link-button";
		edit.dataset.testid = "charter-edit";
		edit.dataset.section = section.name;
		edit.textContent = "Edit";
		head.append(edit);
		block.append(head);
		if (section.body.trim().length > 0) block.append(markdownElement(section.body, "charter-body"));
		else {
			block.append(
				span(
					section.name === "Notes"
						? "Empty. The lead keeps its own durable notes here."
						: "Empty. An empty section grants nothing, so the lead escalates instead of guessing.",
					"hint charter-empty",
				),
			);
		}
		container.append(block);
	}
}

function charterBlock(section) {
	return [...document.querySelectorAll("#objective-charter [data-section]")].find((block) => block.dataset.section === section);
}

/**
 * OBJ-09: writing a section sends the revision this editor read as `baseRev`, so a charter that
 * moved underneath it answers 409 instead of overwriting a change nobody saw.
 */
function startCharterEdit(section) {
	const block = charterBlock(section);
	if (!block || block.querySelector("[data-testid=charter-editor]")) return;
	const current = objectiveDetail.charter.sections.find((entry) => entry.name === section);
	const form = document.createElement("form");
	form.className = "charter-editor";
	form.dataset.testid = "charter-editor";
	form.dataset.section = section;
	form.dataset.baseRev = String(objectiveDetail.charter.rev);
	const field = document.createElement("div");
	field.className = "field";
	const label = document.createElement("label");
	label.textContent = `${section} (Markdown)`;
	const textarea = document.createElement("textarea");
	textarea.rows = 6;
	textarea.value = current?.body ?? "";
	textarea.dataset.testid = "charter-text";
	field.append(label, textarea);
	const actions = document.createElement("div");
	actions.className = "form-actions";
	const cancel = document.createElement("button");
	cancel.type = "button";
	cancel.dataset.testid = "charter-cancel";
	cancel.textContent = "Cancel";
	cancel.addEventListener("click", () => {
		form.remove();
		block.querySelector("[data-testid=charter-edit]")?.focus();
	});
	const save = document.createElement("button");
	save.type = "submit";
	save.className = "primary";
	save.dataset.testid = "charter-save";
	save.textContent = "Save";
	actions.append(cancel, save);
	form.append(field, actions);
	form.addEventListener("submit", (event) => void saveCharterSection(event, section));
	block.append(form);
	textarea.focus();
}

async function saveCharterSection(event, section) {
	event.preventDefault();
	const form = event.currentTarget;
	const textarea = form.querySelector("[data-testid=charter-text]");
	const save = form.querySelector("[data-testid=charter-save]");
	save.disabled = true;
	try {
		const body = await api(
			"POST",
			`/objectives/${encodeURIComponent(objectiveDetail.view.id)}/charter`,
			charterBody(section, textarea.value, Number(form.dataset.baseRev)),
		);
		objectiveDetail.charter = charterView(body);
		status(`${section} saved at revision ${objectiveDetail.charter.rev}.`);
		$("objective-charter-rev").textContent = `revision ${objectiveDetail.charter.rev}`;
		renderObjectiveCharter();
	} catch (error) {
		if (error?.status === 409 && error?.body?.error?.code === "stale_charter") {
			await showCharterConflict(form, section, error);
			return;
		}
		fail(error);
	} finally {
		save.disabled = false;
	}
}

/**
 * OBJ-09/MEM-09: the charter moved while this editor was open. The written text stays in the
 * editor, the newer revision is shown beside it, and saving again sends the revision just read —
 * a conflict costs one read rather than the writing.
 */
async function showCharterConflict(form, section, error) {
	const fresh = charterView(await api("GET", `/objectives/${encodeURIComponent(objectiveDetail.view.id)}/charter`));
	objectiveDetail.charter = fresh;
	form.dataset.baseRev = String(fresh.rev);
	const newest = fresh.sections.find((entry) => entry.name === section);
	const notice = document.createElement("div");
	notice.className = "notice charter-conflict";
	notice.dataset.testid = "charter-conflict";
	const message = document.createElement("p");
	message.textContent = `The charter moved to revision ${fresh.rev}; you read ${error?.body?.error?.baseRev ?? "an older revision"}. Your text is still here. Saving again writes over the newest revision.`;
	notice.append(message);
	if (newest && newest.body.trim().length > 0) {
		const label = document.createElement("p");
		label.className = "hint";
		label.textContent = `${section} at revision ${fresh.rev}:`;
		notice.append(label, markdownElement(newest.body, "charter-conflict-body"));
	}
	const save = document.createElement("button");
	save.type = "button";
	save.dataset.testid = "charter-save-over";
	save.className = "danger";
	save.textContent = "Save mine over it";
	save.addEventListener("click", () => form.requestSubmit());
	notice.append(save);
	form.querySelector("[data-testid=charter-conflict]")?.remove();
	form.insertBefore(notice, form.querySelector(".field"));
}

/** OBJ-30: the newest report is a message in the objective's thread, rendered as mail is. */
function renderObjectiveReport() {
	const container = $("objective-report");
	container.replaceChildren();
	const report = objectiveDetail.view.report;
	if (!report) return empty(container, "No report yet. A report is a message in the objective's thread, so it keeps its edits, its redaction, and its deliveries.");
	const head = document.createElement("p");
	head.className = "meta-line";
	head.dataset.testid = "objective-report-head";
	head.append(refLink(report.sender, "user", refLabel(report.sender), report.sender));
	head.append(" ");
	head.append(timeEl(report.at));
	head.append(" ");
	head.append(refLink(report.url, "thread", `#${report.messageId.slice(-6)}`, report.url));
	if (report.revised) head.append(span("edited", "badge"));
	if (report.redacted) head.append(span("redacted", "badge"));
	container.append(head, markdownElement(report.body, "objective-report-body"));
}

/** OBJ-31: name, size, and a link that fetches the bytes, because a file needs the token. */
function renderObjectiveArtifacts() {
	const list = $("objective-artifacts");
	list.replaceChildren();
	const artifacts = objectiveDetail.view.artifacts;
	if (artifacts.length === 0) return empty(list, "No artifacts. An artifact is a file linked to the objective, uploaded through the same store a message's attachment uses.");
	for (const artifact of artifacts) {
		const title = document.createDocumentFragment();
		title.append(fileLink(artifact.url, artifact.name));
		const meta = [fileSize(artifact.size), artifact.mediaType ?? undefined].filter(Boolean);
		list.append(item(title, meta, () => undefined, { testid: "objective-artifact", id: artifact.id }));
	}
}

/** FIL-06: a file's bytes arrive with the bearer token, which an anchor cannot send. */
function fileLink(url, label) {
	const href = appHref(url, state.domain);
	const anchor = document.createElement("a");
	anchor.href = href ?? "#";
	anchor.textContent = label;
	anchor.dataset.testid = "objective-artifact-link";
	anchor.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		if (!href) return;
		fetchFile(href)
			.then((blob) => {
				const download = document.createElement("a");
				download.href = URL.createObjectURL(blob);
				download.download = label;
				download.click();
				setTimeout(() => URL.revokeObjectURL(download.href), 10_000);
			})
			.catch(() => status(`Could not open ${label}.`, true));
	});
	return anchor;
}

/** UX-09: the roster, each member's live state beside a link to its session. */
function renderObjectiveMembers() {
	const list = $("objective-members");
	list.replaceChildren();
	const view = objectiveDetail.view;
	const sessions = new Map(objectiveDetail.members.map((detail) => [String(detail?.session?.id ?? ""), detail.session]));
	if (view.members.length === 0) {
		return empty(list, "No members. A lead alone may measure, report, and finish an objective; it creates members for the work that produces something.");
	}
	for (const member of view.members) {
		const detail = sessions.get(member.id);
		const state = String(detail?.state ?? member.state);
		const title = document.createDocumentFragment();
		title.append(span(state, "badge state-badge"));
		const person = span("", "person");
		person.dataset.color = participantColor({ url: member.url, kind: "session" });
		person.append(refLink(member.url || member.id, "session", member.id, member.url));
		title.append(" ", person);
		if (member.lead) title.append(" ", span("lead", "badge"));
		const meta = [
			member.profile ? `profile ${member.profile}` : undefined,
			member.stoppedBy ? `stopped by ${member.stoppedBy}` : undefined,
			detail?.live?.activity ? liveActivityLabel(detail.live, serverNow()) : undefined,
			detail?.costUsd === undefined ? undefined : cost(detail.costUsd),
		];
		list.append(
			item(title, meta, () => {
				location.hash = `#/sessions/${member.id}`;
			}, { testid: "objective-member", id: member.id, sessionId: member.id }),
		);
	}
}

/** WAK-08: the objective's pending wakes, with linked labels, next-run times, and recurrence. */
function renderObjectiveWakes() {
	const container = $("objective-wakes");
	container.replaceChildren();
	const wakes = objectiveWakes(objectiveDetail.members);
	const heading = document.createElement("p");
	heading.className = "hint";
	heading.dataset.testid = "objective-wake-count";
	heading.textContent = wakes.length === 0 ? "No pending wakes." : `${wakes.length} pending wake${wakes.length === 1 ? "" : "s"}.`;
	container.append(heading);
	if (wakes.length === 0) return;
	const list = document.createElement("ul");
	for (const wake of wakes) {
		const row = document.createElement("li");
		row.dataset.testid = "objective-wake";
		row.append(refLink(wake.url, "schedule", wake.subject || "Untitled wake"), " · ");
		row.append(refLink(wake.sessionUrl, "session", `wakes ${wake.sessionId.slice(-6)}`), " · ");
		const time = document.createElement("time");
		time.dateTime = new Date(wake.at).toISOString();
		time.textContent = when(wake.at);
		time.title = untilLabel(wake.at, serverNow());
		row.append(time);
		if (wake.cron) row.append(span(` · recurring (${wake.cron})`, "hint"));
		list.append(row);
	}
	container.append(list);
}

/** The question an escalation asks, read once per message: `GET /messages/:id` is the message. */
const escalationQuestions = new Map();

function escalationQuestion(id) {
	if (!id) return Promise.resolve(undefined);
	if (!escalationQuestions.has(id)) {
		escalationQuestions.set(
			id,
			api("GET", `/messages/${encodeURIComponent(id)}`)
				.then((body) => messageView(body.message))
				.catch(() => undefined),
		);
	}
	return escalationQuestions.get(id);
}

/** OBJ-33/OBJ-34: the escalation, at the scope it holds, the question, and the thread an answer comes from. */
function renderObjectiveEscalation() {
	const node = $("objective-escalation");
	node.replaceChildren();
	const view = objectiveDetail.view;
	node.hidden = !view.awaitingUser;
	if (!view.awaitingUser) return;
	const title = document.createElement("p");
	title.append(span("Waiting for you. ", ""));
	title.append("Nothing this covers starts until you answer in its thread.");
	node.append(title);
	const list = document.createElement("ul");
	for (const escalation of view.escalations) {
		const row = document.createElement("li");
		row.dataset.testid = "objective-escalation-row";
		row.dataset.scope = escalation.scope;
		row.append(
			span(
				escalation.scope === "member" ? `member ${refLabel(escalation.member)}` : "the whole objective",
				"hint",
			),
			" · ",
		);
		row.append(refLink(escalation.threadUrl, "thread", "answer in the thread", escalation.threadUrl));
		if (escalation.timeoutAt) row.append(span(` · until ${when(escalation.timeoutAt)}`, "hint"));
		const question = document.createElement("div");
		question.className = "escalation-question";
		question.dataset.testid = "objective-escalation-question";
		row.append(question);
		void escalationQuestion(escalation.messageId).then((message) => {
			// The view may have moved on while the message was in flight.
			if (!question.isConnected || !message) return;
			question.append(markdownElement(message.body, "objective-escalation-body"));
		});
		list.append(row);
	}
	node.append(list);
}

/** Every action that spends money or retires a session asks first (OBJ-04, OBJ-07, OBJ-35). */
const OBJECTIVE_ACTIONS = {
	launch: {
		question:
			"Launch this objective? It creates the lead session and starts its first run, which begins spending money against the objective's limits.",
		label: "Yes, launch",
		run: (id) => api("POST", `/objectives/${encodeURIComponent(id)}/launch`, {}),
	},
	stop: {
		question:
			"Stop this objective? Its running members stop, their wakes are cancelled, and it starts nothing until you resume it.",
		label: "Yes, stop",
		run: (id) => api("POST", `/objectives/${encodeURIComponent(id)}/stop`, {}),
	},
	regenerate: {
		question:
			"Replace the lead? Its session is stopped and archived, and a new lead starts with the briefing. The old lead's transcript stays readable.",
		label: "Yes, replace the lead",
		reason: true,
		run: (id, reason) => api("POST", `/objectives/${encodeURIComponent(id)}/regenerate-lead`, { reason }),
	},
};

function askObjectiveAction(action) {
	const spec = OBJECTIVE_ACTIONS[action];
	if (!spec || !objectiveDetail) return;
	objectivePending = action;
	$("objective-confirm-text").textContent = spec.question;
	$("objective-reason-field").hidden = !spec.reason;
	$("objective-reason").value = "";
	$("objective-confirm-yes").textContent = spec.label;
	$("objective-confirm").hidden = false;
	(spec.reason ? $("objective-reason") : $("objective-confirm-yes")).focus();
}

function cancelObjectiveAction() {
	objectivePending = null;
	$("objective-confirm").hidden = true;
	$("objective-reason-field").hidden = true;
}

async function confirmObjectiveAction() {
	const action = objectivePending;
	if (!action || !objectiveDetail) return;
	const spec = OBJECTIVE_ACTIONS[action];
	const id = objectiveDetail.view.id;
	const reason = spec.reason ? $("objective-reason").value.trim() : undefined;
	if (spec.reason && reason.length === 0) {
		status("Say why the lead is being replaced: the new lead reads it.", true);
		$("objective-reason").focus();
		return;
	}
	cancelObjectiveAction();
	try {
		await spec.run(id, reason);
		status(action === "launch" ? "Objective launched." : action === "stop" ? "Objective stopped." : "The lead is replaced.");
		await openObjective(id);
	} catch (error) {
		fail(error);
	}
}

/** UX-09: a member's state event patches its badge now and re-reads the derived state after the burst. */
function applyObjectiveStateEvent(event) {
	if (!objectiveDetail || $("objective").hidden) return;
	const member = objectiveDetail.view.members.find((entry) => entry.id === event.sessionId);
	if (!member) return;
	member.state = String(event.state ?? member.state);
	const row = document.querySelector(`#objective-members [data-session="${event.sessionId}"]`);
	const stateBadge = row?.querySelector(".state-badge");
	if (stateBadge) {
		stateBadge.textContent = member.state;
		stateBadge.className = `badge ${member.state} state-badge`;
	}
	scheduleObjectiveRefresh();
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
	showPushButton(result);
	if (quiet && result.subscribed) return result;
	const message = explainPush(result, env, { localhostUrl: localhostUrl() });
	status(message.text, !result.subscribed, message.link);
	return result;
}

/**
 * UX-14: the button shows only when there is something to do. Subscribed: hidden. Blocked: it
 * says so, and a click explains the fix. Otherwise it asks. A revoked permission or a broken
 * subscription brings it back on the next load, so it needs no off switch of its own.
 */
function showPushButton(result) {
	const button = $("enable-push");
	const permission = typeof Notification === "undefined" ? "denied" : Notification.permission;
	// Before the quiet re-subscribe answers, a granted permission is assumed to work, so a
	// returning window does not flash the button.
	button.hidden = result === undefined ? permission === "granted" && "serviceWorker" in navigator : Boolean(result.subscribed);
	button.textContent = permission === "denied" ? "Notifications blocked" : "Notifications";
}

function registerWorker() {
	if (!("serviceWorker" in navigator)) return;
	navigator.serviceWorker.register("/sw.js", { type: "module" }).catch((error) => {
		state.workerError = `the service worker failed to register: ${error?.message ?? error}`;
	});
	navigator.serviceWorker.addEventListener("message", (event) => {
		if (event.data?.type !== "open") return;
		openTarget(event.data.target);
	});
}

/**
 * Put the app on a notification click's target (PSH-03). The target is a route such as
 * `/#/threads/<id>`, or the path a browser opened; only the fragment names a view.
 */
function openTarget(target, { replace = false } = {}) {
	const value = String(target ?? "");
	const at = value.indexOf("#");
	const hash = at === -1 ? value : value.slice(at);
	if (!hash.startsWith("#/") || hash === location.hash) return false;
	// `replace` is for a boot: the caller routes right after, and no hashchange should fire.
	if (replace) history.replaceState(null, "", hash);
	else location.hash = hash;
	return true;
}

/**
 * PSH-05: a click may reach this window as nothing but a focus — the worker navigated it, or only
 * opened the app at `/` — so the target it left in the cache is adopted here.
 */
async function followClick({ replace = false } = {}) {
	return openTarget(await takeClickTarget(window.caches), { replace });
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
			return visible("#memory-results [data-selectable], #memory-files [data-selectable], #memory-log [data-selectable], #memory-file-log [data-selectable]");
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
	// A memory detail view has no search box; go back to the browse view that owns one.
	if (state.section === "memory") {
		location.hash = "#/memory";
		setTimeout(() => {
			$("memory-query").focus();
			$("memory-query").select();
		}, 0);
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
		if (!state.threadCanArchive) return;
		// UX-08: archiving the open thread leaves it for the list, instead of redrawing it archived.
		void archiveThread(state.thread.id, !state.threadArchived, { leave: !state.threadArchived });
		return;
	}
	if (state.section !== "inbox") return;
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
	if (state.section === "memory") {
		if (!$("memory-edit-view").hidden) {
			location.hash = $("memory-edit-back").getAttribute("href") || "#/memory";
			return;
		}
		if (!$("memory-file-view").hidden || !$("memory-commit-view").hidden) {
			location.hash = memoryBack || "#/memory";
			return;
		}
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

// ---- Command palette (UX-15) ------------------------------------------------------------------

/** How long a keystroke in the search stage waits for the next one, in milliseconds. */
const PALETTE_DEBOUNCE = 120;
/** The shortest query the search stage sends: one letter is noise to full-text search (SRC-01). */
const PALETTE_MIN_QUERY = 2;

const palette = {
	open: false,
	stage: "commands",
	/** The rows in view: `{kind, command, hit, row}`, `command` for a command, `hit` for a result. */
	rows: [],
	index: 0,
	/** What had focus when the palette opened; closing gives it back, draft and all. */
	restore: undefined,
	/** The newest search: a slow answer for an older query is dropped instead of drawn. */
	search: 0,
	timer: undefined,
};

/** What the page can do right now, as plain data for `paletteCommands`. */
function paletteContext() {
	const thread = state.section === "threads" && !$("thread").hidden ? state.thread : undefined;
	const session = state.section === "sessions" && !$("session").hidden ? state.session : undefined;
	return { thread, canArchive: Boolean(thread && state.threadCanArchive), session, selection: Boolean(selected()), push: state.push };
}

function openPalette() {
	if (palette.open) return;
	palette.open = true;
	palette.restore = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
	$("palette").hidden = false;
	paletteStage("commands");
}

function closePalette() {
	if (!palette.open) return;
	palette.open = false;
	clearTimeout(palette.timer);
	palette.search += 1;
	palette.rows = [];
	palette.index = 0;
	$("palette-list").replaceChildren();
	$("palette-note").textContent = "";
	$("palette").hidden = true;
	const restore = palette.restore;
	palette.restore = undefined;
	// UX-15: the palette may have opened over a half-written reply, which keeps its place.
	if (restore?.isConnected) restore.focus();
}

/** Show one of the palette's two inputs, empty, and draw its list. */
function paletteStage(stage) {
	palette.stage = stage;
	palette.rows = [];
	palette.index = 0;
	clearTimeout(palette.timer);
	palette.search += 1;
	$("palette-input").hidden = stage !== "commands";
	$("palette-search-input").hidden = stage !== "search";
	$("palette-input").value = "";
	$("palette-search-input").value = "";
	$("palette-list").replaceChildren();
	$("palette-note").textContent = "";
	if (stage === "search") {
		$("palette-note").textContent = "Type two or more characters.";
		$("palette-search-input").focus();
		return;
	}
	renderPaletteCommands();
	$("palette-input").focus();
}

/** A command's own key, set to the right of its row the way the help overlay writes one. */
function paletteKeyHint(hint) {
	const aside = document.createElement("div");
	aside.className = "item-aside";
	const kbd = document.createElement("kbd");
	kbd.textContent = hint;
	aside.append(kbd);
	return aside;
}

/** One palette row, built like every other list row so it reads the same (REF-07, UX-07). */
function paletteRow({ command, hit }) {
	const label = command ? command.label : hit.label || "(untitled)";
	const entry = { kind: command ? "command" : "hit", command, hit, row: undefined };
	const row = item(label, command ? [] : [hit.meta].filter(Boolean), () => runPaletteRow(entry), {
		testid: command ? "palette-command" : "palette-hit",
		id: command ? command.id : hit.id,
		aside: command?.hint ? paletteKeyHint(command.hint) : undefined,
	});
	entry.row = row;
	// The palette keeps its own selection; j and k still move the page's list behind it.
	delete row.dataset.selectable;
	row.setAttribute("role", "option");
	row.setAttribute("aria-selected", "false");
	row.id = `palette-row-${palette.rows.length}`;
	row.dataset.kind = entry.kind;
	if (command) row.dataset.command = command.id;
	if (hit) row.dataset.hitKind = hit.kind;
	palette.rows.push(entry);
	return row;
}

function renderPaletteCommands() {
	const list = $("palette-list");
	list.replaceChildren();
	palette.rows = [];
	palette.index = 0;
	const commands = matchCommands(paletteCommands(paletteContext()), $("palette-input").value);
	for (const command of commands) list.append(paletteRow({ command }));
	$("palette-note").textContent = commands.length === 0 ? "No command matches that." : "";
	paletteSelect(0);
}

/** The search stage: one group per store that matched, its best hits first (UX-15). */
function renderPaletteHits(groups, query) {
	const list = $("palette-list");
	list.replaceChildren();
	palette.rows = [];
	palette.index = 0;
	groups.forEach((group, at) => {
		const box = document.createElement("div");
		box.setAttribute("role", "group");
		const title = document.createElement("p");
		title.className = "palette-group-title";
		title.id = `palette-group-${at}`;
		title.textContent = group.title;
		box.setAttribute("aria-labelledby", title.id);
		box.append(title);
		for (const hit of group.hits) box.append(paletteRow({ hit }));
		list.append(box);
	});
	$("palette-note").textContent = groups.length === 0 ? `Nothing matches “${query}”.` : "";
	paletteSelect(0);
}

/** Mark the row the input is on, and put it in reach. */
function paletteSelect(index) {
	palette.index = index;
	const current = palette.rows[index]?.row;
	for (const entry of palette.rows) {
		const on = entry.row === current;
		entry.row.classList.toggle("focus", on);
		entry.row.setAttribute("aria-selected", on ? "true" : "false");
	}
	const input = palette.stage === "search" ? $("palette-search-input") : $("palette-input");
	if (!current) return input.removeAttribute("aria-activedescendant");
	input.setAttribute("aria-activedescendant", current.id);
	current.scrollIntoView({ block: "nearest" });
}

function paletteMove(delta) {
	if (palette.rows.length === 0) return;
	paletteSelect(moveSelection(palette.index, palette.rows.length, delta > 0 ? "next" : "previous"));
}

/** Run a row: a command closes the palette and then acts; a hit navigates to its own view. */
function runPaletteRow(entry) {
	if (!entry) return;
	if (entry.command && entry.command.id === "palette:search") return paletteStage("search");
	closePalette();
	if (entry.command) return runPaletteCommand(entry.command.id);
	location.hash = hitHash(entry.hit);
}

function runPaletteCommand(id) {
	if (id.startsWith("go:")) {
		location.hash = `#/${id.slice("go:".length)}`;
		return;
	}
	if (id.startsWith("session:")) return runSessionCommand(id.slice("session:".length));
	switch (id) {
		case "open":
			return openSelection();
		case "archive-thread":
			return archiveKey();
		case "subject-regenerate":
			return void regenerateThreadSubject();
		case "back":
			return goBack();
		case "help":
			return toggleHelp(true);
		case "push":
			return void enablePush();
	}
}

function runSessionCommand(action) {
	if (action === "archive") return askArchiveSession();
	if (action === "reload") return void openSession(state.session?.id).catch(fail);
	return void sessionAction(action);
}

/** A keystroke in either input: commands filter at once, a search waits for a pause. */
function onPaletteInput() {
	if (palette.stage === "commands") return renderPaletteCommands();
	const query = $("palette-search-input").value.trim();
	clearTimeout(palette.timer);
	const search = (palette.search += 1);
	if (query.length < PALETTE_MIN_QUERY) {
		$("palette-list").replaceChildren();
		palette.rows = [];
		palette.index = 0;
		$("palette-note").textContent = query.length === 0 ? "Type two or more characters." : "Type one more character.";
		return;
	}
	$("palette-note").textContent = "Searching…";
	palette.timer = setTimeout(() => void paletteSearch(query, search), PALETTE_DEBOUNCE);
}

/** The search stage asks the three stores at once and draws whatever stays newest. */
async function paletteSearch(query, search) {
	try {
		const [threads, sessions, memory] = await Promise.all([
			api("GET", pagePath(`/threads?query=${encodeURIComponent(query)}`, undefined, HITS_PER_STORE)),
			api("GET", pagePath(`/sessions?query=${encodeURIComponent(query)}`, undefined, HITS_PER_STORE)),
			api("GET", `/memory/search?query=${encodeURIComponent(query)}&limit=${HITS_PER_STORE}`),
		]);
		if (!palette.open || palette.stage !== "search" || search !== palette.search) return;
		renderPaletteHits(paletteHits({ threads, sessions, memory }, query), query);
	} catch (error) {
		if (search !== palette.search) return;
		$("palette-note").textContent = error?.body?.error?.message ?? error?.message ?? String(error);
	}
}

/** The palette's own keys: the input keeps its letters, so moving and choosing are arrows and Enter. */
function onPaletteKeydown(event) {
	if (event.key === "Escape") {
		event.preventDefault();
		if (palette.stage === "search") return paletteStage("commands");
		return closePalette();
	}
	if (event.key === "ArrowDown" || event.key === "ArrowUp") {
		event.preventDefault();
		return paletteMove(event.key === "ArrowUp" ? -1 : 1);
	}
	if (event.key === "Enter") {
		event.preventDefault();
		return runPaletteRow(palette.rows[palette.index]);
	}
}

function runKey(action, { target, form }) {
	if (action === "submit") return form?.requestSubmit();
	if (action === "leave-input") return target?.blur?.();
	if (action === "help") return toggleHelp();
	if (action === "back") return goBack();
	// UX-15: the palette opens over whatever is in front, help included, and the same chord closes it.
	if (action === "palette") {
		if (palette.open) return closePalette();
		if (!$("help").hidden) toggleHelp(false);
		return openPalette();
	}
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
	threadRenderVersion++;
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

/**
 * UX-19: a page you navigate to starts at its top, wherever the page you left was scrolled. The
 * pages that have a place of their own scroll themselves once they render — a thread's latest or
 * linked message (UX-05), a session's newest entries (UX-10) — which is after this has run.
 */
function resetScroll() {
	const root = document.scrollingElement ?? document.documentElement;
	if (root.scrollTop !== 0) root.scrollTop = 0;
}

async function route() {
	const { section, id, rest, query } = routeFromHash(location.hash);
	showSection(section);
	resetScroll();
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
				else {
					$("sessions-state").value = SESSION_STATES.includes(query.get("state")) ? query.get("state") : "";
					await loadSessionList($("sessions-query").value.trim());
				}
				break;
			case "memory":
				if (id === "files" && rest.length > 0) await openMemoryFile(rest.join("/"), query.get("source") === "1");
				else if (id === "commits" && rest.length > 0) await openMemoryCommit(rest[0]);
				else if (id === "edit" && rest.length > 0) await openMemoryEditor(rest.join("/"));
				else if (id === "new") await openMemoryEditor("");
				else await loadMemory();
				break;
			case "schedules":
				$("schedules-kind").value = ["session", "thread", "wake"].includes(query.get("kind")) ? query.get("kind") : "";
				await loadSchedules(query.get("focus") ?? undefined);
				break;
			case "objectives":
				$("objectives-browse").hidden = false;
				$("objectives-list").hidden = false;
				$("objective").hidden = true;
				// An unknown phase resets the filter rather than answering an empty list.
				$("objectives-phase").value = OBJECTIVE_PHASES.includes(query.get("phase")) ? query.get("phase") : "";
				if (id) await openObjective(id);
				else await loadObjectives();
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
	showPushButton(undefined);
	// A returning user already allowed notifications; refresh or create the subscription
	// without asking again.
	if (typeof Notification !== "undefined" && Notification.permission === "granted" && "serviceWorker" in navigator) {
		void enablePush({ quiet: true });
	}
	void startEvents();
	// A click that opened this window at `/` left its thread in the cache (PSH-05). Adopting it
	// before `route()` means the app draws the thread once, at boot, instead of twice.
	await followClick({ replace: true }).catch(() => {});
	await route();
}

// ---- Wiring ---------------------------------------------------------------------------------

for (const hint of document.querySelectorAll("[data-chord]")) hint.textContent = sequenceLabel(["Mod+Enter"], APPLE);
// UX-15: the palette's button names its own key, and a phone shows a magnifier instead.
const paletteKey = document.querySelector("[data-palette-key]");
if (paletteKey) paletteKey.textContent = APPLE ? "⌘K" : "Ctrl K";
$("open-palette").title = `Command palette (${sequenceLabel(["Mod+k"], APPLE)})`;
$("open-palette").addEventListener("click", () => openPalette());
$("palette").addEventListener("click", (event) => {
	if (event.target === $("palette")) closePalette();
});
for (const input of [$("palette-input"), $("palette-search-input")]) {
	input.addEventListener("input", onPaletteInput);
	input.addEventListener("keydown", onPaletteKeydown);
}

$("authorize-form").addEventListener("submit", (event) => {
	event.preventDefault();
	void authorize($("authorize-input").value);
});
$("compose-form").addEventListener("submit", (event) => void submitCompose(event));
wireAttach("compose-form", "compose-attach", "compose-files", "compose-body");
wireAttach("reply-form", "reply-attach", "reply-files", "reply-body");
$("threads-search").addEventListener("submit", (event) => void searchThreads(event).catch(fail));
$("sessions-search").addEventListener("submit", (event) => {
	event.preventDefault();
	void loadSessionList($("sessions-query").value.trim()).catch(fail);
});
$("sessions-state").addEventListener("change", () => {
	const filter = $("sessions-state").value;
	location.hash = filter ? `#/sessions?state=${filter}` : "#/sessions";
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
$("thread-subject-regenerate").addEventListener("click", () => void regenerateThreadSubject());
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
$("inbox-archived").addEventListener("change", () => void loadInbox());
$("memory-delete").addEventListener("click", () => {
	$("memory-delete-path").textContent = $("memory-delete").dataset.path || "";
	$("memory-delete-confirmation").hidden = false;
	$("memory-delete-cancel").focus();
});
$("memory-delete-cancel").addEventListener("click", () => {
	$("memory-delete-confirmation").hidden = true;
	$("memory-delete").focus();
});
$("memory-delete-confirm").addEventListener("click", () => void deleteMemory());
$("memory-search").addEventListener("submit", (event) => void searchMemory(event));
$("memory-edit-form").addEventListener("submit", (event) => void saveMemory(event));
$("memory-source").addEventListener("click", () => {
	const href = $("memory-source").dataset.href;
	if (href) location.hash = href;
});
// Enter in the path field moves on to writing, instead of saving before there is anything to save.
$("memory-path-input").addEventListener("keydown", (event) => {
	if (event.key !== "Enter") return;
	event.preventDefault();
	memoryEditor?.focus();
});
$("schedules-kind").addEventListener("change", () => {
	const kind = $("schedules-kind").value;
	location.hash = kind ? `#/schedules?kind=${kind}` : "#/schedules";
});
$("schedule-form").addEventListener("submit", (event) => void createSchedule(event));
$("objectives-phase").addEventListener("change", () => {
	const phase = $("objectives-phase").value;
	location.hash = phase ? `#/objectives?phase=${encodeURIComponent(phase)}` : "#/objectives";
});
$("objective-launch").addEventListener("click", () => askObjectiveAction("launch"));
$("objective-stop").addEventListener("click", () => askObjectiveAction("stop"));
$("objective-regenerate").addEventListener("click", () => askObjectiveAction("regenerate"));
$("objective-reload").addEventListener("click", () => {
	if (objectiveDetail) void openObjective(objectiveDetail.view.id).catch(fail);
});
$("objective-confirm-yes").addEventListener("click", () => void confirmObjectiveAction());
$("objective-confirm-no").addEventListener("click", cancelObjectiveAction);
// OBJ-09: each charter section's Edit opens its editor in place, and a save sends the revision read.
$("objective-charter").addEventListener("click", (event) => {
	const button = event.target?.closest?.("[data-testid=charter-edit]");
	if (!button) return;
	event.preventDefault();
	startCharterEdit(button.dataset.section);
});
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
	// A click that is not on a message's actions closes whichever one is open.
	if (!event.target?.closest?.(".message-menu")) closeMessageMenus();
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
// A click that only focuses the window arrives no other way (PSH-05).
window.addEventListener("focus", () => void followClick().catch(() => {}));
document.addEventListener("visibilitychange", () => {
	if (document.visibilityState === "visible") void followClick().catch(() => {});
});

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
			objectiveId: objectiveDetail?.view.id,
			draft: state.draft ? { threadId: state.draft.threadId, after: state.draft.after } : undefined,
			confirm: state.confirm?.action,
			selected: current ? { testid: current.dataset.testid, id: current.dataset.id, thread: current.dataset.thread } : undefined,
			help: !$("help").hidden,
			palette: palette.open ? { stage: palette.stage, rows: palette.rows.length, index: palette.index } : undefined,
			push: state.push,
			apple: APPLE,
			memoryPath: memoryEditingPath || undefined,
		};
	},
	/** The CodeMirror instance while a memory file is open in the editor, for tests and debugging. */
	get memoryEditor() {
		return memoryEditor;
	},
	enablePush,
	showPushButton,
};

void boot();
