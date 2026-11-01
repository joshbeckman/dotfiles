// Migration 13's indexes: the objectives reads that filtered a `detail` or `payload` JSON key had
// no index and scanned, and `objective_events` grows with every run start and end (OBJ-23). This
// drives the objectives routes and checks the plan of every query they made, in the style of
// SRC-04/SRC-05 in `search.test.ts`: a regression to a scan fails here, not just in a bench.

import { afterEach, expect, it, vi } from "vitest";
import { activate, draft, launch, seedSession, startObjectives, view, pana } from "./harness/objectives.ts";
import type { TestPanad } from "./harness/index.ts";

let t: TestPanad | undefined;
afterEach(async () => {
	await t?.close();
	t = undefined;
});

const WAKE = "kind = 'wake' AND state = 'active'";

it("OBJ-23 WAK-01 objectives reads plan through the event and wake indexes", async () => {
	t = await startObjectives();
	const objective = await draft(t, "Cut the energy bill", { maxDailyLeadTurns: 3 });
	await launch(t, objective.id);
	const shown = await view(t, objective.id);
	const lead = shown.lead!.id;
	// A member with a pending wake and a hold wake, so the wake reads have rows to find.
	const member = await seedSession(t, objective.id, "idle");
	const now = t.clock.now();
	const wake = await t.client.post<{ schedule: { id: string } }>("/schedules", { kind: "wake", session: member, in: "1h", note: "Check the meter." });
	expect(wake.status).toBe(201);
	await t.runtime.db.write(async (tx) => {
		await tx.run(
			`INSERT INTO schedules (id, kind, state, at, timezone, creator_id, payload, next_at, created_at, updated_at, stop_after_success, revision)
			 VALUES (?, 'wake', 'active', ?, 'UTC', ?, ?, ?, ?, ?, 0, 0)`,
			t!.runtime.newId(),
			now + 120_000,
			lead,
			JSON.stringify({ session: lead, note: "waiting on the budget", hold: true, condition: "budget_day", objective: objective.id }),
			now + 120_000,
			now,
			now,
		);
		// A run that started and ended today, so the lead's daily counts and quiet interval read rows.
		await tx.run(
			"INSERT INTO objective_events (id, objective_id, at, kind, detail) VALUES (?, ?, ?, 'run.started', ?)",
			t!.runtime.newId(),
			objective.id,
			now,
			JSON.stringify({ session: lead, lead: 1, run: "run-1" }),
		);
		await tx.run(
			"INSERT INTO objective_events (id, objective_id, at, kind, detail) VALUES (?, ?, ?, 'run.ended', ?)",
			t!.runtime.newId(),
			objective.id,
			now + 1000,
			JSON.stringify({ session: lead, run: "run-1" }),
		);
	});
	await pana(t, "objective", { command: "show", objective: objective.id });

	// Everything the objectives read routes and the lead's briefing run, with their parameters.
	const all = vi.spyOn(t.runtime.db, "all");
	const get = vi.spyOn(t.runtime.db, "get");
	await view(t, objective.id);
	await t.client.get(`/objectives/${objective.id}/brief`);
	await t.client.get("/objectives");
	const calls = [...all.mock.calls, ...get.mock.calls];
	all.mockRestore();
	get.mockRestore();
	expect(calls.length).toBeGreaterThan(0);

	const plans = new Map<string, string>();
	for (const [sql, ...params] of calls) {
		const detail = (await t.runtime.db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...params)).map((row) => row.detail).join("\n");
		plans.set(sql, detail);
	}

	let eventReads = 0;
	let wakeReads = 0;
	for (const [sql, detail] of plans) {
		// No read of either table may fall back to a table scan.
		expect(detail, `scans a table: ${sql}\n${detail}`).not.toMatch(/^SCAN (objective_events|schedules)\b/);
		if (sql.includes("json_extract(detail")) {
			eventReads += 1;
			expect(detail, `objective_events read misses the index: ${sql}\n${detail}`).toContain("objective_events_kind");
		}
		if (sql.includes("json_extract") && (sql.includes("payload")) && sql.includes("FROM schedules")) {
			wakeReads += 1;
			// The IN-list reads that also ORDER BY next_at keep the state index: paging in
			// `next_at` order over an IN list needs a sort either way, and without `sqlite_stat1`
			// SQLite prefers the order it already has (BENCH.md records both plans).
			if (sql.includes("ORDER BY next_at")) expect(detail).toContain("schedules_state");
			else expect(detail, `wake read misses the index: ${sql}\n${detail}`).toContain("schedules_wake_session");
		}
	}
	expect(eventReads).toBeGreaterThan(0);
	expect(wakeReads).toBeGreaterThan(0);
	// The retired index served every read the new one now does, and cost a write per event.
	expect(await t.runtime.db.get("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'objective_events_objective'")).toBeUndefined();
	expect(await t.runtime.db.get("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'objective_events_kind'")).toBeDefined();
});
