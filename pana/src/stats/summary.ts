// What the logs add up to (OBS-01, OBS-05). One pass over a window of entries, one bucket per
// route or per client sample name: count, errors, p50, p95, p99, max, and mean.
//
// Percentiles are nearest-rank over the window's own samples on that route. A route with three
// requests reports its three, so every reading carries its `count`; a window with nothing in it
// reports zero requests and no routes rather than a latency of zero.

import { readLogTail } from "./log.ts";

export interface RequestEntry {
	ts: number;
	route: string;
	status: number;
	durationMs: number;
	method?: string;
	path?: string;
	transport?: string;
	caller?: string | null;
}

export interface ClientEntry {
	ts: number;
	kind: ClientKind;
	name: string;
	durationMs: number;
	status?: number;
}

export const CLIENT_KINDS = ["api", "view", "longtask"] as const;
export type ClientKind = (typeof CLIENT_KINDS)[number];

/** One measure of a set of samples. `durationMs` fields are milliseconds. */
export interface Bucket {
	count: number;
	errors: number;
	p50: number;
	p95: number;
	p99: number;
	max: number;
	mean: number;
}

export interface RouteBucket extends Bucket {
	route: string;
}

export interface ClientBucket extends Bucket {
	kind: ClientKind;
	name: string;
}

export interface WindowInfo {
	/** ISO timestamp of the oldest entry read, or null when the window is empty. */
	from: string | null;
	/** ISO timestamp of the newest entry read, or null when the window is empty. */
	to: string | null;
	/** Entries in the window, after `since` and `route` filtering. */
	count: number;
	/** Lines read from the file, before filtering. */
	lines: number;
	/** Lines that were not valid entries, so they were skipped rather than counted. */
	skipped: number;
	/** True when the file is longer than the read cap, so this is the newest part of it only. */
	truncated: boolean;
	/** Bytes read from the file. */
	bytes: number;
}

export interface RequestSummary {
	window: WindowInfo;
	overall: Bucket;
	routes: RouteBucket[];
	statuses: Record<string, number>;
	slowest: Array<{ ts: string; route: string; durationMs: number; status: number }>;
}

export interface ClientSummary {
	window: WindowInfo;
	groups: ClientBucket[];
}

/**
 * Nearest-rank percentile of an ascending array: the sample at `ceil(p * n)`, counting from 1.
 * Empty is 0, and callers report the count. With two samples the median is the lower of them,
 * which is the definition nearest-rank uses rather than an interpolation.
 */
export function percentile(ascending: readonly number[], p: number): number {
	if (ascending.length === 0) return 0;
	const index = Math.max(0, Math.ceil(p * ascending.length) - 1);
	return ascending[Math.min(ascending.length - 1, index)]!;
}

/** Count, errors, percentiles, and mean over one set of samples. */
export function bucketOf(durations: readonly number[], errors: number): Bucket {
	if (durations.length === 0) return { count: 0, errors, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
	const sorted = [...durations].sort((a, b) => a - b);
	const sum = sorted.reduce((total, value) => total + value, 0);
	return {
		count: sorted.length,
		errors,
		p50: percentile(sorted, 0.5),
		p95: percentile(sorted, 0.95),
		p99: percentile(sorted, 0.99),
		max: sorted[sorted.length - 1]!,
		mean: sum / sorted.length,
	};
}

/** Milliseconds for a `since` value: an ISO timestamp, or a span such as `90s`, `10m`, `2h`, `7d`. */
export function parseSince(text: string | null | undefined, now: number): number | undefined {
	const value = (text ?? "").trim();
	if (value === "") return undefined;
	const span = /^(\d+)([smhd])$/.exec(value);
	if (span) {
		const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[span[2] as "s" | "m" | "h" | "d"];
		return now - Number(span[1]) * unit;
	}
	const at = Date.parse(value);
	if (Number.isNaN(at)) throw new Error(`not a time: ${value}; use an ISO timestamp or a span such as 24h`);
	return at;
}

/** Parse JSONL request lines. A line that is not a request entry is counted, not guessed at. */
export function parseRequestLines(lines: readonly string[]): { entries: RequestEntry[]; skipped: number } {
	const entries: RequestEntry[] = [];
	let skipped = 0;
	for (const line of lines) {
		if (line.trim() === "") continue;
		const entry = parseRequestLine(line);
		if (entry) entries.push(entry);
		else skipped++;
	}
	return { entries, skipped };
}

function parseRequestLine(line: string): RequestEntry | undefined {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	const ts = typeof record.ts === "string" ? Date.parse(record.ts) : Number.NaN;
	const durationMs = record.durationMs;
	const status = record.status;
	if (Number.isNaN(ts) || typeof durationMs !== "number" || !Number.isFinite(durationMs)) return undefined;
	if (typeof status !== "number") return undefined;
	const route = typeof record.route === "string" && record.route.length > 0 ? record.route : `raw ${String(record.path ?? "")}`.trim();
	return {
		ts,
		route,
		status,
		durationMs,
		...(typeof record.method === "string" ? { method: record.method } : {}),
		...(typeof record.path === "string" ? { path: record.path } : {}),
		...(typeof record.transport === "string" ? { transport: record.transport } : {}),
		...(typeof record.caller === "string" || record.caller === null ? { caller: record.caller as string | null } : {}),
	};
}

/** Parse JSONL client lines (OBS-03). */
export function parseClientLines(lines: readonly string[]): { entries: ClientEntry[]; skipped: number } {
	const entries: ClientEntry[] = [];
	let skipped = 0;
	for (const line of lines) {
		if (line.trim() === "") continue;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			skipped++;
			continue;
		}
		const record = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
		const ts = typeof record.ts === "string" ? Date.parse(record.ts) : Number.NaN;
		const kind = record.kind;
		const name = record.name;
		const durationMs = record.durationMs;
		if (
			Number.isNaN(ts) ||
			typeof name !== "string" ||
			name.length === 0 ||
			typeof durationMs !== "number" ||
			!Number.isFinite(durationMs) ||
			typeof kind !== "string" ||
			!(CLIENT_KINDS as readonly string[]).includes(kind)
		) {
			skipped++;
			continue;
		}
		entries.push({
			ts,
			kind: kind as ClientKind,
			name,
			durationMs,
			...(typeof record.status === "number" ? { status: record.status } : {}),
		});
	}
	return { entries, skipped };
}

function windowOf(entries: readonly { ts: number }[], lines: number, skipped: number, truncated: boolean, bytes: number): WindowInfo {
	let from: number | undefined;
	let to: number | undefined;
	for (const entry of entries) {
		if (from === undefined || entry.ts < from) from = entry.ts;
		if (to === undefined || entry.ts > to) to = entry.ts;
	}
	return {
		from: from === undefined ? null : new Date(from).toISOString(),
		to: to === undefined ? null : new Date(to).toISOString(),
		count: entries.length,
		lines,
		skipped,
		truncated,
		bytes,
	};
}

export interface RequestSummaryOptions {
	/** Include entries at or after this time, in epoch milliseconds. */
	since?: number;
	/** Only this route. */
	route?: string;
	/** How many of the slowest requests to name. Default 10. */
	slowest?: number;
	/** How many bytes of the log to read. Default `STATS_READ_BYTES`. */
	maxBytes?: number;
}

/** Summarize `<path>`: a request log written by `src/server/log.ts`. */
export async function summarizeRequestsFile(path: string, options: RequestSummaryOptions = {}): Promise<RequestSummary> {
	const tail = await readLogTail(path, options.maxBytes);
	const parsed = parseRequestLines(tail.lines);
	const entries = selectRequests(parsed.entries, options);
	return {
		window: windowOf(entries, tail.lines.length, parsed.skipped, tail.truncated, tail.bytes),
		...summarizeRequests(entries, options.slowest ?? 10),
	};
}

/** Apply the `since` and `route` filters. */
export function selectRequests(entries: readonly RequestEntry[], options: RequestSummaryOptions): RequestEntry[] {
	return entries.filter(
		(entry) => (options.since === undefined || entry.ts >= options.since) && (options.route === undefined || entry.route === options.route),
	);
}

/** The per-route and overall readings for the entries given. */
export function summarizeRequests(
	entries: readonly RequestEntry[],
	slowest = 10,
): Pick<RequestSummary, "overall" | "routes" | "statuses" | "slowest"> {
	const byRoute = new Map<string, { durations: number[]; errors: number }>();
	const statuses: Record<string, number> = {};
	const all: number[] = [];
	let totalErrors = 0;
	for (const entry of entries) {
		const group = byRoute.get(entry.route) ?? { durations: [], errors: 0 };
		group.durations.push(entry.durationMs);
		const failed = entry.status >= 400;
		if (failed) {
			group.errors++;
			totalErrors++;
		}
		byRoute.set(entry.route, group);
		all.push(entry.durationMs);
		statuses[String(entry.status)] = (statuses[String(entry.status)] ?? 0) + 1;
	}
	const routes: RouteBucket[] = [...byRoute.entries()]
		.map(([route, group]) => ({ route, ...bucketOf(group.durations, group.errors) }))
		// The purpose of the list is finding where time goes, so the worst p99 leads. Count breaks ties.
		.sort((a, b) => b.p99 - a.p99 || b.count - a.count || a.route.localeCompare(b.route));
	return {
		overall: bucketOf(all, totalErrors),
		routes,
		statuses,
		slowest: [...entries]
			.sort((a, b) => b.durationMs - a.durationMs)
			.slice(0, Math.max(0, slowest))
			.map((entry) => ({ ts: new Date(entry.ts).toISOString(), route: entry.route, durationMs: entry.durationMs, status: entry.status })),
	};
}

export interface ClientSummaryOptions {
	since?: number;
	/** Only this sample name. */
	name?: string;
	maxBytes?: number;
}

/** Summarize `<path>`: the client log written by `stats.client` (OBS-03, OBS-04). */
export async function summarizeClientFile(path: string, options: ClientSummaryOptions = {}): Promise<ClientSummary> {
	const tail = await readLogTail(path, options.maxBytes);
	const parsed = parseClientLines(tail.lines);
	const entries = parsed.entries.filter(
		(entry) => (options.since === undefined || entry.ts >= options.since) && (options.name === undefined || entry.name === options.name),
	);
	const groups = new Map<string, { kind: ClientKind; name: string; durations: number[]; errors: number }>();
	for (const entry of entries) {
		const key = `${entry.kind}\u0000${entry.name}`;
		const group = groups.get(key) ?? { kind: entry.kind, name: entry.name, durations: [], errors: 0 };
		group.durations.push(entry.durationMs);
		if (entry.status !== undefined && entry.status >= 400) group.errors++;
		groups.set(key, group);
	}
	return {
		window: windowOf(entries, tail.lines.length, parsed.skipped, tail.truncated, tail.bytes),
		groups: [...groups.values()]
			.map((group) => ({ kind: group.kind, name: group.name, ...bucketOf(group.durations, group.errors) }))
			.sort((a, b) => b.p99 - a.p99 || b.count - a.count || a.name.localeCompare(b.name)),
	};
}
