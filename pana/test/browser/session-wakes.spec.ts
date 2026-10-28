import { afterEach, describe, expect, it } from "vitest";
import { sessionRuntime } from "../../src/sessions/index.ts";
import { loopbackOrigin } from "../../src/web/static.ts";
import { startTestPanad, type TestPanad } from "../harness/index.ts";
import { chromeDevtoolsAvailable, closePage, evaluatePage, newPage, resizePage } from "./cli.ts";

const describeBrowser = chromeDevtoolsAvailable() ? describe : describe.skip;
let t: TestPanad | undefined;
let page: number | undefined;
afterEach(async () => {
	await resizePage(1280, 900);
	if (page !== undefined) await closePage(page);
	page = undefined;
	await t?.close();
});

describeBrowser("session wakes", () => {
	it("WAK-08 shows pending wakes, links a schedule beyond the first page, and reloads the empty state at phone width", async () => {
		t = await startTestPanad({ script: [{ text: "I will check later." }], config: { defaultModel: "faux/faux-1", timezone: "UTC" } });
		const made = await t.client.post<{ session: { id: string } }>("/sessions", { prompt: "Wait for the release." });
		const id = made.body.session.id;
		await sessionRuntime(t.runtime).idle();
		for (let i = 0; i < 101; i++) {
			const filler = await t.client.post("/schedules", { kind: "session", at: t.clock.now() + 60_000, prompt: "Unrelated check", subject: `Other ${i}` });
			expect(filler.status).toBe(201);
		}
		const madeWake = await t.client.post<{ schedule: { id: string } }>("/schedules", { kind: "wake", session: id, in: "1h", note: "Check later.", subject: "Check release <readiness>" });
		expect(madeWake.status).toBe(201);
		const wakeId = madeWake.body.schedule.id;
		page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);
		await resizePage(390, 844);
		const shown = await evaluatePage<{ text: string; href: string; time: string; overflow: boolean; meta: string }>(`
			location.hash = ${JSON.stringify(`#/sessions/${id}`)};
			await until(() => document.querySelector("#session-wakes a"));
			const section = document.getElementById("session-wakes");
			return { meta: document.getElementById("session-meta").textContent, text: section.textContent, href: section.querySelector("a").getAttribute("href"),
				time: section.querySelector("time").dateTime,
				overflow: document.documentElement.scrollWidth > innerWidth };
		`);
		expect(shown.text).toContain("Scheduled wakes (1)");
		expect(shown.meta).toContain("scheduled wakes: 1");
		expect(shown.text).toContain("Check release <readiness>");
		expect(shown.href).toBe(`#/schedules?focus=${wakeId}`);
		expect(shown.time).toBe(new Date(t.clock.now() + 3_600_000).toISOString());
		expect(shown.overflow).toBe(false);
		const focused = await evaluatePage<string>(`
			document.querySelector("#session-wakes a").click();
			await until(() => document.querySelector("#schedules-list .item.focus"));
			return document.querySelector("#schedules-list .item.focus").dataset.id;
		`);
		expect(focused).toBe(wakeId);
		await t.client.delete(`/schedules/${wakeId}`);
		const empty = await evaluatePage<string>(`
			location.hash = ${JSON.stringify(`#/sessions/${id}`)};
			await until(() => document.getElementById("session-wakes").textContent === "No scheduled wakes.");
			return document.getElementById("session-wakes").textContent;
		`);
		expect(empty).toBe("No scheduled wakes.");
	});
});
