// HTTP handlers for Web Push (PSH-01, PSH-02, PSH-04). src/server/handlers.ts merges these
// into panad.

import { ApiError } from "../api/errors.ts";
import type { Handlers, RequestContext } from "../api/types.ts";
import { MAX_SUBSCRIPTIONS, endpointProblem, vapidKeys } from "./index.ts";

interface SubscriptionBody {
	endpoint?: unknown;
	keys?: { p256dh?: unknown; auth?: unknown };
}

/** A browser's endpoint is a few hundred characters; keys are 22 and 88. Cap far above both. */
const MAX_ENDPOINT_LENGTH = 2048;
const MAX_KEY_LENGTH = 256;

function stringField(value: unknown, name: string, limit = MAX_KEY_LENGTH): string {
	if (typeof value !== "string" || value.length === 0) {
		throw ApiError.badRequest("invalid_subscription", `subscription is missing ${name}`);
	}
	if (value.length > limit) throw ApiError.badRequest("invalid_subscription", `subscription ${name} is too long`);
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
		const endpoint = stringField(body.endpoint, "endpoint", MAX_ENDPOINT_LENGTH);
		const problem = endpointProblem(endpoint);
		if (problem) throw ApiError.badRequest("invalid_subscription", `push endpoint ${problem}`);
		const keys = (body.keys ?? {}) as { p256dh?: unknown; auth?: unknown };
		const p256dh = stringField(keys.p256dh, "keys.p256dh");
		const auth = stringField(keys.auth, "keys.auth");
		const now = ctx.runtime.clock.now();
		const id = ctx.runtime.newId();
		const storedId = await ctx.runtime.db.write(async (tx) => {
			// Only refreshing an endpoint this participant already holds is exempt from the cap.
			// Count and upsert under the same write transaction, including ownership transfers.
			const held = await tx.get<{ n: number }>(
				"SELECT COUNT(*) AS n FROM push_subscriptions WHERE participant_id = ?", ctx.caller.id,
			);
			const known = await tx.get<{ n: number }>(
				"SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint = ? AND participant_id = ?", endpoint, ctx.caller.id,
			);
			if ((known?.n ?? 0) === 0 && (held?.n ?? 0) >= MAX_SUBSCRIPTIONS) {
				throw new ApiError(409, "too_many_subscriptions", `a participant may hold ${MAX_SUBSCRIPTIONS} push subscriptions`);
			}
			await tx.run(
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
			);
			const row = await tx.get<{ id: string }>("SELECT id FROM push_subscriptions WHERE endpoint = ?", endpoint);
			return row!.id;
		});
		return { status: 201, body: { subscription: { id: storedId, endpoint } } };
	},
};
