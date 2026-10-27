// node test/browser/schedule-check-shots.ts DIR LABEL — synthetic test-domain evidence.
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { recordCheck } from "../../src/schedules/store.ts";
import { loopbackOrigin } from "../../src/web/static.ts";
import { startTestPanad } from "../harness/index.ts";
import { closePage, evaluatePage, newPage, resizePage, screenshot } from "./cli.ts";

const [dir, label] = process.argv.slice(2);
if (!dir || !label) throw new Error("usage: node test/browser/schedule-check-shots.ts DIR LABEL");
const t = await startTestPanad({ config: { timezone: "UTC" } });
let page: number | undefined;
try {
	for (const [subject, check, stop] of [
		["Release readiness", "./scripts/release-ready", true],
		["Weekly project review", null, false],
	] as const) {
		const made = await t.client.post<{ schedule: { id: string } }>("/schedules", {
			subject, cron: "0 9 * * 1-5", prompt: "Review the current results and report any blockers.",
			check, ...(check ? { checkCwd: "/tmp/example-project" } : {}), stopAfterSuccess: stop,
		});
		if (made.status !== 201) throw new Error(JSON.stringify(made.body));
		if (check) await recordCheck(t.runtime, made.body.schedule.id, {
			checkedAt: t.clock.now(), status: "not_ready", exitCode: 1, signal: null,
			stdout: "Waiting for the integration checks to finish.\n2 of 3 checks passed.", stderr: "", error: null,
		});
	}
	page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);
	await resizePage(1280, 1100);
	await evaluatePage(`
		location.hash = "#/schedules";
		await until(() => document.querySelectorAll("#schedules-list .item").length === 2);
		const conditions = document.querySelector("[data-testid=schedule-conditions]");
		if (conditions) conditions.open = true;
		scrollTo(0, 0);
		return true;
	`);
	const file = join(dir, `schedule-checks-${label}.png`);
	copyFileSync(await screenshot(), file);
	console.log(file);
} finally {
	if (page !== undefined) await closePage(page);
	await t.close();
}
