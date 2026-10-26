// WP13 in a real browser: the transcript's Markdown and Raw toggle (UX-11), and work in progress
// streamed into the session view and the thread's working chip (UX-12).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sessionRuntime } from "../../src/sessions/index.ts";
import { loopbackOrigin } from "../../src/web/static.ts";
import { startTestPanad, TEST_DOMAIN, type Script, type TestPanad } from "../harness/index.ts";
import { chromeDevtoolsAvailable, closePage, evaluatePage, newPage, resizePage } from "./cli.ts";

const describeBrowser = chromeDevtoolsAvailable() ? describe : describe.skip;

let t: TestPanad | undefined;
let page: number | undefined;
let dir: string | undefined;

afterEach(async () => {
	if (page !== undefined) await closePage(page);
	page = undefined;
	await t?.close();
	t = undefined;
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
});

interface Created {
	session: { id: string; url: string };
	thread: { id: string };
}

async function start(script: Script): Promise<TestPanad> {
	dir = mkdtempSync(join(tmpdir(), "pana-live-web-"));
	t = await startTestPanad({ script, config: { defaultModel: "faux/faux-1", timezone: "UTC" } });
	page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);
	await resizePage(1280, 900);
	await evaluatePage(`await until(() => window.__pana); return true;`);
	return t;
}

/** Step the fake clock, so pi-durable's 100 ms progress commits and the 250 ms throttle fire. */
async function until(check: () => Promise<boolean>, what: string, stepMs = 50): Promise<void> {
	const end = Date.now() + 20_000;
	for (;;) {
		await t!.clock.advance(stepMs);
		await sessionRuntime(t!.runtime).idle();
		if (await check()) return;
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 30));
	}
}

async function state(sessionId: string): Promise<string> {
	return (await t!.client.get<{ session: { state: string } }>(`/sessions/${sessionId}`)).body.session.state;
}

describeBrowser("pana session view in a browser", () => {
	it("UX-11 assistant text and thinking render as sanitized Markdown, and Raw shows each entry's exact source", async () => {
		const text = [
			"# Disk report",
			"",
			"All **fine**, see [the inbox](pana://test.example/users/tester).",
			"",
			'<img src="x" onerror="window.__pwned = true">',
			"<!-- a note the renderer hides -->",
		].join("\n");
		await start([{ thinking: "Think *carefully* first.", text }]);
		const res = await t!.client.post<Created>("/sessions", { prompt: "report", cwd: dir });
		expect(res.status).toBe(201);
		const sessionId = res.body.session.id;
		await until(async () => (await state(sessionId)) === "idle", "the answer");

		const rendered = await evaluatePage<{
			heading: string;
			bold: string;
			href: string | null;
			handlers: number;
			pwned: boolean;
			thinkingOpen: boolean;
			emphasis: string;
			hidden: boolean;
		}>(`
			location.hash = "#/sessions/${sessionId}";
			await until(() => document.querySelector("#transcript [data-testid=entry-text] h1"));
			const body = document.querySelector("#transcript [data-testid=entry-text]");
			const thinking = document.querySelector("#transcript [data-testid=entry-thinking]");
			return {
				heading: body.querySelector("h1").textContent,
				bold: body.querySelector("strong").textContent,
				href: body.querySelector("a")?.getAttribute("href") ?? null,
				handlers: body.querySelectorAll("[onerror]").length,
				pwned: Boolean(window.__pwned),
				thinkingOpen: thinking.open,
				emphasis: thinking.querySelector("em")?.textContent ?? "",
				hidden: body.textContent.includes("a note the renderer hides"),
			};
		`);
		expect(rendered).toEqual({
			heading: "Disk report",
			bold: "fine",
			href: "#/inbox",
			handlers: 0,
			pwned: false,
			thinkingOpen: false,
			emphasis: "carefully",
			hidden: false,
		});

		// Raw shows the exact source of that entry, in a <pre>, and toggles back.
		const raw = await evaluatePage<{ tag: string; text: string; bodyHidden: boolean; others: number; back: boolean }>(`
			const entry = document.querySelector("#transcript [data-testid=entry-text]").closest("[data-testid=entry]");
			entry.querySelector("[data-testid=entry-raw-toggle]").click();
			const raw = entry.querySelector("[data-testid=entry-raw]");
			const shown = { tag: raw.tagName, text: raw.textContent, bodyHidden: entry.querySelector(".entry-body").hidden, others: document.querySelectorAll("#transcript [data-testid=entry-raw]:not([hidden])").length };
			entry.querySelector("[data-testid=entry-raw-toggle]").click();
			return { ...shown, back: raw.hidden && !entry.querySelector(".entry-body").hidden };
		`);
		expect(raw.tag).toBe("PRE");
		expect(raw.text).toContain("Think *carefully* first.");
		expect(raw.text).toContain(text);
		expect(raw.bodyHidden).toBe(true);
		expect(raw.others).toBe(1);
		expect(raw.back).toBe(true);
		expect(TEST_DOMAIN).toBe("test.example");
	});

	it("UX-12 a held turn streams thinking and text, a running tool shows its elapsed time, and committed entries replace both", async () => {
		await start([]);
		const command = `echo started; while [ ! -f "${dir}/go" ]; do echo tick; sleep 0.2; done; echo finished`;
		t!.model.append([
			{ thinking: "Weighing the **disk** check.", text: "Checking the disk now.", toolCalls: [{ name: "bash", args: { command } }] },
			{ text: "The disk is fine." },
		]);
		// The answer streams in full, but its final event waits: the turn is held open.
		const release = t!.model.gate({ at: "end" });
		const res = await t!.client.post<Created>("/sessions", { prompt: "check the disk", cwd: dir });
		expect(res.status).toBe(201);
		const { id: sessionId } = res.body.session;
		await evaluatePage(`location.hash = "#/sessions/${sessionId}"; await until(() => !document.getElementById("session").hidden); return true;`);

		await until(
			() => evaluatePage<boolean>(`return Boolean(document.querySelector("[data-testid=live-thinking] strong") && document.querySelector("[data-testid=live-text]"));`),
			"the streamed thinking and text",
		);
		const streaming = await evaluatePage<{ thinking: string; open: boolean; text: string; call: string; committed: string[] }>(`
			const thinking = document.querySelector("[data-testid=live-thinking]");
			return {
				thinking: thinking.textContent,
				open: thinking.open,
				text: document.querySelector("[data-testid=live-text]").textContent,
				call: document.querySelector("[data-testid=live-generation] [data-testid=entry-tool-call] pre")?.textContent ?? "",
				committed: [...document.querySelectorAll("#transcript [data-testid=entry]")].map((el) => el.dataset.kind),
			};
		`);
		expect(streaming.thinking).toContain("Weighing the disk check.");
		expect(streaming.open).toBe(true);
		expect(streaming.text).toContain("Checking the disk now.");
		expect(streaming.call).toContain("echo started");
		// Nothing of the answer is committed yet: what shows is the stream.
		expect(streaming.committed).not.toContain("pi.assistant");

		// The answer lands and the tool runs: its name, full arguments, output, and elapsed time.
		release();
		await until(
			() => evaluatePage<boolean>(`return Boolean(document.querySelector("[data-testid=live-tool-output]")?.textContent.includes("started"));`),
			"the running tool",
		);
		const replaced = await evaluatePage<{ generation: boolean; assistant: number }>(`
			return {
				generation: Boolean(document.querySelector("[data-testid=live-generation]")),
				assistant: [...document.querySelectorAll("#transcript [data-testid=entry]")].filter((el) => el.dataset.kind === "pi.assistant").length,
			};
		`);
		expect(replaced).toEqual({ generation: false, assistant: 1 });

		await t!.clock.advance(180_000);
		await until(
			() => evaluatePage<boolean>(`return /bash · running · 3m/.test(document.querySelector("[data-testid=live-tool-meta]")?.textContent ?? "");`),
			"three minutes of elapsed time",
		);
		const tool = await evaluatePage<{ name: string; args: string; output: string }>(`
			const tool = document.querySelector("[data-testid=live-tool]");
			return { name: tool.dataset.tool, args: tool.querySelector("[data-testid=entry-tool-call] pre").textContent, output: tool.querySelector("[data-testid=live-tool-output]").textContent };
		`);
		expect(tool.name).toBe("bash");
		expect(JSON.parse(tool.args)).toEqual({ command });
		expect(tool.output).toContain("tick");

		// The thread's working chip says what the session is doing.
		await evaluatePage(`location.hash = "#/threads/${res.body.thread.id}"; await until(() => !document.getElementById("thread").hidden); return true;`);
		await until(
			() => evaluatePage<boolean>(`return /running bash · 3m/.test(document.querySelector("[data-testid=working-activity]")?.textContent ?? "");`),
			"the working chip",
		);

		// The tool and the run finish: the committed entries replace every in-progress block.
		await evaluatePage(`location.hash = "#/sessions/${sessionId}"; await until(() => !document.getElementById("session").hidden); return true;`);
		writeFileSync(join(dir!, "go"), "");
		await until(async () => (await state(sessionId)) === "idle", "the run to end");
		await until(
			() => evaluatePage<boolean>(`return document.getElementById("transcript").textContent.includes("The disk is fine.") && document.getElementById("transcript-live").hidden;`),
			"the committed entries",
		);
		const done = await evaluatePage<{ live: number; result: string; answer: string; badge: string }>(`
			return {
				badge: document.querySelector("#session-meta .badge").textContent,
				live: document.querySelectorAll("[data-testid^=live-]").length,
				result: document.querySelector("#transcript [data-testid=entry-tool-result]").textContent,
				answer: [...document.querySelectorAll("#transcript [data-testid=entry-text]")].at(-1).textContent,
			};
		`);
		expect(done.live).toBe(0);
		expect(done.badge).toBe("idle");
		expect(done.result).toContain("finished");
		expect(done.answer).toContain("The disk is fine.");
	});
});
