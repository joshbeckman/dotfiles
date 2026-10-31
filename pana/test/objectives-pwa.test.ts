// OBJ-39: the PWA's objectives list and view. These run the browser module's mappers
// (`web/views.js`, `web/links.js`) against real handler output under `npm test`, the way
// test/integration.test.ts does for the other sections, so a shape change fails here instead of
// blanking a screen. The browser suite (`npm run test:web -- test/browser/objectives.spec.ts`)
// drives the same view in Chrome.

import { afterEach, expect, it } from "vitest";
import { recordCost } from "../src/sessions/budget.ts";
import { appHref, idHref, SECTIONS } from "../web/links.js";
import { charterBody, charterView, metricChart, metricsView, objectiveRow, objectiveView, objectiveWakes } from "../web/views.js";
import { startTestPanad, TEST_DOMAIN, type TestPanad } from "./harness/index.ts";

let t: TestPanad | undefined;
afterEach(async () => {
	await t?.close();
	t = undefined;
});

async function start(): Promise<TestPanad> {
	t = await startTestPanad({
		config: { defaultModel: "faux/faux-1", timezone: "UTC" },
		script: [{ text: "Understood. I will read the meter each morning." }, { text: "Noted." }],
	});
	return t;
}

const CHARTER: Array<[string, string]> = [
	["Scope", "The house's electricity, in kWh and dollars."],
	["Cancel", "Stop the objective if the tariff changes."],
	["Done", "Every metric at its target for a week."],
	["Guidance", "Read the meter before coffee, and ask before buying hardware."],
	["Escalation", "Ask me before changing the tariff."],
	["Notes", "Baseline week: readings only, no changes."],
];

/** A session row for an objective, with a participant, so every read sees a real member. */
async function member(objectiveId: string, parent: string | null, state = "idle"): Promise<string> {
	const id = t!.runtime.newId();
	const now = t!.clock.now();
	await t!.runtime.db.write(async (tx) => {
		await tx.run("INSERT INTO participants (id, kind, url, created_at) VALUES (?, 'session', ?, ?)", id, t!.runtime.url({ kind: "session", id }), now);
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

interface Shown {
	objective: Record<string, unknown> & { id: string; url: string; lead: { id: string; url: string } | null };
}

it("OBJ-39 the list and the view read real objective responses", async () => {
	await start();
	const made = await t!.client.post<{ objective: { id: string; url: string } }>("/objectives", { goal: "Cut the energy bill by a fifth" });
	expect(made.status, JSON.stringify(made.body)).toBe(201);
	const id = made.body.objective.id;

	// A draft: no lead, no members, no state, nothing on the clock (OBJ-04).
	let rev = 0;
	for (const [section, body] of CHARTER) {
		const written = await t!.client.post(`/objectives/${id}/charter`, charterBody(section, body, rev));
		expect(written.status, JSON.stringify(written.body)).toBe(200);
		rev += 1;
	}
	const listed = await t!.client.get<{ objectives: unknown[] }>("/objectives");
	const draft = objectiveRow(listed.body.objectives[0]);
	expect(draft).toMatchObject({
		id,
		url: `pana://${TEST_DOMAIN}/objectives/${id}`,
		goal: "Cut the energy bill by a fifth",
		phase: "drafting",
		state: null,
		holding: "",
		lead: "",
		spendTodayUsd: 0,
		leadRunsToday: 0,
	});

	// OBJ-05: launching creates the lead, the thread, and the first run.
	const launched = await t!.client.post<Shown>(`/objectives/${id}/launch`, {});
	expect(launched.status, JSON.stringify(launched.body)).toBe(200);
	const leadId = launched.body.objective.lead!.id;
	const working = await member(id, leadId, "running");

	for (const metric of [
		{ name: "kwh", unit: "kwh", direction: "down", target: 20, aggregation: "mean", window: "7d" },
		{ name: "bill-usd", unit: "usd", direction: "down", target: 90 },
	]) {
		const declared = await t!.client.post(`/objectives/${id}/metrics`, metric);
		expect(declared.status, JSON.stringify(declared.body)).toBe(201);
	}
	for (const value of [30, 28, 24]) {
		const read = await t!.client.post(`/objectives/${id}/metrics/kwh/readings`, { value });
		expect(read.status, JSON.stringify(read.body)).toBe(201);
	}
	await t!.client.post(`/objectives/${id}/metrics/bill-usd/readings`, { value: 120 });
	// WAK-08: a pending wake on a member is one of the objective's wakes.
	const wake = await t!.client.post<{ schedule: { id: string; nextAt: number } }>("/schedules", {
		kind: "wake",
		in: "90m",
		session: working,
		note: "Read the meter and reply here",
	});
	expect(wake.status, JSON.stringify(wake.body)).toBe(201);
	// OBJ-20: today's spend is the objective's, lead included.
	await t!.runtime.db.write((tx) => recordCost(tx, t!.runtime, leadId, 0.42));
	const report = await t!.client.post(`/objectives/${id}/report`, { body: "Baseline is **30 kWh** a day." });
	expect([200, 201]).toContain(report.status);
	const uploaded = await t!.client.request<{ file: { id: string } }>("POST", "/files?name=plan.md", {
		bytes: Buffer.from("# Plan\n"),
		headers: { "content-type": "text/markdown" },
	});
	expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(201);
	const linked = await t!.client.post(`/objectives/${id}/artifacts`, { file: uploaded.body.file.id });
	expect(linked.status, JSON.stringify(linked.body)).toBe(201);
	const escalated = await t!.client.post(`/objectives/${id}/escalate`, { body: "Which meter reading do you trust?" });
	expect(escalated.status, JSON.stringify(escalated.body)).toBe(201);

	const shown = await t!.client.get<Shown>(`/objectives/${id}`);
	expect(shown.status).toBe(200);
	const view = objectiveView(shown.body.objective);
	expect(view).toMatchObject({
		id,
		phase: "active",
		url: `pana://${TEST_DOMAIN}/objectives/${id}`,
		lead: `pana://${TEST_DOMAIN}/sessions/${leadId}`,
		charterRev: 6,
		autonomy: "manual",
		awaitingUser: true,
	});
	// OBJ-03: the derived state is present for an active objective and stored nowhere.
	expect(["running", "idle", "stranded"]).toContain(view.state);
	expect(view.thread).toMatchObject({ id: expect.any(String) });
	// UX-09: the roster links each member to its session, with the lead marked.
	expect(view.members.map((entry) => entry.id).sort()).toEqual([leadId, working].sort());
	expect(view.members.find((entry) => entry.lead)!.id).toBe(leadId);
	expect(view.members.find((entry) => entry.id === working)!.state).toBe("running");
	// OBJ-30/OBJ-31: the newest report and the linked artifact come with the view.
	expect(view.report).toMatchObject({ sender: t!.runtime.userUrl, body: "Baseline is **30 kWh** a day." });
	expect(view.artifacts).toEqual([expect.objectContaining({ name: "plan.md", size: 7 })]);
	// OBJ-33: the escalation names its scope and the thread whose answer clears it.
	expect(view.escalations).toEqual([expect.objectContaining({ scope: "objective", threadUrl: expect.stringContaining("/threads/") })]);
	// OBJ-20..OBJ-24: money and runs, with the limits this objective does not set left to the domain.
	const meters = Object.fromEntries(view.meters.map((meter) => [meter.id, meter]));
	expect(meters["spend-today"]).toMatchObject({ label: "Spend today", unit: "usd", value: 0.42, limit: null, share: null, over: false });
	expect(meters["spend-total"]!.value).toBeCloseTo(0.42, 6);
	expect(meters["runs-today"]!.value).toBeGreaterThanOrEqual(1);
	expect(meters.members).toMatchObject({ label: "Active members", value: 2 });

	// OBJ-28: one series per metric, each against its own target, and a count at target.
	const metrics = metricsView((await t!.client.get(`/objectives/${id}/metrics`)).body);
	expect(metrics.metrics.map((series) => series.name)).toEqual(["bill-usd", "kwh"]);
	expect(metrics.atTarget).toEqual({ count: 0, of: 2 });
	const kwh = metrics.metrics.find((series) => series.name === "kwh")!;
	expect(kwh.points).toHaveLength(3);
	// OBJ-27: a mean over a 7d window is the mean of the readings inside it.
	expect(kwh.current.value).toBeCloseTo((30 + 28 + 24) / 3, 6);
	expect(kwh.target).toBe(20);
	expect(kwh.atTarget).toBe(false);
	expect(kwh.baseline).toBe(30);

	// OBJ-09: every section comes back with its newest revision.
	const charter = charterView((await t!.client.get(`/objectives/${id}/charter`)).body);
	expect(charter.rev).toBe(6);
	expect(charter.sections.map((section) => section.name)).toEqual(["Scope", "Cancel", "Done", "Guidance", "Escalation", "Notes"]);
	expect(charter.sections.map((section) => section.body)).toEqual(CHARTER.map(([, body]) => body));
	expect(charter.sections[0]!.author).toBe(t!.runtime.userUrl);

	// WAK-08: the objective's pending wakes come from its members' own session details.
	const details = await Promise.all([leadId, working].map((session) => t!.client.get(`/sessions/${session}`)));
	const wakes = objectiveWakes(details.map((detail) => detail.body));
	expect(wakes).toEqual([
		expect.objectContaining({ sessionId: working, at: wake.body.schedule.nextAt, cron: null, url: expect.stringContaining("/schedules/") }),
	]);
	expect(wakes[0]!.sessionUrl).toBe(`pana://${TEST_DOMAIN}/sessions/${working}`);

	// REF-08/OBJ-39: an objective URL is a link, whichever form it arrives in.
	expect(appHref(view.url, TEST_DOMAIN)).toBe(`#/objectives/${id}`);
	expect(idHref(id, "objective")).toBe(`#/objectives/${id}`);
	expect(SECTIONS.map((section) => section.id)).toContain("objectives");
});

it("OBJ-39 charts one line per metric against its target, and never a percent-to-target total", () => {
	const body = {
		objective: { id: "O1", url: `pana://${TEST_DOMAIN}/objectives/O1`, phase: "active" },
		metrics: [
			{
				name: "weight",
				unit: "kg",
				direction: "down",
				target: 75,
				targetDisplay: "75 kg",
				aggregation: "raw",
				baseline: 80,
				current: { value: 78.5, at: 300, stale: false, display: "78.5 kg" },
				atTarget: false,
				readings: [
					{ at: 100, value: 80, source: "lead" },
					{ at: 200, value: 79, source: "lead" },
					{ at: 300, value: 78.5, source: "check" },
				],
			},
			{ name: "sessions", unit: "", direction: "up", target: null, targetDisplay: null, current: { value: null, at: null, stale: true }, atTarget: null, readings: [] },
		],
		atTarget: { count: 0, of: 1 },
	};
	const view = metricsView(body);
	// OBJ-28: the count is a count of metrics. No key here is a percentage or a total.
	expect(view.atTarget).toEqual({ count: 0, of: 1 });
	expect(Object.keys(view).sort()).toEqual(["atTarget", "metrics", "objectiveId", "phase", "url"]);
	expect(JSON.stringify(view)).not.toMatch(/pct|percent/i);

	const chart = metricChart(view.metrics[0]!);
	// One line through every reading, and a target line, both inside the box.
	expect(chart.line.split(" ")).toHaveLength(3);
	expect(chart.target).toMatchObject({ value: 75 });
	expect(chart.min).toBe(75);
	expect(chart.max).toBe(80);
	expect(chart.target!.y).toBeGreaterThan(0);
	// A series with no readings draws nothing rather than a line at zero (OBJ-27).
	expect(metricChart(view.metrics[1]!)).toMatchObject({ empty: true, line: "", target: null });
	// A flat metric opens its axis instead of dividing by zero.
	const flat = metricChart({ ...view.metrics[1]!, points: [{ at: 1, value: 5 }, { at: 2, value: 5 }], target: 5 });
	expect(flat.empty).toBe(false);
	expect(flat.min).toBeLessThan(5);
	expect(flat.max).toBeGreaterThan(5);
});

it("OBJ-39 sends a charter write with the revision it read, so a stale one is a conflict and not a loss", async () => {
	await start();
	const made = await t!.client.post<{ objective: { id: string } }>("/objectives", { goal: "Cut the energy bill" });
	const id = made.body.objective.id;
	expect((await t!.client.post(`/objectives/${id}/charter`, charterBody("Scope", "The house.", 0))).status).toBe(200);

	// The editor's own request body carries the revision it read.
	expect(charterBody("Scope", "The house and the car.", 1)).toEqual({ section: "Scope", body: "The house and the car.", baseRev: 1 });
	expect(charterBody("Scope", "The house and the car.")).toEqual({ section: "Scope", body: "The house and the car." });

	// Someone else writes first. The stale write is refused with the revision that is now current,
	// which is what the view shows beside the text it keeps.
	expect((await t!.client.post(`/objectives/${id}/charter`, charterBody("Done", "Every metric at target.", 1))).status).toBe(200);
	const stale = await t!.client.post<{ error: { code: string; charterRev: number; baseRev: number } }>(
		`/objectives/${id}/charter`,
		charterBody("Scope", "The house and the car.", 1),
	);
	expect(stale.status).toBe(409);
	expect(stale.body.error).toMatchObject({ code: "stale_charter", charterRev: 2, baseRev: 1 });

	// Writing again from the revision just read keeps the text.
	const saved = await t!.client.post<Record<string, unknown>>(`/objectives/${id}/charter`, charterBody("Scope", "The house and the car.", 2));
	expect(saved.status).toBe(200);
	expect(charterView(saved.body).sections.find((section) => section.name === "Scope")!.body).toBe("The house and the car.");
});
