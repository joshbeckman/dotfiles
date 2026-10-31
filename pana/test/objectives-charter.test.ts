// The charter (OBJ-09..OBJ-12): six sections, append-only revisions, one renderer, and `Scope` as
// guidance rather than a permission.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { CHARTER_SECTIONS, leadBriefing, memberBriefing, renderCharter } from "../src/objectives/index.ts";
import { activate, draft, events, inputs, launch, pana, seedSession, settle, startObjectives, view } from "./harness/objectives.ts";
import type { TestPanad } from "./harness/index.ts";

let t: TestPanad | undefined;
afterEach(async () => {
	await t?.close();
	t = undefined;
});

async function start(options: Parameters<typeof startObjectives>[0] = {}): Promise<TestPanad> {
	t = await startObjectives(options);
	return t;
}

async function sections(t: TestPanad, id: string, section?: string) {
	const res = await t.client.get<{ rev: number; sections: Record<string, unknown>; revisions: Array<Record<string, unknown>> }>(
		`/objectives/${id}/charter${section === undefined ? "" : `?section=${section}`}`,
	);
	expect(res.status).toBe(200);
	return res.body;
}

// --- OBJ-09 --------------------------------------------------------------------

it("OBJ-09 the charter has six sections, matches a name case-insensitively, and stores its canonical spelling", async () => {
	await start();
	const objective = await draft(t!);

	for (const [written, canonical] of [
		["scope", "Scope"],
		["CANCEL", "Cancel"],
		["Done", "Done"],
		["gUiDaNcE", "Guidance"],
		["escalation", "Escalation"],
		["notes", "Notes"],
	] as const) {
		const res = await t!.client.post(`/objectives/${objective.id}/charter`, { section: written, body: `${canonical} text` });
		expect(res.status, written).toBe(200);
	}

	const stored = await t!.runtime.db.all<{ section: string }>("SELECT section FROM objective_charter_revisions WHERE objective_id = ? ORDER BY rev", objective.id);
	expect(stored.map((row) => row.section)).toEqual([...CHARTER_SECTIONS]);
	const log = await sections(t!, objective.id);
	expect(Object.keys(log.sections).sort()).toEqual([...CHARTER_SECTIONS].sort());
	expect(log.rev).toBe(6);
	// The charter is the newest revision of each section.
	expect((log.sections.Notes as { body: string }).body).toBe("Notes text");

	// An unknown section is 400, and writes nothing.
	const before = await t!.runtime.db.get<{ n: number }>("SELECT count(*) AS n FROM objective_charter_revisions");
	const unknown = await t!.client.post(`/objectives/${objective.id}/charter`, { section: "Budget", body: "no" });
	expect(unknown.status).toBe(400);
	expect((unknown.body as { error: { code: string } }).error.code).toBe("invalid_section");
	expect(await t!.runtime.db.get("SELECT count(*) AS n FROM objective_charter_revisions")).toEqual(before);

	// The CLI reaches the same routes.
	const set = await pana(t!, "objective charter set", { id: objective.id, section: "NOTES", body: "from the cli" });
	expect(set.exitCode).toBe(0);
	const cliLog = await pana(t!, "objective charter log", { id: objective.id, section: "notes" });
	expect(cliLog.exitCode).toBe(0);
	expect((cliLog.body as { revisions: Array<{ section: string; body: string }> }).revisions.map((revision) => revision.body)).toEqual(["from the cli", "Notes text"]);
	expect((await pana(t!, "objective charter set", { id: objective.id, section: "nope", body: "x" })).exitCode).toBe(2);
});

it("OBJ-09 every write appends an immutable revision with its author and time, and nothing updates or deletes one", async () => {
	await start();
	const objective = await draft(t!);
	const member = await seedSession(t!, objective.id);
	const wrote = await t!.client.post<{ rev: number; revisions: Array<{ rev: number; body: string; author: { id: string; url: string }; at: number }> }>(
		`/objectives/${objective.id}/charter`,
		{ section: "Notes", body: "first" },
		{ caller: member },
	);
	expect(wrote.status).toBe(200);
	await t!.clock.advance(60_000);
	await t!.client.post(`/objectives/${objective.id}/charter`, { section: "Notes", body: "second" });

	const log = await sections(t!, objective.id);
	expect(log.revisions.map((revision) => (revision as { body: string }).body)).toEqual(["second", "first"]);
	const newest = log.revisions[0] as { rev: number; at: number; author: { id: string } };
	const oldest = log.revisions[1] as { rev: number; at: number; author: { id: string; url: string } };
	expect(newest.rev).toBe(2);
	expect(oldest.author).toEqual({ id: member, url: `pana://test.example/sessions/${member}` });
	expect(oldest.at).toBe(t!.clock.now() - 60_000);
	// The first revision stays exactly as written.
	expect(oldest).toMatchObject({ rev: 1, body: "first" });

	// EDT-04's shape: no code path updates or deletes a charter revision.
	const packageDir = join(import.meta.dirname, "..", "src", "objectives");
	const offenders: string[] = [];
	for (const name of readdirSync(packageDir)) {
		if (!name.endsWith(".ts")) continue;
		const source = readFileSync(join(packageDir, name), "utf8");
		if (/UPDATE\s+objective_charter_revisions/i.test(source) || /DELETE\s+FROM\s+objective_charter_revisions/i.test(source)) offenders.push(name);
	}
	expect(offenders).toEqual([]);

	// `baseRev` is the MEM-09 shape: a charter that moved since the read is 409, and writes nothing.
	const stale = await t!.client.post(`/objectives/${objective.id}/charter`, { section: "Notes", body: "over the top", baseRev: 0 });
	expect(stale.status).toBe(409);
	expect((stale.body as { error: { code: string; charterRev: number } }).error).toMatchObject({ code: "stale_charter", charterRev: 2 });
	const fresh = await t!.client.post(`/objectives/${objective.id}/charter`, { section: "Notes", body: "read and written", baseRev: 2 });
	expect(fresh.status).toBe(200);
	expect((await pana(t!, "objective charter set", { id: objective.id, section: "Notes", body: "cli stale", "base-rev": "1" })).exitCode).toBe(3);
	expect((await pana(t!, "objective charter set", { id: objective.id, section: "Notes", body: "cli fresh", "base-rev": "3" })).exitCode).toBe(0);
	expect((await t!.client.post(`/objectives/${objective.id}/charter`, { section: "Notes", body: "x", baseRev: -1 })).status).toBe(400);
	expect((await t!.client.get(`/objectives/${objective.id}/charter?section=Budget`)).status).toBe(400);
});

// --- OBJ-10 --------------------------------------------------------------------

it("OBJ-10 the user writes every section; a session writes only Notes", async () => {
	await start();
	const objective = await draft(t!);
	const member = await seedSession(t!, objective.id);

	for (const section of CHARTER_SECTIONS) {
		const bySession = await t!.client.post(`/objectives/${objective.id}/charter`, { section, body: "session text" }, { caller: member });
		if (section === "Notes") expect(bySession.status, section).toBe(200);
		else {
			expect(bySession.status, section).toBe(403);
			expect((bySession.body as { error: { code: string } }).error.code).toBe("forbidden");
		}
		const byUser = await t!.client.post(`/objectives/${objective.id}/charter`, { section, body: "user text" });
		expect(byUser.status, section).toBe(200);
	}
	// A lead cannot widen its own authority: the grant sections stayed the user's.
	const stored = await t!.runtime.db.all<{ section: string; created_by: string }>(
		"SELECT section, created_by FROM objective_charter_revisions WHERE objective_id = ? AND section <> 'Notes' ORDER BY rev",
		objective.id,
	);
	expect(stored.every((row) => row.created_by === "tester")).toBe(true);
});

// --- OBJ-11 --------------------------------------------------------------------

it("OBJ-11 one renderer produces the charter for the lead and for a member, twice the same", async () => {
	await start({ script: [{ text: "I am the lead." }] });
	const objective = await draft(t!);
	await t!.client.post(`/objectives/${objective.id}/charter`, { section: "Scope", body: "Only the meter and the boiler." });
	await t!.client.post(`/objectives/${objective.id}/charter`, { section: "Guidance", body: "Read before you write." });
	await launch(t!, objective.id);
	const lead = (await view(t!, objective.id)).lead!.id;

	// The lead's briefing carries all six sections, twice identical for the same rows.
	const first = await leadBriefing(t!.runtime, (await t!.runtime.db.get("SELECT * FROM objectives WHERE id = ?", objective.id)) as never);
	const second = await leadBriefing(t!.runtime, (await t!.runtime.db.get("SELECT * FROM objectives WHERE id = ?", objective.id)) as never);
	expect(first).toBe(second);
	for (const section of CHARTER_SECTIONS) expect(first).toContain(`### ${section}`);
	expect(first).toContain("Only the meter and the boiler.");
	// `Cancel` is empty by default, and the render says an empty section grants nothing.
	expect(first).toContain("### Cancel");
	expect(first).toMatch(/Empty: an empty section grants nothing[\s\S]*Escalate/);

	const memberRender = renderCharter(
		{ Scope: undefined, Cancel: undefined, Done: undefined, Guidance: undefined, Escalation: undefined, Notes: undefined },
		{ audience: "member" },
	);
	expect(memberRender).toContain("### Scope");
	expect(memberRender).toContain("### Guidance");
	expect(memberRender).not.toContain("### Cancel");
	expect(memberRender).not.toContain("### Notes");
	// A member's own first input carries Scope and Guidance, from the same renderer.
	const memberBrief = await memberBriefing(t!.runtime, objective.id);
	expect(memberBrief).toContain("### Scope");
	expect(memberBrief).toContain("Only the meter and the boiler.");
	expect(memberBrief).toContain("Read before you write.");
	expect(memberBrief).not.toContain("### Cancel");

	// The lead's actual input is the brief, and the next run's input is the brief again plus the mail.
	expect((await inputs(t!, lead))[0]).toContain("### Scope");
	expect((await inputs(t!, lead))[0]).toContain("### Notes");
});

it("OBJ-11 a member's first input carries Scope and Guidance, whatever prompt the lead wrote", async () => {
	await start({ script: [{ text: "I am the lead." }, { text: "Member at work." }] });
	const objective = await draft(t!);
	await t!.client.post(`/objectives/${objective.id}/charter`, { section: "Scope", body: "The boiler room only." });
	await t!.client.post(`/objectives/${objective.id}/charter`, { section: "Guidance", body: "Ask before ordering parts." });
	await t!.client.post(`/objectives/${objective.id}/charter`, { section: "Notes", body: "The user prefers mornings." });
	await launch(t!, objective.id);
	const lead = (await view(t!, objective.id)).lead!.id;
	await settle(t!);

	const created = await t!.client.post<{ session: { id: string } }>("/sessions", { prompt: "Audit the boiler.", to: [lead] }, { caller: lead });
	expect(created.status).toBe(201);
	await settle(t!);
	const first = (await inputs(t!, created.body.session.id))[0]!;
	expect(first).toContain("Audit the boiler.");
	expect(first).toContain("### Scope");
	expect(first).toContain("The boiler room only.");
	expect(first).toContain("### Guidance");
	expect(first).toContain("Ask before ordering parts.");
	// Notes is the lead's, not the member's.
	expect(first).not.toContain("The user prefers mornings.");
});

// --- OBJ-12 --------------------------------------------------------------------

it("OBJ-12 Scope is guidance, the briefing says so, and it names each member's profile", async () => {
	await start();
	const objective = await draft(t!);
	const lead = await seedSession(t!, objective.id, "idle", { profile: "coordinator" });
	const worker = await seedSession(t!, objective.id, "stopped", { parent: lead, profile: "energy" });
	await activate(t!, objective.id, lead);
	await t!.client.post(`/objectives/${objective.id}/charter`, { section: "Scope", body: "Only the meter." });

	const brief = await leadBriefing(t!.runtime, (await t!.runtime.db.get("SELECT * FROM objectives WHERE id = ?", objective.id)) as never);
	expect(brief).toContain("`Scope` is guidance, not a sandbox");
	expect(brief).toContain("profile coordinator");
	expect(brief).toContain("profile energy");
	expect(brief).toContain(`pana://test.example/sessions/${worker}`);
	// The view names it too, so the roster a reader sees agrees with the brief.
	expect((await view(t!, objective.id)).members.map((member) => member.profile)).toEqual(["coordinator", "energy"]);

	// No code path reads Scope as a permission check: the files that gate a run never mention it.
	const root = join(import.meta.dirname, "..", "src");
	const gates = [
		join(root, "sessions", "create.ts"),
		join(root, "sessions", "runtime.ts"),
		join(root, "objectives", "gates.ts"),
		join(root, "objectives", "admission.ts"),
		join(root, "objectives", "state.ts"),
	];
	for (const path of gates) {
		const source = readFileSync(path, "utf8");
		expect(source, path).not.toMatch(/\bScope\b/);
		expect(source, path).not.toContain("CHARTER_SECTIONS");
	}
	// And what an escalation records is the whole objective's state, not a charter read.
	const events = await t!.runtime.db.all<{ kind: string }>("SELECT kind FROM objective_events WHERE objective_id = ?", objective.id);
	expect(events.length).toBeGreaterThan(0);
	expect((await view(t!, objective.id)).state).toBe("stranded");
	// A stopped-by-the-user member is listed as such, and no condition revives it (OBJ-14's shape).
	await t!.runtime.db.write((tx) => tx.run("UPDATE sessions SET stopped_by = 'user' WHERE id = ?", worker));
	const after = await leadBriefing(t!.runtime, (await t!.runtime.db.get("SELECT * FROM objectives WHERE id = ?", objective.id)) as never);
	expect(after).toContain("stopped by the user — inert to the objective");
});

// Keep `events` (harness helper) referenced: the charter log records `charter.set` events.
it("OBJ-09 a charter write records an objective event naming the section", async () => {
	await start();
	const objective = await draft(t!);
	await t!.client.post(`/objectives/${objective.id}/charter`, { section: "Notes", body: "keep state here" });
	const recorded = await events(t!, objective.id, "charter.set");
	expect(recorded).toHaveLength(1);
	expect(recorded[0]!.detail).toMatchObject({ section: "Notes", rev: 1 });
});
