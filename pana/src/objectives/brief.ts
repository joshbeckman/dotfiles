// The lead's briefing (OBJ-32) — the seam this foundation leaves for the briefing package.
//
// The real renderer lists the goal, phase and holding conditions, all six charter sections, the
// member roster with each member's state, URL, and stop reason, the objective URL, money and runs
// spent, each metric's latest value and target, pending wakes, `awaiting_user`, the count of held
// deliveries, and the last five reports (OBJ-32, OBJ-11, OBJ-12, OBJ-37). It must be deterministic
// for a given database state (the PRM-04 pattern).
//
// This stub renders what launch needs so that OBJ-05 can hand the lead a first input: the goal,
// the objective URL, and where the charter will be. It is the whole of the file the briefing
// package replaces; nothing else reads it.
//
// TODO(WP18 briefing): replace `leadBriefing` with the full renderer, keeping the signature.

import type { Runtime } from "../server/runtime.ts";
import type { ObjectiveRow } from "./schema.ts";
import { objectiveUrl } from "./state.ts";

export interface BriefingOptions {
	/** True for the launch input, before any run has happened. */
	firstRun?: boolean;
}

/** Render the input a lead run starts with. Deterministic for a given database state. */
export async function leadBriefing(runtime: Runtime, row: ObjectiveRow, options: BriefingOptions = {}): Promise<string> {
	const url = objectiveUrl(runtime, row.id);
	const lines = [
		`Objective: ${row.goal}`,
		`Objective URL: ${url}`,
		`Phase: ${row.phase}`,
	];
	if (options.firstRun === true) {
		lines.push(
			"",
			"This is your first run as the lead of this objective. Your charter is empty: it has no Scope, Cancel, Done, Guidance, Escalation, or Notes sections yet.",
			"An empty section grants nothing. Escalate to the user rather than assuming permission, and keep objective state in the charter's Notes.",
			"Coordinate: create members for the work, keep durable understanding in memory as any session does, and answer with pana_reply. Hold no durable output of your own.",
		);
	}
	return lines.join("\n");
}
