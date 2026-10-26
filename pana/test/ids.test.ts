import { describe, expect, it } from "vitest";
import { formatUrl, isUlid, monotonicUlidFactory, parseRef, RefError, ulid, type Ref } from "../src/ids/index.ts";

const DOMAIN = "test.example";
const A = "01JB0000000000000000000000";
const B = "01JB0000000000000000000001";

describe("IDs and URLs", () => {
	it("ID-01 new IDs are monotonic ULIDs that keep creation order within one millisecond", () => {
		const next = monotonicUlidFactory({ now: () => 1_700_000_000_000 });
		const ids = Array.from({ length: 1000 }, () => next());
		for (const id of ids) expect(isUlid(id)).toBe(true);
		expect([...ids].sort()).toEqual(ids);
		expect(new Set(ids).size).toBe(ids.length);

		// The time prefix orders IDs across milliseconds too.
		let time = 1_700_000_000_000;
		const ticking = monotonicUlidFactory({ now: () => time });
		const early = ticking();
		time += 1;
		expect(ticking() > early).toBe(true);

		// The process default is monotonic as well.
		const defaults = Array.from({ length: 200 }, () => ulid());
		expect([...defaults].sort()).toEqual(defaults);
	});

	it("ID-01 a carry through the random field stays sorted", () => {
		// Random bytes of all ones put the random field at its maximum minus a little.
		const next = monotonicUlidFactory({ now: () => 0, random: (len) => new Uint8Array(len).fill(0xff) });
		const first = next();
		expect(first.slice(10)).toBe("ZZZZZZZZZZZZZZZZ");
		expect(() => next()).toThrow(/overflow/);
		const low = monotonicUlidFactory({ now: () => 0, random: (len) => Uint8Array.from({ length: len }, (_, i) => (i === len - 1 ? 0x1f : 0)) });
		const a = low();
		const b = low();
		expect(a.slice(-2)).toBe("0Z");
		expect(b.slice(-2)).toBe("10");
		expect(b > a).toBe(true);
	});

	it("ID-02 parseRef accepts a bare ULID, a bare username, or a pana:// URL for every kind", () => {
		expect(parseRef(A)).toEqual({ kind: "session", id: A });
		expect(parseRef("joshbeckman")).toEqual({ kind: "user", id: "joshbeckman" });
		expect(parseRef(`pana://${DOMAIN}/users/joshbeckman`, DOMAIN)).toEqual({ kind: "user", id: "joshbeckman" });
		expect(parseRef(`pana://${DOMAIN}/sessions/${A}`, DOMAIN)).toEqual({ kind: "session", id: A });
		expect(parseRef(`pana://${DOMAIN}/threads/${A}`, DOMAIN)).toEqual({ kind: "thread", id: A });
		expect(parseRef(`pana://${DOMAIN}/threads/${A}?message=${B}`, DOMAIN)).toEqual({ kind: "message", id: B, thread: A });
		expect(parseRef(`pana://${DOMAIN}/files/${A}/report.pdf`, DOMAIN)).toEqual({ kind: "file", id: A, name: "report.pdf" });
		expect(parseRef(`pana://${DOMAIN}/schedules/${A}`, DOMAIN)).toEqual({ kind: "schedule", id: A });
		expect(parseRef(`pana://${DOMAIN}`, DOMAIN)).toEqual({ kind: "domain", id: DOMAIN });
		expect(() => parseRef(`pana://${DOMAIN}/widgets/${A}`, DOMAIN)).toThrow(RefError);
		expect(() => parseRef("https://example.com/x")).toThrow(RefError);
		expect(() => parseRef("  ")).toThrow(RefError);
	});

	it("ID-03 in an address list a 26-character uppercase Crockford string is a session and any other bare string is a username", () => {
		// Lowercase, 25 characters, 27 characters, and U (outside Crockford base32) are not ULIDs.
		const list = [A, "joshbeckman", "01jb0000000000000000000000", "01JB000000000000000000000", "01JB00000000000000000000000", "01JBU00000000000000000000U", "ops-bot"];
		expect(list.map((item) => parseRef(item).kind)).toEqual(["session", "user", "user", "user", "user", "user", "user"]);
	});

	it("ID-04 a URL with a domain other than the configured one is rejected with code foreign_domain", () => {
		let caught: unknown;
		try {
			parseRef(`pana://other.example/sessions/${A}`, DOMAIN);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(RefError);
		expect((caught as RefError).code).toBe("foreign_domain");
		// Without a configured domain to check against, the URL parses.
		expect(parseRef(`pana://other.example/sessions/${A}`).kind).toBe("session");
	});

	it("ID-05 formatUrl and parseRef round-trip every kind", () => {
		const refs: Ref[] = [
			{ kind: "domain", id: DOMAIN },
			{ kind: "user", id: "joshbeckman" },
			{ kind: "session", id: A },
			{ kind: "thread", id: A },
			{ kind: "message", id: B, thread: A },
			{ kind: "file", id: A, name: "notes.md" },
			{ kind: "file", id: A, name: "Q3 plan (final).pdf" },
			{ kind: "schedule", id: A },
		];
		for (const ref of refs) {
			const url = formatUrl(ref, DOMAIN);
			expect(url.startsWith(`pana://${DOMAIN}`)).toBe(true);
			expect(parseRef(url, DOMAIN)).toEqual(ref);
		}
		expect(formatUrl({ kind: "message", id: B, thread: A }, DOMAIN)).toBe(`pana://${DOMAIN}/threads/${A}?message=${B}`);
	});
});
