// node test/browser/thread-list-shots.ts DIR LABEL — synthetic test-domain evidence.
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { postNotice } from "../../src/threads/index.ts";
import { loopbackOrigin } from "../../src/web/static.ts";
import { startTestPanad } from "../harness/index.ts";
import { closePage, evaluatePage, newPage, resizePage, screenshot } from "./cli.ts";
const [dir, label, width] = process.argv.slice(2);
if (!dir || !label) throw new Error("usage: node test/browser/thread-list-shots.ts DIR LABEL [WIDTH]");
const t = await startTestPanad({ config: { timezone: "UTC" } });
let page: number | undefined;
try {
	const made = new Map<string, string>();
	for (const [body, archived] of [["Release readiness\nReview the integration checks.", false], ["Design review\nThe review is complete.", true], ["Weekly planning\nDecide the next milestones.", false]] as const) {
		const posted = await postNotice(t.runtime, { body });
		made.set(body, posted.thread.id);
		if (archived) await t.client.post(`/threads/${posted.thread.id}/archive`, {});
	}
	// UX-20: a thread with a history shows both of its times apart and a count above one.
	const busy = made.get("Weekly planning\nDecide the next milestones.")!;
	let head = (await t.client.get<{ messages: Array<{ id: string }> }>(`/threads/${busy}`)).body.messages.at(-1)!.id;
	await t.clock.advance(26 * 60 * 60_000);
	for (const body of ["First the milestones, then the owners.", "Owners agreed; dates next."]) {
		await t.clock.advance(90 * 60_000);
		head = (await t.client.post<{ message: { id: string } }>(`/threads/${busy}/messages`, { body, after: head })).body.message.id;
	}
	await t.clock.advance(90 * 60_000);
	page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);
	await resizePage(Number(width) || 1280, 900);
	await evaluatePage(`location.hash = "#/threads"; await until(() => document.querySelectorAll("#threads-list .item").length >= 2); await document.fonts.ready; return true;`);
	copyFileSync(await screenshot(), join(dir, `threads-${label}.png`));
} finally {
	if (page !== undefined) await closePage(page);
	await t.close();
}
