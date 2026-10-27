// node test/browser/thread-list-shots.ts DIR LABEL — synthetic test-domain evidence.
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { postNotice } from "../../src/threads/index.ts";
import { loopbackOrigin } from "../../src/web/static.ts";
import { startTestPanad } from "../harness/index.ts";
import { closePage, evaluatePage, newPage, resizePage, screenshot } from "./cli.ts";
const [dir, label] = process.argv.slice(2);
if (!dir || !label) throw new Error("usage: node test/browser/thread-list-shots.ts DIR LABEL");
const t = await startTestPanad({ config: { timezone: "UTC" } });
let page: number | undefined;
try {
	for (const [body, archived] of [["Release readiness\nReview the integration checks.", false], ["Design review\nThe review is complete.", true], ["Weekly planning\nDecide the next milestones.", false]] as const) {
		const made = await postNotice(t.runtime, { body });
		if (archived) await t.client.post(`/threads/${made.thread.id}/archive`, {});
	}
	page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);
	await resizePage(1280, 900);
	await evaluatePage(`location.hash = "#/threads"; await until(() => document.querySelectorAll("#threads-list .item").length >= 2); await document.fonts.ready; return true;`);
	copyFileSync(await screenshot(), join(dir, `threads-${label}.png`));
} finally {
	if (page !== undefined) await closePage(page);
	await t.close();
}
