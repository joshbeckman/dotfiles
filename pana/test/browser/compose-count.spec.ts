// SES-06: the New thread screen's Sessions box, end to end in the browser.

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

async function until(t: Seeded["t"], check: () => Promise<boolean>, what: string): Promise<void> {
	const end = Date.now() + 30_000;
	for (;;) {
		await t.clock.settle();
		if (await check()) return;
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

describeBrowser("compose count", () => {
	it("SES-06 the Sessions box starts that many sessions in the one thread, and refuses a count out of range", async () => {
		seeded = await seedDomain();
		const { t } = seeded;
		// Three answers, then empty turns for the runs that each answer wakes in its siblings: they
		// read each other's answers, and RPL-06 keeps them from answering each other.
		t.model.append([
			{ text: "First answer." },
			{ text: "Second answer." },
			{ text: "Third answer." },
			...Array.from({ length: 6 }, () => ({ text: "" })),
		]);
		const threads = async () => (await t.runtime.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM threads"))!.n;
		const before = await threads();

		page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);
		await resizePage(1280, 900);

		// The box is a number input that fits its row at both widths, and it starts at one.
		for (const viewport of ["", "390x844x3,mobile,touch"]) {
			await emulateViewport(viewport, "light");
			const box = await evaluatePage<{ type: string; value: string; fits: boolean; visible: boolean }>(`
				location.hash = '#/compose';
				await until(() => !document.querySelector('#view-compose').hidden);
				const input = document.querySelector('#compose-count');
				const rect = input.getBoundingClientRect();
				return {
					type: input.type,
					value: input.value,
					visible: rect.width > 0 && rect.height > 0,
					fits: rect.x >= 0 && rect.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth,
				};
			`);
			expect(box).toEqual({ type: "number", value: "1", visible: true, fits: true });
		}

		// Eleven is out of range: the box refuses it as a number field, so the form never submits.
		const refused = await evaluatePage<{ hash: string; overflow: boolean; valid: boolean }>(`
			location.hash = '#/compose';
			await until(() => !document.querySelector('#view-compose').hidden);
			const form = document.querySelector('#compose-form');
			const input = document.querySelector('#compose-count');
			input.value = '11';
			const overflow = input.validity.rangeOverflow;
			form.requestSubmit();
			await sleep(300);
			return { hash: location.hash, overflow, valid: form.checkValidity() };
		`);
		expect(refused).toEqual({ hash: "#/compose", overflow: true, valid: false });
		expect(await threads()).toBe(before);

		// Three starts three sessions in the one thread, each answering the prompt.
		const submitted = await evaluatePage<{ hash: string; count: string }>(`
			location.hash = '#/compose';
			await until(() => !document.querySelector('#view-compose').hidden);
			document.querySelector('#compose-count').value = '3';
			document.querySelector('#compose-subject').value = 'Three answers';
			document.querySelector('#compose-body').value = 'Compare these';
			document.querySelector('#compose-form').requestSubmit();
			await until(() => location.hash.startsWith('#/threads/') && !location.hash.includes('undefined'));
			return { hash: location.hash, count: document.querySelector('#compose-count').value };
		`);
		expect(submitted.count).toBe("1");
		const threadId = submitted.hash.replace("#/threads/", "");

		await until(
			t,
			async () => ((await t.runtime.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?", threadId))?.n ?? 0) >= 4,
			"the prompt and three answers",
		);
		const senders = await t.runtime.db.all<{ sender_id: string }>(
			"SELECT sender_id FROM messages WHERE thread_id = ? ORDER BY seq",
			threadId,
		);
		const sessions = await t.runtime.db.all<{ id: string }>("SELECT id FROM sessions");
		const answered = senders.slice(1).map((row) => row.sender_id);
		expect(new Set(answered).size).toBe(3);
		for (const id of answered) expect(sessions.map((s) => s.id)).toContain(id);

		// The page draws the thread with all four participants: the user and the three sessions.
		const people = await evaluatePage<number>(`
			location.hash = '#/threads/${threadId}';
			await until(() => document.querySelectorAll('#thread-messages [data-testid=message]').length >= 4);
			return document.querySelectorAll('#thread-participants .person').length;
		`);
		expect(people).toBe(4);
	});
});
