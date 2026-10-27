import { afterEach, describe, expect, it } from "vitest";
import { loopbackOrigin } from "../../src/web/static.ts";
import { startTestPanad, type TestPanad } from "../harness/index.ts";
import { chromeDevtoolsAvailable, closePage, evaluatePage, newPage } from "./cli.ts";

const describeBrowser = chromeDevtoolsAvailable() ? describe : describe.skip;
let t: TestPanad | undefined;
let page: number | undefined;
afterEach(async () => {
	if (page !== undefined) await closePage(page);
	page = undefined;
	await t?.close();
	t = undefined;
});

type Schedule = { id: string; subject: string; payload: { body?: string; prompt?: string; subject?: string; to?: string[] } };
describeBrowser("schedule subjects", () => {
	it("SCH-18 shows concise schedule subjects with full instructions in a disclosure and creates and edits optional labels", async () => {
		t = await startTestPanad({ script: [{ text: "Ready to check later." }], config: { defaultModel: "faux/faux-1", timezone: "UTC" } });
		const body = "Read the project notes.\n\n" + "Keep this complete instruction text available. ".repeat(30).trim();
		const made = await t.client.post<{ schedule: Schedule }>("/schedules", {
			kind: "thread", subject: "Weekly review", cron: "0 9 * * 1",
			payload: { to: ["tester"], body, subject: "Subject of the eventual thread" },
		});
		expect(made.status).toBe(201);
		const id = made.body.schedule.id;
		page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);
		const shown = await evaluatePage<{ title: string; meta: string; full: string; closed: boolean; edit: string; editedByDisclosure: boolean }>(`
			location.hash = "#/schedules";
			await until(() => document.querySelectorAll("#schedules-list .item").length === 1);
			const row = document.querySelector("#schedules-list .item");
			const disclosure = row.querySelector("details");
			const closed = !disclosure.open;
			disclosure.querySelector("summary").click();
			const editedByDisclosure = document.getElementById("schedule-create").textContent === "Update";
			row.querySelector("[data-testid=schedule-edit]").click();
			const edit = document.getElementById("schedule-subject").value;
			return { title: row.querySelector(".title").textContent, meta: row.querySelector(".meta").textContent,
				full: disclosure.querySelector("pre").textContent, closed, edit, editedByDisclosure };
		`);
		expect(shown.title).toBe("Weekly review");
		expect(shown.meta).toContain("thread · 0 9 * * 1 · active");
		expect(shown.meta).toContain("next");
		expect(shown.meta).not.toContain(body);
		expect(shown.full).toBe(body);
		expect(shown.closed).toBe(true);
		expect(shown.editedByDisclosure).toBe(false);
		expect(shown.edit).toBe("Weekly review");
		await evaluatePage(`
			document.getElementById("schedule-subject").value = "Updated review";
			document.getElementById("schedule-form").requestSubmit();
			await until(() => document.querySelector("#schedules-list .title")?.textContent === "Updated review");
			return true;
		`);
		const edited = (await t.client.get<{ schedule: Schedule }>(`/schedules/${id}`)).body.schedule;
		expect(edited.subject).toBe("Updated review");
		expect(edited.payload).toMatchObject({ body, subject: "Subject of the eventual thread", to: ["tester"] });

		// A blank subject on create is optional: the API derives the label from the instructions.
		await evaluatePage(`
			if (document.getElementById("schedule-subject").value !== "") throw new Error("subject did not reset");
			document.getElementById("schedule-kind").value = "session";
			document.getElementById("schedule-when").value = "0 10 * * *";
			document.getElementById("schedule-prompt").value = "Check releases\\n\\nInclude all checks in the report.";
			document.getElementById("schedule-form").requestSubmit();
			await until(() => document.querySelectorAll("#schedules-list .item").length === 2);
			return true;
		`);
		const schedules = (await t.client.get<{ schedules: Schedule[] }>("/schedules")).body.schedules;
		const derived = schedules.find((s) => s.id !== id)!;
		expect(derived.subject).toContain("Check releases");
		expect(derived.subject).not.toContain("\n");
		expect(derived.payload.prompt).toBe("Check releases\n\nInclude all checks in the report.");
		const title = await evaluatePage<string>(`
			return [...document.querySelectorAll("#schedules-list .item")].find((row) => row.dataset.id === ${JSON.stringify(derived.id)}).querySelector(".title").textContent;
		`);
		expect(title).toBe(derived.subject);
		// Leaving an automatic label untouched must not convert it into a manual label.
		await evaluatePage(`
			const row = [...document.querySelectorAll("#schedules-list .item")].find((el) => el.dataset.id === ${JSON.stringify(derived.id)});
			row.querySelector("[data-testid=schedule-edit]").click();
			document.getElementById("schedule-prompt").value = "Check releases tomorrow";
			document.getElementById("schedule-form").requestSubmit();
			await until(() => [...document.querySelectorAll("#schedules-list .title")].some((el) => el.textContent === "Check releases tomorrow"));
			return true;
		`);
		expect((await t.client.get<{ schedule: Schedule }>(`/schedules/${derived.id}`)).body.schedule.subject).toBe("Check releases tomorrow");

		await evaluatePage(`
			document.getElementById("schedule-subject").value = "Release watch";
			document.getElementById("schedule-when").value = "0 11 * * *";
			document.getElementById("schedule-prompt").value = "Check the next release.";
			document.getElementById("schedule-form").requestSubmit();
			await until(() => [...document.querySelectorAll("#schedules-list .title")].some((el) => el.textContent === "Release watch"));
			return true;
		`);
		const explicit = (await t.client.get<{ schedules: Schedule[] }>("/schedules")).body.schedules.find((s) => s.subject === "Release watch");
		expect(explicit?.payload.prompt).toBe("Check the next release.");
		await evaluatePage(`
			const row = [...document.querySelectorAll("#schedules-list .item")].find((el) => el.querySelector(".title").textContent === "Release watch");
			row.querySelector("[data-testid=schedule-edit]").click();
			document.getElementById("schedule-subject").value = "";
			document.getElementById("schedule-form").requestSubmit();
			await until(() => [...document.querySelectorAll("#schedules-list .title")].some((el) => el.textContent === "Check the next release."));
			return true;
		`);
		const reset = (await t.client.get<{ schedule: Schedule }>(`/schedules/${explicit!.id}`)).body.schedule;
		expect(reset.subject).toBe("Check the next release.");

		// Wake schedules use the same subject/disclosure presentation, but remain non-editable.
		const session = await t.client.post<{ session: { id: string } }>("/sessions", { prompt: "Wait for the release check." });
		expect(session.status).toBe(201);
		const note = "Collect the release checks.\n\nReply only when the checks have finished.";
		const wake = await t.client.post<{ schedule: Schedule }>("/schedules", {
			kind: "wake", in: "1h", session: session.body.session.id, subject: "Release results", note,
		});
		expect(wake.status).toBe(201);
		const wakeShown = await evaluatePage<{ title: string; note: string; closed: boolean; editable: boolean }>(`
			location.hash = "#/inbox";
			await until(() => !document.getElementById("view-inbox").hidden);
			location.hash = "#/schedules";
			await until(() => document.querySelectorAll("#schedules-list .item").length === 4);
			const row = [...document.querySelectorAll("#schedules-list .item")].find((el) => el.dataset.id === ${JSON.stringify(wake.body.schedule.id)});
			return { title: row.querySelector(".title").textContent, note: row.querySelector("details pre").textContent,
				closed: !row.querySelector("details").open, editable: !!row.querySelector("[data-testid=schedule-edit]") };
		`);
		expect(wakeShown).toEqual({ title: "Release results", note, closed: true, editable: false });
	});
});
