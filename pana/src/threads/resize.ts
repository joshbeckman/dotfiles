// FIL-07: a smaller copy of an image for inline display.
//
// pana has no image decoder and no image dependency, so it borrows the resizer the host already
// has: `sips` on macOS, ImageMagick (`magick`, or `convert` before version 7) elsewhere. With
// neither installed it serves the original. `src/server/tailscale.ts` borrows `tailscale` the same
// way. A derivative is made once per width and kept beside the original under `.resized/`, so a
// thread reopened on a phone never re-reads a twelve-megapixel photo to show it 400 pixels wide.

import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmdirSync, unlinkSync } from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import type { Runtime } from "../server/runtime.ts";
import type { LoadedFile } from "./files.ts";

/** The narrowest and widest copy a request may ask for. */
export const MIN_WIDTH = 16;
export const MAX_WIDTH = 2048;

/** The media types a resizer reads and writes back. Anything else serves the original bytes. */
const RESIZABLE = new Set(["image/jpeg", "image/png"]);

export interface ResizeBackend {
	command: string;
	/** Arguments that succeed only when the command is installed. */
	probe: string[];
	/** Arguments that write `from`, at most `width` pixels wide, into `to`. */
	args(from: string, to: string, width: number, format: "jpeg" | "png"): string[];
}

const BACKENDS: ResizeBackend[] = [
	{
		// macOS 10.3 and later. sips keeps the EXIF orientation tag, so the browser still turns
		// the photo upright after the copy is written.
		command: "sips",
		probe: ["--help"],
		args: (from, to, width, format) => ["-s", "format", format, "-s", "formatOptions", "80", "-Z", String(width), from, "--out", to],
	},
	{
		// ImageMagick 7. `-auto-orient` bakes the EXIF rotation into the pixels, which it then
		// drops; the copy is upright either way.
		command: "magick",
		probe: ["-version"],
		args: (from, to, width, format) => [from, "-auto-orient", "-resize", `${width}x`, "-quality", "80", format === "png" ? `png:${to}` : to],
	},
	{
		// ImageMagick 6, still what most package managers ship.
		command: "convert",
		probe: ["-version"],
		args: (from, to, width, format) => [from, "-auto-orient", "-resize", `${width}x`, "-quality", "80", format === "png" ? `png:${to}` : to],
	},
];

let probed: ResizeBackend | null | undefined;

/** The resizer this host has, or null. Probed once per process. */
export function findBackend(): ResizeBackend | null {
	if (probed !== undefined) return probed;
	const found = BACKENDS.find((backend) => {
		try {
			execFileSync(backend.command, backend.probe, { stdio: "ignore", timeout: 5000 });
			return true;
		} catch {
			return false;
		}
	});
	probed = found ?? null;
	return probed;
}

/** A requested width, clamped to what the cache honors, or undefined when there is none usable. */
export function parseWidth(value: unknown): number | undefined {
	if (typeof value !== "string" || value.trim().length === 0) return undefined;
	const parsed = Number(value.trim());
	if (!Number.isFinite(parsed) || parsed < 1) return undefined;
	return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(parsed)));
}

/** The pixel dimensions a JPEG or PNG header records, or undefined for another format. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | undefined {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	// PNG: the signature, then the IHDR chunk, whose width and height are big-endian.
	const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
	if (
		bytes.length >= 24 &&
		PNG.every((byte, index) => bytes[index] === byte) &&
		String.fromCharCode(...bytes.subarray(12, 16)) === "IHDR"
	) {
		return { width: view.getUint32(16), height: view.getUint32(20) };
	}
	// JPEG: walk the segments to the first start-of-frame, which carries the dimensions. Skipping
	// by segment length keeps an EXIF thumbnail from being read as the frame.
	if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
	let at = 2;
	while (at + 4 <= bytes.length) {
		if (bytes[at] !== 0xff) {
			at += 1;
			continue;
		}
		const marker = bytes[at + 1]!;
		if (marker === 0xff) {
			at += 1;
			continue;
		}
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
			at += 2;
			continue;
		}
		const length = view.getUint16(at + 2);
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			if (at + 9 > bytes.length) return undefined;
			return { height: view.getUint16(at + 5), width: view.getUint16(at + 7) };
		}
		if (length < 2) return undefined;
		at += 2 + length;
	}
	return undefined;
}

/** The derivative's path for one width, kept clear of the original's own name. */
function derivativePath(loaded: LoadedFile, width: number, format: "jpeg" | "png"): string {
	const extension = extname(loaded.row.name);
	const stem = basename(loaded.row.name, extension);
	return join(dirname(loaded.row.path), ".resized", `${width}-${stem}.${format === "png" ? "png" : "jpg"}`);
}

/** A resizer run in flight for one derivative, so two requests at once make one copy. */
const writing = new Map<string, Promise<void>>();

function served(bytes: Uint8Array, format: "jpeg" | "png"): ServedImage {
	return { bytes, mediaType: format === "png" ? "image/png" : "image/jpeg" };
}

function copy(absolute: string, format: "jpeg" | "png"): ServedImage | undefined {
	try {
		return served(readFileSync(absolute), format);
	} catch {
		return undefined;
	}
}

async function make(from: string, absolute: string, width: number, format: "jpeg" | "png", backend: ResizeBackend): Promise<void> {
	mkdirSync(dirname(absolute), { recursive: true });
	const temp = `${absolute}.${process.pid}-${Date.now()}.tmp`;
	try {
		await new Promise<void>((settle, reject) => {
			execFile(backend.command, backend.args(from, temp, width, format), { timeout: 60_000 }, (error) =>
				error ? reject(error) : settle(),
			);
		});
		// The rename makes a half-written copy unreachable, as the row does for an upload's bytes.
		renameSync(temp, absolute);
	} catch (error) {
		try {
			unlinkSync(temp);
		} catch {
			// Nothing was written.
		}
		try {
			// A failed run leaves no empty cache directory behind.
			rmdirSync(dirname(absolute));
		} catch {
			// Another copy lives there.
		}
		throw error;
	}
}

export interface ServedImage {
	bytes: Uint8Array;
	mediaType: string;
}

/**
 * FIL-07: the bytes to serve for one image at one width. The original comes back when no width is
 * asked for, the type is not one a resizer handles, the picture is already that narrow, the host
 * has no resizer, or the resizer fails: a missing tool must not break a thread.
 */
export async function resizedImage(
	runtime: Runtime,
	loaded: LoadedFile,
	width: number | undefined,
	backend: ResizeBackend | null | undefined = findBackend(),
): Promise<ServedImage> {
	const original = { bytes: loaded.bytes, mediaType: loaded.mediaType };
	if (width === undefined || !backend || !RESIZABLE.has(loaded.mediaType)) return original;
	const size = imageSize(loaded.bytes);
	// Never enlarge: a copy wider than the source is only a bigger file.
	if (!size || size.width <= width) return original;

	const format = loaded.mediaType === "image/png" ? "png" : "jpeg";
	const root = resolve(runtime.paths.files);
	const absolute = resolve(runtime.paths.dir, derivativePath(loaded, width, format));
	if (!absolute.startsWith(root + sep)) return original;

	const cached = copy(absolute, format);
	if (cached) return cached;

	const inflight = writing.get(absolute);
	if (inflight) {
		await inflight.catch(() => undefined);
		return copy(absolute, format) ?? original;
	}

	const from = resolve(runtime.paths.dir, loaded.row.path);
	const run = make(from, absolute, width, format, backend)
		.catch((error: unknown) => {
			console.error(`panad: resize ${loaded.row.name} to ${width}px with ${backend.command}:`, error);
		})
		.finally(() => writing.delete(absolute));
	writing.set(absolute, run);
	await run;
	return copy(absolute, format) ?? original;
}
