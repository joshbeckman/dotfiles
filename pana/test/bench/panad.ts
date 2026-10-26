// The real panad entry point with the bench's faux model (SCALE-01). `scripts/bench` runs it as
// a child process:
//
//   PANA_STATE=DIR PANA_BENCH_LATENCY_MS=20 node test/bench/panad.ts

import { main } from "../../src/server/index.ts";
import { createBenchModels } from "./model.ts";
import { recordSql } from "./sqlstats.ts";

if (process.env.PANA_BENCH_SQL) recordSql(process.env.PANA_BENCH_SQL);

const latencyMs = Number(process.env.PANA_BENCH_LATENCY_MS ?? 0);
const models = createBenchModels({ latencyMs: Number.isFinite(latencyMs) ? latencyMs : 0 });

// PANA_BENCH_SETTINGS overrides pi-durable settings, for trying one change without editing panad.
const settings = process.env.PANA_BENCH_SETTINGS ? JSON.parse(process.env.PANA_BENCH_SETTINGS) : undefined;

process.exit(await main(process.argv.slice(2), { models, tailscaleNames: [], ...(settings ? { settings } : {}) }));
