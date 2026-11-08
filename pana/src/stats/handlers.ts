// HTTP handlers owned by WP20. src/server/handlers.ts merges these into panad.
//
// `stats.requests` is the reader over the two logs panad already writes: the request log (SRV-01)
// and the client log (OBS-03). It reads a bounded tail and answers per-operation count, errors,
// and p50/p95/p99, so the numbers a bench used to have to produce are available from the daemon
// that is serving traffic.

import { ApiError } from "../api/errors.ts";
import type { Handlers, RequestContext } from "../api/types.ts";
import { appendClientSamples, clientSamples } from "./client.ts";
import { parseSince, summarizeClientFile, summarizeRequestsFile } from "./summary.ts";

/** The `since` a query asks for (OBS-01), as epoch milliseconds; absent means the whole read window. */
function sinceOf(ctx: RequestContext): number | undefined {
	const text = ctx.query.get("since");
	if (text === null || text.trim() === "") return undefined;
	try {
		return parseSince(text, ctx.runtime.clock.now());
	} catch (error) {
		throw ApiError.badRequest("invalid_since", (error as Error).message);
	}
}

/** A trimmed query value, or undefined when the query does not name one. */
function filterOf(ctx: RequestContext, key: string): string | undefined {
	const value = (ctx.query.get(key) ?? "").trim();
	return value === "" ? undefined : value;
}

export const handlers: Handlers = {
	"stats.requests": async (ctx) => {
		const since = sinceOf(ctx);
		const route = filterOf(ctx, "route");
		const name = filterOf(ctx, "name");
		const requests = await summarizeRequestsFile(ctx.runtime.paths.log, {
			...(since === undefined ? {} : { since }),
			...(route === undefined ? {} : { route }),
		});
		const client = await summarizeClientFile(ctx.runtime.paths.clientLog, {
			...(since === undefined ? {} : { since }),
			...(name === undefined ? {} : { name }),
		});
		return { status: 200, body: { ...requests, client } };
	},
	"stats.client": async (ctx) => {
		const samples = clientSamples(ctx.body);
		const written = await appendClientSamples(ctx.runtime.paths.clientLog, samples, ctx.runtime.clock.now(), {
			maxBytes: ctx.runtime.config.logs.maxBytes,
			keep: ctx.runtime.config.logs.keep,
		});
		return { status: 202, body: { accepted: written, samples: samples.length } };
	},
};
