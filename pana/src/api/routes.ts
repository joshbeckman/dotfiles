// The API route table. panad serves every route on the Unix socket (CLI) and on TCP (PWA).
// Each route names a handler; the owning work package implements it in its own
// `src/<package>/handlers.ts`. A route with no handler answers 501 `not_implemented`.
//
// Patterns use `:param` for one segment and a trailing `*` for the rest of the path, captured
// as `params.rest`. Add routes at the end of a group; never rename a handler.

export type Method = "GET" | "POST" | "DELETE";

export const ROUTES = [
	{ method: "POST", pattern: "/sessions", name: "sessions.create", wp: "WP3" },
	{ method: "GET", pattern: "/sessions", name: "sessions.search", wp: "WP3" },
	{ method: "GET", pattern: "/sessions/:id", name: "sessions.show", wp: "WP3" },
	{ method: "GET", pattern: "/sessions/:id/transcript", name: "sessions.transcript", wp: "WP3" },
	{ method: "POST", pattern: "/sessions/:id/stop", name: "sessions.stop", wp: "WP3" },
	{ method: "POST", pattern: "/sessions/:id/resume", name: "sessions.resume", wp: "WP3" },
	{ method: "POST", pattern: "/sessions/:id/compact", name: "sessions.compact", wp: "WP3" },
	{ method: "GET", pattern: "/inbox", name: "inbox.list", wp: "WP2" },
	{ method: "POST", pattern: "/threads", name: "threads.create", wp: "WP2" },
	{ method: "GET", pattern: "/threads", name: "threads.search", wp: "WP7" },
	{ method: "GET", pattern: "/threads/:id", name: "threads.read", wp: "WP2" },
	{ method: "POST", pattern: "/threads/:id/messages", name: "threads.respond", wp: "WP2" },
	{ method: "POST", pattern: "/threads/:id/subject", name: "threads.subject", wp: "WP7" },
	{ method: "GET", pattern: "/messages/:id", name: "messages.show", wp: "WP2" },
	{ method: "POST", pattern: "/messages/:id/read", name: "messages.markRead", wp: "WP2" },
	{ method: "POST", pattern: "/messages/:id/revisions", name: "messages.revise", wp: "WP2" },
	{ method: "POST", pattern: "/messages/:id/redact", name: "messages.redact", wp: "WP2" },
	{ method: "POST", pattern: "/files", name: "files.upload", wp: "WP2" },
	{ method: "GET", pattern: "/files/:id/*", name: "files.download", wp: "WP2" },
	{ method: "GET", pattern: "/memory/worktree", name: "memory.worktree", wp: "WP5" },
	{ method: "POST", pattern: "/memory/worktree", name: "memory.worktree.create", wp: "WP5" },
	{ method: "GET", pattern: "/memory/search", name: "memory.search", wp: "WP5" },
	{ method: "POST", pattern: "/memory/commit", name: "memory.commit", wp: "WP5" },
	{ method: "GET", pattern: "/memory/log", name: "memory.log", wp: "WP5" },
	{ method: "GET", pattern: "/memory/files/*", name: "memory.files.read", wp: "WP5" },
	{ method: "POST", pattern: "/memory/files/*", name: "memory.files.write", wp: "WP5" },
	{ method: "GET", pattern: "/memory/files", name: "memory.files.list", wp: "WP10" },
	{ method: "GET", pattern: "/schedules", name: "schedules.list", wp: "WP6" },
	{ method: "POST", pattern: "/schedules", name: "schedules.create", wp: "WP6" },
	{ method: "GET", pattern: "/schedules/:id", name: "schedules.show", wp: "WP6" },
	{ method: "POST", pattern: "/schedules/:id", name: "schedules.update", wp: "WP6" },
	{ method: "DELETE", pattern: "/schedules/:id", name: "schedules.delete", wp: "WP6" },
	{ method: "GET", pattern: "/push/key", name: "push.key", wp: "WP8" },
	{ method: "GET", pattern: "/push/subscriptions", name: "push.subscriptions.list", wp: "WP8" },
	{ method: "POST", pattern: "/push/subscriptions", name: "push.subscriptions.create", wp: "WP8" },
	{ method: "GET", pattern: "/events", name: "events.stream", wp: "WP8" },
	// The PWA shell. `web.index` and `web.static` are the only routes that answer without the
	// bearer token (see `src/web/static.ts`); the catch-all must stay last so it never shadows
	// an API route.
	{ method: "GET", pattern: "/", name: "web.index", wp: "WP8" },
	{ method: "GET", pattern: "/*", name: "web.static", wp: "WP8" },
] as const satisfies readonly RouteDef[];

export interface RouteDef {
	method: Method;
	pattern: string;
	name: string;
	/** The work package that owns the handler. */
	wp: string;
}

export type RouteName = (typeof ROUTES)[number]["name"];

export interface RouteMatch {
	route: RouteDef & { name: RouteName };
	params: Record<string, string>;
}

/** Match a method and path against the table. Returns the route and its captured params. */
export function matchRoute(method: string, path: string): RouteMatch | undefined {
	const want = path.split("/").filter((s) => s.length > 0);
	for (const route of ROUTES) {
		if (route.method !== method) continue;
		const params = matchParts(route.pattern.split("/").filter((s) => s.length > 0), want);
		if (params) return { route, params };
	}
	return undefined;
}

/** True when some route has this path under another method, for a 405-style 404 message. */
export function pathExists(path: string): boolean {
	const want = path.split("/").filter((s) => s.length > 0);
	return ROUTES.some((route) => matchParts(route.pattern.split("/").filter((s) => s.length > 0), want) !== undefined);
}

function matchParts(parts: string[], want: string[]): Record<string, string> | undefined {
	const params: Record<string, string> = {};
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i]!;
		if (part === "*") {
			if (want.length <= i) return undefined;
			params.rest = want.slice(i).map(decodeURIComponent).join("/");
			return params;
		}
		const got = want[i];
		if (got === undefined) return undefined;
		if (part.startsWith(":")) params[part.slice(1)] = decodeURIComponent(got);
		else if (part !== got) return undefined;
	}
	return want.length === parts.length ? params : undefined;
}
