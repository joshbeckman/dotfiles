// ART-09, ART-10, and ART-11 in a real browser, against a real panad.
//
// ART-09 is the byte contract: every artifact response, credential-free, carries the sandbox
// policy, nosniff, no-referrer, and `*` CORS, does not redirect, and picks its type from an
// extension allowlist rather than sniffing.
// ART-10 is the sandbox contract, measured in both contexts a preview is shown in: a top-level
// tab and a frame on the app's origin. The opaque origin refuses localStorage, cookies, a service
// worker, the parent document, and reading a panad API answer; a no-cors request still arrives and
// the bearer check refuses it without writing a row.
// ART-11 is the served build: a module (with its own import), a CSS import, a font, a JSON fetch,
// and an image all load inside Chrome, and a missing capability, a foreign version's capability,
// and a path outside the manifest are refused.
// Needs the installed Chrome and chrome-devtools, so it runs with `npm run test:web`, not `npm test`.

import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { request } from "../../src/api/client.ts";
import { loopbackOrigin } from "../../src/web/static.ts";
import { startTestPanad, type TestPanad } from "../harness/index.ts";
import { chromeDevtoolsAvailable, closePage, evaluatePage, newPage } from "./cli.ts";

const describeBrowser = chromeDevtoolsAvailable() ? describe : describe.skip;

let t: TestPanad;
let page: number | undefined;
let origin: string;
let capabilityPath: string;
let versionId: string;
let secondVersionId: string;

afterEach(async () => {
	if (page !== undefined) await closePage(page);
	page = undefined;
});
afterAll(async () => {
	await t?.close();
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
	// ART-10: the opaque origin refuses the reader's storage, identity, and parent document.
	try { window.localStorage.setItem("probe", "1"); out.localStorage = "allowed"; }
	catch (error) { out.localStorage = error.name; }
	try { void document.cookie; out.cookie = "allowed"; }
	catch (error) { out.cookie = error.name; }
	try {
		if (!navigator.serviceWorker) out.serviceWorker = "unavailable";
		else { await navigator.serviceWorker.register("./sw.js"); out.serviceWorker = "allowed"; }
	} catch (error) { out.serviceWorker = error.name; }
	try {
		if (window.parent === window) out.parentRead = "self";
		else { void window.parent.document.title; out.parentRead = "allowed"; }
	} catch (error) { out.parentRead = error.name; }
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
	// ART-10's frame context: the parent gets the same measurement, because the opaque origin
	// makes its own document unreadable to the parent.
	if (window.parent !== window) window.parent.postMessage({ panaProbe: out }, "*");
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

// The SPEC's whole allowlist, so a missing or mis-cased mapping fails the test.
const TYPES: ReadonlyArray<readonly [string, string]> = [
	["index.html", "text/html"],
	["probe.css", "text/css"],
	["probe.js", "text/javascript"],
	["probe.mjs", "text/javascript"],
	["probe.json", "application/json"],
	["probe.wasm", "application/wasm"],
	["probe.svg", "image/svg+xml"],
	["probe.png", "image/png"],
	["probe.jpeg", "image/jpeg"],
	["probe.gif", "image/gif"],
	["probe.webp", "image/webp"],
	["probe.avif", "image/avif"],
	["probe.woff2", "font/woff2"],
	["probe.txt", "text/plain"],
	["probe.md", "text/markdown"],
];

async function upload(name: string, bytes: Uint8Array | string): Promise<string> {
	const res = await t.client.post<Uploaded>(`/files?name=${encodeURIComponent(name)}`, undefined, {
		bytes: typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes,
	});
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.file.id;
}

/** A GET with no bearer token and no cookie: the only credential is the capability path. */
function anonymous(path: string) {
	return request({ host: "127.0.0.1", port: t.panad.tcpPort!, hostHeader: "127.0.0.1" }, "GET", path);
}

function expectHeaders(headers: Record<string, string | string[] | undefined>, what: string): void {
	for (const [name, value] of Object.entries(ARTIFACT_HEADERS)) expect(headers[name], `${what}: ${name}`).toBe(value);
}

function expectSandbox(probe: Record<string, unknown>, where: string): void {
	expect(probe.failed, `${where}: ${JSON.stringify(probe)}`).toBeUndefined();
	expect(probe.origin, where).toBe("null");
	expect(probe.localStorage, where).toBe("SecurityError");
	expect(probe.cookie, where).toBe("SecurityError");
	expect(["SecurityError", "unavailable"], where).toContain(probe.serviceWorker);
	expect(probe.apiRead, where).toBe("TypeError");
	expect(probe.noCors, where).toBe("opaque:0");
	expect(probe.noCorsWrite, where).toBe("opaque:0");
}

async function counts(): Promise<Record<string, number>> {
	const tables = ["sessions", "threads", "messages", "files", "artifacts", "artifact_versions", "artifact_version_files"];
	const out: Record<string, number> = {};
	for (const table of tables) out[table] = (await t.runtime.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))!.n;
	return out;
}

describeBrowser("artifact sandbox", () => {
	beforeAll(async () => {
		t = await startTestPanad({ config: { defaultModel: "faux/faux-1", timezone: "UTC" } });
		const thread = await t.client.post<{ thread: { id: string } }>("/threads", {
			body: "Build the probe page.",
			subject: "Artifact probe",
		});
		expect(thread.status, JSON.stringify(thread.body)).toBe(201);
		const threadId = thread.body.thread.id;
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
		origin = loopbackOrigin(t.panad.tcpPort!);
		capabilityPath = new URL(published.body.previewUrl).pathname;
		versionId = published.body.version.id;
		// A genuinely different manifest, not just a new note (ART-03 answers an identical one with
		// the existing version), so the foreign-capability case has its own version.
		const second = await t.client.post<Published>(
			`/threads/${threadId}/artifacts/probe`,
			manifest({ "index.html": await upload("index-2.html", INDEX.replace("stylesheet probe", "second version")) }),
		);
		expect(second.status, JSON.stringify(second.body)).toBe(201);
		expect(second.body.version.id).not.toBe(versionId);
		secondVersionId = second.body.version.id;
	});

	it("ART-09 serves every artifact byte with the sandbox headers, no redirect, and a type from the extension allowlist", async () => {
		const thread = await t.client.post<{ thread: { id: string } }>("/threads", { body: "Types.", subject: "Artifact types" });
		const threadId = thread.body.thread.id;
		const manifest: Array<{ path: string; fileId: string }> = [];
		for (const [path] of TYPES) manifest.push({ path, fileId: await upload(path, `probe bytes for ${path}`) });
		const published = await t.client.post<Published>(`/threads/${threadId}/artifacts/types`, { entry: "index.html", files: manifest });
		expect(published.status, JSON.stringify(published.body)).toBe(201);
		const path = new URL(published.body.previewUrl).pathname;

		for (const [name, type] of TYPES) {
			// The root serves the entry; every other type is fetched by its own path.
			const bytes = await anonymous(name === "index.html" ? path : path + name);
			expect(bytes.status, `${name}: ${JSON.stringify(bytes.body)}`).toBe(200);
			expect(bytes.headers["content-type"], name).toBe(type);
			expectHeaders(bytes.headers, name);
		}

		// Every artifact response, including a refusal, carries the policy headers.
		const missing = await anonymous(path + "not-in-the-manifest.txt");
		expect(missing.status).toBe(404);
		expectHeaders(missing.headers, "404");
	});

	it("ART-10 refuses the reader's storage, identity, parent, and API answer in a tab and in a frame", async () => {
		const before = await counts();

		// The tab: navigate to the capability URL itself.
		page = await newPage(`${origin}${capabilityPath}`);
		const tab = await evaluatePage<Record<string, unknown>>(`
			const result = await until(() => window.__probe);
			return { ...result, origin: self.origin };
		`);
		expectSandbox(tab, "tab");
		expect(tab.parentRead).toBe("self");
		await closePage(page);
		page = undefined;

		// The frame: open the app, then insert a same-origin URL frame. The artifact response's own
		// CSP sandbox is what makes the frame opaque; the iframe carries no sandbox attribute.
		page = await newPage(`${origin}/#${t.panad.webToken}`);
		const frame = await evaluatePage<Record<string, unknown>>(`
			const url = ${JSON.stringify(`${origin}${capabilityPath}`)};
			const received = await new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("no probe arrived from the frame")), 20000);
				window.addEventListener("message", (event) => {
					if (!event.data || !event.data.panaProbe) return;
					clearTimeout(timer);
					resolve({ ...event.data.panaProbe, messageOrigin: event.origin });
				});
				const frame = document.createElement("iframe");
				frame.id = "artifact-frame";
				frame.src = url;
				document.body.append(frame);
			});
			const element = document.querySelector("#artifact-frame");
			return { ...received, contentDocument: element.contentDocument === null };
		`);
		expectSandbox(frame, "frame");
		// The parent cannot read the frame's document, and the frame's origin is opaque to it.
		expect(frame.contentDocument).toBe(true);
		expect(frame.messageOrigin).toBe("null");
		expect(frame.parentRead).toBe("SecurityError");

		// Nothing the frame did reached a table.
		expect(await counts()).toEqual(before);
	});

	it("ART-11 loads the served build's assets and refuses a missing, foreign, or unmatched capability path", async () => {
		// ART-09: a byte of each asset kind is a credential-free, unredirected 200 with the headers.
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
			expectHeaders(bytes.headers, path);
		}

		// ART-11: a missing capability, a foreign version's capability, and a path outside the
		// manifest are refused.
		const capability = capabilityPath.split("/")[3]!;
		const missing = await anonymous(`/a/${versionId}/`);
		expect(missing.status).toBe(403);
		const foreign = await anonymous(`/a/${secondVersionId}/${capability}/`);
		expect(foreign.status).toBe(403);
		const outside = await anonymous(`${capabilityPath}secret.txt`);
		expect(outside.status).toBe(404);

		// Rows before any artifact code runs in Chrome. The hostile requests below must add none.
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
		expectSandbox(probe, "served build");
		expect(await counts()).toEqual(before);
	});
});
