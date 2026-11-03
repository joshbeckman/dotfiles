import { describe, expect, it } from "vitest";
import { buildLabel, buildSyncLabel, configFromText } from "../web/views.js";
import { routeFromHash } from "../web/links.js";
import { matchCommands, paletteCommands } from "../web/palette.js";

const build = { sha: "abc123", message: "Add settings", dirty: false, fingerprint: "tree-1" };
describe("settings presentation", () => {
	it("routes to settings and exposes it in the command palette", () => {
		expect(routeFromHash("#/settings").section).toBe("settings");
		expect(matchCommands(paletteCommands(), "settings").some((row: any) => row.id === "go:settings")).toBe(true);
	});
	it("compares commits and source fingerprints, never claiming unknown or changed builds match", () => {
		expect(buildSyncLabel(build, build)).toBe("In sync");
		expect(buildSyncLabel(build, { ...build, sha: "older" })).toContain("Out of sync");
		expect(buildSyncLabel(build, { ...build, fingerprint: "tree-2" })).toContain("Out of sync");
		expect(buildSyncLabel({ ...build, dirty: true }, { ...build, dirty: true })).toBe("In sync");
		expect(buildSyncLabel({ ...build, dirty: true, fingerprint: undefined }, build)).toContain("may differ");
		expect(buildSyncLabel(null, build)).toContain("unavailable");
		expect(buildSyncLabel(build, null)).toContain("unavailable");
		expect(buildLabel({ ...build, dirty: true })).toContain("uncommitted changes");
		expect(buildLabel(build)).toContain(build.message);
		expect(buildLabel(null)).toContain("unavailable");
	});
	it("requires a JSON object while retaining unknown keys and nested values", () => {
		expect(configFromText('{"future":{"enabled":true},"zero":0}')).toEqual({ future: { enabled: true }, zero: 0 });
		for (const text of ["[]", "null", "3", '"text"']) expect(() => configFromText(text)).toThrow("JSON object");
		expect(() => configFromText("{")).toThrow("Invalid JSON");
	});
});
