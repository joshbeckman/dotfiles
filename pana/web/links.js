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
		case "users":
			return id ? `#/threads?query=${encodeURIComponent(id)}` : "#/threads";
		case "schedules":
			return id ? `#/schedules?focus=${encodeURIComponent(id)}` : "#/schedules";
		default:
			return undefined;
	}
}

/** Parse a location hash into a section, an id, and query parameters. */
export function routeFromHash(hash) {
	const text = String(hash ?? "").replace(/^#/, "");
	const queryAt = text.indexOf("?");
	const path = queryAt === -1 ? text : text.slice(0, queryAt);
	const query = new URLSearchParams(queryAt === -1 ? "" : text.slice(queryAt + 1));
	const parts = path.split("/").filter((part) => part.length > 0);
	const section = parts[0] && SECTIONS.some((s) => s.id === parts[0]) ? parts[0] : "inbox";
	return { section, id: parts[1] ? decodeURIComponent(parts[1]) : undefined, query };
}

/** The draft head is the thread's newest message when the reply editor opens (WEB-07). */
export function newDraft(thread) {
	const messages = Array.isArray(thread?.messages) ? thread.messages : [];
	const last = messages.length === 0 ? undefined : messages[messages.length - 1];
	return { threadId: thread?.id, after: last?.id, body: "" };
}

/** The URL a push notification click opens (PSH-03). */
export function notificationTarget(payload) {
	const data = payload ?? {};
	if (typeof data.threadId === "string" && data.threadId) return `/#/threads/${encodeURIComponent(data.threadId)}`;
	if (typeof data.url === "string" && data.url) return data.url.startsWith("/") ? data.url : `/${data.url}`;
	return "/";
}

/** WEB-08 copy: a revision changes what readers see; sessions keep what they already received. */
export const CONFIRM_EDIT =
	"Editing changes what readers see. Sessions keep what they already received, so they may still act on the old text.";
export const CONFIRM_REDACT =
	"Redacting removes the body for everyone reading now. Sessions keep what they already received, so a session may still act on the old text.";
