// HTTP handlers owned by WP3. src/server/handlers.ts merges these into panad.

import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { ApiError } from "../api/errors.ts";
import { parseLimit } from "../api/pagination.ts";
import type { HandlerResult, Handlers, RequestContext } from "../api/types.ts";
import { isUlid, parseRef } from "../ids/index.ts";
import { createSession } from "./create.ts";
import { sessionRuntime } from "./runtime.ts";
import { findSessions, SESSION_LIMIT, sessionRow, sessionView, showSession, transcript, waitingConversations } from "./views.ts";

function bodyObject(ctx: RequestContext): Record<string, unknown> {
	const body = ctx.body;
	if (body === undefined || body === null) return {};
	if (typeof body !== "object" || Array.isArray(body)) {
		throw ApiError.badRequest("invalid_body", "request body must be a JSON object");
	}
	return body as Record<string, unknown>;
}

/** A session ID from a bare ULID or a session URL. */
function sessionId(ctx: RequestContext, value: string | null | undefined): string {
	const text = (value ?? "").trim();
	if (isUlid(text)) return text;
	const ref = parseRef(text, ctx.runtime.config.domain);
	if (ref.kind !== "session") throw ApiError.badRequest("invalid_session", `${text} is not a session`);
	return ref.id;
}

function query(ctx: RequestContext, name: string): string | undefined {
	const value = ctx.query.get(name);
	return value === null || value === "" ? undefined : value;
}

function integer(value: string | undefined, name: string): number | undefined {
	if (value === undefined) return undefined;
	const n = Number(value);
	if (!Number.isInteger(n) || n < 0) throw ApiError.badRequest(`invalid_${name}`, `${name} must be a non-negative integer`);
	return n;
}

/**
 * Who may stop, resume, or compact a session. The user controls every session; a session controls
 * itself, the sessions it created, and — OBJ-13 — any member of the objective it leads. The last
 * one is the objective's role and not the creating parent: a lead that regenerated into an
 * objective did not create its predecessor's members, and it must still be able to retire them.
 */
async function authorizeControl(ctx: RequestContext, id: string): Promise<void> {
	const row = await sessionRow(ctx.runtime, id);
	if (ctx.caller.kind === "user") return;
	if (ctx.caller.id === id || row.parent === ctx.caller.id) return;
	if (row.objective_id !== null) {
		const objective = await ctx.runtime.db.get<{ lead_id: string | null }>("SELECT lead_id FROM objectives WHERE id = ?", row.objective_id);
		if (objective?.lead_id === ctx.caller.id) return;
	}
	throw ApiError.forbidden(`session ${ctx.caller.id} may not control session ${id}`);
}

async function shown(ctx: RequestContext, id: string, status = 200): Promise<HandlerResult> {
	const row = await sessionRow(ctx.runtime, id);
	const waiting = waitingConversations(await ctx.runtime.harness.inspect(BG));
	return { status, body: { session: sessionView(ctx.runtime, row, waiting) } };
}


export const handlers: Handlers = {
	"sessions.create": async (ctx): Promise<HandlerResult> => {
		const body = bodyObject(ctx);
		const created = await createSession(ctx.runtime, ctx.caller, body);
		const waiting = waitingConversations(await ctx.runtime.harness.inspect(BG));
		return {
			status: 201,
			body: { session: sessionView(ctx.runtime, created.session, waiting), thread: created.thread, message: created.message },
		};
	},

	"sessions.search": async (ctx): Promise<HandlerResult> => {
		const parent = query(ctx, "parent");
		const page = await findSessions(ctx.runtime, {
			query: query(ctx, "query"),
			state: query(ctx, "state"),
			parent: parent === undefined ? undefined : sessionId(ctx, parent),
			limit: parseLimit(query(ctx, "limit"), SESSION_LIMIT),
			cursor: query(ctx, "cursor"),
		});
		return { status: 200, body: { sessions: page.items, nextCursor: page.nextCursor } };
	},

	"sessions.show": async (ctx): Promise<HandlerResult> => ({
		status: 200,
		body: { session: await showSession(ctx.runtime, sessionId(ctx, ctx.params.id)) },
	}),

	"sessions.transcript": async (ctx): Promise<HandlerResult> => ({
		status: 200,
		body: await transcript(ctx.runtime, sessionId(ctx, ctx.params.id), {
			after: integer(query(ctx, "after"), "after"),
			before: integer(query(ctx, "before"), "before"),
			latest: query(ctx, "latest") === "1" || query(ctx, "latest") === "true",
			limit: integer(query(ctx, "limit"), "limit"),
		}),
	}),

	"sessions.stop": async (ctx): Promise<HandlerResult> => {
		const id = sessionId(ctx, ctx.params.id);
		await authorizeControl(ctx, id);
		const row = await sessionRow(ctx.runtime, id);
		// OBJ-14: the user's own stop writes `user`; a session retiring a member writes `objective`,
		// which the lead may later resume. A session outside an objective records neither, and a
		// session never overwrites the user's reason on a member the user already stopped.
		const stoppedBy = ctx.caller.kind === "user" ? "user" : row.stopped_by === "user" ? "user" : row.objective_id !== null ? "objective" : null;
		await sessionRuntime(ctx.runtime).stop(id, stoppedBy);
		return shown(ctx, id);
	},

	"sessions.resume": async (ctx): Promise<HandlerResult> => {
		const id = sessionId(ctx, ctx.params.id);
		await authorizeControl(ctx, id);
		const row = await sessionRow(ctx.runtime, id);
		// OBJ-14: a member the user stopped is inert to the objective: no gate, condition, schedule,
		// or lead revives it. The user resumes it themselves.
		if (ctx.caller.kind !== "user" && row.stopped_by === "user") {
			throw ApiError.forbidden(`session ${id} was stopped by the user; only the user may resume it`, { session: id });
		}
		await sessionRuntime(ctx.runtime).resume(id);
		return shown(ctx, id);
	},

	"sessions.compact": async (ctx): Promise<HandlerResult> => {
		const id = sessionId(ctx, ctx.params.id);
		await authorizeControl(ctx, id);
		const row = await sessionRow(ctx.runtime, id);
		if (row.state === "archived") throw ApiError.stale(`session ${id} is archived`, { session: id });
		const conversation =
			row.conversation_id === null ? undefined : await ctx.runtime.harness.conversation(row.conversation_id as ConversationId, BG);
		if (!conversation) throw ApiError.notFound(`session ${id} has no conversation`);
		const body = bodyObject(ctx);
		const instructions = typeof body.instructions === "string" && body.instructions.trim() ? body.instructions : undefined;
		const taskId = await conversation.compact(instructions, BG);
		return { status: 202, body: { session: id, task: taskId } };
	},

	// REF-02: only the user archives a session; the archived state itself is STA-07.
	"sessions.archive": async (ctx): Promise<HandlerResult> => {
		if (ctx.caller.kind !== "user") throw ApiError.forbidden("only the user may archive a session");
		const id = sessionId(ctx, ctx.params.id);
		await sessionRuntime(ctx.runtime).archive(id);
		return shown(ctx, id);
	},
};
