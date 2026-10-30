import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loopbackOrigin } from "../../src/web/static.ts";
import { chromeDevtoolsAvailable, closePage, emulateViewport, evaluatePage, newPage, resizePage, screenshot } from "./cli.ts";
import { seedDomain, type Seeded } from "./seed.ts";

const describeBrowser = chromeDevtoolsAvailable() ? describe : describe.skip;
let seeded: Seeded | undefined;
let page: number | undefined;
afterEach(async () => {
	if (page !== undefined) {
		await emulateViewport("", "auto");
		await resizePage(1280, 900);
		await closePage(page);
	}
	page = undefined;
	await seeded?.t.close();
	seeded = undefined;
});

describeBrowser("corner selection", () => {
	it("centers the brand and menu and marks navigation, j/k targets, and palette choices without shifting layout", async () => {
		seeded = await seedDomain();
		const { t } = seeded;
		page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);
		await resizePage(1280, 900);
		for (const [name, viewport, scheme] of [
			["desktop", "", "light"], ["desktop-dark", "", "dark"],
			["phone", "390x844x3,mobile,touch", "light"], ["phone-dark", "390x844x3,mobile,touch", "dark"],
		] as const) {
			await emulateViewport(viewport, scheme);
			const result = await evaluatePage<{
				pageWidth: number; width: number; centers: number[]; navCenter: number;
				border: string; corners: boolean; pointer: string; shifted: boolean; focus: string;
			}>(`
				location.hash = '#/inbox';
				await until(() => document.querySelector('#inbox-list .item'));
				await document.fonts.ready;
				const nav = document.querySelector('#nav a[aria-current="page"]');
				const links = [...document.querySelectorAll('#nav a')];
				const center = e => { const r = e.getBoundingClientRect(); return r.y + r.height / 2; };
				const row = document.querySelector('#inbox-list .item');
				const before = row.getBoundingClientRect().toJSON();
				document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }));
				const selected = document.querySelector('#inbox-list .item.selected');
				const corners = e => getComputedStyle(e, '::after').backgroundImage.split('linear-gradient').length === 9;
				nav.focus();
				return { pageWidth: document.documentElement.scrollWidth, width: innerWidth,
					centers: [center(document.querySelector('.topbar h1')), center(document.querySelector('.brand-mark'))],
					navCenter: center(nav), border: getComputedStyle(nav).borderBottomWidth,
					corners: corners(nav) && corners(selected) && links.filter(e => getComputedStyle(e, '::after').content !== 'none').length === 1,
					pointer: getComputedStyle(selected, '::after').pointerEvents,
					shifted: JSON.stringify(before) !== JSON.stringify(row.getBoundingClientRect().toJSON()),
					focus: document.activeElement === nav ? 'nav' : 'other' };
			`);
			const badge = await evaluatePage<{ padding: number[]; heights: number[]; widths: number[]; centers: number[] }>(`
				const badge = document.getElementById('nav-inbox-count');
				const original = badge.textContent;
				const css = getComputedStyle(badge);
				const padding = [css.paddingTop, css.paddingRight, css.paddingBottom, css.paddingLeft].map(parseFloat);
				const heights = [], widths = [], centers = [];
				for (const count of ['1', '12', '1234']) {
					badge.textContent = count;
					const b = badge.getBoundingClientRect(), n = badge.parentElement.getBoundingClientRect();
					heights.push(b.height);
					widths.push(b.width);
					centers.push(Math.abs(b.y + b.height / 2 - n.y - n.height / 2));
				}
				badge.textContent = original;
				return { padding, heights, widths, centers };
			`);
			expect(badge.padding, name).toEqual([4, 4, 4, 4]);
			expect(Math.min(...badge.heights), name).toBeGreaterThan(19);
			expect(Math.abs(badge.widths[0]! - badge.heights[0]!), name).toBeLessThan(1);
			expect(badge.widths[2]!, name).toBeGreaterThan(badge.widths[1]!);
			expect(Math.max(...badge.heights) - Math.min(...badge.heights), name).toBeLessThan(1);
			expect(Math.max(...badge.centers), name).toBeLessThan(1);
			expect(result.pageWidth, name).toBeLessThanOrEqual(result.width);
			expect(result.border).toBe("0px");
			expect(result.corners).toBe(true);
			expect(result.pointer).toBe("none");
			expect(result.shifted).toBe(false);
			expect(result.focus).toBe("nav");
			expect(Math.abs(result.centers[0]! - result.centers[1]!)).toBeLessThan(1);
			if (!viewport) expect(Math.abs(result.centers[0]! - result.navCenter)).toBeLessThan(1);
			const dir = process.env.PANA_SELECTION_SHOTS;
			if (dir) {
				await evaluatePage(`document.activeElement.blur(); return true;`);
				copyFileSync(await screenshot(), join(dir, `corner-selection-after-${name}.png`));
			}
		}
		const behavior = await evaluatePage<{ current: string; palette: boolean; message: boolean }>(`
			document.querySelector('#nav a[data-section="threads"]').click();
			await until(() => document.querySelector('#nav a[aria-current="page"]')?.dataset.section === 'threads');
			const current = document.querySelector('#nav a[aria-current="page"]').dataset.section;
			document.querySelector('#open-palette').click();
			await until(() => document.querySelector('.palette .item.focus'));
			const choice = document.querySelector('.palette .item.focus');
			const palette = getComputedStyle(choice, '::after').backgroundImage.includes('linear-gradient') && getComputedStyle(choice).boxShadow === 'none';
			document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
			location.hash = '#/threads/${seeded.group.threadId}';
			await until(() => document.querySelector('#thread-messages .message'));
			document.activeElement.blur();
			document.body.dispatchEvent(new KeyboardEvent('keydown', {key: 'j', bubbles: true}));
			const message = document.querySelector('.message.selected');
			return { current, palette, message: !!message && getComputedStyle(message, '::after').pointerEvents === 'none' };
		`);
		expect(behavior).toEqual({ current: "threads", palette: true, message: true });
	});
});
