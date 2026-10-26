// WP16: session scratch directories, their sweep, and the note a removal leaves (SCR-01..SCR-07).

import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runPanaCommand } from "../src/cli/commands.ts";
import { createPanaEnv, PanaExecutionEnv } from "../src/extension/env.ts";
import { fillPrompt, promptTemplate, scratchNote } from "../src/extension/prompt.ts";
import { DAY_MS, sweepScratch } from "../src/scratch/index.ts";
import { sessionRuntime } from "../src/sessions/index.ts";
import { startTestPanad, type TestPanad } from "./harness/index.ts";

let t: TestPanad | undefined;
afterEach(async () => {
	await t?.close();
	t = undefined;
});

async function start(config: Record<string, unknown> = {}): Promise<TestPanad> {
	t = await startTestPanad({ config: { defaultModel: "faux/faux-1", timezone: "UTC", ...config } });
	return t;
}

type Params = Record<string, string | string[] | boolean | undefined>;

async function command(name: string, params: Params, caller?: string) {
	return runPanaCommand(name, params, {
		endpoint: { socketPath: t!.panad.socketPath },
		...(caller ? { caller } : {}),
	});
}

/** A session row, not wakeable, last changed `idleMs` ago. */
async function seedSession(state: string, idleMs = 0): Promise<string> {
	const id = t!.runtime.newId();
	const now = t!.clock.now();
	await t!.runtime.db.write(async (tx) => {
		await tx.run("INSERT INTO participants (id, kind, url, created_at) VALUES (?, 'session', ?, ?)", id, t!.runtime.url({ kind: "session", id }), now);
		await tx.run("INSERT INTO sessions (id, state, depth, created_at, updated_at) VALUES (?, ?, 0, ?, ?)", id, state, now - idleMs, now - idleMs);
	});
	return id;
}

/** Give a session's scratch a file of `bytes` bytes. */
function fill(id: string, bytes = 4096): string {
	const dir = join(t!.runtime.paths.scratch, id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "work.bin"), Buffer.alloc(bytes, 1));
	return dir;
}

async function removedColumns(id: string) {
	return t!.runtime.db.get<{ scratch_removed_at: number | null; scratch_removed_bytes: number | null }>(
		"SELECT scratch_removed_at, scratch_removed_bytes FROM sessions WHERE id = ?",
		id,
	);
}

async function openEnv(conversationId: number, cwd?: string): Promise<PanaExecutionEnv> {
	return (await createPanaEnv(() => t!.runtime)({ conversationId, ...(cwd ? { cwd } : {}) })) as PanaExecutionEnv;
}

interface Created {
	session: { id: string; cwd: string; conversationId: number };
}

describe("SCR-01 a scratch directory per session", () => {
	it("SCR-01 bash exports PANA_SCRATCH, and opening the environment remakes a removed scratch", async () => {
		await start();
		const created = await t!.client.post<Created>("/sessions", { prompt: "hello", cwd: t!.dir });
		expect(created.status, JSON.stringify(created.body)).toBe(201);
		const { id, conversationId } = created.body.session;
		const dir = join(t!.runtime.paths.scratch, id);

		const env = await openEnv(conversationId, t!.dir);
		expect(env.panaEnv.PANA_SCRATCH).toBe(dir);
		expect(existsSync(dir)).toBe(true);

		await sessionRuntime(t!.runtime).idle();
		await t!.runtime.db.run("UPDATE sessions SET state = 'idle', updated_at = ? WHERE id = ?", t!.clock.now() - 9 * DAY_MS, id);
		await sweepScratch(t!.runtime);
		expect(existsSync(dir)).toBe(false);

		await openEnv(conversationId, t!.dir);
		expect(existsSync(dir)).toBe(true);
	});

	it("SCR-01 pana scratch prints the calling session's path, and the user names a session", async () => {
		await start();
		const id = await seedSession("idle");
		const dir = join(t!.runtime.paths.scratch, id);

		const own = await command("scratch", {}, id);
		expect(own.exitCode, JSON.stringify(own.body)).toBe(0);
		expect(own.body).toMatchObject({ session: id, path: dir, bytes: null });

		const unnamed = await command("scratch", {});
		expect(unnamed.exitCode).toBe(2);

		fill(id);
		const named = await command("scratch", { session: t!.runtime.url({ kind: "session", id }) });
		expect(named.body).toMatchObject({ session: id, path: dir });
		expect((named.body as { bytes: number }).bytes).toBeGreaterThan(0);
	});
});

describe("SCR-03 the prompt", () => {
	it("SCR-03 the pana prompt gives the scratch path, says it is deleted, and sends keepers to memory", () => {
		const text = fillPrompt(promptTemplate(), {
			sessionUrl: "pana://d/sessions/X",
			memoryPath: "/m/X",
			domain: "d",
			scratchPath: "/state/scratch/X",
			scratchTtlDays: 8,
		});
		expect(text).toContain("Your scratch directory: /state/scratch/X");
		expect(text).toContain("$PANA_SCRATCH");
		expect(text).toMatch(/idle for\s+8 days/);
		expect(text).toMatch(/worth\s+keeping in memory/);
		expect(text).not.toContain("{{");
		expect(text).not.toContain("removed your scratch");
	});
});

describe("SCR-04 archive", () => {
	it("SCR-04 archiving a session removes its scratch", async () => {
		await start();
		const id = await seedSession("idle");
		const dir = fill(id);
		const archived = await command("session archive", { id });
		expect(archived.exitCode, JSON.stringify(archived.body)).toBe(0);
		expect(existsSync(dir)).toBe(false);
		expect((await removedColumns(id))?.scratch_removed_at).toBe(t!.clock.now());
		expect(readdirSync(t!.runtime.paths.scratch)).toEqual([]);
	});
});

describe("SCR-05 the sweep", () => {
	it("SCR-05 removes archived, orphaned, and idle scratch, and keeps working and recent sessions'", async () => {
		await start();
		const old = 9 * DAY_MS;
		const archived = await seedSession("archived");
		const idle = await seedSession("idle", old);
		const failed = await seedSession("failed", old);
		const running = await seedSession("running", old);
		const recent = await seedSession("idle", 7 * DAY_MS);
		const orphan = t!.runtime.newId();
		const youngOrphan = t!.runtime.newId();
		for (const id of [archived, idle, failed, running, recent, orphan, youngOrphan]) fill(id);
		const past = (t!.clock.now() - old) / 1000;
		utimesSync(join(t!.runtime.paths.scratch, orphan), past, past);
		const young = t!.clock.now() / 1000;
		utimesSync(join(t!.runtime.paths.scratch, youngOrphan), young, young);

		const result = await sweepScratch(t!.runtime);
		const reasons = Object.fromEntries(result.removed.map((removal) => [removal.session, removal.reason]));
		expect(reasons).toEqual({ [archived]: "archived", [idle]: "idle", [failed]: "idle", [orphan]: "orphan" });
		expect(result.removedBytes).toBeGreaterThan(0);
		expect(readdirSync(t!.runtime.paths.scratch).sort()).toEqual([running, recent, youngOrphan].sort());
	});

	it("SCR-05 the TTL comes from scratch.ttlDays", async () => {
		await start({ scratch: { ttlDays: 2 } });
		const idle = await seedSession("idle", 3 * DAY_MS);
		fill(idle);
		expect((await sweepScratch(t!.runtime)).removed.map((removal) => removal.session)).toEqual([idle]);
	});

	it("SCR-05 over scratch.maxTotalMB, removes the longest-idle first and never a working session's", async () => {
		await start({ scratch: { maxTotalMB: 1 } });
		const working = await seedSession("running", 5 * DAY_MS);
		const oldest = await seedSession("idle", 3 * DAY_MS);
		const newer = await seedSession("idle", 1 * DAY_MS);
		for (const id of [working, oldest, newer]) fill(id, 400 * 1024);

		const result = await sweepScratch(t!.runtime);
		expect(result.removed.map((removal) => [removal.session, removal.reason])).toEqual([[oldest, "over_total"]]);
		expect(existsSync(join(t!.runtime.paths.scratch, working))).toBe(true);
		expect(existsSync(join(t!.runtime.paths.scratch, newer))).toBe(true);
	});

	it("SCR-05 panad sweeps again every 24 hours on its clock", async () => {
		await start();
		await t!.clock.settle();
		const id = await seedSession("idle", 8 * DAY_MS - 60_000);
		const dir = fill(id);
		await t!.clock.advance(60 * 60 * 1000);
		expect(existsSync(dir)).toBe(true);
		await t!.clock.advance(DAY_MS);
		for (let i = 0; i < 100 && existsSync(dir); i++) await new Promise((resolve) => setTimeout(resolve, 10));
		expect(existsSync(dir)).toBe(false);
	});
});

describe("SCR-06 the removal note", () => {
	it("SCR-06 a removal records when and how much, and the prompt says so", async () => {
		await start();
		const id = await seedSession("idle", 9 * DAY_MS);
		fill(id, 64 * 1024);
		await sweepScratch(t!.runtime);
		const row = await removedColumns(id);
		expect(row?.scratch_removed_at).toBe(t!.clock.now());
		expect(row?.scratch_removed_bytes).toBeGreaterThanOrEqual(64 * 1024);

		const removed = { at: row!.scratch_removed_at!, bytes: row!.scratch_removed_bytes };
		const text = fillPrompt(promptTemplate(), { sessionUrl: "u", memoryPath: "m", domain: "d", scratchPath: "s", scratchRemoved: removed });
		expect(text).toContain(scratchNote(removed));
		expect(scratchNote({ at: Date.UTC(2026, 0, 5, 9, 0), bytes: 340 * 1024 * 1024 })).toBe(
			"Pana removed your scratch directory at 2026-01-05 09:00 UTC (340 MB) while you were idle. Its old files are gone; the directory you have now is new and empty.",
		);
	});
});

describe("SCR-07 prune and size", () => {
	it("SCR-07 pana scratch prune --dry-run lists without removing, and only the user may prune", async () => {
		await start();
		const id = await seedSession("idle", 9 * DAY_MS);
		const dir = fill(id);

		const refused = await command("scratch prune", {}, id);
		expect(refused.exitCode).toBe(1);
		expect(refused.status).toBe(403);

		const dry = await command("scratch prune", { dryRun: true });
		expect(dry.body).toMatchObject({ dryRun: true, removed: [{ session: id, reason: "idle" }] });
		expect(existsSync(dir)).toBe(true);
		expect((await removedColumns(id))?.scratch_removed_at).toBeNull();

		const real = await command("scratch prune", {});
		expect(real.body).toMatchObject({ dryRun: false, removed: [{ session: id, reason: "idle" }] });
		expect(existsSync(dir)).toBe(false);
	});

	it("SCR-07 session show includes the scratch path and size", async () => {
		await start();
		const id = await seedSession("idle");
		const dir = join(t!.runtime.paths.scratch, id);
		const none = await t!.client.get<{ session: { scratch: unknown } }>(`/sessions/${id}`);
		expect(none.body.session.scratch).toEqual({ path: dir, bytes: null });
		fill(id);
		const some = await t!.client.get<{ session: { scratch: { bytes: number } } }>(`/sessions/${id}`);
		expect(some.body.session.scratch.bytes).toBeGreaterThan(0);
	});
});
