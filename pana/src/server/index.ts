// panad: open the state directory, the shared database, and the Harness, then serve the API
// on the Unix socket and on loopback TCP. WP1 owns the request log (SRV-01), graceful shutdown
// on SIGTERM (SRV-02), resuming work a previous process left behind (SRV-03), and reporting a
// daemon that stopped without being asked to (SRV-04).

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import { Harness, type HarnessOptions, type HarnessSettings, type Registry } from "@earendil-works/pi-durable";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Handlers } from "../api/types.ts";
import { ConfigError, ensureStateLayout, loadConfig, readWebToken, stateDir as defaultStateDir } from "../config/index.ts";
import { openSharedDatabase } from "../db/index.ts";
import { sweepWakes, type WakeSubmitter } from "../db/outbox.ts";
import { createPanaEnv, createPanaRegistry } from "../extension/index.ts";
import { ensureMemoryRepo } from "../memory/index.ts";
import { startMetricChecks } from "../objectives/index.ts";
import { startObjectiveSweeper } from "../objectives/sweep.ts";
import { initPush } from "../push/index.ts";
import { startScheduler } from "../schedules/index.ts";
import { startSessions } from "../sessions/runtime.ts";
import { defaultWakeSubmitter } from "../sessions/wake.ts";
import { launchUrl, loopbackOrigin } from "../web/static.ts";
import { createApp, type RequestLogEntry } from "./app.ts";
import { defaultHandlers } from "./handlers.ts";
import { acquirePidLock } from "./lock.ts";
import { createRequestLogger } from "./log.ts";
import { createProviderModels, hasModel } from "./models.ts";
import { withAuthRetries } from "./retry.ts";
import { detectTailscaleNames } from "./tailscale.ts";
import { createIdFactory, systemClock, urlHelpers, type Clock, type Runtime } from "./runtime.ts";
import { startScratchSweeper } from "../scratch/index.ts";
import { startBrowserSweeper, type SweepBrowsersOptions } from "../extension/browser.ts";

export interface StartOptions {
	/** State directory; default `PANA_STATE` or `~/.local/state/pana` (CFG-01). */
	stateDir?: string;
	clock?: Clock;
	/** Default: every pi-ai provider with credentials in panad's environment (INT-01). */
	models?: Models;
	/** Default: the pana registry, `CodingTools` and `pana` only (ISO-01). */
	registry?: Registry;
	/** Default: the clean pana environment for every session (ISO-03). */
	env?: HarnessOptions["env"];
	settings?: HarnessSettings;
	/** Merged over the packages' handlers. */
	handlers?: Handlers;
	/** TCP port; default `http.port` from config. 0 picks a free port. `false` disables TCP. */
	tcpPort?: number | false;
	tailscaleNames?: readonly string[];
	/** Replaces the WP3 wake submitter. */
	wake?: (runtime: () => Runtime) => WakeSubmitter;
	/** Override browser discovery/stopping for isolated test domains. Defaults to the real CLI. */
	browserSweep?: SweepBrowsersOptions;
	/** Memory may be ahead of disk (see src/db/atomic.ts). Default: log and exit 1. */
	onFatal?: (error: unknown) => void;
	onRequest?: (entry: RequestLogEntry) => void;
	/** Write `<state>/panad.log` (SRV-01). Default true. */
	requestLog?: boolean;
	/** Failures that do not stop panad, such as a wake the startup sweep could not submit. */
	onReport?: (error: unknown, what: string) => void;
}

export interface Panad {
	runtime: Runtime;
	socketPath: string;
	/** Bound TCP port, or undefined when TCP is off. */
	tcpPort: number | undefined;
	webToken: string;
	close(): Promise<void>;
}

/** Start panad. Throws `ConfigError` with the exit code for config and lock failures. */
export async function startPanad(options: StartOptions = {}): Promise<Panad> {
	const dir = options.stateDir ?? defaultStateDir();
	const config = loadConfig(dir);
	const paths = ensureStateLayout(dir);
	const releaseLock = acquirePidLock(paths.pidFile);
	const cleanup: Array<() => Promise<void> | void> = [releaseLock];

	try {
		const clock = options.clock ?? systemClock;
		const onFatal =
			options.onFatal ??
			((error: unknown) => {
				console.error(`panad: fatal: ${error instanceof Error ? error.message : String(error)}`);
				process.exit(1);
			});
		const report = options.onReport ?? ((error, what) => console.error(`panad: ${what}:`, error));

		// MEM-01: memory.git exists as a bare repo with one empty commit on main before the first
		// memory request. WP5 owns the implementation; this is its only startup hook.
		await ensureMemoryRepo(paths.memoryGit, {
			domain: config.domain,
			worktreesDir: paths.memoryWorktrees,
			now: () => clock.now(),
		});

		const { db, storage } = await openSharedDatabase(paths.sqlite, { onFatal });
		const models = withAuthRetries(options.models ?? (await createProviderModels(process.env)));
		const getRuntime = () => runtime;
		const registry = options.registry ?? createPanaRegistry(getRuntime);
		const env = options.env ?? createPanaEnv(getRuntime);
		const settings = panaSettings(options.settings);
		const harness = await Harness.open(
			storage,
			{
				models,
				registry,
				env,
				settings,
				now: () => clock.now(),
				setTimer: clock.setTimer,
				onReport: (error, info) => report(error, `pi-durable ${info.type}`),
			},
			BACKGROUND_CONTEXT,
		);
		cleanup.unshift(() => harness.close(BACKGROUND_CONTEXT));

		let runtime!: Runtime;
		runtime = {
			config,
			paths,
			db,
			harness,
			models,
			registry,
			settings,
			clock,
			newId: createIdFactory(clock),
			...urlHelpers(config.domain, config.user),
			wake: (options.wake ?? defaultWakeSubmitter)(getRuntime),
		};

		// PSH-01: the VAPID pair exists before the first push, not on the first request.
		initPush(runtime);

		// WP3: the delivery hook and the run listener must be in place before any wake or run.
		const sessions = startSessions(runtime, report);
		cleanup.unshift(() => sessions.close());
		// Finish wakes a crash interrupted, then pick up runs the last process left pending (SRV-03).
		await sweepWakes(db, runtime.wake, (error, wake) => report(error, `wake for delivery ${wake.deliveryId}`));
		harness.resume();
		sessions.recover();

		const webToken = readWebToken(dir);
		const logger =
			options.requestLog === false
				? undefined
				: createRequestLogger(paths.log, { now: () => clock.now(), onError: (error) => report(error, "request log") });
		const appOptions = {
			runtime,
			handlers: { ...defaultHandlers, ...options.handlers },
			webToken,
			tailscaleNames: options.tailscaleNames,
			onRequest: (entry: RequestLogEntry) => {
				logger?.(entry);
				options.onRequest?.(entry);
			},
		};

		// WP6: recover runs missed while panad was down, then arm the timer on `runtime.clock`.
		const scheduler = await startScheduler({
			runtime,
			handlers: appOptions.handlers,
			onReport: (error, what) => report(error, what),
		});
		cleanup.unshift(() => scheduler.close());
		// WP18/OBJ-26: metric checks run on the same clock with no session, so a daily measurement
		// costs nothing and needs no agent awake. They add no schedule kind.
		const checks = startMetricChecks(runtime, (error, what) => report(error, what));
		cleanup.unshift(() => checks.close());
		// SCR-05: sweep scratch now, then daily.
		const sweeper = startScratchSweeper(runtime, report);
		cleanup.unshift(() => sweeper.close());
		// ISO-07: stop the browser daemons of sessions that are archived or idle.
		const browsers = startBrowserSweeper(runtime, report, options.browserSweep);
		cleanup.unshift(() => browsers.close());
		// OBJ-06, OBJ-08: notice a stranded or a behind objective, now and every five minutes.
		// A budget pause already reads as `idle` in `objectiveState` (OBJ-22), so nothing is wired
		// into the sweeper's unused `budget` hook here.
		// TODO(WP18): drop or wire `ObjectiveSweepOptions.budget` in the integration pass.
		const objectives = startObjectiveSweeper(runtime, report);
		cleanup.unshift(() => objectives.close());

		if (existsSync(paths.socket)) unlinkSync(paths.socket);
		const socketServer = createServer(createApp(appOptions, "socket"));
		await listen(socketServer, (s, done) => s.listen(paths.socket, done));
		chmodSync(paths.socket, 0o600);
		cleanup.unshift(() => closeServer(socketServer), () => {
			if (existsSync(paths.socket)) unlinkSync(paths.socket);
		});

		let tcpPort: number | undefined;
		const port = options.tcpPort ?? config.http.port;
		if (port !== false) {
			const tcpServer = createServer(createApp(appOptions, "tcp"));
			await listen(tcpServer, (s, done) => s.listen(port, "127.0.0.1", done));
			tcpPort = (tcpServer.address() as AddressInfo).port;
			cleanup.unshift(() => closeServer(tcpServer));
		}

		let closing: Promise<void> | undefined;
		return {
			runtime,
			socketPath: paths.socket,
			tcpPort,
			webToken,
			close: () => (closing ??= runCleanup(cleanup)),
		};
	} catch (error) {
		await runCleanup(cleanup);
		throw error;
	}
}

/**
 * How long pi-durable keeps an idle conversation's context in memory. Pana drops it at once, so an
 * idle session costs nothing but storage, as the README promises.
 *
 * pi-durable's default is ten minutes. Under the bench, every context it keeps is checked again on
 * each task change, so 1000 recently active sessions cost a third of the message throughput and
 * 240 MB of RSS (BENCH.md). The price of 0 is that a session's next run reads its transcript back
 * from SQLite, which takes milliseconds against a model call of seconds.
 */
export const CONTEXT_RETENTION_MS = 0;

/**
 * The caller's settings with pana's default retention and bounded model retries. Getters keep
 * caller settings live, as pi-durable reads them at every use. Fifteen retries means sixteen
 * attempts total, with the existing 2s exponential backoff capped at 60s.
 */
export function panaSettings(base: HarnessSettings = {}): HarnessSettings {
	return Object.create(base, {
		contextRetentionMs: { enumerable: true, get: () => base.contextRetentionMs ?? CONTEXT_RETENTION_MS },
		retry: {
			enumerable: true,
			get: () => ({ enabled: true, maxRetries: 15, baseDelayMs: 2000, maxAgentDelayMs: 60_000, ...base.retry }),
		},
	}) as HarnessSettings;
}

async function runCleanup(steps: Array<() => Promise<void> | void>): Promise<void> {
	let first: unknown;
	for (const step of steps) {
		try {
			await step();
		} catch (error) {
			first ??= error;
		}
	}
	if (first !== undefined) throw first;
}

function listen(server: Server, start: (server: Server, done: () => void) => void): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		start(server, () => {
			server.off("error", reject);
			resolve();
		});
	});
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve) => {
		// `close` stops accepting first; a connection that never goes idle, such as an open event
		// stream, must not hold up a shutdown forever, so it is cut after a short grace period.
		const force = setTimeout(() => server.closeAllConnections(), 250);
		force.unref();
		server.close(() => {
			clearTimeout(force);
			resolve();
		});
		server.closeIdleConnections();
	});
}

/**
 * SRV-04: a stop request is the only clean exit. If the event loop ends without one, the daemon
 * stopped serving while nobody asked it to, and a service manager that restarts on failure is
 * the only thing that brings it back: `Restart=on-failure` and launchd's `SuccessfulExit=false`
 * both key on a non-zero code. One panad on this machine left exactly that way, exit 0 with no
 * message and no stop in the journal, and stayed down until someone noticed.
 */
export function exitCodeWithoutStop(stopping: boolean, code: number): number {
	return code === 0 && !stopping ? 1 : code;
}

/** `panad` entry point. Returns the exit code. `options` lets a test fixture swap in a faux model. */
export async function main(_argv: string[], options: StartOptions = {}): Promise<number> {
	let panad: Panad;
	// API-05: answer to the tailnet name Tailscale Serve forwards. Only the entry point asks
	// tailscale; tests that call startPanad pass names explicitly.
	const tailscaleNames = options.tailscaleNames ?? (await detectTailscaleNames());
	try {
		panad = await startPanad({ ...options, tailscaleNames });
	} catch (error) {
		if (error instanceof ConfigError) {
			console.error(`panad: ${error.message}`);
			return error.exitCode;
		}
		throw error;
	}
	const tcp = panad.tcpPort === undefined ? "" : ` and http://127.0.0.1:${panad.tcpPort}`;
	console.error(`panad: listening on ${panad.socketPath}${tcp}`);
	const { models, config } = panad.runtime;
	const providers = models.getProviders().map((provider) => provider.id);
	console.error(`panad: model providers: ${providers.length > 0 ? providers.join(", ") : "none (set a provider API key in panad's environment)"}`);
	if (config.defaultModel === undefined) {
		console.error("panad: no defaultModel in config.json; sessions need --model or a profile model");
	} else if (!hasModel(models, config.defaultModel)) {
		console.error(`panad: defaultModel ${config.defaultModel} is not available from the registered providers`);
	}
	// WEB-01: open this URL to authorize a window. The token sits in the fragment, so it is
	// never sent to the server or written to an access log.
	if (panad.tcpPort !== undefined) {
		console.error(`panad: open ${launchUrl(loopbackOrigin(panad.tcpPort), panad.webToken)}`);
		for (const name of tailscaleNames) {
			console.error(`panad: open ${launchUrl(`https://${name}`, panad.webToken)} (after tailscale serve --bg ${panad.tcpPort})`);
		}
	}
	return new Promise((resolve) => {
		let stopping = false;
		// SRV-04: node ends the process on its own when the last handle closes, without settling
		// this promise and without a word. Report that as failure so the service restarts the
		// daemon instead of leaving pana down, and say so rather than dying silently.
		process.once("exit", (code) => {
			const reported = exitCodeWithoutStop(stopping, code);
			if (reported === code) return;
			console.error(`panad: exited ${code} without a stop request; reporting ${reported} so the service restarts`);
			process.exitCode = reported;
		});
		const stop = () => {
			// A second signal means the operator is done waiting: leave now, without a clean close.
			if (stopping) process.exit(1);
			stopping = true;
			panad.close().then(
				() => resolve(0),
				(error) => {
					console.error("panad: close failed:", error);
					resolve(1);
				},
			);
		};
		process.once("SIGTERM", stop);
		process.once("SIGINT", stop);
	});
}
