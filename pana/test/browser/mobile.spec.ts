// MOB-01..06 in a real browser at phone width: no view scrolls sideways, long unbroken text wraps,
// the session header keeps its ID readable and stacks its details, the nav fits, and the transcript
// keeps its width for text. Set PANA_MOBILE_SHOTS=DIR to save a screenshot of each view for review.

import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loopbackOrigin } from "../../src/web/static.ts";
import { chromeDevtoolsAvailable, closePage, emulateViewport, evaluatePage, newPage, screenshot } from "./cli.ts";
import { seedDomain, type Seeded } from "./seed.ts";

const describeBrowser = chromeDevtoolsAvailable() ? describe : describe.skip;
// An iPhone-sized viewport. The window itself cannot shrink below about 500 px, so the page emulates one.
const PHONE = "390x844x3,mobile,touch";
const LONG = `pana://lantern.example.org/threads/${"0123456789ABCDEFGHJKMNPQRS".repeat(3)}/and/a/long/path/fireworks/accounts/fireworks/models/deepseek-v4p1-flash-1017`;

let seeded: Seeded | undefined;
let page: number | undefined;

afterEach(async () => {
	if (page !== undefined) {
		await evaluatePage(`localStorage.clear(); sessionStorage.clear(); return true;`).catch(() => undefined);
		await emulateViewport("").catch(() => undefined);
		await closePage(page);
	}
	page = undefined;
	await seeded?.t.close();
	seeded = undefined;
});

interface Overflow {
	scrollWidth: number;
	innerWidth: number;
	/** The outermost elements that reach past the right edge, for a readable failure. */
	offenders: string[];
}

const MEASURE = `
	const describe = (el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (el.dataset.testid ? "[" + el.dataset.testid + "]" : "") + (typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\\s+/).join(".") : "");
	const offenders = [];
	for (const el of document.querySelectorAll("body *")) {
		if (el.closest("[hidden]") || el.offsetParent === null && getComputedStyle(el).position !== "fixed") continue;
		const rect = el.getBoundingClientRect();
		if (rect.width === 0 || rect.right <= innerWidth + 1) continue;
		// A scroll container may hold wide content, such as a code block; that is not overflow. A
		// clipping one is: its text is cut off.
		let clipped = false;
		for (let up = el.parentElement; up && up !== document.body; up = up.parentElement) {
			const style = getComputedStyle(up);
			if (/(auto|scroll)/.test(style.overflowX) && up.getBoundingClientRect().right <= innerWidth + 1) { clipped = true; break; }
		}
		if (clipped) continue;
		if (el.parentElement && offenders.some((o) => o.el.contains(el))) continue;
		offenders.push({ el, text: describe(el) + " right=" + Math.round(rect.right) });
	}
	return { scrollWidth: document.documentElement.scrollWidth, innerWidth, offenders: offenders.map((o) => o.text).slice(0, 8) };
`;

async function view(name: string, hash: string, ready: string): Promise<Overflow> {
	const overflow = await evaluatePage<Overflow>(`
		location.hash = ${JSON.stringify(hash)};
		try { await until(() => ${ready}, 15000); } catch { throw new Error(${JSON.stringify(name)} + " never got ready: " + document.getElementById("status").textContent + " failed requests=" + JSON.stringify(performance.getEntriesByType("resource").filter((e) => e.responseStatus >= 400).map((e) => e.name + " " + e.responseStatus))); }
		await sleep(300);
		${MEASURE}
	`);
	const dir = process.env.PANA_MOBILE_SHOTS;
	if (dir) copyFileSync(await screenshot(), join(dir, `${name}.png`));
	return overflow;
}

describeBrowser("MOB the PWA at phone width", () => {
	it("MOB-01 MOB-02 no view scrolls sideways, even with long URLs, paths, and IDs", async () => {
		seeded = await seedDomain();
		const { t } = seeded;
		// A message body made of one long unbroken token, like a pasted URL.
		const thread = await t.client.get<{ messages: Array<{ id: string }> }>(`/threads/${seeded.group.threadId}`);
		const posted = await t.client.post(`/threads/${seeded.group.threadId}/messages`, {
			after: thread.body.messages.at(-1)!.id,
			body: `See ${LONG}`,
		});
		expect(posted.status, JSON.stringify(posted.body)).toBe(200);

		page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);
		await emulateViewport(PHONE);
		await evaluatePage(`await until(() => document.querySelectorAll("#inbox-list .item").length >= 3); return true;`);
		// The memory views a phone will open, each its own route (MEM-11, MEM-12).
		const memoryLog = await t.client.get<{ commits: Array<{ hash: string }> }>("/memory/log");
		const memoryCommit = memoryLog.body.commits[0]!.hash;

		const views: Array<[string, string, string]> = [
			["inbox", "#/inbox", `document.querySelectorAll("#inbox-list .item").length >= 3`],
			["thread", `#/threads/${seeded.group.threadId}`, `!document.getElementById("thread").hidden && document.querySelectorAll("#thread-messages [data-testid=message]").length >= 7`],
			["threads", "#/threads", `document.querySelectorAll("#threads-list .item").length >= 3`],
			["compose", "#/compose", `!document.getElementById("view-compose").hidden`],
			["sessions", "#/sessions", `document.querySelectorAll("#sessions-list .item").length >= 2`],
			["session", `#/sessions/${seeded.capital.sessionId}`, `document.querySelectorAll("#transcript [data-testid=entry]").length >= 2`],
			["memory", "#/memory", `document.querySelectorAll("#memory-files .item").length >= 1 && document.querySelectorAll("#memory-log .item").length >= 2`],
			["memory-file", "#/memory/files/notes/pana.md", `!document.getElementById("memory-file-view").hidden && document.getElementById("memory-file").textContent.includes("Decisions")`],
			["memory-commit", `#/memory/commits/${memoryCommit}`, `!document.getElementById("memory-commit-view").hidden && document.querySelectorAll("#memory-commit-files .commit-file").length >= 1`],
			["memory-edit", "#/memory/edit/notes/pana.md", `!document.getElementById("memory-edit-view").hidden && window.__pana.memoryEditor && document.querySelector("#memory-editor .cm-editor") !== null`],
			["memory-new", "#/memory/new", `!document.getElementById("memory-edit-view").hidden && window.__pana.memoryEditor && !document.getElementById("memory-path-field").hidden`],
			["schedules", "#/schedules", `document.querySelectorAll("#schedules-list .item").length >= 2`],
		];
		const failures: string[] = [];
		for (const [name, hash, ready] of views) {
			const overflow = await view(name, hash, ready);
			if (overflow.scrollWidth > overflow.innerWidth || overflow.offenders.length > 0) {
				failures.push(`${name}: scrollWidth ${overflow.scrollWidth} > ${overflow.innerWidth}; ${overflow.offenders.join(", ")}`);
			}
		}
		expect(failures).toEqual([]);
	});

	it("MOB-03 the session header keeps the session ID on one line and its controls below it", async () => {
		seeded = await seedDomain();
		const { t } = seeded;
		page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);
		await emulateViewport(PHONE);
		const layout = await evaluatePage<{ titleLines: number; actionsBelow: boolean }>(`
			location.hash = "#/sessions/${seeded.capital.sessionId}";
			await until(() => document.querySelectorAll("#transcript [data-testid=entry]").length >= 2);
			await sleep(200);
			const title = document.getElementById("session-title");
			const lineHeight = parseFloat(getComputedStyle(title).lineHeight) || 24;
			const actions = document.querySelector("#session .header-actions").getBoundingClientRect();
			return { titleLines: Math.round(title.getBoundingClientRect().height / lineHeight), actionsBelow: actions.top >= title.getBoundingClientRect().bottom - 1 };
		`);
		expect(layout.titleLines).toBeLessThanOrEqual(1);
		expect(layout.actionsBelow).toBe(true);
	});

	it("MOB-04 the nav fits a phone's width instead of clipping its last section", async () => {
		seeded = await seedDomain();
		page = await newPage(`${loopbackOrigin(seeded.t.panad.tcpPort!)}/#${seeded.t.panad.webToken}`);
		await emulateViewport(PHONE);
		const nav = await evaluatePage<{ items: number; fits: boolean; overflow: number }>(`
			await until(() => document.querySelectorAll("#nav a").length >= 5);
			const nav = document.getElementById("nav");
			const last = nav.querySelector("a:last-of-type");
			return {
				items: nav.querySelectorAll("a").length,
				// SCHEDULES was 28 px past the edge, so the last item was cut off mid-word.
				fits: last.getBoundingClientRect().right <= nav.getBoundingClientRect().right + 1,
				overflow: nav.scrollWidth - nav.clientWidth,
			};
		`);
		// OBJ-39 added Objectives; six sections still fit a 390 px phone without scrolling.
		expect(nav.items).toBe(6);
		expect(nav.fits).toBe(true);
		expect(nav.overflow).toBe(0);
	});

	it("MOB-05 the session header stacks its details on a phone instead of running them together", async () => {
		seeded = await seedDomain();
		const { t } = seeded;
		// A session with a working directory, so the row the phone dedicates to it has something in it.
		const cwd = mkdtempSync(join(tmpdir(), "pana-mob-session-"));
		const created = await t.client.post<{ session: { id: string } }>("/sessions", { prompt: "Compose one", cwd });
		expect(created.status, JSON.stringify(created.body)).toBe(201);
		page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);
		await emulateViewport(PHONE);
		const layout = await evaluatePage<{ facts: number; urlOwnRow: boolean; cwdOwnRow: boolean; wakesHidden: boolean }>(`
			location.hash = "#/sessions/${created.body.session.id}";
			await until(() => !document.getElementById("session").hidden && document.querySelector("[data-testid=session-facts] .fact-cwd"));
			await sleep(200);
			const meta = document.getElementById("session-meta");
			const facts = meta.querySelector("[data-testid=session-facts]");
			const url = meta.querySelector("[data-testid=session-url]");
			const cwd = meta.querySelector(".fact-cwd");
			const wakes = document.getElementById("session-wakes");
			const box = (el) => el.getBoundingClientRect();
			return {
				facts: facts.querySelectorAll(".fact").length,
				// The URL and the working directory each own a row: neither shares a line with a fact.
				urlOwnRow: Math.abs(box(url).left - box(meta).left) < 2 && box(url).top >= box(facts).bottom - 1,
				cwdOwnRow: box(cwd).width >= box(meta).width - 2 && box(cwd).left <= box(meta).left + 2,
				wakesHidden: box(wakes).height === 0,
			};
		`);
		expect(layout.facts).toBeGreaterThanOrEqual(2);
		expect(layout.urlOwnRow).toBe(true);
		expect(layout.cwdOwnRow).toBe(true);
		expect(layout.wakesHidden).toBe(true);
		rmSync(cwd, { recursive: true, force: true });
	});

	it("MOB-06 a phone's transcript keeps its width for text", async () => {
		seeded = await seedDomain();
		page = await newPage(`${loopbackOrigin(seeded.t.panad.tcpPort!)}/#${seeded.t.panad.webToken}`);
		await emulateViewport(PHONE);
		const widths = await evaluatePage<{ entryPad: number; prePad: number }>(`
			location.hash = "#/sessions/${seeded.capital.sessionId}";
			await until(() => document.querySelector('#transcript [data-testid=entry] pre'));
			const entry = document.querySelector("#transcript [data-testid=entry] pre").closest("[data-testid=entry]");
			const pre = entry.querySelector("pre");
			return {
				entryPad: parseFloat(getComputedStyle(entry).paddingLeft) + parseFloat(getComputedStyle(entry).paddingRight),
				prePad: parseFloat(getComputedStyle(pre).paddingLeft) + parseFloat(getComputedStyle(pre).paddingRight),
			};
		`);
		// 8 px a side (--s2) is the intended value, not a ceiling: a wider indent is a design
		// decision, so this fails rather than drifting 2 px at a time.
		expect(widths.entryPad).toBe(16);
		expect(widths.prePad).toBe(16);
	});
});
