// The pana PWA (WEB-01..08). Plain ES modules, no framework: a hash router, one fetch wrapper,
// and a renderer per section. The server owns auth (API-04); this file only carries the token.

import {
	CONFIRM_EDIT,
	CONFIRM_REDACT,
	TOKEN_KEY,
	appHref,
	newDraft,
	routeFromHash,
	tokenFromInput,
} from "./links.js";
import { subscribeToPush } from "./push.js";
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

async function apiText(path) {
	const response = await raw(path);
	const text = await response.text();
	if (!response.ok) {
		const error = new Error(`GET ${path} failed (${response.status})`);
		error.status = response.status;
		throw error;
	}
	return text;
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
	if ((event.kind === "delivery" || event.kind === "notice") && state.section === "inbox") void loadInbox();
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
	button.className = `item${extra.unread ? " unread" : ""}`;
	if (extra.testid) button.dataset.testid = extra.testid;
	if (extra.threadId) button.dataset.thread = extra.threadId;
	if (extra.sessionId) button.dataset.session = extra.sessionId;
	if (extra.id) button.dataset.id = extra.id;
	const titleEl = document.createElement("span");
	titleEl.className = "title";
	titleEl.textContent = title;
	button.append(titleEl);
	if (meta) {
		const metaEl = document.createElement("span");
		metaEl.className = "meta";
		for (const part of meta) {
			if (part === undefined || part === null || part === "") continue;
			const span = document.createElement("span");
			span.textContent = String(part);
			metaEl.append(span);
		}
		button.append(metaEl);
	}
	button.addEventListener("click", onClick);
	return button;
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

async function loadInbox() {
	const body = await api("GET", "/inbox");
	const list = $("inbox-list");
	list.replaceChildren();
	const items = asList(body, ["items", "deliveries", "inbox", "messages"]);
	if (items.length === 0) return empty(list, "No messages yet. Compose one to start a thread.");
	for (const delivery of items) {
		const message = delivery.message ?? delivery;
		learnDomain(delivery.senderUrl ?? message.senderUrl ?? delivery.thread?.url);
		const threadId = delivery.threadId ?? delivery.thread_id ?? delivery.thread?.id;
		const messageId = delivery.messageId ?? delivery.message_id ?? message.id ?? delivery.id;
		const subject = delivery.subject ?? delivery.thread?.subject ?? message.subject ?? "(no subject)";
		const sender = delivery.senderUrl ?? message.senderUrl ?? delivery.sender ?? "unknown sender";
		const read = Boolean(delivery.read ?? delivery.readAt ?? delivery.read_at);
		list.append(
			item(
				subject,
				[sender, when(delivery.createdAt ?? delivery.created_at ?? message.createdAt), read ? undefined : "unread"],
				() => {
					if (threadId) location.hash = `#/threads/${threadId}${messageId ? `?message=${messageId}` : ""}`;
				},
				{ unread: !read, testid: "inbox-item", threadId, id: messageId },
			),
		);
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
	if (to.length === 0) return status("Name at least one recipient.", true);
	if (!body.trim()) return status("Write a message first.", true);
	const subject = $("compose-subject").value.trim();
	try {
		const created = await api("POST", "/sessions", {
			prompt: body,
			...(to.length > 0 ? { to } : {}),
			...(subject ? { subject } : {}),
		});
		const threadId = created?.thread?.id ?? created?.threadId;
		const sessionId = created?.session?.id ?? created?.sessionId;
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
	const body = await api("GET", `/threads?query=${encodeURIComponent(query)}`);
	const list = $("threads-list");
	list.replaceChildren();
	const threads = asList(body, ["threads", "items", "results"]);
	if (threads.length === 0) return empty(list, query ? `No threads match “${query}”.` : "No threads yet.");
	for (const thread of threads) {
		learnDomain(thread.url ?? thread.thread?.url);
		list.append(
			item(
				thread.subject ?? thread.id,
				[thread.senderUrl ?? thread.createdBy, when(thread.updatedAt ?? thread.createdAt), thread.state],
				() => {
					location.hash = `#/threads/${thread.id}`;
				},
				{ testid: "thread-item", threadId: thread.id },
			),
		);
	}
}

function messageView(message) {
	return {
		id: message?.id,
		sender: message?.senderUrl ?? message?.sender ?? message?.from ?? "",
		at: message?.createdAt ?? message?.created_at ?? message?.at,
		body: message?.body ?? "",
		revised: Boolean(message?.revised ?? message?.edited),
		redacted: Boolean(message?.redacted),
	};
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
	const sender = document.createElement("span");
	sender.textContent = view.sender || "unknown sender";
	const time = document.createElement("span");
	time.textContent = when(view.at);
	header.append(sender, time);
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
	const thread = body?.thread ?? body;
	state.thread = thread;
	const messages = Array.isArray(thread?.messages) ? thread.messages : [];
	learnDomain(thread?.url ?? messages[0]?.senderUrl);

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
	$("thread-participants").textContent = (thread?.participants ?? []).map((p) => p.url ?? p).join(", ");
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
		await api("POST", `/messages/${focusMessage}/read`).catch(() => {});
	}
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
	const thread = body?.thread ?? body;
	const messages = Array.isArray(thread?.messages) ? thread.messages : [];
	const newerIds = new Set(
		[
			...(Array.isArray(error?.body?.error?.newer) ? error.body.error.newer : []),
			...(Array.isArray(error?.body?.error?.messageIds) ? error.body.error.messageIds : []),
		].map(String),
	);
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
	const sessions = asList(body, ["sessions", "items", "results"]);
	if (sessions.length === 0) return empty(list, query ? `No sessions match “${query}”.` : "No sessions yet.");
	for (const session of sessions) {
		learnDomain(session.url);
		const row = item(
			session.id,
			[session.state, session.model, when(session.updatedAt ?? session.createdAt), session.costUsd !== undefined ? `$${session.costUsd}` : undefined],
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
	const session = body?.session ?? body;
	state.session = { ...session, id: session?.id ?? id };
	$("session-title").textContent = state.session.id;
	const meta = $("session-meta");
	meta.replaceChildren(badge(state.session.state ?? "unknown"));
	const details = document.createElement("span");
	details.textContent = [
		state.session.model,
		state.session.cwd,
		state.session.parent ? `parent ${state.session.parent}` : undefined,
		state.session.costUsd !== undefined ? `$${state.session.costUsd}` : undefined,
	]
		.filter(Boolean)
		.join(" · ");
	meta.append(" ", details);
	$("sessions-list").hidden = true;
	$("session").hidden = false;
	renderTranscript(asList(transcript, ["entries", "transcript", "items"]));
}

function renderTranscript(entries) {
	const container = $("transcript");
	container.replaceChildren();
	for (const entry of entries) container.append(entryElement(entry));
	if (entries.length === 0) empty(container, "No transcript yet.");
}

function entryElement(entry) {
	const div = document.createElement("div");
	div.className = "entry";
	div.dataset.testid = "entry";
	div.dataset.role = String(entry.role ?? entry.kind ?? "assistant");
	const meta = document.createElement("span");
	meta.className = "entry-meta";
	meta.textContent = [entry.role ?? entry.kind, when(entry.at ?? entry.createdAt)].filter(Boolean).join(" · ");
	const text = document.createElement("div");
	text.textContent = String(entry.text ?? entry.body ?? entry.content ?? "");
	div.append(meta, text);
	return div;
}

async function loadTranscript() {
	if (!state.session) return;
	const transcript = await api("GET", `/sessions/${state.session.id}/transcript`);
	renderTranscript(asList(transcript, ["entries", "transcript", "items"]));
}

async function sessionAction(action) {
	const session = state.session;
	if (!session) return;
	try {
		await api("POST", `/sessions/${session.id}/${action}`, {});
		status(`${action === "stop" ? "Stopped" : "Compacted"} ${session.id}.`);
		await openSession(session.id);
	} catch (error) {
		fail(error);
	}
}

// ---- Memory ---------------------------------------------------------------------------------

async function loadMemory() {
	const worktree = await api("GET", "/memory/worktree");
	const path = worktree?.path ?? worktree?.worktree ?? worktree?.dir ?? "";
	$("memory-worktree").textContent = path ? `Worktree: ${path}` : "No memory worktree yet.";
	const files = asList(worktree, ["files"]);
	const list = $("memory-files");
	list.replaceChildren();
	if (files.length === 0) {
		empty(list, "No files listed.");
	} else {
		for (const file of files) {
			const filePath = file.path ?? file.name ?? String(file);
			const row = item(filePath, [file.size !== undefined ? `${file.size} B` : undefined], () => void openMemoryFile(filePath), {
				testid: "memory-file-item",
				id: filePath,
			});
			row.dataset.path = filePath;
			list.append(row);
		}
	}
	await loadMemoryLog();
}

async function loadMemoryLog() {
	const body = await api("GET", "/memory/log");
	const list = $("memory-log");
	list.replaceChildren();
	const commits = asList(body, ["commits", "log", "entries"]);
	if (commits.length === 0) return empty(list, "No memory commits yet.");
	for (const commit of commits) {
		list.append(
			item(commit.subject ?? commit.message ?? commit.sha ?? String(commit), [commit.sha, when(commit.at ?? commit.createdAt)], () => {}, {
				testid: "memory-commit",
			}),
		);
	}
}

async function searchMemory(event) {
	event?.preventDefault();
	const query = $("memory-query").value.trim();
	const body = await api("GET", `/memory/search?query=${encodeURIComponent(query)}`);
	const list = $("memory-results");
	list.replaceChildren();
	const results = asList(body, ["results", "matches", "items"]);
	if (results.length === 0) return empty(list, query ? `Nothing matches “${query}”.` : "Type words to search.");
	for (const result of results) {
		const filePath = result.path ?? result.file ?? result.id ?? "";
		const row = item(filePath || String(result), [result.snippet ?? result.line ?? result.text], () => void openMemoryFile(filePath), {
			testid: "memory-result",
		});
		row.dataset.path = filePath;
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
	const text = await apiText(`/memory/files/${memoryPath(path)}`);
	let content = text;
	try {
		const parsed = JSON.parse(text);
		content = parsed.content ?? parsed.body ?? text;
	} catch {
		// Raw file contents.
	}
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
		status("Saved. Commit it when the memory looks right.");
		await loadMemory();
	} catch (error) {
		fail(error);
	}
}

async function createWorktree() {
	try {
		const created = await api("POST", "/memory/worktree", {});
		const path = created?.path ?? created?.worktree ?? created?.dir;
		if (path) $("memory-worktree").textContent = `Worktree: ${path}`;
		status("Memory worktree ready.");
		await loadMemory();
	} catch (error) {
		fail(error);
	}
}

// ---- Schedules ------------------------------------------------------------------------------

let editingSchedule;

async function loadSchedules() {
	const body = await api("GET", "/schedules");
	const list = $("schedules-list");
	list.replaceChildren();
	const schedules = asList(body, ["schedules", "items"]);
	if (schedules.length === 0) return empty(list, "No schedules yet.");
	for (const schedule of schedules) {
		const row = document.createElement("div");
		row.className = "item";
		row.dataset.testid = "schedule-item";
		row.dataset.id = schedule.id;
		const title = document.createElement("span");
		title.className = "title";
		title.textContent = `${schedule.kind ?? "session"} · ${schedule.cron ?? when(schedule.at)} · ${schedule.state ?? "active"}`;
		const meta = document.createElement("span");
		meta.className = "meta";
		const payload = schedule.payload ?? {};
		meta.textContent = [schedule.id, payload.prompt ?? payload.body ?? payload.subject, `next ${when(schedule.nextAt)}`]
			.filter(Boolean)
			.join(" · ");
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
}

function startScheduleEdit(schedule) {
	editingSchedule = schedule;
	$("schedule-kind").value = schedule.kind ?? "session";
	$("schedule-when").value = schedule.cron ?? "";
	$("schedule-prompt").value = schedule.payload?.prompt ?? schedule.payload?.body ?? "";
	$("schedule-create").textContent = "Update";
	status(`Editing ${schedule.id}.`);
	$("schedule-prompt").focus();
}

async function createSchedule(event) {
	event.preventDefault();
	const prompt = $("schedule-prompt").value.trim();
	if (!prompt) return status("Write a prompt first.", true);
	const body = { kind: $("schedule-kind").value, cron: $("schedule-when").value.trim(), payload: { prompt } };
	try {
		if (editingSchedule) await api("POST", `/schedules/${editingSchedule.id}`, body);
		else await api("POST", "/schedules", body);
		editingSchedule = undefined;
		$("schedule-create").textContent = "Create";
		$("schedule-prompt").value = "";
		$("schedule-when").value = "";
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
				await loadSchedules();
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
$("memory-search").addEventListener("submit", (event) => void searchMemory(event));
$("schedule-form").addEventListener("submit", (event) => void createSchedule(event));
$("enable-push").addEventListener("click", () => void enablePush());
document.addEventListener("click", (event) => {
	const action = event.target?.closest?.("[data-action]")?.dataset.action;
	if (action === "stop" || action === "compact") void sessionAction(action);
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
