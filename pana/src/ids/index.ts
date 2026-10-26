// IDs and URLs (ID-01..05).
//
// Every pana record except a username is a ULID: 26 Crockford base32 characters,
// uppercase, lexically sortable by creation time. Usernames are lowercase, so a bare
// token is never ambiguous between the two.

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;
const RANDOM_LEN = 16;
export const ULID_LENGTH = 26;

const ULID_RE = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;

/** True for a 26-character uppercase Crockford string. */
export function isUlid(value: string): boolean {
	return ULID_RE.test(value);
}

function encodeTime(time: number): string {
	let out = "";
	let t = time;
	for (let i = 0; i < TIME_LEN; i++) {
		const mod = t % 32;
		out = CROCKFORD[mod] + out;
		t = Math.floor(t / 32);
	}
	return out;
}

function encodeRandom(bytes: Uint8Array): string {
	// 80 bits of randomness rendered as 16 Crockford characters (5 bits each).
	let bits = 0n;
	for (const b of bytes) bits = (bits << 8n) | BigInt(b);
	let out = "";
	for (let i = 0; i < RANDOM_LEN; i++) {
		out = CROCKFORD[Number(bits & 31n)] + out;
		bits >>= 5n;
	}
	return out;
}

function incrementRandom(random: string): string {
	// Monotonic bump: add one to the random field, carrying through the Crockford digits.
	const chars = random.split("");
	for (let i = chars.length - 1; i >= 0; i--) {
		const index = CROCKFORD.indexOf(chars[i]!);
		if (index < 31) {
			chars[i] = CROCKFORD[index + 1]!;
			return chars.join("");
		}
		chars[i] = CROCKFORD[0]!;
	}
	// Overflow is astronomically unlikely within one millisecond; fail loudly rather than wrap.
	throw new Error("ULID random field overflowed within one millisecond");
}

export interface UlidFactory {
	(): string;
}

export interface UlidFactoryOptions {
	now?: () => number;
	random?: (len: number) => Uint8Array;
}

/**
 * Build a monotonic ULID generator. Two IDs made in the same millisecond keep creation
 * order: the later one increments the former's random field instead of drawing fresh bits.
 */
export function monotonicUlidFactory(options: UlidFactoryOptions = {}): UlidFactory {
	const now = options.now ?? Date.now;
	const random =
		options.random ??
		((len: number) => {
			const bytes = new Uint8Array(len);
			globalThis.crypto.getRandomValues(bytes);
			return bytes;
		});
	let lastTime = -1;
	let lastRandom = "";
	return () => {
		const time = now();
		if (time === lastTime) {
			lastRandom = incrementRandom(lastRandom);
		} else {
			lastTime = time;
			lastRandom = encodeRandom(random(10));
		}
		return encodeTime(time) + lastRandom;
	};
}

const defaultFactory = monotonicUlidFactory();

/** A fresh monotonic ULID from the process default clock and RNG. */
export function ulid(): string {
	return defaultFactory();
}

// --- References and URLs -------------------------------------------------------

export type RefKind = "domain" | "user" | "session" | "thread" | "message" | "file" | "schedule";

export interface Ref {
	kind: RefKind;
	/** The record ID: a ULID, or a username for a user, or the domain for a domain ref. */
	id: string;
	/** For a message ref, the thread it belongs to. */
	thread?: string;
	/** For a file ref, the stored file name. */
	name?: string;
}

export class RefError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "RefError";
		this.code = code;
	}
}

const SCHEME = "pana://";

/** Render a reference as a `pana://` URL on the given domain. */
export function formatUrl(ref: Ref, domain: string): string {
	const base = `${SCHEME}${ref.kind === "domain" ? ref.id : domain}`;
	switch (ref.kind) {
		case "domain":
			return base;
		case "user":
			return `${base}/users/${ref.id}`;
		case "session":
			return `${base}/sessions/${ref.id}`;
		case "thread":
			return `${base}/threads/${ref.id}`;
		case "message":
			if (!ref.thread) throw new RefError("invalid_ref", "a message URL needs a thread");
			return `${base}/threads/${ref.thread}?message=${ref.id}`;
		case "file":
			if (!ref.name) throw new RefError("invalid_ref", "a file URL needs a name");
			return `${base}/files/${ref.id}/${encodeURIComponent(ref.name)}`;
		case "schedule":
			return `${base}/schedules/${ref.id}`;
	}
}

/**
 * Parse a bare ULID, a bare username, or a `pana://` URL into a typed reference.
 * `domain`, when given, rejects a URL whose domain differs (ID-04).
 */
export function parseRef(input: string, domain?: string): Ref {
	const value = input.trim();
	if (!value) throw new RefError("invalid_ref", "empty reference");

	if (value.startsWith(SCHEME)) return parseUrl(value, domain);

	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
		throw new RefError("invalid_ref", `not a pana:// URL: ${input}`);
	}
	// A bare token: a 26-character Crockford string is a session, anything else a username (ID-03).
	// An unknown username is the handler's 404, not a parse error.
	if (isUlid(value)) return { kind: "session", id: value };
	return { kind: "user", id: value };
}

function parseUrl(url: string, domain?: string): Ref {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new RefError("invalid_ref", `malformed URL: ${url}`);
	}
	const host = parsed.hostname || parsed.host;
	if (domain !== undefined && host !== domain) {
		throw new RefError("foreign_domain", `URL domain ${host} is not ${domain}`);
	}
	const segments = parsed.pathname.split("/").filter((s) => s.length > 0);

	if (segments.length === 0) return { kind: "domain", id: host };

	const [collection, first, ...rest] = segments;
	switch (collection) {
		case "users":
			if (!first) break;
			return { kind: "user", id: decodeURIComponent(first) };
		case "sessions":
			if (!first) break;
			return { kind: "session", id: first };
		case "threads": {
			if (!first) break;
			const message = parsed.searchParams.get("message");
			if (message) return { kind: "message", id: message, thread: first };
			return { kind: "thread", id: first };
		}
		case "files":
			if (!first || rest.length === 0) break;
			return { kind: "file", id: first, name: decodeURIComponent(rest.join("/")) };
		case "schedules":
			if (!first) break;
			return { kind: "schedule", id: first };
	}
	throw new RefError("invalid_ref", `unrecognized pana:// path: ${parsed.pathname}`);
}
