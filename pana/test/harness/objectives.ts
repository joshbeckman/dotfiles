// Helpers the objective packages' tests share: a panad with the faux model, a draft, a view, a
// seeded member, and the CLI's command layer. They are small on purpose; a test that needs more
// says what it needs in the test.

import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { expect } from "vitest";
import { runPanaCommand } from "../../src/cli/commands.ts";
import type { ObjectiveView } from "../../src/objectives/index.ts";
import { sessionRuntime, type SessionState } from "../../src/sessions/index.ts";
import { startTestPanad, type TestPanad, type TestPanadOptions } from "./index.ts";

/** Start panad the way the objective tests always do: faux model, UTC days. */
export async function startObjectives(options: TestPanadOptions = {}): Promise<TestPanad> {
	return startTestPanad({
		...options,
		config: { defaultModel: "faux/faux-1", timezone: "UTC", ...(options.config ?? {}) },
		script: options.script ?? [{ text: "Understood." }],
	});
}

export type Params = Record<string, string | string[] | boolean | undefined>;

/** Run one `pana` command through the shared command layer, against this panad. */
export async function pana(t: TestPanad, name: string, params: Params, caller?: string) {
	return runPanaCommand(name, params, { endpoint: { socketPath: t.panad.socketPath }, ...(caller ? { caller } : {}) });
}

/** A drafted objective. */
export async function draft(t: TestPanad, goal = "Cut the energy bill", body: Record<string, unknown> = {}, caller?: string): Promise<ObjectiveView> {
	const made = await t.client.post<{ objective: ObjectiveView }>("/objectives", { goal, ...body }, caller ? { caller } : {});
	expect(made.status).toBe(201);
	return made.body.objective;
}

/** The objective as a read shows it. */
export async function view(t: TestPanad, id: string): Promise<ObjectiveView> {
	const res = await t.client.get<{ objective: ObjectiveView }>(`/objectives/${id}`);
	expect(res.status).toBe(200);
	return res.body.objective;
}

/** Launch, and wait for the lead's first run to settle. */
export async function launch(t: TestPanad, id: string): Promise<ObjectiveView> {
	const res = await t.client.post<{ objective: ObjectiveView }>(`/objectives/${id}/launch`);
	expect(res.status).toBe(200);
	await settle(t);
	return res.body.objective;
}

/** Settle every run and every queued session job. */
export async function settle(t: TestPanad): Promise<void> {
	await t.runtime.harness.waitForIdle(ctx);
	await sessionRuntime(t.runtime).idle();
}

/** A session row for an objective, without a conversation: enough for every read to see it. */
export async function seedSession(t: TestPanad, objectiveId: string | null, state: SessionState = "idle", options: { parent?: string; profile?: string } = {}): Promise<string> {
	const id = t.runtime.newId();
	const now = t.clock.now();
	await t.runtime.db.write(async (tx) => {
		await tx.run("INSERT INTO participants (id, kind, url, created_at) VALUES (?, 'session', ?, ?)", id, t.runtime.url({ kind: "session", id }), now);
		await tx.run(
			"INSERT INTO sessions (id, state, parent, depth, profile, objective_id, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?)",
			id,
			state,
			options.parent ?? null,
			options.profile ?? "default",
			objectiveId,
			now,
			now,
		);
	});
	return id;
}

/** Make a seeded objective active with this lead, without a launch. */
export async function activate(t: TestPanad, objectiveId: string, leadId: string): Promise<void> {
	await t.runtime.db.write((tx) => tx.run("UPDATE objectives SET phase = 'active', lead_id = ?, updated_at = ? WHERE id = ?", leadId, t.clock.now(), objectiveId));
}

/** The text of a session's model inputs, oldest first. */
export async function inputs(t: TestPanad, sessionId: string): Promise<string[]> {
	const row = await t.runtime.db.get<{ conversation_id: number }>("SELECT conversation_id FROM sessions WHERE id = ?", sessionId);
	const conversation = await t.runtime.harness.conversation(row!.conversation_id as never, ctx);
	const page = await conversation!.entries({ order: "ascending" }, 200, undefined, ctx);
	return page.items.map((entry) =>
		(entry.model ?? [])
			.map((message) => message as { role?: string; content?: unknown })
			.filter((message) => message.role === "user")
			.map((message) => String(message.content ?? ""))
			.join("\n"),
	);
}

/** The current body of a thread's newest message. */
export async function headOf(t: TestPanad, threadId: string): Promise<string> {
	const row = await t.runtime.db.get<{ id: string }>("SELECT id FROM messages WHERE thread_id = ? ORDER BY seq DESC LIMIT 1", threadId);
	return row!.id;
}

/** Post as the user into an existing thread, after its head. */
export async function reply(t: TestPanad, threadId: string, body: string, caller?: string) {
	const after = await headOf(t, threadId);
	return t.client.post(`/threads/${threadId}/messages`, { after, body }, caller ? { caller } : {});
}

/** A delivery's wake state, for "held" versus "carried" assertions. */
export async function deliveryOf(t: TestPanad, recipientId: string, messageId: string) {
	return t.runtime.db.get<{ id: string; read_at: number | null; wake_request_id: string | null; wake_submission_id: number | null }>(
		"SELECT id, read_at, wake_request_id, wake_submission_id FROM deliveries WHERE recipient_id = ? AND message_id = ?",
		recipientId,
		messageId,
	);
}

/** Every `objective_events` row of one kind, oldest first. */
export async function events(t: TestPanad, objectiveId: string, kind?: string) {
	const rows = await t.runtime.db.all<{ id: string; kind: string; detail: string; actor_id: string | null; at: number }>(
		`SELECT * FROM objective_events WHERE objective_id = ?${kind === undefined ? "" : " AND kind = ?"} ORDER BY at, id`,
		objectiveId,
		...(kind === undefined ? [] : [kind]),
	);
	return rows.map((row) => ({ ...row, detail: JSON.parse(row.detail) as Record<string, unknown> }));
}
