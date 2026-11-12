// SET-05: the user sets a secret from the Settings page, on a phone or anywhere else without a
// terminal. The values live in the `s` store (src/secrets/index.ts); these routes are names in,
// names out. A value travels one way, in the request body, and is never read back.

import type { Handlers, RequestContext } from "../api/types.ts";
import { ApiError } from "../api/errors.ts";
import { MAX_VALUE_BYTES, SecretsError, secretNameError, secretValueError } from "./index.ts";

const NO_STORE = { "cache-control": "no-store" };

function userOnly(ctx: RequestContext) {
	if (ctx.caller.kind !== "user") throw ApiError.forbidden("only the user can manage secrets");
}

/** The status a store refusal becomes. A missing or broken `s` is 502: pana is fine, its tool is not. */
function refusal(error: unknown): ApiError {
	if (!(error instanceof SecretsError)) return error instanceof ApiError ? error : new ApiError(500, "internal", "internal error");
	switch (error.code) {
		case "invalid_name":
		case "invalid_value":
			return ApiError.badRequest("invalid_secret", error.message);
		case "not_found":
			return ApiError.notFound(error.message);
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
			if (error instanceof SecretsError && error.code !== "invalid_name" && error.code !== "invalid_value") {
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
		return { status: 200, headers: NO_STORE, body: { names: await names(ctx) } };
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
		return { status: 200, headers: NO_STORE, body: { names: await names(ctx) } };
	},
};

/** The names after a write. A store that just accepted a write still answers this. */
async function names(ctx: RequestContext): Promise<string[]> {
	try {
		return await ctx.runtime.secrets.list();
	} catch (error) {
		throw refusal(error);
	}
}
