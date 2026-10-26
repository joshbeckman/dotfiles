// panad: open the state directory, the shared database, and the Harness, then serve the API
// on the Unix socket and on loopback TCP. WP1 owns logging, signals, and resume (SRV-01..03);
// this is the minimal server the WP0 contract needs.

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { Harness, type HarnessOptions, type HarnessSettings, type Registry } from "@earendil-works/pi-durable";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Handlers } from "../api/types.ts";
import { ConfigError, ensureStateLayout, loadConfig, readWebToken, stateDir as defaultStateDir } from "../config/index.ts";
import { openSharedDatabase } from "../db/index.ts";
import { sweepWakes, type WakeSubmitter } from "../db/outbox.ts";
import { createPanaEnv, createPanaRegistry, installGitHooks } from "../extension/index.ts";
import { ensureMemoryRepo } from "../memory/index.ts";
import { initPush } from "../push/index.ts";
import { startScheduler } from "../schedules/index.ts";
import { defaultWakeSubmitter } from "../sessions/wake.ts";
import { launchUrl, loopbackOrigin } from "../web/static.ts";
import { createApp, type RequestLogEntry } from "./app.ts";
import { defaultHandlers } from "./handlers.ts";
import { acquirePidLock } from "./lock.ts";
import { createIdFactory, systemClock, urlHelpers, type Clock, type Runtime } from "./runtime.ts";

export interface StartOptions {
	/** State directory; default `PANA_STATE` or `~/.local/state/pana` (CFG-01). */
	stateDir?: string;
	clock?: Clock;
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
	/** Memory may be ahead of disk (see src/db/atomic.ts). Default: log and exit 1. */
	onFatal?: (error: unknown) => void;
	onRequest?: (entry: RequestLogEntry) => void;
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
		const models = options.models ?? createModels();
		const getRuntime = () => runtime;
		const registry = options.registry ?? createPanaRegistry(getRuntime);
		const env = options.env ?? createPanaEnv(getRuntime);
		const settings = options.settings ?? {};
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

		// The hook directory must exist before any session's bash runs (HOK-01).
		installGitHooks(paths.hooks, config.domain);
		// PSH-01: the VAPID pair exists before the first push, not on the first request.
		initPush(runtime);

		await sweepWakes(db, runtime.wake, (error, wake) => report(error, `wake for delivery ${wake.deliveryId}`));
		harness.resume();

		const webToken = readWebToken(dir);
		const appOptions = {
			runtime,
			handlers: { ...defaultHandlers, ...options.handlers },
			webToken,
			tailscaleNames: options.tailscaleNames,
			onRequest: options.onRequest,
		};

		// WP6: recover runs missed while panad was down, then arm the timer on `runtime.clock`.
		const scheduler = await startScheduler({
			runtime,
			handlers: appOptions.handlers,
			onReport: (error, what) => report(error, what),
		});
		cleanup.unshift(() => scheduler.close());

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
		server.close(() => resolve());
		server.closeAllConnections();
	});
}

/** `panad` entry point. Returns the exit code. */
export async function main(_argv: string[]): Promise<number> {
	let panad: Panad;
	try {
		panad = await startPanad();
	} catch (error) {
		if (error instanceof ConfigError) {
			console.error(`panad: ${error.message}`);
			return error.exitCode;
		}
		throw error;
	}
	const tcp = panad.tcpPort === undefined ? "" : ` and http://127.0.0.1:${panad.tcpPort}`;
	console.error(`panad: listening on ${panad.socketPath}${tcp}`);
	// WEB-01: open this URL to authorize a window. The token sits in the fragment, so it is
	// never sent to the server or written to an access log.
	if (panad.tcpPort !== undefined) {
		console.error(`panad: open ${launchUrl(loopbackOrigin(panad.tcpPort), panad.webToken)}`);
	}
	return new Promise((resolve) => {
		const stop = () => {
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
