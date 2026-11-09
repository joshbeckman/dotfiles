// OBS-06: the request log and the client log rotate instead of growing forever, and the reader
// reads across the files rotation leaves behind (OBS-01), so a window that spans a rotation is
// still one history rather than a hole.
//
// The unit tests drive the writer and the reader on files this test owns. The route tests drive a
// real in-process panad with a tiny `logs.maxBytes`, because the point is that a daemon rotating
// every few requests still answers one continuous summary.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/index.ts";
import { RotatingLog } from "../src/logs/index.ts";
import { readLogTail } from "../src/stats/index.ts";
import { startTestPanad, TEST_DOMAIN, TEST_USER, type TestPanad } from "./harness/index.ts";

let t: TestPanad | undefined;
let dirs: string[] = [];
afterEach(async () => {
	await t?.close();
	t = undefined;
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	dirs = [];
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pana-logs-"));
	dirs.push(dir);
	return dir;
}

/** A log line of a known size, shaped like the request log's own lines. */
function line(n: number): string {
	return `${JSON.stringify({ n })}\n`;
}

/** The `n` values in a file, in order. */
function numbersIn(path: string): number[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((text) => (JSON.parse(text) as { n: number }).n);
}

describe("rotation", () => {
	it("renames the file at the limit and starts a new one, losing no line", () => {
		const dir = tempDir();
		const path = join(dir, "panad.log");
		const size = Buffer.byteLength(line(1));
		const log = new RotatingLog({ path, maxBytes: size * 2, keep: 2 });
		for (const n of [1, 2, 3]) log.append(line(n));
		expect(numbersIn(path)).toEqual([3]);
		expect(numbersIn(`${path}.1`)).toEqual([1, 2]);
		expect(existsSync(`${path}.2`)).toBe(false);
	});

	it("shifts older files up and drops the one past keep", () => {
		const dir = tempDir();
		const path = join(dir, "panad.log");
		const size = Buffer.byteLength(line(1));
		const log = new RotatingLog({ path, maxBytes: size, keep: 2 });
		for (const n of [1, 2, 3, 4]) log.append(line(n));
		expect(numbersIn(path)).toEqual([4]);
		expect(numbersIn(`${path}.1`)).toEqual([3]);
		expect(numbersIn(`${path}.2`)).toEqual([2]);
		expect(existsSync(`${path}.3`)).toBe(false);
	});

	it("keeps one growing file when maxBytes is 0", () => {
		const dir = tempDir();
		const path = join(dir, "panad.log");
		const log = new RotatingLog({ path, maxBytes: 0, keep: 2 });
		for (const n of [1, 2, 3, 4, 5]) log.append(line(n));
		expect(numbersIn(path)).toEqual([1, 2, 3, 4, 5]);
		expect(existsSync(`${path}.1`)).toBe(false);
	});

	it("writes a line bigger than the limit rather than rotating forever", () => {
		const dir = tempDir();
		const path = join(dir, "panad.log");
		const log = new RotatingLog({ path, maxBytes: 4, keep: 1 });
		log.append(line(1));
		log.append(line(2));
		expect(numbersIn(path)).toEqual([2]);
		expect(numbersIn(`${path}.1`)).toEqual([1]);
	});

	it("counts the file it finds, so a restart does not reset the size", () => {
		const dir = tempDir();
		const path = join(dir, "panad.log");
		const size = Buffer.byteLength(line(1));
		writeFileSync(path, line(1) + line(2));
		// The budget is already spent on disk: the next line rotates before it is written.
		const log = new RotatingLog({ path, maxBytes: size * 2, keep: 1 });
		log.append(line(3));
		expect(numbersIn(path)).toEqual([3]);
		expect(numbersIn(`${path}.1`)).toEqual([1, 2]);
	});

	it("reports a write it could not make instead of throwing", () => {
		const errors: unknown[] = [];
		const log = new RotatingLog({ path: join(tempDir(), "missing", "panad.log"), maxBytes: 0, keep: 1, onError: (error) => errors.push(error) });
		expect(() => log.append(line(1))).not.toThrow();
		expect(errors).toHaveLength(1);
	});
});

describe("reading across a rotation", () => {
	it("reads the rotated file, then the active one, oldest first", async () => {
		const dir = tempDir();
		const path = join(dir, "panad.log");
		writeFileSync(`${path}.1`, line(1) + line(2));
		writeFileSync(path, line(3));
		const tail = await readLogTail(path);
		expect(tail.lines).toHaveLength(3);
		expect(tail.lines.map((text) => (JSON.parse(text) as { n: number }).n)).toEqual([1, 2, 3]);
		expect(tail.truncated).toBe(false);
	});

	it("reads the rotation the writer made", async () => {
		const dir = tempDir();
		const path = join(dir, "panad.log");
		const size = Buffer.byteLength(line(1));
		const log = new RotatingLog({ path, maxBytes: size * 2, keep: 3 });
		for (const n of [1, 2, 3, 4, 5]) log.append(line(n));
		const tail = await readLogTail(path);
		expect(tail.lines.map((text) => (JSON.parse(text) as { n: number }).n)).toEqual([1, 2, 3, 4, 5]);
		expect(tail.truncated).toBe(false);
	});

	it("says it truncated when the cap ends at a file boundary and older files remain", async () => {
		const dir = tempDir();
		const path = join(dir, "panad.log");
		writeFileSync(`${path}.1`, line(1) + line(2));
		writeFileSync(path, line(3));
		const tail = await readLogTail(path, Buffer.byteLength(line(3)));
		expect(tail.lines.map((text) => (JSON.parse(text) as { n: number }).n)).toEqual([3]);
		expect(tail.truncated).toBe(true);
	});

	it("drops the half line the cap cut and says it truncated", async () => {
		const dir = tempDir();
		const path = join(dir, "panad.log");
		writeFileSync(`${path}.1`, line(1) + line(2));
		writeFileSync(path, line(3));
		const tail = await readLogTail(path, Buffer.byteLength(line(3)) + 4);
		expect(tail.truncated).toBe(true);
		expect(tail.lines.map((text) => (JSON.parse(text) as { n: number }).n)).toEqual([3]);
	});

	it("is empty for a log that was never written", async () => {
		const tail = await readLogTail(join(tempDir(), "panad.log"));
		expect(tail).toEqual({ lines: [], bytes: 0, truncated: false });
	});
});

describe("logs.maxBytes and logs.keep", () => {
	it("default to 4 MiB and two files", () => {
		const config = parseConfig({ domain: TEST_DOMAIN, user: TEST_USER });
		expect(config.logs).toEqual({ maxBytes: 4 * 1024 * 1024, keep: 2 });
	});

	it("take 0 to turn rotation off, and refuse a negative size", () => {
		expect(parseConfig({ domain: TEST_DOMAIN, user: TEST_USER, logs: { maxBytes: 0 } }).logs.maxBytes).toBe(0);
		expect(() => parseConfig({ domain: TEST_DOMAIN, user: TEST_USER, logs: { maxBytes: -1 } })).toThrow(/logs.maxBytes/);
		expect(() => parseConfig({ domain: TEST_DOMAIN, user: TEST_USER, logs: { maxBytes: 1.5 } })).toThrow(/logs.maxBytes/);
	});

	it("refuse keep below 1, because a rotation always keeps a file", () => {
		expect(() => parseConfig({ domain: TEST_DOMAIN, user: TEST_USER, logs: { keep: 0 } })).toThrow(/logs.keep/);
		expect(parseConfig({ domain: TEST_DOMAIN, user: TEST_USER, logs: { keep: 5 } }).logs.keep).toBe(5);
	});
});

describe("a running panad that rotates", () => {
	it("rotates the request log and still summarizes every request in the window", async () => {
		// Small enough to rotate several times over forty requests, large enough that every file
		// the reader can reach is still on disk: the window must be continuous across all of them.
		t = await startTestPanad({ config: { defaultModel: "faux/faux-1", timezone: "UTC", logs: { maxBytes: 1500, keep: 20 } } });
		for (let index = 0; index < 40; index++) await t.client.get("/inbox");
		const log = t.runtime.paths.log;
		expect(existsSync(`${log}.1`), "the log rotated").toBe(true);
		expect(existsSync(`${log}.2`), "it rotated more than once").toBe(true);
		expect(readFileSync(log, "utf8").length).toBeLessThanOrEqual(1500);
		const summary = await t.client.get<{ window: { count: number; truncated: boolean }; overall: { count: number } }>("/stats/requests");
		expect(summary.status).toBe(200);
		expect(summary.body.overall.count).toBe(40);
		expect(summary.body.window.truncated).toBe(false);
	});

	it("rotates the client log and reads both files back", async () => {
		t = await startTestPanad({ config: { defaultModel: "faux/faux-1", timezone: "UTC", logs: { maxBytes: 300, keep: 20 } } });
		const body = { samples: [{ kind: "api", name: "GET /inbox", durationMs: 5, status: 200 }] };
		for (let index = 0; index < 12; index++) await t.client.post("/stats/client", body);
		expect(existsSync(`${t.runtime.paths.clientLog}.1`), "the client log rotated").toBe(true);
		const summary = await t.client.get<{ client: { window: { count: number }; groups: Array<{ count: number }> } }>("/stats/requests");
		expect(summary.body.client.window.count).toBe(12);
		expect(summary.body.client.groups[0]?.count).toBe(12);
	});
});
