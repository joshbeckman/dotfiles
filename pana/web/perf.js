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

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const HEX_ID = /^[0-9a-f]{16,}$/;

/**
 * The route pattern of a request path (OBS-03): `/threads/01M6…?x=1` becomes `/threads/:id`.
 * Ids are stripped rather than sent, so a batch names an operation and never a subject.
 */
export function apiName(method, path) {
	const clean = String(path ?? "").split("?")[0].split("#")[0];
	const parts = clean.split("/").filter((part) => part.length > 0);
	const words = parts.map((part) => (ULID.test(part) || HEX_ID.test(part) ? ":id" : part));
	return `${String(method ?? "GET").toUpperCase()} /${words.join("/")}`.replace(/\/$/, "");
}

/** The view a hash names (OBS-03): `#/threads/01M6…` becomes `#/threads/:id`. */
export function viewName(hash) {
	const clean = String(hash ?? "").replace(/^#\/?/, "").split("?")[0];
	const parts = clean.split("/").filter((part) => part.length > 0);
	if (parts.length === 0) return "#/";
	const words = parts.map((part) => (ULID.test(part) || HEX_ID.test(part) ? ":id" : part));
	return `#/${words.join("/")}`;
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
		if (!Number.isFinite(durationMs) || durationMs < 0) return;
		if (samples.length >= max) {
			// Keep the newest: a page that renders a thousand rows should still report the last ones.
			samples.shift();
			dropped++;
		}
		const sample = { kind, name, durationMs: Math.round(durationMs * 1000) / 1000 };
		if (typeof status === "number" && status >= 100 && status <= 599) sample.status = status;
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
		// A page that is being hidden is the last chance to send what it measured.
		target.addEventListener("pagehide", stop);
		target.addEventListener("visibilitychange", () => {
			if (target.document?.visibilityState === "hidden") stop();
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
