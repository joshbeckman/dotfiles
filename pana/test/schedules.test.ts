import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { statusToExitCode } from "../src/api/errors.ts";
import type { Handlers } from "../src/api/types.ts";
import { createFakeClock, FAKE_EPOCH, startTestPanad, TEST_DOMAIN, TEST_USER, type Client, type TestPanad } from "./harness/index.ts";

interface Schedule {
	id: string;
	url: string;
	kind: "session" | "thread";
	state: "active" | "done" | "missed" | "deleted";
	cron: string | null;
	at: number | null;
	timezone: string;
	creator: { id: string; kind: string; url: string };
	payload: Record<string, unknown>;
	nextAt: number | null;
	createdAt: number;
	updatedAt: number;
}

interface CreatedSession {
	caller: string;
	callerKind: string;
	callerUrl: string;
	prompt?: string;
	at: number;
}

const NEW_YORK = "America/New_York";
const USER_URL = `pana://${TEST_DOMAIN}/users/${TEST_USER}`;

let t: TestPanad | undefined;
let scratch: string | undefined;
afterEach(async () => {
	await t?.close();
	t = undefined;
	if (scratch) rmSync(scratch, { recursive: true, force: true });
	scratch = undefined;
});

/** A fake WP3: records the sessions.create requests a schedule fires. */
function recorder(created: CreatedSession[]): Handlers {
	return {
		"sessions.create": (ctx) => {
			const body = (ctx.body ?? {}) as { prompt?: string };
			if (body.prompt === "explode") throw new Error("provider exploded");
			created.push({
				caller: ctx.caller.id,
				callerKind: ctx.caller.kind,
				callerUrl: ctx.caller.url,
				prompt: body.prompt,
				at: ctx.runtime.clock.now(),
			});
			return { status: 201, body: { session: { id: ctx.runtime.newId() } } };
		},
	};
}

async function create(client: Client, body: Record<string, unknown>): Promise<Schedule> {
	const res = await client.post<{ schedule: Schedule }>("/schedules", body);
	expect(res.status).toBe(201);
	return res.body.schedule;
}

async function show(client: Client, id: string): Promise<Schedule> {
	const res = await client.get<{ schedule: Schedule }>(`/schedules/${id}`);
	expect(res.status).toBe(200);
	return res.body.schedule;
}

async function listed(client: Client, query = ""): Promise<Schedule[]> {
	const res = await client.get<{ schedules: Schedule[] }>(`/schedules${query}`);
	expect(res.status).toBe(200);
	return res.body.schedules;
}

/** A session that exists (and can act as a caller) without running anything. */
async function session(harness: TestPanad): Promise<string> {
	const id = harness.runtime.newId();
	await harness.runtime.db.write(async (tx) => {
		await tx.run(
			"INSERT INTO participants (id, kind, url, created_at) VALUES (?, 'session', ?, ?)",
			id,
			harness.runtime.url({ kind: "session", id }),
			harness.clock.now(),
		);
		await tx.run("INSERT INTO sessions (id, state, depth, created_at, updated_at) VALUES (?, 'idle', 0, ?, ?)", id, harness.clock.now(), harness.clock.now());
	});
	return id;
}

async function inbox(client: Client): Promise<string[]> {
	const res = await client.get<{ deliveries: Array<{ body?: string; display?: string }> }>("/inbox");
	expect(res.status).toBe(200);
	return res.body.deliveries.map((delivery) => delivery.body ?? delivery.display ?? "");
}

async function newestThread(harness: TestPanad): Promise<{ id: string }> {
	const row = await harness.runtime.db.get<{ id: string }>("SELECT id FROM threads ORDER BY created_at DESC, id DESC LIMIT 1");
	expect(row).toBeDefined();
	return row!;
}

async function threadCount(harness: TestPanad): Promise<number> {
	const row = await harness.runtime.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM threads");
	return row!.n;
}

describe("scheduling", () => {
	it("SCH-01 a cron schedule creates a session at each cron time in the configured timezone", async () => {
		const created: CreatedSession[] = [];
		t = await startTestPanad({ config: { timezone: NEW_YORK }, handlers: recorder(created) });

		const schedule = await create(t.client, {
			kind: "session",
			cron: "0 9 * * *",
			payload: { prompt: "daily standup" },
		});
		// 2026-01-05T09:00Z is 04:00 in New York, so the first 09:00 local run is 14:00Z.
		expect(schedule.state).toBe("active");
		expect(schedule.timezone).toBe(NEW_YORK);
		expect(schedule.nextAt).toBe(Date.UTC(2026, 0, 5, 14, 0));

		await t.clock.advanceTo(Date.UTC(2026, 0, 5, 14, 0) - 1);
		expect(created).toEqual([]);

		await t.clock.advance(1);
		expect(created).toEqual([
			{ caller: TEST_USER, callerKind: "user", callerUrl: USER_URL, prompt: "daily standup", at: Date.UTC(2026, 0, 5, 14, 0) },
		]);
		expect((await show(t.client, schedule.id)).nextAt).toBe(Date.UTC(2026, 0, 6, 14, 0));

		await t.clock.advanceTo(Date.UTC(2026, 0, 6, 14, 0));
		expect(created).toHaveLength(2);
		expect(created[1]?.at).toBe(Date.UTC(2026, 0, 6, 14, 0));

		// Cron "0 9 * * *" without a date field runs every day at 09:00 local.
		expect((await show(t.client, schedule.id)).state).toBe("active");
	});

	it("SCH-02 a one-off --at runs once, then the schedule is done", async () => {
		const created: CreatedSession[] = [];
		t = await startTestPanad({ handlers: recorder(created) });
		const at = FAKE_EPOCH + 60_000;

		const schedule = await create(t.client, {
			kind: "session",
			at: new Date(at).toISOString(),
			payload: { prompt: "once" },
		});
		expect(schedule.nextAt).toBe(at);

		await t.clock.advanceTo(at - 1);
		expect(created).toEqual([]);

		await t.clock.advance(1);
		expect(created).toHaveLength(1);
		const done = await show(t.client, schedule.id);
		expect(done.state).toBe("done");
		expect(done.nextAt).toBeNull();

		await t.clock.advance(24 * 60 * 60_000);
		expect(created).toHaveLength(1);
	});

	it("SCH-03 --cron with --at, neither, a past --at, or a bad cron exits 2", async () => {
		t = await startTestPanad({ handlers: recorder([]) });
		const future = new Date(FAKE_EPOCH + 60_000).toISOString();

		const both = await t.client.post("/schedules", { kind: "session", cron: "0 9 * * *", at: future, payload: { prompt: "x" } });
		expect(both.status).toBe(400);
		expect(statusToExitCode(both.status)).toBe(2);

		const neither = await t.client.post("/schedules", { kind: "session", payload: { prompt: "x" } });
		expect(neither.status).toBe(400);
		expect(statusToExitCode(neither.status)).toBe(2);

		const past = await t.client.post("/schedules", {
			kind: "session",
			at: new Date(FAKE_EPOCH - 1).toISOString(),
			payload: { prompt: "x" },
		});
		expect(past.status).toBe(400);
		expect(past.body).toMatchObject({ error: { code: "past_at" } });
		expect(statusToExitCode(past.status)).toBe(2);

		const badCron = await t.client.post("/schedules", { kind: "session", cron: "not a cron", payload: { prompt: "x" } });
		expect(badCron.status).toBe(400);
		expect(statusToExitCode(badCron.status)).toBe(2);

		expect(await listed(t.client)).toEqual([]);
	});

	it("SCH-04 a thread schedule creates the thread at its time from the creator, with the body stored when scheduled", async () => {
		t = await startTestPanad();
		scratch = mkdtempSync(join(tmpdir(), "pana-schedule-body-"));
		const bodyFile = join(scratch, "body.md");
		writeFileSync(bodyFile, "scheduled hello");
		const body = readFileSync(bodyFile, "utf8");

		const at = FAKE_EPOCH + 5 * 60_000;
		const schedule = await create(t.client, {
			kind: "thread",
			at: new Date(at).toISOString(),
			payload: { to: [TEST_USER], body, subject: "From the schedule" },
		});
		expect(schedule.payload).toEqual({ to: [TEST_USER], body: "scheduled hello", subject: "From the schedule" });

		// The file changes after scheduling. The CLI already read it, so the run must not care.
		writeFileSync(bodyFile, "changed after scheduling");

		await t.clock.advanceTo(at);
		await t.clock.settle();

		const thread = await newestThread(t);
		const read = await t.client.get<{
			thread: { createdBy: { url: string }; participants: Array<{ url: string }> };
			messages: Array<{ body?: string }>;
		}>(`/threads/${thread.id}`);
		expect(read.status).toBe(200);
		expect(read.body.thread.createdBy.url).toBe(USER_URL);
		expect(read.body.thread.participants.map((participant) => participant.url)).toContain(USER_URL);
		expect(read.body.messages[0]?.body).toBe("scheduled hello");
		expect((await show(t.client, schedule.id)).state).toBe("done");
	});

	it("SCH-05 on startup a missed cron skips ahead and a missed one-off is marked missed with a notice", async () => {
		const created: CreatedSession[] = [];
		const clock = createFakeClock();
		const oneOffAt = FAKE_EPOCH + 60 * 60_000;
		const cronAt = FAKE_EPOCH + 2 * 60 * 60_000;

		const first = await startTestPanad({
			clock,
			config: { timezone: NEW_YORK },
			handlers: recorder(created),
		});
		const oneOff = await create(first.client, {
			kind: "session",
			at: new Date(oneOffAt).toISOString(),
			payload: { prompt: "missed one-off" },
		});
		const cron = await create(first.client, {
			kind: "session",
			cron: "0 9 * * *",
			payload: { prompt: "cron while down" },
		});
		expect(cron.nextAt).toBe(Date.UTC(2026, 0, 5, 14, 0));
		await first.stop();

		// Panad is down for four days. No timer may fire while it is closed.
		await clock.advanceTo(FAKE_EPOCH + 4 * 24 * 60 * 60_000);
		expect(created).toEqual([]);

		t = await startTestPanad({ stateDir: first.dir, clock, config: { timezone: NEW_YORK }, handlers: recorder(created) });

		const missed = await show(t.client, oneOff.id);
		expect(missed.state).toBe("missed");
		expect(missed.nextAt).toBeNull();
		expect((await show(t.client, cron.id)).state).toBe("active");
		const skipped = await show(t.client, cron.id);
		expect(skipped.nextAt).toBeGreaterThan(clock.now());

		// Nothing fired late: neither schedule creates a session during recovery.
		expect(created).toEqual([]);
		// The missed one-off told its creator.
		const notices = await inbox(t.client);
		expect(notices.some((body) => body.includes("missed") && body.includes(missed.url))).toBe(true);

		// The recovered cron still fires at its next real time.
		await clock.advanceTo(skipped.nextAt!);
		expect(created.map((session) => session.prompt)).toEqual(["cron while down"]);
	});

	it("SCH-06 a scheduled session that fails posts a notice to the creator", async () => {
		t = await startTestPanad({
			handlers: {
				"sessions.create": () => {
					throw new Error("provider exploded");
				},
			},
		});
		const at = FAKE_EPOCH + 60_000;
		const schedule = await create(t.client, {
			kind: "session",
			at: new Date(at).toISOString(),
			payload: { prompt: "explode" },
		});

		await t.clock.advanceTo(at);
		await t.clock.settle();

		const notices = await inbox(t.client);
		expect(notices.some((body) => body.includes("failed") && body.includes(schedule.url) && body.includes("provider exploded"))).toBe(true);
		// The one-off was claimed, so a failed run does not retry forever.
		expect((await show(t.client, schedule.id)).state).toBe("done");
	});

	it("SCH-07 schedule list filters by kind, delete works, and a deleted schedule never fires", async () => {
		const created: CreatedSession[] = [];
		t = await startTestPanad({ handlers: recorder(created) });
		const base = FAKE_EPOCH;

		const doomed = await create(t.client, {
			kind: "session",
			at: new Date(base + 60_000).toISOString(),
			payload: { prompt: "deleted one" },
		});
		const kept = await create(t.client, {
			kind: "session",
			at: new Date(base + 120_000).toISOString(),
			payload: { prompt: "kept one" },
		});
		const threadSchedule = await create(t.client, {
			kind: "thread",
			at: new Date(base + 180_000).toISOString(),
			payload: { to: [TEST_USER], body: "scheduled thread" },
		});

		expect((await listed(t.client)).map((schedule) => schedule.id)).toEqual([doomed.id, kept.id, threadSchedule.id]);
		const sessions = await listed(t.client, "?kind=session");
		expect(sessions).toHaveLength(2);
		expect(sessions.every((schedule) => schedule.kind === "session")).toBe(true);
		const threads = await listed(t.client, "?kind=thread");
		expect(threads.map((schedule) => schedule.id)).toEqual([threadSchedule.id]);
		expect((await t.client.get("/schedules?kind=nope")).status).toBe(400);

		const deleted = await t.client.delete(`/schedules/${doomed.id}`);
		expect(deleted.status).toBe(204);
		expect((await t.client.get(`/schedules/${doomed.id}`)).status).toBe(404);
		expect((await t.client.delete(`/schedules/${doomed.id}`)).status).toBe(404);
		expect((await t.client.delete("/schedules/NOPE")).status).toBe(404);
		expect((await listed(t.client)).map((schedule) => schedule.id)).not.toContain(doomed.id);

		await t.clock.advanceTo(base + 60_000);
		expect(created).toEqual([]);

		await t.clock.advanceTo(base + 120_000);
		expect(created.map((session) => session.prompt)).toEqual(["kept one"]);

		const before = await threadCount(t);
		expect((await t.client.delete(`/schedules/${threadSchedule.id}`)).status).toBe(204);
		await t.clock.advanceTo(base + 180_000);
		expect(await threadCount(t)).toBe(before);
	});

	it("SCH-08 a DST change fires a daily cron job once per day", async () => {
		const created: CreatedSession[] = [];
		// 2026-03-07T12:00Z is 07:00 EST, the day before the spring-forward at 2026-03-08T07:00Z.
		const clock = createFakeClock(Date.UTC(2026, 2, 7, 12, 0));
		t = await startTestPanad({ clock, config: { timezone: NEW_YORK }, handlers: recorder(created) });

		const schedule = await create(t.client, {
			kind: "session",
			cron: "0 9 * * *",
			payload: { prompt: "nine local" },
		});
		expect(schedule.nextAt).toBe(Date.UTC(2026, 2, 7, 14, 0)); // 09:00 EST
		expect(new Date(schedule.nextAt!).toLocaleString("en-US", { timeZone: NEW_YORK, hour: "2-digit", minute: "2-digit" })).toBe("09:00 AM");

		await clock.advanceTo(Date.UTC(2026, 2, 7, 14, 0));
		await clock.settle();
		expect(created).toHaveLength(1);

		const second = await show(t.client, schedule.id);
		expect(second.nextAt).toBe(Date.UTC(2026, 2, 8, 13, 0)); // 09:00 EDT, 23 hours later

		await clock.advanceTo(Date.UTC(2026, 2, 8, 13, 0));
		await clock.settle();
		expect(created).toHaveLength(2);

		const third = await show(t.client, schedule.id);
		expect(third.nextAt).toBe(Date.UTC(2026, 2, 9, 13, 0));

		await clock.advanceTo(Date.UTC(2026, 2, 9, 13, 0));
		await clock.settle();
		expect(created).toHaveLength(3);

		// Exactly one run per local day across the transition, each at 09:00 local.
		expect(created.map((session) => session.at)).toEqual([
			Date.UTC(2026, 2, 7, 14, 0),
			Date.UTC(2026, 2, 8, 13, 0),
			Date.UTC(2026, 2, 9, 13, 0),
		]);
		for (const session of created) {
			expect(new Date(session.at).toLocaleString("en-US", { timeZone: NEW_YORK, hour: "2-digit", minute: "2-digit" })).toBe("09:00 AM");
		}
	});

	it("a CLI-shaped schedule body stores only its payload fields", async () => {
		const created: CreatedSession[] = [];
		t = await startTestPanad({ handlers: recorder(created) });
		const at = FAKE_EPOCH + 60_000;

		const schedule = await create(t.client, { kind: "session", at: new Date(at).toISOString(), prompt: "from the cli" });
		expect(schedule.payload).toEqual({ prompt: "from the cli" });

		await t.clock.advanceTo(at);
		await t.clock.settle();
		expect(created.map((session) => session.prompt)).toEqual(["from the cli"]);
	});

	it("schedules update keeps the creator and rearms the timer", async () => {
		const created: CreatedSession[] = [];
		t = await startTestPanad({ handlers: recorder(created) });

		const schedule = await create(t.client, {
			kind: "session",
			at: new Date(FAKE_EPOCH + 60_000).toISOString(),
			payload: { prompt: "first" },
		});
		const res = await t.client.post(`/schedules/${schedule.id}`, {
			kind: "session",
			cron: "30 6 * * *",
			payload: { prompt: "second" },
		});
		expect(res.status).toBe(200);
		const updated = (res.body as { schedule: Schedule }).schedule;
		expect(updated.id).toBe(schedule.id);
		expect(updated.cron).toBe("30 6 * * *");
		expect(updated.payload).toEqual({ prompt: "second" });
		expect(updated.creator.id).toBe(TEST_USER);
		expect(updated.nextAt).toBeGreaterThan(FAKE_EPOCH);

		// The old one-off time is gone: nothing fires then.
		await t.clock.advanceTo(FAKE_EPOCH + 60_000);
		expect(created).toEqual([]);

		await t.clock.advanceTo(updated.nextAt!);
		await t.clock.settle();
		expect(created.map((session) => session.prompt)).toEqual(["second"]);
	});

	// #203: every session may read every schedule, but a schedule is its creator's to change: a
	// session is refused another's (or the user's) and must ask the owner. The user changes any.
	it("a session reads every schedule and changes only its own (#203)", async () => {
		t = await startTestPanad();
		const mine = await session(t);
		const other = await session(t);
		const madeBy = async (caller: string | undefined, body: Record<string, unknown>): Promise<Schedule> => {
			const res = await t!.client.post<{ schedule: Schedule }>("/schedules", body, caller ? { caller } : {});
			expect(res.status).toBe(201);
			return res.body.schedule;
		};
		const userSchedule = await madeBy(undefined, { kind: "session", cron: "0 9 * * *", payload: { prompt: "the user's" } });
		const neighbour = await madeBy(other, { kind: "session", cron: "0 10 * * *", payload: { prompt: "another session's" } });
		const own = await madeBy(mine, { kind: "session", cron: "0 11 * * *", payload: { prompt: "mine" } });

		// Read: a session sees the user's schedules and its neighbours', prompts included.
		const seenByMine = await t.client.get<{ schedules: Schedule[] }>("/schedules", { caller: mine });
		expect(seenByMine.status).toBe(200);
		expect(seenByMine.body.schedules.map((schedule) => schedule.id).sort()).toEqual([own.id, neighbour.id, userSchedule.id].sort());
		const neighbourShown = await t.client.get<{ schedule: Schedule }>(`/schedules/${neighbour.id}`, { caller: mine });
		expect(neighbourShown.status).toBe(200);
		expect(neighbourShown.body.schedule.payload).toEqual({ prompt: "another session's" });

		// Update: refused for another's (403 naming the owner), allowed for its own.
		const tookNeighbour = await t.client.post(`/schedules/${neighbour.id}`, { payload: { prompt: "hijacked" } }, { caller: mine });
		expect(tookNeighbour.status).toBe(403);
		expect(tookNeighbour.body).toMatchObject({ error: { code: "forbidden", creator: other } });
		expect((await t.client.post(`/schedules/${userSchedule.id}`, { payload: { prompt: "hijacked" } }, { caller: mine })).status).toBe(403);
		const edited = await t.client.post<{ schedule: Schedule }>(`/schedules/${own.id}`, { payload: { prompt: "mine, edited" } }, { caller: mine });
		expect(edited.status).toBe(200);
		expect(edited.body.schedule.payload).toEqual({ prompt: "mine, edited" });
		expect((await show(t.client, neighbour.id)).payload).toEqual({ prompt: "another session's" });

		// Delete: refused for another's, allowed for its own.
		const removedNeighbour = await t.client.delete(`/schedules/${neighbour.id}`, { caller: mine });
		expect(removedNeighbour.status).toBe(403);
		expect((await t.client.delete(`/schedules/${userSchedule.id}`, { caller: mine })).status).toBe(403);
		expect((await show(t.client, neighbour.id)).state).toBe("active");
		expect((await t.client.delete(`/schedules/${own.id}`, { caller: mine })).status).toBe(204);
		expect((await t.client.get(`/schedules/${own.id}`)).status).toBe(404);

		// The user still changes every schedule.
		expect((await listed(t.client)).map((schedule) => schedule.id).sort()).toEqual([neighbour.id, userSchedule.id].sort());
		const byUser = await t.client.post<{ schedule: Schedule }>(`/schedules/${neighbour.id}`, { payload: { prompt: "the user edited this" } });
		expect(byUser.status).toBe(200);
		expect(byUser.body.schedule.payload).toEqual({ prompt: "the user edited this" });
		expect((await t.client.delete(`/schedules/${userSchedule.id}`)).status).toBe(204);
	});

	it("a session's edit cannot retarget a wake at another session (#203)", async () => {
		t = await startTestPanad();
		const mine = await session(t);
		const other = await session(t);
		const made = await t.client.post<{ schedule: Schedule }>("/schedules", { kind: "wake", in: "10m", note: "Check CI.", session: mine }, { caller: mine });
		expect(made.status).toBe(201);

		const retargeted = await t.client.post<{ schedule: Schedule }>(
			`/schedules/${made.body.schedule.id}`,
			{ payload: { session: other, note: "Check CI." } },
			{ caller: mine },
		);
		expect(retargeted.status).toBe(403);
		expect(retargeted.body).toMatchObject({ error: { code: "forbidden" } });
		expect((await show(t.client, made.body.schedule.id)).payload).toMatchObject({ session: mine });
	});
});
