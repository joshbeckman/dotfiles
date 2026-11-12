// SET-05: the user sets a secret from the Settings page, on a phone or anywhere else without a
// terminal. The values live in the `s` store (src/secrets/index.ts); these routes are names in,
// names out. A value travels one way, in the request body, and is never read back.
//
// These three routes answer TCP only. On the Unix socket an unlabeled caller is the user
// (API-03), so every process of the user, including a session's bash, holds that authority
// without naming itself. Writing a credential into a store the rest of the machine trusts is a
// bigger act than reading settings, and the browser path (token plus Tailscale) is the one this
// feature was built for. A caller that wants these routes has to present the web token.

import type { Handlers, RequestContext } from "../api/types.ts";
import { ApiError } from "../api/errors.ts";
import { MAX_VALUE_BYTES, SecretsError, secretNameError, secretValueError } from "./index.ts";

const NO_STORE = { "cache-control": "no-store" };

function userOnly(ctx: RequestContext) {
	if (ctx.caller.kind !== "user") throw ApiError.forbidden("only the user can manage secrets");
	if (ctx.transport !== "tcp") {
		throw ApiError.forbidden("secrets are set from the PWA over TCP with the web token; this socket has no token to check");
	}
}

/** The status a store refusal becomes. A missing or broken `s` is 502: pana is fine, its tool is not. */
function refusal(error: unknown): ApiError {
	if (error instanceof ApiError) return error;
	if (!(error instanceof SecretsError)) {
		// Not the store's own refusal. Hand the original back so the daemon logs its cause
		// (API-01) instead of a wrapper that says only "internal error".
		throw error;
	}
	switch (error.code) {
		case "invalid_name":
		case "invalid_value":
			return ApiError.badRequest("invalid_secret", error.message);
		case "not_found":
			return ApiError.notFound(error.message);
		case "busy":
			return new ApiError(503, "secrets_busy", error.message);
		default:
			return new ApiError(502, "secrets_unavailable", error.message);
	}
}

function readName(ctx: RequestContext): string {
	const name = ctx.body && typeof ctx.body === "object" ? (ctx.body as { name?: unknown }).name : undefined;
	const problem = secretNameError(name);
	if (problem) throw ApiError.badRequest("invalid_secret", problem);
	return name as string;
}

export const handlers: Handlers = {
	"secrets.list": async (ctx) => {
		userOnly(ctx);
		try {
			return { status: 200, headers: NO_STORE, body: { names: await ctx.runtime.secrets.list(), available: true, maxValueBytes: MAX_VALUE_BYTES } };
		} catch (error) {
			// A store this daemon cannot reach is a state the page states plainly, not a failed page.
			// A busy queue is not that state: it is temporary, and a caller should retry rather than
			// read it as a store that is gone.
			if (error instanceof SecretsError && isPermanentStoreState(error)) {
				return { status: 200, headers: NO_STORE, body: { names: [], available: false, error: error.message, maxValueBytes: MAX_VALUE_BYTES } };
			}
			throw refusal(error);
		}
	},
	"secrets.set": async (ctx) => {
		userOnly(ctx);
		const name = readName(ctx);
		const value = (ctx.body as { value?: unknown }).value;
		const problem = secretValueError(value);
		if (problem) throw ApiError.badRequest("invalid_secret", problem);
		try {
			await ctx.runtime.secrets.set(name, value as string);
		} catch (error) {
			throw refusal(error);
		}
		return { status: 200, headers: NO_STORE, body: { names: await namesAfterWrite(ctx) } };
	},
	"secrets.remove": async (ctx) => {
		userOnly(ctx);
		const name = ctx.params.name;
		const problem = secretNameError(name);
		if (problem) throw ApiError.badRequest("invalid_secret", problem);
		try {
			await ctx.runtime.secrets.remove(name as string);
		} catch (error) {
			throw refusal(error);
		}
		return { status: 200, headers: NO_STORE, body: { names: await namesAfterWrite(ctx) } };
	},
};

/** A store state the page reports in place, rather than a failure: it cannot list, or it failed to. */
function isPermanentStoreState(error: SecretsError): boolean {
	return error.code === "unavailable" || error.code === "failed";
}

/**
 * The names after a write that has already happened. Reading them can fail on its own; that must
 * not turn a stored secret into an error the page reports as "not saved". `null` tells the page
 * the write stands and the list needs a reload.
 */
async function namesAfterWrite(ctx: RequestContext): Promise<string[] | null> {
	try {
		return await ctx.runtime.secrets.list();
	} catch (error) {
		ctx.report?.(error, "secrets: list after a write");
		return null;
	}
}
