// ART-11 in a real browser: publish one version, open its capability URL in Chrome, and prove
// from inside the served build that ART-09's headers and ART-10's sandbox are what the SPEC says.
// A module (with its own import), a CSS import, a font, a JSON fetch, and an image all load; the
// opaque origin refuses localStorage, cookies, a service worker, and reading a panad API answer;
// a no-cors request still arrives and panad's bearer check refuses it without writing a row.
// Needs the installed Chrome and chrome-devtools, so it runs with `npm run test:web`, not `npm test`.

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { request } from "../../src/api/client.ts";
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

const HERE = new URL("../../web/", import.meta.url);
const PNG = readFileSync(new URL("icon-192.png", HERE));
const FONT = readFileSync(new URL("fonts/departure-mono-regular.woff2", HERE));

const INDEX = `<!doctype html>
<html>
<head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head>
<body>
<p id="css-probe">stylesheet probe</p>
<p id="font-probe" style="font-family: probe">font probe</p>
<img id="logo" src="./img/logo.png" alt="">
<script type="module" src="./app.js"></script>
</body>
</html>`;

// The imported sheet runs before the importing one's own rules, so the background proves the
// @import applied and the border proves style.css itself arrived.
const STYLE = `@import "./theme.css";
#css-probe { border-top-color: rgb(4, 5, 6); border-top-style: solid; }
`;
const THEME = `@font-face { font-family: probe; src: url("./fonts/probe.woff2") format("woff2"); }
#css-probe { background-color: rgb(1, 2, 3); }
`;
const DEP = `export function reached() { window.__dep = true; return "dep"; }
`;
const APP = `import { reached } from "./dep.js";

async function probe() {
	const out = { module: reached(), dep: window.__dep };
	// The version's own JSON, fetched from the opaque origin. The artifact response's CORS header
	// is what lets the bytes be read.
	try {
		const res = await fetch("./data.json");
		out.json = (await res.json()).ok;
	} catch (error) { out.json = error.name + ": " + error.message; }
	try {
		const img = new Image();
		img.src = "./img/logo.png";
		await img.decode();
		out.image = img.naturalWidth;
	} catch (error) { out.image = error.name + ": " + error.message; }
	try {
		const faces = await document.fonts.load("12px probe");
		out.font = faces.length ? faces[0].status : "none";
	} catch (error) { out.font = error.name + ": " + error.message; }
	out.css = getComputedStyle(document.querySelector("#css-probe")).backgroundColor;
	// ART-10: the opaque origin refuses the reader's storage and identity.
	try { window.localStorage.setItem("probe", "1"); out.localStorage = "allowed"; }
	catch (error) { out.localStorage = error.name; }
	try { void document.cookie; out.cookie = "allowed"; }
	catch (error) { out.cookie = error.name; }
	try {
		if (!navigator.serviceWorker) out.serviceWorker = "unavailable";
		else { await navigator.serviceWorker.register("./sw.js"); out.serviceWorker = "allowed"; }
	} catch (error) { out.serviceWorker = error.name; }
	try { await fetch("/inbox"); out.apiRead = "allowed"; }
	catch (error) { out.apiRead = error.name; }
	// A no-cors request is not blocked by the sandbox; it arrives and the bearer check refuses it.
	try { const res = await fetch("/inbox", { mode: "no-cors" }); out.noCors = res.type + ":" + res.status; }
	catch (error) { out.noCors = error.name; }
	try {
		const res = await fetch("/sessions", { method: "POST", mode: "no-cors", body: "{}" });
		out.noCorsWrite = res.type + ":" + res.status;
	} catch (error) { out.noCorsWrite = error.name; }
	out.origin = self.origin;
	window.__probe = out;
}
probe().catch((error) => { window.__probe = { failed: error.name + ": " + error.message }; });
`;

interface Uploaded {
	file: { id: string };
}
interface Published {
	artifact: { id: string };
	version: { id: string; seq: number; entry: string; files: Array<{ path: string; fileId: string }> };
	created: boolean;
	previewUrl: string;
	expiresAt: number;
}

const ARTIFACT_HEADERS = {
	"content-security-policy": "sandbox allow-scripts",
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
	"access-control-allow-origin": "*",
};

describeBrowser("artifact sandbox", () => {
	it("ART-11 serves a sandboxed build whose assets load and whose origin cannot read pana or its own reader", async () => {
		t = await startTestPanad({ config: { defaultModel: "faux/faux-1", timezone: "UTC" } });
		const thread = await t.client.post<{ thread: { id: string } }>("/threads", {
			body: "Build the probe page.",
			subject: "Artifact probe",
		});
		expect(thread.status, JSON.stringify(thread.body)).toBe(201);
		const threadId = thread.body.thread.id;

		const upload = async (name: string, bytes: Uint8Array | string): Promise<string> => {
			const res = await t!.client.post<Uploaded>(`/files?name=${encodeURIComponent(name)}`, undefined, {
				bytes: typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes,
			});
			expect(res.status, JSON.stringify(res.body)).toBe(201);
			return res.body.file.id;
		};
		const files: Record<string, string> = {
			"index.html": await upload("index.html", INDEX),
			"style.css": await upload("style.css", STYLE),
			"theme.css": await upload("theme.css", THEME),
			"app.js": await upload("app.js", APP),
			"dep.js": await upload("dep.js", DEP),
			"data.json": await upload("data.json", `{"ok":true}`),
			"img/logo.png": await upload("logo.png", PNG),
			"fonts/probe.woff2": await upload("probe.woff2", FONT),
		};
		const manifest = (overrides: Record<string, string> = {}) => ({
			entry: "index.html",
			files: Object.entries({ ...files, ...overrides }).map(([path, fileId]) => ({ path, fileId })),
		});

		const published = await t.client.post<Published>(`/threads/${threadId}/artifacts/probe`, manifest());
		expect(published.status, JSON.stringify(published.body)).toBe(201);
		expect(published.body.created).toBe(true);
		expect(published.body.version.seq).toBe(1);
		expect(published.body.version.entry).toBe("index.html");
		expect(published.body.previewUrl).toContain(`/a/${published.body.version.id}/`);
		expect(published.body.expiresAt).toBeGreaterThan(0);

		// ART-09: every byte is a credential-free, unredirected 200 with the four headers and a
		// type chosen by extension, never by sniffing. These calls carry no bearer token.
		const port = t.panad.tcpPort!;
		const origin = loopbackOrigin(port);
		const anonymous = (path: string) =>
			request({ host: "127.0.0.1", port, hostHeader: "127.0.0.1" }, "GET", path);
		const capabilityPath = new URL(published.body.previewUrl).pathname;
		for (const [path, type] of [
			["", "text/html"],
			["style.css", "text/css"],
			["app.js", "text/javascript"],
			["dep.js", "text/javascript"],
			["data.json", "application/json"],
			["img/logo.png", "image/png"],
			["fonts/probe.woff2", "font/woff2"],
		] as const) {
			const bytes = await anonymous(capabilityPath + path);
			expect(bytes.status, `${path}: ${JSON.stringify(bytes.body)}`).toBe(200);
			expect(bytes.headers["content-type"]).toBe(type);
			for (const [name, value] of Object.entries(ARTIFACT_HEADERS)) {
				expect(bytes.headers[name], `${path}: ${name}`).toBe(value);
			}
		}

		// ART-11: a missing capability, a foreign version's capability, and a path outside the
		// manifest are refused. A second, genuinely different manifest gives the foreign version.
		const second = await t.client.post<Published>(
			`/threads/${threadId}/artifacts/probe`,
			manifest({ "index.html": await upload("index-2.html", INDEX.replace("stylesheet probe", "second version")) }),
		);
		expect(second.status, JSON.stringify(second.body)).toBe(201);
		expect(second.body.version.id).not.toBe(published.body.version.id);
		const capability = capabilityPath.split("/")[3]!;
		const missing = await anonymous(`/a/${published.body.version.id}/`);
		expect(missing.status).toBe(403);
		const foreign = await anonymous(`/a/${second.body.version.id}/${capability}/`);
		expect(foreign.status).toBe(403);
		const outside = await anonymous(`${capabilityPath}secret.txt`);
		expect(outside.status).toBe(404);

		// Rows before any artifact code runs in Chrome. The hostile requests below must add none.
		const counts = async () => {
			const tables = ["sessions", "threads", "messages", "files", "artifacts", "artifact_versions", "artifact_version_files"];
			const out: Record<string, number> = {};
			for (const table of tables) out[table] = (await t!.runtime.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))!.n;
			return out;
		};
		const before = await counts();

		// ART-10, measured inside the served document.
		page = await newPage(`${origin}${capabilityPath}`);
		const probe = await evaluatePage<Record<string, unknown>>(`
			const result = await until(() => window.__probe);
			return { ...result, origin: self.origin };
		`);
		expect(probe.failed, JSON.stringify(probe)).toBeUndefined();
		// Every kind of subresource loads from the opaque origin.
		expect(probe.module).toBe("dep");
		expect(probe.dep).toBe(true);
		expect(probe.json).toBe(true);
		expect(probe.image).toBe(192);
		expect(probe.font).toBe("loaded");
		expect(probe.css).toBe("rgb(1, 2, 3)");
		// The sandbox is an opaque origin that refuses the reader's storage and identity.
		expect(probe.origin).toBe("null");
		expect(probe.localStorage).toBe("SecurityError");
		expect(probe.cookie).toBe("SecurityError");
		expect(["SecurityError", "unavailable"]).toContain(probe.serviceWorker);
		// It cannot read an API answer, even one it is allowed to request.
		expect(probe.apiRead).toBe("TypeError");
		// It can send a no-cors request. panad's bearer check refuses it, and nothing is written.
		expect(probe.noCors).toBe("opaque:0");
		expect(probe.noCorsWrite).toBe("opaque:0");
		expect(await counts()).toEqual(before);
	});
});
