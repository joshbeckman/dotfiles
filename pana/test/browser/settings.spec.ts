import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { postNotice } from "../../src/threads/index.ts";
import { loopbackOrigin } from "../../src/web/static.ts";
import { participantColor } from "../../web/views.js";
import { createMemorySecrets, startTestPanad, type TestPanad } from "../harness/index.ts";
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
				config: {domain:"test.example",user:"tester",future:{enabled:true},ui:{userColor:"blue",future:{keep:true}},maxDailyUsd:10},
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
			if(!document.getElementById("settings-config-docs").href.endsWith("/pana/docs/configuration.md")) throw new Error("Missing config reference");
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
		const invalid = await evaluatePage<{ error: string; saves: number; colorDisabled: boolean }>(`
			const editor = document.getElementById("settings-config");
			editor.value = "{"; editor.dispatchEvent(new Event("input"));
			document.getElementById("settings-form").requestSubmit();
			return {error:document.getElementById("settings-config-error").textContent,
				saves:window.settingsCalls.filter(c=>c.method==="POST").length,
				colorDisabled:document.getElementById("settings-user-color").disabled};
		`);
		expect(invalid.error).toContain("Invalid JSON");
		expect(invalid.saves).toBe(0);
		expect(invalid.colorDisabled).toBe(true);
		const saved = await evaluatePage<{ body: any; notice: string; warning: string }>(`
			const editor = document.getElementById("settings-config");
			editor.value = JSON.stringify({...window.settingsFixture.config,maxDailyUsd:25});
			editor.dispatchEvent(new Event("input"));
			const select = document.getElementById("settings-user-color");
			if(select.value !== "blue") throw new Error("JSON did not update selector");
			select.value = "#1a2B3c80"; select.dispatchEvent(new Event("input"));
			const picker = document.getElementById("settings-user-color-picker");
			if(picker.type !== "color" || picker.value !== "#1a2b3c") throw new Error("Native color picker not synced");
			picker.value = "#abcdef"; picker.dispatchEvent(new Event("input"));
			if(select.value !== "#abcdef80") throw new Error("Picker lost hex alpha");
			if(document.getElementById("settings-color-preview").dataset.color !== "#abcdef80") throw new Error("Missing preview");
			document.getElementById("settings-form").requestSubmit();
			await until(()=>document.getElementById("settings-status").textContent.includes("saved"));
			return {body:window.settingsCalls.find(c=>c.method==="POST").body,
				notice:document.getElementById("settings-status").textContent,
				warning:document.getElementById("settings-config-warning").textContent};
		`);
		expect(saved.body).toEqual({ config: { domain: "test.example", user: "tester", future: { enabled: true }, ui: { userColor: "#abcdef80", future: { keep: true } }, maxDailyUsd: 25 }, configRevision: "revision-1" });
		expect(saved.notice).toContain("Restart");
		expect(saved.warning).toContain("Restart required");
		const conflict = await evaluatePage<{ draft: string; revision: string; error: string; color: string }>(`
			const editor = document.getElementById("settings-config");
			editor.value = JSON.stringify({...window.settingsFixture.config,maxDailyUsd:30,ui:{...window.settingsFixture.config.ui,userColor:"purple"}}); editor.dispatchEvent(new Event("input"));
			window.settingsFixture.configRevision = "external-revision";
			document.getElementById("settings-refresh").click();
			await until(()=>document.getElementById("settings-status").textContent.includes("unsaved"));
			window.settingsReject=true;
			document.getElementById("settings-form").requestSubmit();
			await until(()=>!document.getElementById("settings-config-error").hidden);
			return {draft:editor.value,revision:window.settingsCalls.filter(c=>c.method==="POST").at(-1).body.configRevision,
				error:document.getElementById("settings-config-error").textContent,color:document.getElementById("settings-user-color").value};
		`);
		expect(conflict.color).toBe("purple");
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
	it("applies hello and cross-window settings.ui to existing user nodes without replacing messages or drafts", async () => {
		t = await startTestPanad({ config: { ui: { userColor: "red" } } });
		const notice = await postNotice(t.runtime, { body: "Color test notice" });
		const sessionId = t.runtime.newId();
		const sessionUrl = t.runtime.url({ kind: "session", id: sessionId });
		const now = t.clock.now();
		await t.runtime.db.write(async (tx) => {
			await tx.run("INSERT INTO participants (id, kind, url, created_at) VALUES (?, 'session', ?, ?)", sessionId, sessionUrl, now);
			await tx.run("INSERT INTO sessions (id, state, depth, created_at, updated_at) VALUES (?, 'stopped', 0, ?, ?)", sessionId, now, now);
		});
		const sent = await t.client.post<any>(`/threads/${notice.thread.id}/messages`, { after: notice.message.id, body: "My colored message", cc: [sessionId] });
		expect(sent.status).toBe(200);
		expect((await t.client.post(`/threads/${notice.thread.id}/messages`, { after: sent.body.message.id, body: "Session identity stays stable" }, { caller: sessionId })).status).toBe(200);
		page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);
		expect(await evaluatePage(`
			location.hash = "#/threads/${notice.thread.id}";
			await until(() => document.querySelector('#thread-messages .message[data-user-color="true"]'));
			window.colorUser = document.querySelector('#thread-messages .message[data-user-color="true"]');
			window.colorDomain = document.querySelector('#thread-messages .message[data-user-color="false"]');
			window.colorSession = document.querySelector('#thread-messages .message[data-sender="${sessionUrl}"]');
			window.colorSessionIdentity = {color:window.colorSession.dataset.color,pattern:window.colorSession.dataset.pattern,border:getComputedStyle(window.colorSession).borderLeftColor};
			if(window.colorSessionIdentity.color !== ${JSON.stringify(participantColor({ url: sessionUrl, kind: "session" }, { participants: sent.body.thread.participants, threadId: notice.thread.id }))}) throw new Error("Thread-local session color missing");
			window.colorHead = window.__pana.state.draft.after;
			document.getElementById("reply-body").value = "Keep my draft";
			return {user:window.colorUser.dataset.color,domain:window.colorDomain.dataset.color};
		`)).toEqual({ user: "red", domain: "black" });
		if (process.env.PANA_SETTINGS_SHOTS) {
			mkdirSync(process.env.PANA_SETTINGS_SHOTS, { recursive: true });
			copyFileSync(await screenshot(true), join(process.env.PANA_SETTINGS_SHOTS, "thread-color-before.png"));
		}
		const settings = await t.client.get<any>("/settings");
		const saved = await t.client.post("/settings", {
			config: { ...settings.body.config, ui: { ...settings.body.config.ui, userColor: "#AbC123" } },
			configRevision: settings.body.configRevision,
		});
		expect(saved.status).toBe(200);
		expect(await evaluatePage(`
			await until(() => window.colorUser.dataset.color === "#AbC123");
			if(window.colorUser.style.getPropertyValue("--who") !== "#AbC123") throw new Error("Custom CSS color not applied");
			const identity = {color:window.colorSession.dataset.color,pattern:window.colorSession.dataset.pattern,border:getComputedStyle(window.colorSession).borderLeftColor};
			if(JSON.stringify(identity) !== JSON.stringify(window.colorSessionIdentity)) throw new Error("User color changed session identity");
			return {same:window.colorUser === document.querySelector('#thread-messages .message[data-user-color="true"]'),
				domain:window.colorDomain.dataset.color,draft:document.getElementById("reply-body").value,
				head:window.colorHead === window.__pana.state.draft.after,
				all:[...document.querySelectorAll('[data-user-color="true"]')].every(n=>n.dataset.color === "#AbC123")};
		`)).toEqual({ same: true, domain: "black", draft: "Keep my draft", head: true, all: true });
		if (process.env.PANA_SETTINGS_SHOTS) copyFileSync(await screenshot(true), join(process.env.PANA_SETTINGS_SHOTS, "thread-color-after.png"));
		expect(await evaluatePage(`
			location.hash = "#/settings";
			await until(() => !document.getElementById("settings-config").disabled);
			const color = document.getElementById("settings-user-color");
			color.value = "#12345678"; color.dispatchEvent(new Event("input"));
			if(window.colorUser.dataset.color !== "#AbC123") throw new Error("Unsaved preview changed messages");
			document.getElementById("settings-form").requestSubmit();
			await until(() => document.getElementById("settings-status").textContent.includes("saved"));
			return {user:window.colorUser.dataset.color,domain:window.colorDomain.dataset.color};
		`)).toEqual({ user: "#12345678", domain: "black" });
		// Mobile emulation can reload the page; capture last, after all fixture/draft assertions.
		if (process.env.PANA_SETTINGS_SHOTS) {
			copyFileSync(await screenshot(true), join(process.env.PANA_SETTINGS_SHOTS, "settings-desktop.png"));
			await emulateViewport("390x844x1,mobile,touch", "dark");
			await evaluatePage(`await until(() => document.getElementById("settings-user-color").value === "#12345678" && !document.getElementById("settings-config").disabled); return true;`);
			copyFileSync(await screenshot(true), join(process.env.PANA_SETTINGS_SHOTS, "settings-phone-dark.png"));
		}
	});
	it("sets and removes a secret without ever showing the value again", async () => {
		t = await startTestPanad({ secrets: createMemorySecrets() });
		page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);
		const saved = await evaluatePage<{ value: string; hint: string; rows: string[]; leaked: boolean; reached: number }>(`
			let reached = 0;
			const realFetch = window.fetch.bind(window);
			window.fetch = (path, options) => { if (path === "/secrets") reached++; return realFetch(path, options); };
			// The boot redirects to its own first route; navigate only once that has settled.
			await until(() => document.querySelector('#nav a[aria-current="page"]'));
			location.hash = "#/settings";
			await until(() => !document.getElementById("settings-secret-name").disabled);
			const name = document.getElementById("settings-secret-name");
			const value = document.getElementById("settings-secret-value");
			if (value.type !== "password") throw new Error("The value field is not masked");
			if (document.querySelector("#settings-secret-reveal")) throw new Error("A control can reveal the value");
			value.value = "typed but unsaved";
			document.getElementById("settings-secret-clear").click();
			if (value.value !== "") throw new Error("Clear did not empty the value");
			value.value = "typed but unsaved";
			location.hash = "#/inbox";
			await until(() => value.value === "");
			if (!document.getElementById("view-settings").hidden) throw new Error("Still on settings after navigating away");
			location.hash = "#/settings";
			await until(() => !document.getElementById("settings-secret-name").disabled);
			name.value = "GARMIN_PASSWORD";
			value.value = "hunter2 corrected";
			document.getElementById("settings-secret-form").requestSubmit();
			await until(() => document.getElementById("settings-secrets-list").textContent.includes("GARMIN_PASSWORD"));
			return {value: value.value, hint: document.getElementById("settings-secret-hint").textContent,
				rows: [...document.querySelectorAll(".settings-secret")].map((row) => row.dataset.name),
				leaked: document.body.textContent.includes("hunter2 corrected"), reached};
		`);
		expect(saved.value).toBe("");
		expect(saved.rows).toEqual(["GARMIN_PASSWORD"]);
		expect(saved.hint).toContain("saved to the s store");
		// The value is stored, and nothing the page renders holds it again.
		expect(saved.leaked).toBe(false);
		expect(saved.reached).toBeGreaterThan(0);
		expect(await t.runtime.secrets.list()).toEqual(["GARMIN_PASSWORD"]);
		if (process.env.PANA_SETTINGS_SHOTS) {
			mkdirSync(process.env.PANA_SETTINGS_SHOTS, { recursive: true });
			copyFileSync(await screenshot(true), join(process.env.PANA_SETTINGS_SHOTS, "settings-secrets.png"));
		}
		const refused = await evaluatePage<string>(`
			const name = document.getElementById("settings-secret-name");
			name.value = "bad-name";
			document.getElementById("settings-secret-value").value = "x";
			document.getElementById("settings-secret-form").requestSubmit();
			return document.getElementById("settings-secret-error").textContent;
		`);
		expect(refused).toContain("letters, digits, and underscores");
		const removed = await evaluatePage<{ rows: string[]; state: string }>(`
			const row = document.querySelector('.settings-secret[data-name="GARMIN_PASSWORD"]');
			row.querySelector("button").click();
			if (!row.querySelector(".confirm")) throw new Error("Remove did not ask first");
			row.querySelector(".confirm .danger").click();
			await until(() => document.getElementById("settings-secrets-list").textContent === "");
			return {rows: [...document.querySelectorAll(".settings-secret")].map((item) => item.dataset.name),
				state: document.getElementById("settings-secrets-state").textContent};
		`);
		expect(removed.rows).toEqual([]);
		expect(removed.state).toBe("No secrets stored yet.");
		expect(await t.runtime.secrets.list()).toEqual([]);
		if (process.env.PANA_SETTINGS_SHOTS) {
			await emulateViewport("390x844x1,mobile,touch", "dark");
			await evaluatePage(`await until(() => !document.getElementById("settings-secret-name").disabled); return true;`);
			copyFileSync(await screenshot(true), join(process.env.PANA_SETTINGS_SHOTS, "settings-secrets-phone-dark.png"));
		}
	});
});
