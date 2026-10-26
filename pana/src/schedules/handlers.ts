// HTTP handlers owned by WP6. src/server/handlers.ts merges these into panad.
//
// The shapes match what the PWA sends (web/app.js): `{kind, cron, payload: {prompt}}` on create
// and update, `{schedules}` on list, `{schedule}` on create, show, and update, and 204 on delete.

import type { Handlers } from "../api/types.ts";
import { createSchedule, deleteSchedule, listSchedules, showSchedule, updateSchedule } from "./store.ts";

export const handlers: Handlers = {
	"schedules.create": async (ctx) => ({
		status: 201,
		body: { schedule: await createSchedule(ctx.runtime, ctx.caller, ctx.body) },
	}),

	"schedules.list": async (ctx) => ({
		status: 200,
		body: { schedules: await listSchedules(ctx.runtime, ctx.query.get("kind")) },
	}),

	"schedules.show": async (ctx) => ({
		status: 200,
		body: { schedule: await showSchedule(ctx.runtime, ctx.params.id!) },
	}),

	"schedules.update": async (ctx) => ({
		status: 200,
		body: { schedule: await updateSchedule(ctx.runtime, ctx.params.id!, ctx.body) },
	}),

	"schedules.delete": async (ctx) => {
		await deleteSchedule(ctx.runtime, ctx.params.id!);
		return { status: 204 };
	},
};
