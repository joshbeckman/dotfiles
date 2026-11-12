import { afterEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { awaitSubjectJobs, scheduleSubject } from "../../src/search/index.ts";
import { postNotice } from "../../src/threads/index.ts";
import { subscriberCount } from "../../src/web/events.ts";
import { loopbackOrigin } from "../../src/web/static.ts";
import { startTestPanad, type TestPanad } from "../harness/index.ts";
import { chromeDevtoolsAvailable, closePage, evaluatePage, newPage, resizePage } from "./cli.ts";

let t: TestPanad | undefined;
let page: number | undefined;
afterEach(async () => {
	if (page !== undefined) await closePage(page);
	page = undefined;
	await t?.close();
	t = undefined;
});

(chromeDevtoolsAvailable() ? describe : describe.skip)("live thread subjects", () => {
	it("SUB-04 a delayed regeneration response cannot replace a newer live subject", async () => {
		t = await startTestPanad({ config: { subjectModel: "faux/faux-1" }, script: [
			{ text: "Older title" }, { text: "Newer title" },
		] });
		const notice = await postNotice(t.runtime, { body: "Initial subject" });
		const id = notice.thread.id;
		page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);
		await evaluatePage(`
			location.hash = "#/threads/${id}";
			await until(() => document.getElementById("thread-subject").textContent === "Initial subject");
			const original = window.fetch;
			let held = false;
			window.__releaseSubjectResponse = null;
			window.fetch = async (path, options) => {
				const response = await original(path, options);
				if (!held && path === "/threads/${id}/subject" && options?.method === "POST") {
					held = true;
					await new Promise(resolve => { window.__releaseSubjectResponse = resolve; });
				}
				return response;
			};
			document.getElementById("thread-subject-regenerate").click();
			await until(() => window.__releaseSubjectResponse !== null);
			await until(() => document.getElementById("thread-subject").textContent === "Older title");
			return true;
		`);
		const newer = await t.client.post<{ applied: boolean }>(`/threads/${id}/subject`, { regenerate: true });
		expect(newer.status).toBe(200);
		expect(newer.body.applied).toBe(true);
		expect(await evaluatePage(`
			await until(() => document.getElementById("thread-subject").textContent === "Newer title");
			window.__releaseSubjectResponse();
			await until(() => !document.getElementById("thread-subject-regenerate").disabled);
			return document.getElementById("thread-subject").textContent;
		`)).toBe("Newer title");
	});

	it("SUB-04 a newer response refreshes the subject after an older event and a lost stream", async () => {
		t = await startTestPanad({ config: { subjectModel: "faux/faux-1" } });
		const panad = t;
		const notice = await postNotice(panad.runtime, { body: "Initial subject" });
		const id = notice.thread.id;
		let startOlder!: () => void;
		let startNewer!: () => void;
		let finishOlder!: (value: ReturnType<typeof fauxAssistantMessage>) => void;
		let finishNewer!: (value: ReturnType<typeof fauxAssistantMessage>) => void;
		const olderStarted = new Promise<void>((resolve) => { startOlder = resolve; });
		const newerStarted = new Promise<void>((resolve) => { startNewer = resolve; });
		const olderResult = new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => { finishOlder = resolve; });
		const newerResult = new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => { finishNewer = resolve; });
		let calls = 0;
		const spy = vi.spyOn(panad.runtime.models, "completeSimple").mockImplementation(() => {
			if (calls++ === 0) { startOlder(); return olderResult; }
			startNewer(); return newerResult;
		});
		try {
			page = await newPage(`${loopbackOrigin(panad.panad.tcpPort!)}/#${panad.panad.webToken}`);
			await evaluatePage(`
				location.hash = "#/threads/${id}";
				await until(() => document.getElementById("thread-subject").textContent === "Initial subject");
				return true;
			`);
			const older = panad.client.post(`/threads/${id}/subject`, { regenerate: true });
			await olderStarted;
			await evaluatePage(`document.getElementById("thread-subject-regenerate").click(); return true;`);
			await newerStarted;
			finishOlder(fauxAssistantMessage([fauxText("Older title")]));
			expect((await older).status).toBe(200);
			await evaluatePage(`
				await until(() => document.getElementById("thread-subject").textContent === "Older title");
				window.dispatchEvent(new Event("pagehide"));
				return true;
			`);
			finishNewer(fauxAssistantMessage([fauxText("Newer title")]));
			expect(await evaluatePage(`
				await until(() => !document.getElementById("thread-subject-regenerate").disabled);
				return document.getElementById("thread-subject").textContent;
			`)).toBe("Newer title");
		} finally {
			finishOlder(fauxAssistantMessage([fauxText("Unused")]));
			finishNewer(fauxAssistantMessage([fauxText("Unused")]));
			spy.mockRestore();
		}
	});

	it("SUB-04 a same-thread refresh during regeneration reconciles the subject without live events", async () => {
		t = await startTestPanad({ config: { subjectModel: "faux/faux-1" }, script: [{ text: "Newer title" }] });
		const panad = t;
		const notice = await postNotice(panad.runtime, { body: "Initial subject" });
		const id = notice.thread.id;
		const release = panad.model.gate();
		let began!: () => void;
		const started = new Promise<void>((resolve) => { began = resolve; });
		const original = panad.runtime.models.completeSimple.bind(panad.runtime.models);
		const spy = vi.spyOn(panad.runtime.models, "completeSimple").mockImplementation((...args) => { began(); return original(...args); });
		try {
			page = await newPage(`${loopbackOrigin(panad.panad.tcpPort!)}/#${panad.panad.webToken}`);
			await evaluatePage(`
				location.hash = "#/threads/${id}";
				await until(() => document.getElementById("thread-subject").textContent === "Initial subject");
				window.__originalMessage = document.querySelector("#thread-messages [data-testid=message]");
				document.getElementById("thread-subject-regenerate").click();
				return true;
			`);
			await started;
			await evaluatePage(`
				window.dispatchEvent(new Event("pagehide"));
				location.hash = "#/threads";
				await until(() => !document.getElementById("threads-list").hidden && document.querySelector('#threads-list [data-thread="${id}"]'));
				location.hash = "#/threads/${id}";
				await until(() => document.querySelector("#thread-messages [data-testid=message]") !== window.__originalMessage && document.getElementById("thread-subject").textContent === "Initial subject");
				return true;
			`);
			release();
			expect(await evaluatePage(`
				await until(() => !document.getElementById("thread-subject-regenerate").disabled);
				return document.getElementById("thread-subject").textContent;
			`)).toBe("Newer title");
		} finally { release(); spy.mockRestore(); }
	});

	it("SUB-04 a failed reconciliation does not report a successful model request as failed", async () => {
		t = await startTestPanad({ config: { subjectModel: "faux/faux-1" }, script: [{ text: "Newer title" }] });
		const panad = t;
		const notice = await postNotice(panad.runtime, { body: "Initial subject" });
		const id = notice.thread.id;
		page = await newPage(`${loopbackOrigin(panad.panad.tcpPort!)}/#${panad.panad.webToken}`);
		const result = await evaluatePage<{ status: string; subject: string }>(`
			location.hash = "#/threads/${id}";
			await until(() => document.getElementById("thread-subject").textContent === "Initial subject");
			const original = window.fetch;
			window.__releaseSubjectResponse = null;
			window.fetch = async (path, options) => {
				if (path === "/threads/${id}/subject" && options?.method === "POST" && options.body === undefined) {
					return new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } });
				}
				const response = await original(path, options);
				if (path === "/threads/${id}/subject" && options?.method === "POST") {
					await new Promise(resolve => { window.__releaseSubjectResponse = resolve; });
				}
				return response;
			};
			document.getElementById("thread-subject-regenerate").click();
			await until(() => window.__releaseSubjectResponse !== null);
			await until(() => document.getElementById("thread-subject").textContent === "Newer title");
			window.__releaseSubjectResponse();
			await until(() => !document.getElementById("thread-subject-regenerate").disabled);
			return { status: document.getElementById("status").textContent, subject: document.getElementById("thread-subject").textContent };
		`);
		expect(result.status).toContain("Subject regenerated, but refresh failed. Reopen the thread to check it.");
		expect(result.subject).toBe("Newer title");
		expect(panad.model.calls()).toBe(1);
	});

	it("SUB-02/SUB-04 update an open thread and loaded list labels without disturbing a draft or list nodes", async () => {
		t = await startTestPanad({ config: { subjectModel: "faux/faux-1" }, script: [
			{ text: "Background subject" }, { text: "Inbox subject" }, { text: "Browse subject" },
		] });
		const notice = await postNotice(t.runtime, { body: "Initial subject\nDetails" });
		const id = notice.thread.id;
		page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);
		await resizePage(1280, 900);
		await evaluatePage(`
			location.hash = "#/threads/${id}";
			await until(() => document.getElementById("thread-subject").textContent === "Initial subject");
			window.__originalMessage = document.querySelector("#thread-messages [data-testid=message]");
			window.__originalDraft = window.__pana.state.draft.after;
			const reply = document.getElementById("reply-body");
			reply.value = "Keep this unsent draft";
			reply.focus(); reply.setSelectionRange(4, 8);
			return true;
		`);
		expect(subscriberCount(t.runtime)).toBeGreaterThan(0);
		scheduleSubject(t.runtime, id);
		await awaitSubjectJobs(t.runtime);
		expect(await evaluatePage(`
			await until(() => document.getElementById("thread-subject").textContent === "Background subject");
			const reply = document.getElementById("reply-body");
			return { text: reply.value, focus: document.activeElement === reply, selection: [reply.selectionStart, reply.selectionEnd],
				sameMessage: window.__originalMessage === document.querySelector("#thread-messages [data-testid=message]"),
				sameHead: window.__originalDraft === window.__pana.state.draft.after };
		`)).toEqual({ text: "Keep this unsent draft", focus: true, selection: [4, 8], sameMessage: true, sameHead: true });

		for (const [route, list, before, subject] of [["inbox", "inbox-list", "Background subject", "Inbox subject"], ["threads", "threads-list", "Inbox subject", "Browse subject"]]) {
			await evaluatePage(`
				const previousRow = document.querySelector('#${list} [data-thread="${id}"]');
				location.hash = "#/${route}";
				await until(() => document.querySelector('#${list} [data-thread="${id}"]') !== previousRow && document.querySelector('#${list} [data-thread="${id}"] .thread-subject-label')?.textContent === "${before}");
				window.__originalRow = document.querySelector('#${list} [data-thread="${id}"]');
				window.__originalMark = window.__originalRow.querySelector(".working-mark");
				return true;
			`);
			// An API caller stands in for regeneration in another window.
			const result = await t.client.post(`/threads/${id}/subject`, { regenerate: true });
			expect(result.status).toBe(200);
			expect(await evaluatePage(`
				await until(() => window.__originalRow.querySelector(".thread-subject-label").textContent === "${subject}");
				return window.__originalRow === document.querySelector('#${list} [data-thread="${id}"]') &&
					window.__originalMark === window.__originalRow.querySelector(".working-mark");
			`)).toBe(true);
		}
	});
});
