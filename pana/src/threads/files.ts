// File attachments (FIL-01..FIL-05).
//
// Bytes live under `<state>/files/<ulid>/<name>` (FIL-05); SQLite stores only the record. The
// upload route receives bytes over HTTP, so the CLI and the PWA use one path and `panad` never
// reads a client path.
//
// FIL-02 is a helper, `appendAttachmentMarkdown`, that WP1's CLI calls after uploading each
// `--attach PATH`: the CLI rewrites its body once, before it posts the message.

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { ApiError } from "../api/errors.ts";
import type { Runtime } from "../server/runtime.ts";
import type { FileRecord } from "./store.ts";

export interface FileUploader {
	id: string;
	kind: "user" | "session";
	url: string;
}

export interface UploadInput {
	name?: unknown;
	bytes: Uint8Array;
	uploader: FileUploader;
}

export interface FileView {
	id: string;
	name: string;
	url: string;
	path: string;
	size: number;
	mediaType: string | null;
	uploader: { id: string; kind: "user" | "session"; url: string };
	createdAt: number;
}

/**
 * The types a browser decodes into pixels and never into a document, so each may be served
 * inline. `image/svg+xml` is deliberately absent: it is an XML document, and a browser that
 * opens one runs the script inside it, exactly as it would for HTML.
 */
export const INLINE_MEDIA_TYPES: ReadonlySet<string> = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"image/avif",
]);

function hasSignature(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
	if (bytes.length < offset + signature.length) return false;
	return signature.every((byte, index) => bytes[offset + index] === byte);
}

/**
 * The media type the bytes themselves declare, or null. Only magic numbers, never the upload's
 * `content-type` header or the file name: a name is a claim, and a caller that controls the
 * header could otherwise store an HTML document as a picture.
 */
export function sniffMediaType(bytes: Uint8Array): string | null {
	if (hasSignature(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
	if (hasSignature(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
	// `GIF87a` and `GIF89a`.
	if (hasSignature(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
	// `RIFF....WEBP`.
	if (hasSignature(bytes, [0x52, 0x49, 0x46, 0x46]) && hasSignature(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
	// ISO-BMFF: a length, then `ftyp`, then the brand (`avif`, or `avis` for a sequence).
	if (hasSignature(bytes, [0x66, 0x74, 0x79, 0x70], 4) && (hasSignature(bytes, [0x61, 0x76, 0x69, 0x66], 8) || hasSignature(bytes, [0x61, 0x76, 0x69, 0x73], 8))) return "image/avif";
	return null;
}

/** A bare file name: no directories, no `..`, never empty. */
export function safeName(value: unknown): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw ApiError.badRequest("invalid_file_name", "an upload needs a file name");
	}
	const raw = value.trim();
	if (raw.includes("/") || raw.includes("\\") || raw.includes("\0")) {
		throw ApiError.badRequest("invalid_file_name", `not a usable file name: ${value}`);
	}
	const name = basename(raw);
	if (name.length === 0 || name === "." || name === "..") {
		throw ApiError.badRequest("invalid_file_name", `not a usable file name: ${value}`);
	}
	return name;
}

function toView(runtime: Runtime, row: FileRecord, uploader: FileUploader): FileView {
	return {
		id: row.id,
		name: row.name,
		url: runtime.url({ kind: "file", id: row.id, name: row.name }),
		path: row.path,
		size: row.size,
		mediaType: row.media_type,
		uploader: { id: uploader.id, kind: uploader.kind, url: uploader.url },
		createdAt: row.created_at,
	};
}

/**
 * FIL-01 and FIL-03: check the size, copy the bytes, then record the row in one pana write. A
 * rejected upload never touches disk.
 */
export async function uploadFile(runtime: Runtime, input: UploadInput): Promise<FileView> {
	const name = safeName(input.name);
	const max = runtime.config.files.maxBytes;
	if (input.bytes.byteLength > max) {
		throw ApiError.badRequest("file_too_large", `file is ${input.bytes.byteLength} bytes, over the ${max} byte limit`, {
			maxBytes: max,
			size: input.bytes.byteLength,
		});
	}

	const id = runtime.newId();
	const root = resolve(runtime.paths.files);
	const absolute = resolve(root, id, name);
	if (!absolute.startsWith(root + sep)) throw ApiError.badRequest("invalid_file_name", `not a usable file name: ${name}`);

	const row: FileRecord = {
		id,
		name,
		path: join("files", id, name),
		size: input.bytes.byteLength,
		media_type: sniffMediaType(input.bytes) ?? "application/octet-stream",
		uploader_id: input.uploader.id,
		created_at: runtime.clock.now(),
	};

	mkdirSync(join(root, id), { recursive: true });
	writeFileSync(absolute, input.bytes);
	try {
		await runtime.db.write(async (tx) => {
			// The uploader may be the user, whose participant row no earlier write needed.
			await tx.run(
				"INSERT OR IGNORE INTO participants (id, kind, url, created_at) VALUES (?, ?, ?, ?)",
				input.uploader.id,
				input.uploader.kind,
				input.uploader.url,
				row.created_at,
			);
			await tx.run(
				"INSERT INTO files (id, name, path, size, media_type, uploader_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				row.id,
				row.name,
				row.path,
				row.size,
				row.media_type,
				row.uploader_id,
				row.created_at,
			);
		});
	} catch (error) {
		// The row is the only reference to these bytes. Without it they are unreachable.
		try {
			unlinkSync(absolute);
		} catch {
			// Nothing to clean up.
		}
		throw error;
	}
	return toView(runtime, row, input.uploader);
}

export interface LoadedFile {
	row: FileRecord;
	bytes: Uint8Array;
	mediaType: string;
}

/**
 * FIL-04: recorded bytes and media type. A wrong or unusable name is a 404. The type that comes
 * back is the one the bytes declared at upload; the route sniffs the bytes again before it says
 * how a browser may treat them, so a record written by an older pana is no liability.
 */
export async function loadFile(runtime: Runtime, id: string, requestedName: string): Promise<LoadedFile> {
	let name: string;
	try {
		name = safeName(requestedName);
	} catch {
		throw ApiError.notFound(`file ${id}/${requestedName}`);
	}
	const row = await runtime.db.get<FileRecord>("SELECT * FROM files WHERE id = ?", id);
	if (!row || row.name !== name) throw ApiError.notFound(`file ${id}/${requestedName}`);

	const root = resolve(runtime.paths.files);
	const absolute = resolve(runtime.paths.dir, row.path);
	if (!absolute.startsWith(root + sep)) throw ApiError.notFound(`file ${id}/${requestedName}`);
	let bytes: Buffer;
	try {
		bytes = readFileSync(absolute);
	} catch {
		throw ApiError.notFound(`file ${id}/${requestedName}`);
	}
	return { row, bytes, mediaType: row.media_type ?? "application/octet-stream" };
}

/** FIL-02: one Markdown reference, image syntax for images. */
export function attachmentMarkdown(file: { name: string; url: string; mediaType?: string | null }): string {
	const isImage = (file.mediaType ?? "").toLowerCase().startsWith("image/");
	const label = file.name.replace(/([\\[\]])/g, "\\$1");
	return isImage ? `![${label}](${file.url})` : `[${label}](${file.url})`;
}

/** FIL-02: append one reference line per attachment to a message body. */
export function appendAttachmentMarkdown(
	body: string,
	files: readonly { name: string; url: string; mediaType?: string | null }[],
): string {
	if (files.length === 0) return body;
	const refs = files.map((file) => attachmentMarkdown(file)).join("\n");
	return body.length === 0 ? refs : `${body}\n\n${refs}`;
}

/** RFC 6266/8187: HTTP headers need ASCII; filename* preserves the UTF-8 name. */
function disposition(kind: "inline" | "attachment", name: string): string {
	const fallback = name.replace(/[^\x20-\x7e]|["\\%]/g, "_");
	const encoded = encodeURIComponent(name).replace(/[!'()*]/g, (character) =>
		`%${character.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** FIL-04: a browser may show the bytes in the tab, as for a picture in a thread. */
export function inlineDisposition(name: string): string {
	return disposition("inline", name);
}

/** FIL-04: anything pana will not render itself is a download, never a page on its origin. */
export function attachmentDisposition(name: string): string {
	return disposition("attachment", name);
}
