// HTTP handlers owned by WP2. src/server/handlers.ts merges these into panad.

import { ApiError } from "../api/errors.ts";
import type { HandlerResult, Handlers, RequestContext } from "../api/types.ts";
import { attachmentDisposition, INLINE_MEDIA_TYPES, inlineDisposition, loadFile, sniffMediaType, uploadFile } from "./files.ts";
import { parseWidth, resizedImage } from "./resize.ts";
import { parseLimit } from "../api/pagination.ts";
import { archiveThread, bookmarkMessage, bookmarks, BOOKMARK_LIMIT, createThread, INBOX_LIMIT, inbox, inboxThreads, readMessage, readThread, redactMessage, respond, reviseMessage, setThreadRole } from "./store.ts";

/** FIL-07: a file's bytes never change for one id and width, so a browser may keep them. */
export const FILES_CACHE_CONTROL = "private, max-age=604800";

/** FIL-04: a download is one reader's copy and renders nothing, so it is not kept at all. */
export const ATTACHMENT_CACHE_CONTROL = "private, no-store";

function bodyObject(ctx: RequestContext): Record<string, unknown> {
	const body = ctx.body;
	if (body === undefined || body === null) return {};
	if (typeof body !== "object" || Array.isArray(body)) {
		throw ApiError.badRequest("invalid_body", "request body must be a JSON object");
	}
	return body as Record<string, unknown>;
}

function participantQuery(ctx: RequestContext): string | undefined {
	const value = ctx.query.get("participant");
	return value === null || value === "" ? undefined : value;
}

function truthyQuery(ctx: RequestContext, name: string): boolean {
	const value = ctx.query.get(name);
	return value === "1" || value === "true" || value === "yes";
}

function header(ctx: RequestContext, name: string): string | undefined {
	const value = ctx.headers[name];
	if (Array.isArray(value)) return value[0];
	return value;
}

export const handlers: Handlers = {
	"threads.create": async (ctx): Promise<HandlerResult> => {
		const body = bodyObject(ctx);
		return {
			status: 201,
			body: await createThread(ctx.runtime, ctx.caller, { to: body.to, body: body.body, subject: body.subject }),
		};
	},

	"threads.read": async (ctx): Promise<HandlerResult> => ({
		status: 200,
		body: await readThread(ctx.runtime, ctx.caller, ctx.params.id!),
	}),

	"threads.role": async (ctx): Promise<HandlerResult> => {
		const body = bodyObject(ctx);
		if (ctx.query.has("participant") || Object.keys(body).some((key) => key !== "role")) throw ApiError.badRequest("invalid_body", "only role is accepted");
		return { status: 200, body: await setThreadRole(ctx.runtime, ctx.caller, ctx.params.id!, body.role) };
	},

	// REF-03: per-participant archive. The user may name a participant, as the inbox route does.
	"threads.archive": async (ctx): Promise<HandlerResult> => {
		const body = bodyObject(ctx);
		return {
			status: 200,
			body: await archiveThread(ctx.runtime, ctx.caller, ctx.params.id!, {
				participant: typeof body.participant === "string" ? body.participant : participantQuery(ctx),
				archived: true,
			}),
		};
	},

	"threads.unarchive": async (ctx): Promise<HandlerResult> => {
		const body = bodyObject(ctx);
		return {
			status: 200,
			body: await archiveThread(ctx.runtime, ctx.caller, ctx.params.id!, {
				participant: typeof body.participant === "string" ? body.participant : participantQuery(ctx),
				archived: false,
			}),
		};
	},

	"threads.respond": async (ctx): Promise<HandlerResult> => {
		const body = bodyObject(ctx);
		return {
			status: 200,
			body: await respond(ctx.runtime, ctx.caller, ctx.params.id!, {
				after: body.after,
				body: body.body,
				cc: body.cc,
			}),
		};
	},

	"messages.show": async (ctx): Promise<HandlerResult> => ({
		status: 200,
		body: await readMessage(ctx.runtime, ctx.caller, ctx.params.id!, {
			participant: participantQuery(ctx),
			markRead: truthyQuery(ctx, "read"),
		}),
	}),

	"messages.markRead": async (ctx): Promise<HandlerResult> => {
		const body = bodyObject(ctx);
		const participant = typeof body.participant === "string" ? body.participant : participantQuery(ctx);
		return {
			status: 200,
			body: await readMessage(ctx.runtime, ctx.caller, ctx.params.id!, { participant, markRead: true }),
		};
	},

	"messages.revise": async (ctx): Promise<HandlerResult> => {
		const body = bodyObject(ctx);
		return {
			status: 200,
			body: await reviseMessage(ctx.runtime, ctx.caller, ctx.params.id!, body.body),
		};
	},

	"messages.redact": async (ctx): Promise<HandlerResult> => ({
		status: 200,
		body: await redactMessage(ctx.runtime, ctx.caller, ctx.params.id!),
	}),

	// BKM-01: the user saves a message, or takes the mark off again.
	"messages.bookmark": async (ctx): Promise<HandlerResult> => ({
		status: 200,
		body: await bookmarkMessage(ctx.runtime, ctx.caller, ctx.params.id!, true),
	}),

	"messages.unbookmark": async (ctx): Promise<HandlerResult> => ({
		status: 200,
		body: await bookmarkMessage(ctx.runtime, ctx.caller, ctx.params.id!, false),
	}),

	// BKM-02: the caller's saved messages, newest save first.
	"bookmarks.list": async (ctx): Promise<HandlerResult> => ({
		status: 200,
		body: await bookmarks(ctx.runtime, ctx.caller, {
			limit: parseLimit(ctx.query.get("limit"), BOOKMARK_LIMIT),
			cursor: ctx.query.get("cursor"),
		}),
	}),

	"inbox.list": async (ctx): Promise<HandlerResult> => {
		const options = {
			archived: truthyQuery(ctx, "archived"),
			limit: parseLimit(ctx.query.get("limit"), INBOX_LIMIT),
			cursor: ctx.query.get("cursor"),
		};
		// UX-03: the PWA reads threads; `session inbox` keeps the delivery list INB-01 describes.
		const view = ctx.query.get("view") ?? "deliveries";
		if (view === "threads") return { status: 200, body: await inboxThreads(ctx.runtime, ctx.caller, participantQuery(ctx), options) };
		if (view !== "deliveries") throw ApiError.badRequest("invalid_view", "view must be deliveries or threads");
		return { status: 200, body: await inbox(ctx.runtime, ctx.caller, participantQuery(ctx), options) };
	},

	"files.upload": async (ctx): Promise<HandlerResult> => {
		const name = ctx.query.get("name") ?? header(ctx, "x-pana-name") ?? header(ctx, "x-file-name");
		const view = await uploadFile(ctx.runtime, {
			name,
			bytes: ctx.rawBody,
			uploader: { id: ctx.caller.id, kind: ctx.caller.kind, url: ctx.caller.url },
		});
		return { status: 201, body: { file: view } };
	},

	"files.download": async (ctx): Promise<HandlerResult> => {
		const loaded = await loadFile(ctx.runtime, ctx.params.id!, ctx.params.rest ?? "");
		// FIL-07: `?w=N` asks for an inline-sized copy; the bytes are the original otherwise.
		const image = await resizedImage(ctx.runtime, loaded, parseWidth(ctx.query.get("w")));
		// FIL-04: the served bytes decide how they may be served, never the stored record alone,
		// so a file uploaded before this rule is no more dangerous than one uploaded after it.
		// Only a raster image is inert on the PWA's origin; everything else, HTML and SVG
		// included, leaves as an opaque download.
		const mediaType = sniffMediaType(image.bytes);
		const inline = mediaType !== null && INLINE_MEDIA_TYPES.has(mediaType);
		return {
			status: 200,
			bytes: image.bytes,
			headers: {
				"content-type": inline ? mediaType : "application/octet-stream",
				"content-disposition": inline ? inlineDisposition(loaded.row.name) : attachmentDisposition(loaded.row.name),
				// FIL-07: a file's bytes never change, so a reopened thread and a second message
				// showing the same picture read the copy the browser already has instead of
				// megabytes of photo again. Private keeps a shared cache out of a token's window.
				"cache-control": inline ? FILES_CACHE_CONTROL : ATTACHMENT_CACHE_CONTROL,
				// A browser that believes the type above may not re-read the bytes to pick another.
				"x-content-type-options": "nosniff",
			},
		};
	},
};
