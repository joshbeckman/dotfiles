// Message bodies and attachments (CLI-04, FIL-01, FIL-02).
//
// `--body`, `--body-file`, and `--body -` are three ways to write one body and only one may be
// used. An attachment goes through WP2's upload route first, because the Markdown reference
// needs the URL the server assigned; `appendAttachmentMarkdown` from `src/threads/files.ts`
// then rewrites the body, so the CLI and the PWA produce the same reference.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { ApiResponse } from "../api/client.ts";
import { mediaTypeFor, type FileView } from "../threads/files.ts";
import { UsageError, type Flags } from "./args.ts";

/** A non-2xx reply from a call made on the way to the command's own call. */
export class ApiResponseError extends Error {
	readonly response: ApiResponse;

	constructor(response: ApiResponse) {
		super(`request failed with status ${response.status}`);
		this.name = "ApiResponseError";
		this.response = response;
	}
}

/** What a message needs to reference an uploaded file (FIL-02). The id is how a command that
 *  links a file instead of referencing it names the uploaded record (OBJ-31). */
export type FileAttachment = Pick<FileView, "id" | "name" | "url" | "mediaType">;

/** Read the body from the flags (CLI-04). `readStdin` is how `--body -` gets its text. */
export async function readBody(flags: Flags, readStdin: () => Promise<string>): Promise<string> {
	const text = flags.get("body");
	const file = flags.get("body-file");
	if (text !== undefined && file !== undefined) {
		throw new UsageError("--body and --body-file are mutually exclusive");
	}
	if (text === undefined && file === undefined) {
		throw new UsageError("a body is required: use --body TEXT, --body-file PATH, or --body -");
	}
	if (text === "-") return readStdin();
	return text ?? readTextFile(file!);
}

export function readTextFile(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		throw new UsageError(`cannot read ${path}: ${(error as Error).message}`);
	}
}

/** Read `--body -` from a process's standard input. */
export function readStdinSync(): string {
	return readFileSync(0, "utf8");
}

export interface ApiCallOptions {
	body?: unknown;
	bytes?: Uint8Array;
	headers?: Record<string, string>;
	query?: Record<string, string | undefined>;
}

/** One HTTP call to panad, with the caller already decided by the transport. */
export interface ApiCall {
	(method: string, path: string, options?: ApiCallOptions): Promise<ApiResponse>;
}

/**
 * Upload one `--attach PATH` to WP2's `POST /files?name=<basename>` with the bytes as the body
 * (FIL-01). The media type is the request's content type; the route infers it from the name when
 * the caller sends opaque bytes.
 */
export async function uploadAttachment(call: ApiCall, path: string): Promise<FileAttachment> {
	const name = basename(path);
	let bytes: Buffer;
	try {
		bytes = readFileSync(path);
	} catch (error) {
		throw new UsageError(`cannot read ${path}: ${(error as Error).message}`);
	}
	// WP2 infers the type from the extension; send it so the record and the response agree.
	const response = await call("POST", "/files", {
		bytes,
		query: { name },
		headers: { "content-type": mediaTypeFor(name, null) },
	});
	if (response.status < 200 || response.status >= 300) throw new ApiResponseError(response);
	const file = (response.body as { file?: FileAttachment } | undefined)?.file;
	if (!file?.url) throw new Error(`upload of ${name} returned no file url`);
	return file;
}

/** Upload every `--attach PATH`, in order. */
export async function uploadAttachments(call: ApiCall, paths: readonly string[]): Promise<FileAttachment[]> {
	const files: FileAttachment[] = [];
	for (const path of paths) files.push(await uploadAttachment(call, path));
	return files;
}
