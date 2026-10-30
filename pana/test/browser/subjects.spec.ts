import { afterEach, describe, expect, it } from "vitest";
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
