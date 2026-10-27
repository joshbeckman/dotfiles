// Rendered message typography must not inherit the app's compact UI headings.
import { copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loopbackOrigin } from "../../src/web/static.ts";
import { chromeDevtoolsAvailable, closePage, emulateColorScheme, emulateViewport, evaluatePage, newPage, resizePage, screenshot } from "./cli.ts";
import { seedDomain, type Seeded } from "./seed.ts";

const describeBrowser = chromeDevtoolsAvailable() ? describe : describe.skip;
const specimen = readFileSync(new URL("../fixtures/message-prose.md", import.meta.url), "utf8");
let seeded: Seeded | undefined;
let page: number | undefined;
afterEach(async () => {
	if (page !== undefined) {
		await emulateViewport("");
		await emulateColorScheme("auto");
		await closePage(page);
	}
	page = undefined;
	await seeded?.t.close();
	seeded = undefined;
});

describeBrowser("message prose", () => {
	it("keeps a consistent heading rhythm and local table/code scrolling on desktop and phone", async () => {
		seeded = await seedDomain({ capitalReply: specimen });
		const { t, group } = seeded;
		const thread = await t.client.get<{ messages: Array<{ id: string }> }>(`/threads/${group.threadId}`);
		const posted = await t.client.post(`/threads/${group.threadId}/messages`, {
			after: thread.body.messages.at(-1)!.id, body: specimen,
		});
		expect(posted.status).toBe(200);
		page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);
		await resizePage(1280, 1000);
		await evaluatePage(`location.hash = "#/threads/${group.threadId}";
			await until(() => [...document.querySelectorAll(".message .prose h1")].some(e => e.textContent === "Message rendering specimen"));
			await document.fonts.ready; return true;`);
		for (const [name, viewport, scheme] of [
			["desktop", "", "light"], ["phone", "390x844x3,mobile,touch", "light"], ["phone-dark", "390x844x3,mobile,touch", "dark"],
		] as const) {
			await emulateViewport(viewport, scheme);
			const layout = await evaluatePage<{
				width: number; pageWidth: number; sizes: number[]; cases: string[]; square: string;
				paragraphGap: number; headingGap: number; quoteBorder: number; tableScroll: boolean;
				codeScroll: boolean; firstMargin: number; lastMargin: number; uiCase: string; dark: boolean;
			}>(`
				await until(() => [...document.querySelectorAll(".message .prose h1")].some(e => e.textContent === "Message rendering specimen"));
				const body = [...document.querySelectorAll(".message .prose h1")].find(e => e.textContent === "Message rendering specimen").closest(".prose");
				const headings = [...body.querySelectorAll("h1,h2,h3,h4,h5,h6")].slice(0,6);
				const css = e => getComputedStyle(e);
				const tables = [...body.querySelectorAll(".prose-table")];
				return { width: innerWidth, pageWidth: document.documentElement.scrollWidth,
					sizes: headings.map(e => parseFloat(css(e).fontSize)), cases: headings.map(e => css(e).textTransform),
					square: getComputedStyle(headings[0], "::after").content,
					paragraphGap: parseFloat(css(body.querySelector("p")).marginBottom),
					headingGap: parseFloat(css(headings[1]).marginTop),
					quoteBorder: parseFloat(css(body.querySelector("blockquote")).borderLeftWidth),
					tableScroll: tables.every(e => css(e).overflowX === "auto" && e.tabIndex === 0)
						&& (innerWidth > 500 || tables.at(-1).scrollWidth > tables.at(-1).clientWidth),
					codeScroll: [...body.querySelectorAll("pre")].every(e => css(e).overflowX === "auto" && e.clientWidth <= body.clientWidth),
					firstMargin: parseFloat(css(body.firstElementChild).marginTop), lastMargin: parseFloat(css(body.lastElementChild).marginBottom),
					dark: matchMedia("(prefers-color-scheme: dark)").matches, uiCase: css(document.querySelector(".topbar h1")).textTransform };
			`);
			expect(layout.pageWidth, name).toBeLessThanOrEqual(layout.width);
			if (viewport) expect(layout.width).toBe(390);
			expect(layout.cases).toEqual(Array(6).fill("none"));
			expect(layout.sizes).toEqual([...layout.sizes].sort((a, b) => b - a));
			expect(Math.min(...layout.sizes)).toBeGreaterThanOrEqual(16);
			expect(layout.square).toBe("none");
			expect(layout.paragraphGap).toBe(12);
			expect(layout.headingGap).toBe(24);
			expect(layout.quoteBorder).toBe(3);
			expect(layout.tableScroll).toBe(true);
			expect(layout.codeScroll).toBe(true);
			expect(layout.firstMargin).toBe(0);
			expect(layout.lastMargin).toBe(0);
			expect(layout.uiCase).toBe("uppercase");
			expect(layout.dark).toBe(scheme === "dark");
			const dir = process.env.PANA_PROSE_SHOTS;
			if (dir) {
				await evaluatePage(`const h = document.querySelector(".message .prose h1"); scrollTo(0, h.getBoundingClientRect().top + scrollY - document.querySelector(".topbar").getBoundingClientRect().height - 16); return true;`);
				copyFileSync(await screenshot(), join(dir, `message-prose-${name}.png`));
			}
		}
		const transcript = await evaluatePage<{ codeScroll: boolean; tableScroll: boolean; wordBreak: string }>(`
			location.hash = "#/sessions/${seeded.capital.sessionId}";
			await until(() => document.querySelector("#transcript .prose h1"));
			const body = document.querySelector("#transcript .prose h1").closest(".prose");
			const pre = [...body.querySelectorAll("pre")].at(-1);
			const table = [...body.querySelectorAll(".prose-table")].at(-1);
			return { codeScroll: pre.scrollWidth > pre.clientWidth && getComputedStyle(pre).whiteSpace === "pre",
				tableScroll: table.scrollWidth > table.clientWidth,
				wordBreak: getComputedStyle(table.querySelector("td")).wordBreak };
		`);
		expect(transcript).toEqual({ codeScroll: true, tableScroll: true, wordBreak: "normal" });
	});
});
