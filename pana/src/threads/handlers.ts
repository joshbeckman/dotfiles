// HTTP handlers owned by WP2. src/server/handlers.ts merges these into panad.

import { ApiError } from "../api/errors.ts";
import type { HandlerResult, Handlers, RequestContext } from "../api/types.ts";
import { loadFile, uploadFile } from "./files.ts";
import { parseLimit } from "../api/pagination.ts";
import { archiveThread, createThread, INBOX_LIMIT, inbox, readMessage, readThread, redactMessage, respond, reviseMessage } from "./store.ts";

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

	"inbox.list": async (ctx): Promise<HandlerResult> => ({
		status: 200,
		body: await inbox(ctx.runtime, ctx.caller, participantQuery(ctx), {
			archived: truthyQuery(ctx, "archived"),
			limit: parseLimit(ctx.query.get("limit"), INBOX_LIMIT),
			cursor: ctx.query.get("cursor"),
		}),
	}),

	"files.upload": async (ctx): Promise<HandlerResult> => {
		const name = ctx.query.get("name") ?? header(ctx, "x-pana-name") ?? header(ctx, "x-file-name");
		const view = await uploadFile(ctx.runtime, {
			name,
			mediaType: header(ctx, "content-type") ?? null,
			bytes: ctx.rawBody,
			uploader: { id: ctx.caller.id, kind: ctx.caller.kind, url: ctx.caller.url },
		});
		return { status: 201, body: { file: view } };
	},

	"files.download": async (ctx): Promise<HandlerResult> => {
		const loaded = await loadFile(ctx.runtime, ctx.params.id!, ctx.params.rest ?? "");
		return {
			status: 200,
			bytes: loaded.bytes,
			headers: {
				"content-type": loaded.mediaType,
				"content-disposition": `inline; filename="${loaded.row.name.replace(/["\\]/g, "_")}"`,
			},
		};
	},
};
