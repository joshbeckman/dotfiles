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

describeBrowser("memory editor visibility", () => {
	it("MEM-12 uses phone-sized text and a visible drawn cursor across live theme changes", async () => {
		seeded = await seedDomain();
		const { t } = seeded;
		const content = "# Editing a memory\n\nKeep the cursor visible while changing this paragraph.\n\n- First item\n- Second item\n";
		await t.client.post("/memory/files/editor.md", { content });
		page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);
		await resizePage(1280, 900);
		await evaluatePage(`
			location.hash = '#/memory/edit/editor.md';
			await until(() => window.__pana.memoryEditor?.value() === ${JSON.stringify(content)});
			return true;
		`);
		// Reuse the same editor: changing the OS theme must not require reopening the file.
		for (const [name, viewport, scheme] of [
			["phone-light", "390x844x3,mobile,touch", "light"],
			["phone-dark", "390x844x3,mobile,touch", "dark"],
			["desktop-dark", "", "dark"],
			["desktop-light", "", "light"],
		] as const) {
			await emulateViewport(viewport, scheme);
			const result = await evaluatePage<{
				font: number; cursorWidth: number; cursorColor: string; textColor: string;
				background: string; content: string; focused: boolean; drawnSelection: boolean;
				overflow: boolean;
			}>(`
				// Mobile emulation can reload the page; wait for the lazy editor after that too.
				await until(() => window.__pana?.memoryEditor?.value() === ${JSON.stringify(content)});
				await document.fonts.ready;
				window.__pana.memoryEditor.focus();
				await until(() => document.querySelector('#memory-editor .cm-cursor'));
				const editor = document.querySelector('#memory-editor .cm-editor');
				const cursor = getComputedStyle(editor.querySelector('.cm-cursor'));
				return {
					font: parseFloat(getComputedStyle(editor.querySelector('.cm-scroller')).fontSize),
					cursorWidth: parseFloat(cursor.borderLeftWidth), cursorColor: cursor.borderLeftColor,
					textColor: getComputedStyle(editor).color, background: getComputedStyle(editor).backgroundColor,
					content: window.__pana.memoryEditor.value(),
					focused: editor.classList.contains('cm-focused'),
					drawnSelection: !!editor.querySelector('.cm-selectionLayer'),
					overflow: document.documentElement.scrollWidth > innerWidth,
				};
			`);
			const dir = process.env.PANA_MEMORY_EDITOR_SHOTS;
			if (dir) {
				// Freeze the blink for visual evidence; keep the actual cursor styles under test.
				await evaluatePage(`document.querySelector('#memory-editor .cm-cursorLayer').style.animation = 'none'; return true;`);
				copyFileSync(await screenshot(), join(dir, `memory-editor-${name}.png`));
			}
			expect(result.content, name).toBe(content);
			expect(result.focused, name).toBe(true);
			expect(result.drawnSelection, name).toBe(true);
			expect(result.overflow, name).toBe(false);
			expect(result.textColor, name).toBe(scheme === "dark" ? "rgb(255, 255, 255)" : "rgb(13, 13, 13)");
			expect(result.background, name).toBe(scheme === "dark" ? "rgb(13, 13, 13)" : "rgb(255, 255, 255)");
			expect(result.cursorColor, name).toBe(result.textColor);
			if (viewport) {
				// iOS focuses editable content below 16px by zooming and panning the page.
				// Chrome can enforce this prerequisite; native iOS focus zoom needs simulator/device testing.
				expect(result.font, name).toBeGreaterThanOrEqual(16);
				expect(result.cursorWidth, name).toBe(2);
			} else {
				expect(result.font, name).toBeCloseTo(14.4);
				expect(result.cursorWidth, name).toBeLessThan(2);
			}
		}
	});
});
