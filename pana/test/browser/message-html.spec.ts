// WEB-04: a message may carry raw HTML. Marked passes it through, so the sanitizer decides what
// reaches the page. Rich tags render, scripts and handlers do not, and a `<style>` element must
// never arrive: it would apply to the whole app instead of the one message that sent it.
import { afterEach, describe, expect, it } from "vitest";
import { loopbackOrigin } from "../../src/web/static.ts";
import { chromeDevtoolsAvailable, closePage, evaluatePage, newPage } from "./cli.ts";
import { seedDomain, type Seeded } from "./seed.ts";

const BODY = [
	"Before the tags.",
	"",
	"<style>.topbar, #thread-title { display: none !important } body { background: rgb(255, 0, 0) !important }</style>",
	"",
	"A <b data-testid=\"raw-bold\">bold</b> word from a b tag.",
	"",
	"<details><summary>fold</summary>",
	"",
	"Inside the fold, **Markdown still parses**.",
	"",
	"</details>",
	"",
	"A <script>document.body.dataset.htmlScript = \"ran\"</script> script tag, and an image whose handler should be gone: <img src=\"/icon-192.png\" onerror=\"document.body.dataset.htmlHandler = 'ran'\" alt=\"icon\">.",
].join("\n");

const describeBrowser = chromeDevtoolsAvailable() ? describe : describe.skip;
let seeded: Seeded | undefined;
let page: number | undefined;
afterEach(async () => {
	if (page !== undefined) await closePage(page);
	page = undefined;
	await seeded?.t.close();
	seeded = undefined;
});

describeBrowser("raw HTML in a message", () => {
	it("WEB-12 renders rich tags, drops scripts and handlers, and never lets a style tag reach the document", async () => {
		seeded = await seedDomain();
		const { t, group } = seeded;
		const before = await t.client.get<{ messages: Array<{ id: string }> }>(`/threads/${group.threadId}`);
		const posted = await t.client.post(`/threads/${group.threadId}/messages`, {
			after: before.body.messages.at(-1)!.id,
			body: BODY,
		});
		expect(posted.status).toBe(200);
		page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);
		const shown = await evaluatePage<{
			styleInProse: number;
			styleInDocument: number;
			topbar: string;
			background: string;
			bold: string | null;
			fold: string | null;
			nested: boolean;
			script: string | undefined;
			handler: string | undefined;
			imageHandler: string | null;
			rawVisible: boolean;
		}>(`
			location.hash = "#/threads/${group.threadId}";
			await until(() => [...document.querySelectorAll("#thread-messages .prose b")].some(e => e.dataset.testid === "raw-bold"));
			const prose = document.querySelector("#thread-messages .prose b[data-testid=raw-bold]").closest(".prose");
			const details = prose.querySelector("details");
			const image = prose.querySelector("img");
			return {
				styleInProse: prose.querySelectorAll("style").length,
				styleInDocument: [...document.querySelectorAll("style")].filter(e => (e.textContent || "").includes(".topbar")).length,
				topbar: getComputedStyle(document.querySelector(".topbar")).display,
				background: getComputedStyle(document.body).backgroundColor,
				bold: prose.querySelector("b[data-testid=raw-bold]").textContent,
				fold: details && details.querySelector("summary").textContent,
				nested: Boolean(details && details.querySelector("strong")),
				script: document.body.dataset.htmlScript,
				handler: document.body.dataset.htmlHandler,
				imageHandler: image && image.getAttribute("onerror"),
				rawVisible: prose.textContent.includes("script tag"),
			};
		`);
		expect(shown.styleInProse).toBe(0);
		expect(shown.styleInDocument).toBe(0);
		expect(shown.topbar).not.toBe("none");
		expect(shown.background).not.toBe("rgb(255, 0, 0)");
		expect(shown.bold).toBe("bold");
		expect(shown.fold).toBe("fold");
		expect(shown.nested).toBe(true);
		expect(shown.script).toBeUndefined();
		expect(shown.handler).toBeUndefined();
		expect(shown.imageHandler).toBeNull();
		expect(shown.rawVisible).toBe(true);
	});
});
