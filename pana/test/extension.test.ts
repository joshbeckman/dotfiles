// ISO, PRM, and TOL: the pana extension's registry, system prompt, and tools.
//
// Every tool is exercised through a real pi-durable run (a capture tool makes a nested call),
// so the test sees the structuredOutput a program would. The API is a fake handler set for
// the routes WP2, WP3, and WP5 own (test/fixtures/extension.ts).

import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Registry } from "@earendil-works/pi-durable";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPanaRegistry, runPanaCli } from "../src/extension/index.ts";
import { PANA_ENV_NAMES } from "../src/extension/env.ts";
import { FAUX_MODEL, startTestPanad, TEST_DOMAIN, TEST_USER, type TestPanad } from "./harness/index.ts";
import { seedThread, type Fixture } from "./harness/wake-fixture.ts";
import { captureExtension, contextOf, conversationOf, fakeApi, promptSections, promptText, runTool } from "./fixtures/extension.ts";

const PANA_TOOLS = [
	"pana_reply",
	"pana_thread_read",
	"pana_thread_create",
	"pana_session_create",
	"pana_memory_search",
	"pana_memory_commit",
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
	return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
}

function makeRepo(): string {
	const repo = tempDir("pana-repo-");
	git(repo, ["init", "-q"]);
	git(repo, ["config", "user.name", "tester"]);
	git(repo, ["config", "user.email", `tester@${TEST_DOMAIN}`]);
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

	it("ISO-03 bash runs with exactly PATH, HOME, USER, LANG, TERM=dumb, PANA_SESSION, and GIT_CONFIG_*", async () => {
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
		expect(env.GIT_CONFIG_COUNT).toBe("1");
		expect(env.GIT_CONFIG_KEY_0).toBe("core.hooksPath");
		expect(env.GIT_CONFIG_VALUE_0).toBe(t!.runtime.paths.hooks);
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
	it("TOL-01 the six pana tools are installed", async () => {
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

function parseEnv(output: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const line of output.split("\n")) {
		const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
		if (match) env[match[1]!] = match[2]!;
	}
	return env;
}

