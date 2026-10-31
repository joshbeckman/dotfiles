// Not a test: `node test/browser/scheduled-shots.ts DIR` seeds a domain, schedules a wake for the
// thread's session, holds a reply mid-flight, and saves the thread footer at desktop and phone
// width: the working line, and the scheduled line under it (UX-09).

import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { sessionRuntime } from "../../src/sessions/index.ts";
import { loopbackOrigin } from "../../src/web/static.ts";
import { closePage, evaluatePage, newPage, resizePage, screenshot } from "./cli.ts";
import { seedDomain } from "./seed.ts";

const dir = process.argv[2] ?? "";
if (!dir) throw new Error("usage: node test/browser/scheduled-shots.ts DIR");

const seeded = await seedDomain();
const { t } = seeded;
const origin = loopbackOrigin(t.panad.tcpPort!);
const page = await newPage(`${origin}/#${t.panad.webToken}`);
const made = await t.client.post<{ schedule: { id: string } }>("/schedules", {
	kind: "wake",
	session: seeded.capital.sessionId,
	in: "2h",
	note: "Check the release.",
	subject: "Check the release",
});
if (made.status !== 201) throw new Error(JSON.stringify(made.body));

try {
	await resizePage(1280, 900);
	await evaluatePage(`
		location.hash = "#/threads/${seeded.capital.threadId}";
		await until(() => window.__pana.state.threadId === "${seeded.capital.threadId}" && !document.getElementById("thread").hidden);
		await until(() => Boolean(document.querySelector("#thread-working [data-testid=scheduled-session]")));
		return true;
	`);
	// A reply held mid-flight makes the same session working while its wake is still pending.
	const release = t.model.gate();
	const reply = await t.client.post(`/threads/${seeded.capital.threadId}/messages`, { after: seeded.capital.messageIds.at(-1), body: "And Lyon?" });
	if (reply.status !== 200) throw new Error(JSON.stringify(reply.body));
	for (const [width, height, suffix] of [[1280, 900, ""], [390, 844, "-phone"]] as const) {
		await resizePage(width, height);
		await evaluatePage(`
			await until(() => Boolean(document.querySelector("#thread-working [data-testid=working-session]")));
			await sleep(300);
			document.getElementById("thread-working").scrollIntoView({ block: "center" });
			await sleep(200);
			return true;
		`);
		const facts = await evaluatePage<{ text: string; overflow: boolean }>(`
			const node = document.getElementById("thread-working");
			return { text: node.textContent, overflow: document.documentElement.scrollWidth > innerWidth };
		`);
		console.log(suffix || "-desktop", JSON.stringify(facts));
		const file = await screenshot(true);
		const out = join(dir, `scheduled-both${suffix}.png`);
		copyFileSync(file, out);
		console.log(out);
	}
	release();
	await sessionRuntime(t.runtime).idle();
} finally {
	await closePage(page);
	await t.close();
}
