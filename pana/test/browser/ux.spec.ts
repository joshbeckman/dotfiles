// WP13 in a real browser (UX-01..08) against a seeded test panad. Keys are dispatched as
// KeyboardEvents on the focused element, which is the path the app's one keydown listener reads.

import { afterEach, describe, expect, it } from "vitest";
import { sessionRuntime } from "../../src/sessions/index.ts";
import { postNotice } from "../../src/threads/index.ts";
import { loopbackOrigin } from "../../src/web/static.ts";
import { INPUT_KEYMAP, KEYMAP } from "../../web/keys.js";
import { PALETTE } from "../../web/views.js";
import type { TestPanad } from "../harness/index.ts";
import { chromeDevtoolsAvailable, closePage, evaluatePage, newPage, resizePage } from "./cli.ts";
import { seedDomain, type Seeded } from "./seed.ts";

const describeBrowser = chromeDevtoolsAvailable() ? describe : describe.skip;

let seeded: Seeded | undefined;
let page: number | undefined;

afterEach(async () => {
	if (page !== undefined) {
		await evaluatePage(`localStorage.clear(); sessionStorage.clear(); return true;`).catch(() => undefined);
		await closePage(page);
	}
	page = undefined;
	await seeded?.t.close();
	seeded = undefined;
});

async function start(): Promise<{ t: TestPanad; origin: string }> {
	seeded = await seedDomain();
	const origin = loopbackOrigin(seeded.t.panad.tcpPort!);
	page = await newPage(`${origin}/#${seeded.t.panad.webToken}`);
	// Layout checks measure a desktop window; the screenshot script may have left a phone one.
	await resizePage(1280, 900);
	await evaluatePage(`await until(() => document.querySelectorAll("#inbox-list .item").length >= 3); return true;`);
	return { t: seeded.t, origin };
}

/** Page helpers: press a key on the focused element, and wait for the app to settle. */
const KEYS = `
	const press = async (key, init = {}) => {
		const target = document.activeElement && document.activeElement !== document.body ? document.activeElement : document.body;
		target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
		await sleep(30);
	};
	const submitChord = () => (window.__pana.state.apple ? { metaKey: true } : { ctrlKey: true });
	const wrongChord = () => (window.__pana.state.apple ? { ctrlKey: true } : { metaKey: true });
	const selectedThread = () => window.__pana.state.selected?.thread;
`;

async function settle(t: TestPanad, check: () => Promise<boolean>, what: string): Promise<void> {
	const end = Date.now() + 15_000;
	for (;;) {
		await t.clock.settle();
		await sessionRuntime(t.runtime).idle();
		if (await check()) return;
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

function rgb(hex: string): string {
	const n = Number.parseInt(hex.slice(1), 16);
	return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

describeBrowser("pana usability in a browser", () => {
	it("UX-01 the click asks inside the user gesture, Allow subscribes, and each refusal names its cause", async () => {
		const { t, origin } = await start();
		// The real browser: a secure context with a service worker and Web Push.
		const env = await evaluatePage<{ secure: boolean; worker: boolean; push: boolean; permission: string }>(`
			const registration = await until(() => navigator.serviceWorker.getRegistration().then((r) => r?.active ? r : undefined));
			return { secure: isSecureContext, worker: Boolean(registration.active), push: "PushManager" in window, permission: Notification.permission };
		`);
		expect(env).toMatchObject({ secure: true, worker: true, push: true });

		// The prompt itself cannot be answered from a test, so Notification is stubbed. The stub
		// records whether the click's user activation was still live when the app asked.
		const denied = await evaluatePage<{ asked: boolean[]; status: string }>(`
			window.__asked = [];
			Object.defineProperty(Notification, "permission", { configurable: true, get: () => "default" });
			Notification.requestPermission = () => {
				window.__asked.push(navigator.userActivation.isActive);
				return new Promise((resolve) => setTimeout(() => resolve("denied"), 400));
			};
			document.getElementById("enable-push").click();
			await until(() => document.getElementById("status").textContent.includes("denied"));
			return { asked: window.__asked, status: document.getElementById("status").textContent };
		`);
		expect(denied.asked).toEqual([true]);
		expect(denied.status).toContain("Chrome answered “denied”");
		expect(denied.status).toContain("System Settings › Notifications › Google Chrome");
		expect(denied.status).not.toContain("Notifications are off: permission denied");

		const silent = await evaluatePage<string>(`
			Notification.requestPermission = () => Promise.resolve("denied");
			document.getElementById("enable-push").click();
			await until(() => document.getElementById("status").textContent.includes("without showing a prompt"));
			return document.getElementById("status").textContent;
		`);
		expect(silent).toContain("site controls");

		const blocked = await evaluatePage<{ status: string; asked: number }>(`
			window.__asked = [];
			Notification.requestPermission = () => { window.__asked.push(true); return Promise.resolve("denied"); };
			Object.defineProperty(Notification, "permission", { configurable: true, get: () => "denied" });
			document.getElementById("enable-push").click();
			await until(() => document.getElementById("status").textContent.includes("already blocks"));
			return { status: document.getElementById("status").textContent, asked: window.__asked.length };
		`);
		expect(blocked.asked).toBe(0);
		expect(blocked.status).toContain(`already blocks notifications for ${origin}`);

		// Allowed, but the push service refuses: the error is named, not called a denial.
		const refused = await evaluatePage<string>(`
			Object.defineProperty(Notification, "permission", { configurable: true, get: () => "granted" });
			PushManager.prototype.getSubscription = async () => null;
			PushManager.prototype.subscribe = async () => { throw new DOMException("Registration failed - push service error", "AbortError"); };
			document.getElementById("enable-push").click();
			await until(() => document.getElementById("status").textContent.includes("AbortError"));
			return document.getElementById("status").textContent;
		`);
		expect(refused).toContain("could not reach its push service");
		expect((await t.runtime.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM push_subscriptions"))!.n).toBe(0);

		// Allowed and subscribed: the subscription reaches panad.
		const subscribed = await evaluatePage<string>(`
			const keys = { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" };
			PushManager.prototype.subscribe = async () => ({ endpoint: "https://push.example/ux-01", toJSON: () => ({ endpoint: "https://push.example/ux-01", keys }) });
			document.getElementById("enable-push").click();
			await until(() => document.getElementById("status").textContent.includes("Notifications enabled."));
			return document.getElementById("status").textContent;
		`);
		expect(subscribed).toBe("Notifications enabled.");
		const rows = await t.runtime.db.all<{ endpoint: string }>("SELECT endpoint FROM push_subscriptions");
		expect(rows.map((row) => row.endpoint)).toEqual(["https://push.example/ux-01"]);
	});

	it("UX-02 Cmd+Enter (Ctrl+Enter off macOS) submits reply, compose, edit, memory, and schedules", async () => {
		const { t } = await start();
		const group = seeded!.group;
		const before = (await t.client.get<{ messages: unknown[] }>(`/threads/${group.threadId}`)).body.messages.length;

		// Reply. The other platform's chord does nothing.
		await evaluatePage(`
			${KEYS}
			location.hash = "#/threads/${group.threadId}";
			await until(() => !document.getElementById("thread").hidden && document.querySelectorAll("#thread-messages [data-testid=message]").length >= 6);
			const box = document.getElementById("reply-body");
			box.focus();
			box.value = "sent with the keyboard";
			await press("Enter", wrongChord());
			await sleep(200);
			if (document.querySelectorAll("#thread-messages [data-testid=message]").length !== ${before}) throw new Error("the wrong chord submitted");
			await press("Enter", submitChord());
			await until(() => [...document.querySelectorAll("#thread-messages .body")].some((el) => el.textContent.includes("sent with the keyboard")));
			return true;
		`);
		const replies = (await t.client.get<{ messages: Array<{ body?: string; sender: { url: string } }> }>(`/threads/${group.threadId}`)).body.messages;
		const mine = replies.slice(before).filter((message) => message.sender.url === t.runtime.userUrl);
		expect(mine.map((message) => message.body)).toEqual(["sent with the keyboard"]);

		// Edit, from the confirmation form inside the message.
		const target = seeded!.capital.messageIds[0]!;
		await evaluatePage(`
			${KEYS}
			location.hash = "#/threads/${seeded!.capital.threadId}";
			await until(() => document.getElementById("thread-subject").textContent.includes("capital") && document.querySelectorAll("#thread-messages [data-testid=message]").length === 2);
			document.querySelector("#thread-messages [data-testid=message-edit]").click();
			await until(() => !document.getElementById("confirm").hidden);
			const box = document.getElementById("edit-body");
			box.focus();
			box.value = "edited with the keyboard";
			await press("Enter", submitChord());
			await until(() => document.querySelector("#thread-messages .body")?.textContent.includes("edited with the keyboard"));
			return true;
		`);
		expect((await t.client.get<{ message: { body: string; revised: boolean } }>(`/messages/${target}`)).body.message).toMatchObject({
			body: "edited with the keyboard",
			revised: true,
		});

		// Compose.
		const sessionsBefore = (await t.client.get<{ sessions: unknown[] }>("/sessions")).body.sessions.length;
		await evaluatePage(`
			${KEYS}
			location.hash = "#/compose";
			await until(() => !document.getElementById("view-compose").hidden);
			document.getElementById("compose-subject").value = "From the keyboard";
			const box = document.getElementById("compose-body");
			box.focus();
			box.value = "Composed with Cmd+Enter";
			await press("Enter", submitChord());
			await until(() => location.hash.startsWith("#/threads/"));
			return true;
		`);
		expect((await t.client.get<{ sessions: unknown[] }>("/sessions")).body.sessions.length).toBe(sessionsBefore + 1);
		await settle(t, async () => true, "the composed session");

		// Memory.
		await evaluatePage(`
			${KEYS}
			location.hash = "#/memory";
			await until(() => document.querySelectorAll("#memory-files .item").length >= 1);
			document.querySelector("#memory-files .item").click();
			await until(() => !document.getElementById("memory-open").hidden);
			const box = document.getElementById("memory-edit");
			box.focus();
			box.value = "# pana\\n\\nSaved with the keyboard.\\n";
			await press("Enter", submitChord());
			await until(() => document.getElementById("memory-file").textContent.includes("Saved with the keyboard"));
			return true;
		`);
		expect((await t.client.get<{ content: string }>("/memory/files/notes/pana.md")).body.content).toContain("Saved with the keyboard");

		// Schedules.
		const schedulesBefore = (await t.client.get<{ schedules: unknown[] }>("/schedules")).body.schedules.length;
		await evaluatePage(`
			${KEYS}
			location.hash = "#/schedules";
			await until(() => document.querySelectorAll("#schedules-list .item").length >= 2);
			document.getElementById("schedule-when").value = "0 18 * * 5";
			const box = document.getElementById("schedule-prompt");
			box.focus();
			box.value = "Friday wrap-up";
			await press("Enter", submitChord());
			await until(() => document.querySelectorAll("#schedules-list .item").length === ${schedulesBefore + 1});
			return true;
		`);
		const schedules = (await t.client.get<{ schedules: Array<{ payload: { prompt?: string } }> }>("/schedules")).body.schedules;
		expect(schedules.map((schedule) => schedule.payload.prompt)).toContain("Friday wrap-up");
	});

	it("UX-03 the inbox shows one row per thread, latest activity first, with participants, snippet, time, and unread count", async () => {
		const { t } = await start();
		const api = (await t.client.get<{ threads: Array<{ threadId: string; unreadCount: number; latest: { snippet: string } }> }>("/inbox?view=threads")).body
			.threads;
		const rows = await evaluatePage<Array<{ thread: string; subject: string; people: string[]; snippet: string; time: string; unread: string | null; marked: boolean }>>(`
			location.hash = "#/inbox";
			await until(() => document.querySelectorAll("#inbox-list .item").length === ${api.length});
			return [...document.querySelectorAll("#inbox-list .item")].map((row) => ({
				thread: row.dataset.thread,
				subject: row.querySelector(".title").textContent,
				people: [...row.querySelectorAll(".people [data-testid=ref-link]")].map((a) => a.title),
				snippet: row.querySelector("[data-testid=inbox-snippet]").textContent,
				time: row.querySelector("time").textContent,
				unread: row.querySelector("[data-testid=unread-count]")?.textContent ?? null,
				marked: row.classList.contains("unread"),
			}));
		`);
		// One row per thread the user is in and has not archived, in the server's activity order.
		expect(rows.map((row) => row.thread)).toEqual(api.map((thread) => thread.threadId));
		expect(new Set(rows.map((row) => row.thread)).size).toBe(rows.length);
		expect(rows.map((row) => row.thread)).not.toContain(seeded!.archivedThreadId);
		expect(rows[0]!.subject).toBe("Scheduled session failed: the model was unreachable.");
		const group = rows.find((row) => row.thread === seeded!.group.threadId)!;
		expect(group.people.sort()).toEqual([...seeded!.group.sessionUrls].sort());
		expect(group.snippet).toContain("Glad that is settled.");
		for (const row of rows) {
			expect(row.time).not.toBe("");
			const count = api.find((thread) => thread.threadId === row.thread)!.unreadCount;
			expect(row.marked).toBe(count > 0);
			expect(row.unread).toBe(count > 0 ? `${count} unread` : null);
		}

		// Load more pages through the same rows (SCALE-03), and the delivery count still drives the badge.
		for (let i = 0; i < 55; i++) await postNotice(t.runtime, { body: `notice ${i}` });
		const unreadTotal = (await t.client.get<{ unreadTotal: number }>("/inbox?view=threads")).body.unreadTotal;
		const paged = await evaluatePage<{ first: number; all: number; badge: string }>(`
			// Each new notice is a live event that redraws the first page. Let them finish, or a
			// redraw lands after "Load more" and replaces the page it added.
			await until(() => document.getElementById("nav-inbox-count").textContent === "${unreadTotal}");
			let last = "";
			await until(async () => {
				await sleep(700);
				const now = [...document.querySelectorAll("#inbox-list .item")].map((el) => el.dataset.thread).join();
				const settled = now === last;
				last = now;
				return settled;
			});
			await until(() => document.querySelectorAll("#inbox-list .item").length === 50);
			const first = document.querySelectorAll("#inbox-list .item").length;
			document.querySelector("#inbox-list [data-more]").click();
			await until(() => !document.querySelector("#inbox-list [data-more]"));
			return { first, all: document.querySelectorAll("#inbox-list .item").length, badge: document.getElementById("nav-inbox-count").textContent };
		`);
		expect(paged.first).toBe(50);
		expect(paged.all).toBe(api.length + 55);
		expect(Number(paged.badge)).toBe(unreadTotal);
	});

	it("UX-04 Edit and Redact are small secondary controls on each message", async () => {
		await start();
		const sizes = await evaluatePage<{ count: number; messages: number; edit: { h: number; font: number; border: string; inHeader: boolean }; reply: { h: number; font: number } }>(`
			location.hash = "#/threads/${seeded!.group.threadId}";
			await until(() => document.querySelectorAll("#thread-messages [data-testid=message]").length >= 6);
			const edit = document.querySelector("#thread-messages [data-testid=message-edit]");
			const reply = document.querySelector("[data-testid=reply-send]");
			const style = getComputedStyle(edit);
			return {
				count: document.querySelectorAll("#thread-messages [data-testid=message-edit], #thread-messages [data-testid=message-redact]").length,
				messages: document.querySelectorAll("#thread-messages [data-testid=message]").length,
				edit: { h: edit.getBoundingClientRect().height, font: parseFloat(style.fontSize), border: style.borderTopStyle, inHeader: Boolean(edit.closest(".message > header")) },
				reply: { h: reply.getBoundingClientRect().height, font: parseFloat(getComputedStyle(reply).fontSize) },
			};
		`);
		expect(sizes.count).toBe(sizes.messages * 2);
		expect(sizes.edit.inHeader).toBe(true);
		expect(sizes.edit.border).toBe("none");
		expect(sizes.edit.h).toBeLessThan(sizes.reply.h / 1.5);
		expect(sizes.edit.font).toBeLessThan(sizes.reply.font);
	});

	it("UX-05 opening a thread shows its latest message, and a message link shows that message", async () => {
		const { t } = await start();
		// A thread taller than the window.
		const notice = await postNotice(t.runtime, { body: "A long thread" });
		let after = notice.message.id;
		const ids = [after];
		for (let i = 0; i < 14; i++) {
			const res = await t.client.post<{ message: { id: string } }>(`/threads/${notice.thread.id}/messages`, {
				after,
				body: `Message ${i}\n\n${"A paragraph that takes some room. ".repeat(12)}`,
			});
			expect(res.status).toBe(200);
			after = res.body.message.id;
			ids.push(after);
		}
		const opened = await evaluatePage<{ scrolled: number; top: number; bottom: number; height: number; selected: string }>(`
			location.hash = "#/inbox";
			await until(() => document.querySelector("#inbox-list .item[data-thread='${notice.thread.id}']"));
			document.querySelector("#inbox-list .item[data-thread='${notice.thread.id}']").click();
			await until(() => !document.getElementById("thread").hidden && document.querySelectorAll("#thread-messages [data-testid=message]").length === ${ids.length});
			await sleep(200);
			const last = [...document.querySelectorAll("#thread-messages [data-testid=message]")].at(-1);
			const box = last.getBoundingClientRect();
			return { scrolled: scrollY, top: box.top, bottom: box.bottom, height: innerHeight, selected: window.__pana.state.selected?.id };
		`);
		expect(opened.scrolled).toBeGreaterThan(0);
		expect(opened.top).toBeGreaterThanOrEqual(0);
		expect(opened.top).toBeLessThan(opened.height);
		expect(opened.selected).toBe(ids.at(-1));

		const linked = await evaluatePage<{ top: number; bottom: number; height: number; focus: string | undefined }>(`
			location.hash = "#/threads/${notice.thread.id}?message=${ids[2]}";
			await until(() => document.querySelector("#thread-messages [data-testid=message].focus")?.dataset.id === "${ids[2]}");
			await sleep(200);
			const box = document.querySelector("#thread-messages [data-testid=message].focus").getBoundingClientRect();
			return { top: box.top, bottom: box.bottom, height: innerHeight, focus: document.querySelector("#thread-messages .focus")?.dataset.id };
		`);
		expect(linked.focus).toBe(ids[2]);
		expect(linked.top).toBeGreaterThanOrEqual(0);
		expect(linked.bottom).toBeLessThanOrEqual(linked.height + 1);
	});

	it("UX-06 each participant's messages carry that participant's palette color in every thread", async () => {
		const { t } = await start();
		const colors = async (threadId: string, count: number) =>
			evaluatePage<Array<{ sender: string; color: string; name: string }>>(`
				location.hash = "#/threads/${threadId}";
				await until(() => window.__pana.state.threadId === "${threadId}" && document.querySelectorAll("#thread-messages [data-testid=message]").length === ${count});
				return [...document.querySelectorAll("#thread-messages [data-testid=message]")].map((el) => ({
					sender: el.dataset.sender,
					color: getComputedStyle(el).borderLeftColor,
					name: el.dataset.color,
				}));
			`);
		const group = await colors(seeded!.group.threadId, seeded!.group.messageIds.length);
		const capital = await colors(seeded!.capital.threadId, seeded!.capital.messageIds.length);
		const palette = new Set(Object.values(PALETTE).map(rgb));
		const bySender = new Map<string, string>();
		for (const message of [...group, ...capital]) {
			expect(palette.has(message.color), `${message.sender} ${message.color}`).toBe(true);
			const seen = bySender.get(message.sender);
			if (seen) expect(message.color, message.sender).toBe(seen);
			bySender.set(message.sender, message.color);
		}
		expect(bySender.get(t.runtime.userUrl)).toBe(rgb(PALETTE.blue));
		const [sessionA, sessionB] = seeded!.group.sessionUrls;
		expect(bySender.get(sessionA!)).toBeDefined();
		expect(bySender.get(sessionB!)).toBeDefined();
		expect(bySender.get(sessionA!)).not.toBe(rgb(PALETTE.blue));
		// The participant list and the inbox use the same colors.
		const marks = await evaluatePage<Record<string, string>>(`
			const out = {};
			for (const person of document.querySelectorAll("#thread-participants .person")) {
				out[person.querySelector("a").title] = getComputedStyle(person, "::before").backgroundColor;
			}
			return out;
		`);
		expect(marks[t.runtime.userUrl]).toBe(rgb(PALETTE.blue));
		expect(marks[sessionA!]).toBe(bySender.get(sessionA!));
	});

	it("UX-07 labels and controls align, spacing follows one scale, and controls sit inside their section", async () => {
		await start();
		const layout = await evaluatePage<Record<string, unknown>>(`
			const box = (el) => el.getBoundingClientRect();
			const inside = (inner, outer) => {
				const a = box(inner), b = box(outer);
				return a.left >= b.left - 0.5 && a.right <= b.right + 0.5 && a.top >= b.top - 0.5 && a.bottom <= b.bottom + 0.5;
			};
			const out = { misaligned: [], outside: [], gaps: new Set() };
			const check = (name, inner, outer) => { if (!inner || !outer || !inside(inner, outer)) out.outside.push(name); };
			const fields = async (hash, ready) => {
				location.hash = hash;
				await until(ready);
				for (const field of document.querySelectorAll(".view:not([hidden]) .field")) {
					if (field.offsetParent === null) continue;
					const label = field.querySelector("label"), control = field.querySelector("input, textarea, select");
					if (Math.abs(box(label).left - box(control).left) > 0.5) out.misaligned.push(hash + " " + control.id);
				}
				for (const el of document.querySelectorAll(".view:not([hidden]) form, .view:not([hidden]) .field, .view:not([hidden]) .form-actions, .view:not([hidden]) .view-header, .view:not([hidden]) .item, .view:not([hidden]) .messages, .view:not([hidden]) .list")) {
					if (el.offsetParent === null) continue;
					const style = getComputedStyle(el);
					for (const gap of [style.rowGap, style.columnGap]) if (gap && gap !== "normal") out.gaps.add(gap);
				}
				for (const form of document.querySelectorAll(".view:not([hidden]) form.panel")) {
					if (form.offsetParent === null) continue;
					for (const control of form.querySelectorAll("input, textarea, select, button")) if (control.offsetParent !== null) check(hash + " " + (control.id || control.textContent), control, form);
				}
			};
			await fields("#/compose", () => !document.getElementById("view-compose").hidden);
			await fields("#/schedules", () => document.querySelectorAll("#schedules-list .item").length >= 2);
			for (const row of document.querySelectorAll("#schedules-list .item")) for (const button of row.querySelectorAll("button")) check("schedule " + button.textContent, button, row);
			await fields("#/threads/${seeded!.group.threadId}", () => document.querySelectorAll("#thread-messages [data-testid=message]").length >= 6);
			check("thread archive", document.getElementById("thread-archive"), document.querySelector("#thread .thread-header"));
			check("reply send", document.querySelector("[data-testid=reply-send]"), document.getElementById("reply-form"));
			for (const message of document.querySelectorAll("#thread-messages [data-testid=message]")) for (const button of message.querySelectorAll("button")) check("message " + button.textContent, button, message);
			document.querySelector("#thread-messages [data-testid=message-edit]").click();
			await until(() => !document.getElementById("confirm").hidden);
			check("confirm in its message", document.getElementById("confirm"), document.getElementById("confirm").closest("[data-testid=message]") ?? document.body.appendChild(document.createElement("i")));
			check("confirm save", document.getElementById("confirm-yes"), document.getElementById("confirm"));
			document.getElementById("confirm-no").click();
			out.searchHidden = document.getElementById("threads-search").offsetParent === null;
			await fields("#/memory", () => document.querySelectorAll("#memory-files .item").length >= 1);
			document.querySelector("#memory-files .item").click();
			await until(() => !document.getElementById("memory-open").hidden);
			check("memory save", document.getElementById("memory-save"), document.getElementById("memory-open"));
			check("memory editor", document.getElementById("memory-edit"), document.getElementById("memory-open"));
			await fields("#/inbox", () => document.querySelectorAll("#inbox-list .item").length >= 3);
			for (const row of document.querySelectorAll("#inbox-list .item")) for (const button of row.querySelectorAll("button")) check("inbox " + button.textContent, button, row);
			await fields("#/threads", () => document.querySelectorAll("#threads-list .item").length >= 3);
			const search = document.getElementById("threads-query"), go = document.querySelector("#threads-search button");
			out.searchCenter = Math.abs((box(search).top + box(search).bottom) / 2 - (box(go).top + box(go).bottom) / 2);
			out.searchHeights = [box(search).height, box(go).height];
			out.gaps = [...out.gaps];
			return out;
		`);
		expect(layout.misaligned).toEqual([]);
		expect(layout.outside).toEqual([]);
		expect(layout.searchHidden).toBe(true);
		expect(layout.searchCenter as number).toBeLessThan(1);
		const [inputHeight, buttonHeight] = layout.searchHeights as number[];
		expect(Math.abs(inputHeight! - buttonHeight!)).toBeLessThan(1);
		// Every flex and grid gap in the views comes from the --s1..--s6 scale (16px root).
		for (const gap of layout.gaps as string[]) expect(["2px", "4px", "8px", "12px", "16px", "24px"], gap).toContain(gap);
	});

	it("UX-08 vim-like keys select, open, navigate, search, reply, archive, go back, and show help", async () => {
		const { t } = await start();
		const inbox = await evaluatePage<{ first?: string; second?: string; back?: string; hash: string }>(`
			${KEYS}
			document.activeElement?.blur();
			await press("j");
			const first = selectedThread();
			await press("j");
			const second = selectedThread();
			await press("k");
			const back = selectedThread();
			return { first, second, back, hash: location.hash };
		`);
		const rows = (await t.client.get<{ threads: Array<{ threadId: string }> }>("/inbox?view=threads")).body.threads.map((row) => row.threadId);
		expect([inbox.first, inbox.second, inbox.back]).toEqual([rows[0], rows[1], rows[0]]);

		const opened = await evaluatePage<{ hash: string; selected?: string; afterK?: string; reply: boolean; typed: string; left: boolean }>(`
			${KEYS}
			await press("j");
			const thread = selectedThread();
			await press("Enter");
			await until(() => location.hash === "#/threads/" + thread && !document.getElementById("thread").hidden);
			await until(() => window.__pana.state.selected?.testid === "message");
			const selected = window.__pana.state.selected?.id;
			await press("k");
			const afterK = window.__pana.state.selected?.id;
			await press("r");
			const reply = document.activeElement === document.getElementById("reply-body");
			// Letters typed in the reply box stay letters.
			await press("j");
			const typedSelection = window.__pana.state.selected?.id;
			await press("Escape");
			const left = document.activeElement !== document.getElementById("reply-body");
			return { hash: location.hash, selected, afterK, reply, typed: typedSelection === afterK ? "kept" : "moved", left };
		`);
		const group = seeded!.group;
		expect(opened.hash).toBe(`#/threads/${rows[1]}`);
		expect(opened.selected).toBeDefined();
		expect(opened.afterK).not.toBe(opened.selected);
		expect(opened.reply).toBe(true);
		expect(opened.typed).toBe("kept");
		expect(opened.left).toBe(true);

		const back = await evaluatePage<{ afterU: string; afterGo: string[]; search: boolean }>(`
			${KEYS}
			await press("u");
			await until(() => location.hash === "#/inbox" && !document.getElementById("view-inbox").hidden);
			const afterU = location.hash;
			const afterGo = [];
			for (const key of ["t", "s", "m", "c", "h", "i"]) {
				document.activeElement?.blur();
				await press("g");
				await press(key);
				afterGo.push(location.hash);
				await sleep(80);
			}
			document.activeElement?.blur();
			await press("g"); await press("t");
			await until(() => !document.getElementById("view-threads").hidden);
			await press("/");
			const search = document.activeElement === document.getElementById("threads-query");
			await press("Escape");
			return { afterU, afterGo, search };
		`);
		expect(back.afterU).toBe("#/inbox");
		expect(back.afterGo).toEqual(["#/threads", "#/sessions", "#/memory", "#/compose", "#/schedules", "#/inbox"]);
		expect(back.search).toBe(true);

		// e archives the open thread, and the selected one in a list.
		await evaluatePage(`
			${KEYS}
			location.hash = "#/threads/${group.threadId}";
			await until(() => window.__pana.state.threadId === "${group.threadId}" && !document.getElementById("thread").hidden);
			document.activeElement?.blur();
			await press("e");
			await until(() => document.getElementById("thread-archive").dataset.archived === "true");
			return true;
		`);
		expect((await t.client.get<{ archived: boolean }>(`/threads/${group.threadId}`)).body.archived).toBe(true);
		const listArchived = await evaluatePage<string | undefined>(`
			${KEYS}
			location.hash = "#/inbox";
			await until(() => document.querySelectorAll("#inbox-list .item").length >= 2 && !document.querySelector("#inbox-list .item[data-thread='${group.threadId}']"));
			document.activeElement?.blur();
			await press("j");
			const thread = selectedThread();
			await press("e");
			await until(() => !document.querySelector("#inbox-list .item[data-thread='" + thread + "']"));
			return thread;
		`);
		expect((await t.client.get<{ archived: boolean }>(`/threads/${listArchived}`)).body.archived).toBe(true);

		// ? shows exactly the keymap; Esc hides it.
		const help = await evaluatePage<{ shown: boolean; actions: string[]; hidden: boolean }>(`
			${KEYS}
			document.activeElement?.blur();
			await press("?");
			await until(() => !document.getElementById("help").hidden);
			const actions = [...document.querySelectorAll("#help-keys tr[data-action]")].map((row) => row.dataset.action);
			await press("Escape");
			await until(() => document.getElementById("help").hidden);
			return { shown: true, actions, hidden: document.getElementById("help").hidden };
		`);
		expect(help.actions).toEqual([...KEYMAP, ...INPUT_KEYMAP].map((binding) => binding.action));
		expect(help.hidden).toBe(true);
	});
});
