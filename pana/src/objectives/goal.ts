// The draft's goal, and the one way to change it (OBJ-42).
//
// `POST /objectives` is how a goal is first written, and it is the only other write path for
// `objectives.goal`. A goal the user typed wrong is fixed here rather than by drafting a second
// objective and abandoning the first: while the phase is `drafting` the goal is still a
// description of work that has not started, so setting it costs nothing and reaches nobody
// (OBJ-04). The moment the objective launches, the goal is the lead's instruction and the
// members' context, so it is frozen, and this refuses any other phase (409 `wrong_phase`).
//
// The user only: a session's goal is a proposal (`proposed_by`), and the user is the one who
// launches it, so the user is the one who decides what it says. Each write appends an
// `objective_events` row naming the old goal and the new one, the way a metric's target change
// (OBJ-29) and a limit change (OBJ-41) do, so the history says what the user asked for.

import { ApiError } from "../api/errors.ts";
import type { Caller } from "../api/types.ts";
import type { Runtime } from "../server/runtime.ts";
import { goalText, objectBody, type ObjectiveRow } from "./schema.ts";
import { loadObjective, objectiveId, recordObjectiveEvent } from "./state.ts";

/** What `setGoal` wrote: the objective's row after the write, and the goal it replaced. */
export interface GoalWritten {
	row: ObjectiveRow;
	from: string;
	to: string;
}

/**
 * `POST /objectives/:id/goal` (OBJ-42) and `pana objective goal set`: the goal of a drafting
 * objective, the user only. One transaction writes the goal and appends the event, so a crash
 * leaves neither a changed goal without its history nor the reverse.
 */
export async function setGoal(runtime: Runtime, caller: Caller, value: string | null | undefined, raw: unknown): Promise<GoalWritten> {
	if (caller.kind !== "user") throw ApiError.forbidden("only the user may change an objective's goal");
	const id = objectiveId(value, runtime.config.domain);
	// `--goal` or `--goal-file` is one text by the time it arrives; a body with neither is a 400.
	const goal = goalText(objectBody(raw).goal);

	return runtime.db.atomically(async (tx) => {
		const row = await loadObjective(tx, id);
		if (row.phase !== "drafting") {
			throw new ApiError(409, "wrong_phase", `objective ${row.id} is ${row.phase}; only a drafting objective's goal can be set`, {
				objective: row.id,
				phase: row.phase,
			});
		}
		await tx.run("UPDATE objectives SET goal = ?, updated_at = ? WHERE id = ?", goal, runtime.clock.now(), id);
		await recordObjectiveEvent(tx, runtime, { objectiveId: id, kind: "goal.set", actorId: caller.id, detail: { from: row.goal, to: goal } });
		return { row: await loadObjective(tx, id), from: row.goal, to: goal };
	});
}
