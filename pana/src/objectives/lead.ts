// Replacing a lead (OBJ-35, OBJ-36).
//
// A lead that fails leaves the objective stranded. Nothing regenerates on its own — a failed lead
// never spends on its replacement — so this is the user's act. The swap is one transaction: the
// old lead is stopped and marked `stopped_by: objective`, the new lead is created as a child of the
// user at depth 0, `objectives.lead_id` moves, the successor takes the retired lead's place in every
// thread the retired lead was in, and the new lead's handoff (the briefing) is posted into the
// objective's thread. Two regenerates that read the same lead produce one lead and one
// 409 `lead_changed`; a launch racing an active objective is already 409 `wrong_phase`.
//
// The old lead's conversation is aborted and its scratch swept after the commit, through the same
// `SessionRuntime.archive` path REF-02 uses, so a failure there leaves a stopped lead rather than
// two live ones.

import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { ApiError } from "../api/errors.ts";
import type { Caller } from "../api/types.ts";
import { isUlid, parseRef } from "../ids/index.ts";
import type { Runtime } from "../server/runtime.ts";
import { sessionRuntime } from "../sessions/index.ts";
import { setSessionState } from "../sessions/state.ts";
import { ensureScratch } from "../scratch/index.ts";
import { announce, respondIn, type ThreadResult } from "../threads/index.ts";
import { leadBriefing } from "./brief.ts";
import { leadAgent } from "./launch.ts";
import { objectBody } from "./schema.ts";
import { loadObjective, objectiveId, recordObjectiveEvent } from "./state.ts";
import { showObjective, type ObjectiveView } from "./view.ts";

export interface RegenerateInput {
	reason?: unknown;
	/** Optional precondition: the lead the caller decided to replace. A lead that moved is 409. */
	lead?: unknown;
}

/** A session ID from a bare ULID or a session URL. */
function leadRef(runtime: Runtime, value: unknown): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string") throw ApiError.badRequest("invalid_lead", "lead must be a session ID or URL");
	const text = value.trim();
	if (isUlid(text)) return text;
	const ref = parseRef(text, runtime.config.domain);
	if (ref.kind !== "session") throw ApiError.badRequest("invalid_lead", `${text} is not a session`);
	return ref.id;
}

/**
 * `POST /objectives/:id/regenerate-lead` (OBJ-35). The user only, on an active objective: a session
 * that could replace its own lead could evade every limit the lead is under.
 */
export async function regenerateLead(runtime: Runtime, caller: Caller, value: string | null | undefined, raw: unknown): Promise<ObjectiveView> {
	if (caller.kind !== "user") throw ApiError.forbidden("only the user may regenerate an objective's lead");
	const input = objectBody(raw) as RegenerateInput;
	const reason = typeof input.reason === "string" ? input.reason.trim() : "";
	if (reason.length === 0) throw ApiError.badRequest("missing_reason", "regenerate-lead needs --reason TEXT");
	// A caller that names the lead it is replacing expects that lead; a regenerate that already
	// landed returns 409 rather than replacing the replacement (OBJ-35).
	const expected = leadRef(runtime, input.lead);

	const id = objectiveId(value, runtime.config.domain);
	const before = await loadObjective(runtime.db, id);
	if (before.phase !== "active") {
		throw new ApiError(409, "wrong_phase", `objective ${id} is ${before.phase}; only an active objective has a lead to replace`, {
			objective: id,
			phase: before.phase,
		});
	}
	if (before.lead_id === null || before.thread_id === null) {
		throw new ApiError(409, "no_lead", `objective ${id} has no lead to replace`, { objective: id });
	}
	const previousLead = before.lead_id;

	// Read and render before the write, so the transaction holds only writes.
	const brief = await leadBriefing(runtime, before, { handoff: { previousLead, reason } });
	const agent = leadAgent(runtime, before);
	const leadId = runtime.newId();
	const cwd = ensureScratch(runtime, leadId);
	const recipients: string[] = [];

	const result: ThreadResult = await runtime.db.atomically(async (tx) => {
		const objective = await loadObjective(tx, id);
		// The concurrency guard: the lead the caller decided to replace must still be the lead.
		if (objective.phase !== "active" || objective.lead_id !== previousLead || objective.thread_id === null || (expected !== undefined && objective.lead_id !== expected)) {
			throw new ApiError(409, "lead_changed", `objective ${id} moved while it was being regenerated`, {
				objective: id,
				lead: objective.lead_id,
				phase: objective.phase,
			});
		}
		const now = runtime.clock.now();

		// OBJ-35: the old lead stops as the objective's act, keeps its transcript, and wakes nothing.
		await setSessionState(tx, runtime, { sessionId: previousLead, state: "stopped", from: ["idle", "running", "waiting", "failed"] });
		await tx.run("UPDATE sessions SET stopped_by = 'objective', hold_until = NULL, updated_at = ? WHERE id = ?", now, previousLead);
		await tx.run(
			"UPDATE schedules SET state = 'deleted', updated_at = ? WHERE kind = 'wake' AND state = 'active' AND json_extract(payload, '$.session') = ?",
			now,
			previousLead,
		);
		// The successor is the user's child at depth 0, exactly as launch's lead is (OBJ-05).
		const conversation = await runtime.harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: {
					model: agent.model,
					thinkingLevel: agent.thinking,
					...(agent.profile.instructions === undefined ? {} : { instructions: agent.profile.instructions }),
					cwd,
				},
			},
			ctx,
		);
		await tx.run("INSERT INTO participants (id, kind, url, created_at) VALUES (?, 'session', ?, ?)", leadId, runtime.url({ kind: "session", id: leadId }), now);
		// STA-07 makes a thread holding an archived session read-only, and every thread the objective
		// runs on must outlive its lead. So the successor takes the retired lead's place in every
		// thread the retired lead was in: the objective's own thread, and each member's thread too.
		//
		// Leaving the retired lead in a member's thread would freeze that member for good. Its thread
		// would refuse every delivery (STA-07), so a member the objective still needs could never run
		// again, and the successor that must control it (OBJ-13) could not even post there. The
		// retired lead's messages keep `sender_id`, so attribution and history are untouched, and the
		// swap is one transaction: no reader ever sees the thread without a lead in it.
		const leadThreads = await tx.all<{ thread_id: string }>(
			"SELECT DISTINCT thread_id FROM thread_participants WHERE participant_id = ?",
			previousLead,
		);
		for (const held of leadThreads) {
			await tx.run("DELETE FROM thread_participants WHERE thread_id = ? AND participant_id = ?", held.thread_id, previousLead);
			// `joined_message_id` null: a participant from here on, delivered only what comes next.
			await tx.run(
				"INSERT OR IGNORE INTO thread_participants (thread_id, participant_id, joined_at, joined_message_id) VALUES (?, ?, ?, NULL)",
				held.thread_id,
				leadId,
				now,
			);
		}

		await tx.run(
			`INSERT INTO sessions (id, conversation_id, state, parent, depth, model, thinking, profile, cwd, objective_id, created_at, updated_at)
			 VALUES (?, ?, 'idle', NULL, 0, ?, ?, ?, ?, ?, ?, ?)`,
			leadId,
			conversation.id,
			`${agent.model.provider}/${agent.model.modelId}`,
			agent.thinking,
			agent.profileName,
			cwd,
			id,
			now,
			now,
		);
		await tx.run("UPDATE objectives SET lead_id = ?, updated_at = ? WHERE id = ?", leadId, now, id);

		// The handoff: the briefing in the objective's thread, as the user, with the new lead joining.
		const appended = await respondIn(tx, runtime, caller, objective.thread_id, { body: brief, cc: [leadId] }, recipients);
		await recordObjectiveEvent(tx, runtime, {
			objectiveId: id,
			kind: "regenerated",
			actorId: caller.id,
			detail: {
				from: previousLead,
				to: leadId,
				reason,
				thread: runtime.url({ kind: "thread", id: objective.thread_id }),
				message: runtime.url({ kind: "message", id: appended.message.id, thread: objective.thread_id }),
			},
		});
		return appended;
	});

	announce(runtime, "delivery", result, recipients);
	// After the swap is durable: abort the old run, withdraw what it never answered, archive it and
	// sweep its scratch (REF-02). A failure here leaves a stopped lead, never a second live one.
	await sessionRuntime(runtime).archive(previousLead, "objective");
	return showObjective(runtime, id);
}
