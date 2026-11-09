// Not a test: `node test/browser/message-html-shots.ts DIR` posts a message whose body carries raw
// HTML (a `<style>` element among it) and saves the thread to DIR/message-html-<name>.png, for
// reviewing WEB-12. Run it once on the branch and once on `master` for the before and after.

import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { loopbackOrigin } from "../../src/web/static.ts";
import { closePage, evaluatePage, newPage, resizePage, screenshot } from "./cli.ts";
import { seedDomain } from "./seed.ts";

const dir = process.argv[2] ?? "";
if (!dir) throw new Error("usage: node test/browser/message-html-shots.ts DIR");

const BODY = [
	"A message may carry raw HTML.",
	"",
	"<style>.topbar, #thread-title, #reply-form { display: none !important } body { background: rgb(200, 0, 0) !important }</style>",
	"",
	"A <b>bold</b> word from a b tag, and a <details><summary>fold</summary>",
	"",
	"Inside the fold, **Markdown still parses**.",
	"",
	"</details>",
].join("\n");

const seeded = await seedDomain();
const { t, group } = seeded;
const before = await t.client.get<{ messages: Array<{ id: string }> }>(`/threads/${group.threadId}`);
const posted = await t.client.post(`/threads/${group.threadId}/messages`, {
	after: before.body.messages.at(-1)!.id,
	body: BODY,
});
if (posted.status !== 200) throw new Error(`post failed: ${posted.status}`);
const page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);

async function shot(name: string): Promise<void> {
	await evaluatePage(`
		location.hash = "#/threads/${group.threadId}";
		await until(() => [...document.querySelectorAll("#thread-messages .prose b")].some(e => e.textContent === "bold"));
		await document.fonts.ready;
		const last = [...document.querySelectorAll("#thread-messages [data-testid=message]")].at(-1);
		scrollTo(0, last.getBoundingClientRect().top + scrollY - 80);
		await sleep(200);
		return true;
	`);
	copyFileSync(await screenshot(true), join(dir, `message-html-${name}.png`));
	console.log(join(dir, `message-html-${name}.png`));
}

try {
	await resizePage(1280, 900);
	await shot("desktop");
	await resizePage(390, 844);
	await shot("phone");
} finally {
	await closePage(page);
	await t.close();
}
