// HTTP handlers for Web Push (PSH-01, PSH-02, PSH-04). src/server/handlers.ts merges these
// into panad.

import { ApiError } from "../api/errors.ts";
import type { Handlers, RequestContext } from "../api/types.ts";
import { vapidKeys } from "./index.ts";

interface SubscriptionBody {
	endpoint?: unknown;
	keys?: { p256dh?: unknown; auth?: unknown };
}

function stringField(value: unknown, name: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw ApiError.badRequest("invalid_subscription", `subscription is missing ${name}`);
	}
	return value;
}

/**
 * The user is a participant, but WP2 creates participant rows on first use and the PWA can
 * subscribe before any message exists. Insert-if-missing keeps the foreign key satisfied
 * without changing another package's contract.
 */
async function ensureParticipant(ctx: RequestContext): Promise<void> {
	const { runtime, caller } = ctx;
	if (caller.kind !== "user") throw ApiError.forbidden("only the user subscribes to push notifications");
	await runtime.db.write((tx) =>
		tx.run(
			"INSERT INTO participants (id, kind, url, created_at) VALUES (?, 'user', ?, ?) ON CONFLICT(id) DO NOTHING",
			caller.id,
			caller.url,
			runtime.clock.now(),
		),
	);
}

export const handlers: Handlers = {
	"push.key": (ctx) => ({
		status: 200,
		body: { publicKey: vapidKeys(ctx.runtime).publicKey },
	}),

	"push.subscriptions.list": async (ctx) => {
		if (ctx.caller.kind !== "user") throw ApiError.forbidden("only the user has push subscriptions");
		const rows = await ctx.runtime.db.all<{ id: string; endpoint: string; created_at: number }>(
			"SELECT id, endpoint, created_at FROM push_subscriptions WHERE participant_id = ? ORDER BY created_at DESC",
			ctx.caller.id,
		);
		return {
			status: 200,
			body: { subscriptions: rows.map((row) => ({ id: row.id, endpoint: row.endpoint, createdAt: row.created_at })) },
		};
	},

	"push.subscriptions.create": async (ctx) => {
		await ensureParticipant(ctx);
		const body = (ctx.body ?? {}) as SubscriptionBody;
		const endpoint = stringField(body.endpoint, "endpoint");
		const keys = (body.keys ?? {}) as { p256dh?: unknown; auth?: unknown };
		const p256dh = stringField(keys.p256dh, "keys.p256dh");
		const auth = stringField(keys.auth, "keys.auth");
		const now = ctx.runtime.clock.now();
		const id = ctx.runtime.newId();
		await ctx.runtime.db.write((tx) =>
			tx.run(
				`INSERT INTO push_subscriptions (id, participant_id, endpoint, p256dh, auth, created_at)
				 VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT(endpoint) DO UPDATE SET
					participant_id = excluded.participant_id,
					p256dh = excluded.p256dh,
					auth = excluded.auth`,
				id,
				ctx.caller.id,
				endpoint,
				p256dh,
				auth,
				now,
			),
		);
		const row = await ctx.runtime.db.get<{ id: string }>("SELECT id FROM push_subscriptions WHERE endpoint = ?", endpoint);
		return { status: 201, body: { subscription: { id: row?.id ?? id, endpoint } } };
	},
};
