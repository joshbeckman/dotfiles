import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { request } from "../src/api/client.ts";
import { isUserColor, loadConfig } from "../src/config/index.ts";
import {
	readSourceRevision,
	UNTRACKED_FILE_CAP,
} from "../src/config/source.ts";
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

it("SET-04 validates every CSS hex form and preserves legacy named colors", () => {
	for (const color of ["blue", "purple", "#AbC", "#AbCd", "#0123Af", "#0123aF45"]) expect(isUserColor(color)).toBe(true);
	for (const color of [null, 42, "cyan", "#12", "#12345", "#1234567", "#123456789", "#ggg", "#fff; color:red", "url(x)"]) expect(isUserColor(color)).toBe(false);
});

it("SET-04 saves the user's arbitrary hex color immediately, persists it, and keeps operational changes restart-only", async () => {
	t = await startTestPanad();
	let read = await t.client.get<any>("/settings");
	expect(t.runtime.config.ui?.userColor).toBe("blue");
	const config = { ...read.body.config, ui: { userColor: "#A1b2C3", future: true } };
	let saved = await t.client.post<any>("/settings", { config, configRevision: read.body.configRevision });
	expect(saved.status).toBe(200);
	expect(saved.body.configRequiresRestart).toBe(false);
	expect(saved.body.config.ui.future).toBe(true);
	expect(t.runtime.config.ui?.userColor).toBe("#A1b2C3");
	for (const userColor of ["#12", "#12345", "#1234567", "#123456789", "#ggg", "#fff; color:red", "invalid", 42, null]) {
		expect((await t.client.post("/settings", { config: { ...config, ui: { userColor } }, configRevision: saved.body.configRevision })).status).toBe(400);
		expect(t.runtime.config.ui?.userColor).toBe("#A1b2C3");
	}
	const dir = t.dir;
	await t.stop();
	t = await startTestPanad({ stateDir: dir });
	expect(t.runtime.config.ui?.userColor).toBe("#A1b2C3");
	read = await t.client.get<any>("/settings");
	saved = await t.client.post<any>("/settings", { config: { ...config, spawnDepth: 7, ui: { userColor: "green" } }, configRevision: read.body.configRevision });
	expect(saved.body.configRequiresRestart).toBe(true);
	expect(t.runtime.config.ui?.userColor).toBe("green");
	expect(t.runtime.config.spawnDepth).toBe(3);
});

/** Poll a cheap predicate on the real clock; a test may wait, a daemon may not. */
async function until(check: () => boolean, timeoutMs = 8000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("timed out waiting for the source snapshot to refresh");
}

/**
 * A `git` ahead of the real one on PATH that logs each call and then stalls. Anything that waits
 * on git synchronously therefore shows up as a slow request, not as a fast one.
 */
function slowGit(): { calls: () => number; restore: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "pana-slow-git-")); dirs.push(dir);
	const log = join(dir, "calls.log");
	const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
	const shim = join(dir, "git");
	writeFileSync(shim, `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\nsleep 2\nexec ${JSON.stringify(real)} "$@"\n`, { mode: 0o755 });
	const saved = process.env.PATH;
	process.env.PATH = `${dir}:${saved ?? ""}`;
	return {
		calls: () => (readdirSync(dir).includes("calls.log") ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0),
		restore: () => { process.env.PATH = saved; },
	};
}

it("SET-02 a settings read never waits on git, and counts no local file beyond the cap", async () => {
	const git = slowGit();
	try {
		t = await startTestPanad();
		for (let attempt = 0; attempt < 2; attempt++) {
			const started = performance.now();
			const read = await t.client.get<any>("/settings");
			expect(read.status).toBe(200);
			expect(performance.now() - started).toBeLessThan(1500);
			// The read reports the snapshot captured at startup, never a fresh subprocess.
			expect(read.body.source).toEqual(t.runtime.processInfo!.running);
		}
	} finally { git.restore(); }
});

it("SET-02 an untracked file enters the fingerprint by size, and by content only up to the cap", () => {
	const dir = mkdtempSync(join(tmpdir(), "pana-source-cap-")); dirs.push(dir);
	const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
	git("init"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.com");
	writeFileSync(join(dir, "tracked.ts"), "export const tracked = 1;\n");
	git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-m", "cap source");
	const small = join(dir, "small.txt");
	const big = join(dir, "big.bin");
	writeFileSync(small, "a".repeat(UNTRACKED_FILE_CAP));
	writeFileSync(big, Buffer.alloc(UNTRACKED_FILE_CAP + 1, 0x61));
	const first = readSourceRevision(dir)!.fingerprint;

	patched(small, "z");
	const editedSmall = readSourceRevision(dir)!.fingerprint;
	expect(editedSmall).not.toBe(first);

	// The oversized file's content is never read, so editing inside it cannot move the fingerprint.
	patched(big, 0x7a);
	expect(readSourceRevision(dir)!.fingerprint).toBe(editedSmall);
	// Its size still counts.
	writeFileSync(big, Buffer.alloc(UNTRACKED_FILE_CAP + 2, 0x61));
	expect(readSourceRevision(dir)!.fingerprint).not.toBe(editedSmall);
});

/** Overwrite the first byte, leaving the file's size alone. */
function patched(path: string, byte: string | number): void {
	const fd = openSync(path, "r+");
	const buffer = typeof byte === "number" ? Buffer.from([byte]) : Buffer.from(byte);
	try { writeSync(fd, buffer, 0, buffer.length, 0); } finally { closeSync(fd); }
}

it("SET-03 a restart validates one snapshot and runs exactly it, and does not wait on the client", async () => {
	t = await startTestPanad();
	const dir = t.dir;
	const snapshots: Array<string | undefined> = [];
	t.runtime.processInfo!.requestRestart = (snapshot) => { snapshots.push(snapshot); };
	const validated = readFileSync(join(dir, "config.json"), "utf8");
	const accepted = await t.client.post<any>("/settings/restart");
	expect(accepted.status).toBe(202);
	expect(accepted.body.restarting).toBe(true);
	// A swap after the acknowledgement cannot change what the restarted process reads.
	writeFileSync(join(dir, "config.json"), JSON.stringify({ ...JSON.parse(validated), spawnDepth: 9 }));
	await until(() => snapshots.length > 0, 5000);
	expect(snapshots).toHaveLength(1);
	const snapshot = snapshots[0]!;
	expect(readFileSync(snapshot, "utf8")).toBe(validated);
	expect(snapshot).not.toBe(join(dir, "config.json"));
});

it("SET-03 a client that disconnects before reading the acknowledgement still gets its restart", async () => {
	t = await startTestPanad();
	const snapshots: Array<string | undefined> = [];
	t.runtime.processInfo!.requestRestart = (snapshot) => { snapshots.push(snapshot); };
	// Write the request then hang up without reading the 202: the daemon must restart anyway.
	const socket = connect(t.runtime.paths.socket);
	await new Promise<void>((resolve, reject) => {
		socket.once("connect", resolve); socket.once("error", reject);
	});
	const body = "";
	socket.write(`POST /settings/restart HTTP/1.1\r\nHost: panad\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
	socket.destroy();
	await until(() => snapshots.length > 0, 5000);
	expect(snapshots).toHaveLength(1);
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
