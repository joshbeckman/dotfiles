// HTTP handlers owned by WP19. src/server/handlers.ts merges these into panad.

import { ApiError } from "../api/errors.ts";
import type { Handlers, RequestContext } from "../api/types.ts";
import { addWorktree } from "./index.ts";

function body(ctx: RequestContext): Record<string, unknown> {
	const value = ctx.body;
	if (value === undefined || value === null) return {};
	if (typeof value !== "object" || Array.isArray(value)) throw ApiError.badRequest("invalid_body", "request body must be a JSON object");
	return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw ApiError.badRequest(`invalid_${field}`, `${field} must be a string`);
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}

export const handlers: Handlers = {
	// GUARD-03: a session makes its own worktree here, because its `bash` cannot write to the
	// primary checkout's `.git` (GUARD-02) and that is what `git worktree add` writes.
	"worktrees.add": async (ctx) => {
		if (ctx.caller.kind !== "session") {
			throw ApiError.forbidden("only a session makes its own worktree: the user's own checkout is theirs to edit");
		}
		const input = body(ctx);
		const repo = text(input.repo, "repo");
		if (repo === undefined) throw ApiError.badRequest("missing_repo", "name a repository: pana worktree add REPO");
		const result = await addWorktree(ctx.runtime, ctx.caller.id, {
			repo,
			...(text(input.branch, "branch") === undefined ? {} : { branch: text(input.branch, "branch") }),
			...(text(input.name, "name") === undefined ? {} : { name: text(input.name, "name") }),
		});
		return { status: result.created ? 201 : 200, body: result };
	},
};
