import { afterEach, describe, expect, it } from "vitest";
import { loopbackOrigin } from "../../src/web/static.ts";
import { chromeDevtoolsAvailable, closePage, evaluatePage, newPage } from "./cli.ts";
import { seedDomain, type Seeded } from "./seed.ts";

let seeded: Seeded | undefined;
let page: number | undefined;
afterEach(async () => {
	if (page !== undefined) await closePage(page);
	await seeded?.t.close();
});

(chromeDevtoolsAvailable() ? describe : describe.skip)("bookmarks", () => {
	it("BKM-04 the message menu saves a message, labels the action with the state, and saves no second time", async () => {
		seeded = await seedDomain();
		const { t, capital } = seeded;
		const origin = loopbackOrigin(t.panad.tcpPort!);
		page = await newPage(`${origin}/#${t.panad.webToken}`);
		await evaluatePage(`
			location.hash = "#/threads/${capital.threadId}";
			await until(() => document.querySelectorAll("#thread-messages [data-testid=message]").length >= 2);
			return true;
		`);

		const labels = await evaluatePage<string[]>(`
			const message = document.querySelector("#thread-messages [data-testid=message]");
			const menu = message.querySelector("[data-testid=message-menu]");
			const open = async () => {
				if (!menu.open) menu.querySelector("summary").click();
				await until(() => menu.open);
			};
			await open();
			const before = message.querySelector("[data-testid=message-bookmark]").textContent;
			message.querySelector("[data-testid=message-bookmark]").click();
			await until(() => document.getElementById("status").textContent === "Bookmarked.");
			await open();
			const after = message.querySelector("[data-testid=message-bookmark]").textContent;
			return [before, after];
		`);
		expect(labels).toEqual(["Bookmark", "Remove bookmark"]);

		// Saving twice keeps one bookmark, and a reload keeps the label.
		await t.client.post(`/messages/${capital.messageIds[0]}/bookmark`, {});
		await evaluatePage(`
			location.hash = "#/threads";
			await until(() => !document.getElementById("threads-browse").hidden);
			location.hash = "#/threads/${capital.threadId}";
			await until(() => document.querySelectorAll("#thread-messages [data-testid=message]").length >= 2);
			return true;
		`);
		const saved = await evaluatePage<string>(`
			const message = document.querySelector("#thread-messages [data-testid=message]");
			const menu = message.querySelector("[data-testid=message-menu]");
			menu.querySelector("summary").click();
			await until(() => menu.open);
			return message.querySelector("[data-testid=message-bookmark]").textContent;
		`);
		expect(saved).toBe("Remove bookmark");
		const list = await t.client.get<{ bookmarks: unknown[] }>("/bookmarks");
		expect(list.body.bookmarks).toHaveLength(1);
	});

	it("BKM-07 message feedback stays visible for both toggle directions, reload, and failures", async () => {
		seeded = await seedDomain();
		const { t, capital } = seeded;
		const origin = loopbackOrigin(t.panad.tcpPort!);
		page = await newPage(`${origin}/#${t.panad.webToken}`);
		const states = await evaluatePage<string[]>(`
			location.hash = "#/threads/${capital.threadId}";
			await until(() => document.querySelectorAll("#thread-messages [data-testid=message]").length >= 2);
			const message = document.querySelector("#thread-messages .selected");
			const indicator = message.querySelector("[data-testid=bookmark-indicator]");
			const button = message.querySelector("[data-testid=message-bookmark]");
			const press = () => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "b", bubbles: true, cancelable: true }));
			const out = [indicator.textContent, indicator.getAttribute("aria-live")];
			press();
			await until(() => indicator.textContent === "Bookmarked");
			out.push(indicator.textContent, button.textContent, String(indicator.getBoundingClientRect().width > 0));
			press();
			await until(() => indicator.textContent === "Bookmark removed");
			out.push(indicator.textContent, button.textContent);
			// The menu uses the same feedback. A rejected request must not claim a state change.
			button.click();
			await until(() => indicator.textContent === "Bookmarked");
			const realFetch = window.fetch;
			window.fetch = (url, options) => String(url).endsWith("/unbookmark")
				? Promise.resolve(new Response(JSON.stringify({ error: { message: "Test failure" } }), { status: 500 }))
				: realFetch(url, options);
			try {
				press();
				await until(() => indicator.textContent === "Bookmarked · update failed");
				out.push(indicator.textContent, button.textContent);
			} finally { window.fetch = realFetch; }
			return out;
		`);
		expect(states).toEqual(["", "polite", "Bookmarked", "Remove bookmark", "true", "Bookmark removed", "Bookmark", "Bookmarked · update failed", "Remove bookmark"]);
		const reload = await evaluatePage<string[]>(`
			location.hash = "#/threads";
			await until(() => !document.getElementById("threads-browse").hidden);
			location.hash = "#/threads/${capital.threadId}";
			await until(() => !document.getElementById("thread").hidden && document.querySelectorAll("#thread-messages [data-testid=message]").length >= 2);
			return [...document.querySelectorAll("#thread-messages [data-testid=bookmark-indicator]")].map((el) => el.textContent);
		`);
		expect(reload).toEqual(["", "Bookmarked"]);
		const list = await t.client.get<{ bookmarks: Array<{ messageId: string }> }>("/bookmarks");
		expect(list.body.bookmarks.map((row) => row.messageId)).toEqual([capital.messageIds[1]]);
	});

	it("UX-08 b toggles the selected or focused message, not input text or another view", async () => {
		seeded = await seedDomain();
		const { t, capital } = seeded;
		const origin = loopbackOrigin(t.panad.tcpPort!);
		page = await newPage(`${origin}/#${t.panad.webToken}`);
		const result = await evaluatePage<{ first: string; second: string; afterInput: string; afterRepeat: string }>(`
			location.hash = "#/threads/${capital.threadId}";
			await until(() => document.querySelectorAll("#thread-messages [data-testid=message]").length >= 2);
			const messages = [...document.querySelectorAll("#thread-messages [data-testid=message]")];
			const press = (key, target = document.body, extra = {}) => target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra }));
			const label = (message) => message.querySelector("[data-testid=message-bookmark]").textContent;
			// Opening selects the latest message. k selects the previous message without moving DOM focus.
			press("k");
			press("b");
			await until(() => label(messages[0]) === "Remove bookmark");
			const first = label(messages[0]);
			const second = label(messages[1]);
			// Typing in the reply must not toggle the selection.
			const input = document.getElementById("reply-body");
			input.focus();
			press("b", input);
			const afterInput = label(messages[0]);
			// Native focus on another message changes the target. Repeated keydown does not toggle.
			messages[1].focus();
			press("b", messages[1], { repeat: true });
			const afterRepeat = label(messages[1]);
			press("b", messages[1]);
			await until(() => label(messages[1]) === "Remove bookmark");
			press("b", messages[1]);
			await until(() => label(messages[1]) === "Bookmark");
			// The menu and keyboard share the same state.
			messages[0].focus();
			press("b", messages[0]);
			await until(() => label(messages[0]) === "Bookmark");
			return { first, second, afterInput, afterRepeat };
		`);
		expect(result).toEqual({ first: "Remove bookmark", second: "Bookmark", afterInput: "Remove bookmark", afterRepeat: "Bookmark" });
		expect((await t.client.get<{ bookmarks: unknown[] }>("/bookmarks")).body.bookmarks).toHaveLength(0);

		// The same key on a list cannot act on a hidden thread message; g b still navigates.
		await evaluatePage(`
			location.hash = "#/threads";
			await until(() => !document.getElementById("threads-browse").hidden);
			const press = (key) => document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
			press("b");
			press("g"); press("b");
			await until(() => location.hash === "#/bookmarks");
			return true;
		`);
		expect((await t.client.get<{ bookmarks: unknown[] }>("/bookmarks")).body.bookmarks).toHaveLength(0);
	});

	it("BKM-05 the Bookmarks section shows the whole message, opens it in its thread, and removes it in place", async () => {
		// A reply longer than a list snippet, with a phrase only the end of it carries.
		const reply = [
			"Paris is the capital of France.",
			"",
			"The release note is a different question, and this second paragraph is here to prove the bookmark card shows the whole message rather than its first hundred and forty characters.",
		].join("\n");
		seeded = await seedDomain({ capitalReply: reply });
		const { t, capital } = seeded;
		const origin = loopbackOrigin(t.panad.tcpPort!);
		page = await newPage(`${origin}/#${t.panad.webToken}`);
		// The session's reply, not the user's question.
		const messageId = capital.messageIds[1]!;
		await t.client.post(`/messages/${messageId}/bookmark`, {});

		const card = await evaluatePage<{ subject: string; paragraphs: number; text: string; open: string }>(`
			location.hash = "#/bookmarks";
			await until(() => document.querySelectorAll("#bookmarks-list [data-testid=bookmark-item]").length === 1);
			const item = document.querySelector("#bookmarks-list [data-testid=bookmark-item]");
			const body = item.querySelector("[data-testid=bookmark-body]");
			return {
				subject: item.querySelector(".bookmark-subject").textContent,
				paragraphs: body.querySelectorAll("p").length,
				text: body.textContent,
				open: item.querySelector("[data-testid=bookmark-open]").getAttribute("href"),
			};
		`);
		expect(card.subject).toBe("What is the capital of France?");
		expect(card.paragraphs).toBe(2);
		expect(card.text).toContain("here to prove the bookmark card shows the whole message");
		expect(card.open).toBe(`#/threads/${capital.threadId}?message=${messageId}`);

		// Clicking the card opens the thread at that message.
		const opened = await evaluatePage<{ hash: string; focused: boolean }>(`
			document.querySelector("#bookmarks-list [data-testid=bookmark-item]").click();
			await until(() => !document.getElementById("thread").hidden && document.querySelector("#thread-messages .focus"));
			return {
				hash: location.hash,
				focused: document.querySelector("#thread-messages .focus").dataset.id === ${JSON.stringify(messageId)},
			};
		`);
		expect(opened).toEqual({ hash: `#/threads/${capital.threadId}?message=${messageId}`, focused: true });

		// Remove takes it off the list without a reload, and the empty hint comes back.
		const removed = await evaluatePage<{ rows: number; hint: string }>(`
			location.hash = "#/bookmarks";
			await until(() => document.querySelectorAll("#bookmarks-list [data-testid=bookmark-item]").length === 1);
			document.querySelector("#bookmarks-list [data-testid=bookmark-remove]").click();
			await until(() => document.querySelectorAll("#bookmarks-list [data-testid=bookmark-item]").length === 0);
			return {
				rows: document.querySelectorAll("#bookmarks-list [data-testid=bookmark-item]").length,
				hint: document.getElementById("bookmarks-list").textContent,
			};
		`);
		expect(removed.rows).toBe(0);
		expect(removed.hint).toContain("No bookmarks yet");
		const list = await t.client.get<{ bookmarks: unknown[] }>("/bookmarks");
		expect(list.body.bookmarks).toHaveLength(0);
	});
});
