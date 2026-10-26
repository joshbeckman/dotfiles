import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import type { ConversationId } from "@earendil-works/pi-durable";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError } from "../src/config/index.ts";
import { MIGRATIONS, migrate, openSharedDatabase, PanaDatabase, SCHEMA_VERSION, SimulatedCrash, sweepWakes } from "../src/db/index.ts";
import type { WakeSubmitter } from "../src/db/outbox.ts";
import { startTestPanad, TEST_DOMAIN, TEST_USER, type TestPanad } from "./harness/index.ts";
import { appendAndWake, seedThread, type Appended, type Fixture } from "./harness/wake-fixture.ts";

const PANA_TABLES = [
	"participants",
	"sessions",
	"threads",
	"thread_participants",
	"messages",
	"message_events",
	"deliveries",
	"files",
	"schedules",
	"push_subscriptions",
	"subjects",
];

const opened: TestPanad[] = [];
const dirs: string[] = [];
afterEach(async () => {
	for (const t of opened.splice(0)) await t.close().catch(() => {});
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function start(options: Parameters<typeof startTestPanad>[0] = {}): Promise<TestPanad> {
	const t = await startTestPanad(options);
	opened.push(t);
	return t;
}

async function seed(t: TestPanad, count = 1): Promise<Fixture> {
	const { db, harness, newId, clock } = t.runtime;
	return seedThread(db, harness, newId, clock.now(), { domain: TEST_DOMAIN, user: TEST_USER, count });
}

function append(t: TestPanad, fixture: Fixture, submit: WakeSubmitter = t.runtime.wake, onPlanned?: (a: Appended) => void) {
	const { db, newId, clock } = t.runtime;
	return appendAndWake(db, fixture, newId, clock.now(), "hello", submit, onPlanned);
}

/** What survived of one append, read through a fresh connection as a restarted panad would. */
async function survivors(path: string, fixture: Fixture, appended: Appended) {
	const { db, storage } = await openSharedDatabase(path);
	try {
		const message = await db.get("SELECT id FROM messages WHERE id = ?", appended.messageId);
		const deliveries = await db.all("SELECT id FROM deliveries WHERE message_id = ?", appended.messageId);
		const thread = await db.get("SELECT id FROM threads WHERE id = ?", fixture.threadId);
		const submissions = [];
		for (const [i, wake] of appended.wakes.entries()) {
			const conversationId = fixture.sessions[i]!.conversationId as ConversationId;
			const found = await storage.submissionByRequest(conversationId, wake.requestId, ctx);
			if (found) submissions.push(found);
		}
		return { message, deliveries: deliveries.length, submissions: submissions.length, thread };
	} finally {
		await storage.close(ctx);
	}
}

function runChild(dir: string, mode: string): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
	const script = join(import.meta.dirname, "fixtures", "crash-child.ts");
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [script, dir, mode], { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
		child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
		child.on("error", reject);
		child.on("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
	});
}

describe("schema", () => {
	it("DB-01 pi-durable and pana share one pana.sqlite through one adapter, and pi-durable tables use the pi_ prefix", async () => {
		const t = await start({ script: [{ text: "ok" }] });
		const { db, harness } = t.runtime;
		const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" } } }, ctx);
		await (await conversation.submit({ type: "input", content: "hi" }, ctx)).wait(ctx);

		const tables = (await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")).map((r) => r.name);
		const pi = tables.filter((name) => name.startsWith("pi_"));
		expect(pi).toEqual(expect.arrayContaining(["pi_conversations", "pi_entries", "pi_submissions", "pi_tasks"]));
		// Every table is pana's, pi-durable's under pi_, or an FTS5 shadow table.
		const other = tables.filter((name) => !name.startsWith("pi_") && !PANA_TABLES.includes(name) && !/_fts(_\w+)?$/.test(name));
		expect(other).toEqual([]);

		// pi-durable's writes are visible through pana's adapter, because it is the same one.
		const row = await db.get<{ n: number }>("SELECT count(*) AS n FROM pi_submissions");
		expect(row?.n).toBe(1);
		expect(t.runtime.db).toBeInstanceOf(PanaDatabase);
		expect(readdirSync(t.dir).filter((name) => name.endsWith(".sqlite"))).toEqual(["pana.sqlite"]);
	});

	it("DB-02 pana creates every listed table plus the FTS5 tables messages_fts and sessions_fts", async () => {
		const t = await start();
		const rows = await t.runtime.db.all<{ name: string; sql: string }>("SELECT name, sql FROM sqlite_master WHERE type = 'table'");
		const names = rows.map((r) => r.name);
		for (const table of PANA_TABLES) expect(names, table).toContain(table);
		for (const fts of ["messages_fts", "sessions_fts"]) {
			const row = rows.find((r) => r.name === fts);
			expect(row?.sql, fts).toMatch(/USING fts5/i);
		}
	});

	it("DB-03 migrations are numbered, run at startup, and are idempotent", async () => {
		expect(MIGRATIONS.map((m) => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1));
		expect(SCHEMA_VERSION).toBe(MIGRATIONS.length);

		const t = await start();
		expect(await t.runtime.db.get("PRAGMA user_version")).toEqual({ user_version: SCHEMA_VERSION });
		expect(await migrate(t.runtime.db)).toBe(SCHEMA_VERSION);
		await t.stop();
		const again = await start({ stateDir: t.dir });
		expect(await again.runtime.db.get("PRAGMA user_version")).toEqual({ user_version: SCHEMA_VERSION });
	});

	it("DB-03 a database newer than the code refuses to open with exit code 1", async () => {
		const t = await start();
		await t.runtime.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
		await t.stop();

		let caught: unknown;
		try {
			await startTestPanad({ stateDir: t.dir });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ConfigError);
		expect((caught as ConfigError).exitCode).toBe(1);
		expect((caught as Error).message).toMatch(/newer than this build/);

		// The refused open leaves the lock free and the file unchanged.
		const raw = await openNodeSqliteDatabase(join(t.dir, "pana.sqlite"));
		expect(await raw.get("PRAGMA user_version")).toEqual({ user_version: SCHEMA_VERSION + 1 });
		await raw.close();
	});
});

describe("DB-04 atomic append and wake", () => {
	it("DB-04 a message insert, its deliveries, and the pi-durable submission commit in one transaction", async () => {
		const t = await start({ script: [{ text: "ok" }] });
		const fixture = await seed(t);
		const seen: string[] = [];
		t.runtime.db.faults = (sql) => seen.push(sql);
		const appended = await append(t, fixture);
		t.runtime.db.faults = undefined;

		// The pi-durable commit ran as a savepoint inside pana's transaction, not as its own transaction.
		expect(seen.some((sql) => sql.startsWith("SAVEPOINT pana_sp_"))).toBe(true);
		expect(seen.at(-1)).toBe("COMMIT");
		expect(seen.filter((sql) => /^\s*INSERT INTO messages/.test(sql))).toHaveLength(1);

		const delivery = await t.runtime.db.get<{ wake_submission_id: number }>(
			"SELECT wake_submission_id FROM deliveries WHERE id = ?",
			appended.wakes[0]!.deliveryId,
		);
		expect(delivery?.wake_submission_id).toBeTypeOf("number");
		const submission = await t.runtime.harness.submission(delivery!.wake_submission_id as never, ctx);
		expect((await submission!.wait(ctx)).status).toBe("done");
	});

	it("DB-04 a crash injected between any two statements leaves none of them", async () => {
		// Learn the statement count of one append on a throwaway panad.
		const probe = await start({ script: [{ text: "ok" }] });
		const probeFixture = await seed(probe);
		let count = 0;
		probe.runtime.db.faults = (_sql, index) => (count = index + 1);
		await append(probe, probeFixture);
		probe.runtime.db.faults = undefined;
		expect(count).toBeGreaterThan(5);

		for (let k = 0; k < count; k++) {
			const t = await start({ script: [{ text: "ok" }] });
			const fixture = await seed(t);
			let planned: Appended | undefined;
			t.runtime.db.faults = (sql, index) => {
				if (index === k) throw new SimulatedCrash(index, sql);
			};
			await expect(append(t, fixture, t.runtime.wake, (a) => (planned = a)), `crash at ${k}`).rejects.toBeInstanceOf(SimulatedCrash);
			expect(t.fatal, `crash at ${k}`).toEqual([]);
			await t.stop().catch(() => {});

			const left = await survivors(join(t.dir, "pana.sqlite"), fixture, planned!);
			expect(left, `crash at ${k}`).toEqual({ message: undefined, deliveries: 0, submissions: 0, thread: { id: fixture.threadId } });
		}
	});

	it("DB-04 a real SIGKILL before COMMIT, after pi-durable's commit joined, leaves none of them", async () => {
		const countDir = mkdtempSync(join(tmpdir(), "pana-crash-"));
		dirs.push(countDir);
		const counted = await runChild(countDir, "count");
		expect(counted.code, counted.stderr).toBe(0);
		const statements: string[] = JSON.parse(counted.stdout).statements;
		const afterJoin = statements.findIndex((sql) => sql.startsWith("RELEASE pana_sp_")) + 1;
		expect(afterJoin).toBeGreaterThan(0);

		for (const k of [0, afterJoin, statements.length - 1]) {
			const dir = mkdtempSync(join(tmpdir(), "pana-crash-"));
			dirs.push(dir);
			const run = await runChild(dir, String(k));
			expect(run.signal, `${run.stderr} at ${k}`).toBe("SIGKILL");
			const plan = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8"));
			const left = await survivors(join(dir, "pana.sqlite"), plan.fixture, plan.appended);
			expect(left, `kill at ${k} (${statements[k]})`).toEqual({ message: undefined, deliveries: 0, submissions: 0, thread: { id: plan.fixture.threadId } });
		}
	});

	it("DB-04 an error after a wake joined commits the rest, and the startup sweep finishes the wake exactly once", async () => {
		const t = await start({ script: [{ text: "one" }, { text: "two" }] });
		const fixture = await seed(t, 2);
		let failed = false;
		const flaky: WakeSubmitter = async (wake) => {
			if (wake.recipientId === fixture.sessions[1]!.id && !failed) {
				failed = true;
				throw new Error("provider unavailable");
			}
			return t.runtime.wake(wake);
		};
		let planned: Appended | undefined;
		await expect(append(t, fixture, flaky, (a) => (planned = a))).rejects.toThrow("provider unavailable");
		expect(t.fatal).toEqual([]);

		const rows = await t.runtime.db.all<{ recipient_id: string; wake_submission_id: number | null }>(
			"SELECT recipient_id, wake_submission_id FROM deliveries WHERE message_id = ? ORDER BY id",
			planned!.messageId,
		);
		expect(rows).toHaveLength(2);
		expect(rows[0]!.wake_submission_id).toBeTypeOf("number");
		expect(rows[1]!.wake_submission_id).toBeNull();
		await t.stop();

		// Restart: the startup sweep submits the pending wake.
		const again = await start({ stateDir: t.dir, script: [{ text: "two" }] });
		const swept = await again.runtime.db.get<{ wake_submission_id: number | null }>(
			"SELECT wake_submission_id FROM deliveries WHERE id = ?",
			planned!.wakes[1]!.deliveryId,
		);
		expect(swept?.wake_submission_id).toBeTypeOf("number");
		expect(again.reports).toEqual([]);

		// Sweeping again submits nothing, and a repeated requestId finds the same submission.
		expect(await sweepWakes(again.runtime.db, again.runtime.wake)).toBe(0);
		const resubmitted = await again.runtime.wake(planned!.wakes[1]!);
		expect(resubmitted).toBe(swept!.wake_submission_id);
	});
});
