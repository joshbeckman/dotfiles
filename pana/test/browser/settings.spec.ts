import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { loopbackOrigin } from "../../src/web/static.ts";
import { startTestPanad, type TestPanad } from "../harness/index.ts";
import { chromeDevtoolsAvailable, closePage, emulateViewport, evaluatePage, newPage, screenshot } from "./cli.ts";

const describeBrowser = chromeDevtoolsAvailable() ? describe : describe.skip;
let t: TestPanad | undefined;
let page: number | undefined;
afterEach(async () => {
	if (page !== undefined) { await emulateViewport(""); await closePage(page); }
	await t?.close();
	t = undefined;
	page = undefined;
});

/** A real test-domain shell with deterministic settings responses: never restart the live daemon. */
describeBrowser("settings", () => {
	it("edits full JSON safely, keeps drafts on refresh/conflict, and confirms daemon restart", async () => {
		t = await startTestPanad();
		page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);
		const loaded = await evaluatePage<{ text: string; disabled: boolean; age: string }>(`
			await until(() => document.querySelector('#nav a[aria-current="page"]'));
			const realFetch = window.fetch.bind(window);
			window.settingsCalls = [];
			window.settingsFixture = {
				config: {domain:"test.example",user:"tester",future:{enabled:true},maxDailyUsd:10},
				configPath:"/tmp/pana-test/config.json",configRevision:"revision-1",configRequiresRestart:false,
				source:{sha:"1234567890abcdef1234567890abcdef12345678",message:"Add settings page",dirty:false,fingerprint:"source"},
				processes:[{role:"panad",pid:12345,startedAt:Date.now()-3661000,
					running:{sha:"abcdef1234567890abcdef1234567890abcdef12",message:"Previous daemon build",dirty:false,fingerprint:"running"}}],
				restartAvailable:true
			};
			window.fetch = async (path, options={}) => {
				if (path !== "/settings" && path !== "/settings/restart") return realFetch(path, options);
				window.settingsCalls.push({path,method:options.method,body:options.body ? JSON.parse(options.body) : null});
				if (window.settingsReject && options.method === "POST" && path === "/settings")
					return new Response(JSON.stringify({error:{message:"Configuration changed on disk"}}),{status:409});
				if (path === "/settings/restart") return new Response(JSON.stringify({restarting:true}),{status:202});
				if (options.method === "POST") {
					window.settingsFixture.config = JSON.parse(options.body).config;
					window.settingsFixture.configRevision = "revision-2";
					window.settingsFixture.configRequiresRestart = true;
				}
				return new Response(JSON.stringify(window.settingsFixture),{status:200});
			};
			location.hash = "#/settings";
			await until(() => document.getElementById("settings-config").value.includes("future"));
			return {text:document.getElementById("settings-processes").textContent,
				disabled:document.getElementById("settings-save").disabled,
				age:document.querySelector("#settings-processes [data-ticking]").textContent};
		`);
		expect(loaded.text).toContain("Out of sync");
		expect(loaded.text).toContain("Previous daemon build");
		expect(loaded.text).toContain("PID 12345");
		expect(loaded.age).toContain("Started");
		expect(loaded.age).toContain("running for");
		expect(loaded.disabled).toBe(true);
		const invalid = await evaluatePage<{ error: string; saves: number }>(`
			const editor = document.getElementById("settings-config");
			editor.value = "{"; editor.dispatchEvent(new Event("input"));
			document.getElementById("settings-form").requestSubmit();
			return {error:document.getElementById("settings-config-error").textContent,
				saves:window.settingsCalls.filter(c=>c.method==="POST").length};
		`);
		expect(invalid.error).toContain("Invalid JSON");
		expect(invalid.saves).toBe(0);
		const saved = await evaluatePage<{ body: any; notice: string; warning: string }>(`
			const editor = document.getElementById("settings-config");
			editor.value = JSON.stringify({...window.settingsFixture.config,maxDailyUsd:25});
			editor.dispatchEvent(new Event("input")); document.getElementById("settings-form").requestSubmit();
			await until(()=>document.getElementById("settings-status").textContent.includes("saved"));
			return {body:window.settingsCalls.find(c=>c.method==="POST").body,
				notice:document.getElementById("settings-status").textContent,
				warning:document.getElementById("settings-config-warning").textContent};
		`);
		expect(saved.body).toEqual({ config: { domain: "test.example", user: "tester", future: { enabled: true }, maxDailyUsd: 25 }, configRevision: "revision-1" });
		expect(saved.notice).toContain("Restart");
		expect(saved.warning).toContain("Restart required");
		if (process.env.PANA_SETTINGS_SHOTS) {
			mkdirSync(process.env.PANA_SETTINGS_SHOTS, { recursive: true });
			copyFileSync(await screenshot(true), join(process.env.PANA_SETTINGS_SHOTS, "settings-desktop.png"));
			await emulateViewport("390x844x1,mobile,touch", "dark");
			copyFileSync(await screenshot(true), join(process.env.PANA_SETTINGS_SHOTS, "settings-phone-dark.png"));
		}
		const conflict = await evaluatePage<{ draft: string; revision: string; error: string }>(`
			const editor = document.getElementById("settings-config");
			editor.value = JSON.stringify({...window.settingsFixture.config,maxDailyUsd:30}); editor.dispatchEvent(new Event("input"));
			window.settingsFixture.configRevision = "external-revision";
			document.getElementById("settings-refresh").click();
			await until(()=>document.getElementById("settings-status").textContent.includes("unsaved"));
			window.settingsReject=true;
			document.getElementById("settings-form").requestSubmit();
			await until(()=>!document.getElementById("settings-config-error").hidden);
			return {draft:editor.value,revision:window.settingsCalls.filter(c=>c.method==="POST").at(-1).body.configRevision,
				error:document.getElementById("settings-config-error").textContent};
		`);
		expect(JSON.parse(conflict.draft).maxDailyUsd).toBe(30);
		expect(conflict.revision).toBe("revision-2");
		expect(conflict.error).toContain("Your draft is kept");

		const restart = await evaluatePage<{ cancelled: number; requested: number; notice: string; disabled: boolean }>(`
			document.getElementById("settings-restart").click();
			if(document.getElementById("settings-restart-confirm").hidden) throw new Error("Missing confirmation");
			document.getElementById("settings-restart-no").click();
			const cancelled=window.settingsCalls.filter(c=>c.path==="/settings/restart").length;
			document.getElementById("settings-restart").click();
			document.getElementById("settings-restart-yes").click();
			await until(()=>document.getElementById("settings-status").textContent.includes("Restart requested"));
			return {cancelled,requested:window.settingsCalls.filter(c=>c.path==="/settings/restart").length,
				notice:document.getElementById("settings-status").textContent,disabled:document.getElementById("settings-restart").disabled};
		`);
		expect(restart.cancelled).toBe(0);
		expect(restart.requested).toBe(1);
		expect(restart.disabled).toBe(true);
		expect(restart.notice).toContain("Refresh status");
		const unavailable = await evaluatePage<{ text: string; disabled: boolean; source: string; overflow: boolean }>(`
			window.settingsFixture.restartAvailable=false;window.settingsFixture.restartReason="Not managed by the daemon entrypoint";
			window.settingsFixture.source=null;window.settingsFixture.processes[0].running=null;
			document.getElementById("settings-refresh").click();
			await until(()=>document.getElementById("settings-restart-reason").textContent.includes("Not managed"));
			return {text:document.getElementById("settings-restart-reason").textContent,
				disabled:document.getElementById("settings-restart").disabled,source:document.getElementById("settings-source").textContent,
				overflow:document.documentElement.scrollWidth>innerWidth};
		`);
		expect(unavailable.disabled).toBe(true);
		expect(unavailable.source).toContain("unavailable");
		expect(unavailable.overflow).toBe(false);
	});
});
