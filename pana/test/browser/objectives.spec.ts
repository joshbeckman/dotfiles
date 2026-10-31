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
			actions: { launch: boolean; stop: boolean; regenerate: boolean };
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
				actions: {
					launch: !document.getElementById("objective-launch").hidden,
					stop: !document.getElementById("objective-stop").hidden,
					regenerate: !document.getElementById("objective-regenerate").hidden,
				},
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
		// OBJ-04/OBJ-07/OBJ-35: what an active objective offers.
		expect(view.actions).toEqual({ launch: false, stop: true, regenerate: true });

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
			await until(() => !document.getElementById("objective").hidden && !document.getElementById("objective-launch").hidden);
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
});
