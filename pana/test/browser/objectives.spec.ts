// OBJ-39 in a real browser: the objectives list and the one view a person uses to watch and steer
// an objective — its state, charter, metrics, report, artifacts, roster, money and runs, wakes,
// and escalation — and the actions it offers (launch, stop, regenerate the lead, edit the charter).
// Needs the installed Chrome and chrome-devtools, so it runs with `npm run test:web`, not in CI.

import { afterEach, describe, expect, it } from "vitest";
import { loopbackOrigin } from "../../src/web/static.ts";
import type { TestPanad } from "../harness/index.ts";
import { chromeDevtoolsAvailable, closePage, emulateViewport, evaluatePage, newPage } from "./cli.ts";
import { seedObjectives, type SeededObjectives } from "./objective-seed.ts";

const describeBrowser = chromeDevtoolsAvailable() ? describe : describe.skip;
const PHONE = "390x844x3,mobile,touch";

let seeded: SeededObjectives | undefined;
let page: number | undefined;
let phone = false;

afterEach(async () => {
	if (phone) await emulateViewport("").catch(() => undefined);
	phone = false;
	if (page !== undefined) await closePage(page).catch(() => undefined);
	page = undefined;
	await seeded?.t.close();
	seeded = undefined;
});

interface Shown {
	objective: {
		id: string;
		phase: string;
		state: string | null;
		awaitingUser: boolean;
		lead: { id: string } | null;
		charterRev: number;
		spendTodayUsd: number;
		leadRunsToday: number;
	};
}

async function shown(t: TestPanad, id: string): Promise<Shown["objective"]> {
	const res = await t.client.get<Shown>(`/objectives/${id}`);
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return res.body.objective;
}

describeBrowser("objectives", () => {
	it("OBJ-39 shows an objective's state, metrics, roster, and spend, and stops and regenerates it", async () => {
		seeded = await seedObjectives();
		const { t, active, draft } = seeded;
		const origin = loopbackOrigin(t.panad.tcpPort!);
		page = await newPage(`${origin}/#${t.panad.webToken}`);

		// ---- The list: phase, derived state, holding condition, goal, lead, spend, runs.
		const list = await evaluatePage<{
			rows: Array<{ id: string; title: string; meta: string }>;
			hint: string;
		}>(`
			location.hash = "#/objectives";
			await until(() => document.querySelectorAll("#objectives-list .item").length === 2);
			return {
				rows: [...document.querySelectorAll("#objectives-list .item")].map((row) => ({
					id: row.dataset.id,
					title: row.querySelector(".title").textContent,
					meta: row.querySelector(".meta").textContent,
				})),
				hint: document.querySelector("#objectives-browse > .hint").textContent,
			};
		`);
		const activeRow = list.rows.find((row) => row.id === active.id)!;
		const draftRow = list.rows.find((row) => row.id === draft.id)!;
		expect(list.hint).toContain("A draft costs nothing until it is launched");
		expect(activeRow.title).toContain("active");
		// OBJ-03: the derived state is on the row, and the escalation is the holding condition.
		expect(activeRow.title).toMatch(/running|idle|stranded/);
		expect(activeRow.title).toContain("waiting for you");
		expect(activeRow.title).toContain("Cut the house's energy bill by a fifth before the tariff changes");
		// OBJ-20: today's spend and today's runs, and the lead to ask about them.
		expect(activeRow.meta).toContain("lead session");
		expect(activeRow.meta).toContain("spent $1.7500 today");
		expect(activeRow.meta).toMatch(/\d+ runs? today/);
		expect(draftRow.title).toContain("drafting");
		expect(draftRow.meta).toContain("no lead yet");
		expect(draftRow.meta).toContain("spent $0.0000 today");

		// The phase filter is part of the list, and an unknown phase resets it.
		const filtered = await evaluatePage<number>(`
			location.hash = "#/objectives?phase=drafting";
			await until(() => document.querySelectorAll("#objectives-list .item").length === 1);
			return document.querySelectorAll("#objectives-list .item").length;
		`);
		expect(filtered).toBe(1);
		await evaluatePage(`
			location.hash = "#/objectives";
			await until(() => document.querySelectorAll("#objectives-list .item").length === 2);
			return true;
		`);

		// ---- The view.
		const view = await evaluatePage<{
			goal: string;
			meta: string;
			url: string;
			charter: Array<{ name: string; text: string }>;
			atTarget: string;
			percentFree: boolean;
			metrics: Array<{ name: string; current: string; target: number | null; line: number; targetLine: number; points: number }>;
			report: string;
			artifacts: Array<{ title: string; meta: string; href: string | null }>;
			members: Array<{ state: string; text: string; session: string | null; lead: boolean }>;
			meters: Array<{ id: string; label: string; value: string; bar: number; source: string; sourceLabel: string }>;
			wakes: string[];
			wakeCount: string;
			escalation: string;
			actions: Record<string, string | undefined>;
		}>(`
			location.hash = "#/objectives/${active.id}";
			await until(() => !document.getElementById("objective").hidden && document.querySelectorAll("#objective-members .item").length >= 2);
			await until(() => document.querySelectorAll("#objective-metrics [data-testid=objective-metric]").length === 3);
			await sleep(300);
			return {
				goal: document.getElementById("objective-goal").textContent,
				meta: document.getElementById("objective-meta").textContent,
				url: document.querySelector("[data-testid=objective-url]").textContent,
				charter: [...document.querySelectorAll("#objective-charter [data-testid=charter-section]")].map((block) => ({
					name: block.dataset.section,
					text: block.querySelector("[data-testid=charter-body]")?.textContent ?? block.querySelector(".charter-empty")?.textContent ?? "",
				})),
				atTarget: document.getElementById("objective-at-target").textContent,
				percentFree: !document.getElementById("objective-metrics-section").textContent.includes("%"),
				metrics: [...document.querySelectorAll("#objective-metrics [data-testid=objective-metric]")].map((figure) => {
					const chart = figure.querySelector("svg[data-testid=metric-chart]");
					const line = chart.querySelector("polyline[data-testid=metric-line]");
					return {
						name: figure.dataset.metric,
						current: figure.querySelector("[data-testid=metric-current]").textContent,
						target: figure.querySelector(".metric-target-label").textContent.includes("no target") ? null : 1,
						line: line ? 1 : 0,
						targetLine: chart.querySelector("line.metric-target") ? 1 : 0,
						points: line ? line.getAttribute("points").split(" ").length : 0,
					};
				}),
				report: document.getElementById("objective-report").textContent,
				artifacts: [...document.querySelectorAll("#objective-artifacts .item")].map((row) => ({
					title: row.querySelector(".title").textContent,
					meta: row.querySelector(".meta").textContent,
					href: row.querySelector("a[data-testid=objective-artifact-link]")?.getAttribute("href") ?? null,
				})),
				members: [...document.querySelectorAll("#objective-members .item")].map((row) => ({
					state: row.querySelector(".state-badge").textContent,
					text: row.textContent,
					session: row.querySelector("a[data-testid=ref-link]")?.getAttribute("href") ?? null,
					lead: row.textContent.includes("lead"),
				})),
				meters: [...document.querySelectorAll("#objective-meters [data-testid=objective-meter]")].map((row) => ({
					id: row.dataset.meter,
					label: row.querySelector(".meter-label").textContent,
					value: row.querySelector("[data-testid=objective-meter-value]").textContent,
					bar: row.querySelectorAll(".meter-bar").length,
					source: row.dataset.source,
					sourceLabel: row.querySelector(".meter-source")?.textContent ?? "",
				})),
				wakes: [...document.querySelectorAll("#objective-wakes [data-testid=objective-wake]")].map((row) => row.textContent),
				wakeCount: document.querySelector("[data-testid=objective-wake-count]").textContent,
				escalation: document.getElementById("objective-escalation").hidden ? "" : document.getElementById("objective-escalation").textContent,
				// OBJ-39: every action is present; data-allowed says whether the phase permits it.
				actions: Object.fromEntries(
					["launch", "stop", "resume", "done", "archive", "regenerate"].map((action) => [
						action,
						document.getElementById("objective-" + action).dataset.allowed,
					]),
				),
			};
		`);

		expect(view.goal).toBe("Cut the house's energy bill by a fifth before the tariff changes");
		expect(view.meta).toContain("active");
		expect(view.meta).toContain("waiting for you");
		expect(view.meta).toContain("autonomy: manual");
		expect(view.url).toContain(`pana://`);
		expect(view.url).toContain(`/objectives/${active.id}`);
		// OBJ-09: all six sections, with the text the charter holds.
		expect(view.charter.map((section) => section.name)).toEqual(["Scope", "Cancel", "Done", "Guidance", "Escalation", "Notes"]);
		expect(view.charter.find((section) => section.name === "Notes")!.text).toContain("The dishwasher runs at night");
		// OBJ-28: one line per metric, its target line, a count at target, and never a percentage.
		expect(view.metrics.map((metric) => metric.name)).toEqual(["bill-usd", "kwh", "reads"]);
		expect(view.metrics.every((metric) => metric.line === 1 && metric.targetLine === 1)).toBe(true);
		expect(view.metrics.find((metric) => metric.name === "kwh")!.points).toBe(3);
		expect(view.metrics.find((metric) => metric.name === "kwh")!.current).toContain("27.333 kwh");
		expect(view.atTarget).toBe("1 of 3 at target");
		expect(view.percentFree).toBe(true);
		// OBJ-30/OBJ-31: the newest report and the artifact, with its name, size, and file URL.
		expect(view.report).toContain("Baseline is 30 kWh a day");
		expect(view.artifacts).toHaveLength(1);
		expect(view.artifacts[0]!.title).toBe("baseline.csv");
		expect(view.artifacts[0]!.meta).toContain("22 B");
		expect(view.artifacts[0]!.href).toContain("/files/");
		// UX-09/REF-08: the roster, each member's live state beside a link to its session.
		expect(view.members).toHaveLength(3);
		expect(view.members.filter((member) => member.lead)).toHaveLength(1);
		expect(view.members.some((member) => member.state === "running")).toBe(true);
		expect(view.members.every((member) => member.session?.startsWith("#/sessions/"))).toBe(true);
		// OBJ-20..OBJ-24: money and runs against the limits, each with a bar.
		const meters = Object.fromEntries(view.meters.map((meter) => [meter.id, meter]));
		expect(meters["spend-today"]).toMatchObject({ label: "Spend today", value: "$1.7500 of $5.0000", bar: 1 });
		expect(meters["spend-total"]).toMatchObject({ value: "$1.7500 of $20.0000" });
		expect(meters["runs-today"]!.value).toMatch(/^\d+ of 12$/);
		expect(meters.members).toMatchObject({ label: "Active members", value: "3 of 4" });
		// OBJ-39: a meter draws the limit that applies. The objective's own limits are unlabelled;
		// the one it does not set is drawn from the domain's config and says where it came from.
		expect(meters["spend-today"]).toMatchObject({ source: "objective", sourceLabel: "" });
		expect(meters.members).toMatchObject({ source: "objective", sourceLabel: "" });
		expect(meters["messages-today"]).toMatchObject({ value: expect.stringMatching(/^\d+ of 10$/), bar: 1, source: "config", sourceLabel: "from the domain's config" });
		// WAK-08: the pending wakes, with next-run times, recurrence, and the session each wakes.
		expect(view.wakes).toHaveLength(2);
		expect(view.wakeCount).toBe("2 pending wakes.");
		expect(view.wakes.join(" ")).toContain("recurring (0 8 * * *)");
		expect(view.wakes.join(" ")).toContain("Read the meter and reply in the objective thread");
		// OBJ-33: the escalation, at the scope it holds, with the thread its answer comes from.
		expect(view.escalation).toContain("the whole objective");
		expect(view.escalation).toContain("Which reading should I trust");
		// OBJ-04/OBJ-07/OBJ-35: what an active objective offers, and what its phase forbids.
		expect(view.actions).toEqual({
			launch: "false",
			stop: "true",
			resume: "false",
			done: "true",
			archive: "false",
			regenerate: "true",
		});

		// ---- UX-09: a member's state event moves its badge without a reload.
		const memberId = seeded.active.memberIds[0]!;
		expect((await t.client.post(`/sessions/${memberId}/stop`, {})).status).toBe(200);
		const live = await evaluatePage<string>(`
			await until(() => document.querySelector('#objective-members [data-session="${memberId}"] .state-badge')?.textContent === "stopped");
			return document.querySelector('#objective-members [data-session="${memberId}"]').textContent;
		`);
		expect(live).toContain("stopped");

		// ---- OBJ-09: the charter edit asks only for the text, and a stale write keeps it.
		const edited = await evaluatePage<{ opened: string; saved: string; rev: number }>(`
			const block = [...document.querySelectorAll("#objective-charter [data-testid=charter-section]")].find((section) => section.dataset.section === "Guidance");
			block.querySelector("[data-testid=charter-edit]").click();
			await until(() => block.querySelector("[data-testid=charter-text]"));
			const opened = block.querySelector("[data-testid=charter-text]").value;
			block.querySelector("[data-testid=charter-text]").value = "Read the meter before coffee, and never on a Sunday.";
			block.querySelector("[data-testid=charter-editor]").requestSubmit();
			await until(() => !document.querySelector("[data-testid=charter-text]"));
			await until(() => [...document.querySelectorAll("#objective-charter [data-testid=charter-section]")].find((section) => section.dataset.section === "Guidance").textContent.includes("never on a Sunday"));
			return { opened, saved: "ok", rev: 0 };
		`);
		expect(edited.opened).toContain("Read the meter before coffee");
		const charter = await t.client.get<{ sections: Record<string, { body: string }>; rev: number }>(`/objectives/${active.id}/charter`);
		expect(charter.body.sections.Guidance!.body).toBe("Read the meter before coffee, and never on a Sunday.");
		let rev = charter.body.rev;

		// Somebody else writes Guidance; the open editor's save is then stale, and must show the
		// conflict instead of losing what was typed.
		const conflict = await evaluatePage<{ kept: string; shown: string; body: string }>(`
			const block = [...document.querySelectorAll("#objective-charter [data-testid=charter-section]")].find((section) => section.dataset.section === "Guidance");
			block.querySelector("[data-testid=charter-edit]").click();
			await until(() => block.querySelector("[data-testid=charter-text]"));
			block.querySelector("[data-testid=charter-text]").value = "Mine: read the meter at noon.";
			await fetch("/objectives/${active.id}/charter", {
				method: "POST",
				headers: { "content-type": "application/json", authorization: "Bearer " + localStorage.getItem("pana-token") },
				body: JSON.stringify({ section: "Guidance", body: "Theirs: read the meter at midnight.", baseRev: ${rev} }),
			});
			block.querySelector("[data-testid=charter-editor]").requestSubmit();
			await until(() => block.querySelector("[data-testid=charter-conflict]"));
			return {
				kept: block.querySelector("[data-testid=charter-text]").value,
				shown: block.querySelector("[data-testid=charter-conflict]").textContent,
				body: block.textContent,
			};
		`);
		expect(conflict.kept).toBe("Mine: read the meter at noon.");
		expect(conflict.shown).toContain("The charter moved to revision");
		expect(conflict.body).toContain("Theirs: read the meter at midnight.");
		await evaluatePage(`
			document.querySelector("[data-testid=charter-save-over]").click();
			await until(() => !document.querySelector("[data-testid=charter-text]"));
			return true;
		`);
		const resolved = await t.client.get<{ sections: Record<string, { body: string }>; rev: number }>(`/objectives/${active.id}/charter`);
		expect(resolved.body.sections.Guidance!.body).toBe("Mine: read the meter at noon.");
		rev = resolved.body.rev;

		// ---- OBJ-35: regenerate the lead, with a reason and a confirmation.
		const before = await shown(t, active.id);
		const regenerate = await evaluatePage<{ asked: boolean; reason: boolean; lead: string }>(`
			document.getElementById("objective-regenerate").click();
			const asked = !document.getElementById("objective-confirm").hidden;
			const reason = !document.getElementById("objective-reason-field").hidden;
			document.getElementById("objective-reason").value = "The lead stopped reading the meter.";
			document.getElementById("objective-confirm-yes").click();
			await until(() => !document.getElementById("objective-confirm").hidden || document.querySelector("#objective-meta a") !== null);
			await sleep(400);
			return { asked, reason, lead: document.getElementById("objective-meta").textContent };
		`);
		expect(regenerate.asked).toBe(true);
		expect(regenerate.reason).toBe(true);
		const replaced = await shown(t, active.id);
		expect(replaced.phase).toBe("active");
		expect(replaced.lead!.id).not.toBe(before.lead!.id);
		expect(regenerate.lead).toContain("lead");

		// ---- OBJ-07: stop asks first, and stops it.
		await evaluatePage(`
			document.getElementById("objective-stop").click();
			if (document.getElementById("objective-confirm").hidden) throw new Error("stop did not ask first");
			document.getElementById("objective-confirm-yes").click();
			await until(() => document.getElementById("objective-meta").textContent.includes("stopped"));
			return true;
		`);
		expect((await shown(t, active.id)).phase).toBe("stopped");

		// ---- OBJ-04: a draft offers launch, asks first, and becomes active.
		const launched = await evaluatePage<{ asked: boolean }>(`
			location.hash = "#/objectives/${draft.id}";
			await until(() => !document.getElementById("objective").hidden && document.getElementById("objective-launch").dataset.allowed === "true");
			document.getElementById("objective-launch").click();
			const asked = !document.getElementById("objective-confirm").hidden;
			document.getElementById("objective-confirm-yes").click();
			await until(() => document.getElementById("objective-meta").textContent.includes("active"));
			return { asked };
		`);
		expect(launched.asked).toBe(true);
		expect((await shown(t, draft.id)).phase).toBe("active");

		// ---- MOB-01 at 390 px: neither the list nor the view scrolls sideways, chart and roster
		// included.
		phone = true;
		await emulateViewport(PHONE);
		const overflow = await evaluatePage<{ list: number; view: number; offenders: string[] }>(`
			const measure = () => {
				const offenders = [];
				for (const element of document.querySelectorAll("body *")) {
					if (element.closest("[hidden]") || element.offsetParent === null) continue;
					const rect = element.getBoundingClientRect();
					if (rect.width === 0 || rect.right <= innerWidth + 1) continue;
					let clipped = false;
					for (let up = element.parentElement; up && up !== document.body; up = up.parentElement) {
						const style = getComputedStyle(up);
						if (/(auto|scroll)/.test(style.overflowX) && up.getBoundingClientRect().right <= innerWidth + 1) { clipped = true; break; }
					}
					if (clipped) continue;
					if (element.parentElement && offenders.some((entry) => entry.element.contains(element))) continue;
					offenders.push({ element, text: element.tagName.toLowerCase() + (element.className ? "." + String(element.className).trim().replace(/\\s+/g, ".") : "") + " right=" + Math.round(rect.right) });
				}
				return { width: document.documentElement.scrollWidth, innerWidth, offenders: offenders.map((entry) => entry.text).slice(0, 8) };
			};
			location.hash = "#/objectives";
			await until(() => document.querySelectorAll("#objectives-list .item").length === 2);
			await sleep(200);
			const list = measure();
			location.hash = "#/objectives/${active.id}";
			await until(() => document.querySelectorAll("#objective-metrics [data-testid=objective-metric]").length === 3);
			await sleep(300);
			const view = measure();
			return { list: list.width - list.innerWidth, view: view.width - view.innerWidth, offenders: [...list.offenders, ...view.offenders] };
		`);
		expect(overflow.offenders).toEqual([]);
		expect(overflow.list).toBeLessThan(2);
		expect(overflow.view).toBeLessThan(2);
	});

	it("OBJ-39 resumes, finishes, archives, edits the limits, and shows why a forbidden action is disabled", async () => {
		seeded = await seedObjectives();
		const { t, active } = seeded;
		page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);

		// A fresh view of the active objective, with every action present and gated.
		const opened = await evaluatePage<{ note: string; noteHidden: boolean; actions: Record<string, boolean>; doneText: string }>(`
			location.hash = "#/objectives/${active.id}";
			await until(() => !document.getElementById("objective").hidden && document.querySelectorAll("#objective-meters [data-testid=objective-meter]").length === 5);
			await sleep(200);
			return {
				note: document.getElementById("objective-actions-note").textContent,
				noteHidden: document.getElementById("objective-actions-note").hidden,
				actions: Object.fromEntries(
					["launch", "stop", "resume", "done", "archive", "regenerate"].map((action) => [action, document.getElementById("objective-" + action).disabled]),
				),
				doneText: "",
			};
		`);
		expect(opened.noteHidden).toBe(false);
		// OBJ-39: what the phase forbids is disabled with its reason, never absent.
		expect(opened.actions).toEqual({ launch: true, stop: false, resume: true, done: false, archive: true, regenerate: false });
		expect(opened.note).toContain("Launch is unavailable: only a draft is launched.");
		expect(opened.note).toContain("Archive is unavailable: only a stopped or done objective is archived.");

		// OBJ-07: finishing is the user's confirmation, and the dialog says what it is confirming.
		const refused = await evaluatePage<{ question: string; status: string }>(`
			document.getElementById("objective-done").click();
			await until(() => !document.getElementById("objective-confirm").hidden);
			const question = document.getElementById("objective-confirm-text").textContent;
			document.getElementById("objective-confirm-yes").click();
			await until(() => document.getElementById("status").textContent.includes("Not at target yet"));
			return { question, status: document.getElementById("status").textContent };
		`);
		expect(refused.question).toContain("Every metric with a target has to be at that target");
		// The refusal names the metric that is short, instead of only saying "conflict".
		expect(refused.status).toContain("Not at target yet");
		expect(refused.status).toContain("kwh");
		expect((await shown(t, active.id)).phase).toBe("active");

		// OBJ-41: the limits are editable, and a cleared limit falls back to the domain's default.
		const limits = await evaluatePage<{ before: string; after: string; source: string; total: string; saved: string }>(`
			const form = document.getElementById("objective-limits");
			const before = form.querySelector("[data-limit=maxDailyUsd]").value;
			form.querySelector("[data-limit=maxDailyUsd]").value = "9";
			form.querySelector("[data-limit=maxTotalUsd]").value = "";
			form.requestSubmit();
			await until(() => document.querySelector("[data-meter=spend-today] [data-testid=objective-meter-value]").textContent.includes("9.0000"));
			const day = document.querySelector("[data-meter=spend-today]");
			const total = document.querySelector("[data-meter=spend-total]");
			return {
				before,
				after: day.querySelector("[data-testid=objective-meter-value]").textContent,
				source: day.dataset.source,
				total: total.querySelector("[data-testid=objective-meter-value]").textContent,
				saved: document.getElementById("status").textContent,
			};
		`);
		expect(limits.before).toBe("5");
		expect(limits.after).toBe("$1.7500 of $9.0000");
		expect(limits.source).toBe("objective");
		// A cleared lifetime limit has no default, so the meter says nothing bounds it and draws no bar.
		expect(limits.total).toContain("no limit");
		expect(limits.saved).toContain("Limits saved");
		const stored = await t.client.get<{ objective: { limits: Record<string, number | null>; effectiveLimits: Record<string, { value: number | null; source: string }> } }>(
			`/objectives/${active.id}`,
		);
		expect(stored.body.objective.limits).toMatchObject({ maxDailyUsd: 9, maxTotalUsd: null });
		expect(stored.body.objective.effectiveLimits.maxDailyUsd).toEqual({ value: 9, source: "objective" });
		expect(stored.body.objective.effectiveLimits.maxTotalUsd).toEqual({ value: null, source: "none" });

		// OBJ-07: stop, then resume from the same screen.
		await evaluatePage(`
			document.getElementById("objective-stop").click();
			await until(() => !document.getElementById("objective-confirm").hidden);
			document.getElementById("objective-confirm-yes").click();
			await until(() => document.getElementById("objective-meta").textContent.includes("stopped"));
			return true;
		`);
		const stopped = await evaluatePage<{ note: string; actions: Record<string, boolean> }>(`
			await until(() => document.getElementById("objective-resume").dataset.allowed === "true");
			return {
				note: document.getElementById("objective-actions-note").textContent,
				actions: Object.fromEntries(
					["launch", "stop", "resume", "done", "archive", "regenerate"].map((action) => [action, document.getElementById("objective-" + action).disabled]),
				),
			};
		`);
		expect(stopped.actions).toEqual({ launch: true, stop: true, resume: false, done: false, archive: false, regenerate: true });
		// Resume is the one action a stopped objective offers, so it is the one the note leaves out.
		expect(stopped.note).not.toContain("Resume is unavailable");

		await evaluatePage(`
			document.getElementById("objective-resume").click();
			await until(() => !document.getElementById("objective-confirm").hidden);
			document.getElementById("objective-confirm-yes").click();
			await until(() => document.getElementById("objective-meta").textContent.includes("active"));
			return true;
		`);
		expect((await shown(t, active.id)).phase).toBe("active");

		// OBJ-07: with every target met, `done` takes the user's confirmation and then offers archive.
		// kwh is a trailing mean, so it takes three readings to bring its window under its target.
		for (const [name, value] of [["kwh", 18], ["kwh", 10], ["kwh", 10], ["bill-usd", 80], ["reads", 8]] as const) {
			const read = await t.client.post(`/objectives/${active.id}/metrics/${name}/readings`, { value });
			expect(read.status, JSON.stringify(read.body)).toBe(201);
		}
		await evaluatePage(`
			document.getElementById("objective-reload").click();
			await until(() => document.getElementById("objective-at-target").textContent.startsWith("3 of 3"));
			return true;
		`);
		await evaluatePage(`
			document.getElementById("objective-done").click();
			await until(() => !document.getElementById("objective-confirm").hidden);
			document.getElementById("objective-confirm-yes").click();
			await until(() => document.getElementById("objective-meta").textContent.includes("done"));
			await until(() => document.getElementById("objective-archive").dataset.allowed === "true");
			return true;
		`);
		expect((await shown(t, active.id)).phase).toBe("done");

		// OBJ-07/SCR-04: archiving asks first and archives the objective's member sessions with it.
		const archived = await evaluatePage<{ question: string; actions: Record<string, boolean> }>(`
			document.getElementById("objective-archive").click();
			await until(() => !document.getElementById("objective-confirm").hidden);
			const question = document.getElementById("objective-confirm-text").textContent;
			document.getElementById("objective-confirm-yes").click();
			await until(() => document.getElementById("objective-meta").textContent.includes("archived"));
			return {
				question,
				actions: Object.fromEntries(
					["launch", "stop", "resume", "done", "archive", "regenerate"].map((action) => [action, document.getElementById("objective-" + action).disabled]),
				),
			};
		`);
		expect(archived.question).toContain("Its member sessions are archived with it");
		expect(archived.actions).toEqual({ launch: true, stop: true, resume: true, done: true, archive: true, regenerate: true });
		expect((await shown(t, active.id)).phase).toBe("archived");
		// Nothing is offered on a closed objective, and the note says why for each.
		const note = await evaluatePage<string>(`return document.getElementById("objective-actions-note").textContent;`);
		expect(note).toContain("Resume is unavailable: only a stopped objective is resumed.");
		expect(note).toContain("Archive is unavailable: only a stopped or done objective is archived.");
	});
});
