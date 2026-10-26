import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, DEFAULTS, loadConfig, stateDir } from "../src/config/index.ts";
import { makeStateDir, startTestPanad, TEST_DOMAIN, TEST_USER, type TestPanad } from "./harness/index.ts";

const PANAD = join(import.meta.dirname, "..", "bin", "panad");

/** Run the real bin/panad and collect its exit code and stderr. */
function runPanad(dir: string, timeoutMs = 10_000): Promise<{ code: number | null; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [PANAD], {
			env: { PATH: process.env.PATH, HOME: dir, PANA_STATE: dir },
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`panad did not exit: ${stderr}`));
		}, timeoutMs);
		child.on("exit", (code) => {
			clearTimeout(timer);
			resolve({ code, stderr });
		});
	});
}

const dirs: string[] = [];
let t: TestPanad | undefined;
afterEach(async () => {
	await t?.close();
	t = undefined;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempConfig(config: Record<string, unknown>): string {
	const dir = makeStateDir({}, config);
	dirs.push(dir);
	return dir;
}

describe("config and state", () => {
	it("CFG-01 panad reads config.json from ~/.local/state/pana, and PANA_STATE overrides the state directory", () => {
		const saved = process.env.PANA_STATE;
		try {
			delete process.env.PANA_STATE;
			expect(stateDir()).toBe(join(homedir(), ".local", "state", "pana"));
			const dir = tempConfig({ domain: TEST_DOMAIN, user: TEST_USER });
			process.env.PANA_STATE = dir;
			expect(stateDir()).toBe(dir);
			expect(loadConfig().domain).toBe(TEST_DOMAIN);
		} finally {
			if (saved === undefined) delete process.env.PANA_STATE;
			else process.env.PANA_STATE = saved;
		}
	});

	it("CFG-02 config.json requires domain and user, and panad exits 2 naming the missing key", async () => {
		const noDomain = tempConfig({ user: TEST_USER });
		const noUser = tempConfig({ domain: TEST_DOMAIN });
		expect(() => loadConfig(noDomain)).toThrow(/missing required key: domain/);
		expect(() => loadConfig(noUser)).toThrow(/missing required key: user/);
		try {
			loadConfig(noUser);
		} catch (error) {
			expect((error as ConfigError).exitCode).toBe(2);
		}

		const run = await runPanad(noDomain);
		expect(run.code).toBe(2);
		expect(run.stderr).toContain("domain");
		const run2 = await runPanad(noUser);
		expect(run2.code).toBe(2);
		expect(run2.stderr).toContain("user");
	});

	it("CFG-03 optional keys take documented defaults and accept overrides", () => {
		const defaults = loadConfig(tempConfig({ domain: TEST_DOMAIN, user: TEST_USER }));
		expect(defaults).toEqual({
			domain: TEST_DOMAIN,
			user: TEST_USER,
			timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
			subjectModel: undefined,
			defaultModel: undefined,
			spawnDepth: 3,
			budget: { sessionUsd: 100, domainDailyUsd: 500 },
			files: { maxBytes: 26214400 },
			http: { port: 8766 },
		});
		expect(DEFAULTS.files.maxBytes).toBe(25 * 1024 * 1024);

		const custom = loadConfig(
			tempConfig({
				domain: TEST_DOMAIN,
				user: TEST_USER,
				timezone: "America/Chicago",
				subjectModel: "faux/faux-1",
				defaultModel: "faux/faux-1",
				spawnDepth: 1,
				budget: { sessionUsd: 5 },
				files: { maxBytes: 10 },
				http: { port: 9000 },
			}),
		);
		expect(custom).toMatchObject({
			timezone: "America/Chicago",
			subjectModel: "faux/faux-1",
			defaultModel: "faux/faux-1",
			spawnDepth: 1,
			budget: { sessionUsd: 5, domainDailyUsd: 500 },
			files: { maxBytes: 10 },
			http: { port: 9000 },
		});
	});

	it("CFG-04 panad creates the state layout on first start, with web-token at mode 0600", async () => {
		t = await startTestPanad();
		for (const path of ["pana.sqlite", "files", "memory.git", "memory/worktrees", "profiles/default.json", "hooks", "web-token"]) {
			expect(existsSync(join(t.dir, path)), path).toBe(true);
		}
		expect(statSync(join(t.dir, "files")).isDirectory()).toBe(true);
		expect(statSync(join(t.dir, "web-token")).mode & 0o777).toBe(0o600);
		expect(readFileSync(join(t.dir, "web-token"), "utf8").length).toBeGreaterThanOrEqual(32);
		expect(JSON.parse(readFileSync(join(t.dir, "profiles/default.json"), "utf8"))).toEqual({});

		// A second start keeps the existing token.
		const token = readFileSync(join(t.dir, "web-token"), "utf8");
		await t.stop();
		const again = await startTestPanad({ stateDir: t.dir });
		expect(readFileSync(join(t.dir, "web-token"), "utf8")).toBe(token);
		await again.stop();
	});

	it("CFG-05 a second panad on the same state directory exits 1 naming the running PID", async () => {
		t = await startTestPanad();
		await expect(startTestPanad({ stateDir: t.dir })).rejects.toThrow(`panad is already running (pid ${process.pid})`);

		const run = await runPanad(t.dir);
		expect(run.code).toBe(1);
		expect(run.stderr).toContain(`pid ${process.pid}`);

		// The first panad still serves.
		expect((await t.client.get("/inbox")).status).toBe(501);
	});

	it("CFG-05 a stale PID file from a dead panad does not block a start", async () => {
		t = await startTestPanad();
		const pidFile = join(t.dir, "panad.pid");
		await t.stop();
		// A PID that cannot be alive.
		writeFileSync(pidFile, "999999999\n");
		const again = await startTestPanad({ stateDir: t.dir });
		expect(readFileSync(pidFile, "utf8").trim()).toBe(String(process.pid));
		await again.stop();
	});
});
