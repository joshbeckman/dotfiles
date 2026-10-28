// node test/browser/session-wake-shots.ts DIR LABEL — throwaway domain only.
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { loopbackOrigin } from "../../src/web/static.ts";
import { sessionRuntime } from "../../src/sessions/index.ts";
import { startTestPanad } from "../harness/index.ts";
import { closePage, evaluatePage, newPage, resizePage, screenshot } from "./cli.ts";

const [dir, label] = process.argv.slice(2);
if (!dir || !label) throw new Error("usage: node test/browser/session-wake-shots.ts DIR LABEL");
const t = await startTestPanad({ script: [{ text: "The release checks are still running. I will check again later." }], config: { defaultModel: "faux/faux-1", timezone: "UTC" } });
let page: number | undefined;
try {
	const made = await t.client.post<{ session: { id: string } }>("/sessions", { prompt: "Check the release and report when it is ready." });
	const id = made.body.session.id;
	await sessionRuntime(t.runtime).idle();
	for (const [subject, delay] of [["Check release readiness", "10m"], ["Follow up on deployment", "1h"]]) {
		const wake = await t.client.post("/schedules", { kind: "wake", session: id, in: delay, subject, note: "Check the release and report any blockers in the original thread." });
		if (wake.status !== 201) throw new Error(JSON.stringify(wake.body));
	}
	page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);
	for (const [width, height, suffix] of [[1280, 900, ""], [390, 844, "-phone"]] as const) {
		await resizePage(width, height);
		await evaluatePage(`
			location.hash = ${JSON.stringify(`#/sessions/${id}`)};
			await until(() => document.querySelectorAll("#transcript [data-testid=entry]").length > 0);
			scrollTo(0, 0);
			return true;
		`);
		const file = join(dir, `session-wakes-${label}${suffix}.png`);
		copyFileSync(await screenshot(), file);
		console.log(file);
	}
} finally {
	await resizePage(1280, 900);
	if (page !== undefined) await closePage(page);
	await t.close();
}
