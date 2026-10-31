// A realistic domain with objectives for the OBJ-39 browser test and screenshots: one active
// objective with a charter, metrics, a report, an artifact, two members, a pending wake, spend, and
// an escalation, plus a draft with nothing spent, which is what an objective costs before launch.

import { recordCost } from "../../src/sessions/budget.ts";
import { sessionRuntime } from "../../src/sessions/index.ts";
import { FAKE_EPOCH, startTestPanad, type TestPanad } from "../harness/index.ts";

export interface SeededObjectives {
	t: TestPanad;
	active: { id: string; url: string; leadId: string; memberIds: string[]; wakeId: string };
	draft: { id: string; url: string };
	charter: Record<string, string>;
}

const GOAL = "Cut the house's energy bill by a fifth before the tariff changes";
const DRAFT_GOAL = "Keep every recipe we cook twice in one place";

export const CHARTER: Record<string, string> = {
	Scope: "The house's electricity, measured in kWh and dollars. Nothing else in the home.",
	Cancel: "Stop if the tariff changes, or if the work starts interrupting the household.",
	Done: "Every metric at its target for one week, and the user confirms it.",
	Guidance: "Read the meter before coffee. Ask before buying any hardware.",
	Escalation: "Ask me before changing the tariff, and before anything that costs more than $50.",
	Notes: "Baseline week: readings only. The dishwasher runs at night; the dryer is the big load.",
};

async function settle(t: TestPanad): Promise<void> {
	await t.clock.settle();
	await sessionRuntime(t.runtime).idle();
}

/** A session row for an objective: enough for every read to see a real member. */
async function member(t: TestPanad, objectiveId: string, parent: string | null, state: string): Promise<string> {
	const id = t.runtime.newId();
	const now = t.clock.now();
	await t.runtime.db.write(async (tx) => {
		await tx.run("INSERT INTO participants (id, kind, url, created_at) VALUES (?, 'session', ?, ?)", id, t.runtime.url({ kind: "session", id }), now);
		await tx.run(
			`INSERT INTO sessions (id, state, parent, depth, objective_id, profile, created_at, updated_at)
			 VALUES (?, ?, ?, 1, ?, 'default', ?, ?)`,
			id,
			state,
			parent,
			objectiveId,
			now,
			now,
		);
	});
	return id;
}

export async function seedObjectives(): Promise<SeededObjectives> {
	const t = await startTestPanad({
		config: { defaultModel: "faux/faux-1", timezone: "UTC" },
		script: [
			{ text: "Understood. I will read the meter each morning and report the weekly total." },
			{ text: "Noted." },
			{ text: "The new lead picks it up from here." },
			{ text: "Still here." },
		],
	});

	const made = await t.client.post<{ objective: { id: string; url: string } }>("/objectives", {
		goal: GOAL,
		dueAt: new Date(FAKE_EPOCH + 30 * 86_400_000).toISOString(),
		maxDailyUsd: 5,
		maxTotalUsd: 20,
		maxDailyLeadTurns: 12,
		maxDailyUserMessages: 6,
		maxActiveMembers: 4,
	});
	if (made.status !== 201) throw new Error(`create objective: ${JSON.stringify(made.body)}`);
	const active = made.body.objective;

	let rev = 0;
	for (const [section, body] of Object.entries(CHARTER)) {
		const written = await t.client.post(`/objectives/${active.id}/charter`, { section, body, baseRev: rev });
		if (written.status !== 200) throw new Error(`charter ${section}: ${JSON.stringify(written.body)}`);
		rev += 1;
	}

	const launched = await t.client.post<{ objective: { lead: { id: string } | null } }>(`/objectives/${active.id}/launch`, {});
	if (launched.status !== 200 || launched.body.objective.lead === null) throw new Error(`launch: ${JSON.stringify(launched.body)}`);
	const leadId = launched.body.objective.lead.id;
	// The lead's first run reads the briefing and answers in the objective's thread.
	await settle(t);

	const memberIds = [await member(t, active.id, leadId, "running"), await member(t, active.id, leadId, "idle")];

	for (const metric of [
		{ name: "kwh", unit: "kwh", direction: "down", target: 20, aggregation: "mean", window: "7d" },
		{ name: "bill-usd", unit: "usd", direction: "down", target: 90 },
		{ name: "reads", unit: "readings", direction: "up", target: 7 },
	]) {
		const declared = await t.client.post(`/objectives/${active.id}/metrics`, metric);
		if (declared.status !== 201) throw new Error(`metric ${metric.name}: ${JSON.stringify(declared.body)}`);
	}
	for (const [name, value] of [["kwh", 30], ["kwh", 28], ["kwh", 24], ["bill-usd", 120], ["bill-usd", 116], ["reads", 7]] as const) {
		const read = await t.client.post(`/objectives/${active.id}/metrics/${name}/readings`, { value });
		if (read.status !== 201) throw new Error(`reading ${name}: ${JSON.stringify(read.body)}`);
	}

	// WAK-08: one one-shot wake and one recurring wake, on different members.
	const wake = await t.client.post<{ schedule: { id: string } }>("/schedules", {
		kind: "wake",
		in: "90m",
		session: memberIds[0]!,
		note: "Read the meter and reply in the objective thread",
	});
	if (wake.status !== 201) throw new Error(`wake: ${JSON.stringify(wake.body)}`);
	if ((await t.client.post("/schedules", { kind: "wake", cron: "0 8 * * *", session: leadId, note: "Morning check of the readings" })).status !== 201) {
		throw new Error("recurring wake");
	}

	await t.runtime.db.write(async (tx) => {
		await recordCost(tx, t.runtime, leadId, 1.25);
		await recordCost(tx, t.runtime, memberIds[0]!, 0.5);
	});

	if ((await t.client.post(`/objectives/${active.id}/report`, { body: "Baseline is **30 kWh** a day. The dryer is the load worth moving." })).status !== 201) {
		throw new Error("report");
	}
	const uploaded = await t.client.request<{ file: { id: string } }>("POST", "/files?name=baseline.csv", {
		bytes: Buffer.from("day,kwh\nmon,31\ntue,29\n"),
		headers: { "content-type": "text/csv" },
	});
	if (uploaded.status !== 201) throw new Error(`upload: ${JSON.stringify(uploaded.body)}`);
	if ((await t.client.post(`/objectives/${active.id}/artifacts`, { file: uploaded.body.file.id })).status !== 201) throw new Error("artifact");

	// OBJ-33: the objective waits for a decision, so the view has an escalation to show.
	if ((await t.client.post(`/objectives/${active.id}/escalate`, { body: "Which reading should I trust, the meter or the supplier's app?" })).status !== 201) {
		throw new Error("escalate");
	}

	const draft = await t.client.post<{ objective: { id: string; url: string } }>("/objectives", { goal: DRAFT_GOAL });
	if (draft.status !== 201) throw new Error(`draft: ${JSON.stringify(draft.body)}`);

	return {
		t,
		active: { id: active.id, url: active.url, leadId, memberIds, wakeId: wake.body.schedule.id },
		draft: { id: draft.body.objective.id, url: draft.body.objective.url },
		charter: CHARTER,
	};
}
