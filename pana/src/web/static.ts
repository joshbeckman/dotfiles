// The PWA's static shell, served by panad on the TCP listener (WEB-01).
//
// The shell is the one part of the TCP surface that does not carry the bearer token: a browser
// cannot put an Authorization header on a page load, and the token arrives in the launch URL's
// fragment instead (WEB-02). Every API route keeps API-04's token check; `isStaticAssetPath`
// is the narrow allowlist that `src/server/app.ts` consults before demanding one.

import { readFile } from "node:fs/promises";
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
	"/render.js": { file: "render.js", contentType: "text/javascript; charset=utf-8" },
	"/push.js": { file: "push.js", contentType: "text/javascript; charset=utf-8" },
	"/views.js": { file: "views.js", contentType: "text/javascript; charset=utf-8" },
	"/pages.js": { file: "pages.js", contentType: "text/javascript; charset=utf-8" },
	"/style.css": { file: "style.css", contentType: "text/css; charset=utf-8" },
	"/fonts.css": { file: "fonts.css", contentType: "text/css; charset=utf-8" },
	"/vendor.js": { file: "vendor.js", contentType: "text/javascript; charset=utf-8" },
	"/mermaid-vendor.js": { file: "mermaid-vendor.js", contentType: "text/javascript; charset=utf-8" },
	"/sw.js": { file: "sw.js", contentType: "text/javascript; charset=utf-8" },
	"/manifest.webmanifest": { file: "manifest.webmanifest", contentType: "application/manifest+json" },
	"/favicon.svg": { file: "favicon.svg", contentType: "image/svg+xml" },
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

export async function loadAsset(pathname: string): Promise<LoadedAsset | undefined> {
	const asset = staticAsset(pathname);
	if (!asset) return undefined;
	let bytes: Buffer;
	try {
		bytes = await readFile(`${WEB_ROOT}${asset.file}`);
	} catch {
		return undefined;
	}
	const headers: Record<string, string> = {
		"cache-control": "no-cache",
		"x-content-type-options": "nosniff",
		"referrer-policy": "no-referrer",
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
	return { bytes, contentType: asset.contentType, headers };
}

/** The launch URL panad prints. The token lives in the fragment, which is never sent to a server. */
export function launchUrl(origin: string, token: string): string {
	return `${origin.replace(/\/$/, "")}/#${token}`;
}

/** The loopback origin for a bound TCP port. */
export function loopbackOrigin(port: number): string {
	return `http://127.0.0.1:${port}`;
}
