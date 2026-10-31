// HTTP handlers owned by WP18's foundation (OBJ-01, OBJ-05, OBJ-07). src/server/handlers.ts
// merges these into panad.
//
// One line per route: the work lives in `store.ts`, `launch.ts`, and `gates.ts`. Every other
// objectives route is in `src/api/routes.ts` and answers 501 `not_implemented` until the package
// that owns it adds its handler the same way — one entry per route, keyed by the route name.

import { ApiError } from "../api/errors.ts";
import { parseLimit } from "../api/pagination.ts";
import { isUlid, parseRef, RefError } from "../ids/index.ts";
import type { HandlerResult, Handlers, RequestContext } from "../api/types.ts";
import { addArtifact, removeArtifact } from "./artifacts.ts";
import { archiveObjective, finishObjective, resumeObjective, stopAllObjectives, stopObjective } from "./gates.ts";
import { launchObjective } from "./launch.ts";
import { addMetric, appendReading, listMetrics, setMetric } from "./metrics.ts";
import { reportObjective } from "./reports.ts";
import { objectBody, phaseFilter } from "./schema.ts";
import { objectiveId } from "./state.ts";
import { createObjective } from "./store.ts";
import { listObjectives, showObjective } from "./view.ts";

const OBJECTIVE_LIMIT = 50;

function query(ctx: RequestContext, name: string): string | undefined {
	const value = ctx.query.get(name);
	return value === null || value === "" ? undefined : value;
}

/** A creator filter: a username, a session ULID, or a same-domain participant URL. */
function creatorFilter(ctx: RequestContext): string | undefined {
	const value = query(ctx, "creator");
	if (value === undefined) return undefined;
	const text = value.trim();
	if (isUlid(text)) return text;
	try {
		const ref = parseRef(text, ctx.runtime.config.domain);
		if (ref.kind === "user" || ref.kind === "session") return ref.id;
	} catch (error) {
		if (error instanceof RefError) throw ApiError.badRequest(error.code, error.message);
		throw error;
	}
	throw ApiError.badRequest("invalid_creator", `${text} is not a user or a session`);
}

export const handlers: Handlers = {
	"objectives.create": async (ctx): Promise<HandlerResult> => {
		const created = await createObjective(ctx.runtime, ctx.caller, ctx.body);
		return { status: 201, body: { objective: await showObjective(ctx.runtime, created.objective.id) } };
	},

	"objectives.list": async (ctx): Promise<HandlerResult> => {
		const page = await listObjectives(ctx.runtime, {
			phase: phaseFilter(query(ctx, "phase")),
			creator: creatorFilter(ctx),
			limit: parseLimit(query(ctx, "limit"), OBJECTIVE_LIMIT),
			cursor: query(ctx, "cursor"),
		});
		return { status: 200, body: { objectives: page.items, nextCursor: page.nextCursor } };
	},

	"objectives.show": async (ctx): Promise<HandlerResult> => ({
		status: 200,
		body: { objective: await showObjective(ctx.runtime, objectiveId(ctx.params.id, ctx.runtime.config.domain)) },
	}),

	"objectives.launch": async (ctx): Promise<HandlerResult> => ({
		status: 200,
		body: { objective: await launchObjective(ctx.runtime, ctx.caller, ctx.params.id) },
	}),

	"objectives.stop": async (ctx): Promise<HandlerResult> => ({
		status: 200,
		body: { objective: await stopObjective(ctx.runtime, ctx.caller, ctx.params.id) },
	}),

	"objectives.stopAll": async (ctx): Promise<HandlerResult> => ({
		status: 200,
		body: { objectives: await stopAllObjectives(ctx.runtime, ctx.caller) },
	}),

	"objectives.resume": async (ctx): Promise<HandlerResult> => ({
		status: 200,
		body: { objective: await resumeObjective(ctx.runtime, ctx.caller, ctx.params.id) },
	}),

	"objectives.done": async (ctx): Promise<HandlerResult> => ({
		status: 200,
		body: { objective: await finishObjective(ctx.runtime, ctx.caller, ctx.params.id) },
	}),

	"objectives.archive": async (ctx): Promise<HandlerResult> => ({
		status: 200,
		body: { objective: await archiveObjective(ctx.runtime, ctx.caller, ctx.params.id) },
	}),

	// OBJ-25..OBJ-29: metrics. The `GET` answers every metric's readings in time order, its target,
	// and its current value; the writes answer with the one metric they touched.
	"objectives.metrics.list": async (ctx): Promise<HandlerResult> => ({
		status: 200,
		body: await listMetrics(ctx.runtime, ctx.params.id),
	}),

	"objectives.metrics.add": async (ctx): Promise<HandlerResult> => ({
		status: 201,
		body: { metric: await addMetric(ctx.runtime, ctx.caller, ctx.params.id, ctx.body) },
	}),

	"objectives.metrics.set": async (ctx): Promise<HandlerResult> => ({
		status: 200,
		body: { metric: await setMetric(ctx.runtime, ctx.caller, ctx.params.id, ctx.params.name ?? "", ctx.body) },
	}),

	"objectives.metrics.readings": async (ctx): Promise<HandlerResult> => ({
		status: 201,
		body: { metric: await appendReading(ctx.runtime, ctx.caller, ctx.params.id, ctx.params.name ?? "", ctx.body) },
	}),

	// OBJ-30: a report is mail in the objective's thread plus its mark, so the reply is the message
	// and the thread as `POST /threads/:id/messages` returns them, with the marked report beside it.
	"objectives.report": async (ctx): Promise<HandlerResult> => {
		const posted = await reportObjective(ctx.runtime, ctx.caller, ctx.params.id, { body: objectBody(ctx.body).body });
		return { status: 201, body: posted };
	},

	// OBJ-31: the CLI uploads through `POST /files` and links the id; the refreshed view comes back
	// so a PWA action can render the artifact list without a second read.
	"objectives.artifacts.add": async (ctx): Promise<HandlerResult> => {
		const added = await addArtifact(ctx.runtime, ctx.params.id, { file: objectBody(ctx.body).file });
		return { status: 201, body: { ...added, objective: await showObjective(ctx.runtime, objectiveId(ctx.params.id, ctx.runtime.config.domain)) } };
	},

	"objectives.artifacts.remove": async (ctx): Promise<HandlerResult> => {
		const removed = await removeArtifact(ctx.runtime, ctx.params.id, ctx.params.fileId);
		return { status: 200, body: { ...removed, objective: await showObjective(ctx.runtime, objectiveId(ctx.params.id, ctx.runtime.config.domain)) } };
	},
};
