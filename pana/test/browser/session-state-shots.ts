// node test/browser/session-state-shots.ts DIR LABEL — throwaway domain only.
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { startTestPanad } from "../harness/index.ts";
import { loopbackOrigin } from "../../src/web/static.ts";
import { closePage, emulateViewport, evaluatePage, newPage, resizePage, screenshot } from "./cli.ts";

const [dir, label] = process.argv.slice(2);
if (!dir || !label) throw new Error("usage: node test/browser/session-state-shots.ts DIR LABEL");
const t = await startTestPanad();
let page: number | undefined;
try {
	await t.runtime.db.write(async (tx) => {
		for (const state of ["idle", "failed", "stopped", "archived", "idle", "running"]) {
			const id = t.runtime.newId();
			await tx.run("INSERT INTO participants (id, kind, url, created_at) VALUES (?, 'session', ?, ?)", id, t.runtime.url({ kind: "session", id }), t.clock.now());
			await tx.run("INSERT INTO sessions (id, state, model, depth, created_at, updated_at) VALUES (?, ?, 'faux/faux-1', 0, ?, ?)", id, state, t.clock.now(), t.clock.now());
		}
	});
	page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);
	for (const [width, height, suffix] of [[1280, 900, ""], [390, 844, "-phone"]] as const) {
		await emulateViewport(width === 390 ? "390x844x1,mobile,touch" : "");
		await resizePage(width, height);
		await evaluatePage(`
			location.hash = "#/sessions";
			await until(() => document.querySelectorAll("#sessions-list .item").length === 6);
			scrollTo(0, 0);
			return true;
		`);
		const file = join(dir, `session-states-${label}${suffix}.png`);
		copyFileSync(await screenshot(), file);
		console.log(file);
	}
	if (label === "after") {
		await evaluatePage(`
			location.hash = "#/sessions?state=idle";
			await until(() => document.querySelectorAll("#sessions-list .item").length === 2);
			return true;
		`);
		const file = join(dir, "session-states-filtered-phone.png");
		copyFileSync(await screenshot(), file);
		console.log(file);
	}
} finally {
	await emulateViewport("");
	await resizePage(1280, 900);
	if (page !== undefined) await closePage(page);
	await t.close();
}
