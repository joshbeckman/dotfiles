// The pana bench (SCALE-01..03). `scripts/bench` runs this file.
//
// It starts a real panad child with the bench's faux model (test/bench/panad.ts) on a temporary
// state directory and drives it only through the Unix socket, as the CLI does:
//
// 1. sessions: N sessions created at once, each answering its first prompt.
// 2. threads: M threads between the user and those sessions, K user messages each. Each message
//    waits for the session's answer before the next, C threads at a time.
// 3. broadcast: R messages to one thread with all N sessions, so each append wakes N sessions.
// 4. fan-out: F sessions that each create B children, down to `spawnDepth`.
// 5. lists (optional): T threads in the user's inbox, then timed pages of every list route.
//
// Then it stops panad and checks the database (SCALE-02). Latency per route comes from
// panad's own request log (SRV-01), so it covers the sessions' tool calls too.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { request, type ApiResponse } from "../../src/api/client.ts";
import { checkDatabase, failedRequests, type CheckResult, type LoggedRequest } from "./checks.ts";
import { BENCH_MODEL } from "./model.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const DOMAIN = "bench.example";
const USER = "bench";

export interface BenchOptions {
	sessions: number;
	threads: number;
	messages: number;
	/** Messages to one thread with every session; 0 skips the phase. */
	broadcast: number;
	fanout: number;
	branch: number;
	spawnDepth: number;
	concurrency: number;
	latencyMs: number;
	/** Threads to seed before timing the list routes; 0 skips the phase. */
	listThreads: number;
	/** Timed requests per list route. */
	listSamples: number;
	/** Page size for the list phase. */
	pageSize: number;
	keep: boolean;
	/** Give up on a phase after this long. */
	timeoutMs: number;
	log?: (line: string) => void;
}

export const DEFAULTS: BenchOptions = {
	sessions: 200,
	threads: 1000,
	messages: 5,
	broadcast: 5,
	fanout: 10,
	branch: 2,
	spawnDepth: 3,
	concurrency: 50,
	latencyMs: 20,
	listThreads: 0,
	listSamples: 50,
	pageSize: 50,
	keep: false,
	timeoutMs: 600_000,
};

export interface Stats {
	count: number;
	p50: number;
	p99: number;
	max: number;
}

export interface PhaseResult {
	name: string;
	ms: number;
	/** What the phase counted, e.g. messages or sessions. */
	units: number;
	unit: string;
	perSecond: number;
	/** End to end: a user message posted until its answer arrived over /events. */
	answer?: Stats;
	/** The user's own post requests, as the client saw them. */
	post?: Stats;
}

export interface ListResult {
	route: string;
	/** Items in the whole list. */
	total: number;
	/** The first page, as the PWA asks for it. */
	firstPage: Stats;
	/** Every page while walking the list with `cursor`. */
	pages: Stats;
	pageCount: number;
	/** Bytes of the first page's response. */
	bytes: number;
}

export interface BenchResult {
	options: Omit<BenchOptions, "log">;
	phases: PhaseResult[];
	routes: Record<string, Stats & { failed: number }>;
	lists: ListResult[];
	requests: number;
	rssPeakMb: number;
	rssEndMb: number;
	dbBytes: number;
	checks: CheckResult[];
	ok: boolean;
	stateDir?: string;
}

export function stats(values: readonly number[]): Stats {
	if (values.length === 0) return { count: 0, p50: 0, p99: 0, max: 0 };
	const sorted = [...values].sort((a, b) => a - b);
	const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
	const round = (n: number) => Math.round(n * 100) / 100;
	return { count: sorted.length, p50: round(at(0.5)), p99: round(at(0.99)), max: round(sorted[sorted.length - 1]!) };
}

/** Expected sessions of one fan-out tree: B^0 + ... + B^depth. */
export function treeSize(branch: number, depth: number): number {
	let total = 0;
	for (let level = 0, width = 1; level <= depth; level++, width *= branch) total += width;
	return total;
}

// --- The panad child -----------------------------------------------------------

interface Child {
	process: ChildProcess;
	socket: string;
	stop(): Promise<void>;
}

async function startChild(state: string, options: BenchOptions): Promise<Child> {
	// PANA_BENCH_NODE_ARGS passes flags such as --cpu-prof to panad alone, not to the driver.
	const nodeArgs = (process.env.PANA_BENCH_NODE_ARGS ?? "").split(/\s+/).filter(Boolean);
	const child = spawn(process.execPath, [...nodeArgs, join(here, "panad.ts")], {
		env: { ...process.env, PANA_STATE: state, PANA_BENCH_LATENCY_MS: String(options.latencyMs) },
		stdio: ["ignore", "ignore", "pipe"],
	});
	let stderr = "";
	child.stderr!.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	const socket = join(state, "panad.sock");
	const end = Date.now() + 30_000;
	for (;;) {
		if (child.exitCode !== null) throw new Error(`panad exited with ${child.exitCode}: ${stderr}`);
		if (existsSync(socket)) {
			try {
				const res = await request({ socketPath: socket }, "GET", "/schedules");
				if (res.status === 200) break;
			} catch {
				// Not listening yet.
			}
		}
		if (Date.now() > end) throw new Error(`panad did not start: ${stderr}`);
		await sleep(50);
	}
	return {
		process: child,
		socket,
		stop: async () => {
			if (child.exitCode !== null) return;
			const exited = new Promise((resolve) => child.once("exit", resolve));
			child.kill("SIGTERM");
			await exited;
			if (process.env.PANA_BENCH_STDERR) process.stderr.write(stderr);
			if (child.exitCode !== 0) throw new Error(`panad exited with ${child.exitCode}: ${stderr}`);
		},
	};
}

function rssKb(pid: number): Promise<number> {
	return new Promise((resolve) => {
		execFile("ps", ["-o", "rss=", "-p", String(pid)], (error, stdout) => resolve(error ? 0 : Number(stdout.trim()) || 0));
	});
}

// --- /events --------------------------------------------------------------------

interface Delivery {
	threadId: string;
	messageId: string;
	senderUrl: string;
}

/** The user's live deliveries, so a driver waits for an answer without polling. */
class Answers {
	readonly #arrived = new Map<string, Delivery[]>();
	readonly #waiting = new Map<string, Array<(delivery: Delivery) => void>>();
	#close: (() => void) | undefined;

	open(socket: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const req = httpRequest({ socketPath: socket, method: "GET", path: "/events" }, (res) => {
				if (res.statusCode !== 200) return reject(new Error(`/events answered ${res.statusCode}`));
				let buffer = "";
				res.setEncoding("utf8");
				res.on("data", (chunk: string) => {
					buffer += chunk;
					let split;
					while ((split = buffer.indexOf("\n\n")) >= 0) {
						const frame = buffer.slice(0, split);
						buffer = buffer.slice(split + 2);
						const data = frame.split("\n").find((line) => line.startsWith("data: "));
						if (!data) continue;
						const event = JSON.parse(data.slice(6)) as { kind: string } & Partial<Delivery>;
						if (event.kind === "hello") resolve();
						if (event.kind === "delivery" && event.senderUrl?.includes("/sessions/")) this.#arrive(event as Delivery);
					}
				});
			});
			req.on("error", reject);
			req.end();
			this.#close = () => req.destroy();
		});
	}

	#arrive(delivery: Delivery): void {
		const waiter = this.#waiting.get(delivery.threadId)?.shift();
		if (waiter) return waiter(delivery);
		const list = this.#arrived.get(delivery.threadId) ?? [];
		list.push(delivery);
		this.#arrived.set(delivery.threadId, list);
	}

	/** The next session message delivered to the user in this thread. */
	next(threadId: string, timeoutMs: number): Promise<Delivery> {
		const ready = this.#arrived.get(threadId)?.shift();
		if (ready) return Promise.resolve(ready);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`no answer in thread ${threadId} after ${timeoutMs} ms`)), timeoutMs);
			const list = this.#waiting.get(threadId) ?? [];
			list.push((delivery) => {
				clearTimeout(timer);
				resolve(delivery);
			});
			this.#waiting.set(threadId, list);
		});
	}

	close(): void {
		this.#close?.();
	}
}

// --- Driving --------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pool<T>(items: readonly T[], limit: number, work: (item: T, index: number) => Promise<void>): Promise<void> {
	let next = 0;
	const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
		while (next < items.length) {
			const index = next++;
			await work(items[index]!, index);
		}
	});
	await Promise.all(workers);
}

function must<T>(res: ApiResponse<T>, what: string): T {
	if (res.status >= 400) throw new Error(`${what} answered ${res.status}: ${res.raw.toString("utf8").slice(0, 300)}`);
	return res.body;
}

interface Created {
	session: { id: string };
	thread: { id: string };
	message: { id: string };
}

/** Run the bench. Resolves with the result; panad is stopped and, unless `keep`, its state removed. */
export async function runBench(partial: Partial<BenchOptions> = {}): Promise<BenchResult> {
	const options: BenchOptions = { ...DEFAULTS, ...partial };
	const log = options.log ?? (() => {});
	const state = mkdtempSync(join(tmpdir(), "pana-bench-"));
	writeFileSync(
		join(state, "config.json"),
		JSON.stringify({
			domain: DOMAIN,
			user: USER,
			defaultModel: BENCH_MODEL,
			spawnDepth: options.spawnDepth,
			budget: { sessionUsd: 1e9, domainDailyUsd: 1e9 },
		}),
	);

	const child = await startChild(state, options);
	const endpoint = { socketPath: child.socket };
	const call = <T>(method: string, path: string, body?: unknown, caller?: string) =>
		request<T>(endpoint, method, path, { ...(body === undefined ? {} : { body }), ...(caller ? { caller } : {}) });

	let rssPeak = 0;
	let sampling = true;
	const sampler = (async () => {
		while (sampling) {
			rssPeak = Math.max(rssPeak, await rssKb(child.process.pid!));
			await sleep(250);
		}
	})();

	const answers = new Answers();
	const phases: PhaseResult[] = [];
	const lists: ListResult[] = [];
	let rssEnd = 0;
	try {
		await answers.open(child.socket);

		// 1. Sessions, all at once.
		log(`sessions: creating ${options.sessions}`);
		let started = performance.now();
		const sessionAnswers: number[] = [];
		const sessionIds: string[] = [];
		await Promise.all(
			Array.from({ length: options.sessions }, async (_, i) => {
				const t0 = performance.now();
				const created = must(await call<Created>("POST", "/sessions", { prompt: `bench reply s${i}` }), "session create");
				sessionIds[i] = created.session.id;
				await answers.next(created.thread.id, options.timeoutMs);
				sessionAnswers.push(performance.now() - t0);
			}),
		);
		phases.push(phase("sessions", started, options.sessions, "sessions", sessionAnswers));

		// 2. Threads, C at a time, K user messages each.
		log(`threads: ${options.threads} threads of ${options.messages} messages, ${options.concurrency} at a time`);
		started = performance.now();
		const threadAnswers: number[] = [];
		await pool(
			Array.from({ length: options.threads }, (_, i) => i),
			options.concurrency,
			async (i) => {
				const session = sessionIds[i % sessionIds.length]!;
				let t0 = performance.now();
				const created = must(await call<Created>("POST", "/threads", { to: [session], body: `bench reply t${i}.1` }), "thread create");
				let answer = await answers.next(created.thread.id, options.timeoutMs);
				threadAnswers.push(performance.now() - t0);
				for (let k = 2; k <= options.messages; k++) {
					t0 = performance.now();
					must(
						await call("POST", `/threads/${created.thread.id}/messages`, { after: answer.messageId, body: `bench reply t${i}.${k}` }),
						"thread respond",
					);
					answer = await answers.next(created.thread.id, options.timeoutMs);
					threadAnswers.push(performance.now() - t0);
				}
			},
		);
		phases.push(phase("threads", started, options.threads * options.messages * 2, "messages", threadAnswers));

		// 3. Broadcast: each message wakes every session. They acknowledge with an empty answer, so
		// nothing is posted back and the thread's head stays the user's.
		if (options.broadcast > 0) {
			log(`broadcast: ${options.broadcast} messages to ${sessionIds.length} sessions`);
			started = performance.now();
			const posts: number[] = [];
			let t0 = performance.now();
			const created = must(await call<Created>("POST", "/threads", { to: sessionIds, body: "bench ack 1" }), "broadcast create");
			posts.push(performance.now() - t0);
			let head = created.message.id;
			for (let k = 2; k <= options.broadcast; k++) {
				t0 = performance.now();
				const next = must(
					await call<{ message: { id: string } }>("POST", `/threads/${created.thread.id}/messages`, { after: head, body: `bench ack ${k}` }),
					"broadcast respond",
				);
				posts.push(performance.now() - t0);
				head = next.message.id;
			}
			await settle(call, options.sessions, options.timeoutMs);
			phases.push({ ...phase("broadcast", started, options.broadcast * sessionIds.length, "wakes"), post: stats(posts) });
		}

		// 4. Fan-out: every root's tree, all at once.
		const perTree = treeSize(options.branch, options.spawnDepth);
		const expectedSessions = options.sessions + options.fanout * perTree;
		log(`fan-out: ${options.fanout} trees of ${perTree} sessions`);
		started = performance.now();
		await Promise.all(
			Array.from({ length: options.fanout }, async (_, i) => {
				const created = must(
					await call<Created>("POST", "/sessions", { prompt: `bench spawn ${options.spawnDepth} ${options.branch} f${i}` }),
					"fan-out create",
				);
				await answers.next(created.thread.id, options.timeoutMs);
			}),
		);
		await settle(call, expectedSessions, options.timeoutMs);
		phases.push(phase("fan-out", started, options.fanout * perTree, "sessions"));

		// 5. Lists: seed the inbox, then time every list route.
		if (options.listThreads > 0) {
			lists.push(...(await listPhase(call, sessionIds, options, log)));
		}
		rssEnd = await rssKb(child.process.pid!);
	} finally {
		sampling = false;
		await sampler;
		answers.close();
		await child.stop();
	}

	const lines = readLog(join(state, "panad.log"));
	const routes: BenchResult["routes"] = {};
	const byRoute = new Map<string, LoggedRequest[]>();
	for (const line of lines) {
		if (line.route === "events.stream") continue;
		const key = line.route ?? `${line.method} ?`;
		const list = byRoute.get(key) ?? [];
		list.push(line);
		byRoute.set(key, list);
	}
	for (const [route, list] of [...byRoute].sort(([a], [b]) => a.localeCompare(b))) {
		routes[route] = { ...stats(list.map((line) => line.durationMs)), failed: list.filter((line) => line.status >= 400).length };
	}

	const sqlite = join(state, "pana.sqlite");
	const dbBytes = ["", "-wal", "-shm"].reduce((sum, suffix) => sum + (existsSync(sqlite + suffix) ? statSync(sqlite + suffix).size : 0), 0);
	const expectedSessions = options.sessions + options.fanout * treeSize(options.branch, options.spawnDepth);
	const checks = [failedRequests(lines), ...checkDatabase(sqlite, { sessions: expectedSessions })];
	const { log: _log, ...printable } = options;
	const result: BenchResult = {
		options: printable,
		phases,
		routes,
		lists,
		requests: lines.length,
		rssPeakMb: Math.round(rssPeak / 102.4) / 10,
		rssEndMb: Math.round(rssEnd / 102.4) / 10,
		dbBytes,
		checks,
		ok: checks.every((check) => check.ok),
	};
	if (options.keep) result.stateDir = state;
	else rmSync(state, { recursive: true, force: true });
	return result;
}

function phase(name: string, started: number, units: number, unit: string, answers?: number[]): PhaseResult {
	const ms = Math.round(performance.now() - started);
	return {
		name,
		ms,
		units,
		unit,
		perSecond: Math.round((units / Math.max(ms, 1)) * 10_000) / 10,
		...(answers ? { answer: stats(answers) } : {}),
	};
}

type Call = <T>(method: string, path: string, body?: unknown, caller?: string) => Promise<ApiResponse<T>>;

/** Wait until every expected session exists and none is running. */
async function settle(call: Call, expected: number, timeoutMs: number): Promise<void> {
	const end = Date.now() + timeoutMs;
	for (;;) {
		const busy = must(await call<{ sessions: unknown[] }>("GET", "/sessions?state=running&limit=1"), "session list");
		const waiting = must(await call<{ sessions: unknown[] }>("GET", "/sessions?state=waiting&limit=1"), "session list");
		const total = busy.sessions.length + waiting.sessions.length === 0 ? await countSessions(call) : 0;
		if (total >= expected) return;
		if (Date.now() > end) throw new Error(`sessions did not settle: ${total} of ${expected} sessions`);
		await sleep(200);
	}
}

/** Every session, a page at a time. Before SCALE-03 the route ignores the cursor. */
async function countSessions(call: Call): Promise<number> {
	let total = 0;
	let cursor: string | undefined;
	do {
		const body = must(
			await call<{ sessions: unknown[]; nextCursor?: string | null }>("GET", `/sessions?limit=500${cursor ? `&cursor=${cursor}` : ""}`),
			"session list",
		);
		total += body.sessions.length;
		cursor = body.nextCursor ?? undefined;
	} while (cursor !== undefined);
	return total;
}

function readLog(path: string): LoggedRequest[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as LoggedRequest);
}

// --- SCALE-03: lists --------------------------------------------------------------

const LIST_ROUTES = ["/inbox", "/threads", "/sessions", "/schedules"] as const;
const LIST_KEYS: Record<(typeof LIST_ROUTES)[number], string> = {
	"/inbox": "deliveries",
	"/threads": "threads",
	"/sessions": "sessions",
	"/schedules": "schedules",
};

interface Page {
	items: unknown[];
	nextCursor?: string | null;
}

async function listPhase(call: Call, sessionIds: readonly string[], options: BenchOptions, log: (line: string) => void): Promise<ListResult[]> {
	// Every session made so far started one thread, and so did the broadcast.
	const made = options.sessions + options.threads + (options.broadcast > 0 ? 1 : 0) + options.fanout * treeSize(options.branch, options.spawnDepth);
	const seed = Math.max(0, options.listThreads - made);
	log(`lists: seeding ${seed} threads and 200 schedules`);
	// A session posts to the user, so the inbox grows and no session wakes.
	await pool(
		Array.from({ length: seed }, (_, i) => i),
		options.concurrency,
		async (i) => {
			must(await call("POST", "/threads", { to: [USER], body: `bench seed ${i}` }, sessionIds[i % sessionIds.length]), "seed thread");
		},
	);
	await pool(
		Array.from({ length: 200 }, (_, i) => i),
		options.concurrency,
		async (i) => {
			must(
				await call("POST", "/schedules", { kind: "thread", at: new Date(Date.now() + 86_400_000 * (i + 1)).toISOString(), to: [USER], body: `bench schedule ${i}` }),
				"schedule create",
			);
		},
	);

	const out: ListResult[] = [];
	for (const route of LIST_ROUTES) {
		const key = LIST_KEYS[route];
		const first: number[] = [];
		let bytes = 0;
		for (let i = 0; i < options.listSamples; i++) {
			const t0 = performance.now();
			const res = must(await call<Record<string, unknown>>("GET", `${route}?limit=${options.pageSize}`), route);
			first.push(performance.now() - t0);
			bytes = res && typeof res === "object" ? JSON.stringify(res).length : 0;
		}
		const pages: number[] = [];
		let total = 0;
		let cursor: string | undefined;
		const seen = new Set<string>();
		do {
			const query = `limit=${options.pageSize}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
			const t0 = performance.now();
			const body = must(await call<Record<string, unknown> & Page>("GET", `${route}?${query}`), route);
			pages.push(performance.now() - t0);
			const items = (body[key] as Array<{ id?: string; threadId?: string }>) ?? [];
			for (const item of items) seen.add(String(item.id ?? item.threadId));
			total += items.length;
			const next = body.nextCursor;
			// Before SCALE-03 the routes ignore the cursor; one page is the whole answer.
			cursor = typeof next === "string" && next.length > 0 && items.length > 0 ? next : undefined;
		} while (cursor !== undefined && pages.length < 10_000);
		if (seen.size !== total) throw new Error(`${route}: ${total} items but ${seen.size} distinct while paging`);
		out.push({ route, total, firstPage: stats(first), pages: stats(pages), pageCount: pages.length, bytes });
		log(`lists: ${route} ${total} items, first page p99 ${stats(first).p99} ms`);
	}
	return out;
}

// --- Report ---------------------------------------------------------------------

export function formatReport(result: BenchResult): string {
	const lines: string[] = [];
	const o = result.options;
	lines.push(
		`pana bench: N=${o.sessions} sessions, M=${o.threads} threads x K=${o.messages} messages, broadcast ${o.broadcast}, fan-out ${o.fanout} x B=${o.branch} to depth ${o.spawnDepth}, C=${o.concurrency}, model ${o.latencyMs} ms`,
		"",
		"phase      time (s)  units               rate/s   answer p50 / p99 (ms)",
	);
	for (const p of result.phases) {
		const answer = p.answer ? `${p.answer.p50} / ${p.answer.p99}` : p.post ? `post ${p.post.p50} / ${p.post.p99}` : "";
		lines.push(
			`${p.name.padEnd(10)} ${(p.ms / 1000).toFixed(1).padStart(8)}  ${`${p.units} ${p.unit}`.padEnd(18)} ${String(p.perSecond).padStart(7)}   ${answer}`,
		);
	}
	lines.push("", "route                    count      p50 ms    p99 ms    max ms  failed");
	for (const [route, s] of Object.entries(result.routes)) {
		lines.push(
			`${route.padEnd(22)} ${String(s.count).padStart(7)} ${String(s.p50).padStart(11)} ${String(s.p99).padStart(9)} ${String(s.max).padStart(9)} ${String(s.failed).padStart(7)}`,
		);
	}
	if (result.lists.length > 0) {
		lines.push("", "list         items  first page p50 / p99 (ms)  pages  page p99 (ms)  first page bytes");
		for (const l of result.lists) {
			lines.push(
				`${l.route.padEnd(11)} ${String(l.total).padStart(6)}  ${`${l.firstPage.p50} / ${l.firstPage.p99}`.padEnd(26)} ${String(l.pageCount).padStart(5)}  ${String(l.pages.p99).padStart(13)}  ${l.bytes}`,
			);
		}
	}
	lines.push(
		"",
		`requests ${result.requests}, panad RSS peak ${result.rssPeakMb} MB, end ${result.rssEndMb} MB, database ${(result.dbBytes / 1048576).toFixed(1)} MB`,
		"",
	);
	for (const check of result.checks) {
		lines.push(`${check.ok ? "ok  " : "FAIL"} ${check.name} (${check.checked})`);
		for (const failure of check.failures) lines.push(`       ${JSON.stringify(failure)}`);
	}
	if (result.stateDir) lines.push("", `state kept at ${result.stateDir}`);
	return `${lines.join("\n")}\n`;
}
