// `scripts/bench` arguments and output (SCALE-01).

import { DEFAULTS, formatReport, runBench, type BenchOptions } from "./bench.ts";

const FLAGS: Record<string, keyof BenchOptions> = {
	"--sessions": "sessions",
	"--threads": "threads",
	"--messages": "messages",
	"--broadcast": "broadcast",
	"--fanout": "fanout",
	"--branch": "branch",
	"--spawn-depth": "spawnDepth",
	"--concurrency": "concurrency",
	"--latency-ms": "latencyMs",
	"--list-threads": "listThreads",
	"--list-samples": "listSamples",
	"--page-size": "pageSize",
	"--timeout-ms": "timeoutMs",
};

export const USAGE = `Usage: pana/scripts/bench [options]

Start a throwaway panad with a faux model, drive it through its socket, stop it, and check the
database. Prints throughput, latency per route, panad RSS, and database size. Exits 1 when a
check fails.

Options (defaults in brackets):
  --sessions N       sessions created at once [${DEFAULTS.sessions}]
  --threads M        threads between the user and those sessions [${DEFAULTS.threads}]
  --messages K       user messages per thread, each answered [${DEFAULTS.messages}]
  --broadcast R      messages to one thread with every session [${DEFAULTS.broadcast}]
  --fanout F         sessions that create child sessions [${DEFAULTS.fanout}]
  --branch B         children each of those creates per level [${DEFAULTS.branch}]
  --spawn-depth D    config spawnDepth, the depth of each fan-out tree [${DEFAULTS.spawnDepth}]
  --concurrency C    threads in flight at once [${DEFAULTS.concurrency}]
  --latency-ms MS    faux model latency per request [${DEFAULTS.latencyMs}]
  --list-threads T   grow the inbox to T threads, then time the list routes [off]
  --list-samples S   timed first-page requests per list route [${DEFAULTS.listSamples}]
  --page-size P      list page size [${DEFAULTS.pageSize}]
  --timeout-ms MS    give up waiting for an answer after this long [${DEFAULTS.timeoutMs}]
  --json             print the result as JSON
  --keep             keep the state directory
  -h, --help         show this help
`;

export async function main(argv: string[]): Promise<number> {
	const options: Partial<BenchOptions> = {};
	let json = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "-h" || arg === "--help") {
			process.stdout.write(USAGE);
			return 0;
		}
		if (arg === "--json") json = true;
		else if (arg === "--keep") options.keep = true;
		else if (arg in FLAGS) {
			const value = Number(argv[++i]);
			if (!Number.isInteger(value) || value < 0) {
				process.stderr.write(`bench: ${arg} needs a non-negative integer\n${USAGE}`);
				return 2;
			}
			(options as Record<string, number>)[FLAGS[arg]!] = value;
		} else {
			process.stderr.write(`bench: unknown argument: ${arg}\n${USAGE}`);
			return 2;
		}
	}
	if ((options.sessions ?? DEFAULTS.sessions) < 1) {
		process.stderr.write("bench: --sessions must be at least 1\n");
		return 2;
	}
	const started = Date.now();
	let result;
	try {
		result = await runBench({ ...options, log: (line) => process.stderr.write(`bench: ${line} (${((Date.now() - started) / 1000).toFixed(1)} s)\n`) });
	} catch (error) {
		process.stderr.write(`bench: failed: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
	process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : formatReport(result));
	return result.ok ? 0 : 1;
}
