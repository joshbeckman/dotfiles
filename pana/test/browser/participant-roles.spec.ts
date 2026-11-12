import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../../src/cli/index.ts";
import type { Handlers, RequestContext } from "../../src/api/types.ts";
import { postNotice, readThread } from "../../src/threads/index.ts";
import { publish, subscriberCount } from "../../src/web/events.ts";
import { handlers as webHandlers } from "../../src/web/handlers.ts";
import { loopbackOrigin } from "../../src/web/static.ts";
import { startTestPanad, type TestPanad } from "../harness/index.ts";
import { chromeDevtoolsAvailable, closePage, evaluatePage, newPage, resizePage, screenshot } from "./cli.ts";

let t: TestPanad | undefined;
let page: number | undefined;
let releaseHeld: (() => void) | undefined;
afterEach(async () => {
	releaseHeld?.();
	releaseHeld = undefined;
	if (page !== undefined) await closePage(page);
	page = undefined;
	await t?.close();
	t = undefined;
});

(chromeDevtoolsAvailable() ? describe : describe.skip)("thread participant roles", () => {
	it("updates the open thread from the real CLI and backend", async () => {
		t = await startTestPanad();
		const notice = await postNotice(t.runtime, { body: "Role integration test" });
		const id = notice.thread.id;
		const user = notice.thread.participants.find((p) => p.kind === "user")!;
		page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);
		await evaluatePage(`location.hash = "#/threads/${id}"; await until(() => document.querySelector('#thread-participants [data-participant-id="${user.id}"] .participant-role')); return true;`);
		const shotDir = process.env.PANA_ROLE_SHOTS_DIR;
		if (shotDir) { mkdirSync(shotDir, { recursive: true }); copyFileSync(await screenshot(), join(shotDir, "default.png")); }
		const cli = async (args: string[]) => {
			let stdout = "", stderr = "";
			const code = await main(["--json", ...args], {
				env: { PANA_STATE: t!.dir }, stdout: { write: (chunk) => { stdout += chunk; } },
				stderr: { write: (chunk) => { stderr += chunk; } },
			});
			expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
			return JSON.parse(stdout);
		};
		await cli(["thread", "role", "set", id, "release reviewer"]);
		expect(await evaluatePage(`await until(() => document.querySelector('#thread-participants [data-participant-id="${user.id}"] .participant-role').textContent === "release reviewer"); return true;`)).toBe(true);
		if (shotDir) copyFileSync(await screenshot(), join(shotDir, "reviewer.png"));
		const read = await cli(["thread", "read", id]);
		expect(read.thread.participants.find((p: { id: string }) => p.id === user.id).role).toBe("release reviewer");
		await cli(["thread", "role", "clear", id]);
		expect(await evaluatePage(`await until(() => document.querySelector('#thread-participants [data-participant-id="${user.id}"] .participant-role').hidden); return true;`)).toBe(true);
	});

	it("shows plain-text role hints, follows events and reconnects without disturbing a draft", async () => {
		const roles = new Map<string, string>();
		let participants: Array<{ id: string; kind: string; url: string }> = [];
		t = await startTestPanad({ handlers: {
			"threads.read": async (ctx: RequestContext) => {
				const body = await readThread(ctx.runtime, ctx.caller, ctx.params.id!);
				return { status: 200, body: { ...body, thread: { ...body.thread, participants: body.thread.participants.map((p) => ({ ...p, role: roles.get(`${body.thread.id}:${p.id}`) ?? "participant" })) } } };
			},
			"threads.participants": async (ctx: RequestContext) => ({ status: 200, body: { participants: participants.map((p) => ({ ...p, role: roles.get(`${ctx.params.id}:${p.id}`) ?? "participant" })) } }),
		} as Handlers });
		const notice = await postNotice(t.runtime, { body: "Release review\nPlease review the release." });
		const id = notice.thread.id;
		participants = notice.thread.participants;
		const read = await t.client.get<{ thread: { participants: Array<{ id: string; kind: string }> } }>(`/threads/${id}`);
		const participant = read.body.thread.participants.find((p) => p.kind === "user")!;
		const key = `${id}:${participant.id}`;
		roles.set(key, "reviewer");
		page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);
		await resizePage(390, 844);
		const initial = await evaluatePage<{ role: string; hidden: number; overflow: boolean }>(`
			location.hash = "#/threads/${id}";
			await until(() => document.querySelector('#thread-participants [data-participant-id="${participant.id}"] .participant-role')?.textContent === "reviewer");
			const reply = document.getElementById("reply-body");
			reply.value = "Keep this unsent draft"; reply.focus(); reply.setSelectionRange(4, 8);
			window.__originalMessage = document.querySelector("#thread-messages [data-testid=message]");
			window.__originalHead = window.__pana.state.draft.after;
			return { role: document.querySelector('#thread-participants [data-participant-id="${participant.id}"] .participant-role').textContent,
				hidden: document.querySelectorAll('#thread-participants .participant-role[hidden]').length,
				overflow: document.documentElement.scrollWidth > innerWidth };
		`);
		expect(initial.role).toBe("reviewer");
		expect(initial.overflow).toBe(false);
		expect(subscriberCount(t.runtime)).toBeGreaterThan(0);
		const shotDir = process.env.PANA_ROLE_SHOTS_DIR;
		if (shotDir) { mkdirSync(shotDir, { recursive: true }); copyFileSync(await screenshot(), join(shotDir, "role-before.png")); }

		const role = '<img src=x onerror="window.__pwned=true">';
		roles.set(key, role);
		await publish(t.runtime, { kind: "thread.role", threadId: id, participantId: participant.id, role });
		const updated = await evaluatePage<{ role: string; html: number; pwned: boolean; draft: string; focus: boolean; selection: number[]; sameMessage: boolean; sameHead: boolean; overflow: boolean }>(`
			await until(() => document.querySelector('#thread-participants [data-participant-id="${participant.id}"] .participant-role').textContent === ${JSON.stringify(role)});
			const label = document.querySelector('#thread-participants [data-participant-id="${participant.id}"] .participant-role');
			const reply = document.getElementById("reply-body");
			return { role: label.textContent, html: label.children.length, pwned: Boolean(window.__pwned), draft: reply.value,
				focus: document.activeElement === reply, selection: [reply.selectionStart, reply.selectionEnd],
				sameMessage: window.__originalMessage === document.querySelector("#thread-messages [data-testid=message]"),
				sameHead: window.__originalHead === window.__pana.state.draft.after,
				overflow: document.documentElement.scrollWidth > innerWidth };
		`);
		expect(updated).toEqual({ role, html: 0, pwned: false, draft: "Keep this unsent draft", focus: true, selection: [4, 8], sameMessage: true, sameHead: true, overflow: false });
		roles.set(key, "release reviewer");
		await publish(t.runtime, { kind: "thread.role", threadId: id, participantId: participant.id, role: "release reviewer" });
		await evaluatePage(`await until(() => document.querySelector('#thread-participants [data-participant-id="${participant.id}"] .participant-role').textContent === "release reviewer"); return true;`);
		if (shotDir) copyFileSync(await screenshot(), join(shotDir, "role-after.png"));
		await publish(t.runtime, { kind: "thread.role", threadId: "another-thread", participantId: participant.id, role: "wrong thread" });
		expect(await evaluatePage(`return document.querySelector('#thread-participants [data-participant-id="${participant.id}"] .participant-role').textContent;`)).toBe("release reviewer");
		await publish(t.runtime, { kind: "thread.role", threadId: id, participantId: participant.id, role: "participant" });
		expect(await evaluatePage(`await until(() => document.querySelector('#thread-participants [data-participant-id="${participant.id}"] .participant-role').hidden); return true;`)).toBe(true);

		// Miss a role event while the app is suspended, then reconnect with a draft in place.
		await evaluatePage(`window.dispatchEvent(new Event("pagehide")); return true;`);
		roles.set(key, "coordinator");
		const added = { id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", kind: "session", url: "pana://test.example/sessions/01ARZ3NDEKTSV4RRFFQ69G5FAV" };
		const removed = participants.find((person) => person.kind === "domain")!;
		participants = [...participants.filter((person) => person.id !== removed.id), added];
		roles.set(`${id}:${added.id}`, "investigator");
		await postNotice(t.runtime, { thread: id, body: "A delivery while away" });
		expect((await t.client.get<{ unreadTotal: number }>("/inbox?view=threads")).body.unreadTotal).toBe(1);
		await evaluatePage(`window.dispatchEvent(new Event("focus")); return true;`);
		const resumed = await evaluatePage<{ text: string; draft: string; focus: boolean; head: boolean }>(`
			await until(() => document.querySelector('#thread-participants [data-participant-id="${participant.id}"] .participant-role').textContent === "coordinator");
			return { text: document.querySelector('#thread-participants [data-participant-id="${participant.id}"] .participant-role').textContent,
				draft: document.getElementById("reply-body").value, focus: document.activeElement === document.getElementById("reply-body"),
				head: window.__originalHead === window.__pana.state.draft.after };
		`);
		expect(resumed).toEqual({ text: "coordinator", draft: "Keep this unsent draft", focus: true, head: true });
		expect(await evaluatePage(`return { added: document.querySelector('#thread-participants [data-participant-id="${added.id}"] .participant-role')?.textContent, removed: Boolean(document.querySelector('#thread-participants [data-participant-id="${removed.id}"]')) };`)).toEqual({ added: "investigator", removed: false });
		// The participant refresh must not mark the missed delivery read or reopen the draft.
		expect((await t.client.get<{ unreadTotal: number }>("/inbox?view=threads")).body.unreadTotal).toBe(1);
		await evaluatePage(`await until(() => document.getElementById("nav-inbox-count").getAttribute("aria-label") === "1 unread message"); return true;`);
		await evaluatePage(`location.reload(); return true;`);
		expect(await evaluatePage(`await until(() => document.querySelector('#thread-participants [data-participant-id="${participant.id}"] .participant-role')?.textContent === "coordinator"); return true;`)).toBe(true);
	});

	it("does not let a stale reconnect read overwrite a newer role event", async () => {
		let role = "initial";
		let otherId = "";
		let participants: Array<{ id: string; kind: string; url: string }> = [];
		let hold = false;
		let captured!: () => void;
		const wasCaptured = new Promise<void>((resolve) => { captured = resolve; });
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		releaseHeld = release;
		t = await startTestPanad({ handlers: {
			"threads.read": async (ctx: RequestContext) => {
				const body = await readThread(ctx.runtime, ctx.caller, ctx.params.id!);
				return { status: 200, body: { ...body, thread: { ...body.thread, participants: body.thread.participants.map((p) => ({ ...p, role })) } } };
			},
			"threads.participants": async () => {
				const snapshot = participants.map((p) => ({ ...p, role: hold && p.id === otherId ? "held-response-applied" : role }));
				if (hold) { hold = false; captured(); await gate; }
				return { status: 200, body: { participants: snapshot } };
			},
		} as Handlers });
		const notice = await postNotice(t.runtime, { body: "Race test" });
		const id = notice.thread.id;
		participants = notice.thread.participants;
		const read = await t.client.get<{ thread: { participants: Array<{ id: string }> } }>(`/threads/${id}`);
		const participantId = read.body.thread.participants[0]!.id;
		otherId = read.body.thread.participants[1]!.id;
		page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);
		await evaluatePage(`location.hash = "#/threads/${id}"; await until(() => document.querySelector('#thread-participants [data-participant-id="${participantId}"] .participant-role')?.textContent === "initial");
			document.getElementById("reply-body").value = "draft"; window.dispatchEvent(new Event("pagehide")); return true;`);
		hold = true;
		await evaluatePage(`window.dispatchEvent(new Event("focus")); return true;`);
		await wasCaptured;
		role = "newer";
		await publish(t.runtime, { kind: "thread.role", threadId: id, participantId, role });
		await evaluatePage(`await until(() => document.querySelector('#thread-participants [data-participant-id="${participantId}"] .participant-role').textContent === "newer"); return true;`);
		release();
		// This value occurs only in the held snapshot, so observing it proves the response was
		// applied, not merely that an earlier participant request finished.
		await evaluatePage(`await until(() => document.querySelector('#thread-participants [data-participant-id="${otherId}"] .participant-role')?.textContent === "held-response-applied"); return true;`);
		expect(await evaluatePage(`return { role: document.querySelector('#thread-participants [data-participant-id="${participantId}"] .participant-role').textContent, draft: document.getElementById("reply-body").value };`)).toEqual({ role: "newer", draft: "draft" });
	});


	it("reconciles a new participant and role when reconnect overlaps the initial thread read", async () => {
		let participants: Array<{ id: string; kind: string; url: string; role?: string }> = [];
		let captured!: () => void;
		const wasCaptured = new Promise<void>((resolve) => { captured = resolve; });
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		let reads = 0;
		t = await startTestPanad({ handlers: {
			"threads.read": async (ctx: RequestContext) => {
				reads++;
				const body = await readThread(ctx.runtime, ctx.caller, ctx.params.id!);
				const snapshot = { ...body, thread: { ...body.thread, participants: body.thread.participants.map((p) => ({ ...p, role: "participant" })) } };
				captured();
				await gate;
				return { status: 200, body: snapshot };
			},
			"threads.participants": async () => ({ status: 200, body: { participants } }),
		} as Handlers });
		const notice = await postNotice(t.runtime, { body: "Held initial read" });
		const id = notice.thread.id;
		const user = notice.thread.participants.find((person) => person.kind === "user")!;
		const removed = notice.thread.participants.find((person) => person.kind === "domain")!;
		const added = { id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", kind: "session", url: "pana://test.example/sessions/01ARZ3NDEKTSV4RRFFQ69G5FAV", role: "investigator" };
		participants = [...notice.thread.participants.map((person) => ({ ...person, role: "participant" }))];
		page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);
		await evaluatePage(`await until(() => window.__pana?.state.domain); location.hash = "#/threads/${id}"; return true;`);
		await wasCaptured;
		// Mark a node through the live stream. Blue after focus proves the new stream's hello was
		// processed before the held response is released (and therefore before its roster reread).
		await evaluatePage(`const marker = document.createElement("span"); marker.id = "role-test-marker"; marker.dataset.userColor = "true"; document.body.append(marker); return true;`);
		await publish(t.runtime, { kind: "settings.ui", userColor: "purple" });
		await evaluatePage(`await until(() => document.getElementById("role-test-marker").dataset.color === "purple"); window.dispatchEvent(new Event("pagehide")); return true;`);
		participants = [{ ...user, role: "participant" }, added];
		await postNotice(t.runtime, { thread: id, body: "Unread during held read" });
		expect((await t.client.get<{ unreadTotal: number }>("/inbox?view=threads")).body.unreadTotal).toBe(1);
		await evaluatePage(`window.dispatchEvent(new Event("focus")); await until(() => document.getElementById("role-test-marker").dataset.color === "blue"); return true;`);
		release();
		const roster = await evaluatePage<{ role: string; removed: boolean; head: string }>(`
			await until(() => document.querySelector('#thread-participants [data-participant-id="${added.id}"] .participant-role')?.textContent === "investigator");
			return { role: document.querySelector('#thread-participants [data-participant-id="${added.id}"] .participant-role').textContent,
				removed: Boolean(document.querySelector('#thread-participants [data-participant-id="${removed.id}"]')),
				head: document.getElementById("draft-head").textContent };
		`);
		expect(roster).toEqual({ role: "investigator", removed: false, head: notice.message.id });
		expect(reads).toBe(1);
		expect((await t.client.get<{ unreadTotal: number }>("/inbox?view=threads")).body.unreadTotal).toBe(1);
	});


	it("reconciles live joins, session events and message identities without touching a draft", async () => {
		type Person = { id: string; kind: string; url: string; role?: string; state?: string; activity?: { activity: string; at: number }; wake?: { at: number; url: string; subject: string; cron: null } };
		let roster: Person[] = [];
		let hold = false;
		let heldCount = 0;
		let firstCaptured!: () => void;
		const first = new Promise<void>((resolve) => { firstCaptured = resolve; });
		let secondCaptured!: () => void;
		const second = new Promise<void>((resolve) => { secondCaptured = resolve; });
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		releaseHeld = release;
		t = await startTestPanad({ config: { defaultModel: "faux/faux-1" }, script: [{ text: "done" }, { text: "done" }], handlers: {
			"threads.read": async (ctx: RequestContext) => {
				const body = await readThread(ctx.runtime, ctx.caller, ctx.params.id!);
				return { status: 200, body: { ...body, thread: { ...body.thread, participants: roster.length ? roster : body.thread.participants } } };
			},
			"threads.participants": async () => {
				const snapshot = structuredClone(roster);
				if (hold) { heldCount++; if (heldCount === 1) firstCaptured(); if (heldCount === 2) secondCaptured(); await gate; }
				return { status: 200, body: { participants: snapshot } };
			},
		} as Handlers });
		const a = await t.client.post<{ session: { id: string; url: string } }>("/sessions", { prompt: "first session" });
		const b = await t.client.post<{ session: { id: string; url: string } }>("/sessions", { prompt: "second session" });
		expect(a.status).toBe(201); expect(b.status).toBe(201);
		await t.client.post(`/sessions/${a.body.session.id}/stop`);
		await t.client.post(`/sessions/${b.body.session.id}/stop`);
		const made = await t.client.post<{ thread: { id: string; participants: Person[] }; message: { id: string } }>("/threads", { to: [a.body.session.id, b.body.session.id], body: "Group thread" });
		expect(made.status).toBe(201);
		const id = made.body.thread.id;
		const posted = await t.client.post<{ message: { id: string } }>(`/threads/${id}/messages`, { after: made.body.message.id, body: "second session message" }, { caller: b.body.session.id });
		expect(posted.status).toBe(200);
		const wake = { at: t.clock.now() + 3_600_000, url: "pana://test.example/schedules/01ARZ3NDEKTSV4RRFFQ69G5FAW", subject: "old wake", cron: null };
		roster = made.body.thread.participants.map((p) => ({ ...p, role: "participant", ...(p.id === a.body.session.id ? { state: "running", activity: { activity: "old work", at: t!.clock.now() }, wake } : p.id === b.body.session.id ? { state: "running", activity: { activity: "old second work", at: t!.clock.now() } } : {}) }));
		page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);
		const initial = await evaluatePage<{ color: string; messageColor: string }>(`
			location.hash = "#/threads/${id}";
			await until(() => document.querySelector('#thread-messages [data-id="${posted.body.message.id}"]') && document.querySelector('#thread-working [data-session="${a.body.session.id}"]'));
			const reply = document.getElementById("reply-body"); reply.value = "draft for the old head"; reply.focus(); reply.setSelectionRange(3, 7);
			window.__rosterMessage = document.querySelector('#thread-messages [data-id="${posted.body.message.id}"]');
			window.__rosterHead = window.__pana.state.draft.after;
			return { color: document.querySelector('#thread-participants [data-participant-id="${b.body.session.id}"]').dataset.color, messageColor: window.__rosterMessage.dataset.color };
		`);
		expect(initial.color).toBe(initial.messageColor);
		// A fresh snapshot is authoritative even when an old participant had live fields.
		await evaluatePage(`window.dispatchEvent(new Event("pagehide")); return true;`);
		roster = roster.map((p) => p.id === a.body.session.id ? { id: p.id, kind: p.kind, url: p.url, role: "participant", state: "stopped" } : p.id === b.body.session.id ? { ...p, role: "snapshot-one", activity: { activity: "fresh work", at: t!.clock.now() } } : p);
		await evaluatePage(`window.dispatchEvent(new Event("focus")); await until(() => document.querySelector('#thread-participants [data-participant-id="${b.body.session.id}"] .participant-role')?.textContent === "snapshot-one"); return true;`);
		expect(await evaluatePage(`return { firstWorking: Boolean(document.querySelector('#thread-working [data-testid="working-session"][data-session="${a.body.session.id}"]')), firstWake: Boolean(document.querySelector('#thread-working [data-testid="scheduled-session"][data-session="${a.body.session.id}"]')), secondWorking: Boolean(document.querySelector('#thread-working [data-testid="working-session"][data-session="${b.body.session.id}"]')), activity: document.querySelector('#thread-working [data-testid="working-session"][data-session="${b.body.session.id}"]')?.textContent };`)).toMatchObject({ firstWorking: false, firstWake: false, secondWorking: true, activity: expect.stringContaining("fresh work") });
		// Removing the earlier session shifts the later session's identity. The existing message node
		// must track the header without being replaced (or changing the draft).
		await evaluatePage(`window.dispatchEvent(new Event("pagehide")); return true;`);
		roster = roster.filter((p) => p.id !== a.body.session.id).map((p) => p.id === b.body.session.id ? { ...p, role: "snapshot-two" } : p);
		const recolored = await evaluatePage<{ before: string; header: string; message: string; same: boolean }>(`
			window.dispatchEvent(new Event("focus"));
			await until(() => document.querySelector('#thread-participants [data-participant-id="${b.body.session.id}"] .participant-role')?.textContent === "snapshot-two");
			return { before: ${JSON.stringify(initial.color)}, header: document.querySelector('#thread-participants [data-participant-id="${b.body.session.id}"]').dataset.color,
				message: window.__rosterMessage.dataset.color, same: window.__rosterMessage === document.querySelector('#thread-messages [data-id="${posted.body.message.id}"]') };
		`);
		expect(recolored.same).toBe(true); expect(recolored.header).toBe(recolored.message); expect(recolored.header).not.toBe(recolored.before);
		// An unknown member's role event starts a roster read without reconnecting. Hold both reads
		// so the newer role and state/wake/live events must be replayed over old snapshots.
		const added = { id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", kind: "session", url: "pana://test.example/sessions/01ARZ3NDEKTSV4RRFFQ69G5FAV", role: "snapshot-role", state: "running", activity: { activity: "stale activity", at: t.clock.now() }, wake };
		roster = [...roster, added];
		hold = true;
		await postNotice(t.runtime, { thread: id, body: "unread during draft" });
		expect((await t.client.get<{ threads: Array<{ threadId: string; unreadCount: number }> }>("/inbox?view=threads")).body.threads.find((thread) => thread.threadId === id)?.unreadCount).toBe(1);
		await publish(t.runtime, { kind: "thread.role", threadId: id, participantId: added.id, role: "first role" });
		await first;
		await publish(t.runtime, { kind: "thread.role", threadId: id, participantId: added.id, role: "newest role" });
		await second;
		await publish(t.runtime, { kind: "session.state", sessionId: b.body.session.id, state: "stopped", url: b.body.session.url, threadIds: [id] });
		await publish(t.runtime, { kind: "session.wake", sessionId: added.id, wake: null });
		await publish(t.runtime, { kind: "session.live", sessionId: added.id, live: null });
		// A marker event sent last proves every prior frame was processed before release.
		await evaluatePage(`const marker = document.createElement("span"); marker.id = "roster-event-marker"; marker.dataset.userColor = "true"; document.body.append(marker); return true;`);
		await publish(t.runtime, { kind: "settings.ui", userColor: "purple" });
		await evaluatePage(`await until(() => document.getElementById("roster-event-marker").dataset.color === "purple"); return true;`);
		release();
		const joined = await evaluatePage<{ role: string; newWorking: boolean; oldWorking: boolean; wake: boolean; activity: boolean; draft: string; focus: boolean; selection: number[]; head: boolean }>(`
			await until(() => document.querySelector('#thread-participants [data-participant-id="${added.id}"] .participant-role')?.textContent === "newest role");
			const reply = document.getElementById("reply-body"); const chip = document.querySelector('#thread-working [data-testid="working-session"][data-session="${added.id}"]');
			return { role: document.querySelector('#thread-participants [data-participant-id="${added.id}"] .participant-role').textContent,
				newWorking: Boolean(chip), oldWorking: Boolean(document.querySelector('#thread-working [data-testid="working-session"][data-session="${b.body.session.id}"]')),
				wake: Boolean(document.querySelector('#thread-working [data-testid="scheduled-session"][data-session="${added.id}"]')), activity: Boolean(chip?.querySelector('[data-testid="working-activity"]')),
				draft: reply.value, focus: document.activeElement === reply, selection: [reply.selectionStart, reply.selectionEnd], head: window.__rosterHead === window.__pana.state.draft.after };
		`);
		expect(joined).toEqual({ role: "newest role", newWorking: true, oldWorking: false, wake: false, activity: false, draft: "draft for the old head", focus: true, selection: [3, 7], head: true });
		expect((await t.client.get<{ threads: Array<{ threadId: string; unreadCount: number }> }>("/inbox?view=threads")).body.threads.find((thread) => thread.threadId === id)?.unreadCount).toBe(1);
	});


	it("finds a new member whose role arrives during the initial thread read", async () => {
		let participants: Array<{ id: string; kind: string; url: string; role?: string }> = [];
		let captured!: () => void;
		const wasCaptured = new Promise<void>((resolve) => { captured = resolve; });
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		releaseHeld = release;
		let reads = 0;
		t = await startTestPanad({ handlers: {
			"threads.read": async (ctx: RequestContext) => {
				reads++;
				const body = await readThread(ctx.runtime, ctx.caller, ctx.params.id!);
				captured(); await gate;
				return { status: 200, body };
			},
			"threads.participants": async () => ({ status: 200, body: { participants } }),
		} as Handlers });
		const notice = await postNotice(t.runtime, { body: "Initial read with live join" });
		const id = notice.thread.id;
		participants = notice.thread.participants;
		const added = { id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", kind: "session", url: "pana://test.example/sessions/01ARZ3NDEKTSV4RRFFQ69G5FAV", role: "snapshot role" };
		page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);
		await evaluatePage(`await until(() => window.__pana?.state.domain); location.hash = "#/threads/${id}"; return true;`);
		await wasCaptured;
		participants = [...participants, added];
		await evaluatePage(`const marker = document.createElement("span"); marker.id = "initial-event-marker"; marker.dataset.userColor = "true"; document.body.append(marker); return true;`);
		await publish(t.runtime, { kind: "thread.role", threadId: id, participantId: added.id, role: "newest role" });
		await publish(t.runtime, { kind: "settings.ui", userColor: "purple" });
		await evaluatePage(`await until(() => document.getElementById("initial-event-marker").dataset.color === "purple"); return true;`);
		await postNotice(t.runtime, { thread: id, body: "unread while the initial read is held" });
		release();
		await evaluatePage(`await until(() => document.querySelector('#thread-participants [data-participant-id="${added.id}"] .participant-role')?.textContent === "newest role"); return true;`);
		expect(reads).toBe(1);
		expect((await t.client.get<{ unreadTotal: number }>("/inbox?view=threads")).body.unreadTotal).toBe(1);
	});

	it("keeps a subject event received during an initial roster retry", async () => {
		let participants: Array<{ id: string; kind: string; url: string; role?: string }> = [];
		let capturedThread!: () => void, capturedRoster!: () => void;
		const threadCaptured = new Promise<void>((resolve) => { capturedThread = resolve; });
		const rosterCaptured = new Promise<void>((resolve) => { capturedRoster = resolve; });
		let releaseThread!: () => void, releaseRoster!: () => void;
		const threadGate = new Promise<void>((resolve) => { releaseThread = resolve; });
		const rosterGate = new Promise<void>((resolve) => { releaseRoster = resolve; });
		releaseHeld = () => { releaseThread(); releaseRoster(); };
		let reads = 0;
		t = await startTestPanad({ config: { subjectModel: "faux/faux-1" }, script: [{ text: "New subject" }, { text: "Latest subject" }], handlers: {
			"threads.read": async (ctx: RequestContext) => {
				reads++;
				const body = await readThread(ctx.runtime, ctx.caller, ctx.params.id!);
				capturedThread(); await threadGate;
				return { status: 200, body };
			},
			"threads.participants": async () => {
				const snapshot = structuredClone(participants);
				capturedRoster(); await rosterGate;
				return { status: 200, body: { participants: snapshot } };
			},
		} as Handlers });
		const notice = await postNotice(t.runtime, { body: "Old subject" });
		const id = notice.thread.id;
		const added = { id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", kind: "session", url: "pana://test.example/sessions/01ARZ3NDEKTSV4RRFFQ69G5FAV", role: "snapshot" };
		participants = [...notice.thread.participants, added];
		page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);
		await evaluatePage(`await until(() => window.__pana?.state.domain);
			const original = window.fetch; window.__subjectReads = 0;
			window.fetch = async (path, options) => {
				const response = await original(path, options);
				if (path === "/threads/${id}/subject" && options?.method === "POST" && options.body === undefined) {
					window.__subjectReads++;
					if (window.__subjectReads === 1) await new Promise(resolve => { window.__releaseSubjectRead = resolve; });
				}
				return response;
			};
			location.hash = "#/threads/${id}"; return true;`);
		await threadCaptured;
		await evaluatePage(`const marker = document.createElement("span"); marker.id = "subject-retry-marker"; marker.dataset.userColor = "true"; document.body.append(marker); return true;`);
		await publish(t.runtime, { kind: "thread.role", threadId: id, participantId: added.id, role: "joined" });
		await publish(t.runtime, { kind: "settings.ui", userColor: "purple" });
		await evaluatePage(`await until(() => document.getElementById("subject-retry-marker").dataset.color === "purple"); return true;`);
		releaseThread();
		await rosterCaptured;
		await postNotice(t.runtime, { thread: id, body: "Unread during roster retry" });
		expect((await t.client.post(`/threads/${id}/subject`, { regenerate: true })).status).toBe(200);
		await publish(t.runtime, { kind: "settings.ui", userColor: "blue" });
		await evaluatePage(`await until(() => document.getElementById("subject-retry-marker").dataset.color === "blue"); return true;`);
		releaseRoster();
		await evaluatePage(`await until(() => window.__releaseSubjectRead); return true;`);
		expect((await t.client.post(`/threads/${id}/subject`, { regenerate: true })).status).toBe(200);
		await publish(t.runtime, { kind: "settings.ui", userColor: "purple" });
		await evaluatePage(`await until(() => document.getElementById("subject-retry-marker").dataset.color === "purple"); window.__releaseSubjectRead(); return true;`);
		const result = await evaluatePage<{ subject: string; role: string; head: string; subjectReads: number }>(`
			await until(() => document.querySelector('#thread-participants [data-participant-id="${added.id}"] .participant-role')?.textContent === "joined");
			return { subject: document.getElementById("thread-subject").textContent,
				role: document.querySelector('#thread-participants [data-participant-id="${added.id}"] .participant-role').textContent,
				head: document.getElementById("draft-head").textContent, subjectReads: window.__subjectReads };
		`);
		expect(result).toEqual({ subject: "Latest subject", role: "joined", head: notice.message.id, subjectReads: 2 });
		expect(reads).toBe(1);
		expect((await t.client.get<{ unreadTotal: number }>("/inbox?view=threads")).body.unreadTotal).toBe(1);
	});

	it("does not overlay a pre-disconnect subject on a newer held thread snapshot", async () => {
		let started!: () => void, captured!: () => void;
		const wasStarted = new Promise<void>((resolve) => { started = resolve; });
		const wasCaptured = new Promise<void>((resolve) => { captured = resolve; });
		let takeSnapshot!: () => void, release!: () => void;
		const beforeSnapshot = new Promise<void>((resolve) => { takeSnapshot = resolve; });
		const afterSnapshot = new Promise<void>((resolve) => { release = resolve; });
		releaseHeld = () => { takeSnapshot(); release(); };
		let reads = 0;
		t = await startTestPanad({ config: { subjectModel: "faux/faux-1" }, script: [{ text: "Subject A" }, { text: "Subject B" }], handlers: {
			"threads.read": async (ctx: RequestContext) => {
				reads++; started(); await beforeSnapshot;
				const body = await readThread(ctx.runtime, ctx.caller, ctx.params.id!);
				captured(); await afterSnapshot;
				return { status: 200, body };
			},
		} as Handlers });
		const notice = await postNotice(t.runtime, { body: "Initial subject" });
		const id = notice.thread.id;
		page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);
		await evaluatePage(`await until(() => window.__pana?.state.domain); location.hash = "#/threads/${id}";
			const marker = document.createElement("span"); marker.id = "subject-order-marker"; marker.dataset.userColor = "true"; document.body.append(marker); return true;`);
		await wasStarted;
		expect((await t.client.post(`/threads/${id}/subject`, { regenerate: true })).status).toBe(200);
		await publish(t.runtime, { kind: "settings.ui", userColor: "purple" });
		await evaluatePage(`await until(() => document.getElementById("subject-order-marker").dataset.color === "purple"); window.dispatchEvent(new Event("pagehide")); return true;`);
		expect((await t.client.post(`/threads/${id}/subject`, { regenerate: true })).status).toBe(200);
		takeSnapshot();
		await wasCaptured;
		await postNotice(t.runtime, { thread: id, body: "Unread after snapshot" });
		await evaluatePage(`window.dispatchEvent(new Event("focus")); await until(() => document.getElementById("subject-order-marker").dataset.color === "blue"); return true;`);
		release();
		const subject = await evaluatePage<string>(`await until(() => document.getElementById("draft-head").textContent === "${notice.message.id}"); return document.getElementById("thread-subject").textContent;`);
		expect(subject).toBe("Subject B");
		expect(reads).toBe(1);
		expect((await t.client.get<{ unreadTotal: number }>("/inbox?view=threads")).body.unreadTotal).toBe(1);
	});

	it("reconciles roles and joined participants after a held stale-reply read", async () => {
		let hold = false;
		let captured!: () => void;
		const wasCaptured = new Promise<void>((resolve) => { captured = resolve; });
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		releaseHeld = release;
		t = await startTestPanad({ config: { defaultModel: "faux/faux-1" }, script: [{ text: "Ready." }], handlers: {
			"threads.read": async (ctx: RequestContext) => {
				const body = await readThread(ctx.runtime, ctx.caller, ctx.params.id!);
				if (hold) { hold = false; captured(); await gate; }
				return { status: 200, body };
			},
		} as Handlers });
		const session = await t.client.post<{ session: { id: string; url: string } }>("/sessions", { prompt: "joining session" });
		expect(session.status).toBe(201);
		await t.client.post(`/sessions/${session.body.session.id}/stop`);
		const notice = await postNotice(t.runtime, { body: "Stale reply test" });
		const id = notice.thread.id;
		const user = notice.thread.participants.find((person) => person.kind === "user")!;
		page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);
		await evaluatePage(`location.hash = "#/threads/${id}"; await until(() => document.getElementById("draft-head").textContent === "${notice.message.id}");
			const reply = document.getElementById("reply-body"); reply.value = "keep this draft"; reply.dispatchEvent(new Event("input")); reply.focus(); reply.setSelectionRange(2, 7);
			window.__oldMessage = document.querySelector('#thread-messages [data-testid="message"]'); return true;`);
		const joined = await t.client.post<{ message: { id: string } }>(`/threads/${id}/messages`, { after: notice.message.id, body: "Joining", cc: [session.body.session.id] });
		expect(joined.status).toBe(200);
		hold = true;
		await evaluatePage(`document.getElementById("reply-form").requestSubmit(); return true;`);
		await wasCaptured;
		await publish(t.runtime, { kind: "thread.role", threadId: id, participantId: user.id, role: "reviewer" });
		await evaluatePage(`await until(() => document.querySelector('#thread-participants [data-participant-id="${user.id}"] .participant-role')?.textContent === "reviewer"); return true;`);
		release();
		const result = await evaluatePage<{ role: string; joined: boolean; draft: string; focus: boolean; selection: number[]; head: string; newer: string; sameMessage: boolean }>(`
			await until(() => !document.getElementById("stale").hidden);
			const reply = document.getElementById("reply-body");
			return { role: document.querySelector('#thread-participants [data-participant-id="${user.id}"] .participant-role').textContent,
				joined: Boolean(document.querySelector('#thread-participants [data-participant-id="${session.body.session.id}"]')),
				draft: reply.value, focus: document.activeElement === reply, selection: [reply.selectionStart, reply.selectionEnd],
				head: document.getElementById("draft-head").textContent, newer: document.getElementById("stale-new").textContent,
				sameMessage: window.__oldMessage === document.querySelector('#thread-messages [data-testid="message"]') };
		`);
		expect(result).toMatchObject({ role: "reviewer", joined: true, draft: "keep this draft", focus: true, selection: [2, 7], head: joined.body.message.id, newer: expect.stringContaining("Joining"), sameMessage: true });
	});

	it("keeps detached history colors current and participant focus on roster refresh", async () => {
		type Person = { id: string; kind: string; url: string; role?: string };
		let roster: Person[] = [];
		let targetId = "";
		// A test-only await at the start of renderMessage holds a message after its identity is
		// assigned but before its detached node is inserted. All normal rendering stays unchanged.
		const source = readFileSync(new URL("../../web/render.js", import.meta.url), "utf8");
		const anchor = "export async function renderMessage(target, text, options) {";
		if (!source.includes(anchor)) throw new Error("renderMessage test hook anchor missing");
		const heldRender = source.replace(anchor, `${anchor}\n\tif (globalThis.__testHoldMessage) await globalThis.__testHoldMessage(target, text);`);
		t = await startTestPanad({ config: { defaultModel: "faux/faux-1" }, script: [{ text: "done" }, { text: "done" }], handlers: {
			"web.static": async (ctx: RequestContext) => ctx.params.rest === "render.js"
				? { status: 200, bytes: Buffer.from(heldRender), headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } }
				: webHandlers["web.static"]!(ctx),
			"threads.read": async (ctx: RequestContext) => {
				const body = await readThread(ctx.runtime, ctx.caller, ctx.params.id!);
				return { status: 200, body: ctx.params.id === targetId ? { ...body, thread: { ...body.thread, participants: roster } } : body };
			},
			"threads.participants": async () => ({ status: 200, body: { participants: roster } }),
		} as Handlers });
		const a = await t.client.post<{ session: { id: string; url: string } }>("/sessions", { prompt: "first session" });
		const b = await t.client.post<{ session: { id: string; url: string } }>("/sessions", { prompt: "second session" });
		expect(a.status).toBe(201); expect(b.status).toBe(201);
		await t.client.post(`/sessions/${a.body.session.id}/stop`);
		await t.client.post(`/sessions/${b.body.session.id}/stop`);
		const made = await t.client.post<{ thread: { id: string; participants: Person[] }; message: { id: string } }>("/threads", { to: [a.body.session.id, b.body.session.id], body: "history thread" });
		expect(made.status).toBe(201);
		targetId = made.body.thread.id;
		roster = made.body.thread.participants.map((person) => ({ ...person, role: "participant" }));
		let head = made.body.message.id;
		const ids: string[] = [];
		for (let i = 0; i < 35; i++) {
			const sent = await t.client.post<{ message: { id: string } }>(`/threads/${targetId}/messages`, { after: head, body: `render-marker-${i}` }, { caller: b.body.session.id });
			expect(sent.status).toBe(200); head = sent.body.message.id; ids.push(head);
		}
		page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);
		await evaluatePage(`location.hash = "#/threads/${targetId}"; await until(() => !document.getElementById("thread").hidden && document.querySelector('#thread-messages [data-id="${ids[34]}"]')); return true;`);
		await evaluatePage(`
			window.__testHoldMessage = async (body, text) => {
				if (!text.includes(window.__holdText)) return;
				window.__heldMessage = body.parentElement;
				await new Promise((resolve) => { window.__releaseMessage = resolve; });
			};
			window.__holdText = "render-marker-34";
			return true;
		`);
		// A new delivery refreshes an undrafted open thread without hiding it. The refreshed
		// initial page is held while an unknown member's role causes a separate roster refresh.
		await postNotice(t.runtime, { thread: targetId, body: "Refresh the initial window" });
		await evaluatePage(`await until(() => window.__heldMessage?.dataset.id === "${ids[34]}"); return true;`);
		const initialBefore = await evaluatePage<string>(`return window.__heldMessage.dataset.color;`);
		const added = { id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", kind: "session", url: "pana://test.example/sessions/01ARZ3NDEKTSV4RRFFQ69G5FAV", role: "new participant" };
		roster = [...roster.filter((person) => person.id !== a.body.session.id), added];
		await evaluatePage(`document.querySelector('#thread-participants [data-participant-id="${b.body.session.id}"] a').focus(); return true;`);
		await publish(t.runtime, { kind: "thread.role", threadId: targetId, participantId: added.id, role: added.role });
		const initialFocus = await evaluatePage<{ focused: boolean; headerColor: string; heldColor: string }>(`
			await until(() => document.querySelector('#thread-participants [data-participant-id="${added.id}"] .participant-role')?.textContent === "new participant");
			return { focused: document.activeElement === document.querySelector('#thread-participants [data-participant-id="${b.body.session.id}"] a'),
				headerColor: document.querySelector('#thread-participants [data-participant-id="${b.body.session.id}"]').dataset.color, heldColor: window.__heldMessage.dataset.color };
		`);
		expect(initialFocus.focused).toBe(true); expect(initialFocus.heldColor).toBe(initialBefore); expect(initialFocus.headerColor).not.toBe(initialBefore);
		const inserted = await evaluatePage<{ header: string; message: string }>(`
			window.__releaseMessage();
			await until(() => document.querySelector('#thread-messages [data-id="${ids[34]}"]'));
			return { header: document.querySelector('#thread-participants [data-participant-id="${b.body.session.id}"]').dataset.color,
				message: document.querySelector('#thread-messages [data-id="${ids[34]}"]').dataset.color };
		`);
		expect(inserted.message).toBe(inserted.header);
		await evaluatePage(`document.getElementById("reply-body").value = "keep this draft"; return true;`);
		// Restore the earlier session before the history load, then remove it while the range is
		// held. This exercises detached nodes that were rendered both before and during the hold.
		const originalA = made.body.thread.participants.find((person) => person.id === a.body.session.id)!;
		const beforeB = roster.findIndex((person) => person.id === b.body.session.id);
		roster = [...roster.slice(0, beforeB), { ...originalA, role: "returned" }, ...roster.slice(beforeB)];
		await publish(t.runtime, { kind: "thread.role", threadId: targetId, participantId: originalA.id, role: "returned" });
		await evaluatePage(`await until(() => document.querySelector('#thread-participants [data-participant-id="${a.body.session.id}"] .participant-role')?.textContent === "returned"); return true;`);
		await evaluatePage(`
			window.__heldMessage = undefined; window.__holdText = "render-marker-4";
			document.querySelector('[data-testid="thread-earlier"]').click();
			await until(() => window.__heldMessage?.dataset.id === "${ids[4]}");
			document.querySelector('#thread-participants [data-participant-id="${b.body.session.id}"] a').focus();
			window.dispatchEvent(new Event("pagehide")); return true;
		`);
		const historyBefore = await evaluatePage<string>(`return window.__heldMessage.dataset.color;`);
		roster = roster.filter((person) => person.id !== a.body.session.id).map((person) => person.id === b.body.session.id ? { ...person, role: "history-refresh" } : person);
		const historyFocus = await evaluatePage<{ focused: boolean; color: string; heldColor: string }>(`
			window.dispatchEvent(new Event("focus"));
			await until(() => document.querySelector('#thread-participants [data-participant-id="${b.body.session.id}"] .participant-role')?.textContent === "history-refresh" && !document.querySelector('#thread-participants [data-participant-id="${a.body.session.id}"]'));
			return { focused: document.activeElement === document.querySelector('#thread-participants [data-participant-id="${b.body.session.id}"] a'),
				color: document.querySelector('#thread-participants [data-participant-id="${b.body.session.id}"]').dataset.color, heldColor: window.__heldMessage.dataset.color };
		`);
		expect(historyFocus.focused).toBe(true); expect(historyFocus.heldColor).toBe(historyBefore); expect(historyFocus.color).not.toBe(historyBefore);
		const history = await evaluatePage<{ held: string; alreadyRendered: string; header: string; focused: boolean }>(`
			window.__releaseMessage();
			await until(() => document.querySelector('#thread-messages [data-id="${ids[4]}"]'));
			return { held: document.querySelector('#thread-messages [data-id="${ids[4]}"]').dataset.color,
				alreadyRendered: document.querySelector('#thread-messages [data-id="${ids[0]}"]').dataset.color,
				header: document.querySelector('#thread-participants [data-participant-id="${b.body.session.id}"]').dataset.color,
				focused: document.activeElement === document.querySelector('#thread-participants [data-participant-id="${b.body.session.id}"] a') };
		`);
		expect(history).toEqual({ held: historyFocus.color, alreadyRendered: historyFocus.color, header: historyFocus.color, focused: true });
	});

});
