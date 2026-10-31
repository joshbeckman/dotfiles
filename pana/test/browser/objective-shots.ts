// Not a test: `node test/browser/objective-shots.ts DIR LABEL` seeds objectives (the way
// test/browser/objective-seed.ts does for the spec) and saves the list and the view, desktop and
// phone, light and dark, for the before-and-after review of a UI change (CONTRIBUTING, "UI
// changes"). Run it against the old `web/` with a different LABEL to compare.

import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { loopbackOrigin } from "../../src/web/static.ts";
import { closePage, emulateViewport, evaluatePage, newPage, resizePage, screenshot } from "./cli.ts";
import { seedObjectives } from "./objective-seed.ts";

const dir = process.argv[2] ?? "";
const label = process.argv[3] ?? "";
if (!dir || !label) throw new Error("usage: node test/browser/objective-shots.ts DIR LABEL");

const seeded = await seedObjectives();
const { t, active } = seeded;
const page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);

async function shot(name: string, hash: string, ready: string): Promise<void> {
	await evaluatePage(`
		location.hash = ${JSON.stringify(hash)};
		await until(() => ${ready});
		await sleep(400);
		scrollTo(0, 0);
		await sleep(100);
		return true;
	`);
	const file = await screenshot(true);
	copyFileSync(file, join(dir, `objectives-${label}-${name}.png`));
	console.log(join(dir, `objectives-${label}-${name}.png`));
}

const LIST = `document.querySelectorAll("#objectives-list .item").length >= 2`;
const VIEW = `!document.getElementById("objective").hidden && document.querySelectorAll("#objective-metrics [data-testid=objective-metric]").length === 3`;

try {
	for (const [dark, suffix] of [[false, ""], [true, "-dark"]] as const) {
		// The scheme rides with the viewport call: `emulate --viewport` resets the emulated media,
		// so setting the scheme first and clearing the viewport after it shoots a light page under
		// a `-dark` name, which is what this script did before PR 149.
		await emulateViewport("", dark ? "dark" : "light");
		await resizePage(1280, 900);
		await shot(`list${suffix}`, "#/objectives", LIST);
		await shot(`view${suffix}`, `#/objectives/${active.id}`, VIEW);
	}
	await emulateViewport("390x844x1,mobile,touch", "light");
	await resizePage(390, 844);
	await shot("list-phone", "#/objectives", LIST);
	await shot("view-phone", `#/objectives/${active.id}`, VIEW);
} finally {
	await emulateViewport("", "auto");
	await resizePage(1280, 900);
	await closePage(page);
	await t.close();
}
