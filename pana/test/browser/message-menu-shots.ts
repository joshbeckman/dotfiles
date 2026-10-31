// Not a test: `node test/browser/message-menu-shots.ts DIR` seeds a thread and saves each message's
// action menu closed and open, desktop and phone, to DIR/message-menu-<name>.png, for reviewing
// UX-04. `before` runs it against the old always-visible Edit/Redact links.

import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { loopbackOrigin } from "../../src/web/static.ts";
import { closePage, emulateColorScheme, evaluatePage, newPage, resizePage, screenshot } from "./cli.ts";
import { seedDomain } from "./seed.ts";

const dir = process.argv[2] ?? "";
if (!dir) throw new Error("usage: node test/browser/message-menu-shots.ts DIR");

const seeded = await seedDomain();
const { t } = seeded;
const origin = loopbackOrigin(t.panad.tcpPort!);
const page = await newPage(`${origin}/#${t.panad.webToken}`);

async function shot(name: string, open: boolean): Promise<void> {
	await evaluatePage(`
		location.hash = "#/threads/${seeded.group.threadId}";
		await until(() => document.querySelectorAll("#thread-messages [data-testid=message]").length >= 4);
		const menu = document.querySelector("#thread-messages [data-testid=message-menu]");
		if (menu) menu.open = ${open};
		await sleep(200);
		scrollTo(0, 0);
		await sleep(100);
		return true;
	`);
	copyFileSync(await screenshot(true), join(dir, `message-menu-${name}.png`));
	console.log(join(dir, `message-menu-${name}.png`));
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
} finally {
	await emulateColorScheme("auto");
	await resizePage(1280, 900);
	await closePage(page);
	await t.close();
}
