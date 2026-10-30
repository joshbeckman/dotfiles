// Not a test: `node test/browser/live-subject-shots.ts DIR` seeds a thread with its first-line subject
// and a subject model, then saves the thread header before and after external regeneration to
// DIR/live-subject-<name>.png, for reviewing UX-16.

import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { postNotice } from "../../src/threads/index.ts";
import { loopbackOrigin } from "../../src/web/static.ts";
import { startTestPanad } from "../harness/index.ts";
import { closePage, evaluatePage, newPage, resizePage, screenshot } from "./cli.ts";

const dir = process.argv[2] ?? "";
if (!dir) throw new Error("usage: node test/browser/live-subject-shots.ts DIR");

const t = await startTestPanad({
	config: { defaultModel: "faux/faux-1", timezone: "UTC", subjectModel: "faux/faux-1" },
	script: [{ text: "Lantern support schedule" }],
});
// A notice rather than a session: no model turn is spent on a run, so the script's one turn is
// the subject the button asks for.
const notice = await postNotice(t.runtime, {
	body: "we should talk about the lantern\n\nand the schedule for the support rotation",
});
const origin = loopbackOrigin(t.panad.tcpPort!);
const page = await newPage(`${origin}/#${t.panad.webToken}`);

async function shot(name: string, body: string): Promise<void> {
	await evaluatePage(body);
	copyFileSync(await screenshot(), join(dir, `live-subject-${name}.png`));
	console.log(join(dir, `live-subject-${name}.png`));
}

try {
	await resizePage(1280, 900);
	await shot(
		"before",
		`
		location.hash = "#/threads/${notice.thread.id}";
		await until(() => document.getElementById("thread-subject").textContent === "we should talk about the lantern");
		document.getElementById("reply-body").value = "Keep this unsent draft while the subject changes";
		await sleep(300);
		scrollTo(0, 0);
		return true;
		`,
	);
	await shot(
		"after",
		`
		await fetch("/threads/${notice.thread.id}/subject", {
			method: "POST", headers: { authorization: "Bearer ${t.panad.webToken}", "content-type": "application/json" },
			body: JSON.stringify({ regenerate: true })
		});
		await until(() => document.getElementById("thread-subject").textContent === "Lantern support schedule");
		await sleep(300);
		scrollTo(0, 0);
		return true;
		`,
	);
} finally {
	await closePage(page);
	await t.close();
}
