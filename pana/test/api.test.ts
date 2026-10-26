import { readFileSync, statSync } from "node:fs";
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

describe("API contract", () => {
	it("API-01 errors return {error: {code, message, ...details}}", async () => {
		const handlers: Handlers = {
			"threads.respond": () => {
				throw ApiError.stale("thread moved", { newer: ["01JB0000000000000000000001"] });
			},
			"threads.read": () => {
				throw new Error("boom");
			},
		};
		({ t } = await withSession(handlers));

		const stale = await t.client.post("/threads/X/messages", { body: "hi" });
		expect(stale.status).toBe(409);
		expect(stale.body).toEqual({ error: { code: "stale", message: "thread moved", newer: ["01JB0000000000000000000001"] } });

		const unbuilt = await t.client.post("/sessions", {});
		expect(unbuilt.status).toBe(501);
		expect(unbuilt.body).toEqual({ error: { code: "not_implemented", message: "sessions.create is not implemented yet", route: "sessions.create", wp: "WP3" } });

		const missing = await t.client.get("/nope");
		expect(missing.status).toBe(404);
		expect(missing.body).toMatchObject({ error: { code: "not_found", message: expect.any(String) } });

		const internal = await t.client.get("/threads/X");
		expect(internal.status).toBe(500);
		expect(internal.body).toEqual({ error: { code: "internal", message: "boom" } });

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
