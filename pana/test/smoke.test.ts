// INT-05: scripts/smoke, in its faux-model mode and without provider keys. The coordinator runs
// it with real keys; these runs prove the script itself.

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const smoke = fileURLToPath(new URL("../scripts/smoke", import.meta.url));

const dirs: string[] = [];
const pids: number[] = [];
afterEach(async () => {
	for (const pid of pids.splice(0)) {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			// Already gone.
		}
		// Not our child, so there is no exit event: poll until it is gone before removing its state.
		for (let i = 0; i < 50 && alive(pid); i++) await new Promise((resolve) => setTimeout(resolve, 100));
	}
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

interface Run {
	code: number;
	stdout: string;
	stderr: string;
}

/** Run the script with only the variables given, so no provider key leaks in from this shell. */
function run(args: string[], extra: Record<string, string>): Promise<Run> {
	const env = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: temp("pana-smoke-home-"),
		LANG: "C.UTF-8",
		USER: "Tester",
		TMPDIR: temp("pana-smoke-tmp-"),
		...extra,
	};
	return new Promise((resolve) => {
		execFile(smoke, args, { env, timeout: 60_000 }, (error, stdout, stderr) => {
			resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
		});
	});
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("scripts/smoke", () => {
	it("INT-05 in faux mode, a session answers and the script prints the thread and the PWA URL, then cleans up", { timeout: 60_000 }, async () => {
		const tmp = temp("pana-smoke-tmp-");
		const result = await run([], { PANA_SMOKE_FAUX: "1", TMPDIR: tmp });
		expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(result.stdout).toContain("model: faux/faux-1");
		expect(result.stdout).toMatch(/session: pana:\/\/smoke\.example\/sessions\/[0-9A-Z]{26}/);
		expect(result.stdout).toContain("pana://smoke.example/users/tester:\nWhat is the capital of France? Answer in one word.");
		expect(result.stdout).toMatch(/pana:\/\/smoke\.example\/sessions\/[0-9A-Z]{26}:\nParis/);
		expect(result.stdout).toMatch(/PWA: http:\/\/localhost:\d+\/#[A-Za-z0-9_-]{20,}/);
		expect(result.stdout).toContain("smoke: ok");
		expect(readdirSync(tmp).filter((name) => name.startsWith("pana-smoke."))).toEqual([]);
	});

	it("INT-05 --keep leaves panad running on its state directory", { timeout: 60_000 }, async () => {
		const result = await run(["--keep"], { PANA_SMOKE_FAUX: "1" });
		expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
		const match = /panad is still running \(pid (\d+)\) on (\S+)/.exec(result.stdout);
		expect(match, result.stdout).not.toBeNull();
		const pid = Number(match![1]);
		pids.push(pid);
		dirs.push(match![2]!);
		expect(alive(pid)).toBe(true);
		expect(existsSync(join(match![2]!, "panad.sock"))).toBe(true);
	});

	it("INT-05 without the provider's key, the script fails fast and names the missing provider", { timeout: 60_000 }, async () => {
		const result = await run([], { PANA_SMOKE_TIMEOUT: "5" });
		expect(result.code).toBe(1);
		expect(result.stdout).toContain("panad: model providers: none");
		expect(result.stderr).toContain("no fireworks provider");
		expect(result.stderr).toContain("is the provider key for fireworks in this environment?");
	});
});
