// Large threads should cost one page of Markdown to open, not the entire history.
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loopbackOrigin } from "../../src/web/static.ts";
import { startTestPanad, type TestPanad } from "../harness/index.ts";
import { chromeDevtoolsAvailable, closePage, emulateViewport, evaluatePage, newPage, screenshot } from "./cli.ts";

const describeBrowser = chromeDevtoolsAvailable() ? describe : describe.skip;
let t: TestPanad | undefined;
let page: number | undefined;
afterEach(async () => {
	if (page !== undefined) { await emulateViewport(""); await closePage(page); }
	page = undefined;
	await t?.close();
	t = undefined;
});

describeBrowser("large thread window", () => {
	it("UX-05 opens recent messages, keeps the real reply head, and loads history around a deep link", async () => {
		t = await startTestPanad();
		const prose = Array.from({ length: 16 }, (_, i) => `### Detail ${i}\n\nA paragraph with **emphasis**, a [link](https://example.com), and some text.\n\n- First item\n- Second item\n\n\`\`\`js\nconst value = ${i};\n\`\`\``).join("\n\n");
		const created = await t.client.post<{ thread: { id: string }; message: { id: string } }>("/threads", { to: ["tester"], body: `Message 0\n\n${prose}` });
		expect(created.status).toBe(201);
		const id = created.body.thread.id;
		const ids = [created.body.message.id];
		for (let i = 1; i < 181; i++) {
			const posted = await t.client.post<{ message: { id: string } }>(`/threads/${id}/messages`, { after: ids.at(-1), body: `Message ${i}\n\n${prose}` });
			expect(posted.status).toBe(200);
			ids.push(posted.body.message.id);
		}
		page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);
		await emulateViewport("390x844x3,mobile,touch", "light");
		await evaluatePage(`await until(() => document.querySelector('[data-testid="inbox-item"]')); return true;`);
		const measured = await evaluatePage<{ ms: number; count: number; head: string; selected: string }>(`
			const start = performance.now(); location.hash = '#/threads/${id}';
			await until(() => !document.querySelector('#thread').hidden && document.querySelector('#thread-messages [data-id="${ids.at(-1)}"]'));
			await new Promise(requestAnimationFrame);
			return { ms: performance.now() - start, count: document.querySelectorAll('#thread-messages .message').length,
				head: document.querySelector('#draft-head').textContent, selected: document.querySelector('#thread-messages .selected')?.dataset.id };
		`);
		console.log("thread-window phone benchmark", JSON.stringify(measured));
		if (process.env.PANA_THREAD_SHOTS) {
			await evaluatePage(`document.querySelector('#thread-subject').scrollIntoView(); return true;`);
			copyFileSync(await screenshot(), join(process.env.PANA_THREAD_SHOTS, `thread-window-${process.env.PANA_THREAD_BASELINE ? "before" : "after"}.png`));
		}
		if (process.env.PANA_THREAD_BASELINE) return;
		expect(measured.count).toBe(30);
		expect(measured.head).toBe(ids.at(-1));
		expect(measured.selected).toBe(ids.at(-1));
		const history = await evaluatePage<{ count: number; first: string; shift: number; focused: boolean }>(`
			const anchor = document.querySelector('#thread-messages .message'); anchor.scrollIntoView();
			const y = anchor.getBoundingClientRect().top;
			const button = document.querySelector('[data-testid="thread-earlier"]'); button.focus(); button.click();
			await until(() => document.querySelectorAll('#thread-messages .message').length === 60);
			return { count: document.querySelectorAll('#thread-messages .message').length, first: document.querySelector('#thread-messages .message').dataset.id, shift: anchor.getBoundingClientRect().top - y, focused: document.activeElement?.dataset.testid === 'thread-earlier' };
		`);
		expect(history.count).toBe(60);
		expect(history.focused).toBe(true);
		expect(history.first).toBe(ids[121]);
		expect(Math.abs(history.shift)).toBeLessThan(2);
		const linked = await evaluatePage<{ count: number; focus: string; head: string; newer: boolean }>(`
			location.hash = '#/threads/${id}?message=${ids[20]}';
			await until(() => document.querySelector('#thread-messages .focus')?.dataset.id === '${ids[20]}');
			return { count: document.querySelectorAll('#thread-messages .message').length, focus: document.querySelector('#thread-messages .focus').dataset.id,
				head: document.querySelector('#draft-head').textContent, newer: !!document.querySelector('[data-testid="thread-later"]') };
		`);
		expect(linked).toEqual({ count: 30, focus: ids[20], head: ids.at(-1), newer: true });
		const complete = await evaluatePage<string[]>(`
			while (document.querySelector('[data-testid="thread-earlier"], [data-testid="thread-later"]')) {
				const button = document.querySelector('[data-testid="thread-earlier"], [data-testid="thread-later"]');
				button.click(); await until(() => !button.isConnected || !button.disabled);
			}
			return [...document.querySelectorAll('#thread-messages .message')].map(e => e.dataset.id);
		`);
		expect(complete).toEqual(ids);
		for (const boundary of [ids[0], ids.at(-1)]) {
			const focused = await evaluatePage<{ count: number; id: string }>(`
				location.hash = '#/threads/${id}?message=${boundary}';
				await until(() => document.querySelector('#thread-messages .focus')?.dataset.id === '${boundary}');
				return { count: document.querySelectorAll('#thread-messages .message').length, id: document.querySelector('#thread-messages .focus').dataset.id };
			`);
			expect(focused).toEqual({ count: 30, id: boundary });
		}
		// A late thread response must not redraw a thread after the reader has navigated away.
		const cancelled = await evaluatePage<boolean>(`
			const originalFetch = window.fetch;
			let release; let started = false;
			const gate = new Promise(resolve => { release = resolve; });
			window.fetch = async (...args) => {
				const response = await originalFetch(...args);
				if (String(args[0]).endsWith('/threads/${id}')) { started = true; await gate; }
				return response;
			};
			try {
				location.hash = '#/threads/${id}'; await until(() => started);
				location.hash = '#/inbox'; await until(() => !document.querySelector('#view-inbox').hidden);
				release(); await sleep(150);
				return document.querySelector('#thread').hidden;
			} finally { release(); window.fetch = originalFetch; }
		`);
		expect(cancelled).toBe(true);
	});
});
