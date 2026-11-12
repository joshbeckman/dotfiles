// ART-12, ART-13, ART-14, and ART-15 in a real browser, against a real panad.
//
// ART-12 is the entry's decision: `.html` in the sandboxed frame, `.md` through the message
// renderer's Markdown and DOMPurify path, a raster image inline, anything else a download, and no
// artifact byte rendered as a document on the app's own origin.
// ART-13 is the route: the thread's list links to `#/threads/<thread>/a/<artifact>`, a `/v/<seq>`
// route stays on that version, an unversioned one shows the newest version when it opens, and a
// `pana://` artifact URL in the timeline opens it.
// ART-14 is the two views: on a phone the switch keeps the thread's scroll position and unsent
// draft and offers one back action; on a wide screen the artifact renders beside the thread, which
// keeps scrolling. The pane has its own chrome and no composer, and no view scrolls sideways at
// 390 px even when the build itself is 2000 px wide.
// ART-15 is the live publish: the open thread appends the published message without a reload, the
// open pane offers **New version** instead of reloading a frame under the reader, and the draft and
// scroll survive. That test skips until panad emits a publication event of its own kind: without
// one the app cannot learn of a publish, so there is nothing to assert yet.
//
// What the tests below require of the app, beyond the listed test ids:
// - `artifact-version`'s text names the sequence it shows, written `v<seq>` (or "version <seq>").
// - `artifact-download` is a link with a `download` attribute whose `href` is the capability path.
// - `artifact-new-version` is one control, visible only when a newer version exists.
// - `artifact-back` is the phone pane's single back action, and the bundle of the pane carries
//   `artifact-version` as its chrome.
// Needs the installed Chrome and chrome-devtools, so it runs with `npm run test:web`, not `npm test`.

import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loopbackOrigin } from "../../src/web/static.ts";
import { startTestPanad, TEST_DOMAIN, type TestPanad } from "../harness/index.ts";
import { chromeDevtoolsAvailable, closePage, emulateViewport, evaluatePage, newPage, resizePage } from "./cli.ts";

const describeBrowser = chromeDevtoolsAvailable() ? describe : describe.skip;

// An iPhone-sized viewport, the one MOB-01 measures at.
const PHONE = "390x844x3,mobile,touch";
const PNG = readFileSync(new URL("../../web/icon-192.png", import.meta.url));

let t: TestPanad;
let page: number | undefined;
let origin: string;
let threadId: string;
/** Artifact ids by name, filled by the fixture publish below. */
const ids = { build: "", notes: "", shot: "", log: "" };

afterEach(async () => {
	if (page !== undefined) {
		await emulateViewport("").catch(() => undefined);
		await closePage(page);
	}
	page = undefined;
});

afterAll(async () => {
	await t?.close();
});

// ---- Fixtures -------------------------------------------------------------------------------

interface Published {
	artifact: { id: string; name: string; threadId: string; url: string };
	version: { id: string; seq: number; entry: string; url: string; previewUrl: string };
	created: boolean;
}
interface VersionView {
	id: string;
	seq: number;
	entry: string;
	previewUrl: string;
	pinned: boolean;
}

/** A build wide enough that its own document pans: the pane must hold it, not the app shell. */
const BUILD = (marker: string) => `<!doctype html>
<html>
<head><meta charset="utf-8"><title>the shelf</title></head>
<body>
<div style="width: 2000px; font: 16px system-ui">${marker}</div>
</body>
</html>
`;

const NOTES = (buildUrl: string) => `# Shelf notes

The build reads **clean**.

<img src="x" onerror="window.__pwned = true">

See the [build](${buildUrl}).
`;

async function upload(name: string, bytes: string | Uint8Array): Promise<string> {
	const res = await t.client.post<{ file: { id: string } }>(`/files?name=${encodeURIComponent(name)}`, undefined, {
		bytes: typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes,
	});
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.file.id;
}

/** Publish a version the way a session's `pana artifact publish` does: uploads first, then a manifest. */
async function publish(name: string, entry: string, files: Record<string, string | Uint8Array>): Promise<Published> {
	const manifest: Array<{ path: string; fileId: string }> = [];
	for (const [path, bytes] of Object.entries(files)) manifest.push({ path, fileId: await upload(path, bytes) });
	const res = await t.client.post<Published>(`/threads/${threadId}/artifacts/${encodeURIComponent(name)}`, { entry, files: manifest });
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	expect(res.body.created).toBe(true);
	return res.body;
}

async function versionsOf(artifactId: string): Promise<VersionView[]> {
	const res = await t.client.get<{ versions: VersionView[] }>(`/artifacts/${artifactId}`);
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return res.body.versions;
}

/** One more user message, so the thread scrolls at phone height. */
async function say(body: string): Promise<void> {
	const thread = await t.client.get<{ messages: Array<{ id: string }> }>(`/threads/${threadId}`);
	const after = thread.body.messages.at(-1)!.id;
	const posted = await t.client.post(`/threads/${threadId}/messages`, { after, body });
	expect(posted.status, JSON.stringify(posted.body)).toBe(200);
}

beforeAll(async () => {
	t = await startTestPanad({ config: { defaultModel: "faux/faux-1", timezone: "UTC" } });
	origin = loopbackOrigin(t.panad.tcpPort!);
	const created = await t.client.post<{ thread: { id: string } }>("/threads", {
		subject: "Artifact shelf",
		body: "Publish the shelf and show me every kind of entry.",
	});
	expect(created.status, JSON.stringify(created.body)).toBe(201);
	threadId = created.body.thread.id;
	for (let index = 0; index < 12; index++) {
		await say(`Shelf note ${index + 1}. The list, the pane, and the frame all have to survive a switch.\n\nA second paragraph, so the thread is taller than the phone.`);
	}

	ids.build = (await publish("build", "index.html", { "index.html": BUILD("the artifact's own bytes") })).artifact.id;
	// A second version, so "newest" and "pinned" are different answers.
	await publish("build", "index.html", { "index.html": BUILD("the second build's own bytes") });
	ids.notes = (await publish("notes", "notes.md", { "notes.md": NOTES(`pana://${TEST_DOMAIN}/artifacts/${ids.build}`) })).artifact.id;
	ids.shot = (await publish("shot", "logo.png", { "logo.png": PNG })).artifact.id;
	ids.log = (await publish("log", "run.txt", { "run.txt": "run log body" })).artifact.id;
});

// ---- Page helpers ---------------------------------------------------------------------------

/** In-page helpers every measurement uses: is this element on screen, and which version is shown? */
const HELPERS = `
	const visible = (el) => {
		if (!el) return false;
		const box = el.getBoundingClientRect();
		return box.width > 0 && box.height > 0;
	};
	// The version element names its sequence the way the SPEC writes it: "v<seq>".
	const seqOf = (el) => {
		const text = el ? el.textContent : "";
		const marked = /v(?:ersion)?\\.?\\s*(\\d+)/i.exec(text);
		const any = /(\\d+)/.exec(text);
		return marked ? Number(marked[1]) : any ? Number(any[1]) : 0;
	};
	const framePath = () => {
		const frame = document.querySelector("[data-testid=artifact-frame]");
		const src = frame ? frame.getAttribute("src") : null;
		return src ? new URL(src, location.href).pathname : null;
	};
`;

async function open(): Promise<void> {
	page = await newPage(`${origin}/#${t.panad.webToken}`);
	await evaluatePage(`await until(() => window.__pana); return true;`);
}

/** Put the app on a route and wait for the condition that says the view it names has drawn. */
async function goto(hash: string, ready: string, timeout = 15_000): Promise<void> {
	await evaluatePage(`
		location.hash = ${JSON.stringify(hash)};
		try {
			await until(() => ${ready}, ${timeout});
		} catch {
			throw new Error(${JSON.stringify(hash)} + " never got ready: " + (document.getElementById("status")?.textContent ?? "") + " run=" + location.hash);
		}
		return true;
	`);
}

// ---- ART-12 ---------------------------------------------------------------------------------

describeBrowser("artifact pane", () => {
	it("ART-12 the entry picks the view: sandboxed page, Markdown, image, or download", async () => {
		const newest = (await versionsOf(ids.build)).at(-1)!;
		await open();
		await resizePage(1280, 900);

		// `.html`: the sandboxed page in its own frame, and not one byte of it in the app's document.
		await goto(`#/threads/${threadId}/a/${ids.build}`, `document.querySelector("[data-testid=artifact-frame]") && document.querySelector("[data-testid=artifact-version]")`);
		const built = await evaluatePage<{
			tag: string;
			src: string | null;
			path: string | null;
			sameOrigin: boolean;
			visible: boolean;
			srcdoc: boolean;
			opaque: boolean;
			version: number;
			appText: string;
			inline: boolean;
			markdown: boolean;
			image: boolean;
			download: boolean;
		}>(`
			${HELPERS}
			await until(() => document.querySelector("[data-testid=artifact-frame]")?.getAttribute("src"));
			const frame = document.querySelector("[data-testid=artifact-frame]");
			const src = frame.getAttribute("src");
			let opaque = true;
			try { opaque = frame.contentDocument === null; } catch { opaque = true; }
			const parse = (selector) => Boolean(document.querySelector(selector));
			return {
				tag: frame.tagName,
				src,
				path: new URL(src, location.href).pathname,
				sameOrigin: new URL(src, location.href).origin === location.origin,
				visible: visible(frame),
				srcdoc: frame.hasAttribute("srcdoc"),
				opaque,
				version: seqOf(document.querySelector("[data-testid=artifact-version]")),
				appText: document.body.textContent,
				inline: document.documentElement.innerHTML.includes("the artifact's own bytes"),
				markdown: parse("[data-testid=artifact-markdown]"),
				image: parse("[data-testid=artifact-image]"),
				download: parse("[data-testid=artifact-download]"),
			};
		`);
		expect(built.tag).toBe("IFRAME");
		expect(built.visible).toBe(true);
		expect(built.sameOrigin).toBe(true);
		// The frame is a capability path on the app's origin, never a `srcdoc` or a blob of bytes the
		// app pasted into a document of its own.
		expect(built.path!.startsWith(`/a/${newest.id}/`)).toBe(true);
		expect(built.src!.startsWith("blob:")).toBe(false);
		expect(built.src!.startsWith("data:")).toBe(false);
		expect(built.srcdoc).toBe(false);
		// The CSP sandbox makes the frame opaque, so the parent cannot read the artifact's document.
		expect(built.opaque).toBe(true);
		expect(built.inline).toBe(false);
		expect(built.appText).not.toContain("the artifact's own bytes");
		expect(built.version).toBe(newest.seq);
		expect([built.markdown, built.image, built.download]).toEqual([false, false, false]);

		// `.md`: rendered through the message renderer, sanitized, and not framed.
		await goto(`#/threads/${threadId}/a/${ids.notes}`, `document.querySelector("[data-testid=artifact-markdown] h1")`);
		const notes = await evaluatePage<{
			heading: string;
			bold: string;
			hrefs: Array<string | null>;
			handlers: number;
			scripts: number;
			styles: number;
			pwned: boolean;
			text: string;
			frame: boolean;
			image: boolean;
			download: boolean;
		}>(`
			${HELPERS}
			const root = document.querySelector("[data-testid=artifact-markdown]");
			const parse = (selector) => Boolean(document.querySelector(selector));
			return {
				heading: root.querySelector("h1")?.textContent ?? "",
				bold: root.querySelector("strong")?.textContent ?? "",
				hrefs: [...root.querySelectorAll("a")].map((anchor) => anchor.getAttribute("href")),
				handlers: root.querySelectorAll("[onerror]").length,
				scripts: root.querySelectorAll("script").length,
				styles: root.querySelectorAll("style").length,
				pwned: Boolean(window.__pwned),
				text: root.textContent,
				frame: parse("[data-testid=artifact-frame]"),
				image: parse("[data-testid=artifact-image]"),
				download: parse("[data-testid=artifact-download]"),
			};
		`);
		expect(notes.heading).toBe("Shelf notes");
		expect(notes.bold).toBe("clean");
		expect(notes.text).toContain("The build reads");
		// DOMPurify's path, not innerHTML: the handler is gone, and nothing it could run survived.
		expect(notes.handlers).toBe(0);
		expect(notes.scripts).toBe(0);
		expect(notes.styles).toBe(0);
		expect(notes.pwned).toBe(false);
		// A `pana://` link inside the Markdown is an app route, not a dead `pana://` href.
		expect(notes.hrefs.some((href) => href !== null && href.startsWith("#/"))).toBe(true);
		expect(notes.hrefs.every((href) => href === null || !href.startsWith("pana://"))).toBe(true);
		expect([notes.frame, notes.image, notes.download]).toEqual([false, false, false]);

		// A raster image: inline, decoded, from its capability path.
		const shotVersion = (await versionsOf(ids.shot)).at(-1)!;
		await goto(
			`#/threads/${threadId}/a/${ids.shot}`,
			`(() => { const img = document.querySelector("[data-testid=artifact-image]"); return img && img.complete && img.naturalWidth > 0; })()`,
		);
		const shot = await evaluatePage<{ tag: string; width: number; path: string; frame: boolean; markdown: boolean; download: boolean }>(`
			${HELPERS}
			const img = document.querySelector("[data-testid=artifact-image]");
			const parse = (selector) => Boolean(document.querySelector(selector));
			return {
				tag: img.tagName,
				width: img.naturalWidth,
				path: new URL(img.getAttribute("src"), location.href).pathname,
				frame: parse("[data-testid=artifact-frame]"),
				markdown: parse("[data-testid=artifact-markdown]"),
				download: parse("[data-testid=artifact-download]"),
			};
		`);
		expect(shot.tag).toBe("IMG");
		expect(shot.width).toBe(192);
		expect(shot.path.startsWith(`/a/${shotVersion.id}/`)).toBe(true);
		expect([shot.frame, shot.markdown, shot.download]).toEqual([false, false, false]);

		// Anything else: offered as a download, from its capability path, and rendered as nothing.
		const logVersion = (await versionsOf(ids.log)).at(-1)!;
		await goto(`#/threads/${threadId}/a/${ids.log}`, `document.querySelector("[data-testid=artifact-download]")`);
		const log = await evaluatePage<{ tag: string; href: string; download: boolean; path: string; frame: boolean; markdown: boolean; image: boolean; text: string }>(`
			${HELPERS}
			const link = document.querySelector("[data-testid=artifact-download]");
			const parse = (selector) => Boolean(document.querySelector(selector));
			return {
				tag: link.tagName,
				href: link.getAttribute("href"),
				download: link.hasAttribute("download"),
				path: new URL(link.getAttribute("href"), location.href).pathname,
				frame: parse("[data-testid=artifact-frame]"),
				markdown: parse("[data-testid=artifact-markdown]"),
				image: parse("[data-testid=artifact-image]"),
				text: document.body.textContent,
			};
		`);
		expect(log.tag).toBe("A");
		expect(log.download).toBe(true);
		expect(log.path.startsWith(`/a/${logVersion.id}/`)).toBe(true);
		expect([log.frame, log.markdown, log.image]).toEqual([false, false, false]);
		expect(log.text).not.toContain("run log body");
	});

	// ---- ART-13 -------------------------------------------------------------------------------

	it("ART-13 the list links to the artifact, a versioned route stays on its version, and a timeline URL opens it", async () => {
		await open();
		await resizePage(1280, 900);
		await goto(`#/threads/${threadId}`, `document.querySelectorAll("[data-testid=artifact-open]").length >= 4`);

		const list = await evaluatePage<{ inThread: boolean; links: Array<{ href: string | null; text: string }> }>(`
			const list = document.querySelector("[data-testid=artifact-list]");
			return {
				inThread: Boolean(document.getElementById("thread")?.contains(list)),
				links: [...list.querySelectorAll("[data-testid=artifact-open]")].map((link) => ({ href: link.getAttribute("href"), text: link.textContent.trim() })),
			};
		`);
		expect(list.inThread).toBe(true);
		const byHref = list.links.map((link) => link.href ?? "");
		for (const id of [ids.build, ids.notes, ids.shot, ids.log]) {
			expect(byHref.some((href) => href.startsWith(`#/threads/${threadId}/a/${id}`)), `${id}: ${JSON.stringify(byHref)}`).toBe(true);
		}

		// The list's open link lands on the newest version.
		const newest = (await versionsOf(ids.build)).at(-1)!;
		await evaluatePage(`
			const link = [...document.querySelectorAll("[data-testid=artifact-open]")].find((anchor) => (anchor.getAttribute("href") ?? "").includes(${JSON.stringify(ids.build)}));
			link.click();
			await until(() => document.querySelector("[data-testid=artifact-version]") && document.querySelector("[data-testid=artifact-frame]"));
			await until(() => document.querySelector("[data-testid=artifact-frame]")?.getAttribute("src"));
			return true;
		`);
		const opened = await evaluatePage<{ seq: number; path: string | null }>(`
			${HELPERS}
			return { seq: seqOf(document.querySelector("[data-testid=artifact-version]")), path: framePath() };
		`);
		expect(opened.seq).toBe(newest.seq);
		expect(opened.path!.startsWith(`/a/${newest.id}/`)).toBe(true);

		// A versioned route shows that version. A publish after it opens does not change what is on
		// screen: the URL pinned a version, so a newer one can never be adopted under it.
		const first = (await versionsOf(ids.build))[0]!;
		await goto(`#/threads/${threadId}/a/${ids.build}/v/${first.seq}`, `document.querySelector("[data-testid=artifact-version]") && document.querySelector("[data-testid=artifact-frame]")?.getAttribute("src")`);
		const pinned = await evaluatePage<{ seq: number; path: string | null }>(`
			${HELPERS}
			return { seq: seqOf(document.querySelector("[data-testid=artifact-version]")), path: framePath() };
		`);
		expect(pinned.seq).toBe(first.seq);
		expect(pinned.path!.startsWith(`/a/${first.id}/`)).toBe(true);

		const third = await publish("build", "index.html", { "index.html": BUILD("the third build's own bytes") });
		const afterPublish = await evaluatePage<{ seq: number; path: string | null }>(`
			${HELPERS}
			await sleep(800);
			return { seq: seqOf(document.querySelector("[data-testid=artifact-version]")), path: framePath() };
		`);
		expect(afterPublish.seq).toBe(first.seq);
		expect(afterPublish.path!.startsWith(`/a/${first.id}/`)).toBe(true);

		// The unversioned route shows the newest version when it opens.
		await goto(`#/threads/${threadId}/a/${ids.build}`, `document.querySelector("[data-testid=artifact-version]") && document.querySelector("[data-testid=artifact-frame]")?.getAttribute("src")`);
		const resolved = await evaluatePage<{ seq: number; path: string | null }>(`
			${HELPERS}
			return { seq: seqOf(document.querySelector("[data-testid=artifact-version]")), path: framePath() };
		`);
		expect(resolved.seq).toBe(third.version.seq);
		expect(resolved.path!.startsWith(`/a/${third.version.id}/`)).toBe(true);

		// The publish's own message in the timeline carries the versioned URL, and it opens that version.
		const versionUrl = `pana://${TEST_DOMAIN}/artifacts/${ids.build}/v/${first.seq}`;
		await goto(`#/threads/${threadId}`, `document.querySelectorAll("#thread-messages [data-testid=message]").length >= 4`);
		const linked = await evaluatePage<{ href: string | null; text: string | null }>(`
			const anchor = [...document.querySelectorAll("#thread-messages a")].find((node) => (node.textContent ?? "").includes(${JSON.stringify(versionUrl)}));
			return { href: anchor?.getAttribute("href") ?? null, text: anchor?.textContent ?? null };
		`);
		expect(linked.href).toBe(`#/threads/${threadId}/a/${ids.build}/v/${first.seq}`);
		await evaluatePage(`
			const anchor = [...document.querySelectorAll("#thread-messages a")].find((node) => (node.textContent ?? "").includes(${JSON.stringify(versionUrl)}));
			anchor.click();
			await until(() => document.querySelector("[data-testid=artifact-version]") && document.querySelector("[data-testid=artifact-frame]")?.getAttribute("src"));
			return true;
		`);
		const fromTimeline = await evaluatePage<{ seq: number; path: string | null }>(`
			${HELPERS}
			return { seq: seqOf(document.querySelector("[data-testid=artifact-version]")), path: framePath() };
		`);
		expect(fromTimeline.seq).toBe(first.seq);
		expect(fromTimeline.path!.startsWith(`/a/${first.id}/`)).toBe(true);
	});

	// ---- ART-14 -------------------------------------------------------------------------------

	it("ART-14 a phone switches to the artifact and comes back to the same scroll and draft", async () => {
		await open();
		await emulateViewport(PHONE);
		await goto(`#/threads/${threadId}`, `document.querySelectorAll("#thread-messages [data-testid=message]").length >= 4 && document.querySelector("[data-testid=artifact-open]")`);

		const switched = await evaluatePage<{
			reading: number;
			threadWidth: number;
			innerWidth: number;
			pane: boolean;
			thread: boolean;
			back: boolean;
			composer: boolean;
			paneWidth: number;
			chrome: boolean;
			frameFits: boolean;
			shellFits: boolean;
			draft: string;
			returned: number;
			threadBack: boolean;
			paneGone: boolean;
		}>(`
			${HELPERS}
			await sleep(200);
			const box = document.getElementById("reply-body");
			box.value = "Keep this draft";
			box.dispatchEvent(new Event("input", { bubbles: true }));
			scrollTo(0, document.documentElement.scrollHeight);
			await sleep(200);
			const reading = scrollY;
			const threadWidth = document.documentElement.scrollWidth;
			const link = [...document.querySelectorAll("[data-testid=artifact-open]")].find((anchor) => (anchor.getAttribute("href") ?? "").includes(${JSON.stringify(ids.build)}));
			link.click();
			const pane = await until(() => {
				const node = document.querySelector("[data-testid=artifact-pane]");
				return node && visible(node) ? node : undefined;
			});
			await until(() => document.querySelector("[data-testid=artifact-frame]")?.getAttribute("src"));
			await sleep(250);
			const frame = document.querySelector("[data-testid=artifact-frame]");
			const paneBox = pane.getBoundingClientRect();
			const shown = {
				pane: visible(pane),
				thread: visible(document.getElementById("thread")),
				back: visible(document.querySelector("[data-testid=artifact-back]")),
				composer: visible(document.getElementById("reply-body")),
				paneWidth: paneBox.width,
				chrome: Boolean(pane.querySelector("[data-testid=artifact-version]")),
				frameFits: !frame || frame.getBoundingClientRect().width <= paneBox.width + 1,
				shellFits: document.documentElement.scrollWidth <= innerWidth + 1,
			};
			document.querySelector("[data-testid=artifact-back]").click();
			await until(() => visible(document.getElementById("reply-body")));
			await sleep(400);
			return {
				reading,
				threadWidth,
				innerWidth,
				...shown,
				draft: document.getElementById("reply-body").value,
				returned: scrollY,
				threadBack: visible(document.getElementById("thread")),
				paneGone: !visible(pane),
			};
		`);
		// The thread scrolls on a phone, and the list of artifacts does not widen it.
		expect(switched.reading).toBeGreaterThan(0);
		expect(switched.threadWidth).toBeLessThanOrEqual(switched.innerWidth + 1);
		// One view at a time, one back action, and no composer in the pane.
		expect(switched.pane).toBe(true);
		expect(switched.thread).toBe(false);
		expect(switched.back).toBe(true);
		expect(switched.composer).toBe(false);
		expect(switched.chrome).toBe(true);
		// A wide build pans inside the pane instead of widening the shell at 390 px.
		expect(switched.frameFits).toBe(true);
		expect(switched.shellFits).toBe(true);
		expect(switched.paneWidth).toBeLessThanOrEqual(switched.innerWidth + 1);
		// Back lands where the reader left: the same draft, and the same place in the thread.
		expect(switched.threadBack).toBe(true);
		expect(switched.paneGone).toBe(true);
		expect(switched.draft).toBe("Keep this draft");
		expect(switched.returned).toBeGreaterThan(0);
		expect(Math.abs(switched.returned - switched.reading)).toBeLessThanOrEqual(8);
	});

	it("ART-14 a wide screen renders the artifact beside the thread, which keeps scrolling", async () => {
		await open();
		await resizePage(1280, 900);
		await goto(
			`#/threads/${threadId}/a/${ids.build}`,
			`document.querySelector("[data-testid=artifact-pane]") && document.querySelectorAll("#thread-messages [data-testid=message]").length >= 4`,
		);

		const layout = await evaluatePage<{
			thread: boolean;
			pane: boolean;
			sideBySide: boolean;
			composerInPane: boolean;
			shell: number;
			innerWidth: number;
			frameWidth: number;
			paneWidth: number;
			newestInView: boolean;
		}>(`
			${HELPERS}
			await until(() => document.querySelector("[data-testid=artifact-frame]")?.getAttribute("src"));
			await sleep(250);
			const pane = document.querySelector("[data-testid=artifact-pane]");
			const thread = document.getElementById("thread");
			const frame = document.querySelector("[data-testid=artifact-frame]");
			const paneBox = pane.getBoundingClientRect();
			const threadBox = thread.getBoundingClientRect();
			// Scroll whichever scroller holds the messages, to its end.
			let scroller = document.scrollingElement;
			for (let node = document.getElementById("thread-messages"); node; node = node.parentElement) {
				const style = getComputedStyle(node);
				if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1) { scroller = node; break; }
			}
			scroller.scrollTop = scroller.scrollHeight;
			if (scroller === document.scrollingElement) scrollTo(0, document.documentElement.scrollHeight);
			await sleep(250);
			const newest = document.querySelector("#thread-messages [data-testid=message]:last-of-type").getBoundingClientRect();
			return {
				thread: visible(thread),
				pane: visible(pane),
				sideBySide: paneBox.left >= threadBox.right - 1 || threadBox.left >= paneBox.right - 1,
				composerInPane: Boolean(pane.querySelector("#reply-body, [data-testid=reply-body]")),
				shell: document.documentElement.scrollWidth,
				innerWidth,
				frameWidth: frame ? frame.getBoundingClientRect().width : 0,
				paneWidth: paneBox.width,
				newestInView: newest.bottom <= innerHeight + 1 && newest.top >= -1,
			};
		`);
		expect(layout.thread).toBe(true);
		expect(layout.pane).toBe(true);
		expect(layout.sideBySide).toBe(true);
		expect(layout.composerInPane).toBe(false);
		// The 2000 px build pans inside the pane; the app shell does not widen.
		expect(layout.shell).toBeLessThanOrEqual(layout.innerWidth + 1);
		expect(layout.frameWidth).toBeLessThanOrEqual(layout.paneWidth + 1);
		expect(layout.newestInView).toBe(true);
	});

	// ---- ART-15 -------------------------------------------------------------------------------

	it("ART-15 a publish appends the message and offers the reader the new version", async (ctx) => {
		await open();
		await resizePage(1280, 900);
		await goto(
			`#/threads/${threadId}/a/${ids.build}`,
			`document.querySelector("[data-testid=artifact-pane]") && document.querySelectorAll("#thread-messages [data-testid=message]").length >= 4 && document.querySelector("[data-testid=artifact-version]")`,
		);

		// ART-15 gives a publish an event of its own kind; without one the open thread and pane
		// cannot hear about it, so there is no affordance to measure yet.
		const kinds = await streamKinds();
		if (!kinds.some((kind) => /artifact/.test(kind))) ctx.skip();

		const before = await evaluatePage<{ seq: number; path: string | null; messages: number; draft: string; scroll: number }>(`
			${HELPERS}
			const box = document.getElementById("reply-body");
			box.value = "Keep this draft";
			box.dispatchEvent(new Event("input", { bubbles: true }));
			scrollTo(0, Math.round(document.documentElement.scrollHeight / 3));
			await sleep(250);
			return {
				seq: seqOf(document.querySelector("[data-testid=artifact-version]")),
				path: framePath(),
				messages: document.querySelectorAll("#thread-messages [data-testid=message]").length,
				draft: box.value,
				scroll: scrollY,
			};
		`);

		const published = await publish("build", "index.html", { "index.html": BUILD("the live build's own bytes") });

		const after = await evaluatePage<{
			messages: number;
			appended: boolean;
			draft: string;
			scroll: number;
			seq: number;
			path: string | null;
			offered: boolean;
		}>(`
			${HELPERS}
			await until(() => document.querySelectorAll("#thread-messages [data-testid=message]").length > ${before.messages}, 20000);
			await sleep(400);
			const messages = [...document.querySelectorAll("#thread-messages [data-testid=message]")];
			const offered = document.querySelector("[data-testid=artifact-new-version]");
			return {
				messages: messages.length,
				appended: /published .*v\\d+/.test(messages[messages.length - 1].textContent),
				draft: document.getElementById("reply-body").value,
				scroll: scrollY,
				seq: seqOf(document.querySelector("[data-testid=artifact-version]")),
				path: framePath(),
				offered: visible(offered),
			};
		`);
		// The open thread appends the published message without a reload.
		expect(after.messages).toBe(before.messages + 1);
		expect(after.appended).toBe(true);
		// Nothing reloads a frame under a reader: the version on screen is the one they were reading,
		// and the draft and the scroll are theirs.
		expect(after.seq).toBe(before.seq);
		expect(after.path).toBe(before.path);
		expect(after.draft).toBe("Keep this draft");
		expect(Math.abs(after.scroll - before.scroll)).toBeLessThanOrEqual(8);
		// The pane offers the new version for the reader to choose.
		expect(after.offered).toBe(true);

		const taken = await evaluatePage<{ seq: number; path: string | null; draft: string; scroll: number; messages: number }>(`
			${HELPERS}
			document.querySelector("[data-testid=artifact-new-version]").click();
			await until(() => seqOf(document.querySelector("[data-testid=artifact-version]")) === ${published.version.seq} && framePath()?.startsWith(${JSON.stringify(`/a/${published.version.id}/`)}));
			await sleep(300);
			return {
				seq: seqOf(document.querySelector("[data-testid=artifact-version]")),
				path: framePath(),
				draft: document.getElementById("reply-body").value,
				scroll: scrollY,
				messages: document.querySelectorAll("#thread-messages [data-testid=message]").length,
			};
		`);
		expect(taken.seq).toBe(published.version.seq);
		expect(taken.path!.startsWith(`/a/${published.version.id}/`)).toBe(true);
		expect(taken.draft).toBe("Keep this draft");
		expect(Math.abs(taken.scroll - after.scroll)).toBeLessThanOrEqual(8);
		// Taking the new version is a choice, not another publish: nothing new enters the timeline.
		expect(taken.messages).toBe(after.messages);
	});
});

/**
 * The kinds `/events` carries after a publish, measured from the page's own token: a throwaway
 * artifact is published and the stream read for a moment. ART-15 is the only item that can be
 * measured this way; the rest of this spec reads what the server answers.
 */
async function streamKinds(): Promise<string[]> {
	await evaluatePage(`
		window.__kinds = [];
		const token = localStorage.getItem("pana-token");
		const controller = new AbortController();
		const response = await fetch("/events", {
			headers: { authorization: "Bearer " + token, accept: "text/event-stream" },
			signal: controller.signal,
		});
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		window.__stop = () => controller.abort();
		(async () => {
			try {
				for (;;) {
					const read = await reader.read();
					if (read.done) break;
					buffer += decoder.decode(read.value, { stream: true });
					let at;
					while ((at = buffer.indexOf("\\n\\n")) >= 0) {
						const frame = buffer.slice(0, at);
						buffer = buffer.slice(at + 2);
						const kind = /^event:\\s*(.+)$/m.exec(frame);
						if (kind) window.__kinds.push(kind[1].trim());
					}
				}
			} catch {
				// Aborted by the probe.
			}
		})();
		await until(() => window.__kinds.includes("hello"));
		return true;
	`);
	try {
		await publish("probe", "probe.txt", { "probe.txt": `probe ${Date.now()}` });
		return await evaluatePage<string[]>(`await sleep(500); window.__stop(); return window.__kinds;`);
	} finally {
		await evaluatePage<string[]>(`window.__stop?.(); return window.__kinds ?? [];`).catch(() => undefined);
	}
}
