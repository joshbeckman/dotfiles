// Not a test: `node test/browser/when-shots.ts DIR` seeds a thread, clicks a message's time, and
// saves the reading it reveals — desktop and phone, light and dark — to DIR/when-<name>.png, for
// reviewing UX-21. `PANA_WHEN_SHOTS_LABEL=before` names the files for the run before the change.

import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { loopbackOrigin } from "../../src/web/static.ts";
import { closePage, emulateColorScheme, evaluatePage, newPage, resizePage, screenshot } from "./cli.ts";
import { seedDomain } from "./seed.ts";

const dir = process.argv[2] ?? "";
if (!dir) throw new Error("usage: node test/browser/when-shots.ts DIR");
const label = process.env.PANA_WHEN_SHOTS_LABEL ?? "after";

const seeded = await seedDomain();
const { t } = seeded;
const origin = loopbackOrigin(t.panad.tcpPort!);
const page = await newPage(`${origin}/#${t.panad.webToken}`);

async function shot(name: string, open: boolean): Promise<void> {
	await evaluatePage(`
		location.hash = "#/threads/${seeded.group.threadId}";
		await until(() => document.querySelectorAll("#thread-messages [data-testid=message] time.when").length >= 3);
		const time = document.querySelector("#thread-messages [data-testid=message] time.when");
		// A run against the old app.js has no reading to open, so it shows the time as it was.
		if (${open}) time.click();
		await sleep(300);
		scrollTo(0, 0);
		await sleep(100);
		return true;
	`);
	const path = join(dir, `when-${label}-${name}.png`);
	copyFileSync(await screenshot(true), path);
	console.log(path);
}

try {
	for (const [width, height, suffix] of [
		[1280, 900, ""],
		[390, 844, "-phone"],
	] as const) {
		await resizePage(width, height);
		await shot(`closed${suffix}`, false);
		await shot(`open${suffix}`, true);
	}
	await emulateColorScheme("dark");
	await resizePage(1280, 900);
	await shot("open-dark", true);
	await resizePage(390, 844);
	await shot("open-phone-dark", true);
} finally {
	await emulateColorScheme("auto");
	await resizePage(1280, 900);
	await closePage(page);
	await t.close();
}
