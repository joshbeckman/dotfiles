import { readFileSync, statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { request } from "../src/api/client.ts";
import { ApiError, statusToExitCode } from "../src/api/errors.ts";
import { matchRoute, ROUTES } from "../src/api/routes.ts";
import type { Handler, Handlers } from "../src/api/types.ts";
import { startTestPanad, TEST_DOMAIN, TEST_USER, type TestPanad } from "./harness/index.ts";

let t: TestPanad | undefined;
afterEach(async () => {
	await t?.close();
	t = undefined;
});

const whoami: Handler = (ctx) => ({ status: 200, body: { caller: ctx.caller, transport: ctx.transport } });

async function withSession(handlers: Handlers = {}, tailscaleNames?: string[]): Promise<{ t: TestPanad; session: string }> {
	t = await startTestPanad({ handlers: { "inbox.list": whoami, ...handlers }, tailscaleNames });
	const session = t.runtime.newId();
	const now = t.clock.now();
	await t.runtime.db.write(async (tx) => {
		await tx.run("INSERT INTO participants (id, kind, url, created_at) VALUES (?, 'session', ?, ?)", session, t!.runtime.url({ kind: "session", id: session }), now);
		await tx.run("INSERT INTO sessions (id, state, depth, created_at, updated_at) VALUES (?, 'idle', 0, ?, ?)", session, now, now);
	});
	return { t, session };
}

/**
 * A POST that declares a body and sends none of it. The status can only arrive if the daemon
 * answers before reading the body; a daemon that reads first never answers at all.
 */
function answerBeforeBody(endpoint: { host: string; port: number }, path: string, headers: Record<string, string>): Promise<number | undefined> {
	return new Promise((resolve, reject) => {
		const req = httpRequest({ ...endpoint, method: "POST", path, headers }, (res) => {
			res.resume();
			res.on("end", () => resolve(res.statusCode));
			res.on("error", reject);
		});
		req.on("error", reject);
		const timer = setTimeout(() => {
			req.destroy();
			resolve(undefined);
		}, 2000);
		req.on("close", () => clearTimeout(timer));
		req.flushHeaders();
	});
}

/** A chunked POST that sends `bytes` and then stops: the answer comes from mid-body. */
function answerMidBody(endpoint: { socketPath: string } | { host: string; port: number }, path: string, bytes: number): Promise<number | undefined> {
	return new Promise((resolve, reject) => {
		const req = httpRequest({ ...endpoint, method: "POST", path, headers: { "content-type": "application/json" } }, (res) => {
			res.resume();
			res.on("end", () => resolve(res.statusCode));
			res.on("error", reject);
		});
		req.on("error", reject);
		const timer = setTimeout(() => {
			req.destroy();
			resolve(undefined);
		}, 2000);
		req.on("close", () => clearTimeout(timer));
		// No content-length, so the daemon only learns the size as the chunks arrive.
		req.write(Buffer.alloc(bytes, 0x20));
	});
}

describe("API contract", () => {
	it("API-01 errors return {error: {code, message, ...details}}", async () => {
		const handlers: Handlers = {
			"threads.respond": () => {
				throw ApiError.stale("thread moved", { newer: ["01JB0000000000000000000001"] });
			},
			"threads.read": () => {
				throw new Error("boom");
			},
			// Every route is built now; pin one as unbuilt to check the 501 shape.
			"push.key": undefined,
		};
		({ t } = await withSession(handlers));

		const stale = await t.client.post("/threads/X/messages", { body: "hi" });
		expect(stale.status).toBe(409);
		expect(stale.body).toEqual({ error: { code: "stale", message: "thread moved", newer: ["01JB0000000000000000000001"] } });

		const unbuilt = await t.client.get("/push/key");
		expect(unbuilt.status).toBe(501);
		expect(unbuilt.body).toEqual({ error: { code: "not_implemented", message: "push.key is not implemented yet", route: "push.key", wp: "WP8" } });

		const missing = await t.client.get("/nope");
		expect(missing.status).toBe(404);
		expect(missing.body).toMatchObject({ error: { code: "not_found", message: expect.any(String) } });

		const internal = await t.client.get("/threads/X");
		expect(internal.status).toBe(500);
		// A 500 says that panad failed, never what it was doing: a message can name a path, a
		// query, or a subprocess's diagnostics (API-01). The detail goes to the local log.
		expect(internal.body).toEqual({ error: { code: "internal", message: "internal error" } });
		expect(t.reports).toContainEqual({ error: expect.objectContaining({ message: "boom" }), what: "request GET /threads/X" });

		const badJson = await request({ socketPath: t.panad.socketPath }, "POST", "/threads", {
			bytes: Buffer.from("{nope"),
			headers: { "content-type": "application/json" },
		});
		expect(badJson.status).toBe(400);
		expect(badJson.body).toMatchObject({ error: { code: "invalid_json" } });
	});

	it("API-02 status codes map to CLI exit codes", async () => {
		const table: Array<[number, number]> = [
			[200, 0],
			[201, 0],
			[204, 0],
			[400, 2],
			[404, 4],
			[409, 3],
			[402, 5],
			[401, 1],
			[403, 1],
			[500, 1],
			[501, 1],
			[503, 1],
		];
		for (const [status, code] of table) expect(statusToExitCode(status), String(status)).toBe(code);

		// The constructors carry the status each exit code depends on.
		expect(statusToExitCode(ApiError.badRequest("x", "x").status)).toBe(2);
		expect(statusToExitCode(ApiError.notFound("x").status)).toBe(4);
		expect(statusToExitCode(ApiError.stale("x").status)).toBe(3);
		expect(statusToExitCode(ApiError.overBudget("x").status)).toBe(5);
		expect(statusToExitCode(ApiError.forbidden("x").status)).toBe(1);
	});

	it("API-03 on the socket the caller is the Pana-Caller session or the configured user, and an unknown session returns 400", async () => {
		const { t, session } = await withSession();
		expect(statSync(t.panad.socketPath).mode & 0o777).toBe(0o600);

		const asUser = await t.client.get("/inbox");
		expect(asUser.body).toEqual({ caller: { kind: "user", id: TEST_USER, url: `pana://${TEST_DOMAIN}/users/${TEST_USER}` }, transport: "socket" });

		const sessionCaller = { kind: "session", id: session, url: `pana://${TEST_DOMAIN}/sessions/${session}` };
		expect((await t.client.get("/inbox", { caller: session })).body).toEqual({ caller: sessionCaller, transport: "socket" });
		expect((await t.client.get("/inbox", { caller: sessionCaller.url })).body).toEqual({ caller: sessionCaller, transport: "socket" });

		const unknown = await t.client.get("/inbox", { caller: t.runtime.newId() });
		expect(unknown.status).toBe(400);
		expect(unknown.body).toMatchObject({ error: { code: "unknown_caller" } });

		const foreign = await t.client.get("/inbox", { caller: `pana://other.example/sessions/${session}` });
		expect(foreign.status).toBe(400);
		expect(foreign.body).toMatchObject({ error: { code: "foreign_domain" } });

		const notSession = await t.client.get("/inbox", { caller: `pana://${TEST_DOMAIN}/users/${TEST_USER}` });
		expect(notSession.status).toBe(400);
		expect(notSession.body).toMatchObject({ error: { code: "invalid_caller" } });
	});

	it("API-04 on TCP every request needs the bearer web-token, and the caller is always the configured user", async () => {
		const { t, session } = await withSession();
		const token = readFileSync(join(t.dir, "web-token"), "utf8");
		const tcp = { host: "127.0.0.1", port: t.panad.tcpPort! };

		const none = await request(tcp, "GET", "/inbox");
		expect(none.status).toBe(403);
		expect(none.body).toMatchObject({ error: { code: "unauthorized" } });

		const wrong = await request({ ...tcp, token: `${token.slice(0, -1)}x` }, "GET", "/inbox");
		expect(wrong.status).toBe(403);
		const short = await request({ ...tcp, token: "x" }, "GET", "/inbox");
		expect(short.status).toBe(403);

		// A route that does not exist still requires the token first.
		expect((await request(tcp, "GET", "/nope")).status).toBe(403);

		const ok = await request({ ...tcp, token }, "GET", "/inbox", { caller: session });
		expect(ok.status).toBe(200);
		expect(ok.body).toEqual({ caller: { kind: "user", id: TEST_USER, url: `pana://${TEST_DOMAIN}/users/${TEST_USER}` }, transport: "tcp" });
	});

	it("API-05 TCP accepts Host 127.0.0.1, localhost, and the Tailscale name, and refuses any other Host with 403", async () => {
		const { t } = await withSession({}, ["lantern.tail1234.ts.net"]);
		const base = { host: "127.0.0.1", port: t.panad.tcpPort!, token: t.panad.webToken };
		for (const host of [`127.0.0.1:${base.port}`, "127.0.0.1", `localhost:${base.port}`, "LOCALHOST", "lantern.tail1234.ts.net", "lantern.tail1234.ts.net:443"]) {
			expect((await request({ ...base, hostHeader: host }, "GET", "/inbox")).status, host).toBe(200);
		}
		for (const host of ["evil.example", `evil.example:${base.port}`, "127.0.0.1.evil.example", "[::1]", "lantern"]) {
			const res = await request({ ...base, hostHeader: host }, "GET", "/inbox");
			expect(res.status, host).toBe(403);
			expect(res.body).toMatchObject({ error: { code: "forbidden_host" } });
		}
	});

	it("API-06 a body is read only after the caller is resolved and never past files.maxBytes, and a refused upload keeps FIL-03's 400", async () => {
		const LIMIT = 1024;
		t = await startTestPanad({
			config: { files: { maxBytes: LIMIT } },
			// Echo the size so a body at the limit is visibly read in full.
			handlers: { "threads.create": (ctx) => ({ status: 201, body: { bytes: ctx.rawBody.length } }) },
		});
		const base = { host: "127.0.0.1", port: t.panad.tcpPort! };

		// A body declared and never sent. A daemon that read the body before the caller would never
		// answer; this one answers with the caller's refusal and buffers none of it.
		const early = await answerBeforeBody(base, "/threads", {
			"content-type": "application/json",
			"content-length": String(64 * 1024 * 1024),
		});
		expect(early).toBe(403);

		// The same limit over a stream: refused at the byte that crosses it, mid-body.
		expect(await answerMidBody({ socketPath: t.panad.socketPath }, "/threads", LIMIT * 2)).toBe(413);

		const exact = { to: [TEST_USER], body: "" };
		const pad = (bytes: number): Buffer => {
			const head = `${JSON.stringify(exact).slice(0, -1)},"pad":"`;
			return Buffer.from(`${head}${"a".repeat(bytes - head.length - 2)}"}`);
		};
		const atLimit = pad(LIMIT);
		expect(atLimit.length).toBe(LIMIT);
		const read = await request({ socketPath: t.panad.socketPath }, "POST", "/threads", {
			bytes: atLimit,
			headers: { "content-type": "application/json" },
		});
		expect(read.status).toBe(201);
		expect(read.body).toEqual({ bytes: LIMIT });

		const over = Buffer.concat([atLimit, Buffer.from(" ")]);
		const refused = await request({ socketPath: t.panad.socketPath }, "POST", "/threads", {
			bytes: over,
			headers: { "content-type": "application/json" },
		});
		expect(refused.status).toBe(413);
		expect(refused.body).toEqual({ error: { code: "payload_too_large", message: `request body is over the ${LIMIT} byte limit`, maxBytes: LIMIT } });
		expect(statusToExitCode(refused.status)).toBe(1);

		// FIL-03 keeps its own answer: an upload past its limit is a 400, and nothing is copied.
		const upload = await request({ socketPath: t.panad.socketPath }, "POST", "/files?name=big.bin", {
			bytes: Buffer.alloc(LIMIT + 1, 7),
		});
		expect(upload.status).toBe(400);
		expect(upload.body).toMatchObject({ error: { code: "file_too_large", maxBytes: LIMIT } });
	});

	it("API route table covers every route in the SPEC.md API table", () => {
		const spec = readFileSync(join(import.meta.dirname, "..", "SPEC.md"), "utf8");
		const rows = spec.split("\n").filter((line) => /^\| (GET|POST|DELETE)/.test(line));
		expect(rows.length).toBeGreaterThan(15);
		const concrete = (path: string) => path.replace(/:\w+/g, "X").replace("*", "a/b.md");
		for (const row of rows) {
			const [, methodCell, routeCell] = row.split("|").map((cell) => cell.trim());
			const methods = methodCell!.split(",").map((m) => m.trim());
			const items = [...routeCell!.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
			const first = items[0]!;
			const firstSegments = first.split("/").filter(Boolean);
			const paths = items.map((item) => {
				const segments = item.split("/").filter(Boolean);
				// `/sessions/:id/stop`, `/resume` means `/sessions/:id/resume`.
				return segments.length === 1 && firstSegments.length >= 3 ? `/${[...firstSegments.slice(0, -1), segments[0]].join("/")}` : item;
			});
			for (const path of paths) {
				expect(methods.some((m) => matchRoute(m, concrete(path))), `${methods} ${path}`).toBe(true);
			}
			for (const method of methods) {
				expect(paths.some((p) => matchRoute(method, concrete(p))), `${method} ${routeCell}`).toBe(true);
			}
		}
		// Every handler name is unique, so packages cannot collide.
		expect(new Set(ROUTES.map((r) => r.name)).size).toBe(ROUTES.length);
	});
});
