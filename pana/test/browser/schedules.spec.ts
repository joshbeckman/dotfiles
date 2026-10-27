import { afterEach, describe, expect, it } from "vitest";
import { recordCheck } from "../../src/schedules/store.ts";
import { loopbackOrigin } from "../../src/web/static.ts";
import { startTestPanad, type TestPanad } from "../harness/index.ts";
import { chromeDevtoolsAvailable, closePage, emulateViewport, evaluatePage, newPage } from "./cli.ts";

const describeBrowser = chromeDevtoolsAvailable() ? describe : describe.skip;
let t: TestPanad | undefined;
let page: number | undefined;
let phone = false;
afterEach(async () => {
	if (phone) await emulateViewport("");
	phone = false;
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


describeBrowser("schedule run conditions", () => {
	it("SCH-19 shows check commands, cwd, stopping behavior, and complete latest diagnostics safely on desktop and phone", async () => {
		t = await startTestPanad({ config: { timezone: "UTC" } });
		const command = "./ready --label '<script>window.checkOutputExecuted = true</script>'";
		const cwd = "/tmp/" + "long-project-directory-".repeat(12);
		const output = "<img src=x onerror='window.checkOutputExecuted = true'>\n" + "long-output".repeat(100);
		for (const state of ["plain", "pending", "passed", "not_ready", "failed", "stop_only"] as const) {
			const checked = state !== "plain" && state !== "stop_only";
			const made = await t.client.post<{ schedule: { id: string } }>("/schedules", {
				subject: state, cron: "0 9 * * *", prompt: "Read and report the test result.",
				...(checked ? { check: command, checkCwd: cwd } : {}),
				stopAfterSuccess: state === "pending" || state === "stop_only",
			});
			expect(made.status).toBe(201);
			if (state === "passed" || state === "not_ready" || state === "failed") await recordCheck(t.runtime, made.body.schedule.id, {
				checkedAt: t.clock.now(), status: state, exitCode: state === "passed" ? 0 : state === "not_ready" ? 1 : null,
				signal: state === "failed" ? "SIGTERM" : null, stdout: output, stderr: "A diagnostic warning",
				error: state === "failed" ? "check timed out" : null,
			});
		}
		page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);
		const rows = await evaluatePage<Array<{ title: string; meta: string; text: string | null; closed: boolean }>>(`
			location.hash = "#/schedules";
			await until(() => document.querySelectorAll("#schedules-list .item").length === 6);
			return [...document.querySelectorAll("#schedules-list .item")].map(row => {
				const conditions = row.querySelector("[data-testid=schedule-conditions]");
				return { title: row.querySelector(".title").textContent, meta: row.querySelector(".meta").textContent,
					text: conditions?.querySelector("pre").textContent ?? null, closed: !conditions?.open };
			});
		`);
		const find = (name: string) => rows.find(r => r.title === name)!;
		expect(find("plain").text).toBeNull();
		expect(find("plain").meta).not.toContain("Conditional");
		expect(rows.every(r => r.closed)).toBe(true);
		expect(find("pending").meta).toContain("Conditional");
		expect(find("pending").meta).toContain("Stops after successful dispatch");
		expect(find("pending").meta).toContain("Last check: Not checked yet");
		expect(find("pending").text).toContain(command);
		expect(find("pending").text).toContain(`Working directory: ${cwd}`);
		expect(find("pending").text).toContain("Stop after successful dispatch: Yes");
		expect(find("stop_only").text).toContain("None (dispatch without a readiness check)");
		expect(find("stop_only").meta).toContain("Stops after successful dispatch");
		expect(find("stop_only").meta).not.toContain("Conditional");
		for (const [state, label, code] of [["passed", "Passed", 0], ["not_ready", "Not ready", 1], ["failed", "Failed", "None"]] as const) {
			const row = find(state);
			expect(row.meta).toContain(`Last check: ${label}`);
			expect(row.text).toContain("Checked at:");
			expect(row.text).toContain(`Exit code: ${code}`);
			expect(row.text).toContain("Stop after successful dispatch: No");
			expect(row.text).toContain(`Standard output:\n${output}`);
			expect(row.text).toContain("Standard error:\nA diagnostic warning");
		}
		expect(find("failed").text).toContain("Signal: SIGTERM");
		expect(find("failed").text).toContain("Error: check timed out");
		const interaction = await evaluatePage<{ edit: string; executed: boolean; injected: number }>(`
			const row = [...document.querySelectorAll("#schedules-list .item")].find(row => row.querySelector(".title").textContent === "failed");
			row.querySelector("[data-testid=schedule-conditions] summary").click();
			return { edit: document.getElementById("schedule-create").textContent, executed: !!window.checkOutputExecuted,
				injected: row.querySelectorAll("[data-testid=schedule-conditions] img, [data-testid=schedule-conditions] script").length };
		`);
		expect(interaction).toEqual({ edit: "Create", executed: false, injected: 0 });
		phone = true;
		await emulateViewport("390x844x1,mobile,touch");
		const overflow = await evaluatePage<number>(`
			for (const details of document.querySelectorAll("[data-testid=schedule-conditions]")) details.open = true;
			await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
			return document.documentElement.scrollWidth - innerWidth;
		`);
		expect(overflow).toBeLessThan(2);
		// Reading diagnostics must never modify the schedule or execute any stored check.
		const stored = await t.runtime.db.all<{ revision: number; next_at: number }>("SELECT revision, next_at FROM schedules");
		expect(stored.every(row => row.revision === 0 && row.next_at > t!.clock.now())).toBe(true);
	});
});
