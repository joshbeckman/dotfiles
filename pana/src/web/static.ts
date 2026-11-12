// The PWA's static shell, served by panad on the TCP listener (WEB-01).
//
// The shell is the one part of the TCP surface that does not carry the bearer token: a browser
// cannot put an Authorization header on a page load, and the token arrives in the launch URL's
// fragment instead (WEB-02). Every API route keeps API-04's token check; `isStaticAssetPath`
// is the narrow allowlist that `src/server/app.ts` consults before demanding one.

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { acceptedEncoding, compressibleContentType, encodedBytes, staticQuality, type Encoding } from "../server/compress.ts";

export const WEB_ROOT = fileURLToPath(new URL("../../web/", import.meta.url));

export interface StaticAsset {
	/** Path under `pana/web/`. */
	file: string;
	contentType: string;
}

const ASSETS: Record<string, StaticAsset> = {
	"/": { file: "index.html", contentType: "text/html; charset=utf-8" },
	"/index.html": { file: "index.html", contentType: "text/html; charset=utf-8" },
	"/app.js": { file: "app.js", contentType: "text/javascript; charset=utf-8" },
	"/links.js": { file: "links.js", contentType: "text/javascript; charset=utf-8" },
	"/choices.js": { file: "choices.js", contentType: "text/javascript; charset=utf-8" },
	"/render.js": { file: "render.js", contentType: "text/javascript; charset=utf-8" },
	"/push.js": { file: "push.js", contentType: "text/javascript; charset=utf-8" },
	"/session-palette.js": { file: "session-palette.js", contentType: "text/javascript; charset=utf-8" },
	"/views.js": { file: "views.js", contentType: "text/javascript; charset=utf-8" },
	"/pages.js": { file: "pages.js", contentType: "text/javascript; charset=utf-8" },
	"/keys.js": { file: "keys.js", contentType: "text/javascript; charset=utf-8" },
	"/palette.js": { file: "palette.js", contentType: "text/javascript; charset=utf-8" },
	"/perf.js": { file: "perf.js", contentType: "text/javascript; charset=utf-8" },
	"/style.css": { file: "style.css", contentType: "text/css; charset=utf-8" },
	"/fonts.css": { file: "fonts.css", contentType: "text/css; charset=utf-8" },
	"/vendor.js": { file: "vendor.js", contentType: "text/javascript; charset=utf-8" },
	// CodeMirror, lazily loaded by the memory editor (loaded only when editing a memory file).
	"/memory-editor-vendor.js": { file: "memory-editor-vendor.js", contentType: "text/javascript; charset=utf-8" },
	"/mermaid-vendor.js": { file: "mermaid-vendor.js", contentType: "text/javascript; charset=utf-8" },
	"/sw.js": { file: "sw.js", contentType: "text/javascript; charset=utf-8" },
	"/manifest.webmanifest": { file: "manifest.webmanifest", contentType: "application/manifest+json" },
	"/favicon.svg": { file: "favicon.svg", contentType: "image/svg+xml" },
	// iOS ignores SVG for home-screen icons and Chrome's install prompt wants PNGs.
	"/apple-touch-icon.png": { file: "apple-touch-icon.png", contentType: "image/png" },
	"/icon-192.png": { file: "icon-192.png", contentType: "image/png" },
	"/icon-512.png": { file: "icon-512.png", contentType: "image/png" },
	"/icon-maskable-512.png": { file: "icon-maskable-512.png", contentType: "image/png" },
	// Chrome and Safari both ask for this path even when the markup names favicon.svg.
	"/favicon.ico": { file: "favicon.svg", contentType: "image/svg+xml" },
};

const FONT = /^[a-z0-9-]+\.woff2$/;

/** The asset for a request path, or undefined when the path is not part of the shell. */
export function staticAsset(pathname: string): StaticAsset | undefined {
	const known = ASSETS[pathname];
	if (known) return known;
	if (pathname.startsWith("/fonts/")) {
		const name = pathname.slice("/fonts/".length);
		if (FONT.test(name)) return { file: `fonts/${name}`, contentType: "font/woff2" };
	}
	return undefined;
}

/**
 * True when a request may load without the bearer token. This covers the shell only; `/nope`
 * stays behind the token check so an unauthenticated caller cannot probe paths.
 */
export function isStaticAssetPath(pathname: string): boolean {
	return staticAsset(pathname) !== undefined;
}

export interface LoadedAsset {
	bytes: Uint8Array;
	contentType: string;
	/** Sent only with the HTML shell. */
	headers?: Record<string, string>;
}

/**
 * How long a browser may keep an asset without asking (WEB-13). The shell is not content
 * addressed, so markup, scripts, and styles revalidate on every load: a `no-cache` answer is
 * one round trip and no bytes. A font file's name already says which face it is, and an icon
 * changes when the app does, so those carry a lifetime instead of a round trip.
 */
function cacheControl(asset: StaticAsset): string {
	if (asset.contentType === "font/woff2") return "public, max-age=31536000, immutable";
	if (asset.contentType.startsWith("image/")) return "public, max-age=86400";
	return "no-cache";
}

interface CachedAsset {
	mtimeMs: number;
	size: number;
	bytes: Buffer;
	/** Strong etag over the file's own bytes: the same file always answers the same validator. */
	etag: string;
	/** Compressed variants, so a page load does not recompress a bundle it already sent. */
	encoded: Map<Encoding, Buffer>;
}

const cache = new Map<string, CachedAsset>();

async function cached(path: string): Promise<CachedAsset | undefined> {
	let info;
	try {
		info = await stat(path);
	} catch {
		return undefined;
	}
	const hit = cache.get(path);
	if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size) return hit;
	let bytes: Buffer;
	try {
		bytes = await readFile(path);
	} catch {
		return undefined;
	}
	const digest = createHash("sha1").update(bytes).digest("base64url");
	const entry: CachedAsset = { mtimeMs: info.mtimeMs, size: info.size, bytes, etag: `"${digest}"`, encoded: new Map() };
	cache.set(path, entry);
	return entry;
}

/** Whether an `if-none-match` header names this etag. Weak and strong forms both match. */
export function etagMatches(header: string | string[] | undefined, etag: string): boolean {
	if (!header) return false;
	const list = Array.isArray(header) ? header : [header];
	for (const value of list) {
		if (value.trim() === "*") return true;
		for (const candidate of value.split(",")) {
			if (candidate.trim().replace(/^W\//, "") === etag) return true;
		}
	}
	return false;
}

/**
 * One asset, compressed for the caller when it is text (WEB-13). A caller that sends no
 * `accept-encoding` gets the file as it sits on disk, which is what panad's own tests ask for.
 */
export async function loadAsset(pathname: string, acceptEncoding?: string): Promise<LoadedAsset | undefined> {
	const asset = staticAsset(pathname);
	if (!asset) return undefined;
	const file = `${WEB_ROOT}${asset.file}`;
	const entry = await cached(file);
	if (!entry) return undefined;
	const headers: Record<string, string> = {
		"cache-control": cacheControl(asset),
		etag: entry.etag,
		"x-content-type-options": "nosniff",
		"referrer-policy": "no-referrer",
	};
	let bytes: Uint8Array = entry.bytes;
	if (compressibleContentType(asset.contentType)) {
		headers.vary = "accept-encoding";
		const encoding = acceptedEncoding(acceptEncoding);
		if (encoding) {
			let body: Uint8Array | undefined = entry.encoded.get(encoding);
			if (!body) {
				body = await encodedBytes(entry.bytes, encoding, staticQuality(encoding, entry.bytes.byteLength));
				// Only a body that came back smaller is worth remembering and announcing.
				if (body !== entry.bytes) entry.encoded.set(encoding, Buffer.from(body));
			}
			if (body !== entry.bytes) {
				bytes = body;
				headers["content-encoding"] = encoding;
			}
		}
	}
	if (asset.contentType.startsWith("text/html")) {
		// No inline script: every module is a file under `web/`, so the shell can run under a
		// strict policy. Mermaid writes <style> and style attributes, hence the inline style rule.
		headers["content-security-policy"] = [
			"default-src 'self'",
			"script-src 'self'",
			"style-src 'self' 'unsafe-inline'",
			"img-src 'self' data: blob:",
			"font-src 'self'",
			"connect-src 'self'",
			"worker-src 'self'",
			"base-uri 'none'",
			"form-action 'self'",
		].join("; ");
	}
	return { bytes, contentType: asset.contentType, headers };
}

/** The launch URL panad prints. The token lives in the fragment, which is never sent to a server. */
export function launchUrl(origin: string, token: string): string {
	return `${origin.replace(/\/$/, "")}/#${token}`;
}

/** The loopback origin for a bound TCP port. */
export function loopbackOrigin(port: number): string {
	// Safari answers "denied" to notification requests from an IP-address origin.
	return `http://localhost:${port}`;
}
