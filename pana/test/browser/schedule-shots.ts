// Not a test: node test/browser/schedule-shots.ts DIR LABEL captures the current
// schedules UI in a throwaway test domain. Run on each revision for before/after evidence.
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { loopbackOrigin } from "../../src/web/static.ts";
import { startTestPanad } from "../harness/index.ts";
import { closePage, evaluatePage, newPage, resizePage, screenshot } from "./cli.ts";

const [dir, label] = process.argv.slice(2);
if (!dir || !label) throw new Error("usage: node test/browser/schedule-shots.ts DIR LABEL");
const t = await startTestPanad({ config: { defaultModel: "faux/faux-1", timezone: "UTC" } });
let page: number | undefined;
try {
	for (const [subject, prompt, cron] of [
		["Weekly project review", "Review the open project milestones, summarize risks and unresolved questions, and write a concise update for the team.\n\nRead the latest notes before proposing next steps. Include links to the source material and call out anything that needs a decision.\n\nDo not publish the update until the supporting checks pass.", "0 9 * * 1"],
		["Check the release", "Check the release status, collect the test results, and report any blockers.\n\nCompare the new results with yesterday's baseline and identify the owner for each outstanding item.", "0 17 * * 1-5"],
	]) {
		const res = await t.client.post("/schedules", { kind: "session", subject, cron, payload: { prompt } });
		if (res.status !== 201) throw new Error(JSON.stringify(res.body));
	}
	page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);
	await resizePage(1280, 1000);
	await evaluatePage(`
		location.hash = "#/schedules";
		await until(() => document.querySelectorAll("#schedules-list .item").length === 2);
		scrollTo(0, 0);
		return true;
	`);
	const file = join(dir, `schedules-${label}.png`);
	copyFileSync(await screenshot(), file);
	console.log(file);
} finally {
	if (page !== undefined) await closePage(page);
	await t.close();
}
