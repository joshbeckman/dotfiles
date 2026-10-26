// The real panad entry point with the bench's faux model (SCALE-01). `scripts/bench` runs it as
// a child process:
//
//   PANA_STATE=DIR PANA_BENCH_LATENCY_MS=20 node test/bench/panad.ts

import { main } from "../../src/server/index.ts";
import { createBenchModels } from "./model.ts";
import { recordSql } from "./sqlstats.ts";

if (process.env.PANA_BENCH_SQL) recordSql(process.env.PANA_BENCH_SQL);

// SIGUSR2 prints memory after a full collection (run with --expose-gc), to tell live heap from
// garbage in the RSS the bench reports.
process.on("SIGUSR2", () => {
	(globalThis as { gc?: () => void }).gc?.();
	const mb = (n: number) => Math.round(n / 1048576);
	const { rss, heapTotal, heapUsed, external, arrayBuffers } = process.memoryUsage();
	console.error(`panad memory MB: rss ${mb(rss)} heapTotal ${mb(heapTotal)} heapUsed ${mb(heapUsed)} external ${mb(external)} arrayBuffers ${mb(arrayBuffers)}`);
});

const latencyMs = Number(process.env.PANA_BENCH_LATENCY_MS ?? 0);
const models = createBenchModels({ latencyMs: Number.isFinite(latencyMs) ? latencyMs : 0 });

// PANA_BENCH_SETTINGS overrides pi-durable settings, for trying one change without editing panad.
const settings = process.env.PANA_BENCH_SETTINGS ? JSON.parse(process.env.PANA_BENCH_SETTINGS) : undefined;

process.exit(await main(process.argv.slice(2), { models, tailscaleNames: [], ...(settings ? { settings } : {}) }));
