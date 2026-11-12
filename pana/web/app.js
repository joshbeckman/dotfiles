// The pana PWA (WEB-01..08, WP13). Plain ES modules, no framework: a hash router, one fetch
// wrapper, a renderer per section, and one keyboard module. The server owns auth (API-04); this
// file only carries the token.

import { choiceText, draftHasChoice, toggleChoice } from "./choices.js";
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
import { apiName, clientBody, startClientTelemetry, viewName } from "./perf.js";
import { HITS_PER_STORE, fuzzyScore, hitHash, matchCommands, paletteCommands, paletteHits } from "./palette.js";
import { createKeyReader, helpRows, isApplePlatform, isSubmitChord, isTextInput, moveSelection, sequenceLabel } from "./keys.js";
import {
	bookmarkRow,
	buildLabel,
	buildSyncLabel,
	configFromText,
	configUserColor,
	configWithUserColor,
	validUserColor,
	userColorPickerValue,
	userColorFromPicker,
	charterBody,
	charterView,
	commitView,
	elapsedLabel,
	entryRaw,
	entryView,
	exactTime,
	inboxThreadRow,
	isWorking,
	liveActivityLabel,
	memoryCommitView,
	memoryFileView,
	memoryHitView,
	messageView,
	metricChart,
	LIMIT_FIELDS,
	limitsBody,
	metricsView,
	objectiveRow,
	objectiveView,
	objectiveWakes,
	participantColor,
	participantPattern,
	refLabel,
	relativeTime,
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
import { renderMessage, syncChoices } from "./render.js";

const $ = (id) => document.getElementById(id);

// The launch URL carries the token in the fragment. Store it, then clear the hash so a reload
// starts at a normal route. An installed app has its own storage, so a 403 opens the panel.
// A fragment that is not a route is a launch fragment, never a view: naming a sample after it
// would write the token into `client.log` (OBS-04).
const launchFragment = (hash) => (hash && !hash.startsWith("#/") ? hash.slice(1) : "");
const launchToken = launchFragment(location.hash);
if (launchToken) {
	localStorage.setItem(TOKEN_KEY, launchToken);
	history.replaceState(null, "", "/#/inbox");
}
let token = launchToken || localStorage.getItem(TOKEN_KEY) || "";

const APPLE = isApplePlatform(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent);

// OBS-03: the PWA measures itself. Samples batch in `perf.js` and post here, through the same
// token-bearing wrapper every other call uses. A failure is dropped inside the recorder.
const telemetry = startClientTelemetry({ post: (samples) => sendClientSamples(samples) });

const state = {
	domain: "",
	userColor: "blue",
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

// ---- Settings -------------------------------------------------------------------------------

let settingsData;
let settingsSavedText;
let settingsConfigRevision;
let settingsBusy = false;
let settingsRestarting = false;

/** Mark user-colored nodes explicitly: palette colors may also belong to sessions. */
function participantIdentity(node, participant, participants = state.thread?.participants ?? [], threadId = state.thread?.id ?? "") {
	const url = typeof participant === "string" ? participant : participant?.url ?? "";
	const kind = typeof participant === "string" ? "" : participant?.kind;
	node.dataset.userColor = String(kind === "user" || (!kind && /^pana:\/\/[^/]+\/users\//.test(url)));
	setVisualColor(node, participantColor(participant, { participants, userColor: state.userColor, threadId }));
	node.dataset.pattern = participantPattern(participant, participants);
}

function setVisualColor(node, color) {
	if (color) node.dataset.color = color;
	else delete node.dataset.color;
	if (validUserColor(color) && color.startsWith("#")) node.style.setProperty("--who", color);
	else node.style.removeProperty("--who");
}

function applyUserColor(color) {
	state.userColor = validUserColor(color) ? color : "blue";
	for (const node of document.querySelectorAll('[data-user-color="true"]')) setVisualColor(node, state.userColor);
}

function syncSettingsColor() {
	const select = $("settings-user-color");
	const picker = $("settings-user-color-picker");
	const preview = $("settings-color-preview");
	try {
		const color = configUserColor(configFromText($("settings-config").value));
		select.value = color;
		select.setCustomValidity("");
		select.disabled = !settingsData || settingsBusy || settingsRestarting;
		picker.disabled = select.disabled;
		picker.value = userColorPickerValue(color);
		setVisualColor(preview, color);
		preview.textContent = `Your message · ${color}`;
		$("settings-color-hint").textContent = "Use the color picker or enter any hex color. The picker preserves alpha from the hex field. Preview only until saved; color applies immediately on save.";
	} catch {
		select.value = "";
		select.disabled = true;
		picker.disabled = true;
		preview.removeAttribute("data-color");
		preview.style.removeProperty("--who");
		preview.textContent = "Preview unavailable";
		$("settings-color-hint").textContent = "Fix the JSON and ui.userColor in the editor to use the color field. Your draft is unchanged.";
	}
}

function settingsNotice(text, error = false) {
	$("settings-status").textContent = text;
	$("settings-status").classList.toggle("error", error);
}

function updateSettingsControls() {
	const changed = settingsSavedText !== undefined && $("settings-config").value !== settingsSavedText;
	$("settings-save").disabled = !settingsData || settingsBusy || settingsRestarting || !changed;
	$("settings-config").disabled = !settingsData || settingsBusy || settingsRestarting;
	$("settings-refresh").disabled = settingsBusy;
	$("settings-reload-config").disabled = settingsBusy || settingsRestarting;
	$("settings-restart").disabled = !settingsData?.restartAvailable || settingsBusy || settingsRestarting;
	$("settings-restart-yes").disabled = settingsBusy || settingsRestarting;
	$("settings-restart-no").disabled = settingsBusy;
	$("settings-draft").textContent = changed ? "Unsaved changes" : "";
	syncSettingsColor();
}

function renderSettings(data) {
	settingsData = data;
	$("settings-source").textContent = buildLabel(data.source);
	$("settings-config-path").textContent = data.configPath;
	$("settings-restart-reason").textContent = data.restartAvailable
		? "Restart loads the current source and saved configuration. Active runs will be interrupted."
		: data.restartReason || "Restart is not available for this daemon.";
	const processes = $("settings-processes");
	processes.replaceChildren();
	for (const process of data.processes || []) {
		const heading = document.createElement("h4");
		heading.textContent = `${process.role} · PID ${process.pid}`;
		const build = document.createElement("p");
		build.className = "settings-build";
		build.textContent = buildLabel(process.running);
		const sync = document.createElement("p");
		sync.className = "notice";
		sync.textContent = buildSyncLabel(data.source, process.running);
		const started = document.createElement("p");
		started.className = "hint";
		if (Number.isFinite(process.startedAt)) {
			tickingLabel(started, { skew: state.clockSkew }, (now) =>
				`Started ${new Date(process.startedAt).toLocaleString()} · running for ${elapsedLabel(Math.max(0, now - process.startedAt))}`);
		} else started.textContent = "Start time unavailable";
		processes.append(heading, build, sync, started);
	}
	if (!processes.childElementCount) processes.textContent = "No process information available.";
	$("settings-config-warning").textContent = data.configValidationError
		? `Configuration on disk is invalid: ${data.configValidationError}. Fix and save it before restarting.`
		: data.configRequiresRestart
		? "Saved configuration differs from the running daemon. Restart required to apply it."
		: "Your message color applies immediately on save. Other configuration changes require a daemon restart.";
	updateSettingsControls();
}

async function loadSettings(reloadConfig = false) {
	if (settingsBusy) return;
	settingsBusy = true;
	updateSettingsControls();
	try {
		const data = await api("GET", "/settings");
		// A refresh or return to this page never silently discards the user's draft.
		const changed = settingsSavedText !== undefined && $("settings-config").value !== settingsSavedText;
		if (!changed || reloadConfig) {
			settingsConfigRevision = data.configRevision;
			settingsSavedText = data.configText ?? (JSON.stringify(data.config, null, 2) + "\n");
			$("settings-config").value = settingsSavedText;
		}
		settingsRestarting = false;
		$("settings-restart-confirm").hidden = true;
		renderSettings(data);
		settingsNotice(changed && !reloadConfig ? "Status refreshed. Your unsaved configuration is kept." : "");
	} catch (error) { settingsNotice(error.message, true); fail(error); }
	finally { settingsBusy = false; updateSettingsControls(); }
}

async function saveSettings(event) {
	event.preventDefault();
	if ($("settings-save").disabled) return;
	const errorNode = $("settings-config-error");
	errorNode.hidden = true;
	let config;
	try { config = configFromText($("settings-config").value); }
	catch (error) {
		errorNode.textContent = error.message;
		errorNode.hidden = false;
		$("settings-config").focus();
		return;
	}
	settingsBusy = true;
	$("settings-restart-confirm").hidden = true;
	updateSettingsControls();
	try {
		const data = await api("POST", "/settings", { config, configRevision: settingsConfigRevision });
		settingsConfigRevision = data.configRevision;
		settingsSavedText = data.configText ?? (JSON.stringify(data.config, null, 2) + "\n");
		$("settings-config").value = settingsSavedText;
		renderSettings(data);
		applyUserColor(configUserColor(data.config));
		settingsNotice("Configuration saved. Your message color is applied. Restart the daemon to apply other changes.");
	} catch (error) {
		errorNode.textContent = error.status === 409
			? `${error.message} Your draft is kept. Copy it before using Reload configuration to read the current file.`
			: error.message;
		errorNode.hidden = false;
		fail(error);
	} finally { settingsBusy = false; updateSettingsControls(); }
}

async function restartSettings() {
	if (settingsBusy || settingsRestarting || !settingsData?.restartAvailable) return;
	settingsBusy = true;
	updateSettingsControls();
	try {
		await api("POST", "/settings/restart", {});
		settingsRestarting = true;
		$("settings-restart-confirm").hidden = true;
		settingsNotice("Restart requested. This app may briefly disconnect. Refresh status once the daemon is back.");
	} catch (error) { settingsNotice(error.message, true); fail(error); }
	finally { settingsBusy = false; updateSettingsControls(); }
}

// ---- Secrets (SET-05) -----------------------------------------------------------------------

/** Drop a typed but unsaved value: this page never shows one, so none may outlive the page. */
function clearSecretDraft() {
	$("settings-secret-value").value = "";
}

/** The `s` store: names only, and a form that writes one. A value never renders back. */
let secretsData;
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function secretError(text) {
	const node = $("settings-secret-error");
	node.textContent = text ?? "";
	node.hidden = !text;
}

function secretHint(data) {
	if (!data) return "";
	if (!data.available) return data.error ?? "The s store is not available to panad.";
	const kb = Math.round((data.maxValueBytes ?? 0) / 1024);
	return `Letters, digits, and underscores in the name. One line per value, up to ${kb} KB. Trailing newlines are dropped.`;
}

/**
 * SET-05: a single-line field loses line breaks before any script sees the paste, so a pasted
 * multi-line value would be stored joined with no error. Refuse it here instead.
 */
function refuseMultiLinePaste(event) {
	const text = event.clipboardData?.getData("text") ?? "";
	if (!/[\r\n]/.test(text)) return;
	event.preventDefault();
	const trimmed = text.replace(/[\r\n]+$/, "");
	if (!/[\r\n]/.test(trimmed)) {
		$("settings-secret-value").value = trimmed;
		secretError();
		return;
	}
	secretError("That value has more than one line, and this field would join them. A multi-line secret has to be set on a machine with a terminal: s set NAME.");
}

/** Run one store write, then render the names the daemon answers with. */
function renderSecretNames(names) {
	if (names === null) {
		// The write succeeded and the list that follows it did not; reload rather than show a
		// list that silently lost the new name.
		void loadSecrets();
		return;
	}
	secretsData = { ...secretsData, names };
	renderSecrets(secretsData);
}

function renderSecrets(data) {
	secretsData = data;
	const list = $("settings-secrets-list");
	const names = data?.available === false ? [] : data?.names ?? [];
	list.replaceChildren();
	for (const name of names) list.append(secretRow(name));
	$("settings-secrets-state").textContent = data?.available === false
		? secretHint(data)
		: names.length ? "" : "No secrets stored yet.";
	$("settings-secret-hint").textContent = data?.available === false ? "" : secretHint(data);
	$("settings-secret-save").disabled = data?.available === false;
	$("settings-secret-name").disabled = data?.available === false;
	$("settings-secret-value").disabled = data?.available === false;
}

/** One stored name with a remove step that asks first, inside the row it acts on. */
function secretRow(name) {
	const item = document.createElement("li");
	item.className = "settings-secret";
	item.dataset.name = name;
	const label = document.createElement("span");
	label.className = "settings-secret-name";
	label.textContent = name;
	const remove = document.createElement("button");
	remove.type = "button";
	remove.className = "quiet";
	remove.textContent = "Remove";
	remove.setAttribute("aria-label", `Remove ${name}`);
	remove.addEventListener("click", () => item.append(secretRemoveConfirm(name)));
	item.append(label, remove);
	return item;
}

function secretRemoveConfirm(name) {
	const box = document.createElement("div");
	box.className = "confirm";
	const text = document.createElement("p");
	text.textContent = `Remove ${name} from the s store?`;
	const actions = document.createElement("div");
	actions.className = "form-actions";
	const cancel = document.createElement("button");
	cancel.type = "button";
	cancel.textContent = "Cancel";
	cancel.addEventListener("click", () => box.remove());
	const yes = document.createElement("button");
	yes.type = "button";
	yes.className = "danger";
	yes.textContent = "Remove";
	yes.addEventListener("click", () => { yes.disabled = true; cancel.disabled = true; void removeSecret(name, box); });
	actions.append(cancel, yes);
	box.append(text, actions);
	cancel.focus();
	return box;
}

async function loadSecrets() {
	try {
		renderSecrets(await api("GET", "/secrets"));
	} catch (error) {
		renderSecrets({ names: [], available: false, error: error.message });
		fail(error);
	}
}

async function saveSecret(event) {
	event.preventDefault();
	const nameNode = $("settings-secret-name");
	const valueNode = $("settings-secret-value");
	const name = nameNode.value.trim();
	const value = valueNode.value;
	secretError();
	if (!SECRET_NAME.test(name)) {
		secretError("A secret name starts with a letter or underscore and holds only letters, digits, and underscores.");
		nameNode.focus();
		return;
	}
	if (!value.length) {
		secretError("A secret needs a value.");
		valueNode.focus();
		return;
	}
	const button = $("settings-secret-save");
	button.disabled = true;
	try {
		const data = await api("POST", "/secrets", { name, value });
		// Clear before rendering: the value must not sit in the DOM while the list redraws.
		clearSecretDraft();
		renderSecretNames(Array.isArray(data.names) ? data.names : null);
		secretError();
		$("settings-secret-hint").textContent = `${name} saved to the s store.`;
	} catch (error) {
		secretError(error.message);
	} finally { button.disabled = secretsData?.available === false; }
}

async function removeSecret(name, box) {
	try {
		const data = await api("DELETE", `/secrets/${encodeURIComponent(name)}`);
		box.remove();
		renderSecretNames(Array.isArray(data.names) ? data.names : null);
	} catch (error) {
		box.remove();
		secretError(error.message);
	}
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
	// OBS-03: one sample per call, from the request to the parsed body, so a slow reply is a
	// measured reply rather than a guess. The name is the route pattern, never the id.
	const started = telemetry?.now();
	let status;
	try {
		const response = await raw(path, options);
		status = response.status;
		return await decode(response, method, path);
	} finally {
		if (started !== undefined) telemetry?.api(apiName(method, path), telemetry.now() - started, status);
	}
}

/** Post one batch of measurements. Best effort: the caller never sees a failure (OBS-03). */
function sendClientSamples(samples) {
	const body = JSON.stringify(clientBody(samples));
	// `keepalive` lets the last batch outlive the page it was measured on.
	return raw("/stats/client", { method: "POST", body, headers: { "content-type": "application/json" }, keepalive: true });
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
	// The route reads the media type from the bytes; a header from the browser would only be a
	// claim it must not trust.
	const response = await raw(`/files?name=${encodeURIComponent(file.name)}`, { method: "POST", body });
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

/**
 * The domain a pana:// link needs. `/events` sends it in `hello` as soon as the stream opens, so it
 * usually arrives before the first route runs, and a payload URL teaches it too. The timer only
 * bounds a page whose stream never opens. A domain already learned resolves this at once: the
 * stream usually opens before the first route, and waiting on the timer then cost the first inbox
 * draw 1040 ms of a 1049 ms render, measured on 2026-11-08.
 */
function ensureDomain() {
	if (state.domainReady) return state.domainReady;
	state.domainReady = new Promise((resolve) => {
		if (state.domain) return resolve();
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

// Buffer live changes while a thread or roster read is in flight. Its snapshot may predate them.
const pendingRoleReads = new Set();
let roleConnectionVersion = 0;
function rememberRosterEvent(event) {
	for (const pending of pendingRoleReads) {
		if (event.kind === "thread.subject") {
			if (event.threadId === pending.id) pending.subjectRevision++;
			continue;
		}
		if (event.kind === "thread.role" && event.threadId !== pending.id) continue;
		if (event.kind === "session.state" && !event.threadIds?.includes(pending.id)) continue;
		pending.events.push(event);
	}
}

function patchRosterPerson(person, event) {
	if (event.kind === "thread.role" && person.id === event.participantId) person.role = event.role;
	if (person.kind !== "session" || person.id !== event.sessionId) return;
	if (event.kind === "session.state") {
		person.state = event.state;
		if (!isWorking(event.state)) delete person.activity;
	} else if (event.kind === "session.wake") {
		if (event.wake && Number.isFinite(Number(event.wake.at))) person.wake = event.wake;
		else delete person.wake;
	} else if (event.kind === "session.live") {
		if (event.live) person.activity = event.live;
		else delete person.activity;
	}
}

async function readThreadWithRoles(id, participantsOnly = false, seedEvent) {
	const pending = { id, events: seedEvent ? [seedEvent] : [], subjectRevision: 0 };
	pendingRoleReads.add(pending);
	try {
		const base = `/threads/${encodeURIComponent(id)}`;
		let version = roleConnectionVersion;
		const body = await api("GET", participantsOnly ? `${base}/participants` : base);
		let participants = participantsOnly ? body.participants : body.thread?.participants;
		// A reconnect can lose events, and a role event can name a member missing from the old
		// snapshot. Re-read only the roster; a second thread read could mark missed mail read.
		const retriedMembers = new Set();
		const missingMembers = () => pending.events.filter((event) => event.kind === "thread.role" &&
			!participants?.some((person) => person?.id === event.participantId) && !retriedMembers.has(event.participantId));
		let subjectRevision = 0;
		let subjectNeedsRead = false;
		while (true) {
			if (version !== roleConnectionVersion || missingMembers().length > 0) {
				if (version !== roleConnectionVersion) {
					pending.events.length = 0;
					retriedMembers.clear();
					subjectNeedsRead = true;
				} else {
					for (const event of missingMembers()) retriedMembers.add(event.participantId);
				}
				version = roleConnectionVersion;
				const latest = await api("GET", `${base}/participants`);
				if (participantsOnly) {
					body.participants = latest.participants;
					participants = body.participants;
				} else {
					body.thread.participants = latest.participants;
					participants = body.thread.participants;
				}
				continue;
			}
			if (!participantsOnly && (subjectNeedsRead || subjectRevision !== pending.subjectRevision)) {
				// An event and a thread snapshot have no shared revision. Read the subject without
				// marking mail read, and retry if an event or reconnect overlaps this read.
				subjectNeedsRead = false;
				subjectRevision = pending.subjectRevision;
				const latest = await api("POST", `${base}/subject`);
				body.thread.subject = latest.subject;
				continue;
			}
			break;
		}
		for (const event of pending.events) {
			const person = participants?.find((each) => each?.id === (event.participantId ?? event.sessionId));
			if (person) patchRosterPerson(person, event);
		}
		return { body, events: pending.events };
	} finally {
		pendingRoleReads.delete(pending);
	}
}

// Synchronize the working set and live activity from the snapshot after applying buffered events.
// A buffered full live view supersedes the snapshot's short activity; a stop or null clears it.
function syncRosterActivity(thread, events) {
	const working = workingMap(thread.id);
	working.clear();
	for (const session of workingParticipants(thread)) working.set(session.sessionId, session);
	for (const person of thread.participants ?? []) {
		if (person.kind !== "session") continue;
		let activity = person.activity;
		// A roster has only the short activity. Keep an equally recent full live view so a
		// later visit to the session still has its tool and generation details.
		const full = state.live.get(person.id)?.view;
		if (activity && full?.tools && full.at === activity.at) activity = full;
		for (const event of events) {
			if (event.sessionId !== person.id) continue;
			if (event.kind === "session.live") activity = event.live;
			else if (event.kind === "session.state" && !isWorking(event.state)) activity = null;
		}
		rememberLive(person.id, activity);
	}
	workingChanged(thread.id);
}

function renderThreadParticipants(thread) {
	const container = $("thread-participants");
	const active = document.activeElement;
	const focusedId = active instanceof HTMLElement && container.contains(active) ? active.closest(".person")?.dataset.participantId : undefined;
	let replacement;
	container.replaceChildren();
	for (const participant of thread?.participants ?? []) {
		const person = typeof participant === "object" ? participant : { url: participant };
		const node = personLink(person, thread.participants, thread.id);
		if (person.id) node.dataset.participantId = person.id;
		const role = span("", "participant-role");
		role.dataset.testid = "participant-role";
		role.title = "Self-declared role";
		node.append(role);
		renderParticipantRole(node, person.role);
		container.append(node);
		if (focusedId && person.id === focusedId) replacement = node.querySelector("a");
	}
	// Do not move focus from a draft or another control. Only restore a participant link that
	// was focused before the synchronous redraw and still belongs to the refreshed roster.
	replacement?.focus({ preventScroll: true });
}

function renderParticipantRole(node, role) {
	const label = node.querySelector(".participant-role");
	if (!label) return;
	const visible = typeof role === "string" && role !== "" && role !== "participant";
	label.textContent = visible ? role : "";
	label.hidden = !visible;
}

function applyThreadRole(event) {
	if (state.thread?.id !== event.threadId) return;
	const person = state.thread.participants?.find((each) => each?.id === event.participantId);
	if (!person) {
		void refreshThreadRoles(event).catch(fail);
		return;
	}
	person.role = event.role;
	for (const node of $("thread-participants").children) {
		if (node.dataset.participantId === event.participantId) renderParticipantRole(node, event.role);
	}
}

// A stream may miss events while disconnected. Refresh the roster, not the draft or messages.
let roleRefreshVersion = 0;
async function refreshThreadRoles(seedEvent) {
	if (state.section !== "threads" || !state.thread || $("thread").hidden) return;
	const current = state.thread;
	const version = ++roleRefreshVersion;
	const { body, events } = await readThreadWithRoles(current.id, true, seedEvent);
	if (version !== roleRefreshVersion || state.thread !== current || state.section !== "threads") return;
	current.participants = body.participants;
	renderThreadParticipants(current);
	// Existing messages retain their nodes and menus, but their colors follow the new roster.
	syncMessageIdentities($("thread-messages"));
	syncMessageIdentities($("stale-new"));
	syncRosterActivity(current, events);
}
// Count live changes to the open thread so a slow HTTP response cannot undo a newer event.
let subjectEventRevision = 0;

// Patch labels only: reopening a thread would disturb reply drafts, focus, and scroll.
function applyThreadSubject(threadId, subject) {
	if (state.thread?.id === threadId) {
		state.thread.subject = subject;
		renderThreadSubject(subject);
	}
	for (const row of document.querySelectorAll("[data-thread]")) {
		if (row.dataset.thread === threadId) {
			const label = row.querySelector(".thread-subject-label");
			if (label) label.textContent = subject;
		}
	}
}

/**
 * UX-17: the subject is the thread's own copy link, the way a session's title is its own. The
 * heading keeps the whole subject for a hover, since the pinned header clamps it to two lines.
 */
function renderThreadSubject(subject) {
	const heading = $("thread-subject");
	const url = state.thread?.url ?? `pana://${state.domain}/threads/${state.thread?.id ?? ""}`;
	heading.replaceChildren(copyLink(url, "thread", subject));
	heading.title = subject;
}

function handleEvent(event) {
	// Every event carries panad's `at`; keeping the difference means a scheduled time counts down
	// against panad's clock even when the two machines disagree, as a test's fake clock does.
	if (Number.isFinite(Number(event.at))) state.clockSkew = Date.now() - Number(event.at);
	if (event.kind === "thread.subject" && typeof event.threadId === "string" && typeof event.subject === "string") {
		rememberRosterEvent(event);
		if (state.thread?.id === event.threadId) subjectEventRevision++;
		applyThreadSubject(event.threadId, event.subject);
		return;
	}
	if (event.kind === "thread.role" && typeof event.threadId === "string" && typeof event.participantId === "string" && typeof event.role === "string") {
		rememberRosterEvent(event);
		applyThreadRole(event);
		return;
	}
	if (event.kind === "settings.ui") {
		applyUserColor(event.userColor);
		return;
	}
	if (event.kind === "hello") {
		roleConnectionVersion++;
		applyUserColor(event.userColor);
		if (typeof event.domain === "string") state.domain = event.domain;
		state.domainResolved?.();
		void refreshThreadRoles().catch(fail);
		return;
	}
	if (event.kind === "artifact.published") { void artifactPublished(event).catch(fail); return; }
	// UX-09: who is working changes in the open thread and in the lists, without a reload.
	if (event.kind === "session.state" && typeof event.sessionId === "string") {
		rememberRosterEvent(event);
		applyStateEvent(event);
		// OBJ-39/UX-09: an objective's roster follows the same events, so a member's state is live.
		applyObjectiveStateEvent(event);
		return;
	}
	// UX-09: a session's next wake moved, so the open thread's scheduled chip follows without a reload.
	if (event.kind === "session.wake" && typeof event.sessionId === "string") {
		rememberRosterEvent(event);
		applyWakeEvent(event);
		return;
	}
	// UX-12: work in progress. It carries no entry, so it must not fall through to a reload.
	if (event.kind === "session.live" && typeof event.sessionId === "string") {
		rememberRosterEvent(event);
		const person = state.thread?.participants?.find((each) => each?.kind === "session" && each.id === event.sessionId);
		if (person) patchRosterPerson(person, event);
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
	// section is open. `loadInbox` refreshes the badge on its way, so the inbox section asks
	// once instead of twice; only the archived view (REF-07) leaves the badge behind.
	if (state.section === "inbox") {
		if ($("inbox-archived")?.checked) void refreshUnread().catch(() => {});
		reloadInbox();
	} else {
		void refreshUnread().catch(() => {});
	}
	if (event.threadId === state.thread?.id) revealOpenThread();
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

/**
 * WEB-11: a phone suspends an app it was launched into instead of closing it, and the `/events`
 * stream it left open never delivers again — the read just never returns, so nothing retries.
 * The stream therefore follows visibility: out of sight lets it go, and coming back opens a new
 * one and re-reads what the deliveries the app missed would have redrawn (REF-06).
 */
let eventsPaused = false;

function pauseEvents() {
	eventsPaused = true;
	stopEvents();
}

async function resumeApp() {
	// A click that only focuses the window arrives no other way (PSH-05).
	await followClick().catch(() => {});
	if (!eventsPaused || !token || document.visibilityState === "hidden") return;
	eventsPaused = false;
	startEvents();
	// Same one-call rule as a live delivery: the list reload carries the badge with it.
	if (state.section === "inbox") {
		await loadInbox().catch(fail);
		if ($("inbox-archived")?.checked) await refreshUnread().catch(() => {});
	} else {
		await refreshUnread().catch(() => {});
	}
	// WEB-11: the deliveries the paused stream missed would have redrawn the open thread too.
	revealOpenThread();
}

/**
 * WEB-11 and REF-06: new mail belongs in the thread the reader has open, whether a delivery
 * carried it or the app was away when it arrived. A drafted reply is left alone: reopening moves
 * the draft head, and a draft in progress must keep the head it was written against so a stale
 * send gets WEB-07's 409.
 */
function revealOpenThread() {
	if (state.section !== "threads" || !state.thread || $("thread").hidden) return;
	if ($("reply-body").value.trim()) return;
	void openThread(state.thread.id).catch(fail);
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
		// A link, an action, or a control that declares itself one inside the row does its own thing.
		if (event.target?.closest?.("a, button, [role='button']")) return;
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
function personLink(person, participants = state.thread?.participants ?? [], threadId = state.thread?.id ?? "") {
	const url = typeof person === "string" ? person : person.url;
	const link = refLink(url, "user", refLabel(url), url);
	const wrap = span("", "person");
	participantIdentity(wrap, person, participants, threadId);
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

/**
 * UX-21: a time shows its short form, and a click reveals the exact timestamp and how long ago it
 * was in a small bubble anchored to it. The reading is measured against panad's clock and keeps
 * counting while the bubble is open, and the bubble is built when opened and removed when closed,
 * so a page of times carries no hidden readings and a thread left open holds no stale age. It is
 * anchored rather than swapped in place because a time is also a narrow list column (UX-20),
 * where the exact reading would otherwise push its neighbours off the row. `label` names the time
 * for a reader who listens, where a column header would otherwise do it.
 */
function timeEl(value, { label = "" } = {}) {
	const node = document.createElement("time");
	node.className = "when";
	const at = Number(value);
	const date = new Date(at);
	const short = shortTime(value);
	const exact = Number.isNaN(date.getTime()) ? String(value ?? "") : exactTime(at);
	const name = (text) => (label ? `${label}: ${text}` : text);
	node.textContent = short;
	node.title = exact;
	if (!Number.isNaN(date.getTime())) node.dateTime = date.toISOString();
	if (label) node.setAttribute("aria-label", name(short));
	// Only a reading this browser could place is worth revealing.
	if (Number.isNaN(date.getTime())) return node;

	let bubble;
	function close() {
		bubble?.remove();
		bubble = undefined;
		node.setAttribute("aria-expanded", "false");
		node.classList.remove("revealed");
		if (label) node.setAttribute("aria-label", name(short));
		if (openTime?.node === node) openTime = undefined;
	}
	function open() {
		closeTime(node);
		bubble = span("", "when-detail");
		bubble.dataset.testid = "when-detail";
		const age = span("", "when-relative");
		bubble.append(span(exact, "when-exact"), age);
		// The shared ticker keeps the age counting; it stops when the bubble leaves the page.
		bubble.dataset.ticking = "true";
		bubble.__render = () => {
			age.textContent = relativeTime(at, serverNow());
		};
		bubble.__render();
		// Reading or selecting the bubble is not a click on the time that opened it.
		bubble.addEventListener("click", (event) => event.stopPropagation());
		node.append(bubble);
		placeDetail(node, bubble);
		node.setAttribute("aria-expanded", "true");
		node.classList.add("revealed");
		if (label) node.setAttribute("aria-label", name(`${exact}, ${age.textContent}`));
		openTime = { node, close };
	}

	node.tabIndex = 0;
	node.setAttribute("role", "button");
	node.setAttribute("aria-expanded", "false");
	// A click on the time is the reveal, not the row's own action (inbox and thread lists).
	node.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		if (bubble) close();
		else open();
	});
	node.addEventListener("keydown", (event) => {
		if (event.key !== "Enter" && event.key !== " ") return;
		event.preventDefault();
		node.click();
	});
	return node;
}

/** UX-21: the time whose reading is showing, with the way to put it away. */
let openTime;

/** Close the open reading unless it belongs to `except`, so one reading shows at a time. */
function closeTime(except) {
	if (!openTime || openTime.node === except) return;
	const { close } = openTime;
	close();
}

/**
 * UX-21: keep a reading on screen. A time at the right edge opens leftward, a time near the foot
 * of a phone opens upward, and neither ever widens the page (MOB-01).
 */
function placeDetail(node, bubble) {
	const margin = 8;
	const anchor = node.getBoundingClientRect();
	const box = bubble.getBoundingClientRect();
	const left = Math.max(margin, Math.min(anchor.left, window.innerWidth - margin - box.width));
	bubble.style.left = `${left - anchor.left}px`;
	if (anchor.bottom + box.height + margin > window.innerHeight && anchor.top - box.height - margin > 0) {
		bubble.style.top = "auto";
		bubble.style.bottom = "calc(100% + var(--s1))";
	}
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
	// Thread-list summaries lack participants: their mark is a generic activity signal.
	participantIdentity(mark, { url: working[0].url, kind: "session" }, row.__participants ?? [], threadId);
	if (!mark.dataset.color) mark.dataset.color = "blue";
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
		if (state.thread?.id === threadId) {
			const person = state.thread.participants?.find((each) => each?.kind === "session" && each.id === sessionId);
			if (person) patchRosterPerson(person, event);
		}
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
	participantIdentity(chip, { url: wake.url, kind: "session" });
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
	participantIdentity(chip, { url: session.url, kind: "session" });
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

/**
 * One list load at a time, with at most one trailing reload (WEB-14). Archiving ten threads
 * asks for the list once per action and once per delivery event, and each answer used to
 * arrive as its own fetch; over a slow link those stack up in front of the next tap. A request
 * that lands mid-load is satisfied by the trailing reload rather than by a second request.
 */
let inboxReloading = false;
let inboxReloadAgain = false;

function reloadInbox() {
	if (inboxReloading) {
		inboxReloadAgain = true;
		return;
	}
	inboxReloading = true;
	void (async () => {
		try {
			do {
				inboxReloadAgain = false;
				await loadInbox();
			} while (inboxReloadAgain);
		} catch (error) {
			fail(error);
		} finally {
			inboxReloading = false;
		}
	})();
}

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
	for (const person of others) people.append(personLink(person, row.participants, row.threadId));
	const snippet = document.createElement("span");
	snippet.className = "snippet";
	snippet.dataset.testid = "inbox-snippet";
	const who = span(`${row.sender.kind === "user" ? "You" : refLabel(row.sender.url)}: `, "snippet-sender");
	if (row.sender.kind !== "user") who.replaceChildren(referenceText(`${refLabel(row.sender.url)}: `));
	participantIdentity(who, row.sender, row.participants, row.threadId);
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
	node.__participants = row.participants;
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
		// `leave` navigates, and the list it lands on reloads itself.
		if (open && leave) {
			location.hash = state.lastList;
			return;
		}
		if (open) {
			await refreshUnread().catch(() => {});
			await openThread(threadId);
			return;
		}
		// The inbox list carries the badge, so archiving in the inbox costs one fetch, not two.
		if (state.section === "inbox") reloadInbox();
		else if (state.section === "threads") await searchThreads();
		else await refreshUnread().catch(() => {});
	} catch (error) {
		fail(error);
	}
}

// ---- Bookmarks (BKM-05) --------------------------------------------------------------------

let bookmarksRequest = 0;

/**
 * The messages the user saved, newest save first, one page at a time (SCALE-03). Each row opens
 * its message in its thread, which is the same link the message header copies.
 */
async function loadBookmarks(cursor) {
	const request = ++bookmarksRequest;
	const list = $("bookmarks-list");
	if (!cursor) list.replaceChildren();
	let body;
	try {
		body = await api("GET", pagePath("/bookmarks", cursor));
	} catch (error) {
		if (request === bookmarksRequest) throw error;
		return;
	}
	// A page that answers after a newer load was started does not draw under it.
	if (request !== bookmarksRequest) return;
	const rows = asList(body, ["bookmarks"]);
	if (rows.length === 0 && !cursor) return empty(list, "No bookmarks yet. Save a message from its ⋯ menu.");
	for (const raw of rows) list.append(await bookmarkItem(bookmarkRow(raw)));
	showMore(list, nextCursor(body), (next) => loadBookmarks(next).catch(fail));
}

/**
 * BKM-05: one saved message, whole. A bookmark is worth saving for what it says, so the card
 * carries the rendered body rather than a snippet; the header still says whose it is, when it was
 * sent, when it was saved, and links to its place in the thread.
 */
async function bookmarkItem(row) {
	learnDomain(row.threadUrl);
	const place = `#/threads/${row.threadId}?message=${row.messageId}`;
	const article = document.createElement("article");
	article.className = "message bookmark";
	article.tabIndex = 0;
	article.dataset.selectable = "";
	article.dataset.testid = "bookmark-item";
	article.dataset.id = row.messageId;
	article.dataset.thread = row.threadId;
	// UX-06: the message's own identity color, the way it reads in its thread.
	participantIdentity(article, row.sender, [], row.threadId);

	const header = document.createElement("header");
	const subject = document.createElement("a");
	subject.className = "bookmark-subject";
	subject.href = `#/threads/${row.threadId}`;
	subject.textContent = row.subject;
	const sender = span(row.sender.kind === "user" ? "You" : refLabel(row.sender.url), "sender");
	participantIdentity(sender, row.sender, [], row.threadId);
	const saved = span("Saved ", "bookmark-saved");
	saved.append(timeEl(row.bookmarkedAt, { label: "bookmarked" }));
	const actions = span("", "bookmark-actions");
	const open = document.createElement("a");
	open.className = "link-button";
	open.href = place;
	open.dataset.testid = "bookmark-open";
	open.textContent = "Open in thread";
	actions.append(open, rowAction("bookmark-remove", "Remove", () => void removeBookmark(row)));
	header.append(subject, sender, timeEl(row.at, { label: "sent" }), saved, actions);
	article.append(header);

	const body = document.createElement("div");
	body.className = "body prose";
	body.dataset.testid = "bookmark-body";
	article.append(body);
	if (row.redacted) {
		body.textContent = row.display ?? "[redacted]";
	} else {
		const { marked, DOMPurify } = window.MailRenderers ?? {};
		await renderMessage(body, row.body, {
			marked,
			DOMPurify,
			domain: state.domain,
			fetchFile,
			cache: fileUrls,
			ensureMermaid,
			idPrefix: `bookmark-${row.messageId}`,
			dark: matchMedia("(prefers-color-scheme: dark)").matches,
			onPick: pickChoice,
		});
		syncChoices(body, draftHas);
	}

	article.addEventListener("click", (event) => {
		// A link or an action does its own thing; anywhere else opens the message in its thread.
		if (event.target?.closest?.("a, button, [role='button']")) return;
		location.hash = place;
	});
	return article;
}

/** BKM-05: take one message out of the list in place, without reloading the page. */
async function removeBookmark(row) {
	try {
		await api("POST", `/messages/${row.messageId}/unbookmark`, {});
		const list = $("bookmarks-list");
		list?.querySelector(`[data-id="${row.messageId}"]`)?.remove();
		if (list && list.querySelectorAll("[data-testid=bookmark-item]").length === 0) {
			empty(list, "No bookmarks yet. Save a message from its ⋯ menu.");
		}
		status("Bookmark removed.");
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
	const revision = subjectEventRevision;
	button.disabled = true;
	button.textContent = "Regenerating…";
	try {
		const body = await api("POST", `/threads/${thread.id}/subject`, { regenerate: true });
		if (state.thread?.id === thread.id) {
			if (state.thread === thread && revision === subjectEventRevision) {
				applyThreadSubject(thread.id, body.subject ?? "(no subject)");
			} else {
				// An intervening event or thread refresh can be older OR newer than this response.
				// Read the current subject, and avoid overwriting a later event or thread refresh.
				const readThread = state.thread;
				const readRevision = subjectEventRevision;
				let current;
				try {
					current = await api("POST", `/threads/${thread.id}/subject`);
				} catch {
					status(body.applied === false
						? "A newer subject was already applied, but refresh failed. Reopen the thread to check it."
						: "Subject regenerated, but refresh failed. Reopen the thread to check it.", true);
					return;
				}
				if (state.thread === readThread && readRevision === subjectEventRevision) {
					applyThreadSubject(thread.id, current.subject ?? "(no subject)");
				}
			}
		}
		status(body.applied === false ? "A newer subject was already applied." : "Subject regenerated.");
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
	// UX-20: the four columns are named once at the top of the list, not on every row.
	if (!cursor) {
		list.append(threadsHeader());
		// The header's own rule separates it from the first row, so the list's top rule would double it.
		list.classList.add("has-header");
	}
	// A later page can hit a thread an earlier page listed.
	const seen = new Set([...list.querySelectorAll("[data-thread]")].map((element) => element.dataset.thread));
	for (const hit of threads) {
		const thread = threadRow(hit);
		// A search returns one hit per matching message; list each thread once.
		if (seen.has(thread.id)) continue;
		seen.add(thread.id);
		learnDomain(thread.url);
		const aside = document.createElement("div");
		aside.className = "item-aside thread-columns";
		aside.append(...threadColumns(thread));
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

/**
 * UX-20: the threads list's four columns, in order. The words live here — once, above the rows —
 * rather than on every row, so a row repeats values and never labels.
 */
const THREAD_COLUMNS = [
	{ label: "messages", title: "How many messages the thread holds" },
	{ label: "participants", title: "How many people are in the thread" },
	{ label: "created", title: "When the thread was created" },
	{ label: "last message", title: "When the newest message was sent" },
];

/** UX-20: the header those columns are named by, drawn once at the top of the list. */
function threadsHeader() {
	const header = document.createElement("div");
	header.className = "list-header thread-columns";
	header.dataset.testid = "threads-header";
	for (const column of THREAD_COLUMNS) {
		const name = span(column.label, "column-label");
		name.title = column.title;
		header.append(name);
	}
	return header;
}

/**
 * UX-20: one thread row's four cells — its message count, its participant count, and its creation
 * and newest-message times. Each cell carries its own words only where they are not on screen: in
 * `title` and `aria-label` for a reader who hovers or listens, and in the phone layout, where the
 * header is gone and a cell names itself.
 */
function threadColumns(thread) {
	const cells = [];
	for (const [value, noun, testid] of [
		[thread.messageCount, thread.messageCount === 1 ? "message" : "messages", "thread-message-count"],
		[thread.participantCount, thread.participantCount === 1 ? "participant" : "participants", "thread-participant-count"],
	]) {
		const cell = span(String(value), "column-count");
		cell.dataset.testid = testid;
		cell.dataset.unit = noun;
		cell.title = `${value} ${noun}`;
		cell.setAttribute("aria-label", cell.title);
		cells.push(cell);
	}
	for (const [label, at, name] of [
		["created", thread.createdAt, "created"],
		["last", thread.lastMessageAt, "last message"],
	]) {
		// A thread with no message still lines up: its cell is empty, not missing.
		if (!at) {
			cells.push(span("", "column-when"));
			continue;
		}
		const cell = timeEl(at, { label: name });
		cell.dataset.testid = `thread-${label}`;
		cell.dataset.label = label;
		cells.push(cell);
	}
	return cells;
}

// A render can finish after a roster refresh while its nodes are still detached. Set identity
// again immediately before insertion, as well as updating messages already on screen.
function syncMessageIdentities(root) {
	if (!state.thread) return;
	const nodes = root instanceof Element && root.matches('[data-testid="message"]') ? [root] : root.querySelectorAll('[data-testid="message"]');
	for (const node of nodes) participantIdentity(node, node.dataset.sender, state.thread.participants, state.thread.id);
}

async function messageElement(message, { focus }) {
	const view = messageView(message);
	learnDomain(view.sender);
	const article = document.createElement("article");
	article.className = "message";
	article.tabIndex = -1;
	article.dataset.testid = "message";
	article.dataset.id = view.id ?? "";
	if (Number.isSafeInteger(message.seq)) article.dataset.seq = String(message.seq);
	article.dataset.sender = view.sender;
	// UX-06: the sender's identity color belongs to this thread, not the session.
	participantIdentity(article, { url: view.sender, kind: view.senderKind });

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
	// BKM-04: saving comes first, because it is the one action here that is undone from the same
	// place, and its label carries the state.
	actions.append(
		messageAction(menu, view, "bookmark", view.bookmarked ? "Remove bookmark" : "Bookmark", () => {
			void setBookmark(view, article);
		}),
		messageAction(menu, view, "edit", "Edit", () => startConfirm("edit", view, article)),
		messageAction(menu, view, "redact", "Redact", () => startConfirm("redact", view, article)),
	);
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
			// WEB-10: a reply option offers text for the draft under the thread, nothing else.
			onPick: pickChoice,
		});
		syncChoices(body, draftHas);
	}

	if (focus) article.classList.add("focus");
	return article;
}

/** One entry of a message's action menu: it closes the menu, then runs (UX-04). */
function messageAction(menu, view, action, label, run) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "link-button";
	button.dataset.action = action;
	button.dataset.id = view.id ?? "";
	button.dataset.testid = `message-${action}`;
	button.textContent = label;
	button.addEventListener("click", () => {
		menu.open = false;
		run();
	});
	return button;
}

/** BKM-04: save this message, or take the mark off, and swap the menu label in place. */
async function setBookmark(view, article) {
	if (article.dataset.bookmarkPending) return;
	article.dataset.bookmarkPending = "true";
	const save = !view.bookmarked;
	try {
		await api("POST", `/messages/${view.id}/${save ? "bookmark" : "unbookmark"}`, {});
		view.bookmarked = save;
		const button = article.querySelector("[data-testid=message-bookmark]");
		if (button) button.textContent = save ? "Remove bookmark" : "Bookmark";
		status(save ? "Bookmarked." : "Bookmark removed.");
	} catch (error) {
		fail(error);
	} finally {
		delete article.dataset.bookmarkPending;
	}
}

/** Close any message's action menu except the one named; a click elsewhere or Escape does this. */
function closeMessageMenus(except) {
	for (const menu of document.querySelectorAll(".message-menu[open]")) if (menu !== except) menu.open = false;
}

/**
 * MOB-08: on a phone a view header's secondary controls fold behind one menu button, because a
 * pinned header cannot spare a row for them; on a wide screen they are the row they always were.
 * The open state carries that, so a closed detail never has to render its content.
 */
const phoneWidth = matchMedia("(max-width: 40rem)");
function syncHeaderMenus() {
	for (const menu of document.querySelectorAll(".header-menu")) menu.open = !phoneWidth.matches;
}
syncHeaderMenus();
phoneWidth.addEventListener("change", syncHeaderMenus);

/** The same for a view header's folded controls, so only one is open at a time. */
function closeHeaderMenus() {
	if (!phoneWidth.matches) return; // A wide screen shows these as a row, not as a menu.
	for (const menu of document.querySelectorAll(".header-menu[open]")) menu.open = false;
}

/** Put the edit and redact form back in its hidden home before the messages are replaced. */
function parkConfirm() {
	$("confirm").hidden = true;
	$("edit-field").hidden = true;
	$("confirm-home").append($("confirm"));
	state.confirm = null;
}

// ART-12..15: the pane owns its capability and never navigates the app to artifact bytes.
let artifactRouteVersion = 0;
let artifactCurrent = null;
let artifactObjectUrl;
const artifactPublishedSeq = new Map();
let threadScrollBeforeArtifact = 0;

function artifactHref(threadId, artifactId, seq) {
	return `#/threads/${encodeURIComponent(threadId)}/a/${encodeURIComponent(artifactId)}${seq === undefined ? "" : `/v/${seq}`}`;
}

async function loadArtifactList(threadId) {
	const { artifacts } = await api("GET", `/threads/${encodeURIComponent(threadId)}/artifacts`);
	if (state.section !== "threads" || state.thread?.id !== threadId) return;
	const list = $("artifact-list");
	list.replaceChildren();
	list.hidden = !artifacts.length;
	if (!artifacts.length) return;
	list.append(document.createTextNode("Artifacts: "));
	for (const artifact of artifacts) {
		const link = document.createElement("a");
		link.href = artifactHref(threadId, artifact.id);
		link.dataset.testid = "artifact-open";
		link.textContent = `${artifact.name} v${artifact.newestVersion.seq}`;
		list.append(link);
	}
}

function closeArtifactPane() {
	artifactRouteVersion++;
	artifactCurrent = null;
	$("thread-layout").classList.remove("artifact-active");
	$("artifact-pane").hidden = true;
	$("artifact-content").replaceChildren();
	if (artifactObjectUrl) URL.revokeObjectURL(artifactObjectUrl);
	artifactObjectUrl = undefined;
}

async function openArtifactPane(threadId, id, seq) {
	const generation = ++artifactRouteVersion;
	const current = () => generation === artifactRouteVersion && state.section === "threads" && state.thread?.id === threadId;
	const result = await api("GET", `/artifacts/${encodeURIComponent(id)}${seq === undefined ? "" : `?seq=${encodeURIComponent(seq)}`}`);
	if (!current()) return;
	if (result.artifact.threadId !== threadId) throw new Error("Artifact belongs to a different thread.");
	const version = seq === undefined ? result.versions.at(-1) : result.versions.find((v) => String(v.seq) === String(seq));
	if (!version) throw new Error("Artifact version not found.");
	artifactCurrent = { id, threadId, seq: version.seq, pinned: seq !== undefined };
	$("artifact-title").textContent = result.artifact.name;
	$("artifact-version").textContent = `v${version.seq}`;
	$("artifact-back").href = `#/threads/${encodeURIComponent(threadId)}`;
	$("artifact-new-version").hidden = true;
	const newer = artifactPublishedSeq.get(id);
	if (newer > version.seq) offerArtifactVersion(newer);
	const content = $("artifact-content");
	content.replaceChildren();
	if (artifactObjectUrl) URL.revokeObjectURL(artifactObjectUrl);
	artifactObjectUrl = undefined;
	$("artifact-pane").hidden = false;
	$("thread-layout").classList.add("artifact-active");
	const entry = version.entry.toLowerCase();
	if (entry.endsWith(".html")) {
		const frame = document.createElement("iframe");
		frame.dataset.testid = "artifact-frame";
		frame.title = `${result.artifact.name} v${version.seq}`;
		frame.setAttribute("sandbox", "allow-scripts");
		frame.referrerPolicy = "no-referrer";
		frame.src = version.previewUrl;
		content.append(frame);
	} else if (/\.(png|jpe?g|gif|webp|avif)$/i.test(entry)) {
		const image = document.createElement("img");
		image.dataset.testid = "artifact-image";
		image.alt = result.artifact.name;
		image.referrerPolicy = "no-referrer";
		image.src = version.previewUrl;
		content.append(image);
	} else {
		const response = await fetch(version.previewUrl, { credentials: "omit", referrerPolicy: "no-referrer" });
		if (!response.ok) throw new Error(`Artifact bytes: HTTP ${response.status}`);
		if (!current()) return;
		if (entry.endsWith(".md")) {
			const text = await response.text();
			if (!current()) return;
			const body = document.createElement("div");
			body.className = "prose";
			body.dataset.testid = "artifact-markdown";
			content.append(body);
			await ensureVendor();
			await renderMessage(body, text, { ...window.MailRenderers, domain: state.domain, fetchFile, cache: fileUrls, ensureMermaid });
		} else {
			const bytes = await response.arrayBuffer();
			if (!current()) return;
			artifactObjectUrl = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
			const link = document.createElement("a");
			link.className = "artifact-download";
			link.dataset.testid = "artifact-download";
			link.href = artifactObjectUrl;
			link.download = version.entry.split("/").at(-1);
			link.textContent = `Download ${version.entry}`;
			content.append(link);
		}
	}
}

$("artifact-new-version").addEventListener("click", () => {
	const button = $("artifact-new-version");
	if (artifactCurrent && button.dataset.seq) location.hash = artifactHref(artifactCurrent.threadId, artifactCurrent.id, button.dataset.seq);
});

function offerArtifactVersion(seq) {
	const button = $("artifact-new-version");
	button.dataset.seq = String(seq);
	button.textContent = `New version v${seq}`;
	button.hidden = false;
}

// A publish never redraws the pane or the draft. Append messages without changing draft.after.
async function artifactPublished(event) {
	if (state.section !== "threads" || !state.thread || event.threadId !== state.thread.id) return;
	const threadId = state.thread.id;
	const seq = Number(event.seq);
	if (event.artifactId && Number.isSafeInteger(seq) && seq > 0) {
		const newest = Math.max(seq, artifactPublishedSeq.get(event.artifactId) ?? 0);
		artifactPublishedSeq.set(event.artifactId, newest);
		if (artifactCurrent?.id === event.artifactId && newest > artifactCurrent.seq) offerArtifactVersion(newest);
	}
	void loadArtifactList(threadId).catch(fail);
	if (typeof event.messageId !== "string") return;
	const { message } = await api("GET", `/messages/${encodeURIComponent(event.messageId)}`);
	if (state.section !== "threads" || state.thread?.id !== threadId || message?.threadId !== threadId) return;
	const container = $("thread-messages");
	if (!container.querySelector(`[data-testid="message"][data-id="${CSS.escape(message.id)}"]`)) {
		const node = await messageElement(message, { focus: false });
		if (state.section === "threads" && state.thread?.id === threadId && !container.querySelector(`[data-testid="message"][data-id="${CSS.escape(message.id)}"]`)) {
			const next = [...container.querySelectorAll('[data-testid="message"]')].find((item) => Number(item.dataset.seq) > message.seq);
			const top = next?.getBoundingClientRect().top;
			container.querySelector(":scope > .hint")?.remove();
			syncMessageIdentities(node);
			container.insertBefore(node, next ?? container.querySelector(':scope > [data-history="later"]'));
			if (next && top < 0) window.scrollBy(0, next.getBoundingClientRect().top - top);
		}
	}
}

// Invalidate in-flight rendering on navigation or a newer refresh of the same thread.
let threadRenderVersion = 0;
const THREAD_PAGE_SIZE = 30;

async function openThread(id, focusMessage) {
	const version = ++threadRenderVersion;
	const current = () => version === threadRenderVersion && state.section === "threads";
	const { body, events } = await readThreadWithRoles(id);
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

	// UX-17: the subject copies the thread's own URL, the way a session's title does; a long one
	// is clamped to two lines in the pinned header, so the whole subject stays on the heading's title.
	renderThreadSubject(thread?.subject ?? "(no subject)");
	const threadUrl = $("thread-url");
	threadUrl.replaceChildren(copyLink(thread?.url ?? `pana://${state.domain}/threads/${id}`, "thread"));
	// REF-08 and UX-06: participants are colored links to their own views.
	renderThreadParticipants(thread);
	// Apply the snapshot and any events received while it was in flight.
	syncRosterActivity(thread, events);
	// REF-07: one toggle, labelled for the thread's state for this reader.
	const archiveButton = $("thread-archive");
	archiveButton.hidden = !state.threadCanArchive;
	archiveButton.dataset.archived = String(Boolean(body.archived));
	archiveButton.textContent = body.archived ? "Unarchive" : "Archive";
	archiveButton.dataset.testid = body.archived ? "thread-unarchive" : "thread-archive";
	void loadArtifactList(id).catch(fail);
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
					syncMessageIdentities(fragment);
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
	syncMessageIdentities(initial);
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
		// UX-05: the pinned header (MOB-07) must not cover the message the link scrolled to.
		syncStickyHeights();
		target.scrollIntoView({ block: focusMessage ? "center" : "start" });
	}
	if (focusMessage) await api("POST", `/messages/${focusMessage}/read`).catch(() => {});
	// REF-06: reading the thread clears its unread count.
	await refreshUnread().catch(() => {});
}

/**
 * WEB-10: a choice is picked exactly when its reply block is in the draft. Deleting the block
 * unpicks the button, so the draft below is the only place a pick is stored.
 */
function draftHas(reply) {
	return draftHasChoice($("reply-body").value, reply);
}

/**
 * WEB-10: add a clicked option's reply to the draft, or take it out again when it is already
 * there. The composer's own `input` listener saves the draft from here, so a pick survives a
 * reload the way typed text does. Nothing is sent: the draft is the reader's to revise.
 */
function pickChoice(option) {
	if (!state.draft) return;
	const box = $("reply-body");
	const picked = draftHasChoice(box.value, choiceText(option));
	const peers = [...document.querySelectorAll("button[data-choice][data-question]")].map((button) => ({
		question: button.dataset.question,
		label: button.textContent,
		reply: button.dataset.answer,
	}));
	box.value = toggleChoice(box.value, option, peers);
	status(`${picked ? "Removed" : "Added"} “${option.label}” ${picked ? "from" : "to"} your reply.`);
	// Save the draft the way a keystroke does, then let the buttons follow it.
	box.dispatchEvent(new Event("input", { bubbles: true }));
	// Every message on screen, including the ones a stale reply lists above the box.
	syncChoices(document, draftHas);
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
	const { body, events } = await readThreadWithRoles(draft.threadId);
	if (state.draft !== draft || state.thread?.id !== draft.threadId || state.section !== "threads") return;
	const thread = body.thread;
	const messages = body.messages ?? [];
	const newerIds = new Set((Array.isArray(error?.body?.error?.newer) ? error.body.error.newer : []).map(String));
	const headIndex = messages.findIndex((message) => message.id === draft.after);
	const newer = headIndex === -1 ? messages.filter((message) => newerIds.has(message.id)) : messages.slice(headIndex + 1);
	// New participants must be known before rendering their stale-warning messages.
	state.thread = thread;
	renderThreadSubject(thread?.subject ?? "(no subject)");
	renderThreadParticipants(thread);
	syncMessageIdentities($("thread-messages"));
	syncRosterActivity(thread, events);
	const container = $("stale-new");
	container.replaceChildren();
	for (const message of newer) {
		const node = await messageElement(message, {});
		syncMessageIdentities(node);
		container.append(node);
	}
	$("stale").hidden = false;
	if (!$("reply-body").value) $("reply-body").value = draft.body;
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
		const swatch = span("", "session-link");
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
	// MOB-05: each fact is its own node, so a phone can wrap the run of them without splitting a
	// model ID apart. Only what a reader needs while reading is pinned: the state and these facts.
	// The path and the URL scroll with the transcript (MOB-08).
	const facts = document.createElement("span");
	facts.className = "session-facts";
	facts.dataset.testid = "session-facts";
	for (const [name, part] of [
		["model", state.session.model],
		["parent", state.session.parent ? refLink(state.session.parentUrl ?? state.session.parent, "session", `parent ${state.session.parent}`) : undefined],
		["cost", cost(state.session.costUsd)],
		["scratch", scratchSize(state.session.scratch)],
		["wakes", `scheduled wakes: ${state.session.wakes?.length ?? 0}`],
	]) {
		if (part === undefined || part === null || part === "") continue;
		const fact = document.createElement("span");
		fact.className = `fact fact-${name}`;
		// The row can ellipsize a model on a narrow screen; the title keeps it whole.
		if (typeof part === "string") fact.title = part;
		if (part instanceof Node) fact.append(part);
		else fact.textContent = String(part);
		facts.append(fact);
	}
	meta.append(facts);
	// Like a thread's header, the session's view shows its working directory and canonical pana://
	// URL; both are reference, not reading matter, so they sit below the pinned header.
	const details = $("session-details");
	details.replaceChildren();
	if (state.session.cwd) {
		const cwd = document.createElement("span");
		cwd.className = "session-cwd";
		cwd.dataset.testid = "session-cwd";
		cwd.title = state.session.cwd;
		cwd.textContent = state.session.cwd;
		details.append(cwd);
	}
	if (state.session.url) {
		const url = document.createElement("span");
		url.className = "hint session-url";
		url.dataset.testid = "session-url";
		url.append(copyLink(state.session.url, "session"));
		details.append(url);
	}
	details.hidden = details.childElementCount === 0;
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
	syncStickyHeights();
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
		row.append(timeEl(wake.nextAt, { label: "next wake" }));
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
// metrics, the newest report, links, the roster, money and runs, the pending wakes, and the
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
		title.append(badge(row.phase, "phase-badge"), " ");
		// OBJ-03: the derived state, which is a function of other rows and never stored.
		if (row.state) title.append(badge(row.state, "state-badge"), " ");
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
	renderObjectiveLimitsForm();
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
	renderObjectiveLimitsForm();
	renderObjectiveMetrics();
	renderObjectiveCharter();
	renderObjectiveReport();
	renderObjectiveLinks();
	renderObjectiveMembers();
	renderObjectiveWakes();
	renderObjectiveEscalation();
}

function renderObjectiveHead() {
	const view = objectiveDetail.view;
	$("objective-goal").textContent = view.goal;
	const meta = $("objective-meta");
	meta.replaceChildren(badge(view.phase, "phase-badge"));
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
	renderObjectiveActions();
	$("objective-charter-rev").textContent = `revision ${view.charterRev}`;
}

/**
 * OBJ-39: every action the view offers, and the phases that permit it. An action the phase forbids
 * is shown disabled with the reason rather than hidden, because "you cannot do that here" and
 * "there is no such thing" are different things to learn from a screen that reports state.
 */
const OBJECTIVE_ACTION_GATES = {
	launch: { phases: ["drafting"], label: "Launch", reason: "only a draft is launched" },
	stop: { phases: ["active"], label: "Stop", reason: "only an active objective is stopped" },
	resume: { phases: ["stopped"], label: "Resume", reason: "only a stopped objective is resumed" },
	// OBJ-07: a stopped objective can be finished too, once its metrics are at target.
	done: { phases: ["active", "stopped"], label: "Done", reason: "only an active or stopped objective is finished" },
	// OBJ-07: a draft is archived where it stands — nothing on it runs, so nothing is stopped — and
	// the reason names that phase too, so a reader of the note sees why an active objective is barred.
	archive: { phases: ["drafting", "stopped", "done"], label: "Archive", reason: "only a drafting, stopped, or done objective is archived" },
	regenerate: { phases: ["active"], label: "Regenerate lead", reason: "only an active objective has a lead to replace" },
};

function renderObjectiveActions() {
	const view = objectiveDetail.view;
	const blocked = [];
	for (const [action, gate] of Object.entries(OBJECTIVE_ACTION_GATES)) {
		const button = $(`objective-${action}`);
		if (!button) continue;
		const allowed = gate.phases.includes(view.phase) && (action !== "regenerate" || Boolean(view.lead));
		const reason = action === "regenerate" && !view.lead ? "this objective has no lead yet" : gate.reason;
		button.disabled = !allowed;
		button.dataset.allowed = String(allowed);
		button.title = allowed ? "" : `${gate.label} is unavailable: ${reason}.`;
		if (!allowed) blocked.push(`${gate.label} is unavailable: ${reason}.`);
	}
	const note = $("objective-actions-note");
	note.hidden = blocked.length === 0;
	note.textContent = blocked.join(" ");
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
 * OBJ-41: the limits form arrives filled with the objective's own values, and an empty field means
 * the domain's default — which the placeholder names, so clearing a budget shows what will apply.
 */
function renderObjectiveLimitsForm() {
	const form = $("objective-limits");
	const view = objectiveDetail.view;
	for (const { field } of LIMIT_FIELDS) {
		const input = form.querySelector(`[data-limit="${field}"]`);
		if (!input) continue;
		const own = view.limits?.[field];
		input.value = own === null || own === undefined ? "" : String(own);
		const effective = view.effectiveLimits?.[field];
		input.placeholder = effective && effective.source !== "none" ? `default ${effective.value}` : "no limit";
	}
	form.querySelector("[data-testid=limits-save]").disabled = false;
}

/** OBJ-41: save the limits the reader changed; a blank field clears one back to the domain's. */
async function saveObjectiveLimits(event) {
	event.preventDefault();
	if (!objectiveDetail) return;
	const form = event.currentTarget;
	const values = {};
	for (const { field } of LIMIT_FIELDS) values[field] = form.querySelector(`[data-limit="${field}"]`)?.value ?? "";
	const { body, invalid } = limitsBody(values, objectiveDetail.view.limits);
	if (invalid.length > 0) {
		return status(`${invalid.map((field) => LIMIT_FIELDS.find((entry) => entry.field === field)?.label ?? field).join(", ")} must be a positive number, or blank for the domain's default.`, true);
	}
	if (Object.keys(body).length === 0) return status("No limit changed.");
	const save = form.querySelector("[data-testid=limits-save]");
	save.disabled = true;
	try {
		const saved = await api("POST", `/objectives/${encodeURIComponent(objectiveDetail.view.id)}/limits`, body);
		objectiveDetail.view = objectiveView(saved.objective);
		status(`Limits saved: ${saved.changes?.length ?? Object.keys(body).length} changed.`);
		// The holding condition and the meters are functions of the limits, so both are redrawn.
		renderObjectiveHead();
		renderObjectiveMeters();
		renderObjectiveLimitsForm();
		renderObjectiveMembers();
		renderObjectiveWakes();
		renderObjectiveEscalation();
	} catch (error) {
		fail(error);
	} finally {
		save.disabled = false;
	}
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
function renderObjectiveLinks() {
	const list = $("objective-links");
	list.replaceChildren();
	const links = objectiveDetail.view.links;
	if (links.length === 0) return empty(list, "No links. A link is a file linked to the objective, uploaded through the same store a message's attachment uses.");
	for (const link of links) {
		const title = document.createDocumentFragment();
		title.append(fileLink(link.url, link.name));
		const meta = [fileSize(link.size), link.mediaType ?? undefined].filter(Boolean);
		list.append(item(title, meta, () => undefined, { testid: "objective-link", id: link.id }));
	}
}

/** FIL-06: a file's bytes arrive with the bearer token, which an anchor cannot send. */
function fileLink(url, label) {
	const href = appHref(url, state.domain);
	const anchor = document.createElement("a");
	anchor.href = href ?? "#";
	anchor.textContent = label;
	anchor.dataset.testid = "objective-link-download";
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
		// UX-09: the same state badge a session row draws, so its color is here from the first paint
		// and a state event only rewrites it.
		title.append(badge(state, "state-badge"));
		const person = span("", "session-link");
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
		row.append(timeEl(wake.at, { label: "next wake" }));
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
	// OBJ-07: resuming starts its work again, which spends again, so it asks first too.
	resume: {
		question: "Resume this objective? Its work starts again, and spends against its limits again.",
		label: "Yes, resume",
		run: (id) => api("POST", `/objectives/${encodeURIComponent(id)}/resume`, {}),
	},
	// OBJ-07: the confirmation is the reserved-for-human step; the check behind it is the server's.
	done: {
		question:
			"Finish this objective? Every metric with a target has to be at that target, and this confirms the lead's claim rather than checking it for you. Its thread and members stay readable.",
		label: "Yes, finish it",
		run: (id) => api("POST", `/objectives/${encodeURIComponent(id)}/done`, {}),
	},
	archive: {
		// OBJ-07: a draft has no lead, no members and no wakes, so the launch-shaped warning would be
		// a lie about it; it gets the sentence its own state deserves.
		question: (view) =>
			view.phase === "drafting"
				? "Archive this draft? It was never launched, so it has no lead, no members, and nothing to stop or sweep; it leaves the list and nothing else changes. This is not undone from the app."
				: "Archive this objective? Its member sessions are archived with it, so their scratch is swept and their threads become read-only. This is not undone from the app.",
		label: "Yes, archive it",
		run: (id) => api("POST", `/objectives/${encodeURIComponent(id)}/archive`, {}),
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
	$("objective-confirm-text").textContent = typeof spec.question === "function" ? spec.question(objectiveDetail.view) : spec.question;
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
		const said = {
			launch: "Objective launched.",
			stop: "Objective stopped.",
			resume: "Objective resumed.",
			done: "Objective finished. Its thread stays readable.",
			archive: "Objective archived.",
			regenerate: "The lead is replaced.",
		};
		status(said[action] ?? "Done.");
		await openObjective(id);
	} catch (error) {
		// OBJ-07: finishing needs every target met. Name the metrics short of theirs rather than
		// leaving the reader with "conflict" and no idea which number to look at.
		if (error?.status === 409 && error?.body?.error?.code === "metric_behind") {
			const behind = Array.isArray(error.body.error.metrics) ? error.body.error.metrics : [];
			status(`Not at target yet: ${behind.map((metric) => `${metric.name} at ${metric.value ?? "no reading"} of ${metric.target}`).join(", ")}.`, true);
			return;
		}
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
// The Markdown renderer is the vendored bundle in web/vendor.js (see web/README.md). Loading it
// from JS removes any doubt about whether a deferred classic script has run before this module.
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
			// A bundle this browser will not parse reports only as an element error event, which carries
			// no message. The window listener catches the script error beside it, so the reason reaches the
			// note on screen instead of dying in a console a phone reader cannot open.
			const heard = [];
			const listen = (event) => {
				if (heard.length === 0 && typeof event?.message === "string" && event.message) heard.push(event.message);
			};
			const stop = () => window.removeEventListener("error", listen, true);
			const failed = (what) => new Error(heard.length > 0 ? `${what}: ${heard[0]}` : what);
			window.addEventListener("error", listen, true);
			script.src = "/mermaid-vendor.js";
			script.onload = () => {
				stop();
				const lib = window.MailMermaid?.mermaid;
				if (lib) resolve(lib);
				else reject(failed("the bundle exposed no mermaid"));
			};
			script.onerror = () => {
				stop();
				reject(failed("the bundle did not load"));
			};
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
		case "bookmarks":
			return visible("#bookmarks-list [data-selectable]");
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

/** Artifact names live per thread. Bound concurrent reads while searching all of them. */
async function searchArtifactNames(query, search) {
	const stats = await api("GET", "/stats/artifacts");
	const matches = [];
	const threads = Array.isArray(stats.threads) ? stats.threads : [];
	for (let offset = 0; offset < threads.length; offset += 8) {
		if (!palette.open || palette.stage !== "search" || search !== palette.search) return [];
		const pages = await Promise.all(threads.slice(offset, offset + 8).map((thread) => api("GET", `/threads/${encodeURIComponent(thread.threadId)}/artifacts`)));
		for (const page of pages) for (const artifact of page.artifacts ?? []) {
			if (fuzzyScore(artifact.name, query) !== null) matches.push(artifact);
		}
	}
	return matches;
}

/** The search stage asks the stores at once and draws whatever stays newest. */
async function paletteSearch(query, search) {
	try {
		const [threads, sessions, memory, artifacts] = await Promise.all([
			api("GET", pagePath(`/threads?query=${encodeURIComponent(query)}`, undefined, HITS_PER_STORE)),
			api("GET", pagePath(`/sessions?query=${encodeURIComponent(query)}`, undefined, HITS_PER_STORE)),
			api("GET", `/memory/search?query=${encodeURIComponent(query)}&limit=${HITS_PER_STORE}`),
			searchArtifactNames(query, search),
		]);
		if (!palette.open || palette.stage !== "search" || search !== palette.search) return;
		renderPaletteHits(paletteHits({ threads, sessions, memory, artifacts: { artifacts } }, query), query);
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
	if (action === "back") {
		// A phone's folded menu is in front of the page, so it closes before the page does.
		if (phoneWidth.matches && document.querySelector(".header-menu[open]")) return closeHeaderMenus();
		return goBack();
	}
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
		case "bookmark": {
			const message = selected();
			if (message?.dataset.testid === "message" && selectables().includes(message)) {
				message.querySelector("[data-testid=message-bookmark]")?.click();
			}
			return;
		}
	}
}

function onKeydown(event) {
	if (event.defaultPrevented || event.isComposing) return;
	// UX-21: Escape puts an open reading away, rather than leaving the page behind it.
	if (event.key === "Escape" && openTime) {
		event.preventDefault();
		openTime.node.focus();
		closeTime();
		return;
	}
	const target = event.target instanceof Element ? event.target : document.activeElement;
	const inInput = isTextInput(target);
	const form = target?.closest?.("form") ?? null;
	// A focused button, link, summary, or control that declares itself a button keeps its own Enter.
	if (!inInput && event.key === "Enter" && !isSubmitChord(event, APPLE) && target?.closest?.("button, a, summary, [role='button']")) return;
	const action = keys.press(event, { inInput, inForm: Boolean(form), apple: APPLE });
	if (!action) return;
	event.preventDefault();
	if (action === "bookmark" && event.repeat) return;
	if (action !== "pending") runKey(action, { target, form });
}

// ---- Router ---------------------------------------------------------------------------------

function showSection(section) {
	threadRenderVersion++;
	state.section = section;
	// SET-05: a typed secret lives only on the Settings page. Leaving it drops the draft, so a
	// value is never sitting in the DOM of a page Josh is reading or showing someone.
	if (section !== "settings" && $("settings-secret-value").value) {
		clearSecretDraft();
		secretError();
	}
	// Compose has no nav item of its own: it is the Threads page's New button. Settings sits in the
	// top bar's tools rather than in the section menu, so this marks both places.
	const navSection = section === "compose" ? "threads" : section;
	let current;
	for (const link of document.querySelectorAll(".topbar a[data-section]")) {
		if (link.dataset.section === navSection) {
			link.setAttribute("aria-current", "page");
			current = link;
		} else link.removeAttribute("aria-current");
	}
	scrollSectionIntoView(current);
	for (const view of document.querySelectorAll(".view")) {
		view.hidden = view.id !== `view-${section}`;
	}
}

/**
 * MOB-04: a phone narrower than the section labels scrolls the menu rather than wrapping it, so the
 * section it is on has to be the one in sight. Settings sits outside the menu and needs nothing.
 */
function scrollSectionIntoView(link) {
	const nav = document.getElementById("nav");
	if (!nav || !link || link.parentElement !== nav || nav.scrollWidth <= nav.clientWidth) return;
	const item = link.getBoundingClientRect();
	const bar = nav.getBoundingClientRect();
	if (item.left < bar.left) nav.scrollLeft -= bar.left - item.left;
	else if (item.right > bar.right) nav.scrollLeft += item.right - bar.right;
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

/** Draw the current hash, and measure how long the draw took to reach a painted frame (OBS-03). */
async function route() {
	const started = telemetry?.now();
	const name = viewName(location.hash);
	try {
		await drawRoute();
	} finally {
		if (started !== undefined) {
			const elapsed = () => telemetry?.view(name, telemetry.now() - started);
			if (typeof requestAnimationFrame === "function") requestAnimationFrame(elapsed);
			else elapsed();
		}
	}
}

async function drawRoute() {
	const canonicalArtifact = /^#\/artifacts\/([^/]+)(?:\/v\/([1-9]\d*))?$/.exec(location.hash);
	if (canonicalArtifact) {
		const requestedHash = location.hash;
		try {
			const id = decodeURIComponent(canonicalArtifact[1]);
			const seq = canonicalArtifact[2];
			const data = await api("GET", `/artifacts/${encodeURIComponent(id)}${seq ? `?seq=${seq}` : ""}`);
			if (location.hash === requestedHash) location.replace(artifactHref(data.artifact.threadId, id, seq));
		} catch (error) { fail(error); }
		return;
	}
	const { section, id, rest, query } = routeFromHash(location.hash);
	const artifactId = section === "threads" && rest[0] === "a" && rest[1] && (rest.length === 2 || (rest.length === 4 && rest[2] === "v" && /^[1-9]\d*$/.test(rest[3]))) ? rest[1] : undefined;
	const artifactSeq = artifactId && rest.length === 4 ? rest[3] : undefined;
	const sameThread = section === "threads" && id && state.section === "threads" && state.thread?.id === id && !$("thread").hidden;
	if (sameThread && (artifactId || artifactCurrent)) {
		try {
			if (artifactId) {
				const switching = !artifactCurrent && matchMedia("(max-width: 59.999rem)").matches;
				if (switching) threadScrollBeforeArtifact = window.scrollY;
				await openArtifactPane(id, artifactId, artifactSeq);
				if (switching && artifactCurrent) window.scrollTo(0, 0);
			} else {
				closeArtifactPane();
				if (matchMedia("(max-width: 59.999rem)").matches) window.scrollTo(0, threadScrollBeforeArtifact);
			}
		} catch (error) { fail(error); }
		return;
	}
	closeArtifactPane();
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
			case "bookmarks":
				await loadBookmarks();
				break;
			case "compose":
				$("compose-to").focus();
				break;
			case "threads":
				$("threads-browse").hidden = false;
				$("threads-list").hidden = false;
				$("thread").hidden = true;
				if (query.get("query")) $("threads-query").value = query.get("query");
				if (id) {
					await openThread(id, query.get("message"));
					if (artifactId) { threadScrollBeforeArtifact = window.scrollY; await openArtifactPane(id, artifactId, artifactSeq); if (matchMedia("(max-width: 59.999rem)").matches) window.scrollTo(0, 0); }
				} else await searchThreads();
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
			case "settings":
				await loadSettings();
				await loadSecrets();
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

function changeSettingsColor() {
	const input = $("settings-user-color");
	try {
		const config = configWithUserColor(configFromText($("settings-config").value), input.value.trim());
		input.setCustomValidity("");
		$("settings-config").value = JSON.stringify(config, null, 2) + "\n";
		$("settings-config-error").hidden = true;
		updateSettingsControls();
	} catch (error) {
		input.setCustomValidity(error.message);
		$("settings-save").disabled = true;
		settingsNotice(error.message, true);
	}
}
$("settings-user-color-picker").addEventListener("input", () => {
	const hex = $("settings-user-color");
	hex.value = userColorFromPicker($("settings-user-color-picker").value, configUserColor(configFromText($("settings-config").value)));
	changeSettingsColor();
});
$("settings-user-color").addEventListener("input", changeSettingsColor);
$("settings-user-color").addEventListener("change", changeSettingsColor);
$("settings-form").addEventListener("submit", (event) => void saveSettings(event));
$("settings-config").addEventListener("input", () => {
	$("settings-config-error").hidden = true;
	updateSettingsControls();
});
$("settings-refresh").addEventListener("click", () => {
	void loadSettings();
	void loadSecrets();
});
$("settings-secret-form").addEventListener("submit", (event) => void saveSecret(event));
// Nothing in this page shows a value. Clear is the only control over the field besides typing.
$("settings-secret-clear").addEventListener("click", () => {
	clearSecretDraft();
	secretError();
	$("settings-secret-value").focus();
});
$("settings-secret-name").addEventListener("input", () => secretError());
$("settings-secret-value").addEventListener("input", () => secretError());
$("settings-secret-value").addEventListener("paste", refuseMultiLinePaste);
$("settings-reload-config").addEventListener("click", () => {
	const changed = settingsSavedText !== undefined && $("settings-config").value !== settingsSavedText;
	if (changed && !window.confirm("Discard unsaved configuration edits and reload the current file?")) return;
	$("settings-config-error").hidden = true;
	void loadSettings(true);
});
$("settings-restart").addEventListener("click", () => {
	$("settings-restart-confirm").hidden = false;
	$("settings-restart-no").focus();
});
$("settings-restart-no").addEventListener("click", () => {
	$("settings-restart-confirm").hidden = true;
	$("settings-restart").focus();
});
$("settings-restart-yes").addEventListener("click", () => void restartSettings());
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
	// WEB-10: an option is picked while its reply is a line of the draft.
	syncChoices(document, draftHas);
});
$("confirm").addEventListener("submit", (event) => void confirmAction(event));
$("confirm-no").addEventListener("click", cancelAction);
$("thread-subject-regenerate").addEventListener("click", () => {
	closeHeaderMenus();
	void regenerateThreadSubject();
});
$("thread-archive").addEventListener("click", () => {
	const thread = state.thread;
	if (!thread) return;
	closeHeaderMenus();
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
for (const action of ["launch", "stop", "resume", "done", "archive", "regenerate"]) {
	$(`objective-${action}`).addEventListener("click", () => askObjectiveAction(action));
}
$("objective-limits").addEventListener("submit", (event) => void saveObjectiveLimits(event));
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
	const row = event.target?.closest?.("[data-selectable], #thread-messages [data-testid=message]");
	if (row && (row.hasAttribute("data-selectable") || selectables().includes(row))) select(row, { scroll: false });
});
document.addEventListener("click", (event) => {
	// A click that is not on a message's actions closes whichever one is open.
	if (!event.target?.closest?.(".message-menu")) closeMessageMenus();
	// A time's reading closes with a click anywhere else, or on another time.
	if (!event.target?.closest?.(".when")) closeTime();
	// A view header's folded controls work the same way: open one, click anywhere else, it closes.
	if (!event.target?.closest?.(".header-menu")) closeHeaderMenus();
	const action = event.target?.closest?.("[data-action]")?.dataset.action;
	if (action) closeHeaderMenus();
	if (action === "stop" || action === "compact") void sessionAction(action);
	if (action === "archive-session") askArchiveSession();
	if (action === "reload") {
		if (state.session) void openSession(state.session.id);
		else void loadSessionList();
	}
	if (action === "create-worktree") void createWorktree();
});
window.addEventListener("hashchange", () => {
	// A launch URL opened in a window that already runs the app is a fragment change, not a load, so
	// the block at the top of this module never runs again. Adopt the token the same way there: leave
	// it in the URL and a rotated token is never taken, every request keeps the old one, and the
	// route measures a view named after the token.
	const launch = launchFragment(location.hash);
	if (!launch) {
		void route();
		return;
	}
	history.replaceState(null, "", "/#/inbox");
	const changed = launch !== token;
	token = launch;
	localStorage.setItem(TOKEN_KEY, launch);
	if (changed) void boot();
	else void route();
});
window.addEventListener("online", () => void startEvents());
// Coming back into view, by any of the ways a browser says so (WEB-11, PSH-05).
window.addEventListener("focus", () => void resumeApp().catch(() => {}));
window.addEventListener("pageshow", (event) => {
	if (event.persisted) void resumeApp().catch(() => {});
});
window.addEventListener("pagehide", () => pauseEvents());
document.addEventListener("visibilitychange", () => {
	if (document.visibilityState === "hidden") pauseEvents();
	else void resumeApp().catch(() => {});
});

// Keep sticky content below the actual header when mobile navigation wraps or fonts load.
const topbar = document.querySelector(".topbar");
const measureTopbar = () => document.documentElement.style.setProperty("--topbar-h", `${topbar.getBoundingClientRect().height}px`);
measureTopbar();
new ResizeObserver(measureTopbar).observe(topbar);

// MOB-07: a view's pinned header covers what a link scrolls to, so the view carries its height as
// --sticky-h for `.message` and `.entry` scroll margins. It changes when a subject or the facts
// wrap, so measure it rather than guessing.
const stickyViewSizes = [...document.querySelectorAll(".view-sticky")].map((sticky) => {
	const view = sticky.parentElement;
	const measure = () => {
		if (!view || view.hidden) return;
		view.style.setProperty("--sticky-h", `${Math.round(sticky.getBoundingClientRect().height)}px`);
	};
	new ResizeObserver(measure).observe(sticky);
	return measure;
});
function syncStickyHeights() {
	for (const measure of stickyViewSizes) measure();
}

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
	/** The recorder from `perf.js` (OBS-03), so a test can flush without waiting for the timer. */
	get telemetry() {
		return telemetry;
	},
	enablePush,
	showPushButton,
};

void boot();
