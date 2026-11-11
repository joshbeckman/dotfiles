// HTTP handlers owned by WP8: the PWA shell (WEB-01) and the live event stream (WEB-06).
// src/server/handlers.ts merges these into panad.

import { ApiError } from "../api/errors.ts";
import type { HandlerResult, Handlers, RequestContext } from "../api/types.ts";
import { subscribeEvents } from "./events.ts";
import { etagMatches, loadAsset } from "./static.ts";

/**
 * WEB-13: one asset, or a 304 when the reader already has it. Compressing and revalidating
 * live here rather than in the request pipeline because an asset is the one body panad can
 * answer from a cache keyed by the file on disk.
 */
async function asset(ctx: RequestContext, pathname: string): Promise<HandlerResult> {
	const loaded = await loadAsset(pathname, header(ctx, "accept-encoding"));
	if (!loaded) throw ApiError.notFound(`no web asset for ${pathname}`);
	const headers: Record<string, string> = { ...loaded.headers, "content-type": loaded.contentType };
	const etag = headers.etag;
	if (etag && etagMatches(ctx.headers["if-none-match"], etag)) {
		// A 304 carries the validator and the freshness a 200 would have and no body at all.
		return { status: 304, headers };
	}
	return { status: 200, bytes: loaded.bytes, headers };
}

function header(ctx: RequestContext, name: string): string | undefined {
	const value = ctx.headers[name];
	return Array.isArray(value) ? value[0] : value;
}

export const handlers: Handlers = {
	"web.index": (ctx) => asset(ctx, "/"),

	"web.static": (ctx) => asset(ctx, `/${ctx.params.rest ?? ""}`),

	"events.stream": (ctx) => ({
		status: 200,
		headers: {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache, no-store",
			connection: "keep-alive",
			"x-accel-buffering": "no",
		},
		stream: (res) => {
			subscribeEvents(ctx.runtime, res, ctx.caller);
		},
	}),
};
