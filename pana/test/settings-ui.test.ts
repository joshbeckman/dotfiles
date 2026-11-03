import { describe, expect, it } from "vitest";
import { buildLabel, buildSyncLabel, configFromText, configUserColor, configWithUserColor, validUserColor, userColorPickerValue, userColorFromPicker, participantColor, participantPattern, PALETTE } from "../web/views.js";
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

describe("user message color", () => {
	it("defaults to blue and supports every palette name without changing session/domain colors", () => {
		const user = { url: "pana://test.example/users/tester", kind: "user" };
		const session = { url: "pana://test.example/sessions/session-id", kind: "session" };
		expect(configUserColor({})).toBe("blue");
		expect(configUserColor({ ui: { future: true } })).toBe("blue");
		for (const color of Object.keys(PALETTE)) {
			expect(configUserColor({ ui: { userColor: color } })).toBe(color);
			expect(participantColor(user, { userColor: color })).toBe(color);
			expect(participantColor(user.url, { userColor: color })).toBe(color);
			expect(participantColor(session, { userColor: color })).toBe(participantColor(session));
			expect(participantColor("pana://test.example", { userColor: color })).toBe("black");
		}
		expect(participantColor(user, { userColor: "toString" })).toBe("blue");
	});
	it("keeps thread-roster session colors and overflow patterns unchanged when user color changes", () => {
		const sessions = Array.from({ length: 14 }, (_, i) => `pana://test.example/sessions/${i}`);
		const user = "pana://test.example/users/tester";
		const participants = [user, "pana://test.example", ...sessions];
		const before = sessions.map((session) => [participantColor(session, { participants }), participantPattern(session, participants)]);
		for (const userColor of ["red", "#abc", "#12345678"]) {
			expect(participantColor(user, { participants, userColor })).toBe(userColor);
			expect(sessions.map((session) => [participantColor(session, { participants, userColor }), participantPattern(session, participants)])).toEqual(before);
		}
		expect(before[12]).toEqual([before[0]![0], "dashed"]);
	});
	it("pairs native RGB picking with arbitrary hex entry without losing alpha", () => {
		expect(userColorPickerValue("blue")).toBe("#002fa7");
		expect(userColorPickerValue("#AbC")).toBe("#aabbcc");
		expect(userColorPickerValue("#AbCd")).toBe("#aabbcc");
		expect(userColorPickerValue("#12345678")).toBe("#123456");
		expect(userColorFromPicker("#abcdef", "#1234")).toBe("#abcdef44");
		expect(userColorFromPicker("#abcdef", "#12345678")).toBe("#abcdef78");
		expect(userColorFromPicker("#abcdef", "blue")).toBe("#abcdef");
		expect(() => userColorFromPicker("red", "blue")).toThrow();
	});
	it("preserves nested UI and other draft keys without mutating the input", () => {
		const config = { ui: { userColor: "blue", future: { enabled: true } }, zero: 0, unknown: [1, 2] };
		expect(configWithUserColor(config, "green")).toEqual({ ...config, ui: { ...config.ui, userColor: "green" } });
		expect(config.ui.userColor).toBe("blue");
		expect(configWithUserColor({ unknown: true }, "red")).toEqual({ unknown: true, ui: { userColor: "red" } });
	});
	it("accepts all CSS hex lengths without allowing CSS injection or overwriting malformed UI drafts", () => {
		for (const ui of [null, [], "blue", { userColor: "#12345" }, { userColor: "toString" }, { userColor: null }]) {
			expect(() => configUserColor({ ui })).toThrow();
			expect(() => configWithUserColor({ ui }, "green")).toThrow();
		}
		expect(() => configWithUserColor({}, "cyan")).toThrow();
		for (const color of ["#AbC", "#abcd", "#12AbEF", "#12345678"]) {
			expect(validUserColor(color)).toBe(true);
			expect(configUserColor({ ui: { userColor: color } })).toBe(color);
			expect(configWithUserColor({}, color).ui.userColor).toBe(color);
			expect(participantColor({ kind: "user" }, { userColor: color })).toBe(color);
		}
		for (const color of ["#12", "#12345", "#1234567", "#123456789", "#ggg", "#fff; color:red", "url(x)", null]) expect(validUserColor(color)).toBe(false);
	});
});
