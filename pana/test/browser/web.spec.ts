import { afterEach, describe, expect, it } from "vitest";
import { publish } from "../../src/web/events.ts";
import { loopbackOrigin } from "../../src/web/static.ts";
import { startTestPanad, type TestPanad } from "../harness/index.ts";
import { chromeDevtoolsAvailable, closePage, evaluatePage, newPage } from "./cli.ts";
import { createWorld, fakeHandlers, type FakeWorld } from "./fakes.ts";

// The browser suite needs the Chrome on this machine and the chrome-devtools CLI. It is kept
// out of `npm test` (see vitest.web.config.ts) so the Node suite never needs a browser.
const describeBrowser = chromeDevtoolsAvailable() ? describe : describe.skip;

interface Ctx {
	t: TestPanad;
	world: FakeWorld;
	page: number;
}

let ctx: Ctx | undefined;

async function setup(token?: string): Promise<Ctx> {
	const world = createWorld();
	const t = await startTestPanad({ handlers: fakeHandlers(world) });
	const origin = loopbackOrigin(t.panad.tcpPort!);
	const page = await newPage(`${origin}/#${token ?? t.panad.webToken}`);
	ctx = { t, world, page };
	return ctx;
}

afterEach(async () => {
	if (!ctx) return;
	await closePage(ctx.page);
	await ctx.t.close();
	ctx = undefined;
});

async function untilTest(check: () => boolean, timeout = 15_000): Promise<void> {
	const end = Date.now() + timeout;
	while (!check()) {
		if (Date.now() > end) throw new Error("timed out waiting for the test condition");
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

describeBrowser("pana in a browser", () => {
	it("WEB-02 a 403 shows the authorize panel, and a pasted launch URL stores the token", async () => {
		const world = createWorld();
		const t = await startTestPanad({ handlers: fakeHandlers(world) });
		const origin = loopbackOrigin(t.panad.tcpPort!);
		const page = await newPage(`${origin}/#a-wrong-token-that-is-long-enough`);
		ctx = { t, world, page };

		const panel = await evaluatePage<{ visible: boolean; text: string }>(`
			const visible = await until(() => !document.getElementById("authorize").hidden);
			return { visible, text: document.getElementById("authorize").textContent };
		`);
		expect(panel.visible).toBe(true);
		expect(panel.text).toContain("Authorize this app");
		expect(panel.text).toContain("Authorize");

		const after = await evaluatePage<{ stored: string | null; hidden: boolean; items: number; title: string }>(`
			document.getElementById("authorize-input").value = ${JSON.stringify(`${origin}/#${t.panad.webToken}`)};
			document.getElementById("authorize-form").requestSubmit();
			await until(() => document.getElementById("authorize").hidden);
			await until(() => document.querySelectorAll("#inbox-list .item").length > 0);
			return {
				stored: localStorage.getItem("pana-token"),
				hidden: document.getElementById("authorize").hidden,
				items: document.querySelectorAll("#inbox-list .item").length,
				title: document.querySelector("#inbox-list .item .title").textContent,
			};
		`);
		expect(after.stored).toBe(t.panad.webToken);
		expect(after.hidden).toBe(true);
		expect(after.items).toBe(1);
		expect(after.title).toContain("A rendered thread");
	});

	it("WEB-03 inbox, compose, threads, sessions, memory, and schedules work end to end", async () => {
		const { world } = await setup();

		const inbox = await evaluatePage<string>(`
			await until(() => document.querySelectorAll("#inbox-list .item").length === 1);
			return document.querySelector("#inbox-list .item .title").textContent;
		`);
		expect(inbox).toContain("A rendered thread");

		const composed = await evaluatePage<string>(`
			location.hash = "#/compose";
			await until(() => !document.getElementById("view-compose").hidden);
			document.getElementById("compose-to").value = "joshbeckman";
			document.getElementById("compose-subject").value = "Hello from the PWA";
			document.getElementById("compose-body").value = "A **composed** message";
			document.getElementById("compose-form").requestSubmit();
			await until(() => location.hash === "#/threads/T2");
			await until(() => !document.getElementById("thread").hidden && document.querySelectorAll("#thread-messages [data-testid=message]").length === 1);
			return document.getElementById("thread-subject").textContent;
		`);
		expect(composed).toBe("Hello from the PWA");
		expect(world.calls.find((call) => call.route === "sessions.create")?.body).toMatchObject({
			to: ["joshbeckman"],
			prompt: "A **composed** message",
			subject: "Hello from the PWA",
		});

		const threads = await evaluatePage<number>(`
			location.hash = "#/threads";
			await until(() => !document.getElementById("threads-list").hidden);
			await until(() => document.querySelectorAll("#threads-list .item").length >= 2);
			const row = [...document.querySelectorAll("#threads-list .item")].find((el) => el.dataset.thread === "T1");
			row.click();
			await until(() => !document.getElementById("thread").hidden);
			await until(() => document.querySelectorAll("#thread-messages [data-testid=message]").length === 2);
			return document.querySelectorAll("#thread-messages [data-testid=message]").length;
		`);
		expect(threads).toBe(2);

		const transcript = await evaluatePage<number>(`
			location.hash = "#/sessions";
			await until(() => document.querySelectorAll("#sessions-list .item").length >= 2);
			[...document.querySelectorAll("#sessions-list .item")].find((el) => el.dataset.session === "S1").click();
			await until(() => !document.getElementById("session").hidden);
			await until(() => document.querySelectorAll("#transcript [data-testid=entry]").length === 2);
			return document.querySelectorAll("#transcript [data-testid=entry]").length;
		`);
		expect(transcript).toBe(2);

		const memory = await evaluatePage<{ worktree: string; files: number; content: string; log: number; editing: boolean }>(`
			location.hash = "#/memory";
			await until(() => document.getElementById("memory-worktree").textContent.includes("/tmp/pana-memory"));
			await until(() => document.querySelectorAll("#memory-files .item").length === 1);
			document.getElementById("memory-query").value = "memory";
			document.getElementById("memory-search").requestSubmit();
			await until(() => document.querySelectorAll("#memory-results .item").length === 1);
			document.querySelector("#memory-results .item").click();
			await until(() => !document.getElementById("memory-file").hidden && document.getElementById("memory-file").textContent.includes("hello memory"));
			document.getElementById("memory-edit").value = "# Notes\\n\\nhello memory, edited\\n";
			document.querySelector("[data-testid=memory-save]").click();
			await until(() => document.getElementById("memory-file").textContent.includes("edited"));
			await until(() => document.querySelectorAll("#memory-log .item").length === 1);
			return {
				worktree: document.getElementById("memory-worktree").textContent,
				files: document.querySelectorAll("#memory-files .item").length,
				content: document.getElementById("memory-file").textContent,
				log: document.querySelectorAll("#memory-log .item").length,
				editing: !document.getElementById("memory-edit").hidden,
			};
		`);
		expect(memory.worktree).toContain("/tmp/pana-memory");
		expect(memory.files).toBe(1);
		expect(memory.content).toContain("hello memory, edited");
		expect(memory.log).toBe(1);
		expect(memory.editing).toBe(true);
		await untilTest(() => world.calls.some((call) => call.route === "memory.files.write"));
		expect(world.files["notes.md"]).toContain("hello memory, edited");

		await evaluatePage(`
			location.hash = "#/schedules";
			await until(() => document.querySelectorAll("#schedules-list .item").length === 1);
			return true;
		`);
		await evaluatePage(`
			document.getElementById("schedule-when").value = "0 10 * * *";
			document.getElementById("schedule-prompt").value = "weekly review";
			document.getElementById("schedule-form").requestSubmit();
			await until(() => document.querySelectorAll("#schedules-list .item").length === 2);
			return true;
		`);
		await evaluatePage(`
			document.querySelectorAll("#schedules-list .item")[0].querySelector("[data-testid=schedule-edit]").click();
			await until(() => document.getElementById("schedule-create").textContent === "Update");
			return true;
		`);
		await evaluatePage(`
			document.getElementById("schedule-prompt").value = "daily review";
			document.getElementById("schedule-form").requestSubmit();
			await until(() => document.getElementById("schedule-create").textContent === "Create");
			return true;
		`);
		await evaluatePage(`
			await until(() => document.querySelectorAll("#schedules-list .item").length === 2);
			document.querySelectorAll("#schedules-list .item")[1].querySelector("[data-action=delete-schedule]").click();
			await until(() => document.querySelectorAll("#schedules-list .item").length === 1);
			return true;
		`);
		const schedules = 1;
		expect(schedules).toBe(1);
		expect(world.calls.map((call) => call.route)).toEqual(
			expect.arrayContaining([
				"sessions.create",
				"threads.read",
				"sessions.show",
				"memory.search",
				"memory.files.write",
				"schedules.create",
				"schedules.update",
				"schedules.delete",
			]),
		);
		expect(world.schedules.find((schedule) => schedule.id === "SC1")?.payload).toMatchObject({ prompt: "daily review" });
	});

	it("WEB-04 messages render Markdown, images, and Mermaid", async () => {
		await setup();
		const rendered = await evaluatePage<{ heading: string; bold: string; image: string; width: number; svg: boolean }>(`
			location.hash = "#/threads/T1";
			await until(() => document.querySelectorAll("#thread-messages [data-testid=message]").length === 2);
			const body = document.querySelector("#thread-messages [data-testid=message] .body");
			const image = body.querySelector("img");
			await until(() => body.querySelector(".diagram svg") || body.textContent.includes("Diagram renderer unavailable"));
			await until(() => image && image.src.startsWith("blob:") && image.naturalWidth > 0);
			return {
				heading: body.querySelector("h2")?.textContent ?? "",
				bold: body.querySelector("strong")?.textContent ?? "",
				image: image.src.slice(0, 5),
				width: image.naturalWidth,
				svg: Boolean(body.querySelector(".diagram svg")),
			};
		`);
		expect(rendered.heading).toBe("Rendered heading");
		expect(rendered.bold).toBe("bold");
		expect(rendered.image).toBe("blob:");
		expect(rendered.width).toBe(1);
		expect(rendered.svg).toBe(true);
	});

	it("WEB-05 pana:// links become app routes and /files/ URLs", async () => {
		await setup();
		const links = await evaluatePage<{
			anchors: Array<{ href: string | null; file: string | null; target?: string }>;
			images: Array<string | null>;
		}>(`
			location.hash = "#/threads/T1";
			await until(() => document.querySelectorAll("#thread-messages [data-testid=message]").length === 2);
			await until(() => document.querySelectorAll("#thread-messages .body a").length >= 1);
			await until(() => document.querySelectorAll("#thread-messages .body img[data-file-path]").length >= 1);
			return {
				anchors: [...document.querySelectorAll("#thread-messages .body a")].map((anchor) => ({
					href: anchor.getAttribute("href"),
					file: anchor.getAttribute("data-file-path"),
					target: anchor.getAttribute("target"),
				})),
				images: [...document.querySelectorAll("#thread-messages .body img[data-file-path]")].map((image) =>
					image.getAttribute("data-file-path"),
				),
			};
		`);
		expect(links.anchors).toContainEqual({ href: "#/sessions/S1", file: null, target: null });
		expect(links.images).toContain("/files/F1/pixel.png");
	});

	it("WEB-06 the session transcript streams live and stop, compact, and reload work", async () => {
		const { t, world } = await setup();
		await evaluatePage(`
			location.hash = "#/sessions";
			await until(() => document.querySelectorAll("#sessions-list .item").length === 2);
			[...document.querySelectorAll("#sessions-list .item")].find((el) => el.dataset.session === "S1").click();
			await until(() => document.querySelectorAll("#transcript [data-testid=entry]").length === 2);
			return true;
		`);

		await publish(t.runtime, { kind: "session.transcript", sessionId: "S1", entry: { role: "assistant", text: "live update" } });
		const live = await evaluatePage<number>(`
			await until(() => document.getElementById("transcript").textContent.includes("live update"));
			return document.querySelectorAll("#transcript [data-testid=entry]").length;
		`);
		expect(live).toBe(3);

		await evaluatePage(`
			document.querySelector("[data-testid=session-stop]").click();
			await until(() => document.getElementById("session-meta").textContent.includes("stopped"));
			return true;
		`);
		expect(world.calls.some((call) => call.route === "sessions.stop")).toBe(true);

		await evaluatePage(`
			document.querySelector("[data-testid=session-compact]").click();
			await until(() => document.getElementById("transcript").textContent.includes("compacted summary"));
			return true;
		`);
		expect(world.calls.some((call) => call.route === "sessions.compact")).toBe(true);

		await evaluatePage(`
			document.querySelector("[data-testid=session-reload]").click();
			await until(() => document.getElementById("transcript").textContent.includes("compacted summary"));
			return true;
		`);
		expect(world.calls.filter((call) => call.route === "sessions.transcript").length).toBeGreaterThanOrEqual(3);
	});

	it("WEB-07 a 409 shows the new messages and keeps the draft", async () => {
		const { world } = await setup();
		await evaluatePage(`
			location.hash = "#/threads/T1";
			await until(() => document.getElementById("draft-head").textContent === "M2");
			return true;
		`);
		world.moved = true;

		const stale = await evaluatePage<{ draft: string; newer: string; head: string; visible: boolean }>(`
			const body = document.getElementById("reply-body");
			body.value = "my kept draft";
			body.dispatchEvent(new Event("input"));
			document.getElementById("reply-form").requestSubmit();
			await until(() => !document.getElementById("stale").hidden);
			return {
				draft: document.getElementById("reply-body").value,
				newer: document.getElementById("stale-new").textContent,
				head: document.getElementById("draft-head").textContent,
				visible: !document.getElementById("stale").hidden,
			};
		`);
		expect(stale.visible).toBe(true);
		expect(stale.draft).toBe("my kept draft");
		expect(stale.newer).toContain("A newer message arrived.");
		expect(stale.head).toBe("M3");
		expect(world.calls.find((call) => call.route === "threads.respond")?.body).toMatchObject({ body: "my kept draft", after: "M2" });
	});

	it("WEB-08 edit and redact ask for confirmation and warn that sessions keep messages", async () => {
		const { world } = await setup();
		await evaluatePage(`
			location.hash = "#/threads/T1";
			await until(() => document.querySelectorAll("#thread-messages [data-testid=message]").length === 2);
			return true;
		`);

		const confirmEdit = await evaluatePage<string>(`
			document.querySelector("[data-testid=message-edit]").click();
			await until(() => !document.getElementById("confirm").hidden);
			return document.getElementById("confirm-text").textContent;
		`);
		expect(confirmEdit).toContain("Sessions keep what they already received");
		expect(world.calls.some((call) => call.route === "messages.revise")).toBe(false);

		await evaluatePage(`
			document.getElementById("edit-body").value = "edited body";
			document.getElementById("confirm-yes").click();
			return true;
		`);
		await untilTest(() => world.calls.some((call) => call.route === "messages.revise"));
		expect(world.calls.find((call) => call.route === "messages.revise")?.body).toMatchObject({ body: "edited body" });

		const confirmRedact = await evaluatePage<string>(`
			const buttons = [...document.querySelectorAll("[data-testid=message-redact]")];
			buttons[1].click();
			await until(() => !document.getElementById("confirm").hidden);
			return document.getElementById("confirm-text").textContent;
		`);
		expect(confirmRedact).toContain("Sessions keep what they already received");
		expect(world.calls.some((call) => call.route === "messages.redact")).toBe(false);

		await evaluatePage(`
			document.getElementById("confirm-yes").click();
			return true;
		`);
		await untilTest(() => world.calls.some((call) => call.route === "messages.redact"));
	});

	it("PSH-02 the shell registers a service worker and offers notifications", async () => {
		await setup();
		const result = await evaluatePage<{ scopes: string[]; button: string; manifest: string }>(`
			const registrations = await until(async () => {
				const found = await navigator.serviceWorker.getRegistrations();
				return found.length > 0 ? found : undefined;
			});
			return {
				scopes: registrations.map((registration) => registration.scope),
				button: document.getElementById("enable-push").textContent,
				manifest: document.querySelector('link[rel="manifest"]').getAttribute("href"),
			};
		`);
		expect(result.scopes.some((scope) => scope.endsWith("/"))).toBe(true);
		expect(result.button).toContain("Notifications");
		expect(result.manifest).toBe("/manifest.webmanifest");
	});
});
