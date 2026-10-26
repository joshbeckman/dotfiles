// Message bodies and attachments (CLI-04, FIL-01, FIL-02).
//
// `--body`, `--body-file`, and `--body -` are three ways to write one body and only one may be
// used. An attachment is uploaded through `POST /files` first, because the Markdown reference
// needs the URL the server assigned. That route belongs to WP2; the contract this file assumes
// is one file per request, named by the `X-Pana-Filename` header, with the bytes as the body,
// and a JSON reply of `{"file": {"id", "name", "url"}}` or `{"id", "name", "url"}`.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { ApiResponse } from "../api/client.ts";
import { UsageError } from "./args.ts";
import type { CommandContext } from "./commands.ts";

/** A non-2xx reply from a call made on the way to the command's own call. */
export class ApiResponseError extends Error {
	readonly response: ApiResponse;

	constructor(response: ApiResponse) {
		super(`request failed with status ${response.status}`);
		this.name = "ApiResponseError";
		this.response = response;
	}
}

/** Read the body from the flags (CLI-04). */
export async function readBody(ctx: CommandContext): Promise<string> {
	const text = ctx.flags.get("body");
	const file = ctx.flags.get("body-file");
	if (text !== undefined && file !== undefined) {
		throw new UsageError("--body and --body-file are mutually exclusive");
	}
	if (text === undefined && file === undefined) {
		throw new UsageError("a body is required: use --body TEXT, --body-file PATH, or --body -");
	}
	if (text === "-") {
		let out = "";
		for await (const chunk of ctx.stdin) out += chunk.toString();
		return out;
	}
	return text ?? readTextFile(file!);
}

export function readTextFile(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		throw new UsageError(`cannot read ${path}: ${(error as Error).message}`);
	}
}

/** A media type from the file extension; unknown types upload as opaque bytes. */
export function mediaTypeFor(name: string): string {
	const dot = name.lastIndexOf(".");
	const extension = dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
	return MEDIA_TYPES[extension] ?? "application/octet-stream";
}

const MEDIA_TYPES: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	svg: "image/svg+xml",
	txt: "text/plain",
	md: "text/markdown",
	json: "application/json",
	pdf: "application/pdf",
};

/** The Markdown reference for one attachment: an image embed for an image, a link otherwise. */
export function markdownReference(name: string, url: string, mediaType: string): string {
	const label = name.replace(/[[\]]/g, "");
	return mediaType.startsWith("image/") ? `![${label}](${url})` : `[${label}](${url})`;
}

/** The body with one Markdown reference appended per `--attach PATH` (FIL-02). */
export async function withAttachments(ctx: CommandContext): Promise<string> {
	const body = await readBody(ctx);
	const paths = ctx.flags.list("attach");
	if (paths.length === 0) return body;
	const references: string[] = [];
	for (const path of paths) references.push(await upload(ctx, path));
	const separator = body.length === 0 || body.endsWith("\n") ? "" : "\n";
	return `${body}${separator}\n${references.join("\n")}`;
}

async function upload(ctx: CommandContext, path: string): Promise<string> {
	const name = basename(path);
	const mediaType = mediaTypeFor(name);
	let bytes: Buffer;
	try {
		bytes = readFileSync(path);
	} catch (error) {
		throw new UsageError(`cannot read ${path}: ${(error as Error).message}`);
	}
	const response = await ctx.call("POST", "/files", {
		bytes,
		headers: {
			"content-type": mediaType,
			"x-pana-filename": encodeURIComponent(name),
			"x-pana-media-type": mediaType,
		},
	});
	if (response.status < 200 || response.status >= 300) throw new ApiResponseError(response);
	const url = fileUrl(response.body);
	if (!url) throw new Error(`upload of ${name} returned no url`);
	return markdownReference(name, url, mediaType);
}

function fileUrl(body: unknown): string | undefined {
	if (typeof body !== "object" || body === null) return undefined;
	const record = body as { url?: unknown; file?: { url?: unknown } };
	if (typeof record.url === "string") return record.url;
	if (record.file && typeof record.file.url === "string") return record.file.url;
	return undefined;
}
