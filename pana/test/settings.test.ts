import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { request } from "../src/api/client.ts";
import { loadConfig } from "../src/config/index.ts";
import { readSourceRevision } from "../src/config/source.ts";
import { makeStateDir, startTestPanad, type TestPanad } from "./harness/index.ts";

let t: TestPanad | undefined;
const dirs: string[] = [];
let child: ChildProcess | undefined;
afterEach(async () => {
	if (child && child.exitCode === null) {
		const exited = new Promise<void>((resolve) => child!.once("exit", () => resolve()));
		child.kill("SIGKILL");
		await exited;
	}
	child = undefined;
	await t?.close(); t = undefined;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("SET-01 user settings read and save config atomically without mutating the running config", async () => {
	t = await startTestPanad({ config: { extra: { keep: true } } });
	const read = await t.tcp.get<any>("/settings");
	expect(read.status).toBe(200);
	expect(read.body.processes[0]).toMatchObject({ role: "panad", pid: process.pid, startedAt: t.clock.now() });
	expect(read.body.configRequiresRestart).toBe(false);
	const config = { ...read.body.config, spawnDepth: 5 };
	const saved = await t.tcp.post<any>("/settings", { config, configRevision: read.body.configRevision });
	expect(saved.status).toBe(200);
	expect(saved.body.configRequiresRestart).toBe(true);
	expect(saved.body.config.extra).toEqual({ keep: true });
	expect(loadConfig(t.dir).spawnDepth).toBe(5);
	expect(t.runtime.config.spawnDepth).toBe(3);
	expect(statSync(join(t.dir, "config.json")).mode & 0o777).toBe(0o600);
});

it("SET-01 stale saves and invalid config preserve the original file and identity", async () => {
	t = await startTestPanad();
	const { body } = await t.client.get<any>("/settings");
	const original = readFileSync(join(t.dir, "config.json"), "utf8");
	for (const patch of [{ user: "other" }, { domain: "other.example" }, { tools: { bashTimeoutSec: -1 } },
		{ http: { port: 65536 } }, { timezone: "not-a-zone" }, { budget: { sessionUsd: "bad" } }, { spawnDepth: 1.5 }]) {
		expect((await t.client.post("/settings", { config: { ...body.config, ...patch }, configRevision: body.configRevision })).status).toBe(400);
		expect(readFileSync(join(t.dir, "config.json"), "utf8")).toBe(original);
	}
	writeFileSync(join(t.dir, "config.json"), original + "\n");
	expect((await t.client.post("/settings", { config: body.config, configRevision: body.configRevision })).status).toBe(409);
});

it("SET-01 invalid external configuration stays editable but cannot restart the healthy daemon", async () => {
	t = await startTestPanad();
	const config = { domain: t.runtime.config.domain, user: t.runtime.config.user };
	writeFileSync(join(t.dir, "config.json"), "{broken");
	const read = await t.client.get<any>("/settings");
	expect(read.status).toBe(200);
	expect(read.body.configText).toBe("{broken");
	expect(read.body.configValidationError).toBeTruthy();
	t.runtime.processInfo!.requestRestart = () => { throw new Error("must not restart"); };
	expect((await t.client.post("/settings/restart")).status).toBe(400);
	expect((await t.client.post<any>("/settings", { config, configRevision: read.body.configRevision })).body.configValidationError).toBeUndefined();
});

it("SET-01 sessions cannot read, save, or restart user settings", async () => {
	t = await startTestPanad({ script: [{ text: "done" }] });
	const created = await t.client.post<any>("/sessions", { prompt: "hello", model: "faux/faux-1" });
	expect(created.status).toBe(201);
	const caller = created.body.session.id;
	expect(caller).toBeTruthy();
	for (const [method, path] of [["GET", "/settings"], ["POST", "/settings"], ["POST", "/settings/restart"]]) {
		expect((await t!.client.request(method!, path!, { caller })).status).toBe(403);
	}
	expect((await t.client.post("/settings/restart")).status).toBe(501);
});

it("SET-02 source revision reports HEAD, commit message, local edits and unknown source", () => {
	const dir = mkdtempSync(join(tmpdir(), "pana-source-")); dirs.push(dir);
	const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
	git("init"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.com");
	writeFileSync(join(dir, "source.ts"), "first\n"); git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-m", "test source");
	const first = readSourceRevision(dir)!;
	expect(first.message).toBe("test source"); expect(first.sha).toHaveLength(40); expect(first.dirty).toBe(false);
	writeFileSync(join(dir, "source.ts"), "second\n");
	const edited = readSourceRevision(dir)!;
	expect(edited.sha).toBe(first.sha); expect(edited.dirty).toBe(true); expect(edited.fingerprint).not.toBe(first.fingerprint);
	writeFileSync(join(dir, "untracked.ts"), "untracked\n");
	expect(readSourceRevision(dir)!.fingerprint).not.toBe(edited.fingerprint);
	expect(readSourceRevision(join(dir, "missing"))).toBe(null);
});

/** Wait on the child's readiness event, never probe a live daemon. */
function listening(process: ChildProcess): Promise<void> {
	return new Promise((resolve, reject) => {
		let output = "";
		const timeout = setTimeout(() => { clean(); reject(new Error(`readiness timed out: ${output}`)); }, 15000);
		const data = (chunk: Buffer) => { output += chunk.toString(); if (output.includes("panad: listening on")) { clean(); resolve(); } };
		const exit = (code: unknown) => { clean(); reject(new Error(`child exited ${code}: ${output}`)); };
		function clean() { clearTimeout(timeout); process.stderr!.off("data", data); process.off("exit", exit); }
		process.stderr!.on("data", data); process.once("exit", exit);
	});
}

it("SET-03 restart acknowledges before graceful close and re-execs with new configuration", async () => {
	if (typeof process.execve !== "function" || !["darwin", "linux"].includes(process.platform)) return;
	const dir = makeStateDir({ http: { port: 0 } }); dirs.push(dir);
	child = spawn(process.execPath, [join(import.meta.dirname, "fixtures/faux-panad.ts")], {
		env: { PATH: process.env.PATH, HOME: dir, PANA_STATE: dir }, stdio: ["ignore", "pipe", "pipe"],
	});
	await listening(child);
	const endpoint = { socketPath: join(dir, "panad.sock") };
	const before = await request<any>(endpoint, "GET", "/settings");
	expect(before.body.restartAvailable).toBe(true);
	await request(endpoint, "POST", "/settings", { body: { config: { ...before.body.config, spawnDepth: 6 }, configRevision: before.body.configRevision } });
	const ready = listening(child);
	const restarting = await request<any>(endpoint, "POST", "/settings/restart");
	expect(restarting.status).toBe(202);
	await ready;
	const after = await request<any>(endpoint, "GET", "/settings");
	expect(after.body.config.spawnDepth).toBe(6);
	expect(after.body.configRequiresRestart).toBe(false);
	expect(after.body.processes[0].pid).toBe(before.body.processes[0].pid);
	expect(after.body.processes[0].startedAt).toBeGreaterThan(before.body.processes[0].startedAt);
	expect(after.body.processes[0].running).toEqual(after.body.source);
});
