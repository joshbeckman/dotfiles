// UX-18 in a real browser: a session opens its newest transcript entries and loads older ones on
// request, instead of parsing the whole transcript before the first paint.

import { afterEach, describe, expect, it } from "vitest";
import { sessionRuntime } from "../../src/sessions/index.ts";
import { loopbackOrigin } from "../../src/web/static.ts";
import { startTestPanad, type TestPanad } from "../harness/index.ts";
import { chromeDevtoolsAvailable, closePage, evaluatePage, newPage, resizePage } from "./cli.ts";

const describeBrowser = chromeDevtoolsAvailable() ? describe : describe.skip;

let t: TestPanad | undefined;
let page: number | undefined;
afterEach(async () => {
	if (page !== undefined) await closePage(page);
	page = undefined;
	await t?.close();
	t = undefined;
});

const PAGE = 30;

describeBrowser("session transcript window", () => {
	it("UX-18 opens the newest page, loads one older page on request, then all of it", async () => {
		// One run with seventy tool calls: four entries per call plus the run's own, so a window
		// of 30 leaves more than one page to load.
		const toolCalls = Array.from({ length: 70 }, () => ({ name: "bash", args: { command: "true" } }));
		t = await startTestPanad({ script: [{ toolCalls }, { text: "done" }], config: { defaultModel: "faux/faux-1", timezone: "UTC" } });
		page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);
		await resizePage(1280, 900);
		const created = await t.client.post<{ session: { id: string } }>("/sessions", { prompt: "run seventy commands" });
		expect(created.status).toBe(201);
		const id = created.body.session.id;
		for (let i = 0; i < 200; i++) {
			await t.clock.advance(50);
			await sessionRuntime(t.runtime).idle();
			const state = (await t.client.get<{ session: { state: string } }>(`/sessions/${id}`)).body.session.state;
			if (state === "idle") break;
		}
		const route = await t.client.get<{ entries: Array<{ id: number }> }>(`/sessions/${id}/transcript`);
		const ids = route.body.entries.map((entry) => entry.id);
		expect(ids.length).toBeGreaterThan(PAGE * 2);

		const opened = await evaluatePage<{ ids: number[]; bottom: boolean; buttons: string[] }>(`
			location.hash = "#/sessions/${id}";
			await until(() => document.querySelectorAll("#transcript > [data-testid=entry]").length > 0);
			await new Promise(requestAnimationFrame);
			const entries = () => [...document.querySelectorAll("#transcript > [data-testid=entry]")];
			const root = document.scrollingElement;
			return {
				ids: entries().map((el) => Number(el.dataset.entryId)),
				bottom: root.scrollHeight - root.scrollTop - root.clientHeight < 4,
				buttons: [...document.querySelectorAll("#transcript [data-history] [data-testid]")].map((el) => el.dataset.testid),
			};
		`);
		// The newest entries only, at the bottom, with one control and no "load all" yet.
		expect(opened.ids).toEqual(ids.slice(-PAGE));
		expect(opened.buttons).toEqual(["transcript-earlier"]);
		expect(opened.bottom).toBe(true);

		const older = await evaluatePage<{ ids: number[]; shift: number; focused: string; buttons: string[] }>(`
			const entries = () => [...document.querySelectorAll("#transcript > [data-testid=entry]")];
			const anchor = entries()[0];
			/* Focus first: focusing scrolls the control into view, so the reader's place is measured from where the click leaves the page. */
			const button = document.querySelector('[data-testid="transcript-earlier"]');
			button.focus();
			anchor.scrollIntoView();
			await new Promise(requestAnimationFrame);
			const top = anchor.getBoundingClientRect().top;
			button.click();
			await until(() => entries().length === ${PAGE * 2});
			return {
				ids: entries().map((el) => Number(el.dataset.entryId)),
				shift: anchor.getBoundingClientRect().top - top,
				focused: document.activeElement?.dataset.testid ?? "",
				buttons: [...document.querySelectorAll("#transcript [data-history] [data-testid]")].map((el) => el.dataset.testid),
			};
		`);
		// The page just older than the window, in front of it, without moving the reader.
		expect(older.ids).toEqual(ids.slice(-PAGE * 2));
		expect(Math.abs(older.shift)).toBeLessThan(2);
		expect(older.focused).toBe("transcript-earlier");
		// With one older page loaded, the second control offers the rest.
		expect(older.buttons).toEqual(["transcript-earlier", "transcript-earlier-all"]);

		const all = await evaluatePage<{ ids: number[]; buttons: string[] }>(`
			document.querySelector('[data-testid="transcript-earlier-all"]').click();
			await until(() => !document.querySelector("#transcript [data-history]"));
			return {
				ids: [...document.querySelectorAll("#transcript > [data-testid=entry]")].map((el) => Number(el.dataset.entryId)),
				buttons: [...document.querySelectorAll("#transcript [data-history] [data-testid]")].map((el) => el.dataset.testid),
			};
		`);
		// Everything, oldest first, with no control left because nothing is older.
		expect(all.ids).toEqual(ids);
		expect(all.buttons).toEqual([]);
	});
});
