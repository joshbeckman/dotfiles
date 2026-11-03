// UX-06: an inbox must not give every one-session conversation the same starting color.
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { loopbackOrigin } from "../../src/web/static.ts";
import { participantColor } from "../../web/views.js";
import { closePage, emulateColorScheme, evaluatePage, newPage, resizePage, screenshot } from "./cli.ts";
import { seedDomain, type Seeded } from "./seed.ts";

let seeded: Seeded | undefined;
let page: number | undefined;
afterEach(async () => {
	if (page !== undefined) {
		await emulateColorScheme("auto").catch(() => {});
		await closePage(page);
	}
	await seeded?.t.close();
	page = undefined;
	seeded = undefined;
});

it("UX-06 thread-seeded colors vary across inbox rows but survive reloads and agree with messages", async () => {
	seeded = await seedDomain();
	const { t } = seeded;
	const session = { id: t.runtime.newId(), url: "", kind: "session" };
	session.url = t.runtime.url({ kind: "session", id: session.id });
	await t.runtime.db.write(async (tx) => {
		await tx.run("INSERT INTO participants (id, kind, url, created_at) VALUES (?, 'session', ?, ?)", session.id, session.url, t.clock.now());
		await tx.run("INSERT INTO sessions (id, state, depth, created_at, updated_at) VALUES (?, 'stopped', 0, ?, ?)", session.id, t.clock.now(), t.clock.now());
	});
	const threads: Array<{ id: string; color: string | undefined }> = [];
	for (let i = 1; i <= 18; i++) {
		const made = await t.client.post<{ thread: { id: string; participants: Array<{ url: string; kind: string }> }; message: { id: string } }>("/threads", {
			to: [session.id], subject: `Conversation ${i}: a distinct starting color`, body: "A short question.",
		});
		expect(made.status).toBe(201);
		const reply = await t.client.post(`/threads/${made.body.thread.id}/messages`, { after: made.body.message.id, body: "Here is the answer." }, { caller: session.id });
		expect(reply.status).toBe(200);
		threads.push({ id: made.body.thread.id, color: participantColor(session, { participants: made.body.thread.participants, threadId: made.body.thread.id }) });
	}
	page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);
	await resizePage(1050, 850);
	const inboxColors = async () => evaluatePage<Record<string, string>>(`
		location.hash = '#/inbox';
		await until(() => document.querySelectorAll('#inbox-list [data-thread]').length >= 18);
		const fixtureIds = new Set(${JSON.stringify(threads.map((thread) => thread.id))});
		return Object.fromEntries([...document.querySelectorAll('#inbox-list [data-thread]')].map((row) => {
			const color = row.querySelector('.people .person')?.dataset.color;
			if (fixtureIds.has(row.dataset.thread) && row.querySelector('.snippet-sender').dataset.color !== color) throw new Error('Snippet sender disagrees with participant swatch');
			return [row.dataset.thread, color];
		}));
	`);
	const colors = await inboxColors();
	for (const thread of threads) expect(colors[thread.id]).toBe(thread.color);
	expect(new Set(threads.map((thread) => colors[thread.id])).size).toBeGreaterThan(1);
	const shots = process.env.PANA_SEED_SHOTS_DIR;
	if (shots) {
		mkdirSync(shots, { recursive: true });
		for (const theme of ["light", "dark"] as const) {
			await emulateColorScheme(theme);
			for (const [width, height] of [[1050, 850], [390, 844]]) {
				await resizePage(width!, height!);
				await evaluatePage("scrollTo(0, 0); return true;");
				copyFileSync(await screenshot(true), join(shots, `after-${theme}-${width}.png`));
			}
		}
		await emulateColorScheme("light");
		await resizePage(1050, 850);
	}
	// Visit two threads which use the same session but may start at different palette positions.
	for (const thread of threads.slice(0, 2)) {
		const color = await evaluatePage<string>(`
			location.hash = '#/threads/${thread.id}';
			await until(() => window.__pana.state.threadId === '${thread.id}' && document.querySelectorAll('#thread-messages [data-testid=message]').length === 2);
			return document.querySelector('#thread-messages [data-sender="${session.url}"]').dataset.color;
		`);
		expect(color).toBe(colors[thread.id]);
	}
	const revisited = await inboxColors();
	for (const thread of threads) expect(revisited[thread.id]).toBe(colors[thread.id]);
	// A new page boots the app from scratch, rather than merely revisiting cached rows.
	await closePage(page);
	page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);
	const reloaded = await inboxColors();
	for (const thread of threads) expect(reloaded[thread.id]).toBe(colors[thread.id]);
});
