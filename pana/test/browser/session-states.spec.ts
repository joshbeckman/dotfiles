import { afterEach, describe, expect, it } from "vitest";
import { sessionRuntime } from "../../src/sessions/index.ts";
import { loopbackOrigin } from "../../src/web/static.ts";
import { startTestPanad, type TestPanad } from "../harness/index.ts";
import { chromeDevtoolsAvailable, closePage, emulateViewport, evaluatePage, newPage, resizePage } from "./cli.ts";

const describeBrowser = chromeDevtoolsAvailable() ? describe : describe.skip;
let t: TestPanad | undefined;
let page: number | undefined;
afterEach(async () => {
	if (page !== undefined) {
		await emulateViewport("");
		await resizePage(1280, 900);
		await closePage(page);
	}
	page = undefined;
	await t?.close();
	t = undefined;
});

describeBrowser("session state filters", () => {
	it("STA-06 filters all stored states, keeps descending ULIDs across pages, and restores the URL filter", async () => {
		t = await startTestPanad();
		const ids: string[] = [];
		await t.runtime.db.write(async (tx) => {
			for (const state of [...Array<string>(52).fill("idle"), "running", "failed", "stopped", "archived"]) {
				const id = t!.runtime.newId();
				ids.push(id);
				await tx.run("INSERT INTO participants (id, kind, url, created_at) VALUES (?, 'session', ?, ?)", id, t!.runtime.url({ kind: "session", id }), t!.clock.now());
				// Deliberately opposite activity order: filtering must not sort by updated_at.
				await tx.run("INSERT INTO sessions (id, state, depth, created_at, updated_at) VALUES (?, ?, 0, ?, ?)", id, state, t!.clock.now(), t!.clock.now() - ids.length * 1000);
			}
		});
		page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);
		const all = await evaluatePage<string[]>(`
			location.hash = "#/sessions";
			const rows = () => [...document.querySelectorAll("#sessions-list .item")];
			await until(() => rows().length === 50);
			document.querySelector("#sessions-list [data-more]").click();
			await until(() => rows().length === 56);
			return rows().map(row => row.dataset.session);
		`);
		expect(all).toEqual([...ids].reverse());
		const filtered = await evaluatePage<{ idle: string[]; states: string[]; empty: string }>(`
			const select = document.getElementById("sessions-state");
			const rows = () => [...document.querySelectorAll("#sessions-list .item")];
			select.value = "idle";
			select.dispatchEvent(new Event("change", { bubbles: true }));
			await until(() => rows().length === 50);
			document.querySelector("#sessions-list [data-more]").click();
			await until(() => rows().length === 52);
			const idle = rows().map(row => row.dataset.session);
			const states = [];
			for (const state of ["running", "failed", "stopped", "archived"]) {
				select.value = state;
				select.dispatchEvent(new Event("change", { bubbles: true }));
				await until(() => rows().length === 1 && rows()[0].textContent.includes(state));
				states.push(rows()[0].textContent.match(/running|failed|stopped|archived/)[0]);
				if (document.querySelector("#sessions-list [data-more]")) throw new Error("stale pagination");
			}
			select.value = "waiting";
			select.dispatchEvent(new Event("change", { bubbles: true }));
			await until(() => document.getElementById("sessions-list").textContent === "No waiting sessions.");
			return { idle, states, empty: document.getElementById("sessions-list").textContent };
		`);
		expect(filtered.idle).toEqual(ids.slice(0, 52).reverse());
		expect(filtered.states).toEqual(["running", "failed", "stopped", "archived"]);
		expect(filtered.empty).toBe("No waiting sessions.");
		await emulateViewport("390x844x1,mobile,touch");
		const restored = await evaluatePage<{ filter: string; count: number; overflow: boolean }>(`
			location.hash = "#/inbox";
			await until(() => !document.getElementById("view-inbox").hidden);
			history.back();
			await until(() => !document.getElementById("view-sessions").hidden && document.getElementById("sessions-state").value === "waiting");
			location.hash = "#/sessions?state=invalid";
			await until(() => document.querySelectorAll("#sessions-list .item").length === 50);
			return { filter: document.getElementById("sessions-state").value, count: document.querySelectorAll("#sessions-list .item").length,
				overflow: document.documentElement.scrollWidth > innerWidth };
		`);
		expect(restored).toEqual({ filter: "", count: 50, overflow: false });
	});

	it("STA-06 combines transcript search with the filter and distinguishes live waiting from running", async () => {
		t = await startTestPanad({
			config: { defaultModel: "faux/faux-1" },
			script: [{ text: "Needle release checked." }, { fail: "overloaded" }, { text: "Recovered." }],
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 60_000 } },
		});
		const made = await t.client.post<{ session: { id: string } }>("/sessions", { prompt: "Find the Needle release." });
		await sessionRuntime(t.runtime).idle();
		const waiting = await t.client.post<{ session: { id: string } }>("/sessions", { prompt: "Wait for the release." });
		page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);
		const result = await evaluatePage<{ waiting: string; running: string; hit: string; empty: string }>(`
			location.hash = "#/sessions?state=waiting";
			await until(() => document.querySelectorAll("#sessions-list .item").length === 1);
			const waiting = document.querySelector("#sessions-list .item").dataset.session;
			location.hash = "#/sessions?state=running";
			await until(() => document.getElementById("sessions-list").textContent === "No running sessions.");
			const running = document.getElementById("sessions-list").textContent;
			location.hash = "#/sessions?state=idle";
			await until(() => document.querySelectorAll("#sessions-list .item").length === 1);
			document.getElementById("sessions-query").value = "Needle";
			document.getElementById("sessions-search").requestSubmit();
			await until(() => document.querySelector("#sessions-list .item")?.textContent.includes("Needle"));
			const hit = document.querySelector("#sessions-list .item").dataset.session;
			location.hash = "#/sessions?state=stopped";
			await until(() => document.getElementById("sessions-list").textContent === "No stopped sessions match “Needle”.");
			return { waiting, running, hit, empty: document.getElementById("sessions-list").textContent };
		`);
		expect(result).toEqual({ waiting: waiting.body.session.id, running: "No running sessions.", hit: made.body.session.id, empty: "No stopped sessions match “Needle”." });
	});
});
