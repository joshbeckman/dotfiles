// Creating and reading objectives (OBJ-01, OBJ-04).
//
// OBJ-04: creating an objective has no effects. A draft has no lead, no members, no schedules, no
// readings, and no notices, and it wakes nothing. A session's create always lands in `drafting`
// and records `proposed_by`, which is how a session or a lead proposes one; only the user launches
// (`launch.ts`).

import type { Caller } from "../api/types.ts";
import type { Runtime } from "../server/runtime.ts";
import {
	autonomyValue,
	goalText,
	objectBody,
	optionalDueAt,
	optionalLimit,
	type ObjectiveRow,
} from "./schema.ts";
import { loadObjective, recordObjectiveEvent } from "./state.ts";

export interface CreateObjectiveInput {
	goal?: unknown;
	dueAt?: unknown;
	autonomy?: unknown;
	maxDailyUsd?: unknown;
	maxTotalUsd?: unknown;
	wakeMinMinutes?: unknown;
	maxDailyLeadTurns?: unknown;
	maxDailyUserMessages?: unknown;
	maxActiveMembers?: unknown;
}

export interface CreatedObjective {
	objective: ObjectiveRow;
}

/** `POST /objectives` (OBJ-01). Always `drafting`, whatever the caller. */
export async function createObjective(runtime: Runtime, caller: Caller, raw: unknown): Promise<CreatedObjective> {
	const input = objectBody(raw) as CreateObjectiveInput;
	const goal = goalText(input.goal);
	const now = runtime.clock.now();
	const id = runtime.newId();

	// OBJ-04: a session's objective is a proposal, so it records who proposed it. The user's own
	// draft has no proposer: they are the only one who can launch it.
	const proposedBy = caller.kind === "session" ? caller.id : null;
	const row: ObjectiveRow = {
		id,
		goal,
		phase: "drafting",
		creator_id: caller.id,
		proposed_by: proposedBy,
		lead_id: null,
		thread_id: null,
		due_at: optionalDueAt(input.dueAt),
		autonomy: autonomyValue(input.autonomy),
		max_daily_usd: optionalLimit(input.maxDailyUsd, "max_daily_usd"),
		max_total_usd: optionalLimit(input.maxTotalUsd, "max_total_usd"),
		wake_min_minutes: optionalLimit(input.wakeMinMinutes, "wake_min_minutes"),
		max_daily_lead_turns: optionalLimit(input.maxDailyLeadTurns, "max_daily_lead_turns"),
		max_daily_user_messages: optionalLimit(input.maxDailyUserMessages, "max_daily_user_messages"),
		max_active_members: optionalLimit(input.maxActiveMembers, "max_active_members"),
		charter_rev: 0,
		stranded_noticed_at: null,
		behind_noticed_at: null,
		created_at: now,
		updated_at: now,
	};

	await runtime.db.atomically(async (tx) => {
		await tx.run(
			`INSERT INTO objectives (id, goal, phase, creator_id, proposed_by, lead_id, thread_id, due_at, autonomy,
			                         max_daily_usd, max_total_usd, wake_min_minutes, max_daily_lead_turns,
			                         max_daily_user_messages, max_active_members, charter_rev, created_at, updated_at)
			 VALUES (?, ?, 'drafting', ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
			row.id,
			row.goal,
			row.creator_id,
			row.proposed_by,
			row.due_at,
			row.autonomy,
			row.max_daily_usd,
			row.max_total_usd,
			row.wake_min_minutes,
			row.max_daily_lead_turns,
			row.max_daily_user_messages,
			row.max_active_members,
			now,
			now,
		);
		await recordObjectiveEvent(tx, runtime, { objectiveId: id, kind: "created", actorId: caller.id, detail: { phase: "drafting" } });
	});

	return { objective: (await loadObjective(runtime.db, id))! };
}
