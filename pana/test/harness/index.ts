// The pana test harness (TST-01..03). Every test that needs panad starts one here: a temp state
// directory, a fake clock, a scripted faux model, and clients for both listeners. Nothing
// touches ~/.local/state/pana or the network.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessSettings, Registry } from "@earendil-works/pi-durable";
import { request, type ApiResponse, type RequestOptions } from "../../src/api/client.ts";
import type { Handlers } from "../../src/api/types.ts";
import type { WakeSubmitter } from "../../src/db/outbox.ts";
import { startPanad, type Panad } from "../../src/server/index.ts";
import type { Runtime } from "../../src/server/runtime.ts";
import { createFakeClock, type FakeClock } from "./clock.ts";
import { createScriptedModel, type Script, type ScriptedModel } from "./model.ts";

export { createFakeClock, FAKE_EPOCH, type FakeClock } from "./clock.ts";
export { createScriptedModel, FAUX_MODEL, type Script, type ScriptedModel, type Turn, type TurnUsage } from "./model.ts";

export const TEST_DOMAIN = "test.example";
export const TEST_USER = "tester";

export interface TestPanadOptions {
	/** Model turns, consumed in order across every session. */
	script?: Script;
	/** Extra or overriding config.json keys. `domain` and `user` default to the test values. */
	config?: Record<string, unknown>;
	/** Write this exact config.json instead (for config tests). */
	rawConfig?: Record<string, unknown>;
	handlers?: Handlers;
	registry?: Registry;
	settings?: HarnessSettings;
	tailscaleNames?: string[];
	wake?: (runtime: () => Runtime) => WakeSubmitter;
	/** Reuse a state directory, for restart tests. */
	stateDir?: string;
	clock?: FakeClock;
	model?: ScriptedModel;
}

export interface Client {
	request<T = unknown>(method: string, path: string, options?: RequestOptions): Promise<ApiResponse<T>>;
	get<T = unknown>(path: string, options?: RequestOptions): Promise<ApiResponse<T>>;
	post<T = unknown>(path: string, body?: unknown, options?: RequestOptions): Promise<ApiResponse<T>>;
	delete<T = unknown>(path: string, options?: RequestOptions): Promise<ApiResponse<T>>;
}

export interface TestPanad {
	panad: Panad;
	runtime: Runtime;
	dir: string;
	clock: FakeClock;
	model: ScriptedModel;
	/** Socket client. Pass `{ caller }` to act as a session. */
	client: Client;
	/** TCP client with the web token and `Host: 127.0.0.1`. */
	tcp: Client;
	/** Failures panad reported but survived. */
	reports: Array<{ error: unknown; what: string }>;
	/** Errors passed to `onFatal`. */
	fatal: unknown[];
	/** Stop panad, keeping the state directory. */
	stop(): Promise<void>;
	/** Stop panad and delete the state directory. */
	close(): Promise<void>;
}

function makeClient(send: (method: string, path: string, options?: RequestOptions) => Promise<ApiResponse>): Client {
	return {
		request: send as Client["request"],
		get: (path, options) => send("GET", path, options) as never,
		post: (path, body, options) => send("POST", path, { ...options, body }) as never,
		delete: (path, options) => send("DELETE", path, options) as never,
	};
}

/** Make a temp state directory with a test config.json. */
export function makeStateDir(config: Record<string, unknown> = {}, raw?: Record<string, unknown>): string {
	const dir = mkdtempSync(join(tmpdir(), "pana-test-"));
	const body = raw ?? { domain: TEST_DOMAIN, user: TEST_USER, ...config };
	writeFileSync(join(dir, "config.json"), JSON.stringify(body));
	return dir;
}

export async function startTestPanad(options: TestPanadOptions = {}): Promise<TestPanad> {
	const dir = options.stateDir ?? makeStateDir(options.config, options.rawConfig);
	const clock = options.clock ?? createFakeClock();
	const model = options.model ?? createScriptedModel(options.script ?? []);
	const reports: TestPanad["reports"] = [];
	const fatal: unknown[] = [];

	const panad = await startPanad({
		stateDir: dir,
		clock,
		models: model.models,
		registry: options.registry,
		// Retries would sleep on the fake clock; a test scripts failures explicitly instead.
		settings: { retry: { maxRetries: 0 }, ...options.settings },
		handlers: options.handlers,
		tcpPort: 0,
		tailscaleNames: options.tailscaleNames,
		wake: options.wake,
		onFatal: (error) => fatal.push(error),
		onReport: (error, what) => reports.push({ error, what }),
	});

	const socket = { socketPath: panad.socketPath };
	const tcpEndpoint = { host: "127.0.0.1", port: panad.tcpPort!, token: panad.webToken };
	let stopped: Promise<void> | undefined;
	const stop = () => (stopped ??= panad.close());

	return {
		panad,
		runtime: panad.runtime,
		dir,
		clock,
		model,
		client: makeClient((method, path, opts) => request(socket, method, path, opts)),
		tcp: makeClient((method, path, opts) => request(tcpEndpoint, method, path, opts)),
		reports,
		fatal,
		stop,
		close: async () => {
			try {
				await stop();
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	};
}
