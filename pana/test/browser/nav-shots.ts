// Not a test: `node test/browser/nav-shots.ts DIR LABEL` seeds a domain and saves the Inbox at
// phone and desktop widths to DIR/nav-LABEL-<width>.png, for reviewing the top bar's section menu.
// It also prints how many rows the menu took and how tall the bar grew at each width.

import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loopbackOrigin } from "../../src/web/static.ts";
import { closePage, emulateViewport, evaluatePage, newPage, screenshot } from "./cli.ts";
import { seedDomain } from "./seed.ts";

const dir = process.argv[2] ?? "";
const label = process.argv[3] ?? "nav";
if (!dir) throw new Error("usage: node test/browser/nav-shots.ts DIR [LABEL]");
mkdirSync(dir, { recursive: true });

const seeded = await seedDomain();
const { t } = seeded;
const page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);

interface Bar {
	rows: number;
	height: number;
	items: number;
	overflow: number;
	navBottom: number;
	settingsVisible: boolean;
}

try {
	for (const width of [390, 360, 320, 1280]) {
		await emulateViewport(`${width}x844x3${width < 1000 ? ",mobile,touch" : ""}`);
		const bar = await evaluatePage<Bar>(`
			location.hash = "#/inbox";
			await until(() => document.querySelectorAll("#inbox-list .item").length >= 3);
			scrollTo(0, 0);
			await sleep(300);
			const nav = document.getElementById("nav");
			const links = [...nav.querySelectorAll("a")];
			const tops = new Set(links.map((a) => Math.round(a.getBoundingClientRect().top)));
			const settings = document.querySelector('[data-testid="nav-settings"]');
			const box = settings?.getBoundingClientRect();
			return {
				rows: tops.size,
				height: Math.round(document.querySelector(".topbar").getBoundingClientRect().height),
				items: links.length,
				overflow: nav.scrollWidth - nav.clientWidth,
				navBottom: Math.round(nav.getBoundingClientRect().bottom),
				settingsVisible: Boolean(box && box.width > 0 && getComputedStyle(settings).display !== "none"),
			};
		`);
		const file = await screenshot(true);
		const name = join(dir, `nav-${label}-${width}.png`);
		copyFileSync(file, name);
		console.log(name, JSON.stringify(bar));
		await evaluatePage(`
			location.hash = "#/settings";
			await until(() => document.querySelector("#nav-settings[aria-current=page]"));
			scrollTo(0, 0);
			await sleep(300);
			return true;
		`);
		const settings = join(dir, `nav-${label}-settings-${width}.png`);
		copyFileSync(await screenshot(false), settings);
		console.log(settings);
	}
} finally {
	await emulateViewport("");
	await closePage(page);
	await t.close();
}
