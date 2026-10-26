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
	"pana session inbox SESSION",
	"pana session inbox read SESSION MESSAGE",
	"pana thread create --to ADDRS (--body TEXT | --body-file PATH | --body -) [--attach PATH...]",
	"pana thread respond --thread THREAD --after MESSAGE [--cc ADDRS] (--body ...) [--attach PATH...]",
	"pana thread read THREAD",
	"pana thread read --message MESSAGE",
	"pana thread subject THREAD [--regenerate]",
	"pana thread search --query TEXT",
	"pana memory",
	"pana memory search TEXT",
	"pana memory commit -m MSG",
	"pana memory log [PATH]",
	'pana schedule session create --cron "0 22 * * 1-5" --prompt TEXT',
	"pana schedule session create --at 2026-10-25T18:26:14Z --prompt TEXT",
	"pana schedule thread create --at 2026-10-25T18:26:14Z --to ADDRS --body-file PATH",
	"pana schedule list [--kind session|thread]",
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
			[["thread", "search"], "missing required flag --query"],
			[["session", "show"], "missing SESSION"],
			[["memory", "search"], "missing TEXT"],
			[["thread", "read", "A", "B"], "unexpected argument B"],
			[["thread", "read", "A", "--message", "B"], "not both"],
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

	it("thread create uploads attachments and appends a Markdown reference", async () => {
		const uploads: Array<{ headers: Record<string, string | string[] | undefined>; bytes: number }> = [];
		const t = await start({
			handlers: {
				"files.upload": (request) => {
					uploads.push({ headers: request.headers, bytes: request.rawBody.byteLength });
					const name = decodeURIComponent(String(request.headers["x-pana-filename"]));
					return { status: 201, body: { file: { id: "01JBFILE", name, url: `pana://${TEST_DOMAIN}/files/01JBFILE/${name}` } } };
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
