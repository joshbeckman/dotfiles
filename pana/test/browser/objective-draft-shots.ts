// Not a test: `node test/browser/objective-draft-shots.ts DIR LABEL` seeds objectives, adds one
// more draft, and saves that draft's view and the confirmation its Archive button asks for — the
// before-and-after of OBJ-07's drafting case (CONTRIBUTING, "UI changes"). Run it against the old
// `web/` with a different LABEL to compare.
//
// On the old code the draft's Archive button is disabled, so the confirmation never opens and only
// the view is saved. Both forms are the point of the pair.

import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { loopbackOrigin } from "../../src/web/static.ts";
import { closePage, emulateViewport, evaluatePage, newPage, resizePage, screenshot } from "./cli.ts";
import { seedObjectives } from "./objective-seed.ts";

const dir = process.argv[2] ?? "";
const label = process.argv[3] ?? "";
if (!dir || !label) throw new Error("usage: node test/browser/objective-draft-shots.ts DIR LABEL");

const seeded = await seedObjectives();
const { t } = seeded;
const page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);

async function shot(name: string): Promise<void> {
	const file = await screenshot(true);
	copyFileSync(file, join(dir, `objectives-${label}-${name}.png`));
	console.log(join(dir, `objectives-${label}-${name}.png`));
}

try {
	// A draft nobody launched: no lead, no members, nothing to stop, and the one the user wants gone.
	const made = await t.client.post<{ objective: { id: string } }>("/objectives", { goal: "Cut the energy bill and dollars" });
	if (made.status !== 201) throw new Error(`create: ${JSON.stringify(made.body)}`);

	await emulateViewport("", "light");
	await resizePage(1280, 900);
	const allowed = await evaluatePage<boolean>(`
		location.hash = "#/objectives/${made.body.objective.id}";
		await until(() => !document.getElementById("objective").hidden && document.getElementById("objective-meta").textContent.includes("drafting"));
		await sleep(400);
		scrollTo(0, 0);
		await sleep(100);
		return document.getElementById("objective-archive").dataset.allowed === "true";
	`);
	await shot("draft-view");

	// With the drafting case in the gate, the button asks first, and a draft gets a draft's question.
	if (allowed) {
		await evaluatePage(`
			document.getElementById("objective-archive").click();
			await until(() => !document.getElementById("objective-confirm").hidden);
			await sleep(200);
			return true;
		`);
		await shot("draft-confirm");
	}
} finally {
	await emulateViewport("", "auto");
	await resizePage(1280, 900);
	await closePage(page);
	await t.close();
}
