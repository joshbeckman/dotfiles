// node test/browser/resume-shots.ts DIR LABEL — synthetic test-domain evidence for WEB-11: the
// inbox a phone left open while a message arrived, then the same inbox after a resume.
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { postNotice } from "../../src/threads/index.ts";
import { loopbackOrigin } from "../../src/web/static.ts";
import { startTestPanad } from "../harness/index.ts";
import { closePage, emulateViewport, evaluatePage, newPage, resizePage, screenshot } from "./cli.ts";

const [dir = "", label = ""] = process.argv.slice(2);
if (!dir || !label) throw new Error("usage: node test/browser/resume-shots.ts DIR LABEL");

const t = await startTestPanad({ config: { defaultModel: "faux/faux-1", timezone: "UTC" } });
// A notice is a delivery with no model turn behind it: it lands in the inbox the moment it is made.
const read = await postNotice(t.runtime, { body: "The boat is in the water." });
const page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);

async function shot(name: string, body: string): Promise<void> {
	await evaluatePage(body);
	copyFileSync(await screenshot(), join(dir, `resume-${name}-${label}.png`));
	console.log(join(dir, `resume-${name}-${label}.png`));
}

try {
	await resizePage(1280, 900);
	await emulateViewport("390x844x3,mobile,touch", "light");
	// Read the first notice, then sit in the inbox with nothing unread.
	await evaluatePage(`
		location.hash = "#/threads/${read.thread.id}";
		await until(() => !document.getElementById("thread").hidden);
		await until(() => document.getElementById("nav-inbox-count").hidden);
		location.hash = "#/inbox";
		await until(() => document.querySelector("#inbox-list .item"));
		await document.fonts.ready;
		return true;
	`);
	// The phone puts the app away.
	await evaluatePage(`
		Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
		document.dispatchEvent(new Event("visibilitychange"));
		return true;
	`);
	const away = await postNotice(t.runtime, { body: "High water at 06:12, so we launch at five." });
	console.log(`arrived while away: ${away.thread.id}`);
	await evaluatePage("await sleep(300); return true;");
	await shot("away", "return true;");
	// Launched from the Home Screen again: the same window, with the new mail in it.
	await shot(
		"back",
		`
		Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
		document.dispatchEvent(new Event("visibilitychange"));
		await until(() => document.querySelector("#inbox-list [data-testid=inbox-snippet]").textContent.includes("High water"));
		await document.fonts.ready;
		return true;
		`,
	);
} finally {
	await emulateViewport("", "auto");
	await resizePage(1280, 900);
	await closePage(page);
	await t.close();
}
