// ISO, PRM, and TOL: the pana extension's registry, system prompt, and tools.
//
// Every tool is exercised through a real pi-durable run (a capture tool makes a nested call),
// so the test sees the structuredOutput a program would. The API is a fake handler set for
// the routes WP2, WP3, and WP5 own (test/fixtures/extension.ts).

import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Registry } from "@earendil-works/pi-durable";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPanaRegistry, runPanaCli } from "../src/extension/index.ts";
import { PANA_BIN, PANA_ENV_NAMES, panaShellEnv } from "../src/extension/env.ts";
import { BROWSER_IDLE_MS, browserScope, SCOPE_PATTERN, scopeSession, sweepBrowsers } from "../src/extension/browser.ts";
import { sessionRuntime } from "../src/sessions/index.ts";
import { FAUX_MODEL, startTestPanad, TEST_DOMAIN, TEST_USER, type TestPanad } from "./harness/index.ts";
import { testGit } from "./harness/git.ts";
import { seedThread, type Fixture } from "./harness/wake-fixture.ts";
import { captureExtension, contextOf, conversationOf, fakeApi, promptSections, promptText, runTool } from "./fixtures/extension.ts";

const PANA_TOOLS = [
	"pana_reply",
	"pana_thread_read",
	"pana_thread_create",
	"pana_session_create",
	"pana_memory_search",
	"pana_memory_commit",
	"pana_schedule_wake",
];

const dirs: string[] = [];
let t: TestPanad | undefined;
let fixture: Fixture | undefined;

afterEach(async () => {
	await t?.close();
	t = undefined;
	fixture = undefined;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = "pana-ext-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

function git(cwd: string, args: string[]): string {
	return testGit(cwd, args);
}

function makeRepo(): string {
	const repo = tempDir("pana-repo-");
	git(repo, ["init", "-q"]);
	git(repo, ["config", "user.name", "tester"]);
	git(repo, ["config", "user.email", `tester@${TEST_DOMAIN}`]);
	git(repo, ["config", "commit.gpgsign", "false"]);
	return repo;
}

async function start(options: { capture?: boolean; handlers?: ReturnType<typeof fakeApi>["handlers"]; registry?: Registry } = {}) {
	let registry = options.registry;
	if (registry === undefined && options.capture) {
		registry = createPanaRegistry(() => t!.runtime);
		registry.install(captureExtension());
	}
	t = await startTestPanad({ registry, handlers: options.handlers, script: [] });
	fixture = await seedThread(t.runtime.db, t.runtime.harness, t.runtime.newId, t.clock.now(), {
		domain: TEST_DOMAIN,
		user: TEST_USER,
		count: 1,
	});
	return fixture;
}

function session(): { id: string; conversationId: number } {
	const first = fixture!.sessions[0];
	if (!first) throw new Error("no seeded session");
	return first;
}

/** Run one text-only turn so the conversation renders its system prompt. */
async function runTurn(text = "ok"): Promise<void> {
	t!.model.append([{ text }]);
	const conversation = await conversationOf(t!, session().conversationId);
	const settled = await (await conversation.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
	if (settled.status !== "done") throw new Error(`run failed: ${JSON.stringify(settled)}`);
}

describe("reader image preparation", () => {
	it("shrinks a 2050x380 screenshot through the installed reader", async () => {
		const first = await start({ capture: true });
		const path = join(import.meta.dirname, "fixtures/wide-screenshot.png");
		const original = readFileSync(path);
		const outcome = await runTool(t!, first.sessions[0]!.conversationId, "read", { path });
		expect(outcome.isError).toBe(false);
		expect(JSON.stringify(outcome.diagnostics)).toContain("Resized from 2050x380 to 2000x371");
		expect(readFileSync(path)).toEqual(original);
	});
});

describe("extension isolation", () => {
	it("ISO-01 the registry holds only CodingTools and pana", async () => {
		t = await startTestPanad({ script: [] });

		const installed = t.runtime.registry.snapshot().installed();
		expect(installed.map((extension) => extension.name)).toEqual(["coding-tools", "pana"]);
		const tools = t.runtime.registry.snapshot().tools().map(({ extension, tool }) => `${extension.name}:${tool.name}`);
		expect(tools).toEqual([
			"coding-tools:read",
			"coding-tools:write",
			"coding-tools:edit",
			"coding-tools:bash",
			...PANA_TOOLS.map((name) => `pana:${name}`),
		]);

		// createPanaRegistry is the same registry, built without panad.
		const offline = createPanaRegistry(() => t!.runtime);
		expect(offline.snapshot().installed().map((extension) => extension.name)).toEqual(["coding-tools", "pana"]);
	});

	it("ISO-02 a session's system prompt contains nothing from ~/.pi/agent", async () => {
		const fakeHome = tempDir("pana-home-");
		mkdirSync(join(fakeHome, ".pi", "agent"), { recursive: true });
		writeFileSync(join(fakeHome, ".pi", "agent", "AGENTS.md"), "PI_AGENT_SENTINEL_ISO02\n");
		mkdirSync(join(fakeHome, ".pi", "agent", "skills"), { recursive: true });
		writeFileSync(join(fakeHome, ".pi", "agent", "skills", "SKILL.md"), "PI_SKILL_SENTINEL_ISO02\n");

		const savedHome = process.env.HOME;
		process.env.HOME = fakeHome;
		try {
			const seeded = await start();
			const cwd = tempDir("pana-cwd-");
			const conversation = await conversationOf(t!, seeded.sessions[0]!.conversationId);
			await conversation.configure({ model: FAUX_MODEL, cwd }, ctx);
			await runTurn();

			const view = await contextOf(t!, session().conversationId);
			const text = promptText(view);
			expect(text).not.toContain("PI_AGENT_SENTINEL_ISO02");
			expect(text).not.toContain("PI_SKILL_SENTINEL_ISO02");
			expect(text).not.toContain(join(fakeHome, ".pi"));
			// The only sections are the pana extension's; nothing loaded from pi's own config.
			expect([...promptSections(view).keys()]).toEqual(["pana"]);
		} finally {
			if (savedHome === undefined) delete process.env.HOME;
			else process.env.HOME = savedHome;
		}
	});

	it("ISO-03 bash runs with exactly PATH, HOME, USER, LANG, TERM=dumb, PANA_SESSION, PANA_STATE, PANA_SCRATCH, PANA_BROWSER_SESSION", async () => {
		const seeded = await start({ capture: true });
		const first = seeded.sessions[0]!;
		const conversation = await conversationOf(t!, first.conversationId);
		await conversation.configure({ model: FAUX_MODEL, cwd: tempDir("pana-cwd-") }, ctx);

		const outcome = await runTool(t!, first.conversationId, "bash", { command: "env" });
		const output = (outcome.structuredOutput as { output: string }).output;
		const env = parseEnv(output);

		// bash itself adds PWD, SHLVL, and _; nothing else may appear.
		const shellAdded = new Set(["PWD", "SHLVL", "_", "OLDPWD"]);
		const names = Object.keys(env).filter((name) => !shellAdded.has(name));
		expect(names.sort()).toEqual([...PANA_ENV_NAMES].sort());

		expect(env.TERM).toBe("dumb");
		expect(env.PANA_SESSION).toBe(first.id);
		expect(env.PANA_BROWSER_SESSION).toBe(browserScope(first.id));
		expect(env.PANA_STATE).toBe(t!.runtime.paths.dir);
		expect(env.PANA_SCRATCH).toBe(join(t!.runtime.paths.scratch, first.id));
		expect(env.GIT_CONFIG_COUNT).toBeUndefined();
		expect(env.GIT_CONFIG_KEY_0).toBeUndefined();
		expect(env.GIT_CONFIG_VALUE_0).toBeUndefined();
		expect(env.HOME).toBe(process.env.HOME);
	});

	it("ISO-04 provider credentials never appear in bash output, the transcript, or panad.log", async () => {
		const sentinel = "sk-pana-iso04-sentinel-value";
		const saved = process.env.OPENAI_API_KEY;
		process.env.OPENAI_API_KEY = sentinel;
		try {
			const seeded = await start({ capture: true });
			const first = seeded.sessions[0]!;
			const conversation = await conversationOf(t!, first.conversationId);
			await conversation.configure({ model: FAUX_MODEL, cwd: tempDir("pana-cwd-") }, ctx);

			const outcome = await runTool(t!, first.conversationId, "bash", { command: "env" });
			expect((outcome.structuredOutput as { output: string }).output).not.toContain(sentinel);
			expect(JSON.stringify(await contextOf(t!, first.conversationId))).not.toContain(sentinel);

			const log = join(t!.dir, "panad.log");
			if (existsSync(log)) expect(readFileSync(log, "utf8")).not.toContain(sentinel);
		} finally {
			if (saved === undefined) delete process.env.OPENAI_API_KEY;
			else process.env.OPENAI_API_KEY = saved;
		}
	});
});

describe("browser isolation", () => {
	/** A stand-in for the installed chrome-devtools CLI: it appends the argv it was given. */
	function stubCli(dir: string): { path: string; calls: () => string[] } {
		const log = join(dir, "argv");
		writeFileSync(join(dir, "chrome-devtools"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\n`, { mode: 0o755 });
		return { path: dir, calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []) };
	}

	/** Run pana's shim itself, with only a PATH, an XDG runtime dir, and the variables a case names. */
	function runShim(args: string[], path: string, xdg: string, env: Record<string, string> = {}): string {
		return execFileSync(join(PANA_BIN, "chrome-devtools"), args, {
			encoding: "utf8",
			env: { PATH: path, XDG_RUNTIME_DIR: xdg, ...env },
		}).trim();
	}

	/** The pid file the CLI writes for a scope: <xdg>/chrome-devtools-mcp-<scope>/daemon.pid. */
	function markRunning(xdg: string, scope: string): void {
		mkdirSync(join(xdg, `chrome-devtools-mcp-${scope}`), { recursive: true });
		writeFileSync(join(xdg, `chrome-devtools-mcp-${scope}`, "daemon.pid"), "1");
	}

	/** The one browser candidate that is not on PATH: Google Chrome's app bundle on a Mac. */
	const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
	const hasMacChrome = existsSync(MAC_CHROME);
	// Two cases below are gated on what the host has, because discovery itself is: a PATH candidate
	// outranks /Applications, and a machine that has Chrome is not a machine with "no browser
	// anywhere". Say which half is skipped, so a green run on one host cannot read as both.
	const macCase = process.platform === "darwin" && hasMacChrome ? "runs" : "is skipped";
	console.warn(
		`ISO-06: ${MAC_CHROME} is ${hasMacChrome ? "here" : "absent"}, so the Mac-Chrome case ${macCase} and the no-browser case ${hasMacChrome ? "is skipped" : "runs"}`,
	);

	/** A stand-in for an installed browser: discovery only needs an executable at that name. */
	function stubBrowser(dir: string, name: string): string {
		const path = join(dir, name);
		writeFileSync(path, "#!/bin/sh\n", { mode: 0o755 });
		return path;
	}

	/**
	 * A PATH with the CLI stub and a browser of each name, in a directory of their own, and an
	 * empty directory last: no system `chromium` from /usr/bin and no /bin (a symlink to it).
	 */
	function sandboxedPath(cli: string, ...browsers: Array<[string, string]>): string {
		const bin = tempDir("pana-path-");
		for (const [name, dir] of browsers) stubBrowser(dir, name);
		return [cli, ...browsers.map(([, dir]) => dir), bin].join(":");
	}

	it("ISO-06 bin/chrome-devtools runs the CLI with this session's --sessionId", () => {
		// ISO-03 puts pana's bin first on a session's PATH, so the shim is what `chrome-devtools` means.
		const env = panaShellEnv({ cwd: tmpdir(), sessionId: "01HZZZZZZZZZZZZZZZZZZZZZZZ" });
		expect(env.PATH?.split(":")[0]).toBe(PANA_BIN);
		expect(existsSync(join(PANA_BIN, "chrome-devtools"))).toBe(true);
		expect(env.PANA_BROWSER_SESSION).toBe(browserScope("01HZZZZZZZZZZZZZZZZZZZZZZZ"));

		const stub = stubCli(tempDir("pana-cli-"));
		const xdg = tempDir("pana-xdg-");
		// A stub browser on PATH, so the implicit start is one fixed argv on every host: a PATH
		// candidate outranks the Mac app bundle, and `/usr/bin:/bin` would name whatever browser
		// the test machine happens to have.
		const browsers = tempDir("pana-browsers-");
		const chromium = stubBrowser(browsers, "chromium");
		const path = sandboxedPath(stub.path, ["chromium", browsers]);
		const scope = env.PANA_BROWSER_SESSION!;

		// A shell with no session runs the CLI unchanged, with no daemon started for it.
		runShim(["list_pages"], path, xdg);
		expect(stub.calls()).toEqual(["list_pages"]);

		// The first call starts this scope's daemon isolated, because the implicit start opens the
		// machine-wide Chrome profile, which the next session's daemon cannot open.
		writeFileSync(join(stub.path, "argv"), "");
		runShim(["list_pages"], path, xdg, { PANA_BROWSER_SESSION: scope });
		expect(stub.calls()).toEqual([
			`start --sessionId ${scope} --isolated --executablePath ${chromium}`,
			`--sessionId ${scope} list_pages`,
		]);

		// A daemon that is already running is never started again: `start` restarts it and closes
		// the pages under it.
		markRunning(xdg, scope);
		writeFileSync(join(stub.path, "argv"), "");
		runShim(["list_pages"], path, xdg, { PANA_BROWSER_SESSION: scope });
		expect(stub.calls()).toEqual([`--sessionId ${scope} list_pages`]);

		// `status` and `stop` name the scope but must not start a browser to answer.
		writeFileSync(join(stub.path, "argv"), "");
		runShim(["stop"], path, xdg, { PANA_BROWSER_SESSION: scope });
		expect(stub.calls()).toEqual([`--sessionId ${scope} stop`]);

		// A call that names its own daemon keeps it.
		writeFileSync(join(stub.path, "argv"), "");
		runShim(["list_pages", "--sessionId", "mine"], path, xdg, { PANA_BROWSER_SESSION: scope });
		expect(stub.calls()).toEqual(["list_pages --sessionId mine"]);

		// pana's bin can appear twice on one PATH; the second copy is not the CLI.
		const other = tempDir("pana-bin-");
		copyFileSync(join(PANA_BIN, "chrome-devtools"), join(other, "chrome-devtools"));
		writeFileSync(join(stub.path, "argv"), "");
		runShim(["list_pages"], `${other}:${path}`, xdg, { PANA_BROWSER_SESSION: scope });
		expect(stub.calls()).toEqual([`--sessionId ${scope} list_pages`]);

		// No CLI on PATH is an error, not a loop, and no browser discovery gets in the way of it.
		expect(() => runShim(["list_pages"], "/usr/bin:/bin", xdg, { PANA_BROWSER_SESSION: scope })).toThrow();
		expect(() => runShim(["list_pages"], `${tempDir("pana-nobrowser-")}`, xdg, { PANA_BROWSER_SESSION: scope })).toThrow();
	});

	it("ISO-06 the implicit start passes --executablePath for the first browser it finds", () => {
		// chrome-devtools-mcp 1.10.1 reads a browser only from `--executablePath`, or from
		// `--channel`, whose choices are all Chrome-branded; with neither it probes
		// /opt/google/chrome, so on a machine with a distro Chromium and no Chrome the daemon
		// starts and every call then fails with "Could not find Google Chrome executable".
		const stub = stubCli(tempDir("pana-cli-"));
		const xdg = tempDir("pana-xdg-");
		const browsers = tempDir("pana-browsers-");
		const chromium = stubBrowser(browsers, "chromium");
		const path = sandboxedPath(stub.path, ["chromium", browsers]);
		const scope = browserScope("01HZZZZZZZZZZZZZZZZZZZZZZZ");

		runShim(["list_pages"], path, xdg, { PANA_BROWSER_SESSION: scope });
		expect(stub.calls()).toEqual([
			`start --sessionId ${scope} --isolated --executablePath ${chromium}`,
			`--sessionId ${scope} list_pages`,
		]);

		// Discovery changes only that start: a daemon already running is never started again.
		markRunning(xdg, scope);
		writeFileSync(join(stub.path, "argv"), "");
		runShim(["list_pages"], path, xdg, { PANA_BROWSER_SESSION: scope });
		expect(stub.calls()).toEqual([`--sessionId ${scope} list_pages`]);

		// `stop` starts nothing, with or without a browser to hand it.
		writeFileSync(join(stub.path, "argv"), "");
		runShim(["stop"], path, xdg, { PANA_BROWSER_SESSION: scope });
		expect(stub.calls()).toEqual([`--sessionId ${scope} stop`]);

		// A call that names its own `--sessionId` runs unchanged, and starts nothing.
		writeFileSync(join(stub.path, "argv"), "");
		runShim(["list_pages", "--sessionId", "mine"], path, xdg, { PANA_BROWSER_SESSION: scope });
		expect(stub.calls()).toEqual(["list_pages --sessionId mine"]);
	});

	// Skipped where the absolute candidate exists: that machine has a browser to find, so it has no
	// "nowhere" to test. The Mac case below covers that half where it can actually run.
	it.skipIf(hasMacChrome)("ISO-06 with no browser anywhere the implicit start keeps today's exact argv", () => {
		// A machine without a browser must keep the CLI's own error, not get a new one from here, so
		// the start is byte for byte what it was before discovery.
		const stub = stubCli(tempDir("pana-cli-"));
		const xdg = tempDir("pana-xdg-");
		const path = sandboxedPath(stub.path);
		const scope = browserScope("01HZZZZZZZZZZZZZZZZZZZZZZZ");

		runShim(["list_pages"], path, xdg, { PANA_BROWSER_SESSION: scope });
		expect(stub.calls()).toEqual([`start --sessionId ${scope} --isolated`, `--sessionId ${scope} list_pages`]);
	});

	// The only candidate that is not on PATH, gated on the platform that has it, so the branch runs
	// where it can instead of being asserted nowhere. Elsewhere this case is skipped, not faked.
	it.skipIf(process.platform !== "darwin" || !hasMacChrome)(
		"ISO-06 on a Mac the implicit start names the Chrome app bundle, spaces and all",
		() => {
			const stub = stubCli(tempDir("pana-cli-"));
			const xdg = tempDir("pana-xdg-");
			const path = sandboxedPath(stub.path);
			const scope = browserScope("01HZZZZZZZZZZZZZZZZZZZZZZZ");

			runShim(["list_pages"], path, xdg, { PANA_BROWSER_SESSION: scope });
			expect(stub.calls()).toEqual([
				// One argument, because the shim quotes it: `/Applications/…` has spaces.
				`start --sessionId ${scope} --isolated --executablePath ${MAC_CHROME}`,
				`--sessionId ${scope} list_pages`,
			]);
		},
	);

	it("ISO-06 google-chrome wins over chromium, which is the CLI's own order", () => {
		// Candidate name beats PATH order: `chromium` sits in the first directory on PATH and
		// `google-chrome` in the second, and the CLI's default is still the Chrome one.
		const stub = stubCli(tempDir("pana-cli-"));
		const xdg = tempDir("pana-xdg-");
		const chromiumDir = tempDir("pana-browsers-");
		const chromeDir = tempDir("pana-browsers-");
		stubBrowser(chromiumDir, "chromium");
		const chrome = stubBrowser(chromeDir, "google-chrome");
		const path = sandboxedPath(stub.path, ["chromium", chromiumDir], ["google-chrome", chromeDir]);
		const scope = browserScope("01HZZZZZZZZZZZZZZZZZZZZZZZ");

		runShim(["list_pages"], path, xdg, { PANA_BROWSER_SESSION: scope });
		expect(stub.calls()).toEqual([
			`start --sessionId ${scope} --isolated --executablePath ${chrome}`,
			`--sessionId ${scope} list_pages`,
		]);
	});

	it("ISO-06 the scope is hex, so the CLI's sessionId rule accepts it, and it names the session back", () => {
		const id = "01HZZZZZZZZZZZZZZZZZZZZZZZ";
		const scope = browserScope(id);
		// The CLI's rule (`assertValidSessionId`): a ULID has letters past `f`, and so does a `pana-`
		// prefix, so a scope that spells the session id is rejected by every command with
		// `Error: Invalid sessionId: …`. Only hex and dashes may appear.
		expect(scope).toMatch(SCOPE_PATTERN);
		expect(scope).toMatch(/^[0-9a-f]+$/);
		expect(scope).not.toBe(browserScope("01HZZZZZZZZZZZZZZZZZZZZZZY"));
		// Stable per session, so a daemon is found again by every later call (ISO-07).
		expect(browserScope(id)).toBe(scope);
		expect(scopeSession(scope)).toBe(id);
		// A scope this module did not make names nobody, and is not stopped as an orphan.
		expect(scopeSession(`pana-${id}`)).toBeUndefined();
		expect(scopeSession("")).toBeUndefined();
		expect(scopeSession("3031")).toBeUndefined();
	});

	it("ISO-06 the installed CLI accepts the scope as --sessionId", () => {
		// The stub above never validates the id, so this runs the real one: `status` answers without
		// starting a daemon, and an id outside its rule fails the call.
		let available = true;
		try {
			execFileSync("chrome-devtools", ["--version"], { stdio: "ignore" });
		} catch {
			available = false;
		}
		if (!available) {
			console.warn("ISO-06: no chrome-devtools on PATH; the scope was not checked against the CLI");
			return;
		}
		const scope = browserScope("01HZZZZZZZZZZZZZZZZZZZZZZZ");
		const status = execFileSync("chrome-devtools", ["--sessionId", scope, "status"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		expect(status).not.toContain("Invalid sessionId");
		// The control: the scope this replaced, which named the session in plain text, is rejected.
		expect(() =>
			execFileSync("chrome-devtools", ["--sessionId", "pana-01HZZZZZZZZZZZZZZZZZZZZZZZ", "status"], { stdio: ["ignore", "pipe", "pipe"] }),
		).toThrow();
	});

	/** A session row, last changed `idleMs` ago. Not wakeable: the sweeper only reads state. */
	async function seedSession(state: string, idleMs = 0): Promise<string> {
		const id = t!.runtime.newId();
		const now = t!.clock.now();
		await t!.runtime.db.write(async (tx) => {
			await tx.run("INSERT INTO participants (id, kind, url, created_at) VALUES (?, 'session', ?, ?)", id, t!.runtime.url({ kind: "session", id }), now);
			await tx.run(
				"INSERT INTO sessions (id, state, depth, created_at, updated_at) VALUES (?, ?, 0, ?, ?)",
				id,
				state,
				now - idleMs,
				now - idleMs,
			);
		});
		return id;
	}

	it("ISO-07 temporary test domains never stop the calling session's browser as an orphan", async () => {
		const xdg = tempDir("pana-xdg-");
		const scope = browserScope("01AAAAAAAAAAAAAAAAAAAAAAAA");
		mkdirSync(join(xdg, `chrome-devtools-mcp-${scope}`), { recursive: true });
		writeFileSync(join(xdg, `chrome-devtools-mcp-${scope}`, "server.sock"), "");
		const argv = join(tempDir("pana-argv-"), "argv");
		writeFileSync(argv, "");
		const bin = tempDir("pana-stub-");
		writeFileSync(join(bin, "chrome-devtools"), `#!/bin/sh\nprintf '%s' "$*" >> "${argv}"\n`, { mode: 0o755 });
		const savedPath = process.env.PATH;
		const savedXdg = process.env.XDG_RUNTIME_DIR;
		process.env.PATH = `${bin}:${savedPath ?? "/usr/bin:/bin"}`;
		process.env.XDG_RUNTIME_DIR = xdg;
		try {
			t = await startTestPanad();
			await t.stop(); // also waits for the startup sweep
			expect(readFileSync(argv, "utf8")).toBe("");
		} finally {
			process.env.PATH = savedPath;
			if (savedXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
			else process.env.XDG_RUNTIME_DIR = savedXdg;
		}
	});

	it("ISO-07 the sweep stops archived, idle, and orphan daemons and keeps a working one", async () => {
		t = await startTestPanad({ script: [] });
		const now = t.clock.now();
		const archived = await seedSession("archived");
		const idle = await seedSession("idle", BROWSER_IDLE_MS + 1);
		const recent = await seedSession("idle", 1000);
		const running = await seedSession("running", BROWSER_IDLE_MS * 10);
		const orphan = t.runtime.newId();
		const browsers = [archived, idle, recent, running, orphan].map((session) => ({
			session,
			scope: browserScope(session),
			socket: `/tmp/chrome-devtools-mcp-${browserScope(session)}-0.sock`,
		}));

		const stopped: string[] = [];
		const stops = await sweepBrowsers(t.runtime, {
			browsers,
			now,
			stop: async (scope) => {
				stopped.push(scope);
			},
		});
		expect(stops.map((stop) => [stop.session, stop.reason])).toEqual([
			[archived, "archived"],
			[idle, "idle"],
			[orphan, "orphan"],
		]);
		expect(stopped).toEqual([archived, idle, orphan].map((session) => browserScope(session)));
	});

	it("ISO-07 archiving a session stops its daemon now", async () => {
		const seeded = await start();
		const id = seeded.sessions[0]!.id;
		const scope = browserScope(id);
		// The CLI keeps an XDG daemon at <dir>/chrome-devtools-mcp-<scope>/server.sock.
		const xdg = tempDir("pana-xdg-");
		mkdirSync(join(xdg, `chrome-devtools-mcp-${scope}`), { recursive: true });
		writeFileSync(join(xdg, `chrome-devtools-mcp-${scope}`, "server.sock"), "");
		const argv = join(tempDir("pana-argv-"), "argv");
		const bin = tempDir("pana-stub-");
		writeFileSync(join(bin, "chrome-devtools"), `#!/bin/sh\nprintf '%s' "$*" >> "${argv}"\n`, { mode: 0o755 });

		const savedPath = process.env.PATH;
		const savedXdg = process.env.XDG_RUNTIME_DIR;
		process.env.PATH = `${bin}:${savedPath ?? "/usr/bin:/bin"}`;
		process.env.XDG_RUNTIME_DIR = xdg;
		try {
			await sessionRuntime(t!.runtime).archive(id);
		} finally {
			process.env.PATH = savedPath;
			if (savedXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
			else process.env.XDG_RUNTIME_DIR = savedXdg;
		}
		expect(readFileSync(argv, "utf8")).toBe(`--sessionId ${scope} stop`);
	});
});

describe("bash time limit", () => {
	it("ISO-05 a bash call without a timeout gets the configured default, and hitting it kills the whole process group", async () => {
		t = await startTestPanad({ script: [], config: { tools: { bashTimeoutSec: 1 } } });
		expect(t.runtime.config.tools.bashTimeoutSec).toBe(1);
		fixture = await seedThread(t.runtime.db, t.runtime.harness, t.runtime.newId, t.clock.now(), { domain: TEST_DOMAIN, user: TEST_USER, count: 1 });
		const conversation = await conversationOf(t, session().conversationId);
		await conversation.configure({ model: FAUX_MODEL, cwd: tempDir("pana-cwd-") }, ctx);

		// A grep under `bash -c` is the case that hung a session: the inner shell and its
		// background child must die with the outer shell, not only the shell pi-durable started.
		const pids = tempDir("pana-pids-");
		const command = `bash -c 'sleep 30 & echo $! > "${pids}/child"; echo $$ > "${pids}/inner"; wait'`;
		t.model.append([{ toolCalls: [{ name: "bash", args: { command } }] }, { text: "done" }]);
		const started = Date.now();
		const settled = await (await conversation.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
		expect(settled.status).toBe("done");
		expect(Date.now() - started).toBeLessThan(15_000);

		const page = await conversation.entries({ order: "ascending" }, 1000, undefined, ctx);
		const result = page.items.find((entry) => entry.kind === "pi.tool-result")!;
		const message = result.model![0] as { isError?: boolean; content: Array<{ type: string; text?: string }> };
		expect(message.isError).toBe(true);
		const text = message.content.map((block) => block.text ?? "").join("\n");
		expect(text).toContain("timed out after 1 seconds");
		expect(text).toContain("never all of HOME");

		for (const name of ["inner", "child"]) {
			const pid = Number(readFileSync(join(pids, name), "utf8").trim());
			expect(pid).toBeGreaterThan(0);
			await expect.poll(() => alive(pid), { timeout: 5000 }).toBe(false);
		}

		// The model is told: the prompt names the limit and asks for scoped searches.
		const prompt = promptText(await contextOf(t, session().conversationId));
		expect(prompt).toContain("time limit: 1 seconds");
		expect(prompt).toContain("Never search all");
	});

	it("ISO-05 the default limit is 600 seconds, and a call's own timeout wins", async () => {
		t = await startTestPanad({ script: [] });
		expect(t.runtime.config.tools.bashTimeoutSec).toBe(600);
		fixture = await seedThread(t.runtime.db, t.runtime.harness, t.runtime.newId, t.clock.now(), { domain: TEST_DOMAIN, user: TEST_USER, count: 1 });
		const conversation = await conversationOf(t, session().conversationId);
		await conversation.configure({ model: FAUX_MODEL, cwd: tempDir("pana-cwd-") }, ctx);
		t.model.append([{ toolCalls: [{ name: "bash", args: { command: "sleep 30", timeout: 1 } }] }, { text: "done" }]);
		const settled = await (await conversation.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
		expect(settled.status).toBe("done");
		const page = await conversation.entries({ order: "ascending" }, 1000, undefined, ctx);
		const result = page.items.find((entry) => entry.kind === "pi.tool-result")!;
		const text = JSON.stringify(result.model);
		expect(text).toContain("Command timed out after 1 seconds");
		expect(text).not.toContain("default limit");
	});
});

describe("system prompt", () => {
	it("PRM-01 sections render in order: project AGENTS.md files, pana/prompt.md, profile instructions", async () => {
		const repo = makeRepo();
		writeFileSync(join(repo, "AGENTS.md"), "ROOT_PROJECT_PRM01\n");
		mkdirSync(join(repo, "sub"));
		writeFileSync(join(repo, "sub", "AGENTS.md"), "SUB_PROJECT_PRM01\n");

		const seeded = await start();
		const conversation = await conversationOf(t!, seeded.sessions[0]!.conversationId);
		await conversation.configure({ model: FAUX_MODEL, cwd: join(repo, "sub"), instructions: "PROFILE_PRM01" }, ctx);
		await runTurn();

		const view = await contextOf(t!, session().conversationId);
		const sections = promptSections(view);
		expect([...sections.keys()]).toEqual(["project", "pana", "instructions"]);

		const project = sections.get("project")!;
		expect(project.indexOf("ROOT_PROJECT_PRM01")).toBeGreaterThanOrEqual(0);
		expect(project.indexOf("ROOT_PROJECT_PRM01")).toBeLessThan(project.indexOf("SUB_PROJECT_PRM01"));
		expect(sections.get("pana")).not.toContain("PROFILE_PRM01");
		expect(sections.get("instructions")).toContain("PROFILE_PRM01");
	});

	it("PRM-05 the rendered prompt permits only user-requested safe fast-forwards of the user's checkout", async () => {
		const seeded = await start();
		await runTurn();
		const text = promptSections(await contextOf(t!, seeded.sessions[0]!.conversationId)).get("pana")!.replace(/\s+/g, " ");
		for (const rule of [
			"on explicit user request, you may fast-forward the user's checkout",
			"Verify the checkout path, current branch, remote/upstream, and working-tree status first",
			"fetch the upstream and compare incoming paths with staged, unstaged, and untracked paths",
			"Existing local changes are allowed only when the incoming update does not touch their paths",
			"Preserve all staged, unstaged, and untracked work unchanged",
			"Stop and report on any path overlap, including file/directory collisions",
			"do not rely on Git merging local edits",
			"Pin the pull to the full upstream commit ID whose paths you inspected",
			"`git pull --ff-only --no-autostash <verified-remote> <inspected-commit>`",
			"Recheck the checkout's HEAD, branch/upstream, index, and working-tree status/diffs before pulling",
			"stop and report if any changed during preflight",
			"Do not switch branches, stash, discard changes, reset, rebase, or resolve conflicts automatically",
			"Stop and report if a fast-forward is impossible or the update would overwrite local files",
			"does not authorize changes to another session's worktree or bypass the memory publishing rules below",
			"Publish memory only with `pana_memory_commit`",
		]) expect(text).toContain(rule);
		expect(text).not.toContain("require no staged or tracked working-tree changes");
	});

	it("PRM-05 Git pulls pinned to the inspected commit preserve unrelated local work even if upstream advances", () => {
		const upstream = makeRepo();
		for (const name of ["incoming", "staged", "unstaged"]) writeFileSync(join(upstream, name), "base\n");
		git(upstream, ["add", "."]);
		git(upstream, ["commit", "-qm", "base"]);
		const checkout = tempDir("pana-user-checkout-");
		git(checkout, ["clone", "-q", upstream, "."]);
		// The command must override user config rather than silently stashing local work.
		git(checkout, ["config", "merge.autoStash", "true"]);
		git(checkout, ["config", "rebase.autoStash", "true"]);
		writeFileSync(join(checkout, "staged"), "staged edit\n");
		git(checkout, ["add", "staged"]);
		writeFileSync(join(checkout, "unstaged"), "unstaged edit\n");
		writeFileSync(join(checkout, "untracked"), "untracked work\n");
		const staged = git(checkout, ["diff", "--cached", "--binary"]);
		const unstaged = git(checkout, ["diff", "--binary"]);
		const status = git(checkout, ["status", "--porcelain=v1"]);
		writeFileSync(join(upstream, "incoming"), "upstream update\n");
		git(upstream, ["commit", "-qam", "update untouched path"]);
		git(checkout, ["fetch", "-q"]);
		expect(git(checkout, ["diff", "--name-only", "HEAD..@{upstream}"]).trim()).toBe("incoming");
		const inspectedCommit = git(checkout, ["rev-parse", "@{upstream}"]).trim();
		// An uninspected upstream advance could absorb staged work if the pull used a moving tip.
		writeFileSync(join(upstream, "staged"), "staged edit\n");
		git(upstream, ["commit", "-qam", "advance after inspection with identical staged content"]);
		git(checkout, ["pull", "--ff-only", "--no-autostash", "origin", inspectedCommit]);
		expect(git(checkout, ["rev-parse", "HEAD"]).trim()).toBe(inspectedCommit);
		expect(git(checkout, ["rev-parse", "HEAD"])).not.toBe(git(upstream, ["rev-parse", "HEAD"]));
		expect(git(checkout, ["diff", "--cached", "--binary"])).toBe(staged);
		expect(git(checkout, ["diff", "--binary"])).toBe(unstaged);
		expect(git(checkout, ["status", "--porcelain=v1"])).toBe(status);
		expect(readFileSync(join(checkout, "untracked"), "utf8")).toBe("untracked work\n");
		expect(git(checkout, ["stash", "list"])).toBe("");

		// If incoming work overlaps a local path, neither autostash config may hide it.
		writeFileSync(join(upstream, "unstaged"), "conflicting upstream edit\n");
		git(upstream, ["commit", "-qam", "overlapping update"]);
		const head = git(checkout, ["rev-parse", "HEAD"]);
		const conflictingCommit = git(upstream, ["rev-parse", "HEAD"]).trim();
		// This tests Git's last-resort overwrite refusal, not the prompt's stricter path preflight.
		expect(() => git(checkout, ["pull", "--ff-only", "--no-autostash", "origin", conflictingCommit])).toThrow();
		expect(git(checkout, ["rev-parse", "HEAD"])).toBe(head);
		expect(git(checkout, ["diff", "--cached", "--binary"])).toBe(staged);
		expect(git(checkout, ["diff", "--binary"])).toBe(unstaged);
		expect(git(checkout, ["status", "--porcelain=v1"])).toBe(status);
		expect(git(checkout, ["stash", "list"])).toBe("");
	});

	it("PRM-06 the rendered prompt discovers optional domain conventions from published memory", async () => {
		const seeded = await start();
		await runTurn();
		const text = promptSections(await contextOf(t!, seeded.sessions[0]!.conversationId)).get("pana")!.replace(/\s+/g, " ");
		for (const rule of [
			"At the start of each run",
			"optional root `AGENTS.md` in published memory (`main`)",
			"not a potentially stale worktree copy",
			"Read it and any relevant workflow files from `main` using read-only Git commands in your own memory worktree",
			"If the entrypoint is absent, skip it",
			"do not create conventions or schedules unasked",
			"Follow only relevant pointers, not every memory file",
			"domain guidance subordinate to higher-priority instructions",
			"they grant no additional permissions",
			"Continue to edit and publish memory through your own worktree under the memory rules above",
		]) expect(text).toContain(rule);
	});

	it("PRM-07 the rendered prompt supplies memory hygiene without domain guidance", async () => {
		const seeded = await start();
		await runTurn();
		const text = promptSections(await contextOf(t!, seeded.sessions[0]!.conversationId)).get("pana")!.replace(/\s+/g, " ");
		for (const rule of [
			"Preserve understanding that improves future judgment, not task history",
			"plausible future situation",
			"ordinary thread/PR retrieval or canonical sources would not be enough",
			"memory can route there",
			"Search relevant history before reviving a proposal",
			"what matters, why, when it applies, and a source",
			'Separate observation from inference; a local "not yet" is not a standing prohibition',
			"When in doubt, do not save",
			"Prune completed task ledgers, stale snapshots, and duplicates",
			"active automation/handoff checkpoints compact and separate",
			"General memory hygiene belongs in Pana; domain-specific choices belong in domain memory",
			"Memory grants no additional permission to act",
		]) expect(text).toContain(rule);
		expect(text).not.toContain("memory-guidance.md");
	});

	it("PRM-02 project section reads AGENTS.md from the git root down to cwd, root first", async () => {
		const repo = makeRepo();
		writeFileSync(join(repo, "AGENTS.md"), "ROOT_AGENTS_PRM02\n");
		mkdirSync(join(repo, "a"));
		writeFileSync(join(repo, "a", "AGENTS.md"), "A_AGENTS_PRM02\n");
		mkdirSync(join(repo, "a", "b"));

		const seeded = await start();
		const conversation = await conversationOf(t!, seeded.sessions[0]!.conversationId);
		await conversation.configure({ model: FAUX_MODEL, cwd: join(repo, "a", "b") }, ctx);
		await runTurn();

		let project = promptSections(await contextOf(t!, session().conversationId)).get("project")!;
		expect(project).toContain("ROOT_AGENTS_PRM02");
		expect(project).toContain("A_AGENTS_PRM02");
		expect(project.indexOf("ROOT_AGENTS_PRM02")).toBeLessThan(project.indexOf("A_AGENTS_PRM02"));

		// Outside a git repo, only cwd/AGENTS.md.
		const outside = tempDir("pana-outside-");
		mkdirSync(join(outside, "child"));
		writeFileSync(join(outside, "AGENTS.md"), "PARENT_AGENTS_PRM02\n");
		writeFileSync(join(outside, "child", "AGENTS.md"), "OUTSIDE_AGENTS_PRM02\n");
		await conversation.configure({ cwd: join(outside, "child") }, ctx);
		await runTurn();

		project = promptSections(await contextOf(t!, session().conversationId)).get("project")!;
		expect(project).toContain("OUTSIDE_AGENTS_PRM02");
		expect(project).not.toContain("PARENT_AGENTS_PRM02");
	});

	it("PRM-03 the pana section includes the session URL, the memory worktree, and the memory commands", async () => {
		const seeded = await start();
		const first = seeded.sessions[0]!;
		const conversation = await conversationOf(t!, first.conversationId);
		await conversation.configure({ model: FAUX_MODEL, cwd: tempDir("pana-cwd-") }, ctx);
		await runTurn();

		const pana = promptSections(await contextOf(t!, first.conversationId)).get("pana")!;
		expect(pana).toContain(`pana://${TEST_DOMAIN}/sessions/${first.id}`);
		expect(pana).toContain(join(t!.runtime.paths.memoryWorktrees, first.id));
		expect(pana).toContain("pana memory commit");
		expect(pana).toContain("pana memory search");
		expect(pana).toContain("pana memory log");
	});

	it("PRM-04 rendering the prompt twice for the same session gives identical text", async () => {
		const seeded = await start();
		const conversation = await conversationOf(t!, seeded.sessions[0]!.conversationId);
		await conversation.configure({ model: FAUX_MODEL, cwd: tempDir("pana-cwd-") }, ctx);

		await runTurn("first");
		const firstText = promptText(await contextOf(t!, session().conversationId));
		await runTurn("second");
		const secondText = promptText(await contextOf(t!, session().conversationId));

		expect(secondText).toBe(firstText);

		// A changed section would append another pi.system entry; identical renders append none.
		const page = await conversation.entries({ order: "ascending" }, 1000, undefined, ctx);
		const systems = page.items.filter((entry) => entry.kind === "pi.system");
		expect(systems).toHaveLength(1);
	});
});

describe("pana tools", () => {
	it("TOL-01 the pana tools are installed", async () => {
		t = await startTestPanad({ script: [] });
		const pana = t.runtime.registry.snapshot().extension("pana");
		expect(pana?.tools?.map((tool) => tool.name)).toEqual(PANA_TOOLS);
	});

	it("TOL-02 each tool calls the same route as its CLI command, as the session", async () => {
		const cases: Array<{ tool: string; args: Record<string, unknown>; cli: string[]; route: string }> = [
			{
				tool: "pana_reply",
				args: { thread: "01THREAD0000000000000000AA", after: "01MESSAGE00000000000000AAA", body: "hi there" },
				cli: ["thread", "respond", "--thread", "01THREAD0000000000000000AA", "--after", "01MESSAGE00000000000000AAA", "--body", "hi there"],
				route: "threads.respond",
			},
			{
				tool: "pana_thread_read",
				args: { thread: "01THREAD0000000000000000AA" },
				cli: ["thread", "read", "01THREAD0000000000000000AA"],
				route: "threads.read",
			},
			{
				tool: "pana_thread_read",
				args: { message: "01MESSAGE00000000000000AAA" },
				cli: ["thread", "read", "--message", "01MESSAGE00000000000000AAA"],
				route: "messages.show",
			},
			{
				tool: "pana_thread_create",
				args: { to: ["joshbeckman", "01PARTNER0000000000000000"], body: "hello" },
				cli: ["thread", "create", "--to", "joshbeckman,01PARTNER0000000000000000", "--body", "hello"],
				route: "threads.create",
			},
			{
				tool: "pana_session_create",
				args: { prompt: "check the build", model: "faux/faux-1", thinking: "high" },
				cli: ["session", "create", "--prompt", "check the build", "--model", "faux/faux-1", "--thinking", "high"],
				route: "sessions.create",
			},
			{
				tool: "pana_memory_search",
				args: { query: "threads" },
				cli: ["memory", "search", "threads"],
				route: "memory.search",
			},
			{
				tool: "pana_memory_commit",
				args: { message: "note what I learned" },
				cli: ["memory", "commit", "-m", "note what I learned"],
				route: "memory.commit",
			},
		];

		const api = fakeApi();
		const seeded = await start({ capture: true, handlers: api.handlers });
		const first = seeded.sessions[0]!;
		const conversation = await conversationOf(t!, first.conversationId);
		await conversation.configure({ model: FAUX_MODEL, cwd: tempDir("pana-cwd-") }, ctx);
		const sessionUrl = `pana://${TEST_DOMAIN}/sessions/${first.id}`;

		for (const testCase of cases) {
			const before = api.calls.length;
			const outcome = await runTool(t!, first.conversationId, testCase.tool, testCase.args);
			const afterTool = api.calls.slice(before);
			const cliOutcome = await runPanaCli(testCase.cli, { endpoint: { socketPath: t!.panad.socketPath }, caller: first.id });
			const afterCli = api.calls.slice(before + afterTool.length);

			expect(outcome.isError).toBe(false);
			expect(outcome.structuredOutput).toEqual({ exitCode: cliOutcome.exitCode, body: cliOutcome.body });

			expect(afterTool).toHaveLength(1);
			expect(afterCli).toHaveLength(1);
			const toolCall = afterTool[0]!;
			const cliCall = afterCli[0]!;
			expect(toolCall.route).toBe(testCase.route);
			expect(cliCall).toEqual(toolCall);
			expect(toolCall.caller).toBe(sessionUrl);
		}
	});

	it("TOL-02 thread reads ignore blank unused selectors and reject missing or conflicting selectors", async () => {
		const api = fakeApi();
		await start({ capture: true, handlers: api.handlers });
		const first = session();
		const thread = "01THREAD0000000000000000AA";
		const message = "01MESSAGE00000000000000AAA";
		const options = { endpoint: { socketPath: t!.panad.socketPath }, caller: first.id };
		for (const blank of [undefined, "", " \t "]) {
			for (const single of [false, true]) {
				const args = single ? { message, thread: blank } : { thread, message: blank };
				const cli = single
					? ["thread", "read", ...(blank === undefined ? [] : [blank]), "--message", message]
					: ["thread", "read", thread, ...(blank === undefined ? [] : ["--message", blank])];
				const before = api.calls.length;
				const outcome = await runTool(t!, first.conversationId, "pana_thread_read", args);
				const cliOutcome = await runPanaCli(cli, options);
				expect(outcome.isError).toBe(false);
				expect(outcome.structuredOutput).toEqual({ exitCode: 0, body: cliOutcome.body });
				const calls = api.calls.slice(before);
				expect(calls).toHaveLength(2);
				expect(calls[0]!.route).toBe(single ? "messages.show" : "threads.read");
				expect(calls[1]).toEqual(calls[0]);
			}
		}
		const before = api.calls.length;
		for (const args of [{}, { thread: "", message: " \t " }, { thread, message }]) {
			const outcome = await runTool(t!, first.conversationId, "pana_thread_read", args);
			expect(outcome.isError).toBe(true);
			expect(outcome.structuredOutput).toMatchObject({ exitCode: 2 });
			expect(JSON.stringify(outcome.diagnostics)).toContain("give either a THREAD or --message MESSAGE");
		}
		for (const cli of [["thread", "read"], ["thread", "read", "", "--message", " "], ["thread", "read", thread, "--message", message]]) {
			await expect(runPanaCli(cli, options)).resolves.toMatchObject({ exitCode: 2 });
		}
		expect(api.calls).toHaveLength(before);
	});

	it("SCH-15 the wake tool forwards an optional display subject", async () => {
		let received: unknown;
		await start({ capture: true, handlers: { "schedules.create": request => {
			received = request.body;
			return { status: 201, body: { schedule: { subject: "Review CI" } } };
		} } });
		const first = session();
		const outcome = await runTool(t!, first.conversationId, "pana_schedule_wake", { in: "10m", note: "Check CI and reply in the source thread", subject: "Review CI" });
		expect(outcome.isError).toBe(false);
		expect(received).toMatchObject({ kind: "wake", in: "10m", note: "Check CI and reply in the source thread", subject: "Review CI" });
	});

	it("the wake tool ignores blank unused selectors but rejects missing or conflicting times", async () => {
		const received: unknown[] = [];
		await start({ capture: true, handlers: { "schedules.create": request => {
			received.push(request.body);
			return { status: 201, body: {} };
		} } });
		const first = session();
		for (const blank of ["", " \t "]) {
			for (const args of [{ in: "5m", at: blank }, { in: blank, at: "2027-01-01T00:00:00Z" }]) {
				const outcome = await runTool(t!, first.conversationId, "pana_schedule_wake", { ...args, note: "Check CI" });
				expect(outcome.isError).toBe(false);
				expect(received.at(-1)).toEqual({ kind: "wake", note: "Check CI", ...(args.in === blank ? { at: args.at } : { in: args.in }) });
			}
		}
		for (const args of [{ in: "", at: " " }, { in: "5m", at: "2027-01-01T00:00:00Z" }]) {
			const outcome = await runTool(t!, first.conversationId, "pana_schedule_wake", { ...args, note: "Check CI" });
			expect(outcome.isError).toBe(true);
			expect(outcome.structuredOutput).toMatchObject({ exitCode: 2 });
		}
		expect(received).toHaveLength(4);
	});

	it("TOL-03 a tool error carries the CLI exit code in structuredOutput.exitCode", async () => {
		const api = fakeApi({
			"memory.commit": {
				status: 409,
				body: { error: { code: "stale", message: "memory conflict", paths: ["notes.md"] } },
			},
		});
		const seeded = await start({ capture: true, handlers: api.handlers });
		const first = seeded.sessions[0]!;

		const outcome = await runTool(t!, first.conversationId, "pana_memory_commit", { message: "conflict" });
		const cliOutcome = await runPanaCli(["memory", "commit", "-m", "conflict"], {
			endpoint: { socketPath: t!.panad.socketPath },
			caller: first.id,
		});

		expect(outcome.isError).toBe(true);
		expect(outcome.structuredOutput).toMatchObject({ exitCode: 3 });
		expect(outcome.structuredOutput).toEqual({ exitCode: cliOutcome.exitCode, body: cliOutcome.body });
		expect(cliOutcome.exitCode).toBe(3);
	});

	it("TOL-04 pana_reply requires after, as thread respond does", async () => {
		const seeded = await start({ capture: true });
		const first = seeded.sessions[0]!;

		const outcome = await runTool(t!, first.conversationId, "pana_reply", { thread: "01THREAD0000000000000000AA", body: "hi" });
		expect(outcome.isError).toBe(true);
		expect(JSON.stringify(outcome.diagnostics)).toContain("after");

		await expect(
			runPanaCli(["thread", "respond", "--thread", "01THREAD0000000000000000AA", "--body", "hi"], {
				endpoint: { socketPath: t!.panad.socketPath },
				caller: first.id,
			}),
		).rejects.toMatchObject({ exitCode: 2 });

		const reply = t!.runtime.registry.snapshot().extension("pana")!.tools!.find((tool) => tool.name === "pana_reply")!;
		const schema = reply.parameters as { required?: string[] };
		expect(schema.required).toContain("after");
	});
});

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function parseEnv(output: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const line of output.split("\n")) {
		const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
		if (match) env[match[1]!] = match[2]!;
	}
	return env;
}

