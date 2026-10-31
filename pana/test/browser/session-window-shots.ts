// Not a test: `node test/browser/session-window-shots.ts DIR` seeds one long session and saves the
// transcript window's screenshots to DIR/session-window-<name>.png, for reviewing UX-18. Run it
// against the old `web/app.js` with `PANA_SESSION_WINDOW_LABEL=before` for the comparison.

import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { sessionRuntime } from "../../src/sessions/index.ts";
import { loopbackOrigin } from "../../src/web/static.ts";
import { startTestPanad } from "../harness/index.ts";
import { closePage, evaluatePage, newPage, resizePage, screenshot } from "./cli.ts";

const dir = process.argv[2] ?? "";
if (!dir) throw new Error("usage: node test/browser/session-window-shots.ts DIR");
const label = process.env.PANA_SESSION_WINDOW_LABEL ?? "after";

// One run with seventy tool calls: more transcript than a window shows at once.
const toolCalls = Array.from({ length: 70 }, () => ({ name: "bash", args: { command: "true" } }));
const t = await startTestPanad({ script: [{ toolCalls }, { text: "Reviewed every path." }], config: { defaultModel: "faux/faux-1", timezone: "UTC" } });
const page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);

async function shot(name: string, body: string): Promise<void> {
	await evaluatePage(body);
	await evaluatePage(`await new Promise((resolve) => setTimeout(resolve, 400)); return true;`);
	const target = join(dir, `session-window-${label}-${name}.png`);
	copyFileSync(await screenshot(), target);
	console.log(target);
}

try {
	await resizePage(1280, 900);
	const created = await t.client.post<{ session: { id: string } }>("/sessions", { prompt: "Review the work tree" });
	if (created.status !== 201) throw new Error(JSON.stringify(created.body));
	const id = created.body.session.id;
	for (let i = 0; i < 400; i++) {
		await t.clock.advance(50);
		await sessionRuntime(t.runtime).idle();
		if ((await t.client.get<{ session: { state: string } }>(`/sessions/${id}`)).body.session.state === "idle") break;
	}
	await shot(
		"opened",
		`location.hash = "#/sessions/${id}";
		 await until(() => document.querySelectorAll("#transcript > [data-testid=entry]").length > 0);
		 await new Promise(requestAnimationFrame);
		 document.scrollingElement.scrollTop = 0;
		 return true;`,
	);
	await shot(
		"loaded",
		`const button = document.querySelector('[data-testid="transcript-earlier"]');
		 if (!button) return true;
		 button.click();
		 await until(() => document.querySelectorAll("#transcript > [data-testid=entry]").length > 30);
		 document.scrollingElement.scrollTop = 0;
		 return true;`,
	);
} finally {
	await closePage(page);
	await t.close();
}
