// Not a test: `node test/browser/choices-shots.ts DIR` seeds a domain, posts a message that
// offers reply options (WEB-10), and saves DIR/choices-<name>.png for the PR.

import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { loopbackOrigin } from "../../src/web/static.ts";
import { closePage, emulateViewport, evaluatePage, newPage, resizePage, screenshot } from "./cli.ts";
import { seedDomain } from "./seed.ts";

const dir = process.argv[2] ?? "";
if (!dir) throw new Error("usage: node test/browser/choices-shots.ts DIR");

const MENU = [
	"Which way should this ship?",
	"",
	"```choices",
	"- Ship it now",
	"- Behind a flag => Ship behind PANA_CHOICES and tell me when it is fully on",
	"- Something else — tell me",
	"```",
].join("\n");

const seeded = await seedDomain();
const { t, group } = seeded;
const thread = await t.client.get<{ messages: Array<{ id: string }> }>(`/threads/${group.threadId}`);
const posted = await t.client.post(`/threads/${group.threadId}/messages`, {
	after: thread.body.messages.at(-1)!.id,
	body: MENU,
});
if (posted.status !== 200) throw new Error(`posting the menu failed: ${JSON.stringify(posted.body)}`);

const origin = loopbackOrigin(t.panad.tcpPort!);
const page = await newPage(`${origin}/#${t.panad.webToken}`);

async function shot(name: string, body: string): Promise<void> {
	await evaluatePage(`${body}\nawait sleep(400);\nreturn true;`);
	const target = join(dir, `choices-${name}.png`);
	copyFileSync(await screenshot(false), target);
	console.log(target);
}

try {
	await resizePage(1280, 1000);
	await evaluatePage(`location.hash = "#/threads/${group.threadId}"; return true;`);

	await shot(
		"desktop",
		`await until(() => document.querySelectorAll('[data-testid="message-choice"]').length === 3);
		 const menu = document.querySelector('[data-testid="message-choices"]');
		 scrollTo(0, menu.getBoundingClientRect().top + scrollY - 220);`,
	);
	await shot(
		"picked",
		`document.querySelectorAll('[data-testid="message-choice"]')[1].click();
		 await until(() => document.querySelector('[data-testid="reply-body"]').value.length > 0);
		 await sleep(200);`,
	);
	// The phone is its own viewport emulation, so it is its own shot.
	await emulateViewport("390x844x3,mobile,touch", "light");
	await evaluatePage(`
		await until(() => document.querySelectorAll('[data-testid="message-choice"]').length === 3);
		const menu = document.querySelector('[data-testid="message-choices"]');
		scrollTo(0, menu.getBoundingClientRect().top + scrollY - 160);
		return true;`);
	copyFileSync(await screenshot(false), join(dir, "choices-phone.png"));
	console.log(join(dir, "choices-phone.png"));
} finally {
	await emulateViewport("");
	await closePage(page);
	await t.close();
}
