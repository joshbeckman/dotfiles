import { mkdtempSync, rmSync, writeFileSync, existsSync, realpathSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCheck, CHECK_OUTPUT_BYTES, CHECK_TIMEOUT_MS } from "../src/schedules/check.ts";
import type { ScheduleView } from "../src/schedules/store.ts";
import { createFakeClock, startTestPanad, type TestPanad } from "./harness/index.ts";

let t: TestPanad | undefined;
let dir: string | undefined;
afterEach(async () => { await t?.close(); t = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });
const cron = "* * * * *";
const base = { kind: "session", cron, payload: { prompt: "only when ready" } };
async function create(extra: Record<string, unknown> = {}) {
	const res = await t!.client.post<{ schedule: ScheduleView }>("/schedules", { ...base, ...extra });
	expect(res.status).toBe(201);
	return res.body.schedule;
}
async function show(id: string) {
	return (await t!.client.get<{ schedule: ScheduleView }>(`/schedules/${id}`)).body.schedule;
}
async function checked(id: string, previous?: number) {
	await vi.waitFor(async () => {
		const result = (await show(id)).lastCheck;
		expect(result).not.toBeNull();
		if (previous !== undefined) expect(result!.checkedAt).toBeGreaterThan(previous);
	});
	return (await show(id)).lastCheck!;
}

describe("schedule conditions", () => {
	it("SCH-09 validates recurring-only checks and options on create and update without polluting payloads", async () => {
		t = await startTestPanad();
		for (const extra of [{ check: "" }, { check: 3 }, { check: "true", checkCwd: "relative" }, { checkCwd: tmpdir() }, { stopAfterSuccess: "true" }]) {
			expect((await t.client.post("/schedules", { ...base, ...extra })).status).toBe(400);
		}
		for (const extra of [{ check: "true" }, { stopAfterSuccess: true }]) {
			expect((await t.client.post("/schedules", { ...base, cron: null, at: t.clock.now() + 60_000, ...extra })).status).toBe(400);
		}
		const schedule = await create({ check: "true" });
		expect(schedule).toMatchObject({ check: "true", checkCwd: process.cwd(), stopAfterSuccess: false, lastCheck: null, payload: base.payload });
		expect((await t.client.post(`/schedules/${schedule.id}`, { at: t.clock.now() + 60_000 })).status).toBe(400);
		expect((await t.client.post(`/schedules/${schedule.id}`, { at: t.clock.now() + 60_000, check: null })).status).toBe(200);
		expect(await show(schedule.id)).toMatchObject({ check: null, checkCwd: null });
	});

	it("SCH-10 skips exit 1 silently, records diagnostics, and dispatches exit 0 on the next recurrence", async () => {
		let calls = 0;
		t = await startTestPanad({ handlers: { "sessions.create": () => { calls++; return { status: 201 }; } } });
		dir = mkdtempSync(join(tmpdir(), "pana-condition-"));
		const schedule = await create({ check: "printf diagnostic; printf waiting >&2; test -f ready", checkCwd: dir });
		await t.clock.advanceTo(schedule.nextAt!);
		const first = await checked(schedule.id);
		expect(first).toMatchObject({ status: "not_ready", exitCode: 1, stdout: "diagnostic", stderr: "waiting", error: null });
		expect(calls).toBe(0);
		expect((await t.client.get<{ deliveries: unknown[] }>("/inbox")).body.deliveries).toEqual([]);
		writeFileSync(join(dir, "ready"), "");
		await t.clock.advanceTo((await show(schedule.id)).nextAt!);
		expect(await checked(schedule.id, first.checkedAt)).toMatchObject({ status: "passed", exitCode: 0 });
		await vi.waitFor(() => expect(calls).toBe(1));
		expect((await show(schedule.id)).state).toBe("active");
	});

	it("SCH-10 thread schedules are gated too; SCH-14 stop-after-success also works without a check", async () => {
		t = await startTestPanad();
		const gated = await create({ kind: "thread", check: "exit 1", payload: { to: ["tester"], body: "not yet" } });
		const once = await create({ kind: "thread", stopAfterSuccess: true, payload: { to: ["tester"], body: "once" } });
		await t.clock.advanceTo(gated.nextAt!);
		await checked(gated.id);
		await vi.waitFor(async () => expect((await show(once.id)).state).toBe("done"));
		expect((await t.runtime.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM threads"))!.n).toBe(1);
		await t.clock.advance(60_000);
		await checked(gated.id, gated.nextAt!);
		expect((await t.runtime.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM threads"))!.n).toBe(1);
	});

	it("SCH-11 a broken check records failure and notifies the user without dispatching", async () => {
		let calls = 0;
		t = await startTestPanad({ handlers: { "sessions.create": () => { calls++; return { status: 201 }; } } });
		const schedule = await create({ check: "printf broken >&2; exit 7" });
		await t.clock.advanceTo(schedule.nextAt!);
		expect(await checked(schedule.id)).toMatchObject({ status: "failed", exitCode: 7, stderr: "broken", error: "check exited 7" });
		await vi.waitFor(async () => {
			const inbox = await t!.client.get<{ deliveries: Array<{ body: string }> }>("/inbox");
			expect(inbox.body.deliveries.some((d) => d.body.includes("check failed") && d.body.includes(schedule.url))).toBe(true);
		});
		expect(calls).toBe(0);
		expect((await show(schedule.id)).state).toBe("active");
	});

	it("SCH-12 executes bash in the recorded cwd, bounds both streams, and records spawn/signal failures", async () => {
		dir = mkdtempSync(join(tmpdir(), "pana-condition-"));
		const clock = createFakeClock();
		const run = (cmd: string, cwd = dir!) => runCheck(cmd, cwd, clock, new AbortController().signal);
		expect(await run('[[ "$PWD" == "' + realpathSync(dir) + '" ]] && printf bash')).toMatchObject({ status: "passed", stdout: "bash" });
		const output = await run("printf '%020000d' 0; printf '%020000d' 0 >&2");
		expect(Buffer.byteLength(output.stdout)).toBe(CHECK_OUTPUT_BYTES);
		expect(Buffer.byteLength(output.stderr)).toBe(CHECK_OUTPUT_BYTES);
		expect(await run("true", join(dir, "missing"))).toMatchObject({ status: "failed" });
		expect(await run("kill -TERM $$")).toMatchObject({ status: "failed", signal: "SIGTERM" });
	});

	it("SCH-12 times out and kills a process group using the runtime clock; shutdown cancellation also settles", async () => {
		dir = mkdtempSync(join(tmpdir(), "pana-condition-"));
		const clock = createFakeClock();
		const abort = new AbortController();
		const pending = runCheck("touch started; while :; do :; done", dir, clock, abort.signal);
		await vi.waitFor(() => expect(existsSync(join(dir!, "started"))).toBe(true));
		await clock.advance(CHECK_TIMEOUT_MS);
		expect(await pending).toMatchObject({ status: "failed", error: `check timed out after ${CHECK_TIMEOUT_MS}ms` });
		const cancelled = runCheck("while :; do :; done", dir, clock, abort.signal);
		abort.abort();
		expect(await cancelled).toMatchObject({ status: "failed", error: "check cancelled during scheduler shutdown" });
	});

	it("SCH-12 shutdown settles even if a child escapes the check process group", async () => {
		dir = mkdtempSync(join(tmpdir(), "pana-condition-"));
		const clock = createFakeClock();
		const abort = new AbortController();
		const pending = runCheck("set -m; (while :; do :; done) & echo $! > escaped; wait", dir, clock, abort.signal);
		let pid: number | undefined;
		try {
			await vi.waitFor(() => {
				expect(existsSync(join(dir!, "escaped"))).toBe(true);
				pid = Number(readFileSync(join(dir!, "escaped"), "utf8").trim());
				expect(pid).toBeGreaterThan(0);
			});
			abort.abort();
			expect(await pending).toMatchObject({ status: "failed", error: "check cancelled during scheduler shutdown" });
		} finally {
			abort.abort();
			if (pid) { try { process.kill(pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } }
		}
	});

	it("SCH-13 a slow check does not block unrelated schedules, cannot overlap itself, and deletion cancels dispatch", async () => {
		let calls = 0;
		t = await startTestPanad({ handlers: { "sessions.create": () => { calls++; return { status: 201 }; } } });
		dir = mkdtempSync(join(tmpdir(), "pana-condition-"));
		const slow = await create({ check: "touch started; while [[ ! -f release ]]; do :; done", checkCwd: dir });
		await create({ check: "true" });
		await t.clock.advanceTo(slow.nextAt!);
		await vi.waitFor(() => expect(calls).toBe(1));
		await vi.waitFor(() => expect(existsSync(join(dir!, "started"))).toBe(true));
		await t.client.delete(`/schedules/${slow.id}`);
		writeFileSync(join(dir, "release"), "");
		await vi.waitFor(async () => {
			const row = await t!.runtime.db.get<{ last_check: string | null }>("SELECT last_check FROM schedules WHERE id = ?", slow.id);
			expect(row!.last_check).not.toBeNull();
		});
		expect(calls).toBe(1);
	});

	it("SCH-13 skips occurrences while a check runs and preserves its result across restart", async () => {
		let calls = 0;
		const handlers = { "sessions.create": () => { calls++; return { status: 201 }; } };
		t = await startTestPanad({ handlers });
		dir = mkdtempSync(join(tmpdir(), "pana-condition-"));
		const schedule = await create({ cron: "* * * * * *", check: "echo run >> runs; while [[ ! -f release ]]; do :; done", checkCwd: dir });
		await t.clock.advanceTo(schedule.nextAt!);
		await vi.waitFor(() => expect(existsSync(join(dir!, "runs"))).toBe(true));
		await t.clock.advance(5_000);
		expect(readFileSync(join(dir, "runs"), "utf8")).toBe("run\n");
		writeFileSync(join(dir, "release"), "");
		await checked(schedule.id);
		await vi.waitFor(() => expect(calls).toBe(1));
		await vi.waitFor(async () => expect((await show(schedule.id)).nextAt!).toBeGreaterThan(t!.clock.now()));
		const result = (await show(schedule.id)).lastCheck;
		const first = t;
		await first.stop();
		await first.clock.advance(5_000);
		t = await startTestPanad({ stateDir: first.dir, clock: first.clock, handlers });
		expect((await show(schedule.id)).lastCheck).toEqual(result);
		expect(calls).toBe(1);
		expect((await show(schedule.id)).nextAt!).toBeGreaterThan(t.clock.now());
	});

	it("SCH-13 marks an exhausted finite cron done when its last occurrence was missed in flight", async () => {
		let release!: () => void;
		let dispatched = false;
		const pending = new Promise<void>((resolve) => { release = resolve; });
		t = await startTestPanad({ handlers: { "sessions.create": async () => { dispatched = true; await pending; return { status: 201 }; } } });
		const schedule = await create({ cron: "0,1 0 10 5 1 * 2026" });
		await t.clock.advanceTo(schedule.nextAt!);
		await vi.waitFor(() => expect(dispatched).toBe(true));
		await t.clock.advance(2_000);
		release();
		await vi.waitFor(async () => expect(await show(schedule.id)).toMatchObject({ state: "done", nextAt: null }));
	});

	it("SCH-14 an old dispatch cannot finish or retime a concurrently edited schedule", async () => {
		let release!: () => void;
		let dispatched = false;
		const pending = new Promise<void>((resolve) => { release = resolve; });
		t = await startTestPanad({ handlers: { "sessions.create": async () => { dispatched = true; await pending; return { status: 201 }; } } });
		const schedule = await create({ stopAfterSuccess: true });
		await t.clock.advanceTo(schedule.nextAt!);
		await vi.waitFor(() => expect(dispatched).toBe(true));
		await t.clock.advance(2 * 60_000);
		const nextAt = t.clock.now() + 600_000;
		expect((await t.client.post(`/schedules/${schedule.id}`, { at: nextAt, stopAfterSuccess: false, payload: { prompt: "edited" } })).status).toBe(200);
		release();
		await t.clock.settle();
		expect(await show(schedule.id)).toMatchObject({ state: "active", nextAt, stopAfterSuccess: false, cron: null });
	});

	it("SCH-14 stops only after successful dispatch, not after a passed check with failed dispatch", async () => {
		let calls = 0;
		t = await startTestPanad({ handlers: { "sessions.create": () => { calls++; if (calls === 1) throw new Error("not dispatched"); return { status: 201 }; } } });
		const schedule = await create({ check: "true", stopAfterSuccess: true });
		await t.clock.advanceTo(schedule.nextAt!);
		await vi.waitFor(() => expect(calls).toBe(1));
		expect((await show(schedule.id)).state).toBe("active");
		await t.clock.advanceTo((await show(schedule.id)).nextAt!);
		await vi.waitFor(async () => expect((await show(schedule.id)).state).toBe("done"));
		expect(calls).toBe(2);
		await t.clock.advance(180_000);
		expect(calls).toBe(2);
	});
});
