// WP12: scale. The bench itself (scripts/bench) is not part of `npm test`; these tests run it at
// a small N and check what each SCALE item promises.

import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runPanaCli } from "../src/cli/commands.ts";
import { runBench, type BenchResult } from "./bench/bench.ts";
import { checkDatabase } from "./bench/checks.ts";
import { answerBody } from "./bench/model.ts";
import { startTestPanad, TEST_USER, type TestPanad } from "./harness/index.ts";
import { nextCursor, pagePath } from "../web/pages.js";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite");

const SMALL = { sessions: 4, threads: 6, messages: 2, broadcast: 2, fanout: 1, branch: 2, spawnDepth: 2, concurrency: 3, latencyMs: 2, listThreads: 30, listSamples: 3, pageSize: 7, timeoutMs: 30_000 };

describe("the bench", () => {
	let result: BenchResult;

	beforeAll(async () => {
		result = await runBench({ ...SMALL, keep: true });
	}, 120_000);

	afterAll(() => {
		if (result?.stateDir) rmSync(result.stateDir, { recursive: true, force: true });
	});

	it("SCALE-01 scripts/bench drives a real panad and reports throughput, latency per route, RSS, and database size", () => {
		expect(result.phases.map((phase) => phase.name)).toEqual(["sessions", "threads", "broadcast", "fan-out"]);
		for (const phase of result.phases) expect(phase.units).toBeGreaterThan(0);
		expect(result.phases.find((phase) => phase.name === "threads")!.perSecond).toBeGreaterThan(0);
		// 4 sessions, then one tree of 1 + 2 + 4 under spawnDepth 2.
		expect(result.options).toMatchObject({ sessions: 4, threads: 6, fanout: 1, spawnDepth: 2 });
		for (const route of ["sessions.create", "threads.create", "threads.respond"]) {
			expect(result.routes[route], route).toMatchObject({ failed: 0 });
			expect(result.routes[route]!.count).toBeGreaterThan(0);
			expect(result.routes[route]!.p99).toBeGreaterThanOrEqual(result.routes[route]!.p50);
		}
		expect(result.rssPeakMb).toBeGreaterThan(0);
		expect(result.dbBytes).toBeGreaterThan(0);
		expect(existsSync(join(result.stateDir!, "pana.sqlite"))).toBe(true);
	});

	it("SCALE-02 under the bench no request fails, every message is delivered exactly once, and every run posts its reply", () => {
		const failed = result.checks.filter((check) => !check.ok);
		expect(failed).toEqual([]);
		const names = result.checks.map((check) => check.name);
		expect(names).toContain("no request fails");
		expect(names).toContain("every message is delivered to every other participant");
		expect(names).toContain("every delivery to a session wakes it exactly once and settles");
		expect(names).toContain("every session run posts its reply exactly once");
		for (const check of result.checks) expect(check.checked, check.name).toBeGreaterThan(0);

		// The checks have teeth: a lost wake and a doubled answer both fail them.
		const dir = mkdtempSync(join(tmpdir(), "pana-scale-"));
		try {
			const copy = join(dir, "pana.sqlite");
			copyFileSync(join(result.stateDir!, "pana.sqlite"), copy);
			const db = new DatabaseSync(copy);
			const ask = db
				.prepare("SELECT m.id, m.thread_id, m.sender_id FROM messages m WHERE m.body LIKE 'bench reply %' LIMIT 1")
				.get() as { id: string; thread_id: string; sender_id: string };
			const answer = db.prepare("SELECT sender_id FROM messages WHERE body = ?").get(answerBody(ask.id)) as { sender_id: string };
			db.prepare("INSERT INTO messages (id, thread_id, seq, sender_id, body, created_at) VALUES (?, ?, 1000, ?, ?, 0)").run(
				"01J00000000000000000000000",
				ask.thread_id,
				answer.sender_id,
				answerBody(ask.id),
			);
			db.prepare("UPDATE deliveries SET wake_submission_id = NULL WHERE id = (SELECT d.id FROM deliveries d JOIN sessions s ON s.id = d.recipient_id LIMIT 1)").run();
			db.close();
			const broken = checkDatabase(copy).filter((check) => !check.ok).map((check) => check.name);
			expect(broken).toContain("every session run posts its reply exactly once");
			expect(broken).toContain("every delivery to a session wakes it exactly once and settles");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("SCALE-02 the bench pages every list route without repeating an item", () => {
		expect(result.lists.map((list) => list.route)).toEqual(["/inbox", "/threads", "/sessions", "/schedules"]);
		for (const list of result.lists) {
			expect(list.pageCount, list.route).toBe(Math.max(1, Math.ceil(list.total / SMALL.pageSize)));
		}
		expect(result.lists.find((list) => list.route === "/threads")!.total).toBe(SMALL.listThreads);
	});
});

describe("list pagination", () => {
	let t: TestPanad | undefined;
	afterEach(async () => {
		await t?.close();
		t = undefined;
	});

	interface Listed {
		id?: string;
		threadId?: string;
	}

	/** Every page of a list route, with the IDs in order. */
	async function walk(route: string, key: string, limit: number): Promise<{ ids: string[]; pages: number }> {
		const ids: string[] = [];
		let cursor: string | undefined;
		let pages = 0;
		do {
			const separator = route.includes("?") ? "&" : "?";
			const res = await t!.client.get<Record<string, unknown> & { nextCursor: string | null }>(
				`${route}${separator}limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
			);
			expect(res.status, JSON.stringify(res.body)).toBe(200);
			expect(res.body).toHaveProperty("nextCursor");
			const items = res.body[key] as Listed[];
			expect(items.length).toBeLessThanOrEqual(limit);
			ids.push(...items.map((item) => item.id ?? item.threadId!));
			cursor = res.body.nextCursor ?? undefined;
			pages++;
		} while (cursor !== undefined && pages < 100);
		return { ids, pages };
	}

	async function seed(): Promise<string[]> {
		t = await startTestPanad({ config: { defaultModel: "faux/faux-1" }, script: Array.from({ length: 6 }, () => ({ text: "ok" })) });
		const sessions: string[] = [];
		for (let i = 0; i < 6; i++) {
			const res = await t.client.post<{ session: { id: string } }>("/sessions", { prompt: `session ${i}` });
			expect(res.status).toBe(201);
			sessions.push(res.body.session.id);
			await t.clock.advance(1);
		}
		// Threads from a session to the user grow the user's inbox and wake nothing.
		for (let i = 0; i < 11; i++) {
			const res = await t.client.post("/threads", { to: [TEST_USER], body: `thread ${i}` }, { caller: sessions[i % sessions.length] });
			expect(res.status).toBe(201);
		}
		for (let i = 0; i < 8; i++) {
			const at = new Date(t.clock.now() + 3_600_000 * (8 - i)).toISOString();
			const res = await t.client.post("/schedules", { kind: "thread", at, to: [TEST_USER], body: `scheduled ${i}` });
			expect(res.status, JSON.stringify(res.body)).toBe(201);
		}
		return sessions;
	}

	it("SCALE-03 /inbox, /threads, /sessions, and /schedules page with limit and cursor, in the unpaged order, each item once", async () => {
		await seed();
		const lists: Array<[string, string]> = [
			["/inbox", "deliveries"],
			["/threads", "threads"],
			["/sessions", "sessions"],
			["/schedules", "schedules"],
		];
		for (const [route, key] of lists) {
			const whole = await t!.client.get<Record<string, Listed[]>>(`${route}?limit=500`);
			const expected = whole.body[key]!.map((item) => item.id ?? item.threadId!);
			expect(expected.length, route).toBeGreaterThan(5);
			const { ids, pages } = await walk(route, key, 4);
			expect(ids, route).toEqual(expected);
			expect(pages, route).toBe(Math.ceil(expected.length / 4));
		}

		// Filters page too: the sessions in one state, and a search by offset.
		const idle = await walk("/sessions?state=idle", "sessions", 4);
		expect(idle.ids).toHaveLength(6);
		const found = await walk("/threads?query=thread", "threads", 4);
		expect(new Set(found.ids).size).toBe(11);
	});

	it("SCALE-03 a cursor resumes after its item when new items arrive, and a bad cursor or limit is a 400", async () => {
		const sessions = await seed();
		const first = await t!.client.get<{ threads: Listed[]; nextCursor: string }>("/threads?limit=5");
		const seen = first.body.threads.map((thread) => thread.threadId!);
		// A newer thread lands while the client reads; the next page neither repeats nor skips.
		await t!.client.post("/threads", { to: [TEST_USER], body: "late" }, { caller: sessions[0] });
		const rest: string[] = [];
		let cursor: string | null = first.body.nextCursor;
		while (cursor) {
			const page: { status: number; body: { threads: Listed[]; nextCursor: string | null } } = await t!.client.get(
				`/threads?limit=5&cursor=${encodeURIComponent(cursor)}`,
			);
			rest.push(...page.body.threads.map((thread) => thread.threadId!));
			cursor = page.body.nextCursor;
		}
		expect(new Set([...seen, ...rest]).size).toBe(seen.length + rest.length);
		expect(seen.length + rest.length).toBe(6 + 11);

		for (const route of ["/inbox", "/threads", "/sessions", "/schedules"]) {
			const bad = await t!.client.get<{ error: { code: string } }>(`${route}?cursor=not-a-cursor`);
			expect(bad.status, route).toBe(400);
			expect(bad.body.error.code).toBe("invalid_cursor");
			const limit = await t!.client.get<{ error: { code: string } }>(`${route}?limit=0`);
			expect(limit.status, route).toBe(400);
			expect(limit.body.error.code).toBe("invalid_limit");
		}
	});

	it("SCALE-03 the archived and unread filters page, and the inbox counts unread deliveries past its page", async () => {
		await seed();
		const all = (await walk("/threads", "threads", 4)).ids;
		// Archive every third thread, and read one other, as the user.
		const archived = all.filter((_, i) => i % 3 === 0);
		for (const id of archived) expect((await t!.client.post(`/threads/${id}/archive`, {})).status).toBe(200);
		const read = all.find((id) => !archived.includes(id))!;
		expect((await t!.client.get(`/threads/${read}`)).status).toBe(200);

		const shown = await walk("/threads", "threads", 4);
		expect(shown.ids).toEqual(all.filter((id) => !archived.includes(id)));
		expect((await walk("/threads?archived=1", "threads", 4)).ids).toEqual(archived);
		const unread = await walk("/threads?unread=1", "threads", 4);
		expect(unread.ids).not.toContain(read);
		expect(unread.ids.every((id) => shown.ids.includes(id))).toBe(true);

		const inbox = await t!.client.get<{ deliveries: Array<{ readAt: number | null }>; unreadTotal: number }>("/inbox?limit=2");
		expect(inbox.body.deliveries).toHaveLength(2);
		const everything = await t!.client.get<{ deliveries: Array<{ readAt: number | null }> }>("/inbox?limit=500");
		expect(inbox.body.unreadTotal).toBe(everything.body.deliveries.filter((d) => d.readAt === null).length);
		expect(inbox.body.unreadTotal).toBeGreaterThan(2);
	});

	it("SCALE-03 the list commands take --limit and --cursor and print nextCursor", async () => {
		await seed();
		const endpoint = { endpoint: { socketPath: t!.panad.socketPath } };
		const commands: Array<[string[], string]> = [
			[["schedule", "list"], "schedules"],
			[["session", "search"], "sessions"],
			[["thread", "search", "--query", "thread"], "threads"],
		];
		for (const [argv, key] of commands) {
			const first = await runPanaCli([...argv, "--limit", "3"], endpoint);
			expect(first.exitCode, first.text).toBe(0);
			const body = first.body as Record<string, Listed[]> & { nextCursor: string };
			expect(body[key]).toHaveLength(3);
			expect(typeof body.nextCursor).toBe("string");
			const second = await runPanaCli([...argv, "--limit", "3", "--cursor", body.nextCursor], endpoint);
			expect(second.exitCode, second.text).toBe(0);
			const next = (second.body as Record<string, Listed[]>)[key]!.map((item) => item.id ?? item.threadId);
			expect(next.some((id) => body[key]!.some((item) => (item.id ?? item.threadId) === id))).toBe(false);
		}
		const sessions = (await t!.client.get<{ sessions: Array<{ id: string }> }>("/sessions")).body.sessions;
		const inbox = await runPanaCli(["session", "inbox", sessions[0]!.id, "--limit", "1"], endpoint);
		expect(inbox.exitCode, inbox.text).toBe(0);
		expect(inbox.body).toHaveProperty("nextCursor");
		const bad = await runPanaCli(["schedule", "list", "--limit", "none"], endpoint);
		expect(bad.exitCode).toBe(2);
	});

	it("SCALE-03 the PWA asks for pages and loads more while a list has a nextCursor", () => {
		expect(pagePath("/inbox", undefined)).toBe("/inbox?limit=50");
		expect(pagePath("/threads?query=a%20b", "CUR")).toBe("/threads?query=a+b&limit=50&cursor=CUR");
		expect(nextCursor({ nextCursor: "abc" })).toBe("abc");
		expect(nextCursor({ nextCursor: null })).toBeUndefined();
		const app = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
		for (const loader of ["loadInbox", "searchThreads", "loadSessionList", "loadSchedules"]) {
			const start = app.indexOf(`async function ${loader}(`);
			const body = app.slice(start, app.indexOf("\n}\n", start));
			// The inbox fetches through refreshUnread, which also sets the nav badge (REF-06).
			const fetcher = loader === "loadInbox" ? app.slice(app.indexOf("async function refreshUnread("), start) : body;
			expect(fetcher, loader).toContain("pagePath(");
			expect(body, loader).toContain("showMore(list, nextCursor(body)");
		}
	});
});

describe("BENCH.md", () => {
	it("SCALE-04 records the bench results on this machine, each bottleneck found, and its fix", () => {
		const bench = readFileSync(new URL("../BENCH.md", import.meta.url), "utf8");
		const section = (title: string) => {
			const start = bench.indexOf(`\n## ${title}\n`);
			expect(start, title).toBeGreaterThan(0);
			const end = bench.indexOf("\n## ", start + 1);
			return bench.slice(start, end < 0 ? undefined : end);
		};
		expect(section("Machine")).toMatch(/Node \d+/);

		const results = section("Results");
		expect(results).toContain("N=200, M=1000, K=5");
		expect(results).toContain("10,000 threads");
		expect(results).toMatch(/\| Phase \| Before \| After \|/);
		for (const phase of ["sessions", "threads", "broadcast", "fan-out"]) expect(results).toMatch(new RegExp(`\\| ${phase}: `));
		for (const list of ["/inbox", "/threads", "/sessions", "/schedules"]) expect(results).toContain(`| \`${list}\` |`);
		for (const metric of ["RSS", "Live heap", "Database"]) expect(results).toContain(metric);

		const fixes = section("Bottlenecks and fixes");
		expect(fixes).toMatch(/\| # \| Bottleneck \| Evidence \| Fix \|/);
		const rows = fixes.split("\n").filter((line) => /^\| \d+ \|/.test(line));
		expect(rows.length).toBeGreaterThanOrEqual(4);
		for (const row of rows) expect(row.split("|").filter((cell) => cell.trim()).length, row).toBe(4);
	});
});
