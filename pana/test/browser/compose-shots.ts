// Not a test: `node test/browser/compose-shots.ts DIR LABEL` seeds a domain, opens the New thread
// screen, and saves DIR/compose-LABEL-<width>.png for the PR.

import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loopbackOrigin } from "../../src/web/static.ts";
import { closePage, emulateViewport, evaluatePage, newPage, screenshot } from "./cli.ts";
import { seedDomain } from "./seed.ts";

const dir = process.argv[2] ?? "";
const label = process.argv[3] ?? "compose";
if (!dir) throw new Error("usage: node test/browser/compose-shots.ts DIR [LABEL]");
mkdirSync(dir, { recursive: true });

const seeded = await seedDomain();
const { t } = seeded;
const page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);

try {
	for (const [width, viewport] of [
		[1280, ""],
		[390, "390x844x3,mobile,touch"],
	] as const) {
		await emulateViewport(viewport, "light");
		await evaluatePage(`
			location.hash = "#/compose";
			await until(() => !document.querySelector("#view-compose").hidden);
			const body = document.querySelector("#compose-body");
			body.value = "Compare these three answers and say which you would ship.";
			scrollTo(0, 0);
			await sleep(300);
			return true;
		`);
		const target = join(dir, `compose-${label}-${width}.png`);
		copyFileSync(await screenshot(false), target);
		console.log(target);
	}
} finally {
	await closePage(page);
	await seeded.t.close();
}
