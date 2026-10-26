// The PWA in a real browser against a real test panad (WEB-02..08, PSH-02, INT-02). Every view
// talks to the real handlers; the only fake is the scripted faux model.

import type { HarnessSettings } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { sessionRuntime } from "../../src/sessions/index.ts";
import { postNotice } from "../../src/threads/index.ts";
import { loopbackOrigin } from "../../src/web/static.ts";
import { FAKE_EPOCH, startTestPanad, TEST_DOMAIN, type Script, type TestPanad } from "../harness/index.ts";
import { chromeDevtoolsAvailable, closePage, evaluatePage, newPage } from "./cli.ts";

// The browser suite needs the Chrome on this machine and the chrome-devtools CLI. It is kept
// out of `npm test` (see vitest.web.config.ts) so the Node suite never needs a browser.
const describeBrowser = chromeDevtoolsAvailable() ? describe : describe.skip;

const PNG_1X1 = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
	"base64",
);

interface Message {
	id: string;
	body?: string;
	revised: boolean;
	redacted: boolean;
	sender: { url: string };
}

interface Created {
	session: { id: string; url: string };
	thread: { id: string };
	message: { id: string };
}

let t: TestPanad | undefined;
let page: number | undefined;

async function start(script: Script = [], settings?: HarnessSettings): Promise<TestPanad> {
	t = await startTestPanad({ script, settings, config: { defaultModel: "faux/faux-1", timezone: "UTC" } });
	return t;
}

async function open(token?: string): Promise<string> {
	const origin = loopbackOrigin(t!.panad.tcpPort!);
	page = await newPage(`${origin}/#${token ?? t!.panad.webToken}`);
	return origin;
}

afterEach(async () => {
	if (page !== undefined) await closePage(page);
	page = undefined;
	await t?.close();
	t = undefined;
});

async function until<T>(check: () => Promise<T | undefined | null | false> | T | undefined | null | false, what: string, timeout = 15_000): Promise<T> {
	const end = Date.now() + timeout;
	for (;;) {
		await t!.clock.settle();
		await sessionRuntime(t!.runtime).idle();
		const value = await check();
		if (value) return value;
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

async function messages(threadId: string): Promise<Message[]> {
	const res = await t!.client.get<{ messages: Message[] }>(`/threads/${threadId}`);
	expect(res.status).toBe(200);
	return res.body.messages;
}

/**
 * Start a session through the API and wait for its auto-reply to land. It polls the table, not
 * the thread route, because reading the thread would mark the reply read for the user.
 */
async function seedSession(prompt: string): Promise<Created> {
	const res = await t!.client.post<Created>("/sessions", { prompt });
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	await until(
		async () => (await t!.runtime.db.get("SELECT 1 FROM messages WHERE thread_id = ? AND seq = 2", res.body.thread.id)) !== undefined,
		"the session's reply",
	);
	return res.body;
}

describeBrowser("pana in a browser", () => {
	it("WEB-02 a 403 shows the authorize panel, and a pasted launch URL stores the token", async () => {
		await start();
		await postNotice(t!.runtime, { body: "A rendered thread" });
		const origin = await open("a-wrong-token-that-is-long-enough");

		const panel = await evaluatePage<{ visible: boolean; text: string }>(`
			const visible = await until(() => !document.getElementById("authorize").hidden);
			return { visible, text: document.getElementById("authorize").textContent };
		`);
		expect(panel.visible).toBe(true);
		expect(panel.text).toContain("Authorize this app");

		const after = await evaluatePage<{ stored: string | null; hidden: boolean; items: number; title: string }>(`
			document.getElementById("authorize-input").value = ${JSON.stringify(`${origin}/#${t!.panad.webToken}`)};
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
		expect(after.stored).toBe(t!.panad.webToken);
		expect(after.hidden).toBe(true);
		expect(after.items).toBe(1);
		expect(after.title).toBe("A rendered thread");
	});

	it("WEB-03 INT-02 inbox, compose, threads, sessions, memory, and schedules work end to end", async () => {
		await start([{ text: "Paris." }, { text: "Composed reply." }]);
		const seeded = await seedSession("What is the capital of France?");
		await open();

		// Inbox: the session's reply to the user, with its sender.
		const inbox = await evaluatePage<{ title: string; meta: string; unread: boolean }>(`
			await until(() => document.querySelectorAll("#inbox-list .item").length === 1);
			const row = document.querySelector("#inbox-list .item");
			return { title: row.querySelector(".title").textContent, meta: row.querySelector(".meta").textContent, unread: row.classList.contains("unread") };
		`);
		expect(inbox.title).toBe("What is the capital of France?");
		expect(inbox.meta).toContain(seeded.session.url);
		expect(inbox.unread).toBe(true);

		// Compose: a real session and thread; its reply shows up in the open thread.
		const composed = await evaluatePage<{ subject: string; hash: string; bodies: string[] }>(`
			location.hash = "#/compose";
			await until(() => !document.getElementById("view-compose").hidden);
			document.getElementById("compose-subject").value = "Hello from the PWA";
			document.getElementById("compose-body").value = "A **composed** message";
			document.getElementById("compose-form").requestSubmit();
			await until(() => location.hash.startsWith("#/threads/") && !document.getElementById("thread").hidden);
			await until(() => document.querySelectorAll("#thread-messages [data-testid=message]").length === 2);
			return {
				subject: document.getElementById("thread-subject").textContent,
				hash: location.hash,
				bodies: [...document.querySelectorAll("#thread-messages [data-testid=message] .body")].map((el) => el.textContent.trim()),
			};
		`);
		expect(composed.subject).toBe("Hello from the PWA");
		expect(composed.bodies).toEqual(["A composed message", "Composed reply."]);
		const sessions = await t!.client.get<{ sessions: Array<{ id: string }> }>("/sessions");
		expect(sessions.body.sessions).toHaveLength(2);

		// Threads: both threads are listed; opening one reads its messages.
		const threads = await evaluatePage<{ listed: number; bodies: string[]; senders: string[] }>(`
			location.hash = "#/threads";
			await until(() => !document.getElementById("threads-list").hidden);
			await until(() => document.querySelectorAll("#threads-list .item").length === 2);
			const listed = document.querySelectorAll("#threads-list .item").length;
			[...document.querySelectorAll("#threads-list .item")].find((el) => el.dataset.thread === ${JSON.stringify(seeded.thread.id)}).click();
			await until(() => !document.getElementById("thread").hidden);
			await until(() => document.querySelectorAll("#thread-messages [data-testid=message]").length === 2);
			const items = [...document.querySelectorAll("#thread-messages [data-testid=message]")];
			return { listed, bodies: items.map((el) => el.querySelector(".body").textContent.trim()), senders: items.map((el) => el.dataset.sender) };
		`);
		expect(threads.listed).toBe(2);
		expect(threads.bodies).toEqual(["What is the capital of France?", "Paris."]);
		expect(threads.senders).toEqual([t!.runtime.userUrl, seeded.session.url]);

		// Thread search finds the reply text.
		const search = await evaluatePage<string[]>(`
			location.hash = "#/threads";
			await until(() => !document.getElementById("threads-list").hidden);
			document.getElementById("threads-query").value = "Paris";
			document.getElementById("threads-search").requestSubmit();
			await until(() => document.querySelectorAll("#threads-list .item").length === 1);
			return [...document.querySelectorAll("#threads-list .item")].map((el) => el.dataset.thread);
		`);
		expect(search).toEqual([seeded.thread.id]);

		// Sessions: the list and a real transcript.
		const transcript = await evaluatePage<{ listed: number; meta: string; text: string; kinds: string[] }>(`
			location.hash = "#/sessions";
			await until(() => document.querySelectorAll("#sessions-list .item").length === 2);
			const listed = document.querySelectorAll("#sessions-list .item").length;
			[...document.querySelectorAll("#sessions-list .item")].find((el) => el.dataset.session === ${JSON.stringify(seeded.session.id)}).click();
			await until(() => !document.getElementById("session").hidden);
			await until(() => document.querySelectorAll("#transcript [data-testid=entry]").length >= 2);
			return {
				listed,
				meta: document.getElementById("session-meta").textContent,
				text: document.getElementById("transcript").textContent,
				kinds: [...document.querySelectorAll("#transcript [data-testid=entry]")].map((el) => el.dataset.kind),
			};
		`);
		expect(transcript.listed).toBe(2);
		expect(transcript.meta).toContain("faux/faux-1");
		expect(transcript.meta).toContain("idle");
		expect(transcript.text).toContain("What is the capital of France?");
		expect(transcript.text).toContain("Paris.");
		expect(transcript.kinds).toEqual(expect.arrayContaining(["pana.message", "pi.assistant"]));

		// Memory: browse, search, open, edit, and the commit is the user's.
		await t!.client.post("/memory/files/notes.md", { content: "# Notes\n\nhello memory\n" });
		const memory = await evaluatePage<{ worktree: string; files: string[]; content: string; log: string }>(`
			location.hash = "#/memory";
			await until(() => document.getElementById("memory-worktree").textContent.includes("memory/worktrees/tester"));
			await until(() => document.querySelectorAll("#memory-files .item").length === 1);
			document.getElementById("memory-query").value = "MEMORY";
			document.getElementById("memory-search").requestSubmit();
			await until(() => document.querySelectorAll("#memory-results .item").length === 1);
			document.querySelector("#memory-results .item").click();
			await until(() => !document.getElementById("memory-file").hidden && document.getElementById("memory-file").textContent.includes("hello memory"));
			document.getElementById("memory-edit").value = "# Notes\\n\\nhello memory, edited\\n";
			document.querySelector("[data-testid=memory-save]").click();
			await until(() => document.getElementById("memory-file").textContent.includes("edited"));
			await until(() => document.querySelectorAll("#memory-log .item").length === 3);
			return {
				worktree: document.getElementById("memory-worktree").textContent,
				files: [...document.querySelectorAll("#memory-files .item")].map((el) => el.dataset.path),
				content: document.getElementById("memory-file").textContent,
				log: document.querySelector("#memory-log .item").textContent,
			};
		`);
		expect(memory.files).toEqual(["notes.md"]);
		expect(memory.content).toContain("hello memory, edited");
		expect(memory.log).toContain("Update notes.md");
		expect(memory.log).toContain(t!.runtime.userUrl);
		const onMain = await t!.client.get<{ content: string }>("/memory/files/notes.md");
		expect(onMain.body.content).toContain("hello memory, edited");

		// Schedules: create cron and one-off, edit each, delete one.
		const at = new Date(FAKE_EPOCH + 7 * 86_400_000).toISOString();
		await evaluatePage(`
			location.hash = "#/schedules";
			await until(() => !document.getElementById("view-schedules").hidden);
			document.getElementById("schedule-when").value = "0 10 * * *";
			document.getElementById("schedule-prompt").value = "daily review";
			document.getElementById("schedule-form").requestSubmit();
			await until(() => document.querySelectorAll("#schedules-list .item").length === 1);
			document.getElementById("schedule-when").value = ${JSON.stringify(at)};
			document.getElementById("schedule-prompt").value = "one-off";
			document.getElementById("schedule-form").requestSubmit();
			await until(() => document.querySelectorAll("#schedules-list .item").length === 2);
			return true;
		`);
		type ScheduleBody = { id: string; cron: string | null; at: number | null; nextAt: number; payload: { prompt: string } };
		const listed = (await t!.client.get<{ schedules: ScheduleBody[] }>("/schedules")).body.schedules;
		const oneOff = listed.find((schedule) => schedule.at !== null)!;
		const daily = listed.find((schedule) => schedule.cron !== null)!;
		expect(oneOff.at).toBe(Date.parse(at));

		const shown = await evaluatePage<string>(`
			[...document.querySelectorAll("#schedules-list .item")].find((el) => el.dataset.id === ${JSON.stringify(oneOff.id)}).querySelector("[data-testid=schedule-edit]").click();
			await until(() => document.getElementById("schedule-create").textContent === "Update");
			const when = document.getElementById("schedule-when").value;
			document.getElementById("schedule-prompt").value = "edited one-off";
			document.getElementById("schedule-form").requestSubmit();
			await until(() => document.getElementById("schedule-create").textContent === "Create");
			return when;
		`);
		expect(shown).toBe(at);
		const edited = (await t!.client.get<{ schedule: ScheduleBody }>(`/schedules/${oneOff.id}`)).body.schedule;
		expect(edited).toMatchObject({ at: Date.parse(at), nextAt: Date.parse(at), cron: null, payload: { prompt: "edited one-off" } });

		// Clearing the time field keeps the stored time too.
		await evaluatePage(`
			[...document.querySelectorAll("#schedules-list .item")].find((el) => el.dataset.id === ${JSON.stringify(daily.id)}).querySelector("[data-testid=schedule-edit]").click();
			await until(() => document.getElementById("schedule-create").textContent === "Update");
			document.getElementById("schedule-when").value = "";
			document.getElementById("schedule-prompt").value = "daily review, edited";
			document.getElementById("schedule-form").requestSubmit();
			await until(() => document.getElementById("schedule-create").textContent === "Create");
			return true;
		`);
		const kept = (await t!.client.get<{ schedule: ScheduleBody }>(`/schedules/${daily.id}`)).body.schedule;
		expect(kept).toMatchObject({ cron: "0 10 * * *", nextAt: daily.nextAt, payload: { prompt: "daily review, edited" } });

		await evaluatePage(`
			await until(() => document.querySelectorAll("#schedules-list .item").length === 2);
			[...document.querySelectorAll("#schedules-list .item")].find((el) => el.dataset.id === ${JSON.stringify(daily.id)}).querySelector("[data-action=delete-schedule]").click();
			await until(() => document.querySelectorAll("#schedules-list .item").length === 1);
			return true;
		`);
		const remaining = (await t!.client.get<{ schedules: ScheduleBody[] }>("/schedules")).body.schedules;
		expect(remaining.map((schedule) => schedule.id)).toEqual([oneOff.id]);
	});

	it("WEB-04 WEB-05 messages render Markdown, images, Mermaid, and pana:// links", async () => {
		await start([{ text: "Ready when you are." }]);
		const seeded = await seedSession("go");
		const upload = await t!.client.request<{ file: { id: string; url: string } }>("POST", "/files?name=pixel.png", {
			bytes: PNG_1X1,
			headers: { "content-type": "image/png" },
		});
		expect(upload.status).toBe(201);
		const markdown = [
			"## Rendered heading",
			"",
			`Some **bold** text and a [session link](${seeded.session.url}).`,
			"",
			`![pixel](${upload.body.file.url})`,
			"",
			"```mermaid",
			"graph TD; A-->B;",
			"```",
		].join("\n");
		const notice = await postNotice(t!.runtime, { body: markdown });
		await open();

		const rendered = await evaluatePage<{
			heading: string;
			bold: string;
			image: string;
			width: number;
			svg: boolean;
			anchors: Array<{ href: string | null; target: string | null }>;
			files: Array<string | null>;
		}>(`
			location.hash = "#/threads/${notice.thread.id}";
			await until(() => document.querySelectorAll("#thread-messages [data-testid=message]").length === 1);
			const body = document.querySelector("#thread-messages [data-testid=message] .body");
			await until(() => body.querySelector(".diagram svg") || body.textContent.includes("Diagram renderer unavailable"));
			await until(() => { const image = body.querySelector("img"); return image && image.src.startsWith("blob:") && image.naturalWidth > 0; });
			const image = body.querySelector("img");
			return {
				heading: body.querySelector("h2")?.textContent ?? "",
				bold: body.querySelector("strong")?.textContent ?? "",
				image: image.src.slice(0, 5),
				width: image.naturalWidth,
				svg: Boolean(body.querySelector(".diagram svg")),
				anchors: [...body.querySelectorAll("a")].map((a) => ({ href: a.getAttribute("href"), target: a.getAttribute("target") })),
				files: [...body.querySelectorAll("img[data-file-path]")].map((el) => el.getAttribute("data-file-path")),
			};
		`);
		expect(rendered.heading).toBe("Rendered heading");
		expect(rendered.bold).toBe("bold");
		expect(rendered.image).toBe("blob:");
		expect(rendered.width).toBe(1);
		expect(rendered.svg).toBe(true);
		expect(rendered.anchors).toContainEqual({ href: `#/sessions/${seeded.session.id}`, target: null });
		expect(rendered.files).toContain(`/files/${upload.body.file.id}/pixel.png`);
		expect(upload.body.file.url).toBe(`pana://${TEST_DOMAIN}/files/${upload.body.file.id}/pixel.png`);
	});

	it("WEB-06 INT-03 the session transcript streams live and stop, compact, and reload work", async () => {
		// A tiny transcript has nothing to compact under the default policy.
		await start([{ text: "first answer" }, { text: "live update" }, { text: "compacted summary" }], { compaction: { keepRecentTokens: 1 } });
		const seeded = await seedSession("Start a transcript");
		await open();
		await evaluatePage(`
			location.hash = "#/sessions/${seeded.session.id}";
			await until(() => document.getElementById("transcript").textContent.includes("first answer"));
			return true;
		`);
		const before = await evaluatePage<number>(`return document.querySelectorAll("#transcript [data-testid=entry]").length;`);

		// A new message wakes the session; its entries stream in without a reload.
		const head = (await messages(seeded.thread.id)).at(-1)!.id;
		const sent = await t!.client.post(`/threads/${seeded.thread.id}/messages`, { after: head, body: "one more thing" });
		expect(sent.status).toBe(200);
		const live = await evaluatePage<{ count: number; ids: string[] }>(`
			await until(() => document.getElementById("transcript").textContent.includes("live update"));
			const entries = [...document.querySelectorAll("#transcript [data-testid=entry]")];
			return { count: entries.length, ids: entries.map((el) => el.dataset.entryId) };
		`);
		expect(live.count).toBeGreaterThan(before);
		expect(new Set(live.ids).size).toBe(live.ids.length);
		await until(async () => (await t!.client.get<{ session: { state: string } }>(`/sessions/${seeded.session.id}`)).body.session.state === "idle", "idle");

		await evaluatePage(`
			document.querySelector("[data-testid=session-compact]").click();
			await until(() => document.getElementById("transcript").textContent.includes("compacted summary"), 20000);
			return true;
		`);

		await evaluatePage(`
			document.querySelector("[data-testid=session-stop]").click();
			await until(() => document.getElementById("session-meta").textContent.includes("stopped"));
			return true;
		`);
		expect((await t!.client.get<{ session: { state: string } }>(`/sessions/${seeded.session.id}`)).body.session.state).toBe("stopped");

		const reloaded = await evaluatePage<string>(`
			document.getElementById("transcript").replaceChildren();
			document.querySelector("[data-testid=session-reload]").click();
			await until(() => document.querySelectorAll("#transcript [data-testid=entry]").length > 0);
			return document.getElementById("transcript").textContent;
		`);
		expect(reloaded).toContain("live update");
		expect(reloaded).toContain("compacted summary");
	});

	it("WEB-07 a 409 shows the new messages and keeps the draft", async () => {
		await start([{ text: "Ready when you are." }]);
		const seeded = await seedSession("go");
		await t!.client.post(`/sessions/${seeded.session.id}/stop`);
		const head = (await messages(seeded.thread.id)).at(-1)!.id;
		await open();
		await evaluatePage(`
			location.hash = "#/threads/${seeded.thread.id}";
			await until(() => document.getElementById("draft-head").textContent === ${JSON.stringify(head)});
			const body = document.getElementById("reply-body");
			body.value = "my kept draft";
			body.dispatchEvent(new Event("input"));
			return true;
		`);
		const moved = await t!.client.post<{ message: { id: string } }>(`/threads/${seeded.thread.id}/messages`, {
			after: head,
			body: "A newer message arrived.",
		});
		expect(moved.status).toBe(200);

		const stale = await evaluatePage<{ draft: string; newer: string; head: string; visible: boolean }>(`
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
		expect(stale.head).toBe(moved.body.message.id);
		expect((await messages(seeded.thread.id)).map((m) => m.body)).toEqual(["go", "Ready when you are.", "A newer message arrived."]);

		// The next send lands after the new head.
		await evaluatePage(`
			document.getElementById("reply-form").requestSubmit();
			await until(() => document.querySelectorAll("#thread-messages [data-testid=message]").length === 4);
			return true;
		`);
		expect((await messages(seeded.thread.id)).at(-1)!.body).toBe("my kept draft");
	});

	it("WEB-08 edit and redact ask for confirmation and warn that sessions keep messages", async () => {
		await start([{ text: "Ready when you are." }]);
		const seeded = await seedSession("original prompt");
		await open();
		await evaluatePage(`
			location.hash = "#/threads/${seeded.thread.id}";
			await until(() => document.querySelectorAll("#thread-messages [data-testid=message]").length === 2);
			return true;
		`);

		const confirmEdit = await evaluatePage<string>(`
			document.querySelector("[data-testid=message-edit]").click();
			await until(() => !document.getElementById("confirm").hidden);
			return document.getElementById("confirm-text").textContent;
		`);
		expect(confirmEdit).toContain("Sessions keep what they already received");
		expect((await messages(seeded.thread.id))[0]!.revised).toBe(false);

		await evaluatePage(`
			document.getElementById("edit-body").value = "edited body";
			document.getElementById("confirm-yes").click();
			await until(() => document.querySelector("#thread-messages [data-testid=message] .body")?.textContent.includes("edited body"));
			return true;
		`);
		expect((await messages(seeded.thread.id))[0]).toMatchObject({ body: "edited body", revised: true });

		const confirmRedact = await evaluatePage<string>(`
			document.querySelectorAll("[data-testid=message-redact]")[1].click();
			await until(() => !document.getElementById("confirm").hidden);
			return document.getElementById("confirm-text").textContent;
		`);
		expect(confirmRedact).toContain("Sessions keep what they already received");
		expect((await messages(seeded.thread.id))[1]!.redacted).toBe(false);

		await evaluatePage(`
			document.getElementById("confirm-yes").click();
			await until(() => document.querySelectorAll("#thread-messages [data-testid=message] .body")[1]?.textContent === "[redacted]");
			return true;
		`);
		expect((await messages(seeded.thread.id))[1]).toMatchObject({ redacted: true });
	});

	it("PSH-02 the shell registers a service worker and offers notifications", async () => {
		await start();
		await open();
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
