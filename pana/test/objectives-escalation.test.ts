// Escalation (OBJ-33, OBJ-34): asking the user to decide, the scope of the hold, and how it clears.

import { afterEach, expect, it } from "vitest";
import { openEscalations } from "../src/objectives/index.ts";
import { deliveryOf, draft, events, launch, pana, reply, settle, startObjectives, view } from "./harness/objectives.ts";
import type { Script, TestPanad } from "./harness/index.ts";

let t: TestPanad | undefined;
afterEach(async () => {
	await t?.close();
	t = undefined;
});

const TURNS = Array.from({ length: 8 }, () => ({ text: "Understood." }));

async function start(script: Script = TURNS): Promise<TestPanad> {
	t = await startObjectives({ script });
	return t;
}

async function sessionState(id: string): Promise<string> {
	return (await t!.runtime.db.get<{ state: string }>("SELECT state FROM sessions WHERE id = ?", id))!.state;
}

/** One message to a session in its own thread, as the user. */
async function mail(sessionId: string, body: string, caller?: string) {
	const made = await t!.client.post<{ thread: { id: string }; message: { id: string } }>("/threads", { to: [sessionId], body }, caller ? { caller } : {});
	expect(made.status).toBe(201);
	return made.body;
}

// --- OBJ-33 --------------------------------------------------------------------

it("OBJ-33 an escalation posts to the objective thread, marks the objective, and holds covered runs until the user answers", async () => {
	await start();
	const objective = await draft(t!, "Choose a tariff");
	const launched = await launch(t!, objective.id);
	const lead = launched.lead!.id;
	const threadId = launched.thread!.id;

	const escalated = await t!.client.post<{ escalation: { id: string; scope: string; url: string; thread: { id: string; url: string } } }>(
		`/objectives/${objective.id}/escalate`,
		{ body: "Which tariff should I pick: night or flat?" },
		{ caller: lead },
	);
	expect(escalated.status).toBe(201);
	expect(escalated.body.escalation).toMatchObject({ scope: "objective", thread: { id: threadId } });

	// The objective reads awaiting_user, and the list marks it.
	const shown = await view(t!, objective.id);
	expect(shown.awaitingUser).toBe(true);
	expect(shown.escalations.map((escalation) => escalation.thread.id)).toEqual([threadId]);
	expect(shown.escalations[0]!.url).toBe(escalated.body.escalation.url);
	const listed = await t!.client.get<{ objectives: Array<{ id: string; awaitingUser: boolean }> }>("/objectives");
	expect(listed.body.objectives.find((candidate) => candidate.id === objective.id)?.awaitingUser).toBe(true);

	// The message is in the objective thread, delivered to the user (which is what pushes, PSH-03).
	const latest = await t!.runtime.db.get<{ body: string; thread_id: string }>("SELECT body, thread_id FROM messages WHERE id = ?", (await t!.runtime.db.get<{ message_id: string }>("SELECT message_id FROM objective_escalations WHERE state = 'open'"))!.message_id);
	expect(latest).toMatchObject({ thread_id: threadId, body: "Which tariff should I pick: night or flat?" });
	const unread = await t!.runtime.db.get<{ n: number }>("SELECT count(*) AS n FROM deliveries WHERE thread_id = ? AND read_at IS NULL", threadId);
	expect(unread!.n).toBeGreaterThan(0);

	// OBJ-23: the event names the condition, the scope, and the message.
	const recorded = await events(t!, objective.id, "escalated");
	expect(recorded).toHaveLength(1);
	expect(recorded[0]!.detail).toMatchObject({ scope: "objective", thread: `pana://test.example/threads/${threadId}`, message: escalated.body.escalation.url });

	// While it holds, no covered run starts: the delivery stays unread with no wake.
	const held = await mail(lead, "Status?");
	expect(await sessionState(lead)).toBe("idle");
	expect(await deliveryOf(t!, lead, held.message.id)).toMatchObject({ read_at: null, wake_request_id: null, wake_submission_id: null });
	expect((await events(t!, objective.id, "run.held")).length).toBeGreaterThan(0);

	// A user message in the objective thread clears it, records why, and delivers what it held.
	// The lead's quiet interval (OBJ-18) has passed by the time the user answers.
	await t!.clock.advance(6 * 60_000);
	const answer = await reply(t!, threadId, "Night tariff.");
	expect(answer.status).toBe(200);
	await settle(t!);
	await settle(t!);
	expect((await view(t!, objective.id)).awaitingUser).toBe(false);
	expect((await openEscalations(t!.runtime.db, t!.runtime, objective.id)).length).toBe(0);
	const cleared = await events(t!, objective.id, "escalation.cleared");
	expect(cleared).toHaveLength(1);
	expect(cleared[0]!.detail).toMatchObject({ reason: "user_message" });
	expect(await deliveryOf(t!, lead, held.message.id)).toMatchObject({ wake_submission_id: expect.any(Number) });
	expect((await deliveryOf(t!, lead, held.message.id))!.read_at).not.toBeNull();
});

it("OBJ-33 the charter's Escalation timeout clears the hold and delivers the mail it held", async () => {
	await start();
	const objective = await draft(t!, "Wait on the board vote");
	await t!.client.post(`/objectives/${objective.id}/charter`, {
		section: "Escalation",
		body: "The board votes on Tuesday.\ntimeout: 1h",
	});
	const launched = await launch(t!, objective.id);
	const lead = launched.lead!.id;

	const escalated = await t!.client.post<{ escalation: { timeoutAt: number } }>(`/objectives/${objective.id}/escalate`, { body: "Which vendor?" }, { caller: lead });
	expect(escalated.status).toBe(201);
	expect(escalated.body.escalation.timeoutAt).toBe(t!.clock.now() + 3_600_000);

	const held = await mail(lead, "Any news?");
	expect((await deliveryOf(t!, lead, held.message.id))!.wake_submission_id).toBeNull();

	// A minute later nothing has changed; an hour later the timeout has elapsed.
	await t!.clock.advance(60_000);
	expect((await view(t!, objective.id)).awaitingUser).toBe(true);
	await t!.clock.advance(3_600_000);
	await settle(t!);
	expect((await view(t!, objective.id)).awaitingUser).toBe(false);
	const cleared = await events(t!, objective.id, "escalation.cleared");
	expect(cleared).toHaveLength(1);
	expect(cleared[0]!.detail).toMatchObject({ reason: "timeout" });
	expect((await deliveryOf(t!, lead, held.message.id))!.wake_submission_id).not.toBeNull();
});

it("OBJ-33 a stop and resume does not carry mail the escalation is still holding", async () => {
	await start();
	const objective = await draft(t!, "Hold across a resume");
	const launched = await launch(t!, objective.id);
	const lead = launched.lead!.id;
	expect((await t!.client.post(`/objectives/${objective.id}/escalate`, { body: "Which tariff?" }, { caller: lead })).status).toBe(201);
	const held = await mail(lead, "Status?");
	expect((await deliveryOf(t!, lead, held.message.id))!.wake_submission_id).toBeNull();

	expect((await t!.client.post(`/sessions/${lead}/stop`)).status).toBe(200);
	expect((await t!.client.post(`/sessions/${lead}/resume`)).status).toBe(200);
	expect((await deliveryOf(t!, lead, held.message.id))!.wake_submission_id).toBeNull();
	expect(await sessionState(lead)).toBe("idle");
});

// --- OBJ-34 --------------------------------------------------------------------

it("OBJ-34 an objective-wide escalation holds the lead and lets members work; a member scope holds only that member", async () => {
	await start([{ text: "I am the lead." }, { text: "Member A ready." }, { text: "Member B ready." }, { text: "A works." }, { text: "B works." }, { text: "A again." }]);
	const objective = await draft(t!, "Two members, one decision");
	const launched = await launch(t!, objective.id);
	const lead = launched.lead!.id;
	const objectiveThread = launched.thread!.id;

	const madeA = await t!.client.post<{ session: { id: string }; thread: { id: string } }>("/sessions", { prompt: "Audit the boiler.", to: [lead] }, { caller: lead });
	const madeB = await t!.client.post<{ session: { id: string }; thread: { id: string } }>("/sessions", { prompt: "Read the meter.", to: [lead] }, { caller: lead });
	expect(madeA.status).toBe(201);
	expect(madeB.status).toBe(201);
	const memberA = madeA.body.session.id;
	const memberB = madeB.body.session.id;
	await settle(t!);

	// Objective-wide: every lead run waits, and the objective's members keep working.
	const wide = await t!.client.post(`/objectives/${objective.id}/escalate`, { body: "Approve the budget?" }, { caller: lead });
	expect(wide.status).toBe(201);
	expect((await view(t!, objective.id)).escalations.map((escalation) => escalation.scope)).toEqual(["objective"]);
	const toLead = await mail(lead, "Status?");
	expect(await deliveryOf(t!, lead, toLead.message.id)).toMatchObject({ wake_submission_id: null });
	const toA = await mail(memberA, "Keep going.", lead);
	expect((await deliveryOf(t!, memberA, toA.message.id))!.wake_submission_id).not.toBeNull();
	await settle(t!);

	// The user answers, then a member scope holds only that member and the lead.
	await reply(t!, objectiveThread, "Approved.");
	await settle(t!);
	const scoped = await t!.client.post<{ escalation: { scope: string; member: { id: string } } }>(
		`/objectives/${objective.id}/escalate`,
		{ body: "Is the boiler safe to touch?", member: memberA },
		{ caller: lead },
	);
	expect(scoped.status).toBe(201);
	expect(scoped.body.escalation).toMatchObject({ scope: "member", member: { id: memberA } });

	const toAAgain = await mail(memberA, "One more look.", lead);
	expect((await deliveryOf(t!, memberA, toAAgain.message.id))!.wake_submission_id).toBeNull();
	const toB = await mail(memberB, "Carry on.", lead);
	expect((await deliveryOf(t!, memberB, toB.message.id))!.wake_submission_id).not.toBeNull();
	const toLeadAgain = await mail(lead, "Anything?");
	expect((await deliveryOf(t!, lead, toLeadAgain.message.id))!.wake_submission_id).toBeNull();

	// The brief lists the held scope with the thread it waits on.
	const brief = await t!.client.get<{ brief: string }>(`/objectives/${objective.id}/brief`);
	expect(brief.body.brief).toContain(`For member pana://test.example/sessions/${memberA} escalation waits on the user at`);
	expect(brief.body.brief).toContain(`Member pana://test.example/sessions/${memberA}:`);
	expect(brief.body.brief).toContain(`pana://test.example/threads/${objectiveThread}`);
	// A scope no one can decide uses the objective-wide form.
	const undecided = await t!.client.post<{ escalation: { scope: string } }>(`/objectives/${objective.id}/escalate`, { body: "I cannot tell." }, { caller: lead });
	expect(undecided.status).toBe(201);
	expect(undecided.body.escalation.scope).toBe("objective");
	// Naming a session that is not a member is a usage error, not a silent widening.
	const stranger = await t!.client.post(`/objectives/${objective.id}/escalate`, { body: "x", member: t!.runtime.newId() }, { caller: lead });
	expect(stranger.status).toBe(400);
	expect((stranger.body as { error: { code: string } }).error.code).toBe("invalid_member");
	// A session that does not lead the objective cannot escalate on it.
	expect((await t!.client.post(`/objectives/${objective.id}/escalate`, { body: "x" }, { caller: memberA })).status).toBe(403);
	// The CLI reaches the same route.
	expect((await pana(t!, "objective escalate", { id: objective.id, body: "From the cli." }, lead)).exitCode).toBe(0);
});

it("OBJ-34 a member's escalation holds that member and the lead, and the member's thread is what a reader opens", async () => {
	await start([{ text: "I am the lead." }, { text: "Member ready." }, { text: "Member holds." }]);
	const objective = await draft(t!, "One member asks");
	const launched = await launch(t!, objective.id);
	const lead = launched.lead!.id;
	const member = await t!.client.post<{ session: { id: string } }>("/sessions", { prompt: "Check the meter.", to: [lead] }, { caller: lead });
	const memberId = member.body.session.id;
	await settle(t!);

	// The member asks through its own thread; the hold is recorded against it.
	const escalated = await t!.client.post<{ escalation: { scope: string; member: { id: string } } }>(
		`/objectives/${objective.id}/escalate`,
		{ body: "The meter is locked: can I break the seal?", member: memberId },
		{ caller: lead },
	);
	expect(escalated.status).toBe(201);
	expect(escalated.body.escalation.scope).toBe("member");

	const toMember = await mail(memberId, "Try the back door.", lead);
	expect((await deliveryOf(t!, memberId, toMember.message.id))!.wake_submission_id).toBeNull();
	const toLead = await mail(lead, "What is happening?");
	expect((await deliveryOf(t!, lead, toLead.message.id))!.wake_submission_id).toBeNull();
	// The seam is the same one every delivery asks, and it names the member scope.
	const held = await events(t!, objective.id, "run.held");
	expect(held.some((event) => event.detail.scope === "member" && event.detail.member === memberId)).toBe(true);
});
