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

async function start(script: Script = [], settings?: HarnessSettings, config: Record<string, unknown> = {}): Promise<TestPanad> {
	t = await startTestPanad({ script, settings, config: { defaultModel: "faux/faux-1", timezone: "UTC", ...config } });
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
	it("MEM-09 browser saves a session-created file from a stale worktree and retains edits on a stale-editor conflict", async () => {
		await start([{ text: "Ready." }]);
		await t!.client.get("/memory/worktree"); // The UI user's checkout predates the file.
		const session = await seedSession("Create a memory note");
		const created = await t!.client.post("/memory/files/profile.md", { content: "# Profile\n\nPrincipal engineer\n" }, { caller: session.session.id });
		expect(created.status).toBe(201);
		await open();
		await evaluatePage(`
			await until(() => window.__pana && document.getElementById("authorize").hidden);
			location.hash = "#/memory/edit/profile.md";
			await until(() => !document.getElementById("memory-edit-view").hidden && window.__pana.memoryEditor);
			window.__pana.memoryEditor.load("# Profile\\n\\nSenior Staff engineer\\n");
			document.getElementById("memory-save").click();
			await until(() => location.hash === "#/memory/files/profile.md" && document.getElementById("memory-file").textContent.includes("Senior Staff"));
			return true;
		`);
		expect((await t!.client.get<{ content: string }>("/memory/files/profile.md")).body.content).toContain("Senior Staff engineer");
		await evaluatePage(`
			document.getElementById("memory-edit-link").click();
			await until(() => !document.getElementById("memory-edit-view").hidden && document.activeElement.closest("#memory-editor") && window.__pana.memoryEditor.value().includes("Senior Staff"));
			window.__pana.memoryEditor.load("my unsaved correction");
			return true;
		`);
		expect((await t!.client.post("/memory/files/profile.md", { content: "newer session correction\n" }, { caller: session.session.id })).status).toBe(201);
		const stale = await evaluatePage<{ content: string; path: string; error: string }>(`
			document.getElementById("memory-save").click();
			await until(() => document.getElementById("status").textContent.includes("changed since you opened it"));
			return { content: window.__pana.memoryEditor.value(), path: location.hash, error: document.getElementById("status").textContent };
		`);
		expect(stale.content).toBe("my unsaved correction");
		expect(stale.path).toBe("#/memory/edit/profile.md");
		expect(stale.error).toContain("Copy your edits");
		expect((await t!.client.get<{ content: string }>("/memory/files/profile.md")).body.content).toBe("newer session correction\n");
	});

	it("MEM-09 switching editor routes cannot pair an old asynchronous load with the new file path", async () => {
		await start();
		await t!.client.post("/memory/files/a.md", { content: "file A\n" });
		await t!.client.post("/memory/files/b.md", { content: "file B\n" });
		await open();
		const result = await evaluatePage<{ content: string; title: string; disabled: boolean }>(`
			await until(() => window.__pana && document.getElementById("authorize").hidden);
			const original = window.fetch;
			let release;
			const gate = new Promise(resolve => { release = resolve; });
			let pending = false;
			window.fetch = async (path, options) => {
				const response = await original(path, options);
				if (path === "/memory/files/a.md" && options.method === "GET") {
					pending = true;
					await gate;
				}
				return response;
			};
			try {
				location.hash = "#/memory/edit/a.md";
				await until(() => pending);
				const disabled = document.getElementById("memory-save").disabled;
				location.hash = "#/memory/edit/b.md";
				await until(() => window.__pana.memoryEditor?.value() === "file B\\n" && !document.getElementById("memory-save").disabled);
				release();
				await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
				const content = window.__pana.memoryEditor.value();
				const title = document.getElementById("memory-edit-title").textContent;
				window.__pana.memoryEditor.load("edited B\\n");
				document.getElementById("memory-save").click();
				await until(() => location.hash === "#/memory/files/b.md" && document.getElementById("memory-file").textContent.includes("edited B"));
				return { content, title, disabled };
			} finally {
				release();
				window.fetch = original;
			}
		`);
		expect(result).toEqual({ content: "file B\n", title: "b.md", disabled: true });
		expect((await t!.client.get<{ content: string }>("/memory/files/a.md")).body.content).toBe("file A\n");
		expect((await t!.client.get<{ content: string }>("/memory/files/b.md")).body.content).toBe("edited B\n");
	});

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
		const memory = await evaluatePage<{
			worktree: string;
			files: string[];
			content: string;
			log: string;
			listHidden: boolean;
			commit: string;
			commitBack: string;
			source: string;
		}>(`
			location.hash = "#/memory";
			await until(() => document.getElementById("memory-worktree").textContent.includes("memory/worktrees/tester"));
			await until(() => document.querySelectorAll("#memory-files .item").length === 1);
			document.getElementById("memory-query").value = "MEMORY";
			document.getElementById("memory-search").requestSubmit();
			await until(() => document.querySelectorAll("#memory-results .item").length === 1);
			document.querySelector("#memory-results .item").click();
			await until(() => !document.getElementById("memory-file-view").hidden && document.getElementById("memory-file").textContent.includes("hello memory"));
			// MEM-11: a file stands alone; the file list and the edit pane are not beside it.
			const listHidden = document.getElementById("memory-browse").hidden;
			// Source is the exact bytes the editor opens, and the reader can switch back.
			document.getElementById("memory-source").click();
			await until(() => location.hash.includes("?source=1") && document.getElementById("memory-file").classList.contains("raw"));
			const source = document.getElementById("memory-file").textContent;
			document.getElementById("memory-source").click();
			await until(() => !location.hash.includes("source=1") && document.getElementById("memory-file").classList.contains("memory-markdown"));
			document.getElementById("memory-edit-link").click();
			await until(() => !document.getElementById("memory-edit-view").hidden && window.__pana.memoryEditor);
			window.__pana.memoryEditor.load("# Notes\\n\\nhello memory, edited\\n");
			document.querySelector("[data-testid=memory-save]").click();
			await until(() => location.hash.startsWith("#/memory/files/") && document.getElementById("memory-file").textContent.includes("edited"));
			// The log at the bottom of the browse view opens a commit of its own (MEM-11).
			location.hash = "#/memory";
			await until(() => document.querySelectorAll("#memory-log .item").length === 3);
			const commitRow = document.querySelector("#memory-log .item");
			commitRow.click();
			await until(() => !document.getElementById("memory-commit-view").hidden && document.querySelectorAll("#memory-commit-files .commit-file").length === 1);
			return {
				worktree: document.getElementById("memory-worktree").textContent,
				files: [...document.querySelectorAll("#memory-files .item")].map((el) => el.dataset.path),
				content: location.hash.startsWith("#/memory/commits/") ? document.getElementById("memory-commit-files").textContent : "",
				log: commitRow.textContent,
				listHidden,
				commit: document.getElementById("memory-commit-subject").textContent + " " + document.getElementById("memory-commit-files").textContent,
				commitBack: document.getElementById("memory-commit-back").getAttribute("href"),
				source,
			};
		`);
		expect(memory.files).toEqual(["notes.md"]);
		expect(memory.listHidden).toBe(true);
		expect(memory.log).toContain("Update notes.md");
		// The row names its author the way every other view does, as the shortened URL label.
		expect(memory.log).toContain("tester");
		expect(memory.commit).toContain("Update notes.md");
		expect(memory.commit).toContain("+hello memory, edited");
		expect(memory.commitBack).toBe("#/memory");
		expect(memory.source).toBe("# Notes\n\nhello memory\n");
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
		// FIL-07: an inline image asks for a bounded copy; the original stays behind the link.
		expect(rendered.files).toContain(`/files/${upload.body.file.id}/pixel.png?w=1024`);
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

	it("REF-07 hides archive actions for a thread the reader is not in, including keyboard and palette", async () => {
		await start([{ text: "Ready." }]);
		const seeded = await seedSession("A participant thread");
		await t!.client.post(`/sessions/${seeded.session.id}/stop`);
		const made = await t!.client.post<{ thread: { id: string } }>("/threads", {
			to: [seeded.session.id], body: "Session-only discussion",
		}, { caller: seeded.session.id });
		expect(made.status).toBe(201);
		const id = made.body.thread.id;
		expect((await t!.client.get<{ canArchive: boolean }>(`/threads/${id}`)).body.canArchive).toBe(false);
		expect((await t!.client.post(`/threads/${id}/archive`, {})).status).toBe(403);
		await open();
		const result = await evaluatePage<{ hidden: boolean; paletteArchive: boolean; listActions: number }>(`
			location.hash = "#/threads";
			await until(() => document.querySelector("#threads-list [data-thread='${id}']"));
			const listActions = document.querySelectorAll("#threads-list .item-actions").length;
			location.hash = "#/threads/${id}";
			await until(() => !document.getElementById("thread").hidden && document.getElementById("thread-subject").textContent === "Session-only discussion");
			document.activeElement?.blur();
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "e", bubbles: true }));
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
			await until(() => !document.getElementById("palette").hidden);
			return { hidden: document.getElementById("thread-archive").hidden,
				paletteArchive: Boolean(document.querySelector("[data-command=archive-thread]")), listActions };
		`);
		expect(result).toEqual({ hidden: true, paletteArchive: false, listActions: 0 });
		expect((await t!.client.get<{ archived: boolean }>(`/threads/${id}`)).body.archived).toBe(false);
	});

	it("REF-03 participant membership filters domain-wide thread browsing and text search", async () => {
		await start([{ text: "Ready." }]);
		const seeded = await seedSession("A participant thread");
		await t!.client.post(`/sessions/${seeded.session.id}/stop`);
		const made = await t!.client.post<{ thread: { id: string } }>("/threads", {
			to: [seeded.session.id], body: "Session-only discussion",
		}, { caller: seeded.session.id });
		expect(made.status).toBe(201);
		const notice = await postNotice(t!.runtime, { body: "Domain announcement" });
		await t!.client.post(`/threads/${notice.thread.id}/archive`, {});
		await open();
		const result = await evaluatePage<{ all: string[]; member: string[]; hits: string[]; user: string[]; requests: string[]; paletteHit: boolean }>(`
			await until(() => window.__pana && document.getElementById("authorize").hidden);
			const requests = [];
			const originalFetch = window.fetch;
			window.fetch = (...args) => {
				if (String(args[0]).includes("/threads")) requests.push(String(args[0]));
				return originalFetch(...args);
			};
			location.hash = "#/threads";
			const ids = () => [...document.querySelectorAll("#threads-list .item")].map(row => row.dataset.thread);
			await until(() => ids().length === 3);
			const all = ids();
			if (document.getElementById("threads-unread") || document.querySelector("#threads-list .archived, #threads-list .unread, #threads-list .badge, #threads-list .unread-count")) throw new Error("personal state in browse");
			document.getElementById("threads-participant").value = "${seeded.session.id}";
			document.getElementById("threads-search").requestSubmit();
			await until(() => ids().length === 2);
			const member = ids();
			document.getElementById("threads-participant").value = "${seeded.session.url}";
			document.getElementById("threads-query").value = "Session-only";
			document.getElementById("threads-search").requestSubmit();
			await until(() => ids().length === 1 && ids()[0] === "${made.body.thread.id}");
			const hits = ids();
			document.getElementById("threads-participant").value = "tester";
			document.getElementById("threads-query").value = "";
			document.getElementById("threads-search").requestSubmit();
			await until(() => ids().length === 2 && !ids().includes("${made.body.thread.id}"));
			const user = ids();
			document.getElementById("open-palette").click();
			await until(() => !document.getElementById("palette").hidden);
			const commands = document.getElementById("palette-input");
			commands.value = "search";
			commands.dispatchEvent(new Event("input", { bubbles: true }));
			commands.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
			await until(() => document.activeElement?.id === "palette-search-input");
			const search = document.getElementById("palette-search-input");
			search.value = "Domain announcement";
			search.dispatchEvent(new Event("input", { bubbles: true }));
			await until(() => document.querySelector("#palette-list [data-testid=palette-hit]"));
			return { all, member, hits, user, requests, paletteHit: document.getElementById("palette-list").textContent.includes("Domain announcement") };
		`);
		expect(result.all.sort()).toEqual([seeded.thread.id, made.body.thread.id, notice.thread.id].sort());
		expect(result.member.sort()).toEqual([seeded.thread.id, made.body.thread.id].sort());
		expect(result.hits).toEqual([made.body.thread.id]);
		expect(result.user.sort()).toEqual([seeded.thread.id, notice.thread.id].sort());
		expect(result.paletteHit).toBe(true);
		expect(result.requests.length).toBeGreaterThanOrEqual(5);
		for (const request of result.requests) {
			const params = new URL(request, "http://test.example").searchParams;
			expect(params.has("includeArchived")).toBe(false);
			expect(params.has("unread")).toBe(false);
		}
		expect(result.requests.some(request => new URL(request, "http://test.example").searchParams.get("participant") === seeded.session.url)).toBe(true);
	});

	it("REF-06 REF-07 unread counts stay in the inbox; archive controls do not hide threads from browse or search", async () => {
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
		expect(marked.unread).toBe(false);
		expect(marked.count).not.toContain("unread");
		expect(marked.count).not.toContain("archived");

		// The Threads list has no archive actions; archive from the open thread instead.
		const archived = await evaluatePage<{ items: number; navHidden: boolean }>(`
			if (document.querySelector("#threads-list .item-actions") || document.getElementById("threads-archived")) throw new Error("unexpected list archive control");
			location.hash = "#/threads/${seeded.thread.id}";
			await until(() => !document.getElementById("thread").hidden);
			document.getElementById("thread-archive").click();
			await until(() => document.querySelector("[data-testid=thread-unarchive]"));
			location.hash = "#/threads";
			await until(() => !document.getElementById("threads-list").hidden && document.querySelector("#threads-list .item"));
			return { items: document.querySelectorAll("#threads-list .item").length, navHidden: document.getElementById("nav-inbox-count").hidden };
		`);
		expect(archived.items).toBe(1);
		expect(archived.navHidden).toBe(true);
		expect((await t!.client.get<{ threads: unknown[] }>("/threads")).body.threads).toHaveLength(1);

		// The inbox hides it too, and its row has an Archive button.
		const inboxHidden = await evaluatePage<number>(`
			location.hash = "#/inbox";
			await until(() => document.getElementById("inbox-list").textContent.includes("No messages yet"));
			return document.querySelectorAll("#inbox-list .item").length;
		`);
		expect(inboxHidden).toBe(0);
		expect(await t!.client.get<{ deliveries: unknown[] }>("/inbox")).toMatchObject({ body: { deliveries: [] } });

		// Searching also finds archived threads, with no caller-specific state label.
		const restored = await evaluatePage<number>(`
			location.hash = "#/threads";
			await until(() => !document.getElementById("threads-list").hidden);
			document.getElementById("threads-query").value = "France";
			document.getElementById("threads-search").requestSubmit();
			await until(() => document.querySelector("#threads-list .meta")?.textContent.includes("France"));
			if (document.querySelector("#threads-list .archived, #threads-list .unread, #threads-list .unread-count")) throw new Error("personal state in browse");
			location.hash = "#/threads/${seeded.thread.id}";
			await until(() => !document.getElementById("thread").hidden);
			document.getElementById("thread-archive").click();
			await until(() => document.querySelector("[data-testid=thread-archive]"));
			location.hash = "#/threads";
			await until(() => !document.getElementById("threads-list").hidden && document.querySelector("#threads-list .item"));
			return document.querySelectorAll("#threads-list .item").length;
		`);
		expect(restored).toBe(1);

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

	it("UX-16 the thread header regenerates the subject and keeps the old ones", async () => {
		// With a subject model set, the button asks it; a notice starts at its first line, no job.
		await start([{ text: "Lantern maintenance plan" }], undefined, { subjectModel: "faux/faux-1" });
		const notice = await postNotice(t!.runtime, { body: "we should talk about the lantern\nand the schedule" });
		await open();

		const regenerated = await evaluatePage<{ before: string; after: string; status: string; label: string; disabled: boolean }>(`
			location.hash = "#/threads/${notice.thread.id}";
			await until(() => !document.getElementById("thread").hidden);
			await until(() => document.getElementById("thread-subject").textContent === "we should talk about the lantern");
			const before = document.getElementById("thread-subject").textContent;
			document.getElementById("thread-subject-regenerate").click();
			await until(() => document.getElementById("thread-subject").textContent === "Lantern maintenance plan");
			const button = document.getElementById("thread-subject-regenerate");
			return {
				before,
				after: document.getElementById("thread-subject").textContent,
				status: document.getElementById("status").textContent,
				label: button.textContent,
				disabled: button.disabled,
			};
		`);
		expect(regenerated.before).toBe("we should talk about the lantern");
		expect(regenerated.after).toBe("Lantern maintenance plan");
		expect(regenerated.status).toContain("Subject regenerated");
		// The button comes back for another try, rather than staying busy.
		expect(regenerated.label).toBe("Regenerate subject");
		expect(regenerated.disabled).toBe(false);
		// SUB-04: the old subject is history now, not lost.
		const history = await t!.client.post<{ subject: string; history: Array<{ subject: string; source: string }> }>(
			`/threads/${notice.thread.id}/subject`,
			{},
		);
		expect(history.body.subject).toBe("Lantern maintenance plan");
		expect(history.body.history.map((entry) => entry.subject)).toEqual(["we should talk about the lantern", "Lantern maintenance plan"]);
		expect(history.body.history.map((entry) => entry.source)).toEqual(["first-line", "model"]);
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

	it("WAK-04 the schedules list shows a wake's note and session, with Delete and no Edit", async () => {
		await start([{ text: "watching" }]);
		const seeded = await seedSession("watch PR 75");
		const wake = await t!.client.post("/schedules", { kind: "wake", in: "10m", note: "Check CI on PR 75" }, { caller: seeded.session.id });
		expect(wake.status, JSON.stringify(wake.body)).toBe(201);
		await open();
		const row = await evaluatePage<{ text: string; actions: string[]; link: string }>(`
			location.hash = "#/schedules";
			const row = await until(() => [...document.querySelectorAll("#schedules-list .item")].find((el) => el.textContent.includes("wake")));
			return {
				text: row.textContent,
				actions: [...row.querySelectorAll("button")].map((button) => button.textContent),
				link: [...row.querySelectorAll("a")].map((a) => a.getAttribute("href")).find((href) => href.includes("/sessions/")) ?? "",
			};
		`);
		expect(row.text).toContain("Check CI on PR 75");
		expect(row.actions).toEqual(["Delete"]);
		expect(row.link).toContain(seeded.session.id);
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

	it("PSH-05 a notification click opens its thread from the cache, on boot or on focus, and from the worker's message", async () => {
		await start();
		const seeded = await seedSession("tell me about the tide");
		const origin = await open();
		const thread = `#/threads/${seeded.thread.id}`;
		// A click's target is left in the cache for the page, because a browser may only focus the
		// window or open the app at `/`. The cache belongs to the origin, so one window can leave
		// the note that the next boot reads.
		await evaluatePage(`
			const cache = await caches.open("pana-notification");
			await cache.put("/__pana-notification-target", new Response(JSON.stringify({ target: "/${thread}", at: Date.now() })));
			return true;
		`);
		await closePage(page!);
		page = await newPage(`${origin}/#${t!.panad.webToken}`);
		const booted = await evaluatePage<string>(`
			await until(() => location.hash === "${thread}");
			await until(() => !document.getElementById("thread").hidden);
			return location.hash;
		`);
		expect(booted).toBe(thread);

		// The same click on a window that is already open: adopted when it is focused.
		const focused = await evaluatePage<string>(`
			location.hash = "#/inbox";
			await until(() => location.hash === "#/inbox");
			const cache = await caches.open("pana-notification");
			await cache.put("/__pana-notification-target", new Response(JSON.stringify({ target: "/${thread}", at: Date.now() })));
			window.dispatchEvent(new Event("focus"));
			await until(() => location.hash === "${thread}");
			await until(() => !document.getElementById("thread").hidden);
			return location.hash;
		`);
		expect(focused).toBe(thread);

		// And when the worker can reach the page: the same target, as a message.
		const messaged = await evaluatePage<string>(`
			location.hash = "#/inbox";
			await until(() => location.hash === "#/inbox");
			navigator.serviceWorker.dispatchEvent(new MessageEvent("message", { data: { type: "open", target: "/${thread}" } }));
			await until(() => location.hash === "${thread}");
			return location.hash;
		`);
		expect(messaged).toBe(thread);
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
	it("MEM-11 a memory file and a commit are their own views, and the log opens the commit", async () => {
		await start([]);
		await open();
		await t!.client.post("/memory/files/guide.md", { content: "# Guide\n\nFirst line.\n" });
		await t!.client.post("/memory/files/guide.md", { content: "# Guide\n\nSecond line.\n" });
		const shown = await evaluatePage<{
			browseHidden: boolean;
			editorHidden: boolean;
			source: string;
			sourceClass: string;
			commitSubject: string;
			commitPatch: string;
			commitBack: string;
		}>(`
			location.hash = "#/memory";
			await until(() => document.querySelectorAll("#memory-files .item").length === 1 && document.querySelectorAll("#memory-log .item").length === 3);
			document.querySelector("#memory-files .item").click();
			await until(() => !document.getElementById("memory-file-view").hidden && document.getElementById("memory-file").textContent.includes("Second line"));
			// Opening a file hides the list and the editor; Edit is a button, not a pane already open.
			const browseHidden = document.getElementById("memory-browse").hidden;
			const editorHidden = document.getElementById("memory-edit-view").hidden;
			document.getElementById("memory-source").click();
			await until(() => location.hash.includes("?source=1") && document.getElementById("memory-file").classList.contains("raw"));
			const source = document.getElementById("memory-file").textContent;
			const sourceClass = document.getElementById("memory-file").className;
			document.getElementById("memory-file-back").click();
			await until(() => !document.getElementById("memory-browse").hidden);
			document.querySelector("#memory-log .item").click();
			await until(() => !document.getElementById("memory-commit-view").hidden && document.getElementById("memory-commit-subject").textContent.length > 0);
			return {
				browseHidden,
				editorHidden,
				source,
				sourceClass,
				commitSubject: document.getElementById("memory-commit-subject").textContent,
				commitPatch: document.getElementById("memory-commit-files").textContent,
				commitBack: document.getElementById("memory-commit-back").getAttribute("href"),
			};
		`);
		expect(shown.browseHidden).toBe(true);
		expect(shown.editorHidden).toBe(true);
		expect(shown.source).toBe("# Guide\n\nSecond line.\n");
		expect(shown.sourceClass).toContain("raw");
		expect(shown.commitSubject).toBe("Update guide.md");
		expect(shown.commitPatch).toContain("-First line.");
		expect(shown.commitPatch).toContain("+Second line.");
		expect(shown.commitBack).toBe("#/memory");
	});

	it("MEM-13 deleting a memory file requires confirmation, supports cancellation and refreshes the list", async () => {
		await start();
		await t!.tcp.post("/memory/files/delete%20me.md", { content: "# Temporary note\n" });
		await open();
		const result = await evaluatePage(`
			location.hash = "#/memory/files/delete%20me.md";
			await until(() => document.getElementById("memory-file").textContent.includes("Temporary note"));
			document.getElementById("memory-delete").click();
			if (document.getElementById("memory-delete-confirmation").hidden) throw new Error("no confirmation");
			if (document.getElementById("memory-delete-path").textContent !== "delete me.md") throw new Error("wrong path");
			document.getElementById("memory-delete-cancel").click();
			if (!document.getElementById("memory-delete-confirmation").hidden) throw new Error("did not cancel");
			if (location.hash !== "#/memory/files/delete%20me.md") throw new Error("cancel navigated");
			document.getElementById("memory-delete").click();
			document.getElementById("memory-delete-confirm").click();
			await until(() => location.hash === "#/memory" && !document.getElementById("memory-browse").hidden);
			await until(() => document.getElementById("memory-files").textContent.includes("Memory is empty."));
			return true;
		`);
		expect(result).toBe(true);
		expect((await t!.tcp.get("/memory/files/delete%20me.md")).status).toBe(404);
	});

	it("MEM-12 editing and creating use a full-view code editor, and Save commits as the user", async () => {
		await start([]);
		await open();
		await t!.client.post("/memory/files/notes.md", { content: "# Notes\n\nold\n" });
		const layout = await evaluatePage<{ gutter: boolean; label: string; height: number; lines: number }>(`
			location.hash = "#/memory/edit/notes.md";
			await until(() => !document.getElementById("memory-edit-view").hidden && window.__pana.memoryEditor && document.querySelector("#memory-editor .cm-editor"));
			const editor = document.querySelector("#memory-editor");
			return {
				gutter: Boolean(editor.querySelector(".cm-gutters")),
				label: editor.querySelector(".cm-content")?.getAttribute("aria-label") ?? "",
				height: editor.getBoundingClientRect().height,
				lines: editor.querySelectorAll(".cm-line").length,
			};
		`);
		expect(layout.gutter).toBe(true);
		expect(layout.label).toBe("Memory file content");
		expect(layout.height).toBeGreaterThan(300);
		// Three text lines plus the empty line after the trailing newline.
		expect(layout.lines).toBeGreaterThanOrEqual(3);

		// Create view: a path field and the same editor, and Save writes through the API.
		const created = await evaluatePage<string>(`
			location.hash = "#/memory/new";
			await until(() => !document.getElementById("memory-edit-view").hidden && !document.getElementById("memory-path-field").hidden && window.__pana.memoryEditor);
			document.getElementById("memory-path-input").value = "notes/from-the-editor.md";
			window.__pana.memoryEditor.load("# From the editor\\n\\nSaved from a phone-sized screen.\\n");
			document.getElementById("memory-save").click();
			await until(() => location.hash.startsWith("#/memory/files/") && document.getElementById("memory-file").textContent.includes("Saved from a phone-sized screen"));
			return location.hash;
		`);
		expect(created).toBe("#/memory/files/notes/from-the-editor.md");
		const written = await t!.client.get<{ content: string }>("/memory/files/notes/from-the-editor.md");
		expect(written.body.content).toContain("Saved from a phone-sized screen.");
	});
});
