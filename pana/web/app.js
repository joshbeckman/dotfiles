// The pana PWA (WEB-01..08). Plain ES modules, no framework: a hash router, one fetch wrapper,
// and a renderer per section. The server owns auth (API-04); this file only carries the token.

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
import { subscribeToPush } from "./push.js";
import { commitView, entryView, inboxRow, memoryHitView, messageView, scheduleBody, scheduleWhen, threadRow } from "./views.js";
import { escapeHtml, hydrateFiles, renderDiagrams, renderMessage, rewriteLinks } from "./render.js";

const $ = (id) => document.getElementById(id);

// The launch URL carries the token in the fragment. Store it, then clear the hash so a reload
// starts at a normal route. An installed app has its own storage, so a 403 opens the panel.
const launchToken = location.hash && !location.hash.startsWith("#/") ? location.hash.slice(1) : "";
if (launchToken) {
	localStorage.setItem(TOKEN_KEY, launchToken);
	history.replaceState(null, "", "/#/inbox");
}
let token = launchToken || localStorage.getItem(TOKEN_KEY) || "";

const state = {
	domain: "",
	domainResolved: undefined,
	section: "inbox",
	thread: null,
	session: null,
	draft: null,
	confirm: null,
	eventAbort: undefined,
	domainReady: undefined,
};

let statusTimer;
function status(text, error = false) {
	clearTimeout(statusTimer);
	$("status").textContent = text;
	$("status").classList.toggle("error", error);
	if (text && !error) {
		statusTimer = setTimeout(() => {
			$("status").textContent = "";
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
	transcript.append(entryElement(entry));
	transcript.lastElementChild?.scrollIntoView({ block: "nearest" });
}

// ---- Helpers --------------------------------------------------------------------------------

function asList(body, keys) {
	if (Array.isArray(body)) return body;
	if (!body || typeof body !== "object") return [];
	for (const key of keys) if (Array.isArray(body[key])) return body[key];
	return [];
}

function item(title, meta, onClick, extra = {}) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = `item${extra.unread ? " unread" : ""}${extra.archived ? " archived" : ""}`;
	if (extra.testid) button.dataset.testid = extra.testid;
	if (extra.threadId) button.dataset.thread = extra.threadId;
	if (extra.sessionId) button.dataset.session = extra.sessionId;
	if (extra.id) button.dataset.id = extra.id;
	const titleEl = document.createElement("span");
	titleEl.className = "title";
	if (typeof title === "string") titleEl.textContent = title;
	else titleEl.append(title);
	button.append(titleEl);
	if (meta) {
		const metaEl = document.createElement("span");
		metaEl.className = "meta";
		for (const part of meta) {
			if (part === undefined || part === null || part === "") continue;
			if (part instanceof Node) metaEl.append(part);
			else {
				const span = document.createElement("span");
				span.textContent = String(part);
				metaEl.append(span);
			}
		}
		button.append(metaEl);
	}
	button.addEventListener("click", onClick);
	if (!extra.actions) return button;
	// REF-07: row actions sit beside the row, because a button may not contain a button.
	const row = document.createElement("div");
	row.className = "row";
	row.dataset.thread = extra.threadId ?? "";
	row.append(button, ...extra.actions);
	return row;
}

/** A link to an ID's own view (REF-08), or plain text when the ID has no view here. */
function refLink(value, kind, label) {
	const text = String(value ?? "");
	if (!text) return document.createTextNode("");
	const href = text.startsWith("pana://") ? appHref(text, state.domain) : idHref(text, kind);
	if (!href) return document.createTextNode(label ?? text);
	const anchor = document.createElement("a");
	anchor.href = href;
	anchor.textContent = label ?? text;
	anchor.dataset.testid = "ref-link";
	if (/^https?:/i.test(href)) {
		anchor.target = "_blank";
		anchor.rel = "noopener noreferrer";
	}
	return anchor;
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

function empty(container, text) {
	container.replaceChildren();
	const p = document.createElement("p");
	p.className = "hint";
	p.textContent = text;
	container.append(p);
}

function badge(text) {
	const span = document.createElement("span");
	span.className = `badge ${text}`;
	span.textContent = text;
	return span;
}

// ---- Inbox ----------------------------------------------------------------------------------

/** REF-06: the nav badge is the caller's unread delivery count across every thread. */
async function refreshUnread(archived = false) {
	const body = await api("GET", `/inbox${archived ? "?archived=1" : ""}`);
	const items = asList(body, ["deliveries"]);
	const unread = items.filter((delivery) => delivery.readAt === null || delivery.readAt === undefined).length;
	const badge = $("nav-inbox-count");
	// The archived view is not the inbox, so it never rewrites the badge.
	if (badge && !archived) {
		badge.textContent = String(unread);
		badge.hidden = unread === 0;
	}
	return { items, unread };
}

async function loadInbox() {
	// REF-07: the same view shows the archived threads, so Unarchive has a home in the inbox.
	const showArchived = Boolean($("inbox-archived")?.checked);
	const { items } = await refreshUnread(showArchived);
	const list = $("inbox-list");
	list.replaceChildren();
	if (items.length === 0) {
		return empty(list, showArchived ? "No archived threads." : "No messages yet. Compose one to start a thread.");
	}
	for (const delivery of items) {
		const row = inboxRow(delivery);
		learnDomain(row.sender);
		const archive = showArchived
			? rowAction("inbox-unarchive", "Unarchive", () => void archiveThread(row.threadId, false))
			: rowAction("inbox-archive", "Archive", () => void archiveThread(row.threadId, true));
		list.append(
			item(
				row.subject,
				[
					refLink(row.sender, "user"),
					when(row.at),
					row.unreadCount > 0 ? `${row.unreadCount} unread` : undefined,
					row.read ? undefined : "unread",
				],
				() => {
					location.hash = `#/threads/${row.threadId}?message=${row.messageId}`;
				},
				{ unread: !row.read, testid: "inbox-item", threadId: row.threadId, id: row.messageId, actions: [archive] },
			),
		);
	}
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
		if (state.section === "threads" && state.thread?.id === threadId) await openThread(threadId);
		await refreshUnread().catch(() => {});
		if (state.section === "inbox") await loadInbox();
		else if (state.section === "threads") await searchThreads();
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

async function searchThreads(event) {
	event?.preventDefault();
	const query = $("threads-query").value.trim();
	const params = new URLSearchParams();
	if (query) params.set("query", query);
	if ($("threads-archived")?.checked) params.set("archived", "1");
	if ($("threads-unread")?.checked) params.set("unread", "1");
	const suffix = params.toString();
	const body = await api("GET", `/threads${suffix ? `?${suffix}` : ""}`);
	const list = $("threads-list");
	list.replaceChildren();
	const threads = asList(body, ["threads"]);
	if (threads.length === 0) return empty(list, query ? `No threads match “${query}”.` : "No threads yet.");
	const seen = new Set();
	for (const hit of threads) {
		const thread = threadRow(hit);
		// A search returns one hit per matching message; list each thread once.
		if (seen.has(thread.id)) continue;
		seen.add(thread.id);
		learnDomain(thread.url);
		const archive = rowAction(thread.archived ? "thread-unarchive" : "thread-archive", thread.archived ? "Unarchive" : "Archive", () =>
			void archiveThread(thread.id, !thread.archived),
		);
		list.append(
			item(
				thread.subject,
				[
					thread.snippet,
					when(thread.at),
					thread.unreadCount > 0 ? `${thread.unreadCount} unread` : undefined,
					thread.archived ? "archived" : undefined,
				],
				() => {
					location.hash = `#/threads/${thread.id}`;
				},
				{ testid: "thread-item", threadId: thread.id, unread: thread.unreadCount > 0, archived: thread.archived, actions: [archive] },
			),
		);
	}
}

async function messageElement(message, { threadId, focus }) {
	const view = messageView(message);
	learnDomain(view.sender);
	const article = document.createElement("article");
	article.className = "message";
	article.dataset.testid = "message";
	article.dataset.id = view.id ?? "";
	article.dataset.sender = view.sender;

	const header = document.createElement("header");
	const sender = view.sender ? refLink(view.sender, "user") : document.createTextNode("unknown sender");
	if (sender instanceof HTMLElement) sender.dataset.testid = "message-sender";
	const time = document.createElement("span");
	time.textContent = when(view.at);
	const messageLink = refLink(view.url ?? `${view.threadId}`, "thread", `#${String(view.id ?? "").slice(-6)}`);
	if (messageLink instanceof HTMLElement) messageLink.dataset.testid = "message-link";
	header.append(sender, time, messageLink);
	if (view.revised) {
		const edited = document.createElement("span");
		edited.className = "badge";
		edited.textContent = "edited";
		header.append(edited);
	}
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

	const actions = document.createElement("div");
	actions.className = "row-actions";
	for (const [action, label] of [
		["edit", "Edit"],
		["redact", "Redact"],
	]) {
		const button = document.createElement("button");
		button.type = "button";
		button.dataset.action = action;
		button.dataset.id = view.id ?? "";
		button.dataset.testid = `message-${action}`;
		button.textContent = label;
		button.addEventListener("click", () => startConfirm(action, view));
		actions.append(button);
	}
	article.append(actions);

	if (focus) article.classList.add("focus");
	return article;
}

async function openThread(id, focusMessage) {
	const body = await api("GET", `/threads/${id}`);
	const thread = body.thread;
	const messages = body.messages ?? [];
	state.thread = thread;
	learnDomain(thread?.url);

	const draft = newDraft({ id, messages });
	const stored = sessionStorage.getItem(`pana-draft:${id}`);
	if (stored) draft.body = stored;
	state.draft = draft;
	$("reply-body").value = draft.body;
	$("draft-head").textContent = draft.after ?? "(no messages yet)";
	$("stale").hidden = true;
	$("stale-new").replaceChildren();
	$("confirm").hidden = true;
	state.confirm = null;

	$("thread-subject").textContent = thread?.subject ?? "(no subject)";
	const threadUrl = $("thread-url");
	threadUrl.replaceChildren(refLink(thread?.url ?? id, "thread"));
	// REF-08: participants are links to their own views.
	const participants = $("thread-participants");
	participants.replaceChildren();
	for (const [index, participant] of (thread?.participants ?? []).entries()) {
		if (index > 0) participants.append(document.createTextNode(", "));
		const url = typeof participant === "object" ? participant.url : participant;
		participants.append(refLink(url, "user"));
	}
	// REF-07: one toggle, labelled for the thread's state for this reader.
	const archiveButton = $("thread-archive");
	archiveButton.dataset.archived = String(Boolean(body.archived));
	archiveButton.textContent = body.archived ? "Unarchive" : "Archive";
	archiveButton.dataset.testid = body.archived ? "thread-unarchive" : "thread-archive";
	const container = $("thread-messages");
	container.replaceChildren();
	for (const message of messages) {
		container.append(await messageElement(message, { threadId: id, focus: message.id === focusMessage }));
	}
	if (messages.length === 0) empty(container, "No messages yet.");

	$("threads-list").hidden = true;
	$("thread").hidden = false;
	$("thread-subject").focus?.();
	if (focusMessage) {
		container.querySelector(".focus")?.scrollIntoView?.({ block: "center" });
		await api("POST", `/messages/${focusMessage}/read`).catch(() => {});
	}
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
	for (const message of newer) {
		container.append(await messageElement(message, { threadId: draft.threadId }));
	}
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

function startConfirm(action, message) {
	state.confirm = { action, messageId: message.id, original: message.body };
	$("confirm-text").textContent = action === "redact" ? CONFIRM_REDACT : CONFIRM_EDIT;
	const editor = $("edit-area");
	if (editor) editor.remove();
	if (action === "edit") {
		const area = document.createElement("div");
		area.id = "edit-area";
		area.className = "confirm";
		const label = document.createElement("label");
		label.htmlFor = "edit-body";
		label.textContent = "New body";
		const textarea = document.createElement("textarea");
		textarea.id = "edit-body";
		textarea.dataset.testid = "edit-body";
		textarea.rows = 6;
		textarea.value = message.body;
		area.append(label, textarea);
		$("confirm").before(area);
	}
	$("confirm").hidden = false;
	$("confirm-yes").focus();
}

async function confirmAction() {
	const pending = state.confirm;
	if (!pending) return;
	const editBody = pending.action === "edit" ? $("edit-body")?.value : undefined;
	$("confirm").hidden = true;
	$("edit-area")?.remove();
	state.confirm = null;
	try {
		if (pending.action === "redact") {
			await api("POST", `/messages/${pending.messageId}/redact`, {});
		} else {
			await api("POST", `/messages/${pending.messageId}/revisions`, { body: editBody });
		}
		status(pending.action === "redact" ? "Redacted." : "Edited.");
		if (state.thread) await openThread(state.thread.id);
	} catch (error) {
		fail(error);
	}
}

function cancelAction() {
	$("confirm").hidden = true;
	$("edit-area")?.remove();
	state.confirm = null;
}

// ---- Sessions -------------------------------------------------------------------------------

async function loadSessionList(query = "") {
	const body = await api("GET", `/sessions?query=${encodeURIComponent(query)}`);
	const list = document.querySelector("#sessions-list");
	list.replaceChildren();
	const sessions = asList(body, ["sessions"]);
	if (sessions.length === 0) return empty(list, query ? `No sessions match “${query}”.` : "No sessions yet.");
	for (const session of sessions) {
		learnDomain(session.url);
		const row = item(
			refLink(session.url ?? session.id, "session", session.id),
			[
				session.state,
				session.model,
				session.parent ? refLink(session.parentUrl ?? session.parent, "session", `parent ${session.parent}`) : undefined,
				when(session.updatedAt),
				cost(session.costUsd),
				session.snippet,
			],
			() => {
				location.hash = `#/sessions/${session.id}`;
			},
			{ testid: "session-item", sessionId: session.id },
		);
		row.prepend(badge(session.state ?? "unknown"));
		list.append(row);
	}
}

async function openSession(id) {
	const [body, transcript] = await Promise.all([api("GET", `/sessions/${id}`), api("GET", `/sessions/${id}/transcript`)]);
	state.session = body.session;
	// REF-08: the session's own ID is a link to the session view, and the parent is a link to its.
	const title = $("session-title");
	title.replaceChildren(refLink(state.session.url ?? state.session.id, "session", state.session.id));
	const meta = $("session-meta");
	meta.replaceChildren(badge(state.session.state ?? "unknown"));
	const details = document.createElement("span");
	for (const part of [
		state.session.model,
		state.session.cwd,
		state.session.parent ? refLink(state.session.parentUrl ?? state.session.parent, "session", `parent ${state.session.parent}`) : undefined,
		cost(state.session.costUsd),
	]) {
		if (part === undefined || part === null || part === "") continue;
		if (details.childNodes.length > 0) details.append(" · ");
		if (part instanceof Node) details.append(part);
		else details.append(document.createTextNode(String(part)));
	}
	meta.append(" ", details);
	const archive = $("session-archive");
	if (archive) {
		archive.hidden = state.session.state === "archived";
		archive.dataset.id = state.session.id;
	}
	$("sessions-list").hidden = true;
	$("session").hidden = false;
	renderTranscript(asList(transcript, ["entries"]));
}

function cost(usd) {
	return typeof usd === "number" ? `$${usd.toFixed(4)}` : undefined;
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
	const body = document.createElement("div");
	body.className = "entry-body";
	for (const block of view.blocks ?? []) body.append(blockElement(block));
	div.append(meta, body);
	return div;
}

function blockElement(block) {
	if (block.type === "thinking") {
		// REF-09: thinking is collapsed by default.
		return details("details-thinking", "Thinking", block.text, { testid: "entry-thinking" });
	}
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
		const span = document.createElement("span");
		span.className = "block-image";
		span.textContent = `[image ${block.mediaType}]`;
		return span;
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
	$("memory-worktree").textContent = worktree?.path ? `Worktree: ${worktree.path}` : "No memory worktree yet.";
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
		list.append(item(commit.message, [commit.author, commit.short, when(Date.parse(commit.at))], () => {}, { testid: "memory-commit", id: commit.hash }));
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
	$("memory-file").textContent = content;
	$("memory-file").hidden = false;
	$("memory-edit").value = content;
	$("memory-edit").hidden = false;
	$("memory-save").hidden = false;
}

async function saveMemory() {
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
		if (created?.path) $("memory-worktree").textContent = `Worktree: ${created.path}`;
		status("Memory worktree ready.");
		await loadMemory();
	} catch (error) {
		fail(error);
	}
}

// ---- Schedules ------------------------------------------------------------------------------

let editingSchedule;

async function loadSchedules(focus) {
	const body = await api("GET", "/schedules");
	const list = $("schedules-list");
	list.replaceChildren();
	const schedules = asList(body, ["schedules"]);
	if (schedules.length === 0) return empty(list, "No schedules yet.");
	for (const schedule of schedules) {
		const row = document.createElement("div");
		row.className = "item";
		row.dataset.testid = "schedule-item";
		row.dataset.id = schedule.id;
		const title = document.createElement("span");
		title.className = "title";
		title.textContent = `${schedule.kind} · ${schedule.cron ?? when(schedule.at)} · ${schedule.state}`;
		const meta = document.createElement("span");
		meta.className = "meta";
		const payload = schedule.payload ?? {};
		// REF-08: a schedule ID is a link to the schedule view, which focuses its row.
		meta.append(refLink(schedule.url ?? schedule.id, "schedule", schedule.id));
		for (const part of [payload.prompt ?? payload.body ?? payload.subject, `next ${when(schedule.nextAt)}`]) {
			if (part === undefined || part === null || part === "") continue;
			meta.append(" · ", document.createTextNode(String(part)));
		}
		const edit = document.createElement("button");
		edit.type = "button";
		edit.textContent = "Edit";
		edit.dataset.testid = "schedule-edit";
		edit.addEventListener("click", () => startScheduleEdit(schedule));
		const remove = document.createElement("button");
		remove.type = "button";
		remove.textContent = "Delete";
		remove.dataset.action = "delete-schedule";
		remove.dataset.id = schedule.id;
		remove.dataset.testid = "schedule-delete";
		remove.addEventListener("click", () => void deleteSchedule(schedule.id));
		row.append(title, meta, edit, remove);
		list.append(row);
	}
	if (focus) {
		const row = [...document.querySelectorAll("#schedules-list .item")].find((el) => el.dataset.id === focus);
		if (row) {
			row.classList.add("focus");
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
	status(`Editing ${schedule.id}.`);
	$("schedule-prompt").focus();
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
		editingSchedule = undefined;
		$("schedule-create").textContent = "Create";
		$("schedule-prompt").value = "";
		$("schedule-when").value = "";
		$("schedule-to").value = "";
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

// ---- Push -----------------------------------------------------------------------------------

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

async function enablePush() {
	try {
		const result = await subscribeToPush({
			permission: typeof Notification === "undefined" ? "denied" : Notification.permission,
			requestPermission: () => Notification.requestPermission(),
			register: () => navigator.serviceWorker.ready,
			getKey: async () => (await api("GET", "/push/key")).publicKey,
			post: (subscription) => api("POST", "/push/subscriptions", subscription),
		});
		status(result.subscribed ? "Notifications enabled." : `Notifications are off: ${result.reason}`);
	} catch (error) {
		fail(error);
	}
}

function registerWorker() {
	if (!("serviceWorker" in navigator)) return;
	navigator.serviceWorker.register("/sw.js", { type: "module" }).catch(() => {});
	navigator.serviceWorker.addEventListener("message", (event) => {
		if (event.data?.type !== "open") return;
		const target = String(event.data.target ?? "");
		const hash = target.includes("#") ? target.slice(target.indexOf("#")) : target;
		if (hash.startsWith("#/")) location.hash = hash;
	});
}

// ---- Router ---------------------------------------------------------------------------------

function showSection(section) {
	state.section = section;
	for (const link of document.querySelectorAll("#nav a")) {
		if (link.dataset.section === section) link.setAttribute("aria-current", "page");
		else link.removeAttribute("aria-current");
	}
	for (const view of document.querySelectorAll(".view")) {
		view.hidden = view.id !== `view-${section}`;
	}
}

async function route() {
	const { section, id, query } = routeFromHash(location.hash);
	showSection(section);
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
				$("threads-list").hidden = false;
				$("thread").hidden = true;
				if (query.get("query")) $("threads-query").value = query.get("query");
				if (id) await openThread(id, query.get("message"));
				else await searchThreads();
				break;
			case "sessions":
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
		void enablePush();
	}
	void startEvents();
	await route();
}

// ---- Wiring ---------------------------------------------------------------------------------

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
$("confirm-yes").addEventListener("click", () => void confirmAction());
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
$("schedule-form").addEventListener("submit", (event) => void createSchedule(event));
$("enable-push").addEventListener("click", () => void enablePush());
document.addEventListener("click", (event) => {
	const action = event.target?.closest?.("[data-action]")?.dataset.action;
	if (action === "stop" || action === "compact") void sessionAction(action);
	if (action === "archive-session") askArchiveSession();
	if (action === "reload") {
		if (state.session) void openSession(state.session.id);
		else void loadSessionList();
	}
	if (action === "create-worktree") void createWorktree();
	if (action === "save-memory") void saveMemory();
});
window.addEventListener("hashchange", () => void route());
window.addEventListener("online", () => void startEvents());

// The thread from a notification click arrives as `?thread=<id>` (PSH-03).
const bootParams = new URLSearchParams(location.search);
if (bootParams.get("thread")) history.replaceState(null, "", `/#/threads/${bootParams.get("thread")}`);

// Exposed for the browser tests and for a human debugging a window.
window.__pana = {
	get state() {
		return {
			domain: state.domain,
			section: state.section,
			threadId: state.thread?.id,
			sessionId: state.session?.id,
			draft: state.draft ? { threadId: state.draft.threadId, after: state.draft.after } : undefined,
			confirm: state.confirm?.action,
		};
	},
};

void boot();
