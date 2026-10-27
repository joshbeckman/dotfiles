// INT-04: the whole system through its real entry points. A real `panad` child process runs a
// scripted faux model, and the test drives it only through the `pana` binary, as a person or an
// agent would. The session's model calls `bash`, which runs the same `pana` binary.

import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import type { Script } from "./harness/index.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const panaBin = join(root, "bin", "pana");
const fixture = join(root, "test", "fixtures", "faux-panad.ts");
const DOMAIN = "test.example";

const dirs: string[] = [];
let panad: ChildProcess | undefined;

afterEach(async () => {
	if (panad && panad.exitCode === null) {
		const exited = new Promise((resolve) => panad!.once("exit", resolve));
		panad.kill("SIGTERM");
		await exited;
	}
	panad = undefined;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

interface Env {
	PATH: string;
	HOME: string;
	PANA_STATE: string;
	LANG: string;
}

interface CliResult {
	code: number;
	json: any;
	stderr: string;
}

/** Run `pana` as a subprocess. Its stdout is a pipe, so it prints JSON (CLI-03). */
function pana(env: Env, args: string[]): Promise<CliResult> {
	return new Promise((resolve) => {
		execFile(panaBin, args, { env: { ...env }, cwd: env.HOME }, (error, stdout, stderr) => {
			const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
			let json: unknown;
			try {
				json = stdout ? JSON.parse(stdout) : undefined;
			} catch {
				json = stdout;
			}
			resolve({ code, json, stderr });
		});
	});
}

async function until<T>(check: () => Promise<T | undefined | false>, what: string, timeoutMs = 30_000): Promise<T> {
	const end = Date.now() + timeoutMs;
	for (;;) {
		const value = await check();
		if (value) return value;
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

it("INT-04 a session created from the CLI uses bash, pana memory, and git, then answers and wakes again", { timeout: 90_000 }, async () => {
	const state = tempDir("pana-e2e-state-");
	const home = tempDir("pana-e2e-home-");
	const repo = tempDir("pana-e2e-repo-");
	const env: Env = {
		PATH: `${join(root, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
		HOME: home,
		PANA_STATE: state,
		LANG: "C.UTF-8",
	};
	writeFileSync(
		join(state, "config.json"),
		JSON.stringify({ domain: DOMAIN, user: "tester", defaultModel: "faux/faux-1", timezone: "UTC", http: { port: 0 } }),
	);
	const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { env: { ...env }, encoding: "utf8" });
	git("init", "-q");
	git("config", "user.name", "tester");
	git("config", "user.email", `tester@${DOMAIN}`);
	git("config", "commit.gpgsign", "false");

	// The model's first turn is one bash call: find the memory worktree with `pana memory`, write
	// a file, commit memory, and make a commit in the session's repo. `pana` prints JSON in bash,
	// because its stdout is not a TTY.
	const command = [
		"set -eu",
		`wt=$(pana memory | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>console.log(JSON.parse(s).path))')`,
		`printf '# Capitals\\n\\nParis is the capital of France.\\n' > "$wt/capitals.md"`,
		`pana memory commit -m "Remember the capital of France" >/dev/null`,
		"echo Paris > answer.txt",
		"git add answer.txt",
		`git commit -q -m "Record the answer"`,
		"echo done",
	].join("\n");
	const script: Script = [
		{ toolCalls: [{ name: "bash", args: { command } }] },
		{ text: "Paris. I saved it to memory." },
		{ text: "You're welcome." },
	];
	const scriptPath = join(state, "faux-script.json");
	writeFileSync(scriptPath, JSON.stringify(script));

	let log = "";
	panad = spawn(process.execPath, [fixture], {
		env: { ...env, PANA_FAUX_SCRIPT: scriptPath },
		cwd: home,
		stdio: ["ignore", "pipe", "pipe"],
	});
	panad.stdout!.on("data", (chunk: Buffer) => (log += chunk.toString()));
	panad.stderr!.on("data", (chunk: Buffer) => (log += chunk.toString()));
	await until(async () => log.includes("panad: listening") || panad!.exitCode !== null, "panad to listen");
	expect(log, log).toContain("panad: listening");
	expect(existsSync(join(state, "panad.sock"))).toBe(true);

	const created = await pana(env, ["session", "create", "--prompt", "What is the capital of France?", "--cwd", repo]);
	expect(created.code, created.stderr).toBe(0);
	const sessionId: string = created.json.session.id;
	const sessionUrl = `pana://${DOMAIN}/sessions/${sessionId}`;
	const threadId: string = created.json.thread.id;
	expect(created.json.session.model).toBe("faux/faux-1");

	// The answer is posted to the thread as a message from the session.
	const first = await until(async () => {
		const read = await pana(env, ["thread", "read", threadId]);
		return read.code === 0 && read.json.messages.length >= 2 ? read.json.messages : undefined;
	}, `the answer\n${log}`);
	expect(first.map((m: any) => m.sender.url)).toEqual([`pana://${DOMAIN}/users/tester`, sessionUrl]);
	expect(first[1].body).toBe("Paris. I saved it to memory.");

	// The user's response wakes the session again, and its next answer lands after it.
	const responded = await pana(env, ["thread", "respond", "--thread", threadId, "--after", first[1].id, "--body", "Thanks!"]);
	expect(responded.code, responded.stderr).toBe(0);
	const second = await until(async () => {
		const read = await pana(env, ["thread", "read", threadId]);
		return read.code === 0 && read.json.messages.length >= 4 ? read.json.messages : undefined;
	}, `the second answer\n${log}`);
	expect(second.slice(2).map((m: any) => [m.sender.url, m.body])).toEqual([
		[`pana://${DOMAIN}/users/tester`, "Thanks!"],
		[sessionUrl, "You're welcome."],
	]);

	// A stale --after is rejected with exit code 3.
	const stale = await pana(env, ["thread", "respond", "--thread", threadId, "--after", first[1].id, "--body", "late"]);
	expect(stale.code).toBe(3);

	// Memory names the session as the author.
	const memoryLog = await pana(env, ["memory", "log"]);
	expect(memoryLog.code, memoryLog.stderr).toBe(0);
	expect(memoryLog.json.commits[0]).toMatchObject({
		authorUrl: sessionUrl,
		email: `${sessionId}@${DOMAIN}`,
		message: "Remember the capital of France",
	});
	const search = await pana(env, ["memory", "search", "capital of france"]);
	expect(search.json.results).toEqual([{ path: "capitals.md", line: 3, text: "Paris is the capital of France." }]);

	// The session's commit in its repo carries exactly one pana trailer.
	const body = git("log", "-1", "--format=%B");
	expect(body).toContain("Record the answer");
	const trailer = `Co-authored-by: AI ${sessionUrl} <tester@${DOMAIN}>`;
	expect(body.split("\n").filter((line) => line === trailer)).toHaveLength(1);

	const show = await pana(env, ["session", "show", sessionId]);
	expect(show.json.session).toMatchObject({ state: "idle", cwd: repo });

	// SIGTERM is a clean stop.
	const exited = new Promise<number | null>((resolve) => panad!.once("exit", (code) => resolve(code)));
	panad.kill("SIGTERM");
	expect(await exited).toBe(0);
});
