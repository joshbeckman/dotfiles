// Migration 13's indexes: the objectives reads that filtered a `detail` or `payload` JSON key had
// no index and scanned, and `objective_events` grows with every run start and end (OBJ-23). This
// drives the objectives routes and checks the plan of every query they made, in the style of
// SRC-04/SRC-05 in `search.test.ts`: a regression to a scan fails here, not just in a bench.

import { afterEach, expect, it, vi } from "vitest";
import { nextWakes } from "../src/schedules/live.ts";
import { draft, launch, seedSession, startObjectives, view, pana } from "./harness/objectives.ts";
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
	let messageReads = 0;
	for (const [sql, detail] of plans) {
		// No read of either table may fall back to a table scan.
		expect(detail, `scans a table: ${sql}\n${detail}`).not.toMatch(/^SCAN (objective_events|schedules)\b/);
		if (sql.includes("json_extract(detail")) {
			eventReads += 1;
			expect(detail, `objective_events read misses the index: ${sql}\n${detail}`).toContain("objective_events_kind");
		}
		// OBJ-24's count: messages by a session, inside the day, for one objective.
		if (sql.includes("FROM messages m") && sql.includes("JOIN sessions s")) {
			messageReads += 1;
			expect(detail, `messages read misses the index: ${sql}\n${detail}`).toContain("messages_sender_created");
			expect(detail, `messages read scans: ${sql}\n${detail}`).not.toMatch(/SCAN m\b/);
		}
		if (sql.includes("json_extract") && (sql.includes("payload")) && sql.includes("FROM schedules")) {
			wakeReads += 1;
			expect(detail, `wake read misses the index: ${sql}\n${detail}`).toContain("schedules_wake_session");
			// With the order applied in JS, no wake read leaves a sort behind in SQLite.
			expect(detail, `wake read still sorts in SQLite: ${sql}\n${detail}`).not.toContain("USE TEMP B-TREE FOR ORDER BY");
		}
	}
	expect(eventReads).toBeGreaterThan(0);
	expect(wakeReads).toBeGreaterThan(0);
	expect(messageReads).toBeGreaterThan(0);
	// The retired index served every read the new one now does, and cost a write per event.
	expect(await t.runtime.db.get("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'objective_events_objective'")).toBeUndefined();
	expect(await t.runtime.db.get("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'objective_events_kind'")).toBeDefined();
});

it("WAK-01 OBJ-32 wakes keep their (next_at, id) order now that the sort leaves SQL", async () => {
	t = await startObjectives();
	const objective = await draft(t, "Sort the wakes");
	await launch(t, objective.id);
	const lead = (await view(t, objective.id)).lead!.id;
	const first = await seedSession(t, objective.id, "idle");
	const second = await seedSession(t, objective.id, "idle");
	const third = await seedSession(t, objective.id, "idle");
	const now = t.clock.now();
	const insert = (id: string, session: string, nextAt: number) =>
		t!.runtime.db.write((tx) =>
			tx.run(
				`INSERT INTO schedules (id, kind, state, at, timezone, creator_id, payload, next_at, created_at, updated_at, stop_after_success, revision)
				 VALUES (?, 'wake', 'active', ?, 'UTC', ?, ?, ?, ?, ?, 0, 0)`,
				id,
				nextAt,
				lead,
				JSON.stringify({ session, note: `wake ${id}` }),
				nextAt,
				now,
				now,
			),
		);
	// `first` has two wakes on the same instant whose ids disagree with insertion order.
	await insert("01WAKEZZZZZZZZZZZZZZZZZZZZZ", first, now + 5_000);
	await insert("01WAKEAAAAAAAAAAAAAAAAAAAAA", first, now + 5_000);
	// `second` is earlier than both, `third` ties with `first` under a higher id.
	await insert("01WAKEMIDDLEMIDDLEMIDDLEMID", second, now + 1_000);
	await insert("01WAKEBBBBBBBBBBBBBBBBBBBBB", third, now + 5_000);

	// The earliest wake per session, with the lower id breaking a tie.
	const wakes = await nextWakes(t.runtime, [first, second, third]);
	expect(wakes.get(first)!.at).toBe(now + 5_000);
	expect(wakes.get(first)!.url).toContain("01WAKEAAAAAAAAAAAAAAAAAAAAA");
	expect(wakes.get(second)!.url).toContain("01WAKEMIDDLEMIDDLEMIDDLEMID");
	expect(wakes.get(third)!.url).toContain("01WAKEBBBBBBBBBBBBBBBBBBBBB");

	// The brief lists them in the same order: earliest first, lower id on a tie.
	const all = vi.spyOn(t.runtime.db, "all");
	const res = await t.client.get<{ brief: string }>(`/objectives/${objective.id}/brief`);
	const calls = [...all.mock.calls];
	all.mockRestore();
	expect(res.status).toBe(200);
	const section = res.body.brief.split("## Pending wakes")[1]!.split("\n## ")[0]!;
	const lines = section.split("\n").filter((line) => line.startsWith("- "));
	const order = (session: string) => lines.findIndex((line) => line.includes(`/sessions/${session}`));
	expect(order(second)).toBeGreaterThanOrEqual(0);
	expect(order(second)).toBeLessThan(order(first));
	expect(order(first)).toBeLessThan(order(third));
	expect(lines.filter((line) => line.includes(`/sessions/${first} `))).toHaveLength(2);

	// Both statements use the wake index with no sort left in SQLite.
	let checked = 0;
	for (const [sql, ...params] of calls) {
		if (!(sql.includes("json_extract") && sql.includes("FROM schedules"))) continue;
		const detail = (await t.runtime.db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...params)).map((row) => row.detail).join("\n");
		expect(detail, sql).toContain("schedules_wake_session");
		expect(detail, sql).not.toContain("USE TEMP B-TREE FOR ORDER BY");
		checked += 1;
	}
	expect(checked).toBeGreaterThan(0);
});
