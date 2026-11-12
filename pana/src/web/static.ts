// The PWA's static shell, served by panad on the TCP listener (WEB-01).
//
// The shell is the one part of the TCP surface that does not carry the bearer token: a browser
// cannot put an Authorization header on a page load, and the token arrives in the launch URL's
// fragment instead (WEB-02). Every API route keeps API-04's token check; `isStaticAssetPath`
// is the narrow allowlist that `src/server/app.ts` consults before demanding one.

import { readFile, stat } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

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

export interface LoadOptions {
	/** Send a gzipped copy when the asset is worth one. The caller reads `accept-encoding`. */
	gzip?: boolean;
}

/** Below this size the header and the CPU cost more than the bytes saved. */
export const COMPRESS_MIN_BYTES = 1024;

/** Compressed copies kept at once. Seven assets pass the floor today; this is room to spare. */
const COMPRESS_CACHE_MAX = 64;

/** Compressed copies, keyed by file, size, and modification time. */
const compressed = new Map<string, Uint8Array>();

/** Whether an `accept-encoding` header asks for gzip, honouring an explicit `gzip;q=0`. */
export function acceptsGzip(header: string | string[] | undefined): boolean {
	const value = Array.isArray(header) ? header.join(",") : header;
	if (!value) return false;
	for (const entry of value.split(",")) {
		const [name, ...params] = entry.trim().toLowerCase().split(";");
		if (name !== "gzip" && name !== "*") continue;
		const quality = params.map((param) => param.trim()).find((param) => param.startsWith("q="));
		if (quality && Number(quality.slice(2)) === 0) continue;
		return true;
	}
	return false;
}

/** Types worth compressing: text, and nothing already packed (woff2 fonts, PNG icons). */
function compressible(contentType: string): boolean {
	return /^(?:text\/|application\/(?:json|manifest\+json)$)|^image\/svg\+xml/.test(contentType);
}

/**
 * The gzipped copy of one asset, kept until its file changes.
 *
 * panad reads `web/` per request, so a `web/`-only merge is live without a restart; that has to
 * stay true. The key carries the file's size and modification time, so a rewritten bundle is
 * compressed again on its next load instead of the cache serving the old bytes.
 */
function compressedAsset(key: string, bytes: Buffer): Uint8Array {
	const known = compressed.get(key);
	if (known) return known;
	// Level 6 is the default trade. The 3.4 MB diagram bundle takes a few hundred ms on this Pi,
	// once per file, and every later load of it is a third of the bytes.
	const zipped = gzipSync(bytes, { level: 6 });
	if (compressed.size >= COMPRESS_CACHE_MAX) {
		const oldest = compressed.keys().next().value;
		if (oldest !== undefined) compressed.delete(oldest);
	}
	compressed.set(key, zipped);
	return zipped;
}

export async function loadAsset(pathname: string, options: LoadOptions = {}): Promise<LoadedAsset | undefined> {
	const asset = staticAsset(pathname);
	if (!asset) return undefined;
	const file = `${WEB_ROOT}${asset.file}`;
	let bytes: Buffer;
	let modified = 0;
	try {
		modified = (await stat(file)).mtimeMs;
		bytes = await readFile(file);
	} catch {
		return undefined;
	}
	const headers: Record<string, string> = {
		"cache-control": "no-cache",
		"x-content-type-options": "nosniff",
		"referrer-policy": "no-referrer",
		// The bytes depend on this header, so anything caching them has to key on it as well.
		vary: "accept-encoding",
	};
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
	if (options.gzip && bytes.byteLength >= COMPRESS_MIN_BYTES && compressible(asset.contentType)) {
		headers["content-encoding"] = "gzip";
		return { bytes: compressedAsset(`${asset.file}:${bytes.byteLength}:${modified}`, bytes), contentType: asset.contentType, headers };
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
