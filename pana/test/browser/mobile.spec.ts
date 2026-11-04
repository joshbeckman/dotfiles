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

	it("MOB-03 a phone's view header keeps Back, the title, and the controls' menu on one row", async () => {
		seeded = await seedDomain();
		const { t } = seeded;
		page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);
		await emulateViewport(PHONE);
		const layout = await evaluatePage<{
			titleLines: number;
			sameRow: boolean;
			folded: boolean;
			opened: { visible: boolean; inView: boolean };
		}>(`
			location.hash = "#/sessions/${seeded.capital.sessionId}";
			await until(() => document.querySelectorAll("#transcript [data-testid=entry]").length >= 2);
			await sleep(200);
			const box = (el) => el.getBoundingClientRect();
			const title = document.getElementById("session-title");
			const lineHeight = parseFloat(getComputedStyle(title).lineHeight) || 24;
			const menu = document.querySelector("#session .header-menu");
			const summary = menu.querySelector("summary");
			const actions = menu.querySelector(".header-actions");
			const middle = (el) => box(el).top + box(el).height / 2;
			const sameRow = Math.abs(middle(summary) - middle(title)) < 8;
			const folded = actions.offsetParent === null;
			summary.click();
			await sleep(150);
			const stop = box(document.querySelector("#session [data-testid=session-stop]"));
			return {
				titleLines: Math.round(box(title).height / lineHeight),
				sameRow,
				folded,
				opened: { visible: stop.width > 0 && stop.height > 0, inView: stop.top >= 0 && stop.bottom <= innerHeight },
			};
		`);
		expect(layout.titleLines).toBe(1);
		expect(layout.sameRow).toBe(true);
		// MOB-08: the controls cost the pinned header no row until the reader asks for them.
		expect(layout.folded).toBe(true);
		expect(layout.opened).toEqual({ visible: true, inView: true });
	});

	it("MOB-04 the nav fits one phone row, and Settings is reachable outside it", async () => {
		seeded = await seedDomain();
		page = await newPage(`${loopbackOrigin(seeded.t.panad.tcpPort!)}/#${seeded.t.panad.webToken}`);
		await emulateViewport(PHONE);
		const nav = await evaluatePage<{
			items: number;
			rows: number;
			fits: boolean;
			overflow: number;
			bar: number;
			sticky: number;
			settings: boolean;
		}>(`
			await until(() => document.querySelectorAll("#nav a").length >= 5);
			await document.fonts.ready;
			const nav = document.getElementById("nav");
			const links = [...nav.querySelectorAll("a")];
			const last = links.at(-1);
			const settings = document.querySelector("[data-testid=nav-settings]");
			const bar = document.querySelector(".topbar").getBoundingClientRect();
			const probe = document.createElement("div");
			probe.style.cssText = "position:absolute;visibility:hidden;height:var(--topbar-h)";
			document.body.append(probe);
			const sticky = Math.round(probe.getBoundingClientRect().height);
			probe.remove();
			return {
				items: links.length,
				rows: new Set(links.map((a) => Math.round(a.getBoundingClientRect().top))).size,
				// SCHEDULES was 28 px past the edge, so the last item was cut off mid-word.
				fits: last.getBoundingClientRect().right <= nav.getBoundingClientRect().right + 1,
				overflow: nav.scrollWidth - nav.clientWidth,
				bar: Math.round(bar.height),
				// Every sticky header below the bar is offset by this variable.
				sticky,
				settings: Boolean(settings && settings.getBoundingClientRect().width > 0),
			};
		`);
		// Six sections, one row: Settings is configuration, so it sits with the tools beside the
		// palette rather than wrapping the menu to a second line that holds one word.
		expect(nav.items).toBe(6);
		expect(nav.rows).toBe(1);
		expect(nav.fits).toBe(true);
		expect(nav.overflow).toBe(0);
		expect(nav.settings).toBe(true);
		// The bar used to be 50 px taller than the variable the sticky headers trust.
		expect(Math.abs(nav.bar - nav.sticky)).toBeLessThanOrEqual(2);
		const onSettings = await evaluatePage<{ current: string | null; navCurrent: boolean }>(`
			location.hash = "#/settings";
			await until(() => document.querySelector("[data-testid=nav-settings][aria-current=page]"));
			return {
				current: document.querySelector("[data-testid=nav-settings]")?.getAttribute("aria-current"),
				navCurrent: Boolean(document.querySelector("#nav a[aria-current=page]")),
			};
		`);
		expect(onSettings).toEqual({ current: "page", navCurrent: false });
	});

	it("MOB-05 a phone pins a session's state and facts, and lets its path and URL scroll", async () => {
		seeded = await seedDomain();
		const { t } = seeded;
		// A session with a working directory, so the details line has a path to show.
		const cwd = mkdtempSync(join(tmpdir(), "pana-mob-session-"));
		const created = await t.client.post<{ session: { id: string } }>("/sessions", { prompt: "Compose one", cwd });
		expect(created.status, JSON.stringify(created.body)).toBe(201);
		page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);
		await emulateViewport(PHONE);
		const layout = await evaluatePage<{ facts: number; path: string; url: string; pinned: boolean; sticky: number; wakesHidden: boolean }>(`
			location.hash = "#/sessions/${created.body.session.id}";
			await until(() => !document.getElementById("session").hidden && document.querySelector("[data-testid=session-cwd]"));
			await sleep(200);
			const sticky = document.querySelector("[data-testid=session-sticky]");
			const details = document.getElementById("session-details");
			const wakes = document.getElementById("session-wakes");
			return {
				facts: document.querySelectorAll("[data-testid=session-facts] .fact").length,
				path: document.querySelector("[data-testid=session-cwd]").textContent,
				url: document.querySelector("[data-testid=session-url]").textContent,
				// MOB-08: the path and the URL are reference, not reading matter, so they scroll.
				pinned: !sticky.contains(details),
				sticky: Math.round(sticky.getBoundingClientRect().height),
				wakesHidden: wakes.getBoundingClientRect().height === 0,
			};
		`);
		expect(layout.facts).toBeGreaterThanOrEqual(2);
		expect(layout.path).toBe(cwd);
		expect(layout.url).toBe(`pana://test.example/sessions/${created.body.session.id}`);
		expect(layout.pinned).toBe(true);
		// The pinned header leaves the phone to the transcript.
		expect(layout.sticky).toBeLessThanOrEqual(120);
		expect(layout.wakesHidden).toBe(true);
		rmSync(cwd, { recursive: true, force: true });
	});

	it("MOB-07 a thread's header stays in view while its messages scroll", async () => {
		seeded = await seedDomain();
		page = await newPage(`${loopbackOrigin(seeded.t.panad.tcpPort!)}/#${seeded.t.panad.webToken}`);
		await emulateViewport(PHONE);
		const pinned = await evaluatePage<{
			scrolled: boolean;
			landedBelow: boolean;
			pinnedTop: boolean;
			subject: boolean;
			participants: boolean;
			height: number;
			actions: string[];
		}>(`
			location.hash = "#/threads/${seeded.group.threadId}";
			await until(() => document.querySelectorAll("#thread-messages [data-testid=message]").length >= 4);
			await sleep(200);
			const sticky = document.querySelector("[data-testid=thread-sticky]");
			const topbar = document.querySelector(".topbar").getBoundingClientRect();
			const box = (el) => el.getBoundingClientRect();
			// UX-05 lands on the newest message: it must arrive below the header, not under it.
			const newest = box(document.querySelector("#thread-messages [data-testid=message]:last-of-type"));
			const landedBelow = newest.top >= box(sticky).bottom - 1;
			scrollTo(0, document.documentElement.scrollHeight);
			await sleep(200);
			const inSight = (el) => box(el).top >= topbar.bottom - 1 && box(el).bottom <= innerHeight;
			const menu = document.querySelector("#thread .header-menu");
			menu.querySelector("summary").click();
			await sleep(150);
			return {
				scrolled: scrollY > 0,
				landedBelow,
				// The header is pinned under the nav, not scrolled away with the messages.
				pinnedTop: Math.abs(box(sticky).top - topbar.bottom) < 2,
				subject: inSight(document.getElementById("thread-subject")),
				participants: inSight(document.getElementById("thread-participants")),
				height: Math.round(box(sticky).height),
				actions: [...menu.querySelectorAll(".header-actions button")].filter((button) => button.getBoundingClientRect().height > 0).map((button) => button.textContent.trim()),
			};
		`);
		expect(pinned.scrolled).toBe(true);
		expect(pinned.landedBelow).toBe(true);
		expect(pinned.pinnedTop).toBe(true);
		expect(pinned.subject).toBe(true);
		expect(pinned.participants).toBe(true);
		expect(pinned.actions).toEqual(["Regenerate subject", "Archive"]);
		expect(pinned.height).toBeLessThanOrEqual(120);
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
