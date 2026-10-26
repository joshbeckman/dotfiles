// SCALE-03 in a real browser: the PWA lists show one page and a "Load more" button while the
// list has a nextCursor. The Node suite checks the same wiring without a browser.

import { afterEach, describe, expect, it } from "vitest";
import { postNotice } from "../../src/threads/index.ts";
import { loopbackOrigin } from "../../src/web/static.ts";
import { startTestPanad, TEST_USER, type TestPanad } from "../harness/index.ts";
import { chromeDevtoolsAvailable, closePage, evaluatePage, newPage } from "./cli.ts";

const describeBrowser = chromeDevtoolsAvailable() ? describe : describe.skip;

let t: TestPanad | undefined;
let page: number | undefined;

afterEach(async () => {
	if (page !== undefined) await closePage(page);
	page = undefined;
	await t?.close();
	t = undefined;
});

describeBrowser("pana lists in a browser", () => {
	it("SCALE-03 the inbox, threads, and schedules load more with a button, and the unread badge counts past the page", async () => {
		t = await startTestPanad({ config: { timezone: "UTC" } });
		for (let i = 0; i < 53; i++) await postNotice(t.runtime, { body: `Notice ${i}` });
		for (let i = 0; i < 52; i++) {
			const at = new Date(t.clock.now() + 3_600_000 * (i + 1)).toISOString();
			const res = await t.client.post("/schedules", { kind: "thread", at, to: [TEST_USER], body: `scheduled ${i}` });
			expect(res.status).toBe(201);
		}
		page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);

		const counts = await evaluatePage<Record<string, [number, number, boolean]>>(`
			const out = {};
			for (const [hash, list, total] of [["#/inbox", "inbox-list", 53], ["#/threads", "threads-list", 53], ["#/schedules", "schedules-list", 52]]) {
				location.hash = hash;
				const items = () => document.querySelectorAll("#" + list + " .item").length;
				await until(() => items() === 50 && document.querySelector("#" + list + " [data-more]"));
				const first = items();
				document.querySelector("#" + list + " [data-more]").click();
				await until(() => items() === total);
				out[hash] = [first, items(), document.querySelector("#" + list + " [data-more]") === null];
			}
			// REF-06's badge counts every unread delivery, not only the first page's.
			out.badge = [Number(document.getElementById("nav-inbox-count").textContent), 0, true];
			return out;
		`);
		expect(counts).toEqual({
			"#/inbox": [50, 53, true],
			"#/threads": [50, 53, true],
			"#/schedules": [50, 52, true],
			badge: [53, 0, true],
		});
	});
});
