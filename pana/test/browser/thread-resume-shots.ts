// node test/browser/thread-resume-shots.ts DIR LABEL — synthetic test-domain evidence for WEB-11:
// the thread a phone left open while a message arrived, then the same thread after a resume.
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { loopbackOrigin } from "../../src/web/static.ts";
import { startTestPanad } from "../harness/index.ts";
import { closePage, emulateViewport, evaluatePage, newPage, resizePage, screenshot } from "./cli.ts";

const [dir = "", label = ""] = process.argv.slice(2);
if (!dir || !label) throw new Error("usage: node test/browser/thread-resume-shots.ts DIR LABEL");

const t = await startTestPanad({ script: [{ text: "Paris." }], config: { defaultModel: "faux/faux-1", timezone: "UTC" } });
const created = await t.client.post<{ session: { id: string }; thread: { id: string } }>("/sessions", { prompt: "What is the capital of France?" });
const threadId = created.body.thread.id;

async function messages(): Promise<{ id: string }[]> {
	const body = await t.client.get<{ messages: { id: string }[] }>(`/threads/${threadId}`);
	return body.body.messages;
}

for (let i = 0; i < 400 && (await messages()).length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
if ((await messages()).length < 2) throw new Error("the session did not answer");
// A stopped session queues mail without waking, so the append below is only a delivery.
await t.client.post(`/sessions/${created.body.session.id}/stop`);

const page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);

async function shot(name: string, body: string): Promise<unknown> {
	const result = await evaluatePage(body);
	copyFileSync(await screenshot(), join(dir, `thread-resume-${name}-${label}.png`));
	console.log(join(dir, `thread-resume-${name}-${label}.png`), JSON.stringify(result ?? null));
	return result;
}

try {
	await resizePage(1280, 900);
	await emulateViewport("390x844x3,mobile,touch", "light");
	// Read the thread and stay on it, with the reply box empty.
	await evaluatePage(`
		location.hash = "#/threads/${threadId}";
		await until(() => !document.getElementById("thread").hidden);
		await until(() => document.querySelectorAll("#thread-messages [data-testid=message]").length === 2);
		await document.fonts.ready;
		return true;
	`);
	// The phone puts the app away.
	await evaluatePage(`
		Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
		document.dispatchEvent(new Event("visibilitychange"));
		return true;
	`);
	const head = (await messages()).at(-1)!.id;
	await t.client.post(`/threads/${threadId}/messages`, { after: head, body: "High water at 06:12, so we launch at five." }, { caller: created.body.session.id });
	await evaluatePage("await sleep(300); return true;");
	await shot("away", "return true;");
	// Launched from the Home Screen again: the same window, with the new message in it.
	await shot(
		"back",
		`
		Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
		document.dispatchEvent(new Event("visibilitychange"));
		await sleep(1500);
		await document.fonts.ready;
		return document.getElementById("thread-messages").textContent.includes("High water");
		`,
	);
} finally {
	await emulateViewport("", "auto");
	await resizePage(1280, 900);
	await closePage(page);
	await t.close();
}
