import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { request } from "../src/api/client.ts";
import type { Handlers } from "../src/api/types.ts";
import { statePaths } from "../src/config/index.ts";
import {
	createScriptedModel,
	FAUX_MODEL,
	makeStateDir,
	startTestPanad,
	TEST_DOMAIN,
	TEST_USER,
	type ScriptedModel,
	type TestPanad,
} from "./harness/index.ts";

const opened: TestPanad[] = [];
const children: ChildProcess[] = [];
const dirs: string[] = [];

afterEach(async () => {
	for (const child of children.splice(0)) child.kill("SIGKILL");
	for (const t of opened.splice(0)) await t.close().catch(() => {});
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function start(options: Parameters<typeof startTestPanad>[0] = {}): Promise<TestPanad> {
	const t = await startTestPanad(options);
	opened.push(t);
	return t;
}

function track(dir: string): string {
	dirs.push(dir);
	return dir;
}

/** A model whose first request never answers on its own. A close aborts it, as pi-durable's is. */
function stallingModel(): { model: ScriptedModel; reached: Promise<void> } {
	const base = createScriptedModel([]);
	const provider = base.faux.provider;
	let mark!: () => void;
	const reached = new Promise<void>((resolve) => (mark = resolve));
	const stall = (_model: unknown, _context: unknown, options?: { signal?: AbortSignal }) => {
		const stream = createAssistantMessageEventStream();
		mark();
		options?.signal?.addEventListener(
			"abort",
			() => {
				const message = fauxAssistantMessage([], { stopReason: "aborted" });
				stream.push({ type: "error", reason: "aborted", error: message });
				stream.end(message);
			},
			{ once: true },
		);
		return stream;
	};
	base.models.setProvider({ ...provider, stream: stall as never, streamSimple: stall as never });
	return { model: base, reached };
}

function spawnNode(script: string, args: string[], env: Record<string, string>): ChildProcess {
	const child = spawn(process.execPath, [script, ...args], {
		env: { ...process.env, ...env },
		stdio: ["ignore", "pipe", "pipe"],
	});
	children.push(child);
	return child;
}

function waitForLine(child: ChildProcess, line: string): Promise<void> {
	return new Promise((resolve, reject) => {
		let stderr = "";
		const timer = setTimeout(() => reject(new Error(`panad did not print "${line}": ${stderr}`)), 10_000);
		child.stderr!.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
			if (stderr.includes(line)) {
				clearTimeout(timer);
				resolve();
			}
		});
		child.once("exit", (code, signal) => {
			clearTimeout(timer);
			reject(new Error(`panad exited before printing "${line}" (${code ?? signal}): ${stderr}`));
		});
	});
}

function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => resolve({ code, signal }));
	});
}

function logLines(dir: string): Array<Record<string, unknown>> {
	const path = statePaths(dir).log;
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Poll a conversation's entries until they contain `needle`. */
async function waitForText(t: TestPanad, needle: string): Promise<boolean> {
	const root = await t.runtime.harness.root(ctx);
	for (let round = 0; round < 200; round++) {
		const page = await root.entries({ order: "ascending" }, 200, undefined, ctx);
		if (JSON.stringify(page.items).includes(needle)) return true;
		await t.clock.settle();
	}
	return false;
}

const echo: Handlers = {
	"inbox.list": (request) => ({ status: 200, body: { caller: request.caller } }),
	"threads.create": (request) => ({ status: 201, body: request.body }),
};

describe("panad", () => {
	it("SRV-01 panad listens on both transports and logs one JSONL line per request, never a body", async () => {
		const t = await start({ handlers: echo });
		expect(typeof t.panad.tcpPort).toBe("number");

		const secret = "SEKRIT-BODY-VALUE";
		const socketInbox = await t.client.get("/inbox");
		expect(socketInbox.status).toBe(200);
		const created = await t.client.post("/threads", { to: ["someone"], body: secret });
		expect(created.status).toBe(201);
		const missing = await t.client.get("/nope");
		expect(missing.status).toBe(404);
		const unbuilt = await t.client.get("/files/01JBFILE/a.txt");
		expect(unbuilt.status).toBe(501);
		const overTcp = await t.tcp.get("/inbox");
		expect(overTcp.status).toBe(200);
		await t.clock.settle();

		const lines = logLines(t.dir);
		expect(lines).toHaveLength(5);
		for (const line of lines) {
			expect(Object.keys(line).sort()).toEqual(
				["caller", "durationMs", "method", "path", "route", "status", "transport", "ts"].sort(),
			);
			expect(typeof line.durationMs).toBe("number");
			expect(typeof line.ts).toBe("string");
		}

		const routes = lines.map((line) => line.route);
		expect(routes).toEqual(["inbox.list", "threads.create", null, "files.download", "inbox.list"]);
		expect(lines.map((line) => line.status)).toEqual([200, 201, 404, 501, 200]);
		expect(lines.map((line) => line.transport)).toEqual(["socket", "socket", "socket", "socket", "tcp"]);
		expect(lines[0]!.caller).toBe(`pana://${TEST_DOMAIN}/users/${TEST_USER}`);
		expect(lines[0]!.method).toBe("GET");
		expect(lines[0]!.path).toBe("/inbox");

		// Bodies are never logged, and neither is anything else that could carry content.
		const raw = readFileSync(statePaths(t.dir).log, "utf8");
		expect(raw).not.toContain(secret);
		expect(raw).not.toContain("body");
		expect(raw).not.toContain("authorization");

		// A failed request is one line too, and it does not stop the next request.
		const after = await t.client.get("/inbox");
		expect(after.status).toBe(200);
		expect(logLines(t.dir)).toHaveLength(6);
	});

	it("SRV-02 on SIGTERM panad stops accepting requests, closes the Harness, and exits 0", async () => {
		const dir = track(makeStateDir({ domain: TEST_DOMAIN, user: TEST_USER, http: { port: 0 } }));
		const child = spawnNode(join(import.meta.dirname, "fixtures", "panad-child.ts"), [], { PANA_STATE: dir });
		await waitForLine(child, "listening on");

		const paths = statePaths(dir);
		expect(existsSync(paths.socket)).toBe(true);
		const live = await request({ socketPath: paths.socket }, "GET", "/sessions");
		expect(live.status).toBe(501);

		child.kill("SIGTERM");
		const exit = await waitForExit(child);
		expect(exit.signal).toBe(null);
		expect(exit.code).toBe(0);

		// It stopped accepting: the socket is gone and no listener answers.
		expect(existsSync(paths.socket)).toBe(false);
		expect(existsSync(paths.pidFile)).toBe(false);
		await expect(request({ socketPath: paths.socket }, "GET", "/sessions")).rejects.toThrow();

		// The request log survived the shutdown, complete and valid.
		const lines = logLines(dir);
		expect(lines).toHaveLength(1);
		expect(lines[0]!.path).toBe("/sessions");

		// A clean close leaves state the next start can open.
		const restarted = await start({ stateDir: dir });
		const after = await restarted.client.get("/inbox");
		expect(after.status).toBe(501);
	});

	it("SRV-02 a run in progress when panad closes finishes after the next start", async () => {
		const dir = track(makeStateDir());
		const stall = stallingModel();
		const first = await start({ stateDir: dir, model: stall.model });
		const root = await first.runtime.harness.root(ctx, { agent: { model: FAUX_MODEL } });
		const submission = await root.submit({ type: "input", content: "interrupted work" }, ctx);
		await stall.reached;

		await first.panad.close();
		expect(existsSync(statePaths(dir).socket)).toBe(false);

		const second = await start({ stateDir: dir, script: [{ text: "finished after the restart" }] });
		await second.runtime.harness.waitForIdle(ctx);
		expect(await waitForText(second, "finished after the restart")).toBe(true);

		const settled = await (await second.runtime.harness.submission(submission.id, ctx))!.wait(ctx);
		expect(settled.status).toBe("done");
	});

	it("SRV-03 after a crash mid-run, the next start resumes the run and it finishes", async () => {
		const dir = track(makeStateDir({ domain: TEST_DOMAIN, user: TEST_USER, http: { port: 0 } }));
		const child = spawnNode(join(import.meta.dirname, "fixtures", "crash-run-child.ts"), [dir], {});
		const exit = await waitForExit(child);
		expect(exit.signal).toBe("SIGKILL");
		expect(existsSync(join(dir, "crashed"))).toBe(true);

		const t = await start({ stateDir: dir, script: [{ text: "recovered from the crash" }] });
		await t.runtime.harness.waitForIdle(ctx);
		expect(await waitForText(t, "recovered from the crash")).toBe(true);

		// The transcript holds the input once and the answer, with no duplicate run.
		const root = await t.runtime.harness.root(ctx);
		const page = await root.entries({ order: "ascending" }, 200, undefined, ctx);
		const userEntries = page.items.filter((entry) => entry.kind === "pi.user");
		expect(userEntries).toHaveLength(1);
		expect(t.model.calls()).toBe(1);
	});
});
