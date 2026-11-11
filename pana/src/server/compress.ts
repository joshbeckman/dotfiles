// Compression for the TCP listener (WEB-13). The PWA is used from a phone on a bad link as
// often as from the machine panad runs on, and until now every byte crossed it as-is: the
// 406 KB a cold page load fetches, the 14 KB inbox, and every list answer. Compressing the
// text half of that costs panad a few milliseconds and saves the reader most of it.
//
// The work is async because the daemon also serves `/events`: a 3 MB bundle brotli'd on the
// event loop would stall every open stream for as long as it takes.

import { promisify } from "node:util";
import { brotliCompress, constants as zlibConstants, gzip } from "node:zlib";

export type Encoding = "br" | "gzip";

const brotli = promisify(brotliCompress);
const gz = promisify(gzip);

/** Below this a body is a header's worth of bytes, and gzip's own framing can make it bigger. */
export const COMPRESS_MIN_BYTES = 1024;

/** Types worth compressing. Everything else is already compressed (png, woff2) or binary. */
const COMPRESSIBLE = [
	"text/",
	"application/json",
	"application/javascript",
	"application/manifest+json",
	"application/xml",
	"image/svg+xml",
];

/** One request's `accept-encoding`, with the encoding to use or none. Bare tokens mean q=1. */
export function acceptedEncoding(header: string | undefined): Encoding | undefined {
	if (!header) return undefined;
	const scores: Record<string, number> = {};
	for (const part of header.split(",")) {
		const [name, ...params] = part.trim().toLowerCase().split(";");
		if (!name) continue;
		let quality = 1;
		for (const param of params) {
			const match = /^\s*q=([0-9.]+)\s*$/.exec(param);
			if (match) quality = Number(match[1]);
		}
		// `br` is a few percent smaller than gzip on this app's own files, so it wins a tie.
		if (name === "br" || name === "gzip") scores[name] = quality;
	}
	if ((scores.br ?? 0) > 0) return "br";
	if ((scores.gzip ?? 0) > 0) return "gzip";
	return undefined;
}

/** Whether a response type is text worth compressing. An empty or unknown type is left alone. */
export function compressibleContentType(type: string | undefined): boolean {
	if (!type) return false;
	const value = type.toLowerCase();
	return COMPRESSIBLE.some((prefix) => value.startsWith(prefix));
}

/**
 * The level a file costs once. Brotli's top setting buys 8% over its ninth and costs eighteen
 * times as much on this app's own `app.js` (354 ms against 19 ms), and a second on the 3.4 MB
 * Mermaid bundle for a percent, so the level follows the size rather than the best number.
 */
const BROTLI_DEEP_MAX_BYTES = 1024 * 1024;

export function staticQuality(encoding: Encoding, size: number): number {
	if (encoding === "gzip") return 9;
	return size <= BROTLI_DEEP_MAX_BYTES ? 9 : 5;
}

/**
 * The body to send for this encoding, or the body as given when compressing it would not pay:
 * a body under `COMPRESS_MIN_BYTES`, or bytes no larger than the original.
 */
export async function encodedBytes(bytes: Uint8Array, encoding: Encoding, quality?: number): Promise<Uint8Array> {
	if (bytes.byteLength < COMPRESS_MIN_BYTES) return bytes;
	const source = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const done =
		encoding === "br"
			? await brotli(source, {
					params: {
						[zlibConstants.BROTLI_PARAM_QUALITY]: quality ?? 5,
						[zlibConstants.BROTLI_PARAM_SIZE_HINT]: source.byteLength,
					},
				})
			: await gz(source, { level: quality ?? 6 });
	return done.byteLength < source.byteLength ? done : bytes;
}
