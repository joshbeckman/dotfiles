import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runStoredCheck } from "../src/schedules/check.ts";
import { claimScheduleForRun, sessionWakes, updateSchedule, type ScheduleRow, type ScheduleView } from "../src/schedules/store.ts";
import { startTestPanad, TEST_USER, type TestPanad } from "./harness/index.ts";

let t: TestPanad | undefined;
afterEach(async () => { vi.restoreAllMocks(); await t?.close(); t = undefined; });

async function session(): Promise<string> {
	const id = t!.runtime.newId();
	await t!.runtime.db.write(async (tx) => {
		await tx.run("INSERT INTO participants (id, kind, url, created_at) VALUES (?, 'session', ?, ?)", id, t!.runtime.url({ kind: "session", id }), t!.clock.now());
		await tx.run("INSERT INTO sessions (id, state, depth, created_at, updated_at) VALUES (?, 'idle', 0, ?, ?)", id, t!.clock.now(), t!.clock.now());
	});
	return id;
}

async function create(body: Record<string, unknown>, caller?: string): Promise<ScheduleView> {
	const response = await t!.client.post<{ schedule: ScheduleView }>("/schedules", { at: t!.clock.now() + 60_000, subject: "Manual", ...body }, caller ? { caller } : {});
	expect(response.status).toBe(201);
	return response.body.schedule;
}

it("normalizes replacement wake targets and applies the session default on updates", async () => {
	t = await startTestPanad();
	const mine = await session();
	const other = await session();
	const wake = await create({ kind: "wake", payload: { note: "Initial" } }, mine);
	const edit = (payload: unknown, caller?: string) => t!.client.post<{ schedule: ScheduleView }>(`/schedules/${wake.id}`, { payload }, caller ? { caller } : {});

	const selfUrl = t.runtime.url({ kind: "session", id: mine });
	const self = await edit({ session: ` ${selfUrl} `, note: "Self" }, mine);
	expect(self.status).toBe(200);
	expect(self.body.schedule.payload).toEqual({ session: mine, note: "Self" });
	const defaulted = await edit({ note: "Default" }, mine);
	expect(defaulted.status).toBe(200);
	expect(defaulted.body.schedule.payload).toEqual({ session: mine, note: "Default" });
	expect((await edit({ note: "No user default" })).status).toBe(400);
	expect((await edit({ session: other, note: "Not self" }, mine)).status).toBe(403);
	expect((await edit({ session: t.runtime.url({ kind: "session", id: other }), note: "Not self" }, mine)).status).toBe(403);
	expect((await edit({ session: mine, note: " " }, mine)).status).toBe(400);

	const target = await edit({ session: t.runtime.url({ kind: "session", id: other }), note: "User retarget" });
	expect(target.status).toBe(200);
	expect(target.body.schedule.payload).toEqual({ session: other, note: "User retarget" });
	expect((await sessionWakes(t.runtime, other)).map((item) => item.id)).toContain(wake.id);
	expect((await sessionWakes(t.runtime, mine)).map((item) => item.id)).not.toContain(wake.id);
	// The user can retarget a session-owned wake; its owner cannot edit the retained foreign target.
	expect((await t.client.post(`/schedules/${wake.id}`, { subject: "Changed" }, { caller: mine })).status).toBe(403);
	expect((await t.client.post(`/schedules/${wake.id}`, { subject: "Changed" })).status).toBe(200);
});

it("validates retained payloads on kind changes and every effective wake target", async () => {
	t = await startTestPanad();
	const mine = await session();
	const other = await session();
	const withoutNote = await create({ kind: "session", payload: { prompt: "Hello" } }, mine);
	expect((await t.client.post(`/schedules/${withoutNote.id}`, { kind: "wake" }, { caller: mine })).status).toBe(400);
	const foreign = await create({ kind: "session", payload: { prompt: "Hello", note: "Check", session: t.runtime.url({ kind: "session", id: other }) } }, mine);
	expect((await t.client.post(`/schedules/${foreign.id}`, { kind: "wake" }, { caller: mine })).status).toBe(403);
	const converted = await t.client.post<{ schedule: ScheduleView }>(`/schedules/${foreign.id}`, { kind: "wake" });
	expect(converted.status).toBe(200);
	expect(converted.body.schedule.payload.session).toBe(other);
	const own = await create({ kind: "session", payload: { prompt: "Hello", note: "Check" } }, mine);
	const defaulted = await t.client.post<{ schedule: ScheduleView }>(`/schedules/${own.id}`, { kind: "wake" }, { caller: mine });
	expect(defaulted.status).toBe(200);
	expect(defaulted.body.schedule.payload.session).toBe(mine);
	const unnamed = await create({ kind: "session", payload: { prompt: "Hello", note: "Check" } });
	expect((await t.client.post(`/schedules/${unnamed.id}`, { kind: "wake" })).status).toBe(400);

	await t.runtime.db.write(async (tx) => { await tx.run("UPDATE sessions SET state = 'archived' WHERE id = ?", mine); });
	expect((await t.client.post(`/schedules/${own.id}`, { subject: "Retained" })).status).toBe(409);
	expect((await t.client.post(`/schedules/${own.id}`, { payload: { session: t!.runtime.newId(), note: "Missing" } })).status).toBe(404);
});

it("checks the row and target inside the write, after an earlier queued change", async () => {
	t = await startTestPanad();
	const mine = await session();
	const other = await session();
	const wake = await create({ kind: "wake", payload: { session: mine, note: "Initial" } }, mine);
	const db = t.runtime.db;
	const originalWrite = db.write.bind(db);
	const spy = vi.spyOn(db, "write");
	spy.mockImplementationOnce(async (fn) => {
		// Model a user update committed after a stale preflight read, before this update's write.
		await originalWrite(async (tx) => { await tx.run("UPDATE schedules SET payload = ? WHERE id = ?", JSON.stringify({ session: other, note: "Retargeted" }), wake.id); });
		return originalWrite(fn);
	});
	await expect(updateSchedule(t.runtime, { kind: "session", id: mine, url: t.runtime.url({ kind: "session", id: mine }) }, wake.id, { subject: "Edit" })).rejects.toMatchObject({ status: 403 });
	const row = await db.get<{ payload: string; subject: string }>("SELECT payload, subject FROM schedules WHERE id = ?", wake.id);
	expect(JSON.parse(row!.payload).session).toBe(other);
	expect(row!.subject).toBe("Manual");
});

it("checks target state in the same write that saves the wake", async () => {
	t = await startTestPanad();
	const mine = await session();
	const other = await session();
	const wake = await create({ kind: "wake", payload: { session: mine, note: "Initial" } });
	const db = t.runtime.db;
	const originalWrite = db.write.bind(db);
	vi.spyOn(db, "write").mockImplementationOnce(async (fn) => {
		await originalWrite(async (tx) => { await tx.run("UPDATE sessions SET state = 'archived' WHERE id = ?", other); });
		return originalWrite(fn);
	});
	await expect(updateSchedule(t.runtime, { kind: "user", id: TEST_USER, url: "" }, wake.id, { payload: { session: other, note: "Check" } })).rejects.toMatchObject({ status: 409 });
	const row = await db.get<{ payload: string }>("SELECT payload FROM schedules WHERE id = ?", wake.id);
	expect(JSON.parse(row!.payload).session).toBe(mine);
});


it("keeps wake target, claimed check authority, and cwd provenance together across an edit", async () => {
	t = await startTestPanad();
	const mine = await session();
	const made = await t.client.post<{ schedule: ScheduleView }>("/schedules", {
		kind: "wake", cron: "* * * * *", note: "Initial", check: "true", subject: "Manual",
	}, { caller: mine });
	expect(made.status).toBe(201);
	const id = made.body.schedule.id;
	const before = (await t.runtime.db.get<ScheduleRow>("SELECT * FROM schedules WHERE id = ?", id))!;
	const edited = await t.client.post<{ schedule: ScheduleView }>(`/schedules/${id}`, {
		payload: { session: t.runtime.url({ kind: "session", id: mine }), note: "Updated" },
	}, { caller: mine });
	expect(edited.status).toBe(200);
	expect(edited.body.schedule.payload.session).toBe(mine);
	expect(await claimScheduleForRun(t.runtime, before, "active", before.next_at! + 60_000)).toBeUndefined();
	const current = (await t.runtime.db.get<ScheduleRow>("SELECT * FROM schedules WHERE id = ?", id))!;
	const claim = (await claimScheduleForRun(t.runtime, current, "active", current.next_at! + 60_000))!;
	expect(claim.author).toBe(mine);
	expect(JSON.parse(claim.row.payload).session).toBe(mine);
	const stored = { command: claim.row.check_command!, cwd: claim.row.check_cwd, author: claim.author };
	const signal = new AbortController().signal;
	expect((await runStoredCheck(t.runtime, stored, t.clock, signal)).status).toBe("passed");
	const replacement = join(t.runtime.paths.dir, "outside-check-box");
	mkdirSync(replacement);
	rmSync(stored.cwd!, { recursive: true });
	symlinkSync(replacement, stored.cwd!);
	expect((await runStoredCheck(t.runtime, stored, t.clock, signal)).status).toBe("failed");
});
