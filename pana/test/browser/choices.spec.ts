// WEB-10: a message may offer reply options. A click fills the reply draft under the thread, a
// second click takes the line out again, and the draft stays the only place a pick lives.

import { afterEach, describe, expect, it } from "vitest";
import { loopbackOrigin } from "../../src/web/static.ts";
import { chromeDevtoolsAvailable, closePage, emulateViewport, evaluatePage, newPage } from "./cli.ts";
import { seedDomain, type Seeded } from "./seed.ts";

const describeBrowser = chromeDevtoolsAvailable() ? describe : describe.skip;

const MENU = [
	"Which way should this ship?",
	"",
	"```choices",
	"- Ship it now",
	"- Behind a flag => Ship behind PANA_CHOICES and tell me when it is fully on",
	"- Something else — tell me",
	"```",
].join("\n");

let seeded: Seeded | undefined;
let page: number | undefined;
afterEach(async () => {
	if (page !== undefined) {
		await emulateViewport("");
		await closePage(page);
	}
	page = undefined;
	await seeded?.t.close();
	seeded = undefined;
});

/** Post a message into the seeded two-message thread and open the app on it. */
async function openWith(body: string): Promise<string> {
	const { t, group } = seeded!;
	const thread = await t.client.get<{ messages: Array<{ id: string }> }>(`/threads/${group.threadId}`);
	const posted = await t.client.post(`/threads/${group.threadId}/messages`, {
		after: thread.body.messages.at(-1)!.id,
		body,
	});
	expect(posted.status).toBe(200);
	page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);
	await evaluatePage(`location.hash = "#/threads/${group.threadId}"; return true;`);
	return group.threadId;
}

/** How many messages the thread holds, read from the API rather than the page. */
async function messageCount(threadId: string): Promise<number> {
	const read = await seeded!.t.client.get<{ messages: unknown[] }>(`/threads/${threadId}`);
	return read.body.messages.length;
}

describeBrowser("reply options", () => {
	it("WEB-10 renders a choices fence as buttons that fill, and empty, the reply draft", async () => {
		seeded = await seedDomain();
		const threadId = await openWith(MENU);
		const before = await messageCount(threadId);

		const rendered = await evaluatePage<{
			labels: string[];
			replies: string[];
			pressed: string[];
			code: number;
			groupRole: string | null;
			groupLabel: string | null;
			pageWidth: number;
			width: number;
		}>(`
			await until(() => document.querySelectorAll('[data-testid="message-choice"]').length === 3);
			const buttons = [...document.querySelectorAll('[data-testid="message-choice"]')];
			const group = buttons[0].closest("[data-testid=message-choices]");
			return {
				labels: buttons.map((button) => button.textContent.trim()),
				replies: buttons.map((button) => button.dataset.reply),
				pressed: buttons.map((button) => button.getAttribute("aria-pressed")),
				code: document.querySelectorAll(".message pre > code.language-choices").length,
				groupRole: group.getAttribute("role"),
				groupLabel: group.getAttribute("aria-label"),
				pageWidth: document.documentElement.scrollWidth,
				width: innerWidth,
			};
		`);
		expect(rendered.labels).toEqual([
			"Ship it now",
			// A label whose reply says more shows both: the one to scan, the one that will be sent.
			"Behind a flagShip behind PANA_CHOICES and tell me when it is fully on",
			"Something else — tell me",
		]);
		expect(rendered.replies).toEqual([
			"Ship it now",
			"Ship behind PANA_CHOICES and tell me when it is fully on",
			"Something else — tell me",
		]);
		expect(rendered.pressed).toEqual(["false", "false", "false"]);
		// The fence itself is gone: the buttons are the message.
		expect(rendered.code).toBe(0);
		expect(rendered.groupRole).toBe("group");
		expect(rendered.groupLabel).toBe("Reply options");
		expect(rendered.pageWidth).toBeLessThanOrEqual(rendered.width);

		// One click writes the line, saves the draft, and marks the button pressed.
		const picked = await evaluatePage<{ box: string; pressed: string[]; stored: string; status: string }>(`
			document.querySelectorAll('[data-testid="message-choice"]')[1].click();
			await until(() => document.querySelector('[data-testid="reply-body"]').value.length > 0);
			return {
				box: document.querySelector('[data-testid="reply-body"]').value,
				pressed: [...document.querySelectorAll('[data-testid="message-choice"]')].map((b) => b.getAttribute("aria-pressed")),
				stored: sessionStorage.getItem("pana-draft:${threadId}"),
				status: document.querySelector('[data-testid="status"]').textContent,
			};
		`);
		expect(picked.box).toBe("Ship behind PANA_CHOICES and tell me when it is fully on");
		expect(picked.pressed).toEqual(["false", "true", "false"]);
		// The draft is saved the way typed text is, so a reload keeps a pick.
		expect(picked.stored).toBe(picked.box);
		expect(picked.status).toContain("Added");

		// A second click takes the line back out, and the pressed state follows.
		const unpicked = await evaluatePage<{ box: string; pressed: string[]; stored: string | null }>(`
			document.querySelectorAll('[data-testid="message-choice"]')[1].click();
			await until(() => document.querySelector('[data-testid="reply-body"]').value === "");
			return {
				box: document.querySelector('[data-testid="reply-body"]').value,
				pressed: [...document.querySelectorAll('[data-testid="message-choice"]')].map((b) => b.getAttribute("aria-pressed")),
				stored: sessionStorage.getItem("pana-draft:${threadId}"),
			};
		`);
		expect(unpicked.box).toBe("");
		expect(unpicked.pressed).toEqual(["false", "false", "false"]);
		expect(unpicked.stored).toBe("");

		// Typing first: a pick is appended after the prose, on its own line.
		const appended = await evaluatePage<{ box: string; pressed: string[] }>(`
			const box = document.querySelector('[data-testid="reply-body"]');
			box.value = "Thinking about it.";
			box.dispatchEvent(new Event("input", { bubbles: true }));
			document.querySelectorAll('[data-testid="message-choice"]')[0].click();
			await until(() => document.querySelector('[data-testid="reply-body"]').value.includes("Ship it now"));
			return {
				box: box.value,
				pressed: [...document.querySelectorAll('[data-testid="message-choice"]')].map((b) => b.getAttribute("aria-pressed")),
			};
		`);
		expect(appended.box).toBe("Thinking about it.\nShip it now");
		expect(appended.pressed).toEqual(["true", "false", "false"]);

		// Deleting the line by hand unpicks the button: the draft is the state.
		const deleted = await evaluatePage<string[]>(`
			const box = document.querySelector('[data-testid="reply-body"]');
			box.value = "Thinking about it.";
			box.dispatchEvent(new Event("input", { bubbles: true }));
			return [...document.querySelectorAll('[data-testid="message-choice"]')].map((b) => b.getAttribute("aria-pressed"));
		`);
		expect(deleted).toEqual(["false", "false", "false"]);

		// Nothing was sent: the options only ever wrote into the draft.
		expect(await messageCount(threadId)).toBe(before);
	});

	it("WEB-10a composes quoted answers, switches only one question, and keeps draft state on reload", async () => {
		seeded = await seedDomain();
		const threadId = await openWith([
			"Two decisions:", "", "```choices",
			"- Which approach? => Fix forward => Keep the change.",
			"- ^ => Revert => Revert the change.",
			"- When? => Today => Ship today.",
			"- ^ => Later => Ship later.", "```",
		].join("\n"));
		const before = await messageCount(threadId);
		await emulateViewport("390x844x3,mobile,touch", "light");
		const composed = await evaluatePage<{ body: string; questions: string[]; pressed: string[]; overflow: boolean }>(`
			await until(() => document.querySelectorAll('[data-testid="message-choice"]').length === 4);
			const box = document.querySelector('[data-testid="reply-body"]');
			box.value = "My notes.";
			box.dispatchEvent(new Event("input", { bubbles: true }));
			const buttons = [...document.querySelectorAll('[data-testid="message-choice"]')];
			buttons[0].click();
			buttons[2].click();
			buttons[1].click();
			return {
				body: box.value,
				questions: [...document.querySelectorAll('.choice-question')].map((q) => q.textContent),
				pressed: buttons.map((b) => b.getAttribute('aria-pressed')),
				overflow: document.documentElement.scrollWidth > innerWidth,
			};
		`);
		expect(composed.body).toBe("My notes.\n\n> Which approach?\n\nRevert the change.\n\n> When?\n\nShip today.");
		expect(composed.questions).toEqual(["Which approach?", "When?"]);
		expect(composed.pressed).toEqual(["false", "true", "true", "false"]);
		expect(composed.overflow).toBe(false);
		await evaluatePage("location.reload(); return true;");
		const reloaded = await evaluatePage<{ body: string; pressed: string[] }>(`
			await until(() => document.querySelectorAll('[data-testid="message-choice"]').length === 4);
			return {
				body: document.querySelector('[data-testid="reply-body"]').value,
				pressed: [...document.querySelectorAll('[data-testid="message-choice"]')].map((b) => b.getAttribute('aria-pressed')),
			};
		`);
		expect(reloaded.body).toBe(composed.body);
		expect(reloaded.pressed).toEqual(composed.pressed);
		const removed = await evaluatePage<{ body: string; pressed: string[] }>(`
			const buttons = [...document.querySelectorAll('[data-testid="message-choice"]')];
			buttons[1].click();
			const box = document.querySelector('[data-testid="reply-body"]');
			box.value = box.value.replace('> When?\\n\\nShip today.', 'My timing note.');
			box.dispatchEvent(new Event("input", { bubbles: true }));
			return { body: box.value, pressed: buttons.map((b) => b.getAttribute('aria-pressed')) };
		`);
		expect(removed.body).not.toContain("Which approach?");
		expect(removed.body).toContain("My notes.");
		expect(removed.body).toContain("My timing note.");
		expect(removed.pressed).toEqual(["false", "false", "false", "false"]);
		expect(await messageCount(threadId)).toBe(before);
	});

	it("WEB-10a leaves orphan shorthand visible instead of rendering a misleading button", async () => {
		seeded = await seedDomain();
		await openWith("```choices\n- ^ => Yes => Yes\n```");
		const result = await evaluatePage<{ buttons: number; code: string }>(`
			await until(() => document.querySelector('.message pre > code.language-choices'));
			return {
				buttons: document.querySelectorAll('[data-testid="message-choice"]').length,
				code: document.querySelector('.message pre > code.language-choices').textContent,
			};
		`);
		expect(result.buttons).toBe(0);
		expect(result.code).toContain("^ => Yes => Yes");
	});

	it("WEB-10 leaves a fence it cannot read as code, and offers no buttons without a draft", async () => {
		// A session's own words can carry a fence too; a transcript has no reply box, so the
		// renderer is given no `onPick` there and the block stays code.
		seeded = await seedDomain({ capitalReply: MENU });
		page = await newPage(`${loopbackOrigin(seeded.t.panad.tcpPort!)}/#${seeded.t.panad.webToken}`);
		const transcript = await evaluatePage<{ buttons: number; code: string }>(`
			location.hash = "#/sessions/${seeded.capital.sessionId}";
			await until(() => document.querySelector("#transcript pre > code.language-choices"));
			return {
				buttons: document.querySelectorAll('[data-testid="message-choice"]').length,
				code: document.querySelector("#transcript pre > code.language-choices").textContent,
			};
		`);
		expect(transcript.buttons).toBe(0);

		// The same message in its thread does render, so the difference is the draft, not the text.
		await evaluatePage(`location.hash = "#/threads/${seeded.capital.threadId}"; return true;`);
		const inThread = await evaluatePage<number>(`
			await until(() => document.querySelectorAll('[data-testid="message-choice"]').length === 3);
			return document.querySelectorAll('[data-testid="message-choice"]').length;
		`);
		expect(inThread).toBe(3);

		// A fence that is not a list of options is someone's code, and stays visible as code.
		await openWith(["Not a menu:", "", "```choices", "pick one of these", "```"].join("\n"));
		const unreadable = await evaluatePage<{ buttons: number; code: string }>(`
			await until(() => document.querySelector(".message pre > code.language-choices"));
			return {
				buttons: document.querySelectorAll('[data-testid="message-choice"]').length,
				code: document.querySelector(".message pre > code.language-choices").textContent.trim(),
			};
		`);
		expect(unreadable.buttons).toBe(0);
		expect(unreadable.code).toBe("pick one of these");
	});

	it("WEB-10 keeps a row of options readable on a phone", async () => {
		seeded = await seedDomain();
		await openWith(MENU);
		await emulateViewport("390x844x3,mobile,touch", "light");
		const layout = await evaluatePage<{ pageWidth: number; width: number; tallest: number; inside: boolean }>(`
			await until(() => document.querySelectorAll('[data-testid="message-choice"]').length === 3);
			const buttons = [...document.querySelectorAll('[data-testid="message-choice"]')];
			const message = buttons[0].closest(".message").getBoundingClientRect();
			return {
				pageWidth: document.documentElement.scrollWidth,
				width: innerWidth,
				tallest: Math.max(...buttons.map((button) => button.getBoundingClientRect().height)),
				// A long reply wraps inside its button instead of running off the message.
				inside: buttons.every((button) => button.getBoundingClientRect().right <= message.right + 1),
			};
		`);
		expect(layout.pageWidth).toBeLessThanOrEqual(layout.width);
		expect(layout.tallest).toBeGreaterThan(36);
		expect(layout.inside).toBe(true);
	});
});
