import { copyFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { loopbackOrigin } from "../../src/web/static.ts";
import { chromeDevtoolsAvailable, closePage, evaluatePage, newPage, screenshot } from "./cli.ts";
import { seedDomain, type Seeded } from "./seed.ts";

let seeded: Seeded | undefined;
let page: number | undefined;
afterEach(async () => {
	if (page !== undefined) await closePage(page);
	await seeded?.t.close();
});
(chromeDevtoolsAvailable() ? describe : describe.skip)("copy self URLs", () => {
	it("UX-17 copies all five self URLs without navigation, preserves reference navigation, and reports clipboard failures", async () => {
		seeded = await seedDomain({ capitalReply: "Paris. [Memory](pana://test.example/memory/files/notes/pana.md)" });
		const { t, capital } = seeded;
		const origin = loopbackOrigin(t.panad.tcpPort!);
		page = await newPage(`${origin}/#${t.panad.webToken}`);
		await evaluatePage(`
			await until(() => window.__pana);
			window.copied = [];
			Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
				writeText: async (text) => { window.copied.push(text); }
			} });
			location.hash = "#/threads/${capital.threadId}";
			await until(() => document.querySelectorAll("[data-testid=message-link]").length >= 2);
			return true;
		`);
		if (process.env.PANA_COPY_SHOTS) copyFileSync(await screenshot(true), "docs/copy-urls-before.png");
		await evaluatePage(`
			document.querySelector("#thread-url a").click();
			await until(() => document.getElementById("status").textContent === "URL copied to clipboard.");
			window.copied = [];
			return true;
		`);
		if (process.env.PANA_COPY_SHOTS) copyFileSync(await screenshot(true), "docs/copy-urls-after.png");
		const copied = await evaluatePage<string[]>(`
			const check = async (selector) => {
				const hash = location.hash;
				const n = window.copied.length;
				document.querySelector(selector).click();
				await until(() => window.copied.length === n + 1);
				await until(() => document.getElementById("status").textContent === "URL copied to clipboard.");
				if (location.hash !== hash) throw new Error("copy navigated");
			};
			await check("#thread-url a");
			await check("[data-testid=message-link]");
			location.hash = "#/sessions/${capital.sessionId}";
			await until(() => document.querySelector("#session-title a[data-copy-url]"));
			await check("#session-title a");
			await check("[data-testid=session-url] a");
			location.hash = "#/schedules";
			await until(() => document.querySelector("#schedules-list a[data-copy-url]"));
			await check("#schedules-list a[data-copy-url]");
			if (!document.getElementById("schedule-cancel").hidden) throw new Error("copy opened edit");
			location.hash = "#/memory/files/notes/pana.md";
			await until(() => document.querySelector("#memory-path a"));
			await check("#memory-path a");
			return window.copied;
		`);
		expect(copied.slice(0, 4)).toEqual([
			`pana://test.example/threads/${capital.threadId}`,
			`pana://test.example/threads/${capital.threadId}?message=${capital.messageIds[0]}`,
			capital.sessionUrl, capital.sessionUrl,
		]);
		expect(copied[4]).toMatch(/^pana:\/\/test.example\/schedules\//);
		expect(copied[5]).toBe("pana://test.example/memory/files/notes/pana.md");
		await evaluatePage(`
			location.hash = "#/threads/${capital.threadId}";
			await until(() => document.querySelector('#thread-messages .body a[href="#/memory/files/notes/pana.md"]'));
			document.querySelector('#thread-messages .body a[href="#/memory/files/notes/pana.md"]').click();
			await until(() => location.hash === "#/memory/files/notes/pana.md" && document.querySelector("#memory-path a"));
			return true;
		`);
		const failures = await evaluatePage<string[]>(`
			const errors = [];
			for (const value of [{ writeText: async () => { throw new Error("Permission denied"); } }, undefined]) {
				Object.defineProperty(navigator, "clipboard", { configurable: true, value });
				document.querySelector("#memory-path a").click();
				await until(() => document.getElementById("status").classList.contains("error"));
				errors.push(document.getElementById("status").textContent);
			}
			location.hash = "#/sessions";
			await until(() => document.querySelector("#sessions-list a"));
			document.querySelector("#sessions-list a").click();
			await until(() => location.hash.startsWith("#/sessions/"));
			return errors;
		`);
		expect(failures[0]).toContain("Permission denied");
		expect(failures[1]).toContain("Clipboard is unavailable");
	});
});
