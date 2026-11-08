// `pana stats requests` in a terminal (OBS-02): one table of routes, one of client samples, and
// the slowest requests named. JSON output is the route's own body, so a script reads the same
// fields a reader does.
//
// Every string here can come from a log file, so names go through `sanitizeTerminalText` before
// they are printed, the same way message text does (CLI-08).

import { sanitizeTerminalText } from "../cli/sanitize.ts";

interface Bucket {
	count?: number;
	errors?: number;
	p50?: number;
	p95?: number;
	p99?: number;
	max?: number;
	mean?: number;
}

interface Summary {
	window?: {
		from?: string | null;
		to?: string | null;
		count?: number;
		lines?: number;
		skipped?: number;
		truncated?: boolean;
		bytes?: number;
	};
	overall?: Bucket;
	routes?: Array<Bucket & { route?: string }>;
	statuses?: Record<string, number>;
	slowest?: Array<{ ts?: string; route?: string; durationMs?: number; status?: number }>;
	client?: {
		window?: Summary["window"];
		groups?: Array<Bucket & { kind?: string; name?: string }>;
	};
}

const CELL = 10;

/** A number of milliseconds, two decimals, right-aligned. */
function ms(value: number | undefined): string {
	return (typeof value === "number" ? value.toFixed(2) : "-").padStart(CELL);
}

/** A count, right-aligned. */
function num(value: number | undefined): string {
	return (typeof value === "number" ? String(value) : "-").padStart(7);
}

/** Bytes as a short unit, for saying how much of a log was read. */
function bytes(value: number | undefined): string {
	if (typeof value !== "number") return "an unknown number of bytes";
	if (value < 1024) return `${value} B`;
	if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
	return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function pad(text: string, width: number): string {
	return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function header(width: number): string {
	return `${pad("name", width)}  count errors     p50      p95      p99      max     mean`;
}

function row(name: string, bucket: Bucket, width: number): string {
	return `${pad(name, width)}  ${num(bucket.count)}${num(bucket.errors)}${ms(bucket.p50)}${ms(bucket.p95)}${ms(bucket.p99)}${ms(bucket.max)}${ms(bucket.mean)}`;
}

/** The summary as a person reads it: the window, the routes, the browser's samples, the slowest calls. */
export function renderStatsText(value: unknown): string {
	if (typeof value !== "object" || value === null) return "";
	const summary = value as Summary;
	const window = summary.window ?? {};
	const lines: string[] = [];
	const from = window.from ?? "-";
	const to = window.to ?? "-";
	lines.push(`window   ${from} .. ${to}`);
	const errors = summary.overall?.errors ?? 0;
	const rates = summary.statuses ?? {};
	const failed = Object.entries(rates)
		.filter(([status]) => Number(status) >= 400)
		.sort(([a], [b]) => Number(a) - Number(b))
		.map(([status, count]) => `${status} ${count}`);
	lines.push(`reads    ${window.count ?? 0} requests from ${bytes(window.bytes)} of the log${window.truncated ? " (older entries are past the read cap and not counted)" : ""}`);
	lines.push(
		`errors   ${errors}${errors > 0 && summary.overall?.count ? ` (${((errors / summary.overall.count) * 100).toFixed(1)}%)` : ""}${failed.length > 0 ? `: ${failed.join(", ")}` : ""}`,
	);
	if (window.skipped) lines.push(`skipped  ${window.skipped} lines that are not entries`);
	const overall = summary.overall;
	if (overall && (overall.count ?? 0) > 0) {
		lines.push(`all      p50 ${ms(overall.p50).trim()}  p95 ${ms(overall.p95).trim()}  p99 ${ms(overall.p99).trim()}  max ${ms(overall.max).trim()} ms`);
	}
	const routes = (summary.routes ?? []).filter((route) => route.route !== undefined);
	if (routes.length > 0) {
		lines.push("");
		lines.push("server");
		const width = Math.max(4, ...routes.map((route) => sanitizeTerminalText(route.route ?? "").length));
		lines.push(header(width));
		for (const route of routes) lines.push(row(sanitizeTerminalText(route.route ?? ""), route, width));
	}
	const groups = (summary.client?.groups ?? []).filter((group) => group.kind !== undefined);
	if (groups.length > 0) {
		lines.push("");
		lines.push(`client   ${summary.client?.window?.count ?? 0} samples from ${bytes(summary.client?.window?.bytes)} of client.log`);
		const names = groups.map((group) => sanitizeTerminalText(`${group.kind ?? ""} ${group.name ?? ""}`));
		const width = Math.max(4, ...names.map((name) => name.length));
		lines.push(header(width));
		for (const [index, group] of groups.entries()) lines.push(row(names[index]!, group, width));
	} else {
		lines.push("");
		lines.push("client   no samples; the PWA posts them as it is used (OBS-03)");
	}
	const slowest = (summary.slowest ?? []).slice(0, 10);
	if (slowest.length > 0) {
		lines.push("");
		lines.push("slowest");
		for (const entry of slowest) {
			lines.push(`${entry.ts ?? "-"}  ${pad(sanitizeTerminalText(entry.route ?? "-"), 20)}  ${ms(entry.durationMs).trim().padStart(9)} ms  ${entry.status ?? "-"}`);
		}
	}
	return `${lines.join("\n")}\n`;
}
