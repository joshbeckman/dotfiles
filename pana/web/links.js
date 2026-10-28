// Pure helpers shared by the PWA, its service worker, and tests. No DOM and no globals are
// touched at module load, so Node can import this file directly (WEB-02, WEB-05, WEB-07).

/** The six app sections (WEB-03), in navigation order. */
export const SECTIONS = [
	{ id: "inbox", title: "Inbox", route: "#/inbox" },
	{ id: "compose", title: "Compose", route: "#/compose" },
	{ id: "threads", title: "Threads", route: "#/threads" },
	{ id: "sessions", title: "Sessions", route: "#/sessions" },
	{ id: "memory", title: "Memory", route: "#/memory" },
	{ id: "schedules", title: "Schedules", route: "#/schedules" },
];

export const TOKEN_KEY = "pana-token";

/**
 * Accept the whole launch URL or a bare token, as agent-mail-web does. The fragment is the only
 * part of a launch URL that is not guessable.
 */
export function tokenFromInput(raw) {
	const text = String(raw ?? "").trim();
	if (!text) return "";
	const hash = text.indexOf("#");
	if (hash >= 0) return text.slice(hash + 1).trim();
	return /^[A-Za-z0-9._~-]{20,}$/.test(text) ? text : "";
}

/**
 * Map a `pana://` link to an app route or a file URL (WEB-05). Relative, http(s), and mailto
 * links pass through unchanged. A foreign domain, or a kind the app does not show, returns
 * undefined so the caller can drop the href.
 */
export function appHref(href, domain) {
	if (typeof href !== "string" || href.length === 0) return undefined;
	if (!href.startsWith("pana://")) return href;
	let url;
	try {
		url = new URL(href);
	} catch {
		return undefined;
	}
	if (url.host.toLowerCase() !== String(domain).toLowerCase()) return undefined;
	// URL has already percent-encoded the path, so decode before building the app URL, which
	// encodes each segment once.
	const parts = url.pathname
		.split("/")
		.filter((part) => part.length > 0)
		.map((part) => {
			try {
				return decodeURIComponent(part);
			} catch {
				return part;
			}
		});
	if (parts.length === 0) return "/";
	const [kind, id, ...rest] = parts;
	switch (kind) {
		case "threads": {
			if (!id) return "#/threads";
			const message = url.searchParams.get("message");
			return `#/threads/${encodeURIComponent(id)}${message ? `?message=${encodeURIComponent(message)}` : ""}`;
		}
		case "sessions":
			return id ? `#/sessions/${encodeURIComponent(id)}` : "#/sessions";
		case "files":
			return id ? `/files/${encodeURIComponent(id)}/${rest.map(encodeURIComponent).join("/")}` : undefined;
		// REF-08: a user link opens the inbox, which is where the user reads mail.
		case "users":
			return "#/inbox";
		case "memory":
			return id === "files" && rest.length > 0 ? memoryFileHref(rest.join("/")) : undefined;
		case "schedules":
			return id ? `#/schedules?focus=${encodeURIComponent(id)}` : "#/schedules";
		default:
			return undefined;
	}
}

/**
 * The app route for a bare ID of a known kind (REF-08). A message needs its thread, so it is
 * not accepted here; a `pana://` message URL goes through `appHref`.
 */
export function idHref(id, kind) {
	const value = String(id ?? "");
	if (!value) return undefined;
	switch (kind) {
		case "session":
			return `#/sessions/${encodeURIComponent(value)}`;
		case "thread":
			return `#/threads/${encodeURIComponent(value)}`;
		case "user":
			return "#/inbox";
		case "schedule":
			return `#/schedules?focus=${encodeURIComponent(value)}`;
		default:
			return undefined;
	}
}

/** A `pana://` URL inside free text, without the punctuation that usually follows one. */
const PANA_IN_TEXT = /pana:\/\/[^\s<>"'`)\]]+/g;

/**
 * Split text into plain and linked segments, so a `pana://` URL inside a message body, a
 * transcript, or a tool result is a link to its view (REF-08). A URL on a foreign domain stays
 * text, because the app has no route for it.
 */
export function panaLinkSegments(text, domain) {
	const source = String(text ?? "");
	const segments = [];
	let last = 0;
	for (const match of source.matchAll(PANA_IN_TEXT)) {
		let url = match[0];
		// Trailing sentence punctuation belongs to the prose, not to the URL.
		const tail = /[.,;:!?]+$/.exec(url);
		if (tail) url = url.slice(0, -tail[0].length);
		const href = appHref(url, domain);
		const at = match.index ?? 0;
		if (at > last) segments.push({ text: source.slice(last, at) });
		if (!href) {
			segments.push({ text: url });
		} else {
			segments.push({ text: url, href });
		}
		if (tail) segments.push({ text: tail[0] });
		last = at + match[0].length;
	}
	if (last < source.length) segments.push({ text: source.slice(last) });
	return segments;
}

/** Parse a location hash into a section, an id, the remaining path segments, and query parameters. */
export function routeFromHash(hash) {
	const text = String(hash ?? "").replace(/^#/, "");
	const queryAt = text.indexOf("?");
	const path = queryAt === -1 ? text : text.slice(0, queryAt);
	const query = new URLSearchParams(queryAt === -1 ? "" : text.slice(queryAt + 1));
	const parts = path.split("/").filter((part) => part.length > 0);
	const section = parts[0] && SECTIONS.some((s) => s.id === parts[0]) ? parts[0] : "inbox";
	return {
		section,
		id: parts[1] ? decodeURIComponent(parts[1]) : undefined,
		// A memory path is many segments; decode each so the caller can join them back with `/`.
		rest: parts.slice(2).map((part) => decodeURIComponent(part)),
		query,
	};
}

/** The route for one memory file's read view. */
export function memoryFileHref(path) {
	const parts = String(path ?? "")
		.split("/")
		.filter((part) => part.length > 0)
		.map((part) => encodeURIComponent(part));
	return parts.length > 0 ? `#/memory/files/${parts.join("/")}` : "#/memory";
}

/** The route for one memory file's full-view editor. */
export function memoryEditHref(path) {
	const parts = String(path ?? "")
		.split("/")
		.filter((part) => part.length > 0)
		.map((part) => encodeURIComponent(part));
	return parts.length > 0 ? `#/memory/edit/${parts.join("/")}` : "#/memory/new";
}

/** The route for one memory commit's `git show` view. */
export function memoryCommitHref(hash) {
	const value = String(hash ?? "");
	return value.length > 0 ? `#/memory/commits/${encodeURIComponent(value)}` : "#/memory";
}

/** The draft head is the thread's newest message when the reply editor opens (WEB-07). */
export function newDraft(thread) {
	const messages = Array.isArray(thread?.messages) ? thread.messages : [];
	const last = messages.length === 0 ? undefined : messages[messages.length - 1];
	return { threadId: thread?.id, after: last?.id, body: "" };
}

// ---- Attachment references ------------------------------------------------------------------
// FIL-02 and FIL-06: an uploaded file's Markdown reference. The server owns the upload
// (`POST /files`) and the CLI owns `--attach`; the composers write the same reference, so a
// message reads the same whether it was sent from a terminal or from the app.

/** True when a media type is an image, the case that earns `![]()` syntax. */
export function isImageType(mediaType) {
	return String(mediaType ?? "")
		.toLowerCase()
		.startsWith("image/");
}

/** One Markdown reference: image syntax for images, a link for everything else. */
export function referenceFor(file) {
	const label = String(file?.name ?? "").replace(/([\\[\]])/g, "\\$1");
	const url = String(file?.url ?? "");
	return isImageType(file?.mediaType) ? `![${label}](${url})` : `[${label}](${url})`;
}

/** Append one reference after a blank line, so it starts its own block instead of joining text. */
export function appendReference(body, reference) {
	const text = String(body ?? "").replace(/\s+$/, "");
	return text.length === 0 ? reference : `${text}\n\n${reference}`;
}

/** Append one reference per file, in order. */
export function withReferences(body, files) {
	return (files ?? []).reduce((text, file) => appendReference(text, referenceFor(file)), String(body ?? ""));
}

/** The URL a push notification click opens (PSH-03). */
export function notificationTarget(payload) {
	const data = payload ?? {};
	if (typeof data.threadId === "string" && data.threadId) return `/#/threads/${encodeURIComponent(data.threadId)}`;
	if (typeof data.url === "string" && data.url) return data.url.startsWith("/") ? data.url : `/${data.url}`;
	return "/";
}

// ---- Notification clicks (PSH-03, PSH-05) ---------------------------------------------------
// The service worker and the page both use these, because a browser picks how a click reaches the
// app: it may navigate the window, only focus it, or open it fresh at the manifest's `start_url`.
// So the click's route is also left in Cache Storage (`leaveClickTarget`), and whichever side runs
// next — the worker steering a window, or the page finding itself open — puts the app on the
// thread (`takeClickTarget`). The storage is a parameter, so this file still touches no global at
// load and Node tests hand it a Map.

/** The cache a click leaves its route in, and the key it uses. Both sides read the same names. */
export const PENDING_CACHE = "pana-notification";
export const PENDING_KEY = "/__pana-notification-target";

/** A route older than this is stale: the app was open, and the reader has moved on. */
export const PENDING_TTL_MS = 120_000;

/**
 * A delivery's tag names its thread, so a browser that drops the notification's `data` still says
 * which thread was clicked. `src/push/index.ts` writes the other half of this one format.
 */
export const TAG_PREFIX = "pana:thread:";

/** A thread's notification tag: one notification per thread, replaced by the next. */
export function notifyTag(threadId) {
	return threadId ? `${TAG_PREFIX}${threadId}` : "pana";
}

/** The app route a click opens: `data.threadId` first, then the tag, then `data.url`, else `/`. */
export function clickTarget(notification) {
	const data = (notification && typeof notification.data === "object" && notification.data) || {};
	const tag = String(notification?.tag ?? "");
	const threadId =
		typeof data.threadId === "string" && data.threadId
			? data.threadId
			: tag.startsWith(TAG_PREFIX)
				? tag.slice(TAG_PREFIX.length)
				: undefined;
	return notificationTarget({ threadId, url: typeof data.url === "string" ? data.url : undefined });
}

/**
 * Leave the clicked route where the page can find it. A cache that fails is not worth losing the
 * click over: the caller still steers the window if it can.
 */
export async function leaveClickTarget(storage, target, now = Date.now()) {
	if (!storage || typeof storage.open !== "function" || typeof target !== "string") return false;
	try {
		const cache = await storage.open(PENDING_CACHE);
		const body = JSON.stringify({ target, at: Number(now) });
		await cache.put(PENDING_KEY, new Response(body, { headers: { "content-type": "application/json" } }));
		return true;
	} catch {
		return false;
	}
}

/** Take the click's route, once, while it is fresh. */
export async function takeClickTarget(storage, now = Date.now()) {
	if (!storage || typeof storage.open !== "function") return undefined;
	try {
		const cache = await storage.open(PENDING_CACHE);
		const response = await cache.match(PENDING_KEY);
		if (!response) return undefined;
		await cache.delete(PENDING_KEY);
		const saved = await response.json();
		if (typeof saved?.target !== "string") return undefined;
		const age = Number(now) - Number(saved.at);
		return Number.isFinite(age) && age <= PENDING_TTL_MS ? saved.target : undefined;
	} catch {
		return undefined;
	}
}

/** WEB-08 copy: a revision changes what readers see; sessions keep what they already received. */
export const CONFIRM_EDIT =
	"Editing changes what readers see. Sessions keep what they already received, so they may still act on the old text.";
/** REF-02 copy: archiving a session is not undone from the app. */
export const CONFIRM_ARCHIVE_SESSION =
	"Archiving is permanent: the session, and every thread it belongs to, becomes read-only.";

export const CONFIRM_REDACT =
	"Redacting removes the body for everyone reading now. Sessions keep what they already received, so a session may still act on the old text.";
