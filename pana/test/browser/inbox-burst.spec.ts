// WEB-14: what a slow link feels before anything is drawn. The inbox follows `/events`, and an
// action in it used to ask for the list both on its own and again for the delivery its own
// archive produced, so one tap cost three or four list fetches. On a link with a half-second
// round trip that is the difference between a tap and a wait. This suite counts the fetches a
// real page makes, through the measurements the app already posts (OBS-03).

import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { loopbackOrigin } from "../../src/web/static.ts";
import { chromeDevtoolsAvailable, closePage, evaluatePage, newPage } from "./cli.ts";
import { seedDomain, type Seeded } from "./seed.ts";

const describeBrowser = chromeDevtoolsAvailable() ? describe : describe.skip;

let seeded: Seeded | undefined;
let page: number | undefined;

afterEach(async () => {
	if (page !== undefined) await closePage(page);
	page = undefined;
	await seeded?.t.close();
	seeded = undefined;
});

interface ClientSample {
	kind: string;
	name: string;
}

function samples(dir: string): ClientSample[] {
	const path = `${dir}/client.log`;
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as ClientSample);
}

/** Post what the page has measured and answer everything the log holds. `window.__pana` is the app's. */
async function flushed(dir: string): Promise<ClientSample[]> {
	await evaluatePage(`window.__pana.telemetry.flush(); return true;`);
	const end = Date.now() + 5_000;
	for (;;) {
		const found = samples(dir);
		const posted = found.filter((sample) => sample.kind === "api").length;
		if (posted > 0 || Date.now() > end) return found;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

describeBrowser("WEB-14 a burst in the inbox costs one list fetch", () => {
	it("archives from the inbox with a single list reload, and the list still updates", async () => {
		seeded = await seedDomain();
		const { t } = seeded;
		page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);
		await evaluatePage(`
			location.hash = '#/inbox';
			await until(() => document.querySelectorAll('#inbox-list .item').length >= 3);
			window.__pana.telemetry.flush();
			return true;
		`);
		// Let the boot's own samples land so the count below is only what the tap costs.
		await new Promise((resolve) => setTimeout(resolve, 500));
		await flushed(t.dir);
		const before = samples(t.dir).length;

		const drew = await evaluatePage<{ was: number; now: number }>(`
			const rows = () => document.querySelectorAll('#inbox-list .item').length;
			const was = rows();
			document.querySelector('[data-testid="inbox-archive"]').click();
			await until(() => rows() === was - 1);
			return { was, now: rows() };
		`);
		expect(drew.now).toBe(drew.was - 1);

		// Archiving sends no delivery of its own, so the tap itself must cost one list fetch: the
		// badge comes back with the list rather than in a fetch of its own.
		await new Promise((resolve) => setTimeout(resolve, 800));
		const added = (await flushed(t.dir)).slice(before);
		const loads = added.filter((sample) => sample.name === "GET /inbox");
		expect(loads.length, JSON.stringify(added)).toBe(1);
	});
});
