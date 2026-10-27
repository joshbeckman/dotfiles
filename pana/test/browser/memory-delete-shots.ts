// `node test/browser/memory-delete-shots.ts DIR LABEL [confirm]` captures a seeded file view.
// For the baseline, run against the pre-change web assets; `confirm` also captures the prompt
// on desktop and phone. Only the isolated test domain is ever modified.
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { loopbackOrigin } from "../../src/web/static.ts";
import { startTestPanad } from "../harness/index.ts";
import { closePage, evaluatePage, newPage, resizePage, screenshot } from "./cli.ts";

const [dir, label, confirm] = process.argv.slice(2);
if (!dir || !label) throw new Error("usage: node test/browser/memory-delete-shots.ts DIR LABEL [confirm]");
const t = await startTestPanad();
await t.tcp.post("/memory/files/notes/temporary.md", { content: "# Temporary note\n\nThis file is no longer needed.\n" });
const page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);
async function shot(suffix: string): Promise<void> {
	copyFileSync(await screenshot(), join(dir!, `memory-delete-${label}${suffix}.png`));
}
try {
	await resizePage(1280, 900);
	await evaluatePage(`
		location.hash = "#/memory/files/notes/temporary.md";
		await until(() => document.getElementById("memory-file").textContent.includes("no longer needed"));
		await document.fonts.ready;
		return true;
	`);
	await shot("");
	if (confirm) {
		await evaluatePage(`document.getElementById("memory-delete").click(); return true;`);
		await shot("-confirm");
		await resizePage(390, 844);
		await shot("-phone");
	}
} finally {
	await resizePage(1280, 900);
	await closePage(page);
	await t.close();
}
