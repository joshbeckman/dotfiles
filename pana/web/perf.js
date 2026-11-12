// The PWA's own measurements (OBS-03). The browser cannot tell panad what it felt like unless
// something asks, so this module times three things and posts them in batches:
//
//   api       one sample per API call, from the request to the parsed body, named by its route
//             pattern (`GET /threads/:id`), with the response status.
//   view      one sample per render, from the hash change to the frame after it painted.
//   longtask  every task the browser reports over 50 ms, which is the main-thread stall a reader
//             feels as a frozen page.
//
// A batch goes to `POST /stats/client` (src/stats/client.ts), which keeps the kind, name,
// duration, and status and discards anything else. Nothing here reads message text, the token, or
// a URL's query string: a name is a route pattern, so an id never leaves the browser.

/** Samples one batch may carry. The daemon rejects a longer batch (CLIENT_BATCH_MAX). */
export const CLIENT_BATCH_MAX = 200;
/** How often a batch is posted while a page stays open. */
export const CLIENT_FLUSH_MS = 10_000;
/** Match the daemon limit; a suspended page may resume after more than ten minutes. */
const CLIENT_DURATION_MAX_MS = 600_000;

// Only these literal patterns can leave the browser. Keep this list in sync with the API
// route table; unknown routes use a fixed fallback, never a path supplied by a caller.
const API_PATTERNS = [
	"POST /sessions",
	"GET /sessions",
	"GET /sessions/:id",
	"GET /sessions/:id/transcript",
	"POST /sessions/:id/stop",
	"POST /sessions/:id/resume",
	"POST /sessions/:id/compact",
	"POST /sessions/:id/archive",
	"GET /inbox",
	"POST /threads",
	"GET /threads",
	"GET /threads/:id",
	"POST /threads/:id/messages",
	"POST /threads/:id/subject",
	"POST /threads/:id/archive",
	"POST /threads/:id/unarchive",
	"GET /messages/:id",
	"POST /messages/:id/read",
	"POST /messages/:id/revisions",
	"POST /messages/:id/redact",
	"POST /files",
	"GET /files/:id/*",
	"GET /memory/worktree",
	"POST /memory/worktree",
	"GET /memory/search",
	"POST /memory/commit",
	"GET /memory/log",
	"GET /memory/commits/:hash",
	"GET /memory/files/*",
	"POST /memory/files/*",
	"DELETE /memory/files/*",
	"GET /memory/files",
	"GET /scratch",
	"POST /scratch/prune",
	"POST /worktrees",
	"GET /schedules",
	"POST /schedules",
	"GET /schedules/:id",
	"POST /schedules/:id",
	"DELETE /schedules/:id",
	"POST /objectives",
	"GET /objectives",
	"POST /objectives/stop",
	"GET /objectives/:id",
	"POST /objectives/:id/launch",
	"POST /objectives/:id/stop",
	"POST /objectives/:id/resume",
	"POST /objectives/:id/done",
	"POST /objectives/:id/archive",
	"POST /objectives/:id/goal",
	"GET /objectives/:id/charter",
	"POST /objectives/:id/charter",
	"GET /objectives/:id/metrics",
	"POST /objectives/:id/metrics",
	"POST /objectives/:id/metrics/:name",
	"POST /objectives/:id/metrics/:name/readings",
	"GET /objectives/:id/brief",
	"POST /objectives/:id/report",
	"POST /objectives/:id/escalate",
	"POST /objectives/:id/regenerate-lead",
	"POST /objectives/:id/links",
	"DELETE /objectives/:id/links/:fileId",
	"POST /objectives/:id/limits",
	"GET /push/key",
	"GET /push/subscriptions",
	"POST /push/subscriptions",
	"GET /events",
	"GET /settings",
	"POST /settings",
	"POST /settings/restart",
	"GET /secrets",
	"POST /secrets",
	"DELETE /secrets/:name",
	"GET /stats/requests",
	"POST /stats/client",
];
const VIEW_PATTERNS = [
	"#/", "#/inbox", "#/compose", "#/threads", "#/threads/:id",
	"#/sessions", "#/sessions/:id", "#/memory", "#/memory/files/*",
	"#/memory/edit/*", "#/memory/commits/:id", "#/memory/new",
	"#/schedules", "#/settings", "#/objectives", "#/objectives/:id",
];
const API_NAMES = new Set([...API_PATTERNS, "UNKNOWN /unknown"]);
const VIEW_NAMES = new Set([...VIEW_PATTERNS, "#/unknown", "page-load"]);

/** Match placeholders without ever copying their contents into a name. */
function matches(pattern, path) {
	const expected = pattern.split("/").filter(Boolean);
	const actual = path.split("/").filter(Boolean);
	for (let i = 0; i < expected.length; i++) {
		if (expected[i] === "*") return actual.length > i;
		if (actual[i] === undefined) return false;
		if (!expected[i].startsWith(":") && expected[i] !== actual[i]) return false;
	}
	return expected.length === actual.length;
}

/** Return a fixed route pattern, even for malformed or unknown paths and methods. */
export function apiName(method, path) {
	const verb = String(method ?? "GET").toUpperCase();
	const clean = String(path ?? "").split(/[?#]/, 1)[0];
	const name = API_PATTERNS.find((candidate) => {
		const [candidateVerb, pattern] = candidate.split(" ");
		return candidateVerb === verb && matches(pattern, clean);
	});
	return name ?? "UNKNOWN /unknown";
}

/** Return a fixed view pattern, never a file path, query, fragment token, or unknown route. */
export function viewName(hash) {
	const raw = String(hash ?? "");
	if (raw === "" || !raw.startsWith("#/")) return "#/";
	const clean = raw.split("?", 1)[0];
	return VIEW_PATTERNS.find((pattern) => matches(pattern, clean)) ?? "#/unknown";
}

/** The server also checks the exact set, so a direct POST cannot write path data as a name. */
export function isSafeClientName(kind, name) {
	return typeof name === "string" && (kind === "api" ? API_NAMES.has(name)
		: kind === "view" ? VIEW_NAMES.has(name)
		: kind === "longtask" && name === "long-task");
}

/**
 * Start measuring. `post(samples)` sends one batch and may fail however it likes: a measurement
 * that cannot be delivered is dropped, never retried, so a dead daemon cannot fill memory.
 * Returns the recorder, or undefined when this environment has no clock to measure with.
 */
export function startClientTelemetry(options = {}) {
	const post = options.post;
	const target = options.target ?? (typeof window === "undefined" ? undefined : window);
	const perf = options.performance ?? (typeof performance === "undefined" ? undefined : performance);
	if (typeof post !== "function" || !perf) return undefined;
	const flushMs = options.flushMs ?? CLIENT_FLUSH_MS;
	const max = options.maxSamples ?? CLIENT_BATCH_MAX;

	let samples = [];
	let timer;
	let stopped = false;
	let dropped = 0;

	function record(kind, name, durationMs, status) {
		if (stopped) return;
		if (!isSafeClientName(kind, name) || !Number.isFinite(durationMs) || durationMs < 0 || durationMs > CLIENT_DURATION_MAX_MS) return;
		if (samples.length >= max) {
			// Keep the newest: a page that renders a thousand rows should still report the last ones.
			samples.shift();
			dropped++;
		}
		const sample = { kind, name, durationMs: Math.round(durationMs * 1000) / 1000 };
		if (Number.isInteger(status) && status >= 100 && status <= 599) sample.status = status;
		samples.push(sample);
	}

	function flush() {
		if (samples.length === 0) return 0;
		const batch = samples;
		samples = [];
		try {
			const sent = post(batch);
			if (sent && typeof sent.catch === "function") sent.catch(() => {});
		} catch {
			// A failed post is dropped on purpose: telemetry never retries and never throws.
		}
		return batch.length;
	}

	function stop() {
		if (stopped) return;
		flush();
		stopped = true;
		if (timer !== undefined) clearInterval(timer);
		timer = undefined;
	}

	if (target && typeof target.addEventListener === "function") {
		// Flush before backgrounding or entering the back-forward cache. Do not stop: the
		// same recorder must keep measuring when the page becomes visible or is restored.
		target.addEventListener("pagehide", flush);
		target.addEventListener("visibilitychange", () => {
			if (target.document?.visibilityState === "hidden") flush();
		});
	}
	if (typeof setInterval === "function") timer = setInterval(flush, flushMs);

	// A page load's own cost: response received, then parsed and ready. A module runs before
	// DOMContentLoaded, and the navigation entry does not gain that event's time until the load
	// event, so the sample lands there. It is what makes a cold view sample separable from boot.
	const navigation = () => (typeof perf.getEntriesByType === "function" ? perf.getEntriesByType("navigation")[0] : undefined);
	if (navigation()) {
		const recordPageLoad = () => {
			const end = navigation()?.domContentLoadedEventEnd ?? 0;
			if (end > 0) record("view", "page-load", end, undefined);
		};
		if (target?.document?.readyState === "complete") recordPageLoad();
		else if (typeof target?.addEventListener === "function") target.addEventListener("load", recordPageLoad, { once: true });
	}

	// Long tasks need an observer; a browser without one still reports api and view samples.
	const Observer = target?.PerformanceObserver ?? (typeof PerformanceObserver === "undefined" ? undefined : PerformanceObserver);
	if (Observer && typeof perf.now === "function") {
		try {
			const observer = new Observer((list) => {
				for (const entry of list.getEntries()) record("longtask", "long-task", entry.duration, undefined);
			});
			observer.observe({ type: "longtask", buffered: true });
		} catch {
			// Not every engine implements `longtask`; the other two samples are the useful ones.
		}
	}

	return {
		now: () => perf.now(),
		api: (name, durationMs, status) => record("api", name, durationMs, status),
		view: (name, durationMs) => record("view", name, durationMs, undefined),
		longTask: (durationMs) => record("longtask", "long-task", durationMs, undefined),
		flush,
		stop,
		/** What is waiting to be sent, for a test or a debugging session. */
		pending: () => samples.length,
		/** How many samples were dropped because the page outran its own batch size. */
		droppedSamples: () => dropped,
	};
}

/** The body `POST /stats/client` accepts: one batch, and nothing else. */
export function clientBody(samples) {
	return { samples: Array.isArray(samples) ? samples.slice(0, CLIENT_BATCH_MAX) : [] };
}
