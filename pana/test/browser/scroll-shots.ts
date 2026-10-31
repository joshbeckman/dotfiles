// Not a test: `node test/browser/scroll-shots.ts DIR LABEL` saves where the page you navigate to
// starts from (UX-19). It scrolls a thread to its end — which is where opening one leaves you
// (UX-05) — then follows the link back to the inbox and shoots the viewport without scrolling it
// back, so the picture is the position the router left the reader in.

import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { postNotice } from "../../src/threads/index.ts";
import { loopbackOrigin } from "../../src/web/static.ts";
import { closePage, evaluatePage, newPage, resizePage, screenshot } from "./cli.ts";
import { seedDomain } from "./seed.ts";

const dir = process.argv[2] ?? "";
const label = process.argv[3] ?? "";
if (!dir || !label) throw new Error("usage: node test/browser/scroll-shots.ts DIR LABEL");

const seeded = await seedDomain();
const { t } = seeded;
// Threads are inbox rows, so the inbox is taller than the window.
for (let i = 0; i < 24; i++) await postNotice(t.runtime, { body: `A notice that fills a row. ${i}` });
// A thread taller than the window, so opening it lands partway down it (UX-05).
const long = await postNotice(t.runtime, { body: "A long thread" });
let after = long.message.id;
for (let i = 0; i < 14; i++) {
	const res = await t.client.post<{ message: { id: string } }>(`/threads/${long.thread.id}/messages`, {
		after,
		body: `Message ${i}\n\n${"A paragraph that takes some room. ".repeat(12)}`,
	});
	after = res.body.message.id;
}

const page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);
try {
	await resizePage(1280, 900);
	const position = await evaluatePage<number>(`
		location.hash = "#/threads/${long.thread.id}";
		await until(() => document.querySelectorAll("#thread-messages [data-testid=message]").length === 15);
		await sleep(500);
		const reading = scrollY;
		location.hash = "#/inbox";
		await until(() => document.querySelectorAll("#inbox-list .item").length >= 20);
		await sleep(500);
		return reading + scrollY;
	`);
	const file = await screenshot(false);
	copyFileSync(file, join(dir, `${label}.png`));
	console.log(`${join(dir, `${label}.png`)} thread+inbox scrollY=${position}`);
} finally {
	await resizePage(1280, 900);
	await closePage(page);
	await t.close();
}
