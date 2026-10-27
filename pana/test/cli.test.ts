import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "../src/api/errors.ts";
import type { Handler, Handlers } from "../src/api/types.ts";
import { main, type CliIo } from "../src/cli/index.ts";
import { startTestPanad, TEST_DOMAIN, TEST_USER, type TestPanad } from "./harness/index.ts";

/** Every command line from README.md's command sections (CLI-06). */
const README_COMMANDS = [
	"pana session create --prompt TEXT [--model M] [--thinking LEVEL] [--cwd DIR] [--profile NAME] [--to ADDRS]",
	"pana session show SESSION",
	"pana session search [--query TEXT] [--state STATE] [--parent SESSION]",
	"pana session stop SESSION",
	"pana session resume SESSION",
	"pana session compact SESSION",
	"pana session archive SESSION",
	"pana session inbox SESSION",
	"pana session inbox read SESSION MESSAGE",
	"pana thread create --to ADDRS (--body TEXT | --body-file PATH | --body -) [--attach PATH...]",
	"pana thread respond --thread THREAD --after MESSAGE [--cc ADDRS] (--body ...) [--attach PATH...]",
	"pana thread read THREAD",
	"pana thread read --message MESSAGE",
	"pana thread subject THREAD [--regenerate]",
	"pana thread archive THREAD",
	"pana thread unarchive THREAD",
	"pana thread search [--query TEXT] [--archived] [--unread]",
	"pana memory",
	"pana memory search TEXT",
	"pana memory commit -m MSG",
	"pana memory log [PATH]",
	'pana schedule session create --cron "0 22 * * 1-5" --prompt TEXT [--check COMMAND] [--check-cwd DIR] [--stop-after-success]',
	"pana schedule session create --at 2026-10-25T18:26:14Z --prompt TEXT",
	"pana schedule thread create --at 2026-10-25T18:26:14Z --to ADDRS --body-file PATH",
	'pana schedule thread create --cron "*/5 * * * *" --to ADDRS --body TEXT [--check COMMAND] [--check-cwd DIR] [--stop-after-success]',
	"pana schedule wake --in 10m --note TEXT [--session SESSION]",
	"pana schedule wake --at 2026-10-25T18:26:14Z --note TEXT",
	'pana schedule wake --cron "*/5 * * * *" --note TEXT [--check COMMAND] [--check-cwd DIR] [--stop-after-success]',
	"pana schedule list [--kind session|thread|wake]",
	"pana schedule delete SCHEDULE",
];

const opened: TestPanad[] = [];
const servers: Array<() => Promise<void>> = [];
const dirs: string[] = [];

afterEach(async () => {
	for (const close of servers.splice(0)) await close();
	for (const t of opened.splice(0)) await t.close().catch(() => {});
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function start(options: Parameters<typeof startTestPanad>[0] = {}): Promise<TestPanad> {
	const t = await startTestPanad(options);
	opened.push(t);
	return t;
}

interface Run {
	code: number;
	stdout: string;
	stderr: string;
}

async function run(argv: string[], t: TestPanad | undefined, io: Partial<CliIo> = {}): Promise<Run> {
	let stdout = "";
	let stderr = "";
	const code = await main(argv, {
		env: { PANA_STATE: t?.dir ?? join(tmpdir(), "pana-cli-no-panad") },
		stdin: Readable.from([]),
		stdout: { write: (chunk) => (stdout += chunk), isTTY: true },
		stderr: { write: (chunk) => (stderr += chunk), isTTY: true },
		...io,
	});
	return { code, stdout, stderr };
}

/** A panad with a session row, so `Pana-Caller` can name it. */
async function withSession(handlers: Handlers): Promise<{ t: TestPanad; session: string }> {
	const t = await start({ handlers });
	const session = t.runtime.newId();
	const now = t.clock.now();
	await t.runtime.db.write(async (tx) => {
		await tx.run(
			"INSERT INTO participants (id, kind, url, created_at) VALUES (?, 'session', ?, ?)",
			session,
			t.runtime.url({ kind: "session", id: session }),
			now,
		);
		await tx.run("INSERT INTO sessions (id, state, depth, created_at, updated_at) VALUES (?, 'idle', 0, ?, ?)", session, now, now);
	});
	return { t, session };
}

describe("pana CLI", () => {
	it("CLI-01 pana talks only to the socket, and exits 1 with `panad is not running` without one", async () => {
		// A TCP server stands where panad's HTTP listener would be. The CLI must still refuse to
		// use it: only the socket counts.
		const dir = mkdtempSync(join(tmpdir(), "pana-cli-tcp-"));
		dirs.push(dir);
		let tcpHits = 0;
		const server = createServer((_req, res) => {
			tcpHits++;
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ via: "tcp" }));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as AddressInfo).port;
		writeFileSync(join(dir, "config.json"), JSON.stringify({ domain: TEST_DOMAIN, user: TEST_USER, http: { port } }));
		servers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

		const without = await run(["thread", "search", "--query", "x"], undefined, { env: { PANA_STATE: dir } });
		expect(without.code).toBe(1);
		expect(without.stderr).toContain("panad is not running");
		expect(tcpHits).toBe(0);

		// With panad listening on the socket, the same command reaches it.
		let seen: Record<string, unknown> | undefined;
		const t = await start({
			handlers: {
				"threads.search": (request) => {
					seen = { caller: request.caller.url, transport: request.transport };
					return { status: 200, body: { threads: [] } };
				},
			},
		});
		const withPanad = await run(["thread", "search", "--query", "x"], t);
		expect(withPanad.code).toBe(0);
		expect(seen).toEqual({ caller: t.runtime.userUrl, transport: "socket" });
	});

	it("CLI-02 pana sends Pana-Caller from PANA_SESSION when set", async () => {
		const { t, session } = await withSession({
			"inbox.list": (request) => ({ status: 200, body: { caller: request.caller } }),
		});
		const sessionUrl = t.runtime.url({ kind: "session", id: session });

		const asUser = await run(["session", "inbox", session, "--json"], t);
		expect(asUser.code).toBe(0);
		expect(JSON.parse(asUser.stdout)).toEqual({ caller: { kind: "user", id: TEST_USER, url: t.runtime.userUrl } });

		const asSession = await run(["session", "inbox", session, "--json"], t, {
			env: { PANA_STATE: t.dir, PANA_SESSION: session },
		});
		expect(asSession.code).toBe(0);
		expect(JSON.parse(asSession.stdout)).toEqual({ caller: { kind: "session", id: session, url: sessionUrl } });

		// A session URL is accepted too, as API-03 allows.
		const asUrl = await run(["session", "inbox", session, "--json"], t, {
			env: { PANA_STATE: t.dir, PANA_SESSION: sessionUrl },
		});
		expect(JSON.parse(asUrl.stdout)).toEqual({ caller: { kind: "session", id: session, url: sessionUrl } });
	});

	it("CLI-03 output is text on a TTY and JSON otherwise, and --json forces JSON", async () => {
		const handlers: Handlers = {
			"threads.read": () => ({ status: 200, body: { id: "01JBTHREAD", subject: "Paris", participants: ["tester"] } }),
		};
		const t = await start({ handlers });

		const tty = await run(["thread", "read", "01JBTHREAD"], t);
		expect(tty.code).toBe(0);
		expect(tty.stdout).toContain("subject: Paris");
		expect(tty.stdout).not.toContain("{");
		expect(() => JSON.parse(tty.stdout)).toThrow();

		let piped = "";
		const pipedRun = await run(["thread", "read", "01JBTHREAD"], t, {
			stdout: { write: (chunk) => (piped += chunk), isTTY: false },
		});
		expect(pipedRun.code).toBe(0);
		expect(JSON.parse(piped)).toEqual({ id: "01JBTHREAD", subject: "Paris", participants: ["tester"] });

		const forced = await run(["--json", "thread", "read", "01JBTHREAD"], t);
		expect(JSON.parse(forced.stdout)).toEqual({ id: "01JBTHREAD", subject: "Paris", participants: ["tester"] });
	});

	it("CLI-04 --body, --body-file, and --body - are exclusive, and a required body is enforced", async () => {
		const bodies: unknown[] = [];
		const t = await start({
			handlers: {
				"threads.create": (request) => {
					bodies.push(request.body);
					return { status: 201, body: request.body };
				},
			},
		});

		const none = await run(["thread", "create", "--to", "someone"], t);
		expect(none.code).toBe(2);
		expect(none.stderr).toContain("body");

		const both = await run(["thread", "create", "--to", "someone", "--body", "hi", "--body-file", "x"], t);
		expect(both.code).toBe(2);
		expect(both.stderr).toContain("mutually exclusive");

		const inline = await run(["thread", "create", "--to", "someone", "--body", "inline body"], t);
		expect(inline.code).toBe(0);

		const dir = mkdtempSync(join(tmpdir(), "pana-cli-body-"));
		dirs.push(dir);
		const file = join(dir, "body.md");
		writeFileSync(file, "file body");
		const fromFile = await run(["thread", "create", "--to", "someone", "--body-file", file], t);
		expect(fromFile.code).toBe(0);

		const fromStdin = await run(["thread", "create", "--to", "someone", "--body", "-"], t, {
			stdin: Readable.from(["stdin body"]),
		});
		expect(fromStdin.code).toBe(0);

		// A body is required for every command that documents one.
		for (const argv of [
			["thread", "respond", "--thread", "T", "--after", "M"],
			["schedule", "thread", "create", "--at", "2026-10-25T18:26:14Z", "--to", "someone"],
		]) {
			const missing = await run(argv, t);
			expect(missing.code, argv.join(" ")).toBe(2);
			expect(missing.stderr, argv.join(" ")).toContain("body");
		}

		expect(bodies).toEqual([
			{ to: ["someone"], body: "inline body" },
			{ to: ["someone"], body: "file body" },
			{ to: ["someone"], body: "stdin body" },
		]);
	});

	it("CLI-05 exit codes follow API-02", async () => {
		const thrower = (error: ApiError) => () => {
			throw error;
		};
		const t = await start({
			handlers: {
				"sessions.show": thrower(ApiError.stale("stale head")),
				"sessions.stop": thrower(ApiError.badRequest("invalid", "bad")),
				"sessions.resume": thrower(ApiError.notFound("missing")),
				"sessions.compact": thrower(ApiError.overBudget("over")),
				"inbox.list": thrower(new ApiError(500, "internal", "boom")),
				"threads.read": thrower(ApiError.forbidden("no")),
				"threads.search": () => ({ status: 200, body: { threads: [] } }),
			},
		});

		expect((await run(["session", "show", "01JBS"], t)).code).toBe(3);
		expect((await run(["session", "stop", "01JBS"], t)).code).toBe(2);
		expect((await run(["session", "resume", "01JBS"], t)).code).toBe(4);
		expect((await run(["session", "compact", "01JBS"], t)).code).toBe(5);
		expect((await run(["session", "inbox", "01JBS"], t)).code).toBe(1);
		expect((await run(["thread", "read", "01JBT"], t)).code).toBe(1);
		expect((await run(["thread", "search", "--query", "x"], t)).code).toBe(0);
	});

	it("CLI-06 pana --help and pana <noun> --help list every command in the README", async () => {
		const root = await run(["--help"], undefined);
		expect(root.code).toBe(0);
		for (const command of README_COMMANDS) expect(root.stdout, command).toContain(command);

		for (const noun of ["session", "thread", "memory", "schedule"]) {
			const help = await run([noun, "--help"], undefined);
			expect(help.code).toBe(0);
			for (const command of README_COMMANDS.filter((line) => line.startsWith(`pana ${noun} `) || line === `pana ${noun}`)) {
				expect(help.stdout, `${noun}: ${command}`).toContain(command);
			}
		}

		// A leaf shows its flags.
		const leaf = await run(["thread", "respond", "--help"], undefined);
		expect(leaf.code).toBe(0);
		expect(leaf.stdout).toContain("--after MESSAGE");
		expect(leaf.stdout).toContain("--cc ADDRS");
	});

	it("CLI-07 unknown commands and flags exit 2 with usage", async () => {
		const t = await start({ handlers: { "threads.search": () => ({ status: 200, body: {} }) } });

		const cases: Array<[string[], string]> = [
			[["nope"], "unknown command"],
			[["session", "nope"], "unknown command"],
			[["session"], "needs a command"],
			[["thread", "search", "--bogus"], "unknown flag --bogus"],
			[["thread", "search", "-x"], "unknown flag -x"],
			[["thread", "search"], "give --query TEXT, --archived, or --unread"],
			[["session", "show"], "missing SESSION"],
			[["memory", "search"], "missing TEXT"],
			[["thread", "read", "A", "B"], "unexpected argument B"],
			[["thread", "read", "A", "--message", "B"], "THREAD or --message"],
			[["nope", "--help"], "unknown command"],
		];
		for (const [argv, message] of cases) {
			const result = await run(argv, t);
			expect(result.code, argv.join(" ")).toBe(2);
			expect(result.stderr, argv.join(" ")).toContain(message);
			expect(result.stderr, argv.join(" ")).toContain("usage: ");
		}
	});
});

describe("pana CLI routes", () => {
	it("routes each command to its API call, with the session as caller when PANA_SESSION is set", async () => {
		const calls: Array<{ route: string; query: Record<string, string> }> = [];
		const record = (route: string): Handler => (request) => {
			calls.push({ route, query: Object.fromEntries(request.query) });
			return { status: 200, body: { route, params: request.params } };
		};
		const { t, session } = await withSession({
			"sessions.create": (request) => {
				calls.push({ route: "sessions.create", query: {} });
				return { status: 201, body: { body: request.body } };
			},
			"sessions.search": record("sessions.search"),
			"sessions.show": record("sessions.show"),
			"sessions.transcript": record("sessions.transcript"),
			"sessions.stop": record("sessions.stop"),
			"sessions.resume": record("sessions.resume"),
			"sessions.compact": record("sessions.compact"),
			"inbox.list": record("inbox.list"),
			"messages.markRead": record("messages.markRead"),
			"threads.create": (request) => {
				calls.push({ route: "threads.create", query: {} });
				return { status: 201, body: { body: request.body } };
			},
			"threads.respond": (request) => {
				calls.push({ route: "threads.respond", query: {} });
				return { status: 201, body: { params: request.params, body: request.body } };
			},
			"threads.read": record("threads.read"),
			"messages.show": record("messages.show"),
			"threads.subject": (request) => {
				calls.push({ route: "threads.subject", query: {} });
				return { status: 200, body: { body: request.body } };
			},
			"threads.search": record("threads.search"),
			"memory.worktree": record("memory.worktree"),
			"memory.search": record("memory.search"),
			"memory.commit": record("memory.commit"),
			"memory.log": record("memory.log"),
			"schedules.create": (request) => {
				calls.push({ route: "schedules.create", query: {} });
				return { status: 201, body: { body: request.body } };
			},
			"schedules.list": record("schedules.list"),
			"schedules.delete": record("schedules.delete"),
		});
		const env = { PANA_STATE: t.dir, PANA_SESSION: session };

		const run1 = (argv: string[]) => run(argv, t, { env });

		expect((await run1(["session", "create", "--prompt", "hello", "--to", "a,b", "--model", "m"])).code).toBe(0);
		expect((await run1(["session", "show", "S1"])).code).toBe(0);
		expect((await run1(["session", "search", "--state", "idle"])).code).toBe(0);
		expect((await run1(["session", "stop", "S1"])).code).toBe(0);
		expect((await run1(["session", "resume", "S1"])).code).toBe(0);
		expect((await run1(["session", "compact", "S1"])).code).toBe(0);
		expect((await run1(["session", "inbox", "S1"])).code).toBe(0);
		expect((await run1(["session", "inbox", "read", "S1", "M1"])).code).toBe(0);
		expect((await run1(["thread", "create", "--to", "a", "--body", "hi"])).code).toBe(0);
		expect((await run1(["thread", "respond", "--thread", "T1", "--after", "M1", "--body", "hi"])).code).toBe(0);
		expect((await run1(["thread", "read", "T1"])).code).toBe(0);
		expect((await run1(["thread", "read", "--message", "M1"])).code).toBe(0);
		expect((await run1(["thread", "subject", "T1", "--regenerate"])).code).toBe(0);
		expect((await run1(["thread", "search", "--query", "x"])).code).toBe(0);
		expect((await run1(["memory"])).code).toBe(0);
		expect((await run1(["memory", "search", "x"])).code).toBe(0);
		expect((await run1(["memory", "commit", "-m", "msg"])).code).toBe(0);
		expect((await run1(["memory", "log", "a.md"])).code).toBe(0);
		expect((await run1(["schedule", "session", "create", "--cron", "0 22 * * 1-5", "--prompt", "p"])).code).toBe(0);
		expect((await run1(["schedule", "thread", "create", "--at", "2026-10-25T18:26:14Z", "--to", "a", "--body", "b"])).code).toBe(0);
		expect((await run1(["schedule", "list", "--kind", "session"])).code).toBe(0);
		expect((await run1(["schedule", "delete", "01JBSCH"])).code).toBe(0);

		expect(calls.map((call) => call.route)).toEqual([
			"sessions.create",
			"sessions.show",
			"sessions.search",
			"sessions.stop",
			"sessions.resume",
			"sessions.compact",
			"inbox.list",
			"messages.markRead",
			"threads.create",
			"threads.respond",
			"threads.read",
			"messages.show",
			"threads.subject",
			"threads.search",
			"memory.worktree",
			"memory.search",
			"memory.commit",
			"memory.log",
			"schedules.create",
			"schedules.create",
			"schedules.list",
			"schedules.delete",
		]);

		// The address list splits and the session inbox names its participant.
		const created = await run1(["--json", "session", "create", "--prompt", "hello", "--to", "a,b"]);
		expect(JSON.parse(created.stdout)).toEqual({
			body: { prompt: "hello", model: undefined, thinking: undefined, cwd: undefined, profile: undefined, to: ["a", "b"] },
		});
	});

	it("schedule create rejects both or neither of --cron and --at", async () => {
		const t = await start({ handlers: { "schedules.create": () => ({ status: 201, body: {} }) } });
		expect((await run(["schedule", "session", "create", "--prompt", "p"], t)).code).toBe(2);
		expect(
			(await run(["schedule", "session", "create", "--cron", "* * * * *", "--at", "2026-01-01T00:00:00Z", "--prompt", "p"], t)).code,
		).toBe(2);
	});

	it("schedule selectors ignore blanks in validation and API payloads for every kind", async () => {
		const t = await start({ handlers: { "schedules.create": (request) => ({ status: 201, body: request.body }) } });
		for (const command of [
			["schedule", "session", "create", "--prompt", "p"],
			["schedule", "thread", "create", "--to", "a", "--body", "b"],
			["schedule", "wake", "--note", "n"],
		]) {
			const selectors = command[1] === "wake" ? ["in", "at", "cron"] : ["at", "cron"];
			const values: Record<string, string> = { in: "5m", at: "2027-01-01T00:00:00Z", cron: "* * * * *" };
			for (const selected of selectors) {
				for (const blank of ["", " \t "]) {
					const options = selectors.flatMap((key) => [`--${key}`, key === selected ? values[key]! : blank]);
					const result = await run([...command, ...options, "--json"], t);
					expect(result.code).toBe(0);
					const body = JSON.parse(result.stdout);
					expect(body[selected]).toBe(values[selected]);
					for (const unused of selectors.filter((key) => key !== selected)) expect(body).not.toHaveProperty(unused);
				}
			}
			const missing = await run([...command, ...selectors.flatMap((key) => [`--${key}`, " \t "])], undefined);
			expect(missing.code).toBe(2);
			expect(missing.stderr).toContain("Provide one schedule selector:");
			const conflict = await run([...command, "--at", values.at!, "--cron", values.cron!], undefined);
			expect(conflict.code).toBe(2);
			expect(conflict.stderr).toContain("Conflicting schedule selectors:");
			expect(conflict.stderr).toContain("--at");
			expect(conflict.stderr).toContain("--cron");
			const check = await run([...command, "--at", values.at!, "--cron", " ", "--check", "true"], undefined);
			expect(check.code).toBe(2);
			expect(check.stderr).toContain("require --cron");
		}
	});

	it("SCH-09 CLI forwards recurring check options for every kind and leaves cwd defaulting to panad", async () => {
		const t = await start({ handlers: { "schedules.create": (request) => ({ status: 201, body: request.body }) } });
		const kinds = [
			{ command: ["schedule", "session", "create"], args: ["--prompt", "p"], kind: "session" },
			{ command: ["schedule", "thread", "create"], args: ["--to", "a", "--body", "b"], kind: "thread" },
			{ command: ["schedule", "wake"], args: ["--note", "n", "--session", "S"], kind: "wake" },
		];
		for (const { command, args, kind } of kinds) {
			const result = await run([...command, ...args, "--cron", "*/5 * * * *", "--check", "test -f ready", "--check-cwd", tmpdir(), "--stop-after-success", "--json"], t);
			expect(result.code).toBe(0);
			expect(JSON.parse(result.stdout)).toMatchObject({ kind, cron: "*/5 * * * *", check: "test -f ready", checkCwd: tmpdir(), stopAfterSuccess: true });
			const defaults = await run([...command, ...args, "--cron", "* * * * *", "--check", "true", "--json"], t);
			expect(defaults.code).toBe(0);
			expect(JSON.parse(defaults.stdout)).not.toHaveProperty("checkCwd");
			const noCheck = await run([...command, ...args, "--cron", "* * * * *", "--stop-after-success", "--json"], t);
			expect(noCheck.code).toBe(0);
			expect(JSON.parse(noCheck.stdout)).toMatchObject({ stopAfterSuccess: true });
		}
	});

	it("SCH-09 CLI rejects invalid check options and timing combinations before dispatch", async () => {
		const commands = [
			["schedule", "session", "create", "--prompt", "p"],
			["schedule", "thread", "create", "--to", "a", "--body", "b"],
			["schedule", "wake", "--note", "n"],
		];
		for (const command of commands) {
			for (const options of [
				[],
				["--cron", "* * * * *", "--at", "2027-01-01T00:00:00Z"],
				["--at", "2027-01-01T00:00:00Z", "--check", "true"],
				["--at", "2027-01-01T00:00:00Z", "--stop-after-success"],
				["--cron", "* * * * *", "--check", " "],
				["--cron", "* * * * *", "--check", "true", "--check-cwd", "relative"],
				["--cron", "* * * * *", "--check-cwd", tmpdir()],
			]) expect((await run([...command, ...options], undefined)).code).toBe(2);
		}
		for (const options of [
			["--in", "10m", "--cron", "* * * * *"],
			["--in", "10m", "--at", "2027-01-01T00:00:00Z"],
			["--in", "10m", "--check", "true"],
		]) expect((await run(["schedule", "wake", "--note", "n", ...options], undefined)).code).toBe(2);
	});

	it("the user can read any inbox, and the caller is the user without PANA_SESSION", async () => {
		const t = await start({ handlers: { "inbox.list": (request) => ({ status: 200, body: { caller: request.caller } }) } });
		const result = await run(["session", "inbox", "01JBSESSION", "--json"], t);
		expect(JSON.parse(result.stdout)).toEqual({ caller: { kind: "user", id: TEST_USER, url: `pana://${TEST_DOMAIN}/users/${TEST_USER}` } });
	});

	it("a failed run of a session command reports the API's error message", async () => {
		const t = await start({
			handlers: {
				"threads.read": () => {
					throw ApiError.stale("thread moved", { newer: ["01JBX"] });
				},
			},
		});
		const text = await run(["thread", "read", "T1"], t);
		expect(text.stderr).toContain("thread moved");

		const asJson = await run(["--json", "thread", "read", "T1"], t);
		expect(JSON.parse(asJson.stderr)).toEqual({ error: { code: "stale", message: "thread moved", newer: ["01JBX"] } });
	});

	it("covers the WP5 memory and WP7 search route shapes", async () => {
		const seen: Array<{ route: string; query: Record<string, string>; body: unknown }> = [];
		const record = (route: string, body: unknown): Handler => (request) => {
			seen.push({ route, query: Object.fromEntries(request.query), body: request.body });
			return { status: 200, body };
		};
		const worktree = {
			caller: `pana://${TEST_DOMAIN}/users/${TEST_USER}`,
			path: "/state/memory/worktrees/tester",
			branch: "writer/tester",
			repo: "/state/memory.git",
			created: false,
		};
		const commit = { branch: "writer/tester", commit: { hash: "abc123", authorUrl: worktree.caller, email: "x", time: "t", message: "m" }, reused: false };
		const threadHit = {
			threadId: "01JBTHREAD",
			threadUrl: `pana://${TEST_DOMAIN}/threads/01JBTHREAD`,
			subject: "Paris",
			messageId: "01JBMESSAGE",
			messageUrl: `pana://${TEST_DOMAIN}/threads/01JBTHREAD?message=01JBMESSAGE`,
			snippet: "the [capital] of France",
			matched: "message",
			createdAt: 0,
		};
		const t = await start({
			handlers: {
				"memory.worktree": record("memory.worktree", worktree),
				"memory.search": record("memory.search", { tree: "main", query: "paris", matches: [{ path: "places.md", line: 4, text: "Paris" }] }),
				"memory.commit": record("memory.commit", commit),
				"memory.log": record("memory.log", { tree: "main", path: null, commits: [commit.commit] }),
				"threads.search": record("threads.search", { threads: [threadHit] }),
				"threads.subject": record("threads.subject", { threadUrl: threadHit.threadUrl, subject: "Paris", history: [] }),
			},
		});

		// `pana memory` prints the path alone, so a shell can use it.
		const worktreeRun = await run(["memory"], t);
		expect(worktreeRun.code).toBe(0);
		expect(worktreeRun.stdout).toBe(`${worktree.path}\n`);

		expect((await run(["memory", "search", "paris"], t)).code).toBe(0);
		expect((await run(["memory", "commit", "-m", "note"], t)).code).toBe(0);
		expect((await run(["memory", "log", "places.md"], t)).code).toBe(0);
		expect((await run(["thread", "search", "--query", "paris"], t)).code).toBe(0);
		expect((await run(["--json", "thread", "subject", "01JBTHREAD"], t)).code).toBe(0);
		expect((await run(["thread", "subject", "01JBTHREAD", "--regenerate"], t)).code).toBe(0);

		expect(seen).toEqual([
			{ route: "memory.worktree", query: {}, body: undefined },
			{ route: "memory.search", query: { query: "paris" }, body: undefined },
			{ route: "memory.commit", query: {}, body: { message: "note" } },
			{ route: "memory.log", query: { path: "places.md" }, body: undefined },
			{ route: "threads.search", query: { query: "paris" }, body: undefined },
			{ route: "threads.subject", query: {}, body: { regenerate: false } },
			{ route: "threads.subject", query: {}, body: { regenerate: true } },
		]);

		// Thread hits arrive in the shape WP7 returns, so the JSON mode is a passthrough.
		const asJson = await run(["--json", "thread", "search", "--query", "paris"], t);
		expect(JSON.parse(asJson.stdout)).toEqual({ threads: [threadHit] });
	});

	it("runs thread create, respond, and a stale respond end to end", async () => {
		const t = await start();

		const created = await run(["--json", "thread", "create", "--to", "friend", "--body", "hello there"], t);
		expect(created.code).toBe(0);
		const thread = JSON.parse(created.stdout) as { thread: { id: string }; message: { id: string } };
		expect(thread.thread.id).toMatch(/^[0-9A-Z]{26}$/);

		const responded = await run(
			["--json", "thread", "respond", "--thread", thread.thread.id, "--after", thread.message.id, "--body", "second"],
			t,
		);
		expect(responded.code).toBe(0);
		const second = JSON.parse(responded.stdout) as { message: { id: string; body: string } };
		expect(second.message.body).toBe("second");

		// The head moved, so the same `--after` is stale: exit 3 and nothing is appended.
		const stale = await run(
			["thread", "respond", "--thread", thread.thread.id, "--after", thread.message.id, "--body", "third"],
			t,
		);
		expect(stale.code).toBe(3);
		expect(stale.stderr).toContain("moved");

		const read = await run(["--json", "thread", "read", thread.thread.id], t);
		expect(read.code).toBe(0);
		const bodies = (JSON.parse(read.stdout) as { messages: Array<{ body: string }> }).messages.map((message) => message.body);
		expect(bodies).toEqual(["hello there", "second"]);
	});

	it("a memory conflict exits 3", async () => {
		const t = await start({
			handlers: {
				"memory.commit": () => {
					throw ApiError.stale("memory conflict", { paths: ["places.md"] });
				},
			},
		});
		const result = await run(["memory", "commit", "-m", "note"], t);
		expect(result.code).toBe(3);
		expect(result.stderr).toContain("memory conflict");
	});

	it("thread create uploads attachments and appends a Markdown reference", async () => {
		const uploads: Array<{ headers: Record<string, string | string[] | undefined>; bytes: number }> = [];
		const t = await start({
			handlers: {
				"files.upload": (request) => {
					uploads.push({ headers: request.headers, bytes: request.rawBody.byteLength });
					const name = request.query.get("name")!;
					const mediaType = String(request.headers["content-type"]);
					return {
						status: 201,
						body: { file: { id: "01JBFILE", name, url: `pana://${TEST_DOMAIN}/files/01JBFILE/${name}`, mediaType } },
					};
				},
				"threads.create": (request) => ({ status: 201, body: request.body }),
			},
		});
		const dir = mkdtempSync(join(tmpdir(), "pana-cli-attach-"));
		dirs.push(dir);
		const image = join(dir, "pixel.png");
		const text = join(dir, "notes.txt");
		writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
		writeFileSync(text, "hello");

		const result = await run(["--json", "thread", "create", "--to", "a", "--body", "look", "--attach", image, "--attach", text], t);
		expect(result.code).toBe(0);
		expect(uploads.map((upload) => upload.bytes)).toEqual([4, 5]);
		expect(uploads[0]!.headers["content-type"]).toBe("image/png");
		expect(uploads[1]!.headers["content-type"]).toBe("text/plain");
		expect(JSON.parse(result.stdout)).toEqual({
			to: ["a"],
			body:
				"look\n\n" +
				`![pixel.png](pana://${TEST_DOMAIN}/files/01JBFILE/pixel.png)\n` +
				`[notes.txt](pana://${TEST_DOMAIN}/files/01JBFILE/notes.txt)`,
		});
	});
});

describe("pana CLI references", () => {
	it("ID-02 every command accepts a pana:// URL wherever it accepts a bare ID", async () => {
		const seen: Array<Record<string, string>> = [];
		const record: Handler = (request) => {
			seen.push({ ...request.params, ...Object.fromEntries(request.query) });
			return { status: 200, body: {} };
		};
		const t = await start({
			handlers: {
				"threads.read": record,
				"messages.show": record,
				"threads.subject": record,
				"sessions.show": record,
				"schedules.delete": record,
				"inbox.list": record,
			},
		});
		const thread = "01JB0000000000000000000001";
		const message = "01JB0000000000000000000002";
		const session = "01JB0000000000000000000003";
		const base = `pana://${TEST_DOMAIN}`;
		const env = { env: { PANA_STATE: t.dir } };

		for (const argv of [
			["thread", "read", `${base}/threads/${thread}`],
			["thread", "read", `${base}/threads/${thread}?message=${message}`],
			["thread", "read", "--message", `${base}/threads/${thread}?message=${message}`],
			["thread", "subject", `${base}/threads/${thread}`],
			["session", "show", `${base}/sessions/${session}`],
			["schedule", "delete", `${base}/schedules/${session}`],
			["session", "inbox", `${base}/sessions/${session}`],
		]) {
			expect((await run(argv, t, env)).code).toBe(0);
		}
		expect(seen.map((s) => s.id ?? s.participant)).toEqual([thread, thread, message, thread, session, session, session]);

		const wrongKind = await run(["session", "show", `${base}/threads/${thread}`], t, env);
		expect(wrongKind.code).toBe(2);
	});
});


it("SCH-15 schedule CLI forwards an optional display subject for every kind", async () => {
	const bodies: unknown[] = [];
	const t = await start({ handlers: { "schedules.create": ctx => {
		bodies.push(ctx.body);
		return { status: 201, body: {} };
	} } });
	for (const args of [
		["session", "create", "--cron", "0 9 * * *", "--prompt", "Description"],
		["thread", "create", "--cron", "0 9 * * *", "--to", "tester", "--body", "Description"],
		["wake", "--in", "10m", "--note", "Description", "--session", "S1"],
	]) {
		const result = await run(["schedule", ...args, "--subject", "Short label"], t);
		expect(result.code).toBe(0);
	}
	expect(bodies).toEqual([
		expect.objectContaining({ kind: "session", subject: "Short label", prompt: "Description" }),
		expect.objectContaining({ kind: "thread", subject: "Short label", body: "Description" }),
		expect.objectContaining({ kind: "wake", subject: "Short label", note: "Description" }),
	]);
});
