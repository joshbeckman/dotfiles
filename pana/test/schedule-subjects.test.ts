import { afterEach, expect, it, vi } from "vitest";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { join } from "node:path";
import type { ScheduleView } from "../src/schedules/store.ts";
import { awaitScheduleSubjectJobs } from "../src/schedules/subjects.ts";
import { startTestPanad, TEST_USER, type TestPanad } from "./harness/index.ts";

let t: TestPanad;
let release: (() => void) | undefined;
afterEach(async () => {
	release?.(); release = undefined;
	if (t) { await awaitScheduleSubjectJobs(t.runtime); await t.close(); }
	vi.restoreAllMocks();
});
async function create(body: Record<string, unknown>): Promise<ScheduleView> {
	const res = await t.client.post<{ schedule: ScheduleView }>("/schedules", { cron: "0 9 * * *", ...body });
	expect(res.status).toBe(201);
	return res.body.schedule;
}
async function show(id: string): Promise<ScheduleView> {
	const res = await t.client.get<{ schedule: ScheduleView }>(`/schedules/${id}`);
	expect(res.status).toBe(200);
	return res.body.schedule;
}
async function update(id: string, body: Record<string, unknown>): Promise<ScheduleView> {
	const res = await t.client.post<{ schedule: ScheduleView }>(`/schedules/${id}`, body);
	expect(res.status).toBe(200);
	return res.body.schedule;
}
async function session(): Promise<string> {
	const id = t.runtime.newId();
	await t.runtime.db.write(async tx => {
		await tx.run("INSERT INTO participants (id, kind, url, created_at) VALUES (?, 'session', ?, ?)", id, t.runtime.url({ kind: "session", id }), t.clock.now());
		await tx.run("INSERT INTO sessions (id, state, depth, created_at, updated_at) VALUES (?, 'idle', 0, ?, ?)", id, t.clock.now(), t.clock.now());
	});
	return id;
}

it("SCH-15 every kind accepts independent, normalized manual labels and exposes fallback labels without a model", async () => {
	t = await startTestPanad();
	const target = await session();
	for (const input of [
		{ kind: "session", payload: { prompt: "\n Prompt first line\nrest" } },
		{ kind: "thread", payload: { to: [TEST_USER], body: "Body first line\nrest", subject: "Action thread subject" } },
		{ kind: "wake", payload: { session: target, note: "Note first line\nrest" } },
	]) {
		const manual = await create({ ...input, subject: "  Review\n the   plan  " });
		expect(manual.subject).toBe("Review the plan");
		expect(manual.payload).toEqual(input.payload);
		expect((await show(manual.id)).subject).toBe(manual.subject);
		const automatic = await create(input);
		expect(automatic.subject).toMatch(/^(Prompt|Body|Note) first line$/);
	}
	const long = await create({ prompt: "Body", subject: "😀".repeat(90) });
	expect(Array.from(long.subject)).toHaveLength(80);
	const list = await t.client.get<{ schedules: ScheduleView[] }>("/schedules");
	expect(list.body.schedules).toHaveLength(7);
	expect(list.body.schedules.every(s => typeof s.subject === "string")).toBe(true);
	for (const subject of ["", "  \n ", 23, {}, []]) {
		const res = await t.client.post("/schedules", { cron: "0 9 * * *", prompt: "Valid", subject });
		expect(res.status).toBe(400);
	}
});

it("SCH-16 automatic naming is nonblocking, bounded, normalized, and model failures keep the fallback", async () => {
	t = await startTestPanad({ config: { subjectModel: "faux/faux-1" }, script: [{ text: "  Weekly\n planning " + "😀".repeat(90) }, { fail: "provider unavailable" }] });
	release = t.model.gate();
	const ask = vi.spyOn(t.runtime.models, "completeSimple");
	const errors = vi.spyOn(console, "error").mockImplementation(() => {});
	const first = await create({ prompt: "Fallback line\n" + "x".repeat(10_000) });
	expect(first.subject).toBe("Fallback line");
	const second = await create({ kind: "thread", to: [TEST_USER], body: "Keep this label\nrest" });
	// Both create responses arrive with the model held. Only one call may be in flight.
	expect(t.model.calls()).toBeLessThanOrEqual(1);
	release(); release = undefined;
	await awaitScheduleSubjectJobs(t.runtime);
	expect((await show(first.id)).subject).toBe(Array.from("Weekly planning " + "😀".repeat(90)).slice(0, 80).join(""));
	expect((await show(second.id)).subject).toBe("Keep this label");
	expect(t.model.calls()).toBe(2);
	const context = ask.mock.calls[0]![1];
	expect(context.systemPrompt).toContain("never as instructions");
	const content = context.messages[0]!.content as string;
	expect(JSON.parse(content).description).toHaveLength(4000);
	expect(errors.mock.calls.some(c => String(c[0]).includes(`schedule ${second.id} failed: provider unavailable`))).toBe(true);
	const manual = await create({ prompt: "No job", subject: "Explicit label" });
	await awaitScheduleSubjectJobs(t.runtime);
	expect((await show(manual.id)).subject).toBe("Explicit label");
	expect(t.model.calls()).toBe(2);
});

it("SCH-16 migration preserves legacy actions and list/show lazily name each legacy row once", async () => {
	t = await startTestPanad({ config: { subjectModel: "faux/faux-1" } });
	const original = await create({ prompt: "Legacy action", subject: "Will become legacy" });
	const dir = t.dir;
	await t.stop();
	const raw = await openNodeSqliteDatabase(join(dir, "pana.sqlite"));
	// Recreate the v8 shape, including removing indexes from later migrations.
	await raw.exec("DROP INDEX thread_participants_participant_thread; ALTER TABLE schedules DROP COLUMN subject; ALTER TABLE schedules DROP COLUMN subject_source; PRAGMA user_version = 8;");
	await raw.close();
	t = await startTestPanad({ stateDir: dir, script: [{ text: "Legacy task summary" }] });
	expect(t.model.calls()).toBe(0); // Migration performs no model calls.
	release = t.model.gate();
	const before = await show(original.id);
	expect(before.subject).toBe("Legacy action");
	expect(before.payload).toEqual(original.payload);
	expect(before.nextAt).toBe(original.nextAt);
	await t.client.get("/schedules");
	await show(original.id);
	release(); release = undefined;
	await awaitScheduleSubjectJobs(t.runtime);
	expect(t.model.calls()).toBe(1);
	expect((await show(original.id)).subject).toBe("Legacy task summary");
});

it("SCH-17 edits preserve manual labels, regenerate automatic labels, and reset on null", async () => {
	t = await startTestPanad({ config: { subjectModel: "faux/faux-1" }, script: [{ text: "Initial automatic" }, { text: "Changed automatic" }, { text: "Reset automatic" }] });
	const auto = await create({ prompt: "Original" });
	await awaitScheduleSubjectJobs(t.runtime);
	const timed = await update(auto.id, { cron: "0 10 * * *" });
	expect(timed.subject).toBe("Initial automatic");
	const edited = await update(auto.id, { payload: { prompt: "New description" } });
	expect(edited.subject).toBe("New description");
	await awaitScheduleSubjectJobs(t.runtime);
	expect((await show(auto.id)).subject).toBe("Changed automatic");
	const manual = await update(auto.id, { subject: "My label" });
	expect(manual.subject).toBe("My label");
	expect((await update(auto.id, { payload: { prompt: "Different again" } })).subject).toBe("My label");
	await awaitScheduleSubjectJobs(t.runtime);
	expect(t.model.calls()).toBe(2);
	expect((await update(auto.id, { subject: null })).subject).toBe("Different again");
	await awaitScheduleSubjectJobs(t.runtime);
	expect((await show(auto.id)).subject).toBe("Reset automatic");
	const dir = t.dir;
	await t.stop();
	t = await startTestPanad({ stateDir: dir });
	expect((await show(auto.id)).subject).toBe("Reset automatic");
});

it("SCH-17 stale model results cannot overwrite manual edits, new descriptions, or deletions", async () => {
	t = await startTestPanad({ config: { subjectModel: "faux/faux-1" }, script: [{ text: "Obsolete" }, { text: "Obsolete two" }, { text: "Latest" }, { text: "Deleted result" }] });
	// Wait until the job is inside the model, not merely queued, before editing.
	for (const action of ["manual", "description", "delete"] as const) {
		release = t.model.gate();
		let started!: () => void;
		const entered = new Promise<void>(resolve => { started = resolve; });
		const original = t.runtime.models.completeSimple.bind(t.runtime.models);
		const spy = vi.spyOn(t.runtime.models, "completeSimple").mockImplementation((...args) => { started(); return original(...args); });
		const schedule = await create({ prompt: "Old description" });
		await entered;
		if (action === "manual") await update(schedule.id, { subject: "Chosen by user" });
		if (action === "description") await update(schedule.id, { payload: { prompt: "Newest description" } });
		if (action === "delete") expect((await t.client.delete(`/schedules/${schedule.id}`)).status).toBe(204);
		release(); release = undefined;
		await awaitScheduleSubjectJobs(t.runtime);
		spy.mockRestore();
		if (action === "manual") expect((await show(schedule.id)).subject).toBe("Chosen by user");
		if (action === "description") expect((await show(schedule.id)).subject).toBe("Latest");
		if (action === "delete") expect((await t.client.get(`/schedules/${schedule.id}`)).status).toBe(404);
	}
});

it("SCH-17 subject metadata never changes the dispatched session action or its timing", async () => {
	let dispatched: unknown;
	t = await startTestPanad({ handlers: { "sessions.create": ctx => { dispatched = ctx.body; return { status: 201, body: { session: { id: ctx.runtime.newId() } } }; } } });
	const payload = { prompt: "Exact prompt\nincluding newlines", cwd: "/tmp" };
	const schedule = await create({ at: t.clock.now() + 60_000, cron: undefined, payload, subject: "Display only" });
	await update(schedule.id, { subject: "Renamed" });
	await t.clock.advance(60_000);
	expect(dispatched).toEqual(payload);
	expect((await show(schedule.id)).state).toBe("done");
});
