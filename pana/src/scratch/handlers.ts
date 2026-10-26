// HTTP handlers owned by WP16. src/server/handlers.ts merges these into panad.

import { ApiError } from "../api/errors.ts";
import type { Handlers, RequestContext } from "../api/types.ts";
import { isUlid, parseRef } from "../ids/index.ts";
import { sessionRow } from "../sessions/views.ts";
import { directoryBytes, scratchPath, sweepScratch } from "./index.ts";

/** The session a scratch call is about: the named one, or the calling session. */
function targetSession(ctx: RequestContext): string {
	const named = (ctx.query.get("session") ?? "").trim();
	if (named === "") {
		if (ctx.caller.kind === "session") return ctx.caller.id;
		throw ApiError.badRequest("missing_session", "name a session: pana scratch --session SESSION");
	}
	if (isUlid(named)) return named;
	const ref = parseRef(named, ctx.runtime.config.domain);
	if (ref.kind !== "session") throw ApiError.badRequest("invalid_session", `${named} is not a session`);
	return ref.id;
}

export const handlers: Handlers = {
	"scratch.show": async (ctx) => {
		const id = targetSession(ctx);
		await sessionRow(ctx.runtime, id);
		const path = scratchPath(ctx.runtime, id);
		return { status: 200, body: { session: id, path, bytes: await directoryBytes(path) } };
	},
	"scratch.prune": async (ctx) => {
		if (ctx.caller.kind !== "user") throw ApiError.forbidden("only the user may prune scratch");
		const body = typeof ctx.body === "object" && ctx.body !== null ? (ctx.body as Record<string, unknown>) : {};
		const result = await sweepScratch(ctx.runtime, { dryRun: body.dryRun === true });
		return { status: 200, body: result };
	},
};
