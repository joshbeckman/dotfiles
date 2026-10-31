// UX-19 in a real browser: a page you navigate to starts at its top, whatever position the page
// you left was in. The pages that have a place of their own (UX-05's latest message, UX-10's
// newest transcript entries) still scroll there; this suite leaves that to their own tests.

import { afterEach, describe, expect, it } from "vitest";
import { postNotice } from "../../src/threads/index.ts";
import { loopbackOrigin } from "../../src/web/static.ts";
import { chromeDevtoolsAvailable, closePage, evaluatePage, newPage, resizePage } from "./cli.ts";
import { seedDomain, type Seeded } from "./seed.ts";

const describeBrowser = chromeDevtoolsAvailable() ? describe : describe.skip;

let seeded: Seeded | undefined;
let page: number | undefined;

afterEach(async () => {
	if (page !== undefined) await closePage(page);
	page = undefined;
	await seeded?.t.close();
	seeded = undefined;
});

/** Scroll the page to its end, so the next page is opened from a position it could keep. */
const toBottom = `scrollTo(0, document.documentElement.scrollHeight); await sleep(150);`;

/** Enough threads that the inbox and threads lists are taller than the window. */
async function fill(t: Seeded["t"]): Promise<void> {
	for (let i = 0; i < 24; i++) await postNotice(t.runtime, { body: `A notice that fills a row. ${i}` });
}

describeBrowser("the top of a new page", () => {
	it("UX-19 going from one list to another starts the new one at the top, not where the old one was", async () => {
		seeded = await seedDomain();
		const { t } = seeded;
		await fill(t);
		page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);
		await resizePage(1280, 900);
		const walked = await evaluatePage<{ inbox: number; threads: number; back: number }>(`
			location.hash = "#/inbox";
			await until(() => document.querySelectorAll("#inbox-list .item").length >= 20);
			${toBottom}
			const inbox = scrollY;
			location.hash = "#/threads";
			await until(() => !document.getElementById("threads-list").hidden && document.querySelectorAll("#threads-list .item").length >= 20);
			await sleep(300);
			const threads = scrollY;
			${toBottom}
			location.hash = "#/inbox";
			await until(() => document.querySelectorAll("#inbox-list .item").length >= 20);
			await sleep(300);
			return { inbox, threads, back: scrollY };
		`);
		// Both lists really did scroll, so the zeros below are the router's doing, not short pages.
		expect(walked.inbox).toBeGreaterThan(0);
		expect(walked.threads).toBe(0);
		expect(walked.back).toBe(0);
	});

	it("UX-19 leaving a thread you were reading starts the next page at the top", async () => {
		seeded = await seedDomain();
		const { t } = seeded;
		await fill(t);
		// A thread taller than the window, so opening it lands partway down it (UX-05).
		const notice = await postNotice(t.runtime, { body: "A long thread" });
		let after = notice.message.id;
		for (let i = 0; i < 14; i++) {
			const res = await t.client.post<{ message: { id: string } }>(`/threads/${notice.thread.id}/messages`, {
				after,
				body: `Message ${i}\n\n${"A paragraph that takes some room. ".repeat(12)}`,
			});
			expect(res.status).toBe(200);
			after = res.body.message.id;
		}
		page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);
		await resizePage(1280, 900);
		const walked = await evaluatePage<{ reading: number; list: number; tall: number }>(`
			location.hash = "#/threads/${notice.thread.id}";
			await until(() => document.querySelectorAll("#thread-messages [data-testid=message]").length === 15);
			await sleep(300);
			const reading = scrollY;
			location.hash = "#/inbox";
			await until(() => document.querySelectorAll("#inbox-list .item").length >= 20);
			await sleep(300);
			return { reading, list: scrollY, tall: document.documentElement.scrollHeight - innerHeight };
		`);
		expect(walked.reading).toBeGreaterThan(0);
		expect(walked.tall).toBeGreaterThan(0);
		expect(walked.list).toBe(0);
	});
});
