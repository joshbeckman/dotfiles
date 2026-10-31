// Replacing a lead (OBJ-35) and what a failed lead leaves behind (OBJ-36).

import { afterEach, expect, it } from "vitest";
import { BRIEF_TITLE } from "../src/objectives/index.ts";
import { draft, events, inputs, launch, pana, settle, startObjectives, view } from "./harness/objectives.ts";
import type { Script, TestPanad } from "./harness/index.ts";

let t: TestPanad | undefined;
afterEach(async () => {
	await t?.close();
	t = undefined;
});

async function start(script: Script = [{ text: "I am the lead." }, { text: "I am the replacement." }, { text: "Still here." }]): Promise<TestPanad> {
	t = await startObjectives({ script });
	return t;
}

async function sessionsOf(objectiveId: string) {
	return t!.runtime.db.all<{ id: string; state: string; parent: string | null; depth: number; objective_id: string; stopped_by: string | null }>(
		"SELECT id, state, parent, depth, objective_id, stopped_by FROM sessions WHERE objective_id = ? ORDER BY created_at, id",
		objectiveId,
	);
}

// --- OBJ-35 --------------------------------------------------------------------

it("OBJ-35 regenerate stops and archives the old lead, creates the successor as the user's child, and hands it the briefing", async () => {
	await start();
	const objective = await draft(t!, "Cut the energy bill");
	const launched = await launch(t!, objective.id);
	const previous = launched.lead!.id;
	const threadId = launched.thread!.id;
	const wake = await t!.client.post<{ schedule: { id: string } }>("/schedules", { kind: "wake", session: previous, in: "1h", note: "Check the meter." });
	expect(wake.status).toBe(201);

	const regenerated = await t!.client.post<{ objective: ReturnType<typeof view> extends Promise<infer V> ? V : never }>(
		`/objectives/${objective.id}/regenerate-lead`,
		{ reason: "It stopped answering." },
	);
	expect(regenerated.status).toBe(200);
	const shown = await view(t!, objective.id);
	const replacement = shown.lead!.id;
	expect(replacement).not.toBe(previous);
	expect(shown.phase).toBe("active");

	// Exactly one live lead, the old one retired as the objective's act.
	const sessions = await sessionsOf(objective.id);
	expect(sessions.map((session) => session.id).sort()).toEqual([previous, replacement].sort());
	expect(sessions.find((session) => session.id === previous)).toMatchObject({ state: "archived", stopped_by: "objective" });
	const successor = sessions.find((session) => session.id === replacement)!;
	expect(successor).toMatchObject({ parent: null, depth: 0, objective_id: objective.id, state: expect.stringMatching(/^(idle|running)$/) });
	// The old lead's wake would have woken a retired lead; it is gone.
	expect(await t!.runtime.db.get("SELECT state FROM schedules WHERE id = ?", wake.body.schedule.id)).toEqual({ state: "deleted" });

	// The handoff is the briefing, in the objective's thread, and it is the new lead's first input.
	const handoff = await t!.runtime.db.get<{ body: string }>("SELECT body FROM messages WHERE thread_id = ? ORDER BY seq DESC LIMIT 1", threadId);
	expect(handoff!.body.startsWith(BRIEF_TITLE)).toBe(true);
	expect(handoff!.body).toContain("You are the new lead of this objective.");
	expect(handoff!.body).toContain("It stopped answering.");
	expect(handoff!.body).toContain(`pana://test.example/sessions/${previous}`);
	await settle(t!);
	const first = (await inputs(t!, replacement)).filter((text) => text.length > 0)[0]!;
	// The handoff message is the briefing, so the briefing is not prepended a second time.
	expect(first.split(BRIEF_TITLE).length - 1).toBe(1);
	expect(first).toContain("It stopped answering.");

	// The event records the swap and where to read the handoff.
	const recorded = await events(t!, objective.id, "regenerated");
	expect(recorded).toHaveLength(1);
	expect(recorded[0]!.detail).toMatchObject({
		from: previous,
		to: replacement,
		reason: "It stopped answering.",
		thread: `pana://test.example/threads/${threadId}`,
	});
	// The superseded lead cannot resume itself into the objective, whoever asks.
	expect((await t!.client.post(`/sessions/${previous}/resume`)).status).toBe(403);
	expect((await t!.client.post(`/sessions/${previous}/resume`, {}, { caller: previous })).status).toBe(403);
	// A member the lead created is not a former lead, and resumes normally.
	const member = await t!.client.post<{ session: { id: string } }>("/sessions", { prompt: "Audit.", to: [replacement] }, { caller: replacement });
	await settle(t!);
	await t!.client.post(`/sessions/${member.body.session.id}/stop`);
	expect((await t!.client.post(`/sessions/${member.body.session.id}/resume`)).status).toBe(200);

	// The CLI reaches the same route; a session may not replace a lead.
	expect((await pana(t!, "objective regenerate-lead", { id: objective.id, reason: "again" })).exitCode).toBe(0);
	expect((await t!.client.post(`/objectives/${objective.id}/regenerate-lead`, { reason: "x" }, { caller: previous })).status).toBe(403);
	// Only an active objective has a lead to replace.
	await t!.client.post(`/objectives/${objective.id}/stop`);
	expect((await t!.client.post(`/objectives/${objective.id}/regenerate-lead`, { reason: "x" })).status).toBe(409);
});

it("OBJ-35 a concurrent regenerate leaves exactly one lead: one 200 and one 409", async () => {
	await start();
	const objective = await draft(t!, "One lead only");
	await launch(t!, objective.id);

	const observed = (await view(t!, objective.id)).lead!.id;
	const [first, second] = await Promise.all([
		t!.client.post(`/objectives/${objective.id}/regenerate-lead`, { reason: "first", lead: observed }),
		t!.client.post(`/objectives/${objective.id}/regenerate-lead`, { reason: "second", lead: observed }),
	]);
	expect([first.status, second.status].sort()).toEqual([200, 409]);
	const refused = first.status === 409 ? first : second;
	expect((refused.body as { error: { code: string } }).error.code).toBe("lead_changed");

	const shown = await view(t!, objective.id);
	const liveLeads = (await sessionsOf(objective.id)).filter((session) => session.state !== "archived" && session.state !== "stopped");
	expect(liveLeads.map((session) => session.id)).toEqual([shown.lead!.id]);
	expect((await events(t!, objective.id, "regenerated")).length).toBe(1);
});

// --- OBJ-36 --------------------------------------------------------------------

it("OBJ-36 a failed lead strands the objective, spends nothing on its own replacement, and records the run to read", async () => {
	await start([{ fail: "provider error" }]);
	const objective = await draft(t!, "The lead will fail");
	const launched = await launch(t!, objective.id);
	const lead = launched.lead!.id;
	const threadId = launched.thread!.id;

	expect(await t!.runtime.db.get("SELECT state FROM sessions WHERE id = ?", lead)).toEqual({ state: "failed" });
	const shown = await view(t!, objective.id);
	expect(shown.state).toBe("stranded");
	// Nothing regenerates on its own: the lead is still the same session.
	expect(shown.lead!.id).toBe(lead);
	expect((await events(t!, objective.id, "regenerated")).length).toBe(0);
	const before = (await sessionsOf(objective.id)).length;

	// The failing run's thread and message are recorded, so the user can read what happened.
	const recorded = await events(t!, objective.id, "stranded");
	expect(recorded).toHaveLength(1);
	const detail = recorded[0]!.detail as { reason: string; thread: string; message: string };
	expect(typeof detail.reason).toBe("string");
	expect((detail.reason as string).length).toBeGreaterThan(0);
	expect(detail.thread).toBe(`pana://test.example/threads/${threadId}`);
	const launchMessage = await t!.runtime.db.get<{ id: string }>("SELECT id FROM messages WHERE thread_id = ? ORDER BY seq LIMIT 1", threadId);
	expect(detail.message).toBe(`pana://test.example/threads/${threadId}?message=${launchMessage!.id}`);

	// The stranded notice offers regenerate, and nothing spends while the user decides.
	const notices = await t!.runtime.db.all<{ body: string }>("SELECT body FROM messages WHERE body LIKE '%regenerate-lead%'");
	expect(notices.some((notice) => notice.body.includes(`pana objective regenerate-lead ${shown.url}`))).toBe(true);
	await t!.clock.advance(6 * 3_600_000);
	await settle(t!);
	expect((await sessionsOf(objective.id)).length).toBe(before);
	expect((await view(t!, objective.id)).lead!.id).toBe(lead);

	// The user's regenerate is the replacement, and it works after the failure.
	const regenerated = await t!.client.post(`/objectives/${objective.id}/regenerate-lead`, { reason: "try again" });
	expect(regenerated.status).toBe(200);
	expect((await view(t!, objective.id)).lead!.id).not.toBe(lead);
	await settle(t!);
	expect((await events(t!, objective.id, "regenerated")).length).toBe(1);
});
