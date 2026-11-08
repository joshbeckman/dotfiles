// OBS-03, OBS-04: the PWA measures itself, and the measurements reach panad.
//
// A unit test can call the recorder, but only a real page proves the app wires it up: that
// `perf.js` loads under the shell's strict CSP, that a view draws and an API call completes
// during it, and that the batch lands in `client.log` with a route pattern rather than an id.

import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { loopbackOrigin } from "../../src/web/static.ts";
import { chromeDevtoolsAvailable, closePage, evaluatePage, newPage } from "./cli.ts";
import { seedDomain, type Seeded } from "./seed.ts";

let seeded: Seeded | undefined;
let page: number | undefined;
afterEach(async () => {
	if (page !== undefined) await closePage(page);
	await seeded?.t.close();
});

/** Wait for the daemon to have appended at least one sample, or give up. */
async function waitForSamples(dir: string, count = 1): Promise<string[]> {
	const path = `${dir}/client.log`;
	const end = Date.now() + 10_000;
	for (;;) {
		const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
		if (lines.length >= count) return lines;
		if (Date.now() > end) throw new Error(`timed out waiting for ${count} client samples; have ${lines.length}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

(chromeDevtoolsAvailable() ? describe : describe.skip)("OBS-03 the PWA measures itself", () => {
	it("records an API call and a view render, and posts them without an id", async () => {
		seeded = await seedDomain();
		const { t } = seeded;
		page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);

		// Draw the inbox and open one thread, so there is a view to time and a call with an id in
		// its path for the recorder to reduce to a pattern.
		await evaluatePage(`
			location.hash = '#/inbox';
			await until(() => !document.getElementById('view-inbox').hidden);
			return true;
		`);
		await evaluatePage(`
			location.hash = '#/threads/${seeded!.capital.threadId}';
			await until(() => !document.getElementById('thread').hidden && document.querySelectorAll('#thread-messages .message').length >= 2);
			return true;
		`);

		// Flush now instead of waiting for the ten-second timer.
		const pending = await evaluatePage<number>(`
			window.__pana.telemetry.flush();
			return window.__pana.telemetry.pending();
		`);
		expect(pending).toBe(0);

		const lines = await waitForSamples(t.dir, 2);
		const samples = lines.map((line) => JSON.parse(line) as { kind: string; name: string; durationMs: number; status?: number });
		const kinds = new Set(samples.map((sample) => sample.kind));
		expect(kinds.has("api")).toBe(true);
		expect(kinds.has("view")).toBe(true);

		// A name is a route or a section, and never the id the reader was looking at.
		for (const sample of samples) {
			expect(sample.name).not.toContain(seeded.capital.threadId);
			expect(sample.name).not.toContain(seeded.capital.sessionId);
			expect(sample.durationMs).toBeGreaterThanOrEqual(0);
		}
		const threadRead = samples.find((sample) => sample.kind === "api" && sample.name.includes("/threads/:id"));
		expect(threadRead, "the thread read is named by its pattern").toBeDefined();
		expect(samples.some((sample) => sample.kind === "view" && sample.name === "#/inbox")).toBe(true);

		// The daemon reads the same file back.
		const summary = await t.client.get<{ client: { window: { count: number }; groups: Array<{ kind: string; name: string }> } }>("/stats/requests");
		expect(summary.status).toBe(200);
		expect(summary.body.client.window.count).toBeGreaterThanOrEqual(samples.length);
		expect(summary.body.client.groups.some((group) => group.kind === "api" && group.name === "GET /threads/:id")).toBe(true);
	});
});
