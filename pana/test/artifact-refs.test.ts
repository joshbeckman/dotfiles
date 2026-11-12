// ART-13: artifact URLs are canonical refs, the PWA renders both forms as links, and the palette
// finds an artifact by name. The app's own routes are drawn by app.js; these are the helpers it
// calls, so Node can drive them directly (WEB-02).
import { describe, expect, it } from "vitest";
import { formatUrl, parseRef } from "../src/ids/index.ts";
import { appHref, artifactHref, idHref, panaLinkSegments } from "../web/links.js";
import { artifactHits, hitHash, paletteHits } from "../web/palette.js";

const DOMAIN = "test.example";
const ARTIFACT = "01JB0000000000000000000001";
const THREAD = "01JB0000000000000000000002";

describe("ART-13 artifact refs", () => {
	it("ART-13 a pana:// artifact URL is a ref with or without a version", () => {
		expect(parseRef(`pana://${DOMAIN}/artifacts/${ARTIFACT}`, DOMAIN)).toEqual({ kind: "artifact", id: ARTIFACT });
		expect(parseRef(`pana://${DOMAIN}/artifacts/${ARTIFACT}/v/2`, DOMAIN)).toEqual({ kind: "artifact", id: ARTIFACT, version: 2 });
		expect(formatUrl({ kind: "artifact", id: ARTIFACT }, DOMAIN)).toBe(`pana://${DOMAIN}/artifacts/${ARTIFACT}`);
		expect(formatUrl({ kind: "artifact", id: ARTIFACT, version: 2 }, DOMAIN)).toBe(`pana://${DOMAIN}/artifacts/${ARTIFACT}/v/2`);
		// The ref never carries its thread, so the URL shape is one thing everywhere.
		expect(formatUrl({ kind: "artifact", id: ARTIFACT, thread: THREAD }, DOMAIN)).toBe(`pana://${DOMAIN}/artifacts/${ARTIFACT}`);
	});

	it("ART-13 both artifact URL forms render as app links", () => {
		expect(appHref(`pana://${DOMAIN}/artifacts/${ARTIFACT}`, DOMAIN)).toBe(`#/artifacts/${ARTIFACT}`);
		expect(appHref(`pana://${DOMAIN}/artifacts/${ARTIFACT}/v/3`, DOMAIN)).toBe(`#/artifacts/${ARTIFACT}/v/3`);
		// A version URL that names no version, or some other suffix, is no link at all.
		for (const path of ["/v", "/v/0", "/v/01", "/v/one", "/v/1/2", "/x/1", "/artifacts"]) {
			expect(appHref(`pana://${DOMAIN}/artifacts/${ARTIFACT}${path}`, DOMAIN)).toBeUndefined();
		}
		expect(appHref(`pana://${DOMAIN}/artifacts`, DOMAIN)).toBeUndefined();
		expect(appHref(`pana://elsewhere.example/artifacts/${ARTIFACT}`, DOMAIN)).toBeUndefined();
	});

	it("ART-13 the app route is the thread's pane, and a version is always pinned", () => {
		expect(artifactHref(ARTIFACT, { thread: THREAD })).toBe(`#/threads/${THREAD}/a/${ARTIFACT}`);
		expect(artifactHref(ARTIFACT, { thread: THREAD, seq: 2 })).toBe(`#/threads/${THREAD}/a/${ARTIFACT}/v/2`);
		// Without a thread, the route the app resolves before drawing the pane.
		expect(artifactHref(ARTIFACT)).toBe(`#/artifacts/${ARTIFACT}`);
		expect(artifactHref(ARTIFACT, { seq: 2 })).toBe(`#/artifacts/${ARTIFACT}/v/2`);
		// A version that is not a positive whole number is no pin, never a broken segment.
		expect(artifactHref(ARTIFACT, { thread: THREAD, seq: 0 })).toBe(`#/threads/${THREAD}/a/${ARTIFACT}`);
		expect(artifactHref(ARTIFACT, { thread: THREAD, seq: 1.5 })).toBe(`#/threads/${THREAD}/a/${ARTIFACT}`);
		expect(artifactHref("")).toBeUndefined();
		expect(idHref(ARTIFACT, "artifact")).toBe(`#/artifacts/${ARTIFACT}`);
	});

	it("ART-13 artifact URLs inside text are links, and a trailing period stays prose", () => {
		const text = `Pinned pana://${DOMAIN}/artifacts/${ARTIFACT}/v/2, latest pana://${DOMAIN}/artifacts/${ARTIFACT}.`;
		const linked = panaLinkSegments(text, DOMAIN).filter((segment) => segment.href);
		expect(linked.map((segment) => segment.href)).toEqual([`#/artifacts/${ARTIFACT}/v/2`, `#/artifacts/${ARTIFACT}`]);
		expect(linked.map((segment) => segment.text)).toEqual([`pana://${DOMAIN}/artifacts/${ARTIFACT}/v/2`, `pana://${DOMAIN}/artifacts/${ARTIFACT}`]);
		expect(panaLinkSegments(text, DOMAIN).map((segment) => segment.text).join("")).toBe(text);
	});

	it("ART-13 the palette lists an artifact by name and opens its thread's pane", () => {
		const body = {
			artifacts: [
				{ id: ARTIFACT, threadId: THREAD, name: "quarterly-deck", createdAt: 5, newestVersion: { seq: 4 } },
				{ id: "01JB0000000000000000000003", threadId: THREAD, name: "chart-review", newestVersion: null },
			],
		};
		const hits = artifactHits(body);
		expect(hits[0]).toMatchObject({ kind: "artifact", id: ARTIFACT, thread: THREAD, label: "quarterly-deck", meta: "v4" });
		expect(hits[1]).toMatchObject({ kind: "artifact", id: "01JB0000000000000000000003", label: "chart-review", meta: "" });
		// A hit opens the newest version, so a name search never pins an old build.
		expect(hitHash(hits[0]!)).toBe(`#/threads/${THREAD}/a/${ARTIFACT}`);
		expect(hitHash({ kind: "artifact", id: ARTIFACT })).toBe(`#/artifacts/${ARTIFACT}`);

		const groups = paletteHits({ artifacts: body }, "chart");
		expect(groups.map((group) => group.title)).toEqual(["Artifacts"]);
		expect(groups[0]!.hits.map((hit) => hit.label)).toEqual(["chart-review", "quarterly-deck"]);
		// The group is appended, so no existing group moves.
		expect(paletteHits({ threads: { threads: [] }, artifacts: body }, "").map((group) => group.title)).toEqual(["Artifacts"]);
		expect(paletteHits({ threads: { threads: [] } }, "nothing")).toEqual([]);
		expect(artifactHits(undefined)).toEqual([]);
	});
});
