// node test/browser/inbox-shots.ts DIR LABEL — synthetic test-domain evidence.
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { loopbackOrigin } from "../../src/web/static.ts";
import { closePage, emulateViewport, evaluatePage, newPage, resizePage, screenshot } from "./cli.ts";
import { seedDomain } from "./seed.ts";
const [dir, label] = process.argv.slice(2);
if (!dir || !label) throw new Error("usage: node test/browser/inbox-shots.ts DIR LABEL");
const { t } = await seedDomain();
let page: number | undefined;
try {
	page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);
	await resizePage(1280, 900);
	for (const [name, viewport] of [["desktop", ""], ["phone", "390x844x3,mobile,touch"]]) {
		await emulateViewport(viewport!, "light");
		await evaluatePage(`location.hash = '#/inbox'; await until(() => document.querySelector('#inbox-list .item')); await document.fonts.ready; return true;`);
		copyFileSync(await screenshot(), join(dir, `inbox-new-${label}-${name}.png`));
	}
} finally {
	await emulateViewport("", "auto");
	await resizePage(1280, 900);
	if (page !== undefined) await closePage(page);
	await t.close();
}
