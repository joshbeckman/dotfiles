// HTTP handlers owned by WP8: the PWA shell (WEB-01) and the live event stream (WEB-06).
// src/server/handlers.ts merges these into panad.

import { ApiError } from "../api/errors.ts";
import type { HandlerResult, Handlers } from "../api/types.ts";
import { subscribeEvents } from "./events.ts";
import { loadAsset } from "./static.ts";

async function asset(pathname: string): Promise<HandlerResult> {
	const loaded = await loadAsset(pathname);
	if (!loaded) throw ApiError.notFound(`no web asset for ${pathname}`);
	return {
		status: 200,
		bytes: loaded.bytes,
		headers: { ...loaded.headers, "content-type": loaded.contentType },
	};
}

export const handlers: Handlers = {
	"web.index": () => asset("/"),

	"web.static": (ctx) => asset(`/${ctx.params.rest ?? ""}`),

	"events.stream": (ctx) => ({
		status: 200,
		headers: {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache, no-store",
			connection: "keep-alive",
			"x-accel-buffering": "no",
		},
		stream: (res) => {
			subscribeEvents(ctx.runtime, res);
		},
	}),
};
