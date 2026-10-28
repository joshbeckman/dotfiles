import { afterEach, expect, it } from "vitest";
import { sessionRuntime } from "../src/sessions/index.ts";
import type { SessionDetail } from "../src/sessions/views.ts";
import type { ScheduleView } from "../src/schedules/store.ts";
import { startTestPanad, type TestPanad } from "./harness/index.ts";

let t: TestPanad | undefined;
afterEach(async () => { await t?.close(); });

it("WAK-08 session detail lists only pending wakes targeting that session in next-run order", async () => {
	t = await startTestPanad({ script: [{ text: "Ready." }, { text: "Other session." }], config: { defaultModel: "faux/faux-1" } });
	const create = async () => {
		const made = await t!.client.post<{ session: { id: string } }>("/sessions", { prompt: "Wait for a check." });
		await sessionRuntime(t!.runtime).idle();
		return made.body.session.id;
	};
	const id = await create();
	const other = await create();
	const wake = async (session: string, delay: string, subject: string) => {
		const made = await t!.client.post<{ schedule: ScheduleView }>("/schedules", { kind: "wake", session, in: delay, note: "Check later.", subject });
		expect(made.status).toBe(201);
		return made.body.schedule;
	};
	const later = await wake(id, "1h", "Later check");
	const sooner = await wake(id, "10m", "Sooner check");
	await wake(other, "5m", "Other target");
	const deleted = await wake(id, "2m", "Cancelled");
	await t.client.delete(`/schedules/${deleted.id}`);
	const done = await wake(id, "3m", "Already claimed");
	const missed = await wake(id, "4m", "Missed");
	await t.runtime.db.write(async (tx) => {
		await tx.run("UPDATE schedules SET state = 'done' WHERE id = ?", done.id);
		await tx.run("UPDATE schedules SET state = 'missed' WHERE id = ?", missed.id);
	});
	// An ordinary session schedule created by this session does not wake it.
	expect((await t.client.post("/schedules", { kind: "session", at: t.clock.now() + 3_600_000, prompt: "Create a new session." }, { caller: id })).status).toBe(201);
	const recurring = await t.client.post<{ schedule: ScheduleView }>("/schedules", { kind: "wake", session: id, cron: "0 9 * * *", note: "Daily check.", subject: "Daily check" });
	expect(recurring.status).toBe(201);
	const result = await t.client.get<{ session: SessionDetail }>(`/sessions/${id}`);
	expect(result.status).toBe(200);
	const expected = [sooner, later, recurring.body.schedule].sort((a, b) => a.nextAt! - b.nextAt! || a.id.localeCompare(b.id));
	expect(result.body.session.wakes.map((s) => s.id)).toEqual(expected.map((s) => s.id));
	expect(result.body.session.wakes).toEqual(expected);
	await t.client.delete(`/schedules/${sooner.id}`);
	await t.client.delete(`/schedules/${later.id}`);
	await t.client.delete(`/schedules/${recurring.body.schedule.id}`);
	expect((await t.client.get<{ session: SessionDetail }>(`/sessions/${id}`)).body.session.wakes).toEqual([]);
});
