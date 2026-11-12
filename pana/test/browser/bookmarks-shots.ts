// Not a test: `node test/browser/bookmarks-shots.ts DIR` saves the bookmark surfaces to
// DIR/bookmarks-<name>.png for the PR's before-and-after evidence (BKM-04, BKM-05): a message's
// menu on an unsaved and a saved message, and the list with a row and with none.

import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { loopbackOrigin } from "../../src/web/static.ts";
import { closePage, emulateColorScheme, evaluatePage, newPage, resizePage, screenshot } from "./cli.ts";
import { seedDomain } from "./seed.ts";

const dir = process.argv[2] ?? "";
if (!dir) throw new Error("usage: node test/browser/bookmarks-shots.ts DIR");

const seeded = await seedDomain({
	capitalReply: [
		"Paris is the capital of France.",
		"",
		"The release note is a different question. A bookmark shows the whole message, so this second paragraph appears here in full rather than as a one-line snippet.",
	].join("\n"),
});
const { t, capital } = seeded;
const origin = loopbackOrigin(t.panad.tcpPort!);
const page = await newPage(`${origin}/#${t.panad.webToken}`);
// The session's reply, which has a body worth reading.
const saved = capital.messageIds[1]!;

async function shot(name: string): Promise<void> {
	copyFileSync(await screenshot(true), join(dir, `bookmarks-${name}.png`));
	console.log(join(dir, `bookmarks-${name}.png`));
}

/** Save the shot with the message's menu open, and say which label it offered. */
async function menu(name: string): Promise<void> {
	const label = await evaluatePage<string>(`
		const message = document.querySelector("#thread-messages [data-testid=message][data-id='${saved}']");
		const menu = message.querySelector("[data-testid=message-menu]");
		if (!menu.open) menu.querySelector("summary").click();
		await until(() => menu.open);
		await sleep(150);
		return message.querySelector("[data-testid=message-bookmark]").textContent;
	`);
	console.log(`bookmarks-${name}.png: ${label}`);
	await shot(name);
}

try {
	for (const [width, height, variant] of [
		[1280, 900, ""],
		[390, 844, "-phone"],
	] as const) {
		await resizePage(width, height);

		// An unsaved message: the menu offers Bookmark. Unsave first, because the loop keeps one
		// domain for both widths.
		await t.client.post(`/messages/${saved}/unbookmark`, {});
		await evaluatePage(`
			location.hash = "#/threads/${capital.threadId}";
			await until(() => document.querySelectorAll("#thread-messages [data-testid=message]").length >= 2);
			scrollTo(0, 0);
			return true;
		`);
		await menu(`menu-unsaved${variant}`);

		// Saved: the menu offers Remove bookmark.
		await t.client.post(`/messages/${saved}/bookmark`, {});
		await evaluatePage(`
			location.hash = "#/threads";
			await until(() => !document.getElementById("threads-browse").hidden);
			location.hash = "#/threads/${capital.threadId}";
			await until(() => document.querySelectorAll("#thread-messages [data-testid=message]").length >= 2);
			scrollTo(0, 0);
			return true;
		`);
		await menu(`menu-saved${variant}`);

		// The list it lands on.
		await evaluatePage(`
			location.hash = "#/bookmarks";
			await until(() => document.querySelectorAll("#bookmarks-list [data-testid=bookmark-item]").length === 1);
			scrollTo(0, 0);
			await sleep(150);
			return true;
		`);
		await shot(`list${variant}`);
	}

	await emulateColorScheme("dark");
	await resizePage(1280, 900);
	await evaluatePage(`
		location.hash = "#/bookmarks";
		await until(() => document.querySelectorAll("#bookmarks-list [data-testid=bookmark-item]").length === 1);
		scrollTo(0, 0);
		await sleep(150);
		return true;
	`);
	await shot("list-dark");

	// Empty, after Remove.
	await emulateColorScheme("auto");
	await evaluatePage(`
		document.querySelector("#bookmarks-list [data-testid=bookmark-remove]").click();
		await until(() => document.querySelectorAll("#bookmarks-list [data-testid=bookmark-item]").length === 0);
		await sleep(150);
		return true;
	`);
	await shot("empty");
} finally {
	await emulateColorScheme("auto");
	await resizePage(1280, 900);
	await closePage(page);
	await t.close();
}
