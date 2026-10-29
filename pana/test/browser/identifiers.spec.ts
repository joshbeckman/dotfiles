import { afterEach, describe, expect, it } from "vitest";
import { loopbackOrigin } from "../../src/web/static.ts";
import { chromeDevtoolsAvailable, closePage, emulateViewport, evaluatePage, newPage } from "./cli.ts";
import { seedDomain, type Seeded } from "./seed.ts";

let seeded: Seeded | undefined;
let page: number | undefined;
afterEach(async () => {
	if (page !== undefined) {
		await emulateViewport("");
		await closePage(page);
	}
	await seeded?.t.close();
});
(chromeDevtoolsAvailable() ? describe : describe.skip)("identifier typography", () => {
	it("uses mono only for machine tokens in headers, participants, lists, and session details", async () => {
		seeded = await seedDomain();
		const { t, capital, group } = seeded;
		page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);
		await emulateViewport("390x844x3,mobile,touch");
		const thread = await evaluatePage<{ participants: string[]; userTokens: number; senderTokens: number; messageTokens: number; address: string; mono: string; senderFont: string; overflow: boolean }>(`
			location.hash = "#/threads/${group.threadId}";
			await until(() => document.querySelectorAll('#thread-messages .message').length >= 4);
			await document.fonts.ready;
			const user = document.querySelector('.sender[href="#/inbox"]');
			const sender = document.querySelector('.sender[href*="/sessions/"]');
			return {
				participants: [...document.querySelectorAll('#thread-participants .identifier')].map(e => e.textContent),
				userTokens: user.querySelectorAll('.identifier').length,
				senderTokens: sender.querySelectorAll('.identifier').length,
				messageTokens: document.querySelector('[data-testid=message-link]').querySelectorAll('.identifier').length,
				address: document.querySelector('#thread-url .identifier').textContent,
				mono: getComputedStyle(sender.querySelector('.identifier')).fontFamily,
				senderFont: getComputedStyle(sender).fontFamily,
				overflow: document.documentElement.scrollWidth > innerWidth,
			};
		`);
		expect(thread.participants).toHaveLength(2);
		expect(thread.participants.every(id => /^[0-9A-HJKMNP-TV-Z]{6}$/.test(id))).toBe(true);
		expect(thread.userTokens).toBe(0);
		expect(thread.senderTokens).toBe(1);
		expect(thread.messageTokens).toBe(1);
		expect(thread.address).toBe(`pana://test.example/threads/${group.threadId}`);
		expect(thread.mono).toContain("Berkeley Mono");
		expect(thread.senderFont).toContain("IBM Plex Sans");
		expect(thread.overflow).toBe(false);
		const list = await evaluatePage<string[]>(`
			location.hash = '#/sessions';
			await until(() => !document.querySelector('#sessions-list').hidden && document.querySelectorAll('#sessions-list .item').length >= 3);
			return [...document.querySelectorAll('#sessions-list .title .identifier')].map(e => e.textContent);
		`);
		expect(list).toHaveLength(3);
		expect(list).toContain(capital.sessionId);
		const session = await evaluatePage<{ tail: string; url: string; overflow: boolean }>(`
			location.hash = '#/sessions/${capital.sessionId}';
			await until(() => !document.querySelector('#session').hidden && document.querySelector('#session-title .identifier'));
			return {tail:document.querySelector('#session-title .identifier').textContent,
				url:document.querySelector('[data-testid=session-url] .identifier').textContent,
				overflow:document.documentElement.scrollWidth > innerWidth};
		`);
		expect(session.tail).toBe(capital.sessionId.slice(-6));
		expect(session.url).toBe(capital.sessionUrl);
		expect(session.overflow).toBe(false);
	});
});
