import { afterEach, describe, expect, it } from "vitest";
import { loopbackOrigin } from "../../src/web/static.ts";
import { chromeDevtoolsAvailable, closePage, emulateViewport, evaluatePage, newPage, resizePage } from "./cli.ts";
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

describeBrowser("inbox compose", () => {
	it("offers the same New action as Threads on desktop and phone, including archived and empty inboxes", async () => {
		seeded = await seedDomain();
		const { t } = seeded;
		page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);
		await resizePage(1280, 900);
		for (const viewport of ["", "390x844x3,mobile,touch"]) {
			await emulateViewport(viewport, "light");
			for (const archived of [false, true]) {
				const result = await evaluatePage<{ same: boolean; fits: boolean; compose: boolean; archived: boolean; thumbReach: boolean }>(`
					location.hash = '#/inbox';
					await until(() => !document.querySelector('#view-inbox').hidden);
					const toggle = document.querySelector('#inbox-archived');
					if (toggle.checked !== ${archived}) toggle.click();
					const button = document.querySelector('[data-testid="inbox-new"]');
					const other = document.querySelector('[data-testid="threads-new"]');
					const same = button.className === other.className && button.href === other.href && button.textContent === other.textContent;
					const rect = button.getBoundingClientRect();
					const fits = rect.width > 0 && rect.x >= 0 && rect.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth;
					let thumbReach = true;
					if (innerWidth <= 640) {
						thumbReach = rect.width >= 48 && rect.height >= 48 && innerHeight - rect.bottom >= 16 && innerHeight - rect.bottom < 64 && innerWidth - rect.right < 64;
						scrollTo(0, document.body.scrollHeight);
						await new Promise(resolve => requestAnimationFrame(resolve));
						const scrolled = button.getBoundingClientRect();
						const lastRow = document.querySelector('#inbox-list .item:last-child');
						thumbReach &&= Math.abs(scrolled.bottom - rect.bottom) < 1 && (!lastRow || lastRow.getBoundingClientRect().bottom <= scrolled.top);
					}
					button.focus();
					const focused = document.activeElement === button;
					button.click();
					await until(() => !document.querySelector('#view-compose').hidden);
					return { same, fits, compose: focused && location.hash === '#/compose' && !!document.querySelector('#compose-body') && !button.getClientRects().length, archived: toggle.checked, thumbReach };
				`);
				expect(result).toEqual({ same: true, fits: true, compose: true, archived, thumbReach: true });
			}
		}
		for (const thread of await t.runtime.db.all<{ id: string }>("SELECT id FROM threads")) {
			await t.client.post(`/threads/${thread.id}/archive`, {});
		}
		const empty = await evaluatePage<boolean>(`
			location.hash = '#/inbox';
			await until(() => !document.querySelector('#view-inbox').hidden);
			const toggle = document.querySelector('#inbox-archived');
			if (toggle.checked) toggle.click();
			await until(() => !document.querySelector('#inbox-list .item'));
			document.querySelector('[data-testid="inbox-new"]').click();
			await until(() => !document.querySelector('#view-compose').hidden);
			return location.hash === '#/compose';
		`);
		expect(empty).toBe(true);
	});
});
