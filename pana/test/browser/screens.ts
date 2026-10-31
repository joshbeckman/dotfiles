// Not a test: `node test/browser/screens.ts DIR LABEL [dark]` seeds a domain and saves a
// screenshot of every section to DIR/LABEL-<name>.png, for the before-and-after review of UX-06
// and UX-07. `dark` renders with the dark color scheme.

import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { loopbackOrigin } from "../../src/web/static.ts";
import { closePage, emulateColorScheme, evaluatePage, newPage, resizePage, screenshot } from "./cli.ts";
import { seedDomain } from "./seed.ts";

const dir = process.argv[2] ?? "";
const label = process.argv[3] ?? "";
if (!dir || !label) throw new Error("usage: node test/browser/screens.ts DIR LABEL");

const seeded = await seedDomain();
const { t } = seeded;
const origin = loopbackOrigin(t.panad.tcpPort!);
const page = await newPage(`${origin}/#${t.panad.webToken}`);
const dark = process.argv[4] === "dark";
if (dark) await emulateColorScheme("dark");

async function shot(name: string, hash: string, ready: string, extra = ""): Promise<void> {
	await evaluatePage(`
		location.hash = ${JSON.stringify(hash)};
		await until(() => ${ready});
		${extra}
		await sleep(400);
		scrollTo(0, 0);
		await sleep(100);
		return true;
	`);
	const file = await screenshot(true);
	copyFileSync(file, join(dir, `${label}-${name}.png`));
	console.log(join(dir, `${label}-${name}.png`));
}

try {
	for (const [width, height, suffix] of [[1280, 900, ""], [390, 844, "-phone"]] as const) {
		await resizePage(width, height);
		await shot(`inbox${suffix}`, "#/inbox", `document.querySelectorAll("#inbox-list .item").length >= 3`);
		await shot(`thread${suffix}`, `#/threads/${seeded.group.threadId}`, `document.querySelectorAll("#thread-messages [data-testid=message]").length >= 4`);
		await shot(`session${suffix}`, `#/sessions/${seeded.capital.sessionId}`, `document.querySelectorAll("#transcript [data-testid=entry]").length >= 2`);
		// OBJ-39: this domain seeds no objectives, so the section shows its empty state.
		await shot(`objectives${suffix}`, "#/objectives", `!document.getElementById("view-objectives").hidden && document.getElementById("objectives-list").textContent.length > 0`);
		if (suffix) continue;
		await shot("compose", "#/compose", `!document.getElementById("view-compose").hidden`);
		await shot("threads", "#/threads", `!document.getElementById("threads-list").hidden && document.querySelectorAll("#threads-list .item").length >= 3`);
		await shot(
			"thread-capital",
			`#/threads/${seeded.capital.threadId}`,
			`document.getElementById("thread-subject").textContent.includes("capital") && document.querySelectorAll("#thread-messages [data-testid=message]").length === 2`,
			`document.querySelector("#thread-messages [data-testid=message-menu] > summary")?.click(); await sleep(100); document.querySelector("#thread-messages [data-testid=message-edit]")?.click(); await sleep(100);`,
		);
		await shot("sessions", "#/sessions", `document.querySelectorAll("#sessions-list .item").length >= 3`);
		await shot("memory", "#/memory", `document.querySelectorAll("#memory-files .item").length >= 1 && document.querySelectorAll("#memory-log .item").length >= 2`);
		await shot("memory-file", "#/memory/files/notes/pana.md", `!document.getElementById("memory-file-view").hidden && document.getElementById("memory-file").textContent.includes("Decisions")`);
		await shot("schedules", "#/schedules", `document.querySelectorAll("#schedules-list .item").length >= 2`);
		await shot(
			"help",
			"#/inbox",
			`document.querySelectorAll("#inbox-list .item").length >= 3`,
			`document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "?", bubbles: true }));`,
		);
		await evaluatePage(`document.getElementById("help-close")?.click(); return true;`);
	}
} finally {
	await resizePage(1280, 900);
	if (dark) await emulateColorScheme("auto");
	await closePage(page);
	await t.close();
}
