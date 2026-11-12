import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../../src/cli/index.ts";
import type { Handlers, RequestContext } from "../../src/api/types.ts";
import { postNotice, readThread } from "../../src/threads/index.ts";
import { publish, subscriberCount } from "../../src/web/events.ts";
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

});
