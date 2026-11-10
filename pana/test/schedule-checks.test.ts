import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, realpathSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCheck, runStoredCheck, CHECK_OUTPUT_BYTES, CHECK_TIMEOUT_MS } from "../src/schedules/check.ts";
import { scheduleScope, sessionBox } from "../src/schedules/check-box.ts";
import { claimScheduleForRun, finishSchedule, type ScheduleRow, type ScheduleView } from "../src/schedules/store.ts";
import type { Runtime } from "../src/server/runtime.ts";
import { createFakeClock, startTestPanad, type TestPanad } from "./harness/index.ts";

let t: TestPanad | undefined;
let dir: string | undefined;
afterEach(async () => {
	await t?.close();
	t = undefined;
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
	delete process.env.PANA_TEST_SECRET;
});

/** A session that exists (and can act as a caller) without running anything. */
async function session(harness: TestPanad): Promise<string> {
	const id = harness.runtime.newId();
	await harness.runtime.db.write(async (tx) => {
		await tx.run("INSERT INTO participants (id, kind, url, created_at) VALUES (?, 'session', ?, ?)", id, harness.runtime.url({ kind: "session", id }), harness.clock.now());
		await tx.run("INSERT INTO sessions (id, state, depth, created_at, updated_at) VALUES (?, 'idle', 0, ?, ?)", id, harness.clock.now(), harness.clock.now());
	});
	return id;
}

/** A runtime with only the paths a session's box reads, for unit tests of the runner. */
function pathsOnly(state: string): Runtime {
	return { paths: { dir: state, scratch: join(state, "scratch"), memoryWorktrees: join(state, "memory", "worktrees") } } as unknown as Runtime;
}

function canNamespace(): boolean {
	try {
		execFileSync("unshare", ["--map-root-user", "--mount", "true"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}
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

	// SCH-09: a session defines its own check again, and the check runs inside that session's box.
	it("SCH-09 a session defines a check that runs in its own box, with its own env and cwd", async () => {
		let calls = 0;
		t = await startTestPanad({ handlers: { "sessions.create": () => { calls++; return { status: 201 }; } } });
		process.env.PANA_TEST_SECRET = "panad-only";
		const mine = await session(t);
		const scratch = join(t.runtime.paths.scratch, mine);
		mkdirSync(scratch, { recursive: true });
		const asSession = (extra: Record<string, unknown>) => t!.client.post<{ schedule: ScheduleView }>("/schedules", { ...base, ...extra }, { caller: mine });

		// The command proves the box: the session's own identity, its scratch, its PWD, and no
		// variable panad holds. Any miss prints the environment and fails with exit 2.
		// `PWD` is the physical path the kernel starts the child in; on macOS `/tmp` and `/var` are
		// symlinks, so compare it with the resolved scratch while `PANA_SCRATCH` keeps its own spelling.
		const command = `[[ "$PANA_SESSION" == "${mine}" && "$PANA_SCRATCH" == "${scratch}" && "$(pwd -P)" == "${realpathSync(scratch)}" && -z "\${PANA_TEST_SECRET:-}" ]] || { env; exit 2; }`;
		const made = await asSession({ check: command });
		expect(made.status).toBe(201);
		const schedule = made.body.schedule;
		// A session's check defaults to its scratch, never panad's cwd.
		expect(schedule).toMatchObject({ check: command, checkCwd: scratch });
		expect(await t.runtime.db.get("SELECT session_id FROM check_authors WHERE scope = ?", scheduleScope(schedule.id))).toEqual({ session_id: mine });

		await t.clock.advanceTo(schedule.nextAt!);
		expect(await checked(schedule.id)).toMatchObject({ status: "passed", exitCode: 0, stderr: "" });
		await vi.waitFor(() => expect(calls).toBe(1));

		// An edit that leaves the cwd alone keeps it; a cwd outside the box is refused, and names it.
		const kept = await t.client.post<{ schedule: ScheduleView }>(`/schedules/${schedule.id}`, { check: "exit 0" }, { caller: mine });
		expect(kept.status).toBe(200);
		expect(kept.body.schedule.checkCwd).toBe(scratch);
		// An edit that does not name the check keeps its command, cwd, and author.
		expect((await t.client.post(`/schedules/${schedule.id}`, { payload: { prompt: "edited" } }, { caller: mine })).status).toBe(200);
		expect(await show(schedule.id)).toMatchObject({ check: "exit 0", checkCwd: scratch });
		expect(await t.runtime.db.get("SELECT session_id FROM check_authors WHERE scope = ?", scheduleScope(schedule.id))).toEqual({ session_id: mine });
		const outside = await t.client.post(`/schedules/${schedule.id}`, { checkCwd: tmpdir() }, { caller: mine });
		expect(outside.status).toBe(400);
		expect((outside.body as { error: { code: string; message: string } }).error).toMatchObject({ code: "invalid_check_cwd" });
		expect((outside.body as { error: { message: string } }).error.message).toContain(scratch);
		// A peer session's worktree is outside it too.
		const peer = join(t.runtime.paths.dir, "worktrees", "01ARZ3NDEKTSV4RRFFQ69G5FAV");
		expect((await t.client.post(`/schedules/${schedule.id}`, { checkCwd: peer }, { caller: mine })).status).toBe(400);
		// Clearing the check clears its author with it.
		expect((await t.client.post(`/schedules/${schedule.id}`, { check: null }, { caller: mine })).status).toBe(200);
		expect(await show(schedule.id)).toMatchObject({ check: null, checkCwd: null });
		expect(await t.runtime.db.get("SELECT session_id FROM check_authors WHERE scope = ?", scheduleScope(schedule.id))).toBeFalsy();
	});

	// SCH-09/#203: a check belongs to its schedule, so only that schedule's creator (or the user)
	// may set one, and the box is the author's: a check never runs under another session's identity.
	it("SCH-09 a session sets a check only on its own schedule, and it runs as that session", async () => {
		t = await startTestPanad({ handlers: { "sessions.create": () => ({ status: 201 }) } });
		const other = await session(t);
		const mine = await session(t);
		const theirs = await t.client.post<{ schedule: ScheduleView }>("/schedules", { ...base }, { caller: other });
		expect(theirs.status).toBe(201);
		// #203: the neighbour's schedule is not the caller's to change, so it cannot carry its check.
		const refused = await t.client.post(`/schedules/${theirs.body.schedule.id}`, { check: 'printf "%s" "$PANA_SESSION"' }, { caller: mine });
		expect(refused.status).toBe(403);
		expect(await t.runtime.db.get("SELECT session_id FROM check_authors WHERE scope = ?", scheduleScope(theirs.body.schedule.id))).toBeFalsy();

		// On its own schedule the caller is the author, so the check runs with the caller's identity.
		const own = await t.client.post<{ schedule: ScheduleView }>("/schedules", { ...base }, { caller: mine });
		expect(own.status).toBe(201);
		const set = await t.client.post(`/schedules/${own.body.schedule.id}`, { check: 'printf "%s:%s" "${PANA_SESSION}" "${PANA_SCRATCH}"' }, { caller: mine });
		expect(set.status).toBe(200);
		expect(await t.runtime.db.get("SELECT session_id FROM check_authors WHERE scope = ?", scheduleScope(own.body.schedule.id))).toEqual({ session_id: mine });
		await t.clock.advanceTo(own.body.schedule.nextAt!);
		await vi.waitFor(async () => expect((await show(own.body.schedule.id)).lastCheck).not.toBeNull());
		expect((await show(own.body.schedule.id)).lastCheck!.stdout).toBe(`${mine}:${join(t.runtime.paths.scratch, mine)}`);
	});

	// SCH-09/GUARD: a session's check cannot leave its box even when the stored row says it should,
	// and the guard refuses the user's primary checkout either way.
	it("SCH-09 a session check is refused outside its box, and the guard keeps it out of a checkout", async () => {
		const home = mkdtempSync(join(tmpdir(), "pana-box-home-"));
		const state = mkdtempSync(join(tmpdir(), "pana-box-state-"));
		dir = home;
		try {
			const repo = join(home, "dotfiles");
			mkdirSync(join(repo, ".git"), { recursive: true });
			const box = sessionBox(pathsOnly(state), "01M6YZ5VCHZEZ6HKNF1KXFG08C");
			mkdirSync(box.scratchDir, { recursive: true });
			const clock = createFakeClock();
			const host = { stateDir: state, box, checkoutRoots: [home] };

			// A stored cwd inside the user's checkout is a failure, not a run.
			const outside = await runCheck(`printf nope > ${join(repo, "from-check.txt")}`, repo, clock, new AbortController().signal, host);
			expect(outside).toMatchObject({ status: "failed", exitCode: null });
			expect(outside.error).toContain("box");
			expect(existsSync(join(repo, "from-check.txt"))).toBe(false);

			// The same command runs inside the box.
			const inside = await runCheck(`printf ok > ${join(box.scratchDir, "done.txt")}; printf ok`, box.scratchDir, clock, new AbortController().signal, host);
			expect(inside).toMatchObject({ status: "passed", stdout: "ok" });
			expect(readFileSync(join(box.scratchDir, "done.txt"), "utf8")).toBe("ok");
		} finally {
			rmSync(state, { recursive: true, force: true });
		}
	});

	it.skipIf(!canNamespace())("SCH-09/GUARD-02 sandbox mode mounts the user's checkout read-only for a session check", async () => {
		const home = mkdtempSync(join(tmpdir(), "pana-box-home-"));
		const state = mkdtempSync(join(tmpdir(), "pana-box-state-"));
		dir = home;
		try {
			const repo = join(home, "dotfiles");
			mkdirSync(join(repo, ".git"), { recursive: true });
			const box = sessionBox(pathsOnly(state), "01M6YZ5VCHZEZ6HKNF1KXFG08C");
			mkdirSync(box.scratchDir, { recursive: true });
			const result = await runCheck(
				`printf nope > ${join(repo, "from-check.txt")}`,
				box.scratchDir,
				createFakeClock(),
				new AbortController().signal,
				{ stateDir: state, box, checkoutRoots: [home], protectCheckouts: "sandbox" },
			);
			// Bash reports the read-only mount as a failed write; the file never appears.
			expect(result.exitCode).not.toBe(0);
			expect(existsSync(join(repo, "from-check.txt"))).toBe(false);
		} finally {
			rmSync(state, { recursive: true, force: true });
		}
	});

	it("SCH-12 a check sees only PANA_ENV_NAMES, never panad's own environment", async () => {
		dir = mkdtempSync(join(tmpdir(), "pana-condition-"));
		const clock = createFakeClock();
		process.env.PANA_TEST_SECRET = "panad-only";
		try {
			const command = 'printf "secret=%s home=%s session=%s\\n" "${PANA_TEST_SECRET:-unset}" "${HOME:+set}" "${PANA_SESSION:-none}"';
			const result = await runCheck(command, dir, clock, new AbortController().signal);
			expect(result).toMatchObject({ status: "passed", exitCode: 0, error: null });
			expect(result.stdout.trim()).toBe("secret=unset home=set session=none");
		} finally {
			delete process.env.PANA_TEST_SECRET;
		}
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

	it("SCH-12 normal completion kills background group members, even if they ignore TERM", async () => {
		dir = mkdtempSync(join(tmpdir(), "pana-condition-"));
		const clock = createFakeClock();
		for (const code of [0, 1, 7]) {
			const pidFile = join(dir, `child-${code}`);
			let pid = 0;
			try {
				const result = await runCheck(`(trap '' TERM; while :; do :; done) >/dev/null 2>&1 & echo $! > '${pidFile}'; exit ${code}`, dir, clock, new AbortController().signal);
				pid = Number(readFileSync(pidFile, "utf8"));
				expect(result).toMatchObject({ exitCode: code, status: code === 0 ? "passed" : code === 1 ? "not_ready" : "failed" });
				await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
			} finally {
				if (pid) { try { process.kill(pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } }
			}
		}
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
		// `echo run >> runs` creates the file before it writes it, so existence alone
		// lets a slow runner read the empty file. Wait for the line the check echoes.
		await vi.waitFor(() => {
			expect(existsSync(join(dir!, "runs"))).toBe(true);
			expect(readFileSync(join(dir!, "runs"), "utf8")).toBe("run\n");
		});
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

describe("check authority races", () => {
	it("captures command, cwd and session authority together across update and delete", async () => {
		t = await startTestPanad();
		const mine = await session(t);
		const made = await t.client.post<{ schedule: ScheduleView }>("/schedules", { ...base, check: 'printf "%s" "$PANA_SESSION"' }, { caller: mine });
		const id = made.body.schedule.id;
		const before = (await t.runtime.db.get<ScheduleRow>("SELECT * FROM schedules WHERE id = ?", id))!;
		const claimed = (await claimScheduleForRun(t.runtime, before, "active", before.next_at! + 60_000))!;
		expect(claimed.author).toBe(mine);
		expect((await t.client.post(`/schedules/${id}`, { check: "printf user" })).status).toBe(200);
		expect(await claimScheduleForRun(t.runtime, before, "active", before.next_at! + 60_000)).toBeUndefined();
		expect((await t.client.delete(`/schedules/${id}`)).status).toBe(204);
		expect(await claimScheduleForRun(t.runtime, before, "active", before.next_at! + 60_000)).toBeUndefined();
		const result = await runStoredCheck(t.runtime, { command: claimed.row.check_command!, cwd: claimed.row.check_cwd, author: claimed.author }, t.clock, new AbortController().signal);
		expect(result).toMatchObject({ status: "passed", stdout: mine });
	});

	it("does not erase a newer author's record when stale wake completion loses", async () => {
		t = await startTestPanad();
		const mine = await session(t);
		const made = await t.client.post<{ schedule: ScheduleView }>("/schedules", { ...base }, { caller: mine });
		const id = made.body.schedule.id;
		const old = (await t.runtime.db.get<ScheduleRow>("SELECT * FROM schedules WHERE id = ?", id))!;
		expect((await t.client.post(`/schedules/${id}`, { check: "true" }, { caller: mine })).status).toBe(200);
		await finishSchedule(t.runtime, id, old.revision);
		expect(await t.runtime.db.get("SELECT session_id FROM check_authors WHERE scope = ?", scheduleScope(id))).toEqual({ session_id: mine });
		expect((await show(id)).state).toBe("active");
	});

	it("fails closed for missing legacy authority until the check is explicitly redefined", async () => {
		t = await startTestPanad();
		const schedule = await create({ check: "true" });
		await t.runtime.db.write(tx => tx.run("DELETE FROM check_authors WHERE scope = ?", scheduleScope(schedule.id)));
		expect((await t.client.post(`/schedules/${schedule.id}`, { checkCwd: tmpdir() })).status).toBe(400);
		await t.clock.advanceTo(schedule.nextAt!);
		expect(await checked(schedule.id)).toMatchObject({ status: "failed", error: expect.stringContaining("author is missing") });
		expect((await t.client.post(`/schedules/${schedule.id}`, { check: "true" })).status).toBe(200);
		await t.clock.advanceTo((await show(schedule.id)).nextAt!);
		expect((await checked(schedule.id, schedule.nextAt!)).status).toBe("passed");
	});
});

it("SCH-09 upgrades a pre-author database without guessing who wrote its check", async () => {
	t = await startTestPanad();
	const schedule = await create({ check: "true" });
	// Model a version-15 database: it predates the check_authors table entirely.
	await t.runtime.db.write(async tx => {
		await tx.exec("DROP TABLE check_authors; PRAGMA user_version = 15;");
	});
	const first = t;
	await first.stop();
	t = await startTestPanad({ stateDir: first.dir, clock: first.clock });
	expect(await t.runtime.db.get("PRAGMA user_version")).toEqual({ user_version: 16 });
	await t.clock.advanceTo(schedule.nextAt!);
	expect(await checked(schedule.id)).toMatchObject({ status: "failed", error: expect.stringContaining("author is missing") });
});

it("SCH-09 preserves a legacy session author on restart", async () => {
	t = await startTestPanad();
	const mine = await session(t);
	const made = await t.client.post<{ schedule: ScheduleView }>("/schedules", { ...base, check: 'printf "%s" "$PANA_SESSION"' }, { caller: mine });
	const first = t;
	await first.stop();
	t = await startTestPanad({ stateDir: first.dir, clock: first.clock });
	await t.clock.advanceTo(made.body.schedule.nextAt!);
	expect(await checked(made.body.schedule.id)).toMatchObject({ status: "passed", stdout: mine });
});
