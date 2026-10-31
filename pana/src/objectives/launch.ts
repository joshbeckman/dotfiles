// Launching a draft (OBJ-04, OBJ-05).
//
// Launch is one transaction: the objective's thread between the user and the lead, the lead
// session (a child of the user at depth 0, whatever session proposed the draft), the phase
// `active`, and the lead's first run input. A crash before COMMIT leaves a draft and nothing else,
// so no objective is ever active without exactly one lead, and two launches racing produce one
// lead and one 409.

import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { ApiError } from "../api/errors.ts";
import type { Caller } from "../api/types.ts";
import { scheduleSubject } from "../search/index.ts";
import { DEFAULT_PROFILE, DEFAULT_THINKING, THINKING_LEVELS, loadProfile, parseModel } from "../sessions/create.ts";
import type { Runtime } from "../server/runtime.ts";
import { ensureScratch } from "../scratch/index.ts";
import { announce } from "../threads/announce.ts";
import { createThreadIn } from "../threads/store.ts";
import { leadBriefing } from "./brief.ts";
import type { ObjectiveRow } from "./schema.ts";
import { loadObjective, objectiveId, recordObjectiveEvent } from "./state.ts";
import { showObjective, type ObjectiveView } from "./view.ts";

/** The lead's profile and model. The default profile, unless a later package adds a per-objective one. */
function leadAgent(runtime: Runtime, objective: ObjectiveRow) {
	const profileName = DEFAULT_PROFILE;
	const profile = loadProfile(runtime, profileName);
	const modelName = runtime.config.defaultModel ?? profile.model;
	if (modelName === undefined) {
		throw ApiError.badRequest("missing_model", `objective ${objective.id} needs a lead model: set defaultModel or the profile's model`);
	}
	const thinking = profile.thinking ?? DEFAULT_THINKING;
	if (!(THINKING_LEVELS as readonly string[]).includes(thinking)) {
		throw ApiError.badRequest("invalid_thinking", `profile ${profileName}: thinking must be one of ${THINKING_LEVELS.join(", ")}`);
	}
	return { profileName, profile, model: parseModel(runtime, modelName), thinking: thinking as ModelThinkingLevel };
}

/**
 * `POST /objectives/:id/launch` (OBJ-04, OBJ-05). The user only; a session gets 403. Anything not
 * `drafting` is 409.
 */
export async function launchObjective(runtime: Runtime, caller: Caller, value: string | null | undefined): Promise<ObjectiveView> {
	const id = objectiveId(value, runtime.config.domain);
	if (caller.kind !== "user") {
		throw ApiError.forbidden("only the user may launch an objective");
	}

	// Read and render before the transaction, so the write holds only writes.
	const opening = await loadObjective(runtime.db, id);
	// The lead's input describes the objective it is about to lead, so it reads `active`.
	const body = await leadBriefing(runtime, { ...opening, phase: "active" }, { firstRun: true });
	const agent = leadAgent(runtime, opening);
	const leadId = runtime.newId();
	const cwd = ensureScratch(runtime, leadId);
	const subject = opening.goal.replace(/\s+/g, " ").trim().slice(0, 80);

	const recipients: string[] = [];
	const thread = await runtime.db.atomically(async (tx) => {
		const objective = await loadObjective(tx, id);
		if (objective.phase !== "drafting") {
			throw new ApiError(409, "wrong_phase", `objective ${id} is ${objective.phase}; only a draft can be launched`, {
				objective: id,
				phase: objective.phase,
			});
		}

		const now = runtime.clock.now();
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
		await tx.run(
			"INSERT INTO participants (id, kind, url, created_at) VALUES (?, 'session', ?, ?)",
			leadId,
			runtime.url({ kind: "session", id: leadId }),
			now,
		);
		// OBJ-05: the lead is a child of the user at depth 0, so it has no session parent and the
		// spawn depth counts from the top. `idle` until the thread's first message wakes it.
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

		// The objective's thread: the user and the lead, and the lead's first input.
		const created = await createThreadIn(
			tx,
			runtime,
			{ kind: "user", id: runtime.config.user, url: runtime.userUrl },
			{ to: [leadId], body, subject },
			recipients,
		);

		await tx.run(
			"UPDATE objectives SET phase = 'active', lead_id = ?, thread_id = ?, updated_at = ? WHERE id = ?",
			leadId,
			created.thread.id,
			now,
			id,
		);
		await recordObjectiveEvent(tx, runtime, {
			objectiveId: id,
			kind: "launched",
			actorId: caller.id,
			detail: { lead: leadId, thread: created.thread.id },
		});
		return created;
	});

	// Both are work that must not run inside the write, as in `createThread`.
	announce(runtime, "delivery", thread, recipients);
	scheduleSubject(runtime, thread.thread.id);
	return showObjective(runtime, id);
}
