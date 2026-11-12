// The `pana stats` command table (OBS-02), beside the package it commands, the way
// `src/objectives/cli.ts` holds its own. `src/cli/commands.ts` spreads `STATS_COMMANDS` once.

import type { CommandParams, CommandSpec } from "../cli/commands.ts";
import { renderStatsText } from "./text.ts";

function text(params: CommandParams, name: string): string | undefined {
	const value = params[name];
	return typeof value === "string" ? value : undefined;
}

/** Keep only the keys a request carries, so absent flags stay out of the query. */
function compact(fields: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(fields)) {
		if (value !== undefined) out[key] = value;
	}
	return out;
}

export const STATS_COMMANDS: readonly CommandSpec[] = [
	{ path: ["stats", "artifacts"], usage: "pana stats artifacts", summary: "Cumulative artifact bytes, overall and per thread", flags: [], positionals: [], request: () => ({method: "GET", path: "/stats/artifacts"}) },
	{
		path: ["stats", "requests"],
		usage: "pana stats requests [--since SPAN] [--route ROUTE] [--name NAME]",
		summary: "Counts, errors, and p50/p95/p99 latency per route from panad's request log, plus the PWA's own samples",
		flags: [
			{ name: "since", syntax: "--since SPAN", type: "string", description: "Only entries newer than an ISO time or a span such as 90s, 30m, 24h, 7d" },
			{ name: "route", syntax: "--route ROUTE", type: "string", description: "Only this server route, e.g. threads.respond" },
			{ name: "name", syntax: "--name NAME", type: "string", description: "Only this client sample name, e.g. api inbox.list" },
		],
		positionals: [],
		request: (params) => ({
			method: "GET",
			path: "/stats/requests",
			query: compact({ since: text(params, "since"), route: text(params, "route"), name: text(params, "name") }) as Record<string, string>,
		}),
		formatText: (value) => renderStatsText(value),
	},
];
