import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../../src/cli/index.ts";
import { postNotice, readThread } from "../../src/threads/index.ts";
import { publish, subscriberCount } from "../../src/web/events.ts";
import { loopbackOrigin } from "../../src/web/static.ts";
import { startTestPanad, type TestPanad } from "../harness/index.ts";
import { chromeDevtoolsAvailable, closePage, evaluatePage, newPage, resizePage, screenshot } from "./cli.ts";

let t: TestPanad | undefined;
let page: number | undefined;
afterEach(async () => {
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
		const read = await cli(["thread", "read", id]);
		expect(read.thread.participants.find((p: { id: string }) => p.id === user.id).role).toBe("release reviewer");
		await cli(["thread", "role", "clear", id]);
		expect(await evaluatePage(`await until(() => document.querySelector('#thread-participants [data-participant-id="${user.id}"] .participant-role').hidden); return true;`)).toBe(true);
	});

	it("shows plain-text role hints, follows events and reconnects without disturbing a draft", async () => {
		const roles = new Map<string, string>();
		t = await startTestPanad({ handlers: {
			"threads.read": async (ctx) => {
				const body = await readThread(ctx.runtime, ctx.caller, ctx.params.id!);
				return { status: 200, body: { ...body, thread: { ...body.thread, participants: body.thread.participants.map((p) => ({ ...p, role: roles.get(`${body.thread.id}:${p.id}`) ?? "participant" })) } } };
			},
		} });
		const notice = await postNotice(t.runtime, { body: "Release review\nPlease review the release." });
		const id = notice.thread.id;
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
		await evaluatePage(`window.dispatchEvent(new Event("focus")); return true;`);
		const resumed = await evaluatePage<{ text: string; draft: string; focus: boolean; head: boolean }>(`
			await until(() => document.querySelector('#thread-participants [data-participant-id="${participant.id}"] .participant-role').textContent === "coordinator");
			return { text: document.querySelector('#thread-participants [data-participant-id="${participant.id}"] .participant-role').textContent,
				draft: document.getElementById("reply-body").value, focus: document.activeElement === document.getElementById("reply-body"),
				head: window.__originalHead === window.__pana.state.draft.after };
		`);
		expect(resumed).toEqual({ text: "coordinator", draft: "Keep this unsent draft", focus: true, head: true });
		await evaluatePage(`location.reload(); return true;`);
		expect(await evaluatePage(`await until(() => document.querySelector('#thread-participants [data-participant-id="${participant.id}"] .participant-role')?.textContent === "coordinator"); return true;`)).toBe(true);
	});

	it("does not let a stale reconnect read overwrite a newer role event", async () => {
		let role = "initial";
		let hold = false;
		let captured!: () => void;
		const wasCaptured = new Promise<void>((resolve) => { captured = resolve; });
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		t = await startTestPanad({ handlers: {
			"threads.read": async (ctx) => {
				const body = await readThread(ctx.runtime, ctx.caller, ctx.params.id!);
				const snapshot = role;
				if (hold) { hold = false; captured(); await gate; }
				return { status: 200, body: { ...body, thread: { ...body.thread, participants: body.thread.participants.map((p) => ({ ...p, role: snapshot })) } } };
			},
		} });
		const notice = await postNotice(t.runtime, { body: "Race test" });
		const id = notice.thread.id;
		const read = await t.client.get<{ thread: { participants: Array<{ id: string }> } }>(`/threads/${id}`);
		const participantId = read.body.thread.participants[0]!.id;
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
		// Wait for the held response to finish, then verify it did not revert the event.
		await evaluatePage(`await until(() => performance.getEntriesByType("resource").filter((entry) => entry.name.endsWith("/threads/${id}") && entry.responseEnd > 0).length >= 2); return true;`);
		expect(await evaluatePage(`return { role: document.querySelector('#thread-participants [data-participant-id="${participantId}"] .participant-role').textContent, draft: document.getElementById("reply-body").value };`)).toEqual({ role: "newer", draft: "draft" });
	});

});
