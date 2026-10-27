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
		// UX-03 changed the inbox to one row per thread; the session is a short, linked name.
		const inbox = await evaluatePage<{ title: string; who: string; href: string; unread: boolean }>(`
			await until(() => document.querySelectorAll("#inbox-list .item").length === 1);
			const row = document.querySelector("#inbox-list .item");
			const link = row.querySelector(".meta [data-testid=ref-link]");
			return { title: row.querySelector(".title").textContent, who: link.title, href: link.getAttribute("href"), unread: row.classList.contains("unread") };
		`);
		expect(inbox.title).toBe("What is the capital of France?");
		expect(inbox.who).toBe(seeded.session.url);
		expect(inbox.href).toBe(`#/sessions/${seeded.session.id}`);
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

	it("FIL-06 the composers upload an attachment and append the reference", async () => {
		await start([{ text: "Ready when you are." }]);
		const seeded = await seedSession("go");
		await t!.client.post(`/sessions/${seeded.session.id}/stop`);
		await open();

		// Reply: a file from the picker, then a second one dropped on the composer.
		const attached = await evaluatePage<{ body: string; status: string }>(`
			location.hash = "#/threads/${seeded.thread.id}";
			await until(() => !document.getElementById("thread").hidden && document.getElementById("reply-body"));
			const body = document.getElementById("reply-body");
			body.value = "Two things for you.";
			const png = Uint8Array.from(atob(${JSON.stringify(PNG_1X1.toString("base64"))}), (character) => character.charCodeAt(0));
			const picked = new DataTransfer();
			picked.items.add(new File([png], "pixel.png", { type: "image/png" }));
			const input = document.getElementById("reply-files");
			input.files = picked.files;
			input.dispatchEvent(new Event("change"));
			await until(() => body.value.includes("![pixel.png](pana://"));
			const dropped = new DataTransfer();
			dropped.items.add(new File(["a note"], "notes.txt", { type: "text/plain" }));
			document.getElementById("reply-form").dispatchEvent(
				new DragEvent("drop", { dataTransfer: dropped, bubbles: true, cancelable: true }),
			);
			await until(() => body.value.includes("[notes.txt](pana://"));
			return { body: body.value, status: document.getElementById("status").textContent };
		`);
		expect(attached.body).toMatch(/^Two things for you\.\n\n!\[pixel\.png\]\(pana:\/\/.+\/files\/[^/]+\/pixel\.png\)\n\n\[notes\.txt\]\(pana:\/\/.+\/files\/[^/]+\/notes\.txt\)$/);
		expect(attached.status).toBe("Attached 1 file.");

		// The replied message renders the image from the authenticated route.
		const rendered = await evaluatePage<{ image: string; width: number; sent: string }>(`
			document.getElementById("reply-form").requestSubmit();
			await until(() => {
				const body = [...document.querySelectorAll("#thread-messages .body")].at(-1);
				const image = body?.querySelector("img");
				return image && image.src.startsWith("blob:") && image.naturalWidth > 0;
			});
			const body = [...document.querySelectorAll("#thread-messages .body")].at(-1);
			const image = body.querySelector("img");
			return { image: image.src.slice(0, 5), width: image.naturalWidth, sent: body.textContent };
		`);
		expect(rendered.image).toBe("blob:");
		expect(rendered.width).toBe(1);
		// The link text stays as written; only the reference lines are images and links.
		expect(rendered.sent).toContain("Two things for you.");
		const posted = (await messages(seeded.thread.id)).at(-1)!;
		expect(posted.body).toBe(attached.body);
		const imagePath = posted.body!.match(/pana:\/\/\S+?\/pixel\.png/)![0]!.replace(`pana://${TEST_DOMAIN}`, "");
		expect((await t!.client.get(imagePath)).status).toBe(200);

		// Compose: a screenshot pasted into the body attaches the same way.
		const pasted = await evaluatePage<string>(`
			location.hash = "#/compose";
			await until(() => !document.getElementById("view-compose").hidden);
			const box = document.getElementById("compose-body");
			const clipboard = new DataTransfer();
			clipboard.items.add(new File(["from the clipboard"], "pasted.txt", { type: "text/plain" }));
			box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true, cancelable: true }));
			await until(() => box.value.includes("[pasted.txt](pana://"));
			return box.value;
		`);
		expect(pasted).toMatch(/^\[pasted\.txt\]\(pana:\/\/.+\/files\/[^/]+\/pasted\.txt\)$/);
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

	it("REF-06 REF-07 unread counts mark threads and the inbox, follow /events, and the archive buttons hide and restore a thread", async () => {
		await start([{ text: "Paris." }]);
		const seeded = await seedSession("What is the capital of France?");
		// A stopped session queues mail without waking, so an append below is only a delivery.
		await t!.client.post(`/sessions/${seeded.session.id}/stop`);
		await open();

		const marked = await evaluatePage<{ nav: string; hidden: boolean; unread: boolean; count: string }>(`
			await until(() => !document.getElementById("nav-inbox-count").hidden);
			location.hash = "#/threads";
			await until(() => document.querySelectorAll("#threads-list .item").length === 1);
			const row = document.querySelector("#threads-list .item");
			return {
				nav: document.getElementById("nav-inbox-count").textContent,
				hidden: document.getElementById("nav-inbox-count").hidden,
				unread: row.classList.contains("unread"),
				count: row.querySelector(".meta").textContent,
			};
		`);
		expect(marked.hidden).toBe(false);
		expect(marked.nav).toBe("1");
		expect(marked.unread).toBe(true);
		expect(marked.count).toContain("1 unread");

		// REF-07: archive from the thread list, and the list and the nav count both drop it.
		const archived = await evaluatePage<{ items: number; navHidden: boolean }>(`
			document.querySelector("#threads-list [data-testid=thread-archive]").click();
			await until(() => document.querySelectorAll("#threads-list .row").length === 0);
			await until(() => document.getElementById("nav-inbox-count").hidden);
			return { items: document.querySelectorAll("#threads-list .item").length, navHidden: document.getElementById("nav-inbox-count").hidden };
		`);
		expect(archived.items).toBe(0);
		expect(archived.navHidden).toBe(true);
		expect((await t!.client.get<{ threads: unknown[] }>("/threads")).body.threads).toEqual([]);

		// The inbox hides it too, and its row has an Archive button.
		const inboxHidden = await evaluatePage<number>(`
			location.hash = "#/inbox";
			await until(() => document.getElementById("inbox-list").textContent.includes("No messages yet"));
			return document.querySelectorAll("#inbox-list .item").length;
		`);
		expect(inboxHidden).toBe(0);
		expect(await t!.client.get<{ deliveries: unknown[] }>("/inbox")).toMatchObject({ body: { deliveries: [] } });

		// REF-07: the archived filter lists it, and Unarchive restores it.
		const restored = await evaluatePage<{ href: string; after: number; nav: string }>(`
			location.hash = "#/threads";
			await until(() => !document.getElementById("threads-list").hidden);
			document.getElementById("threads-archived").checked = true;
			document.getElementById("threads-search").requestSubmit();
			await until(() => document.querySelectorAll("#threads-list .item").length === 1);
			document.querySelector("#threads-list [data-testid=thread-unarchive]").click();
			await until(() => document.getElementById("nav-inbox-count").textContent === "1");
			document.getElementById("threads-archived").checked = false;
			document.getElementById("threads-search").requestSubmit();
			await until(() => document.querySelectorAll("#threads-list .item").length === 1);
			return {
				href: document.querySelector("#threads-list .item .title").textContent,
				after: document.querySelectorAll("#threads-list .item").length,
				nav: document.getElementById("nav-inbox-count").textContent,
			};
		`);
		expect(restored.after).toBe(1);
		expect(restored.nav).toBe("1");

		// REF-06: opening the thread clears its unread count, and a new delivery brings it back
		// from `/events` without a reload.
		const cleared = await evaluatePage<{ navHidden: boolean; live: string }>(`
			location.hash = "#/threads/${seeded.thread.id}";
			await until(() => !document.getElementById("thread").hidden);
			await until(() => document.getElementById("nav-inbox-count").hidden);
			const navHidden = document.getElementById("nav-inbox-count").hidden;
			location.hash = "#/inbox";
			await until(() => !document.getElementById("view-inbox").hidden);
			return { navHidden, live: document.getElementById("nav-inbox-count").textContent };
		`);
		expect(cleared.navHidden).toBe(true);
		expect(cleared.live).toBe("0");

		const head = (await messages(seeded.thread.id)).at(-1)!.id;
		const sent = await t!.client.post(`/threads/${seeded.thread.id}/messages`, { after: head, body: "a live delivery" }, { caller: seeded.session.id });
		expect(sent.status).toBe(200);
		// UX-03: the live delivery lands in the thread's one row, which shows the new snippet.
		const live = await evaluatePage<{ nav: string; items: number; count: string; snippet: string }>(`
			await until(() => document.getElementById("nav-inbox-count").textContent === "1");
			await until(() => document.querySelector("#inbox-list .item .meta")?.textContent.includes("1 unread"));
			return {
				nav: document.getElementById("nav-inbox-count").textContent,
				items: document.querySelectorAll("#inbox-list .item").length,
				count: document.querySelector("#inbox-list .item .meta").textContent,
				snippet: document.querySelector("#inbox-list [data-testid=inbox-snippet]").textContent,
			};
		`);
		expect(live.nav).toBe("1");
		expect(live.items).toBe(1);
		expect(live.count).toContain("1 unread");
		expect(live.snippet).toContain("a live delivery");

		// REF-07: the inbox row's Archive button removes it.
		const inboxArchived = await evaluatePage<number>(`
			document.querySelector("#inbox-list [data-testid=inbox-archive]").click();
			await until(() => document.getElementById("inbox-list").textContent.includes("No messages yet"));
			return document.querySelectorAll("#inbox-list .item").length;
		`);
		expect(inboxArchived).toBe(0);

		// REF-07: the inbox view's archived filter offers Unarchive.
		const inboxRestored = await evaluatePage<{ unarchive: number; items: number }>(`
			const box = document.getElementById("inbox-archived");
			box.checked = true;
			box.dispatchEvent(new Event("change"));
			await until(() => document.querySelectorAll("#inbox-list [data-testid=inbox-unarchive]").length >= 1);
			const unarchive = document.querySelectorAll("#inbox-list [data-testid=inbox-unarchive]").length;
			document.querySelector("#inbox-list [data-testid=inbox-unarchive]").click();
			await until(() => document.getElementById("inbox-list").textContent.includes("No archived threads"));
			box.checked = false;
			box.dispatchEvent(new Event("change"));
			await until(() => document.querySelectorAll("#inbox-list .item").length === 1);
			return { unarchive, items: document.querySelectorAll("#inbox-list .item").length };
		`);
		expect(inboxRestored.unarchive).toBe(1);
		expect(inboxRestored.items).toBe(1);
		expect((await t!.client.get<{ deliveries: unknown[] }>("/inbox")).body.deliveries).toHaveLength(2);
		expect((await t!.client.get<{ deliveries: unknown[] }>("/inbox?archived=1")).body.deliveries).toEqual([]);
	});

	it("REF-02 the session view archives only after a confirmation", async () => {
		await start([{ text: "Ready when you are." }]);
		const seeded = await seedSession("archive me");
		await open();
		const asked = await evaluatePage<{ text: string; hidden: boolean }>(`
			location.hash = "#/sessions/${seeded.session.id}";
			await until(() => !document.getElementById("session").hidden);
			document.querySelector("[data-testid=session-archive]").click();
			await until(() => !document.getElementById("session-confirm").hidden);
			return { text: document.getElementById("session-confirm-text").textContent, hidden: document.getElementById("session-confirm").hidden };
		`);
		expect(asked.hidden).toBe(false);
		expect(asked.text).toContain("read-only");
		expect((await t!.client.get<{ session: { state: string } }>(`/sessions/${seeded.session.id}`)).body.session.state).not.toBe("archived");

		await evaluatePage(`
			document.getElementById("session-confirm-no").click();
			await until(() => document.getElementById("session-confirm").hidden);
			return true;
		`);
		expect((await t!.client.get<{ session: { state: string } }>(`/sessions/${seeded.session.id}`)).body.session.state).not.toBe("archived");

		await evaluatePage(`
			document.querySelector("[data-testid=session-archive]").click();
			await until(() => !document.getElementById("session-confirm").hidden);
			document.getElementById("session-confirm-yes").click();
			await until(() => document.getElementById("session-meta").textContent.includes("archived"));
			return true;
		`);
		expect((await t!.client.get<{ session: { state: string } }>(`/sessions/${seeded.session.id}`)).body.session.state).toBe("archived");
	});

	it("REF-08 every ID and pana:// URL in the app is a link to its view", async () => {
		await start([{ text: "Paris." }]);
		const seeded = await seedSession("What is the capital of France?");
		const upload = await t!.client.request<{ file: { url: string } }>("POST", "/files?name=note.txt", {
			bytes: Buffer.from("a file\n"),
			headers: { "content-type": "text/plain" },
		});
		expect(upload.status).toBe(201);
		const linked = [
			`A session link: ${seeded.session.url}`,
			`A thread link: pana://${TEST_DOMAIN}/threads/${seeded.thread.id}`,
			`A message link: pana://${TEST_DOMAIN}/threads/${seeded.thread.id}?message=${seeded.message.id}`,
			`A file link: ${upload.body.file.url}`,
			`A user link: pana://${TEST_DOMAIN}/users/tester`,
		].join("\n\n");
		const notice = await postNotice(t!.runtime, { body: linked });
		const at = new Date(FAKE_EPOCH + 3_600_000).toISOString();
		await t!.client.post("/schedules", { kind: "session", at, payload: { prompt: "later" } });
		const schedule = (await t!.client.get<{ schedules: Array<{ id: string }> }>("/schedules")).body.schedules[0]!;
		await open();

		const inbox = await evaluatePage<{ session: string; domains: string[]; count: number }>(`
			await until(() => document.querySelectorAll("#inbox-list .item").length >= 2);
			const rows = [...document.querySelectorAll("#inbox-list .item")];
			const forSession = rows.find((el) => el.dataset.thread === ${JSON.stringify(seeded.thread.id)});
			const forNotice = rows.find((el) => el.dataset.thread === ${JSON.stringify(notice.thread.id)});
			return {
				session: forSession.querySelector("[data-testid=ref-link]").getAttribute("href"),
				domains: [...forNotice.querySelectorAll("[data-testid=ref-link]")].map((a) => a.getAttribute("href")),
				count: document.querySelectorAll("#inbox-list [data-testid=ref-link]").length,
			};
		`);
		// REF-08: a session sender links to its session view, and the domain sender to the app root.
		expect(inbox.session).toBe(`#/sessions/${seeded.session.id}`);
		expect(inbox.domains).toEqual(["/"]);
		expect(inbox.count).toBeGreaterThanOrEqual(2);

		const thread = await evaluatePage<{
			url: string;
			participants: string[];
			senders: string[];
			message: string;
			body: string[];
			files: string[];
		}>(`
			location.hash = "#/threads/${notice.thread.id}";
			await until(() => !document.getElementById("thread").hidden);
			await until(() => document.querySelectorAll("#thread-messages [data-testid=message]").length === 1);
			await until(() => document.querySelectorAll("#thread-messages [data-testid=message] .body a").length >= 4);
			const body = [...document.querySelectorAll("#thread-messages [data-testid=message] .body a")]
				.filter((a) => !a.dataset.filePath)
				.map((a) => a.getAttribute("href"));
			return {
				url: document.querySelector("#thread-url a").getAttribute("href"),
				participants: [...document.querySelectorAll("#thread-participants a")].map((a) => a.getAttribute("href")),
				senders: [...document.querySelectorAll("[data-testid=message-sender]")].map((a) => a.getAttribute("href")),
				message: document.querySelector("[data-testid=message-link]").getAttribute("href"),
				body,
				files: [...document.querySelectorAll("#thread-messages [data-file-path]")].map((el) => el.getAttribute("data-file-path")),
			};
		`);
		expect(thread.url).toBe(`#/threads/${notice.thread.id}`);
		expect(thread.participants).toEqual(["/", "#/inbox"]);
		expect(thread.senders).toEqual(["/"]);
		expect(thread.message).toBe(`#/threads/${notice.thread.id}?message=${notice.message.id}`);
		expect(thread.body).toEqual(
			expect.arrayContaining([
				`#/sessions/${seeded.session.id}`,
				`#/threads/${seeded.thread.id}`,
				`#/threads/${seeded.thread.id}?message=${seeded.message.id}`,
				"#/inbox",
			]),
		);
		expect(thread.files).toEqual([`/files/${upload.body.file.url.split("/")[4]}/note.txt`]);

		// A message header link opens the thread scrolled to that message.
		const focused = await evaluatePage<{ focus: boolean; hash: string }>(`
			document.querySelector("[data-testid=message-link]").click();
			await until(() => document.querySelector("#thread-messages [data-testid=message].focus"));
			return { focus: Boolean(document.querySelector("#thread-messages [data-testid=message].focus")), hash: location.hash };
		`);
		expect(focused.focus).toBe(true);
		expect(focused.hash).toContain(`#/threads/${notice.thread.id}?message=${notice.message.id}`);

		// Sessions: the list and the session view link their IDs, and the parent is a link.
		const sessions = await evaluatePage<{ list: string[]; title: string; meta: string }>(`
			location.hash = "#/sessions";
			await until(() => document.querySelectorAll("#sessions-list .item").length === 1);
			const list = [...document.querySelectorAll("#sessions-list [data-testid=ref-link]")].map((a) => a.getAttribute("href"));
			[...document.querySelectorAll("#sessions-list .item")][0].click();
			await until(() => !document.getElementById("session").hidden);
			return {
				list,
				title: document.querySelector("#session-title a").getAttribute("href"),
				meta: document.getElementById("session-meta").textContent,
			};
		`);
		expect(sessions.list).toContain(`#/sessions/${seeded.session.id}`);
		expect(sessions.title).toBe(`#/sessions/${seeded.session.id}`);

		// Schedules: the ID links to the schedule view, which focuses that row.
		const schedules = await evaluatePage<{ href: string; focus: boolean }>(`
			location.hash = "#/schedules";
			await until(() => !document.getElementById("view-schedules").hidden);
			await until(() => document.querySelectorAll("#schedules-list .item").length === 1);
			const link = document.querySelector("#schedules-list [data-testid=ref-link]");
			const href = link.getAttribute("href");
			link.click();
			await until(() => document.querySelector("#schedules-list .item.focus"));
			return { href, focus: Boolean(document.querySelector("#schedules-list .item.focus")) };
		`);
		expect(schedules.href).toBe(`#/schedules?focus=${schedule.id}`);
		expect(schedules.focus).toBe(true);

		// Transcript: the pana URLs inside a pana.message entry are links.
		const transcript = await evaluatePage<string[]>(`
			location.hash = "#/sessions/${seeded.session.id}";
			await until(() => !document.getElementById("session").hidden);
			await until(() => document.querySelectorAll("#transcript [data-testid=ref-link]").length >= 3);
			return [...document.querySelectorAll("#transcript [data-testid=ref-link]")].map((a) => a.getAttribute("href"));
		`);
		expect(transcript).toEqual(
			expect.arrayContaining([`#/inbox`, `#/threads/${seeded.thread.id}`, `#/threads/${seeded.thread.id}?message=${seeded.message.id}`]),
		);
	});

	it("REF-09 the session view shows thinking, tool calls, tool results, system and compaction entries, and usage", async () => {
		await start(
			[
				{
					thinking: "Check the disk before answering.",
					toolCalls: [{ name: "bash", args: { command: "node -e \"console.log('z'.repeat(2600))\"" } }],
					usage: { input: 11, output: 6, costUsd: 0.0025 },
				},
				{ text: "the long answer", usage: { input: 30, output: 4, costUsd: 0.001 } },
				// Compaction asks the model for a summary.
				{ text: "a compacted summary" },
			],
			{ compaction: { keepRecentTokens: 1 } },
		);
		const seeded = await seedSession("look first");
		await open();
		await evaluatePage(`
			location.hash = "#/sessions/${seeded.session.id}";
			await until(() => !document.getElementById("session").hidden);
			await until(() => document.querySelector("[data-testid=entry-thinking]"));
			return true;
		`);
		const rendered = await evaluatePage<{
			thinkingOpen: boolean;
			thinking: string;
			callArgs: string;
			resultOpen: boolean;
			result: string;
			kinds: string[];
			meta: string;
		}>(`
			await until(() => document.querySelector("[data-testid=entry-tool-result]"));
			const thinking = document.querySelector("[data-testid=entry-thinking]");
			const call = document.querySelector("[data-testid=entry-tool-call]");
			const result = document.querySelector("[data-testid=entry-tool-result]");
			return {
				thinkingOpen: thinking.open,
				thinking: thinking.textContent,
				callArgs: call.querySelector("pre").textContent,
				resultOpen: result.open,
				result: result.querySelector("pre").textContent.length,
				kinds: [...document.querySelectorAll("#transcript [data-testid=entry]")].map((el) => el.dataset.kind),
				meta: [...document.querySelectorAll("#transcript [data-testid=entry-meta]")].map((el) => el.textContent).join(" | "),
			};
		`);
		expect(rendered.thinkingOpen).toBe(false);
		expect(rendered.thinking).toContain("Check the disk before answering.");
		expect(rendered.callArgs).toContain("repeat(2600)");
		// A long tool result is collapsed, with its output still in the DOM.
		expect(rendered.resultOpen).toBe(false);
		expect(rendered.result).toBeGreaterThan(2000);
		expect(rendered.kinds).toEqual(expect.arrayContaining(["pana.message", "pi.system", "pi.assistant", "pi.tool-result"]));
		expect(rendered.meta).toContain("in 11 · out 6");

		// Compaction writes an entry the session view shows.
		await evaluatePage(`
			document.querySelector("[data-testid=session-compact]").click();
			await until(() => [...document.querySelectorAll("#transcript [data-testid=entry]")].some((el) => el.dataset.kind === "pi.compaction"), 20000);
			return true;
		`);
		expect((await t!.client.get<{ entries: Array<{ kind: string }> }>(`/sessions/${seeded.session.id}/transcript`)).body.entries.map((e) => e.kind)).toContain(
			"pi.compaction",
		);
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

	it("UX-10 opening a session lands on its newest entry, with its header and controls pinned in view", async () => {
		const long = "node -e \"console.log('line\\n'.repeat(400))\"";
		await start([
			{ toolCalls: [{ name: "bash", args: { command: long } }] },
			{ toolCalls: [{ name: "bash", args: { command: long } }] },
			{ text: "the newest entry" },
		]);
		const seeded = await seedSession("make it long");
		await open();
		const view = await evaluatePage<{ fromBottom: number; stickyTop: number; topbar: number; controls: boolean }>(`
			location.hash = "#/sessions/${seeded.session.id}";
			await until(() => !document.getElementById("session").hidden);
			await until(() => document.getElementById("transcript").textContent.includes("the newest entry"));
			await new Promise((r) => requestAnimationFrame(() => r()));
			const root = document.scrollingElement;
			const sticky = document.querySelector("[data-testid=session-sticky]").getBoundingClientRect();
			const stop = document.querySelector("[data-testid=session-stop]").getBoundingClientRect();
			return {
				fromBottom: root.scrollHeight - root.scrollTop - root.clientHeight,
				stickyTop: sticky.top,
				topbar: document.querySelector(".topbar").getBoundingClientRect().bottom,
				controls: stop.top >= 0 && stop.bottom <= innerHeight,
			};
		`);
		expect(view.fromBottom).toBeLessThan(2);
		expect(Math.abs(view.stickyTop - view.topbar)).toBeLessThan(4);
		expect(view.controls).toBe(true);

		// The header shows the session's pana:// URL, as a thread's header does.
		const url = await evaluatePage<string>(`return document.querySelector("[data-testid=session-url] a")?.textContent ?? ""`);
		expect(url).toBe(`pana://test.example/sessions/${seeded.session.id}`);
	});

	it("UX-13 New on the Threads page opens the composer, and the nav has no Compose item", async () => {
		await start([]);
		await open();
		const view = await evaluatePage<{ navCompose: boolean; composeVisible: boolean; current: string | null }>(`
			location.hash = "#/threads";
			await until(() => !document.getElementById("view-threads").hidden);
			document.querySelector("[data-testid=threads-new]").click();
			await until(() => !document.getElementById("view-compose").hidden);
			return {
				navCompose: Boolean(document.querySelector('#nav a[data-section="compose"]')),
				composeVisible: !document.getElementById("view-compose").hidden,
				current: document.querySelector('#nav a[aria-current="page"]')?.dataset.section ?? null,
			};
		`);
		expect(view).toEqual({ navCompose: false, composeVisible: true, current: "threads" });
	});
});
