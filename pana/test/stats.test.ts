// WP20: observability. The reader over panad's own logs (OBS-01, OBS-02), the percentiles it
// reports (OBS-05), and the PWA's samples (OBS-03, OBS-04).
//
// The unit tests drive the reader directly on a file this test writes, so the shapes are pinned
// without a daemon. The route tests drive a real in-process panad, because the point of the route
// is that the numbers come from the log panad itself is writing.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../src/cli/index.ts";
import { runPanaCommand } from "../src/cli/commands.ts";
import {
	bucketOf,
	parseClientLines,
	parseRequestLines,
	parseSince,
	percentile,
	readLogTail,
	summarizeClientFile,
	summarizeRequests,
	summarizeRequestsFile,
} from "../src/stats/index.ts";
import { CLIENT_BATCH_MAX, clientLine } from "../src/stats/client.ts";
import { renderStatsText } from "../src/stats/text.ts";
import { apiName, clientBody, startClientTelemetry, viewName } from "../web/perf.js";
import { startTestPanad, type TestPanad } from "./harness/index.ts";

let t: TestPanad | undefined;
let dirs: string[] = [];
afterEach(async () => {
	await t?.close();
	t = undefined;
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	dirs = [];
});

async function start(): Promise<TestPanad> {
	t = await startTestPanad({ config: { defaultModel: "faux/faux-1", timezone: "UTC" } });
	return t;
}

/** Run the real CLI entry point against a test panad, capturing both streams. */
async function cli(argv: string[], panad: TestPanad) {
	let stdout = "";
	let stderr = "";
	const code = await main(argv, {
		env: { PANA_STATE: panad.dir },
		stdin: Readable.from([]),
		stdout: { write: (chunk: string) => (stdout += chunk), isTTY: true },
		stderr: { write: (chunk: string) => (stderr += chunk), isTTY: true },
	});
	return { code, stdout, stderr };
}

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pana-stats-"));
	dirs.push(dir);
	return dir;
}

/** A request log line, in the shape `src/server/log.ts` writes. */
function line(at: string, route: string | null, durationMs: number, status = 200, path = "/x"): string {
	return `${JSON.stringify({ ts: at, transport: "socket", method: "GET", path, route, caller: null, status, durationMs })}\n`;
}

const T0 = Date.UTC(2026, 0, 5, 9, 0, 0);
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

describe("percentiles", () => {
	it("is nearest-rank over the samples given", () => {
		expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
		expect(percentile([1, 2, 3, 4, 5], 0.95)).toBe(5);
		expect(percentile([1, 2, 3, 4, 5], 1)).toBe(5);
		expect(percentile([7], 0.99)).toBe(7);
		expect(percentile([], 0.99)).toBe(0);
	});

	it("reports an empty bucket as zero samples, never as zero latency", () => {
		expect(bucketOf([], 0)).toEqual({ count: 0, errors: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 });
	});

	it("counts errors separately from durations", () => {
		const bucket = bucketOf([10, 20, 30], 1);
		expect(bucket.count).toBe(3);
		expect(bucket.errors).toBe(1);
		expect(bucket.p50).toBe(20);
		expect(bucket.mean).toBe(20);
	});
});

describe("since", () => {
	it("takes a span or an ISO timestamp", () => {
		expect(parseSince("90s", T0)).toBe(T0 - 90_000);
		expect(parseSince("2h", T0)).toBe(T0 - 2 * 3_600_000);
		expect(parseSince("7d", T0)).toBe(T0 - 7 * 86_400_000);
		expect(parseSince(at(-1000), T0)).toBe(T0 - 1000);
		expect(parseSince("", T0)).toBeUndefined();
		expect(parseSince(null, T0)).toBeUndefined();
	});

	it("refuses text that is not a time", () => {
		expect(() => parseSince("yesterday", T0)).toThrow(/not a time/);
	});
});

describe("reading a log", () => {
	it("treats a missing file as empty", async () => {
		const tail = await readLogTail(join(tempDir(), "nothing.log"));
		expect(tail.lines).toEqual([]);
		expect(tail.bytes).toBe(0);
		expect(tail.truncated).toBe(false);
	});

	it("reads the newest bytes and drops the half line the window cut", async () => {
		const path = join(tempDir(), "panad.log");
		writeFileSync(path, line(at(0), "a", 1) + line(at(1), "b", 2) + line(at(2), "c", 3));
		const full = readFileSync(path);
		const lastLine = line(at(2), "c", 3);
		const tail = await readLogTail(path, lastLine.length + 20);
		expect(tail.truncated).toBe(true);
		expect(tail.bytes).toBeLessThan(full.length);
		expect(tail.lines).toHaveLength(1);
		expect(JSON.parse(tail.lines[0]!).route).toBe("c");
	});

	it("counts a line it cannot parse instead of guessing", () => {
		const parsed = parseRequestLines([line(at(0), "inbox.list", 2), "{not json", "", JSON.stringify({ ts: at(1) })]);
		expect(parsed.entries).toHaveLength(1);
		expect(parsed.skipped).toBe(2);
	});

	it("names an unnumbered request by its path", () => {
		const parsed = parseRequestLines([JSON.stringify({ ts: at(0), path: "/nope", status: 404, durationMs: 0.5 })]);
		expect(parsed.entries[0]!.route).toBe("raw /nope");
	});
});

describe("summarizing requests", () => {
	const entries = parseRequestLines([
		line(at(0), "inbox.list", 2),
		line(at(1000), "inbox.list", 4),
		line(at(2000), "inbox.list", 30, 500),
		line(at(3000), "threads.read", 1),
	]).entries;

	it("groups by route, worst p99 first", () => {
		const summary = summarizeRequests(entries);
		expect(summary.routes.map((route) => route.route)).toEqual(["inbox.list", "threads.read"]);
		const inbox = summary.routes[0]!;
		expect(inbox.count).toBe(3);
		expect(inbox.errors).toBe(1);
		expect(inbox.p50).toBe(4);
		expect(inbox.max).toBe(30);
		expect(summary.overall.count).toBe(4);
		expect(summary.overall.errors).toBe(1);
	});

	it("names the slowest requests, and the statuses seen", () => {
		const summary = summarizeRequests(entries, 2);
		expect(summary.slowest.map((entry) => entry.durationMs)).toEqual([30, 4]);
		expect(summary.statuses).toEqual({ "200": 3, "500": 1 });
	});

	it("filters by route and by since before summarizing", async () => {
		const path = join(tempDir(), "panad.log");
		writeFileSync(path, [line(at(0), "inbox.list", 2), line(at(60_000), "inbox.list", 3), line(at(120_000), "threads.read", 9)].join(""));
		const onlyRoute = await summarizeRequestsFile(path, { route: "threads.read" });
		expect(onlyRoute.routes.map((route) => route.route)).toEqual(["threads.read"]);
		expect(onlyRoute.window.count).toBe(1);
		const recent = await summarizeRequestsFile(path, { since: T0 + 90_000 });
		expect(recent.window.count).toBe(1);
		expect(recent.routes[0]!.route).toBe("threads.read");
		expect(recent.window.from).toBe(at(120_000));
		expect(recent.window.to).toBe(at(120_000));
	});

	it("says nothing was measured when the window is empty", async () => {
		const summary = await summarizeRequestsFile(join(tempDir(), "empty.log"));
		expect(summary.window.count).toBe(0);
		expect(summary.window.from).toBeNull();
		expect(summary.routes).toEqual([]);
		expect(summary.overall.count).toBe(0);
	});
});

describe("GET /stats/requests", () => {
	it("reads the request log panad is writing", async () => {
		const panad = await start();
		await panad.client.get("/inbox");
		await panad.client.get("/inbox");
		const res = await panad.client.get<{ overall: { count: number }; routes: Array<{ route: string }>; window: { from: string | null } }>("/stats/requests");
		expect(res.status).toBe(200);
		expect(res.body.window.from).not.toBeNull();
		expect(res.body.overall.count).toBeGreaterThanOrEqual(2);
		expect(res.body.routes.map((route) => route.route)).toContain("inbox.list");
	});

	it("takes since and route as filters", async () => {
		const panad = await start();
		await panad.client.get("/inbox");
		const res = await panad.client.get<{ window: { count: number }; routes: Array<{
			route: string;
		}> }>("/stats/requests?route=inbox.list&since=1h");
		expect(res.body.routes.map((route) => route.route)).toEqual(["inbox.list"]);
		expect(res.body.window.count).toBeGreaterThanOrEqual(1);
		const none = await panad.client.get<{ window: { count: number }; routes: unknown[] }>("/stats/requests?since=2000-01-01T00:00:00Z");
		expect(none.body.window.count).toBeGreaterThanOrEqual(1);
		const past = await panad.client.get<{ window: { count: number }; routes: unknown[] }>("/stats/requests?since=2999-01-01T00:00:00Z");
		expect(past.body.window.count).toBe(0);
		expect(past.body.routes).toEqual([]);
	});

	it("refuses a since that is not a time", async () => {
		const panad = await start();
		const res = await panad.client.get<{ error: { code: string } }>("/stats/requests?since=yesterday");
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe("invalid_since");
	});
});

describe("POST /stats/client", () => {
	const batch = {
		samples: [
			{ kind: "api", name: "GET /inbox", durationMs: 12.5, status: 200 },
			{ kind: "view", name: "#/inbox", durationMs: 40 },
			{ kind: "longtask", name: "long-task", durationMs: 75 },
		],
	};

	it("appends one line per sample and reports them in the summary", async () => {
		const panad = await start();
		const res = await panad.client.post<{ accepted: number; samples: number }>("/stats/client", batch);
		expect(res.status).toBe(202);
		expect(res.body).toEqual({ accepted: 3, samples: 3 });
		const lines = readFileSync(panad.runtime.paths.clientLog, "utf8").split("\n").filter(Boolean);
		expect(lines).toHaveLength(3);
		expect(Object.keys(JSON.parse(lines[0]!)).sort()).toEqual(["durationMs", "kind", "name", "status", "ts"]);
		const summary = await panad.client.get<{ client: { window: { count: number }; groups: Array<{ kind: string; name: string; p50: number }> } }>(
			"/stats/requests",
		);
		expect(summary.body.client.window.count).toBe(3);
		const view = summary.body.client.groups.find((group) => group.kind === "view");
		expect(view?.name).toBe("#/inbox");
		expect(view?.p50).toBe(40);
	});

	it("keeps the sample's own names and no field it was not given", async () => {
		const panad = await start();
		await panad.client.post("/stats/client", { samples: [{ kind: "api", name: "GET /x", durationMs: 1, body: "secret", token: "nope" }] });
		const stored = JSON.parse(readFileSync(panad.runtime.paths.clientLog, "utf8").trim());
		expect(stored).not.toHaveProperty("body");
		expect(stored).not.toHaveProperty("token");
	});

	it("rejects a batch that is not samples", async () => {
		const panad = await start();
		const cases = [
			{},
			{ samples: "nope" },
			{ samples: [{ kind: "network", name: "x", durationMs: 1 }] },
			{ samples: [{ kind: "api", name: "GET /x\n\u001b[2J", durationMs: 1 }] },
			{ samples: [{ kind: "api", name: "GET /x", durationMs: -1 }] },
			{ samples: [{ kind: "api", name: "GET /x", durationMs: Number.MAX_SAFE_INTEGER }] },
			{ samples: [{ kind: "api", name: "GET /x", durationMs: 1, status: 99 }] },
			{ samples: Array.from({ length: CLIENT_BATCH_MAX + 1 }, () => ({ kind: "api", name: "GET /x", durationMs: 1 })) },
		];
		for (const body of cases) {
			const res = await panad.client.post<{ error: { code: string } }>("/stats/client", body);
			expect(res.status, JSON.stringify(body).slice(0, 60)).toBe(400);
			expect(res.body.error.code).toMatch(/^invalid_sample|^too_many_samples|^invalid_samples$/);
		}
		expect(existsSync(panad.runtime.paths.clientLog)).toBe(false);
	});

	it("reads a client log it wrote, and skips a line it did not", async () => {
		const path = join(tempDir(), "client.log");
		writeFileSync(
			path,
			[
				clientLine({ kind: "api", name: "GET /inbox", durationMs: 5, status: 200 }, T0),
				clientLine({ kind: "api", name: "GET /inbox", durationMs: 7, status: 500 }, T0 + 1),
				"{}\n",
			].join(""),
		);
		const summary = await summarizeClientFile(path);
		expect(summary.window).toMatchObject({ count: 2, skipped: 1 });
		expect(summary.groups[0]).toMatchObject({ kind: "api", name: "GET /inbox", count: 2, errors: 1, p50: 5 });
		expect(parseClientLines(["{}\n"]).skipped).toBe(1);
	});
});

describe("pana stats requests", () => {
	it("answers from the daemon with routes and a client section", async () => {
		const panad = await start();
		await panad.client.get("/inbox");
		const outcome = await runPanaCommand("stats requests", { since: "24h" }, { endpoint: { socketPath: panad.panad.socketPath } });
		expect(outcome.exitCode).toBe(0);
		const body = outcome.body as { routes: Array<{ route: string }>; client: { groups: unknown[] } };
		expect(body.routes.map((route) => route.route)).toContain("inbox.list");
		expect(body.client.groups).toEqual([]);
	});

	it("prints a table on a TTY and the same fields as JSON with --json", async () => {
		const panad = await start();
		await panad.client.get("/inbox");
		const text = await cli(["stats", "requests", "--since", "24h"], panad);
		expect(text.code).toBe(0);
		expect(text.stdout).toContain("server");
		expect(text.stdout).toContain("inbox.list");
		expect(text.stdout).toContain("client");
		const json = await cli(["stats", "requests", "--since", "24h", "--json"], panad);
		expect(json.code).toBe(0);
		const body = JSON.parse(json.stdout) as { routes: Array<{ route: string }> };
		expect(body.routes.map((route) => route.route)).toContain("inbox.list");
	});

	it("exits 2 for a stats command that does not exist", async () => {
		const panad = await start();
		const result = await cli(["stats", "nope"], panad);
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("unknown command");
	});

	it("renders an empty window as empty, not as fast", () => {
		const text = renderStatsText({
			window: { from: null, to: null, count: 0, bytes: 0, skipped: 0, truncated: false },
			overall: { count: 0, errors: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 },
			routes: [],
			statuses: {},
			slowest: [],
			client: { window: { count: 0, bytes: 0 }, groups: [] },
		});
		expect(text).toContain("0 requests");
		expect(text).toContain("no samples");
		expect(text).not.toContain("p50 0.00");
	});

	it("strips a control sequence a log could carry", () => {
		const text = renderStatsText({
			window: { count: 1, bytes: 1, from: at(0), to: at(0) },
			overall: { count: 1, errors: 0 },
			routes: [{ route: "evil\u001b[2Jroute", count: 1, errors: 0, p50: 1, p95: 1, p99: 1, max: 1, mean: 1 }],
		});
		expect(text).not.toContain("\u001b");
	});
});

describe("the PWA's own names", () => {
	it("names a call by its route pattern, without the id or the query", () => {
		expect(apiName("get", "/inbox")).toBe("GET /inbox");
		expect(apiName("GET", "/threads/01M6YEBTJ6T1N9RJ97T8B16RFE?message=01M6YEBTJ6T1N9RJ97T8B16RFG")).toBe("GET /threads/:id");
		expect(apiName("POST", "/objectives/01M6YEBTJ6T1N9RJ97T8B16RFE/report")).toBe("POST /objectives/:id/report");
	});

	it("names a view by its section, without the id", () => {
		expect(viewName("#/inbox")).toBe("#/inbox");
		expect(viewName("#/threads/01M6YEBTJ6T1N9RJ97T8B16RFE")).toBe("#/threads/:id");
		expect(viewName("")).toBe("#/");
	});

	// OBS-04: the launch URL carries the token in the fragment. A fragment that is not a route names
	// no view, so the sample cannot carry the token into client.log.
	it("never names a view after the launch fragment", () => {
		expect(viewName("#Loaht6C-_wtcKAk2q9xBpfZqg9PJhwA7pFLwgLvrHH0")).toBe("#/");
		expect(viewName("#")).toBe("#/");
	});

	it("caps a batch at what the daemon accepts", () => {
		expect(clientBody(Array.from({ length: 5 }, () => ({}))).samples).toHaveLength(5);
		expect(clientBody(Array.from({ length: CLIENT_BATCH_MAX + 50 }, () => ({}))).samples).toHaveLength(CLIENT_BATCH_MAX);
		expect(clientBody(undefined).samples).toEqual([]);
	});
});

describe("the PWA's recorder", () => {
	/** A recorder on a fake clock, with the batch it posted held here. */
	function recorder(options: { maxSamples?: number } = {}) {
		let clock = 0;
		const posted: unknown[][] = [];
		const perf = { now: () => clock };
		const telemetry = startClientTelemetry({
			post: (samples: unknown[]) => posted.push(samples),
			performance: perf,
			target: undefined,
			maxSamples: options.maxSamples,
		});
		return {
			telemetry: telemetry!,
			posted,
			advance: (ms: number) => {
				clock += ms;
			},
		};
	}

	// OBS-03: a cold view sample is only separable from boot when the load itself is measured. The
	// navigation entry gains its DOMContentLoaded time only by the load event, so the sample waits.
	it("records the page load when the document finishes loading", () => {
		const listeners = new Map<string, () => void>();
		const posted: unknown[][] = [];
		const nav = { domContentLoadedEventEnd: 0 };
		const telemetry = startClientTelemetry({
			post: (samples: unknown[]) => posted.push(samples),
			performance: { now: () => 0, getEntriesByType: (type: string) => (type === "navigation" ? [nav] : []) },
			target: {
				addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
				document: { readyState: "loading" },
			},
		})!;
		expect(telemetry.pending()).toBe(0);
		nav.domContentLoadedEventEnd = 212.5;
		listeners.get("load")!();
		telemetry.flush();
		expect(posted[0]).toEqual([{ kind: "view", name: "page-load", durationMs: 212.5 }]);
	});

	it("records a page load the browser has already finished", () => {
		const posted: unknown[][] = [];
		startClientTelemetry({
			post: (samples: unknown[]) => posted.push(samples),
			performance: { now: () => 0, getEntriesByType: () => [{ domContentLoadedEventEnd: 88 }] },
			target: { document: { readyState: "complete" } },
		})!.flush();
		expect(posted[0]).toEqual([{ kind: "view", name: "page-load", durationMs: 88 }]);
	});

	it("measures a call from the request to the reply", () => {
		const { telemetry, posted, advance } = recorder();
		const started = telemetry.now();
		advance(12.25);
		telemetry.api("GET /inbox", telemetry.now() - started, 200);
		expect(telemetry.pending()).toBe(1);
		telemetry.flush();
		expect(posted[0]).toEqual([{ kind: "api", name: "GET /inbox", durationMs: 12.25, status: 200 }]);
		expect(telemetry.pending()).toBe(0);
	});

	it("keeps the newest samples when a page outruns its batch", () => {
		const { telemetry, posted } = recorder({ maxSamples: 2 });
		telemetry.view("#/a", 1);
		telemetry.view("#/b", 2);
		telemetry.view("#/c", 3);
		expect(telemetry.droppedSamples()).toBe(1);
		telemetry.flush();
		expect((posted[0] as Array<{ name: string }>).map((sample) => sample.name)).toEqual(["#/b", "#/c"]);
	});

	it("drops a batch that cannot be delivered, and keeps measuring", () => {
		const posted: unknown[] = [];
		const telemetry = startClientTelemetry({
			post: () => {
				throw new Error("offline");
			},
			performance: { now: () => 0 },
			target: undefined,
		})!;
		telemetry.view("#/a", 1);
		expect(() => telemetry.flush()).not.toThrow();
		expect(telemetry.pending()).toBe(0);
		telemetry.view("#/b", 2);
		telemetry.flush();
		expect(posted).toEqual([]);
	});

	it("has no recorder without something to post with", () => {
		expect(startClientTelemetry({})).toBeUndefined();
		expect(startClientTelemetry({ post: "nope" as never })).toBeUndefined();
	});
});
