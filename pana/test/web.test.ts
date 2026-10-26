import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { request } from "../src/api/client.ts";
import { matchRoute } from "../src/api/routes.ts";
import { publish, subscriberCount } from "../src/web/events.ts";
import { launchUrl, loopbackOrigin } from "../src/web/static.ts";
import { appHref, CONFIRM_EDIT, CONFIRM_REDACT, newDraft, notificationTarget, routeFromHash, SECTIONS, tokenFromInput } from "../web/links.js";
import { makeStateDir, startTestPanad, TEST_DOMAIN, type TestPanad } from "./harness/index.ts";

let t: TestPanad | undefined;
afterEach(async () => {
	await t?.close();
	t = undefined;
});

const panadBin = fileURLToPath(new URL("../bin/panad", import.meta.url));

/** Minimal SSE reader: collect frames and wait for a substring. */
function openSse(port: number, token: string): { waitFor(needle: string, timeoutMs?: number): Promise<string>; close(): void } {
	let buffer = "";
	const waiters: Array<{ needle: string; resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }> = [];
	const req = httpRequest({
		host: "127.0.0.1",
		port,
		path: "/events",
		headers: { authorization: `Bearer ${token}`, host: `127.0.0.1:${port}`, accept: "text/event-stream" },
	});
	req.on("response", (res: IncomingMessage) => {
		res.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			for (const waiter of [...waiters]) {
				if (!buffer.includes(waiter.needle)) continue;
				clearTimeout(waiter.timer);
				waiters.splice(waiters.indexOf(waiter), 1);
				waiter.resolve();
			}
		});
	});
	req.end();
	return {
		waitFor(needle, timeoutMs = 5000) {
			if (buffer.includes(needle)) return Promise.resolve(buffer);
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`SSE did not contain ${needle}; got ${buffer}`)), timeoutMs);
				waiters.push({ needle, resolve: () => resolve(buffer), reject, timer });
			});
		},
		close() {
			for (const waiter of waiters.splice(0)) {
				clearTimeout(waiter.timer);
				waiter.reject(new Error("closed"));
			}
			req.destroy();
		},
	};
}

/** Wait for a child's stderr to contain a line matching a pattern. */
function waitForLine(child: ReturnType<typeof spawn>, pattern: RegExp): Promise<RegExpExecArray> {
	return new Promise((resolve, reject) => {
		let text = "";
		const timer = setTimeout(() => reject(new Error(`no line matching ${pattern}; got ${text}`)), 15_000);
		child.stderr?.on("data", (chunk: Buffer) => {
			text += chunk.toString("utf8");
			const match = pattern.exec(text);
			if (!match) return;
			clearTimeout(timer);
			resolve(match);
		});
		child.once("exit", (code) => {
			if (pattern.test(text)) return;
			clearTimeout(timer);
			reject(new Error(`panad exited ${code} before printing the launch URL; got ${text}`));
		});
	});
}

describe("PWA shell and static assets", () => {
	it("WEB-01 panad serves the PWA at / on TCP and prints a launch URL with the token in the fragment", async () => {
		t = await startTestPanad();
		const port = t.panad.tcpPort!;

		const page = await request({ host: "127.0.0.1", port }, "GET", "/");
		expect(page.status).toBe(200);
		expect(String(page.raw)).toContain('<title>pana</title>');
		expect(String(page.raw)).toContain('id="view-inbox"');
		expect(page.headers["content-type"]).toContain("text/html");
		expect(page.headers["content-security-policy"]).toContain("script-src 'self'");
		expect(page.headers["content-security-policy"]).not.toContain("unsafe-eval");

		// The shell does not need the token, but unknown paths still do (API-04).
		expect((await request({ host: "127.0.0.1", port }, "GET", "/app.js")).status).toBe(200);
		expect((await request({ host: "127.0.0.1", port }, "GET", "/nope")).status).toBe(403);
		expect((await request({ host: "127.0.0.1", port, token: t.panad.webToken }, "GET", "/nope")).status).toBe(404);

		const url = launchUrl(loopbackOrigin(port), t.panad.webToken);
		expect(url).toBe(`http://localhost:${port}/#${t.panad.webToken}`);

		// The real entry point prints that URL and keeps the token out of the path.
		const dir = makeStateDir({ http: { port: 0 } });
		const child = spawn(process.execPath, [panadBin], { env: { ...process.env, PANA_STATE: dir } });
		try {
			const match = await waitForLine(child, /panad: open (http:\/\/localhost:(\d+)\/#(\S+))/);
			const [, , printedPort, printedToken] = match;
			expect(printedToken).toBe(readFileSync(join(dir, "web-token"), "utf8").trim());
			expect(Number(printedPort)).toBeGreaterThan(0);
			child.kill("SIGTERM");
			await new Promise((resolve) => child.once("exit", resolve));
		} finally {
			child.kill("SIGKILL");
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("WEB-02 the token round-trips from a launch URL and the shell carries an authorize panel", async () => {
		const token = "abcdefghijklmnopqrstuvwxyz012345";
		expect(tokenFromInput(`http://127.0.0.1:8766/#${token}`)).toBe(token);
		expect(tokenFromInput(`  ${token}  `)).toBe(token);
		expect(tokenFromInput("not a token")).toBe("");
		expect(tokenFromInput("")).toBe("");

		t = await startTestPanad();
		const page = await t.tcp.get("/");
		const html = String(page.raw);
		expect(html).toContain('id="authorize"');
		expect(html).toContain('id="authorize-form"');
		expect(html).toContain("Authorize this app");
		const app = String((await t.tcp.get("/app.js")).raw);
		expect(app).toContain("localStorage.setItem(TOKEN_KEY");
		expect(app).toContain("showAuthorize()");
		// A wrong token gets 403 from the API, which is what opens the panel.
		expect((await request({ host: "127.0.0.1", port: t.panad.tcpPort! }, "GET", "/push/key")).status).toBe(403);
	});

	it("WEB-03 the shell has every section and the app routes each one", async () => {
		const ids = SECTIONS.map((section) => section.id);
		expect(ids).toEqual(["inbox", "compose", "threads", "sessions", "memory", "schedules"]);

		t = await startTestPanad();
		const html = String((await t.tcp.get("/")).raw);
		for (const section of SECTIONS) {
			expect(html).toContain(`data-testid="${section.id}"`);
			expect(html).toContain(`href="${section.route}"`);
		}
		expect(html).toContain('id="compose-form"');
		expect(html).toContain('id="reply-form"');
		expect(html).toContain('id="memory-search"');
		expect(html).toContain('id="schedule-form"');
	});

	it("WEB-04 the shell reuses the agent-mail renderers and the Mermaid bundle", async () => {
		t = await startTestPanad();
		const vendor = await t.tcp.get("/vendor.js");
		expect(vendor.status).toBe(200);
		expect(vendor.headers["content-type"]).toContain("javascript");
		expect(String(vendor.raw)).toContain("MailRenderers");
		const mermaid = await t.tcp.get("/mermaid-vendor.js");
		expect(mermaid.status).toBe(200);
		expect(String(mermaid.raw)).toContain("MailMermaid");
		const render = String((await t.tcp.get("/render.js")).raw);
		expect(render).toContain("marked.parse");
		expect(render).toContain("DOMPurify.sanitize");
		expect(render).toContain("language-mermaid");
		// The copied shims stay beside the bundles they were built from.
		expect(statSync(fileURLToPath(new URL("../web/renderers.js", import.meta.url))).size).toBeGreaterThan(0);
		expect(statSync(fileURLToPath(new URL("../web/mermaid-renderer.js", import.meta.url))).size).toBeGreaterThan(0);
	});

	it("WEB-05 pana:// links map to app routes and /files/ URLs", () => {
		const domain = TEST_DOMAIN;
		expect(appHref(`pana://${domain}/threads/T1`, domain)).toBe("#/threads/T1");
		expect(appHref(`pana://${domain}/threads/T1?message=M1`, domain)).toBe("#/threads/T1?message=M1");
		expect(appHref(`pana://${domain}/sessions/S1`, domain)).toBe("#/sessions/S1");
		expect(appHref(`pana://${domain}/files/F1/two words.png`, domain)).toBe("/files/F1/two%20words.png");
		// REF-08: a user link opens the inbox, not a thread search.
		expect(appHref(`pana://${domain}/users/joshbeckman`, domain)).toBe("#/inbox");
		expect(appHref(`pana://${domain}/schedules/X1`, domain)).toBe("#/schedules?focus=X1");
		expect(appHref(`pana://${domain}`, domain)).toBe("/");
		expect(appHref(`pana://other.example/threads/T1`, domain)).toBeUndefined();
		expect(appHref("https://example.com/x", domain)).toBe("https://example.com/x");
		expect(appHref("#/inbox", domain)).toBe("#/inbox");
		expect(appHref(undefined, domain)).toBeUndefined();
	});

	it("WEB-06 /events streams live transcript events to an authorized window", async () => {
		t = await startTestPanad();
		const sessionId = "01JB00000000000000000000S1";
		const stream = openSse(t.panad.tcpPort!, t.panad.webToken);
		try {
			const hello = await stream.waitFor('event: hello');
			expect(hello).toContain('"domain":"test.example"');
			expect(subscriberCount(t.runtime)).toBe(1);

			await publish(t.runtime, {
				kind: "session.transcript",
				sessionId,
				entry: { role: "assistant", text: "live update" },
			});
			const frame = await stream.waitFor("live update");
			expect(frame).toContain("event: session.transcript");
			expect(frame).toContain(`"sessionId":"${sessionId}"`);
		} finally {
			stream.close();
		}

		// The controls the Sessions view drives are real routes.
		for (const action of ["stop", "compact"]) {
			expect(matchRoute("POST", `/sessions/${sessionId}/${action}`)?.route.name).toBe(`sessions.${action}`);
		}
		expect(matchRoute("GET", `/sessions/${sessionId}/transcript`)?.route.name).toBe("sessions.transcript");
	});

	it("WEB-07 a reply draft records the thread head", () => {
		const thread = { id: "T1", messages: [{ id: "M1" }, { id: "M2" }] };
		expect(newDraft(thread)).toEqual({ threadId: "T1", after: "M2", body: "" });
		expect(newDraft({ id: "T1", messages: [] })).toEqual({ threadId: "T1", after: undefined, body: "" });
		expect(routeFromHash("#/threads/T1?message=M2")).toMatchObject({ section: "threads", id: "T1" });
		expect(routeFromHash("#/threads/T1?message=M2").query.get("message")).toBe("M2");
		expect(routeFromHash("").section).toBe("inbox");
	});

	it("WEB-08 edit and redact copy warns that sessions keep what they received", () => {
		for (const copy of [CONFIRM_EDIT, CONFIRM_REDACT]) {
			expect(copy).toContain("Sessions keep what they already received");
		}
		expect(CONFIRM_REDACT).toMatch(/Remove|removes/);
	});
});

describe("Web Push", () => {
	it("PSH-01 panad creates VAPID keys on first start and serves the public key", async () => {
		t = await startTestPanad();
		const path = join(t.dir, "vapid.json");
		expect(existsSync(path)).toBe(true);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		const stored = JSON.parse(readFileSync(path, "utf8")) as { publicKey: string; privateKey: string };
		expect(stored.publicKey).toHaveLength(87);
		expect(stored.privateKey).toHaveLength(43);

		const key = await t.tcp.get<{ publicKey: string }>("/push/key");
		expect(key.status).toBe(200);
		expect(key.body.publicKey).toBe(stored.publicKey);

		const dir = t.dir;
		await t.stop();
		t = await startTestPanad({ stateDir: dir });
		const again = await t.tcp.get<{ publicKey: string }>("/push/key");
		expect(again.body.publicKey).toBe(stored.publicKey);
	});

	it("PSH-02 a subscription is stored against the user and listed back", async () => {
		t = await startTestPanad();
		const subscription = { endpoint: "https://push.example/abc", keys: { p256dh: "p256dh-value", auth: "auth-value" } };
		const created = await t.tcp.post<{ subscription: { id: string; endpoint: string } }>("/push/subscriptions", subscription);
		expect(created.status).toBe(201);
		expect(created.body.subscription.endpoint).toBe(subscription.endpoint);

		const listed = await t.tcp.get<{ subscriptions: Array<{ id: string; endpoint: string }> }>("/push/subscriptions");
		expect(listed.status).toBe(200);
		expect(listed.body.subscriptions.map((row) => row.endpoint)).toEqual([subscription.endpoint]);

		// Re-posting the same endpoint updates the keys rather than duplicating it.
		await t.tcp.post("/push/subscriptions", { endpoint: subscription.endpoint, keys: { p256dh: "new", auth: "new" } });
		const after = await t.tcp.get<{ subscriptions: unknown[] }>("/push/subscriptions");
		expect(after.body.subscriptions).toHaveLength(1);

		const bad = await t.tcp.post("/push/subscriptions", { endpoint: subscription.endpoint });
		expect(bad.status).toBe(400);
		expect(bad.body).toMatchObject({ error: { code: "invalid_subscription" } });
	});

	it("PSH-03 a delivery to the user and a notice each send a push that opens the thread", async () => {
		t = await startTestPanad();
		const sent: Array<{ endpoint: string; message: { title?: string; body?: string; threadId?: string; url?: string } }> = [];
		const { setPushTransport } = await import("../src/push/index.ts");
		setPushTransport(t.runtime, async (subscription, message) => {
			sent.push({ endpoint: subscription.endpoint, message });
		});

		await t.tcp.post("/push/subscriptions", {
			endpoint: "https://push.example/one",
			keys: { p256dh: "p", auth: "a" },
		});

		const delivery = await publish(t.runtime, {
			kind: "delivery",
			to: t.runtime.userUrl,
			threadId: "T1",
			title: "New message",
			body: "hello",
		});
		expect(delivery?.sent).toBe(1);
		expect(sent).toHaveLength(1);
		expect(sent[0]!.message).toMatchObject({ title: "New message", body: "hello", threadId: "T1" });
		expect(notificationTarget(sent[0]!.message)).toBe("/#/threads/T1");

		const notice = await publish(t.runtime, { kind: "notice", to: t.runtime.userUrl, title: "Budget", body: "spent" });
		expect(notice?.sent).toBe(1);
		expect(sent).toHaveLength(2);
		expect(notificationTarget(sent[1]!.message)).toBe("/");

		// A session's event reaches open windows but never the user's phone.
		await publish(t.runtime, { kind: "session.transcript", sessionId: "S1", entry: { text: "x" } });
		expect(sent).toHaveLength(2);
	});

	it("PSH-04 a subscription that answers 404 or 410 is deleted", async () => {
		t = await startTestPanad();
		const { setPushTransport } = await import("../src/push/index.ts");
		let status = 410;
		setPushTransport(t.runtime, async () => {
			throw Object.assign(new Error("gone"), { statusCode: status });
		});
		for (const endpoint of ["https://push.example/gone", "https://push.example/missing", "https://push.example/flaky"]) {
			await t.tcp.post("/push/subscriptions", { endpoint, keys: { p256dh: "p", auth: "a" } });
		}

		await publish(t.runtime, { kind: "notice", to: t.runtime.userUrl, title: "a" });
		let listed = await t.tcp.get<{ subscriptions: Array<{ endpoint: string }> }>("/push/subscriptions");
		expect(listed.body.subscriptions).toHaveLength(0);

		status = 500;
		await t.tcp.post("/push/subscriptions", { endpoint: "https://push.example/flaky", keys: { p256dh: "p", auth: "a" } });
		await publish(t.runtime, { kind: "notice", to: t.runtime.userUrl, title: "b" });
		listed = await t.tcp.get<{ subscriptions: Array<{ endpoint: string }> }>("/push/subscriptions");
		expect(listed.body.subscriptions.map((row) => row.endpoint)).toEqual(["https://push.example/flaky"]);
	});
});
