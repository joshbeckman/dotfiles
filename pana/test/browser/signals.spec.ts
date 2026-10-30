import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loopbackOrigin } from "../../src/web/static.ts";
import { chromeDevtoolsAvailable, closePage, emulateViewport, evaluatePage, newPage, resizePage, screenshot } from "./cli.ts";
import { seedDomain, type Seeded } from "./seed.ts";

let seeded: Seeded | undefined;
let page: number | undefined;
afterEach(async () => {
	if (page !== undefined) {
		await emulateViewport("", "auto");
		await closePage(page);
	}
	await seeded?.t.close();
});
(chromeDevtoolsAvailable() ? describe : describe.skip)("signal typography", () => {
	it("loads Departure only for session state badges and shortcut keycaps, not adjacent text", async () => {
		seeded = await seedDomain();
		const { t } = seeded;
		page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);
		await resizePage(1280, 900);
		for (const [name, viewport, scheme] of [["desktop", "", "light"], ["phone-dark", "390x844x3,mobile,touch", "dark"]] as const) {
			await emulateViewport(viewport, scheme);
			const fonts = await evaluatePage<{ loaded: boolean; state: string; key: string; unchanged: string[]; overflow: boolean }>(`
				location.hash = '#/sessions';
				await until(() => document.querySelectorAll('#sessions-list .state-badge').length >= 3);
				await document.fonts.load('11px "Departure Mono"');
				const probe = document.createElement('div');
				probe.innerHTML = '<span class="unread-count">3 unread</span><span class="badge">edited</span><span class="badge modified">modified</span><code>worker.ts</code><kbd>Esc</kbd>';
				document.body.append(probe);
				const family = e => getComputedStyle(e).fontFamily;
				const result = {
					loaded: [...document.fonts].some(f => f.family === 'Departure Mono' && f.status === 'loaded'),
					state: family(document.querySelector('#sessions-list .state-badge')),
					key: family(probe.querySelector('kbd')),
					unchanged: [...probe.querySelectorAll(':not(kbd)')].map(family).concat([family(document.querySelector('#nav')), family(document.body)]),
					overflow: document.documentElement.scrollWidth > innerWidth,
				};
				probe.remove(); return result;
			`);
			expect(fonts.loaded, name).toBe(true);
			expect(fonts.state, name).toContain('Departure Mono');
			expect(fonts.key, name).toContain('Departure Mono');
			expect(fonts.unchanged.every(f => !f.includes('Departure Mono')), name).toBe(true);
			expect(fonts.overflow, name).toBe(false);
			if (process.env.PANA_SIGNAL_SHOTS) {
				for (const view of ["sessions", "help"]) {
					if (view === "help") await evaluatePage(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true })); return true;`);
					await evaluatePage(`await document.fonts.ready; return true;`);
					copyFileSync(await screenshot(true), join(process.env.PANA_SIGNAL_SHOTS, `signals-${name}-${view}-after.png`));
					await evaluatePage(`const style = document.createElement('style'); style.id = 'baseline-fonts'; style.textContent = '.state-badge {font-family:var(--font-sans);font-size:0.72rem;letter-spacing:0.03em} kbd {font-family:var(--font-mono);font-size:0.8rem}'; document.head.append(style); await document.fonts.ready; return true;`);
					copyFileSync(await screenshot(true), join(process.env.PANA_SIGNAL_SHOTS, `signals-${name}-${view}-before.png`));
					await evaluatePage(`document.getElementById('baseline-fonts').remove(); document.getElementById('help-close')?.click(); return true;`);
				}
			}
		}
	});
});
