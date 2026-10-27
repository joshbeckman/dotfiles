// HTTP handlers owned by WP5. src/server/handlers.ts merges these into panad.
//
// The CLI (WP1) and the PWA (WP8) both reach memory here, so MEM-09's "commit as the user through
// the same path as MEM-03" is one code path: the caller decides the writer, never the transport.

import { ApiError } from "../api/errors.ts";
import type { Caller, Handlers, RequestContext } from "../api/types.ts";
import type { Runtime } from "../server/runtime.ts";
import { assertWriterId, Memory, normalizeMemoryPath, type MemoryWriter } from "./repo.ts";

export function memoryFor(runtime: Runtime): Memory {
	return new Memory({
		gitDir: runtime.paths.memoryGit,
		worktreesDir: runtime.paths.memoryWorktrees,
		domain: runtime.config.domain,
		now: () => runtime.clock.now(),
	});
}

export function writerOf(caller: Caller): MemoryWriter {
	assertWriterId(caller.id);
	return { id: caller.id, url: caller.url };
}

function bodyObject(body: unknown): Record<string, unknown> {
	return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function optionalNumber(raw: string | null): number | undefined {
	if (raw === null || raw.trim().length === 0) return undefined;
	const value = Number(raw);
	return Number.isFinite(value) ? value : undefined;
}

export const handlers: Handlers = {
	"memory.worktree": async (ctx: RequestContext) => {
		const tree = await memoryFor(ctx.runtime).worktree(writerOf(ctx.caller));
		return { status: 200, body: tree };
	},
	"memory.worktree.create": async (ctx: RequestContext) => {
		const tree = await memoryFor(ctx.runtime).worktree(writerOf(ctx.caller));
		return { status: tree.created ? 201 : 200, body: tree };
	},
	"memory.commit": async (ctx: RequestContext) => {
		const message = bodyObject(ctx.body).message;
		if (typeof message !== "string") throw ApiError.badRequest("missing_message", "memory commit needs a message");
		const result = await memoryFor(ctx.runtime).commit(writerOf(ctx.caller), message);
		return { status: 200, body: result };
	},
	"memory.search": async (ctx: RequestContext) => {
		const query = ctx.query.get("query") ?? ctx.query.get("q") ?? "";
		const result = await memoryFor(ctx.runtime).search(query, optionalNumber(ctx.query.get("limit")));
		return { status: 200, body: result };
	},
	"memory.log": async (ctx: RequestContext) => {
		const path = ctx.query.get("path");
		const commits = await memoryFor(ctx.runtime).log({ path: path ?? undefined, limit: optionalNumber(ctx.query.get("limit")) });
		return { status: 200, body: { tree: "main", path, commits } };
	},
	"memory.commit.show": async (ctx: RequestContext) => {
		const commit = await memoryFor(ctx.runtime).showCommit(ctx.params.hash ?? "");
		return { status: 200, body: commit };
	},
	"memory.files.read": async (ctx: RequestContext) => {
		const path = normalizeMemoryPath(ctx.params.rest ?? "");
		const file = await memoryFor(ctx.runtime).readFile(path);
		if (!file) throw ApiError.notFound(`memory file ${path}`);
		return { status: 200, body: file };
	},
	"memory.files.list": async (ctx: RequestContext) => ({
		status: 200,
		body: { tree: "main", files: await memoryFor(ctx.runtime).listFiles() },
	}),
	"memory.files.write": async (ctx: RequestContext) => {
		const path = normalizeMemoryPath(ctx.params.rest ?? "");
		const body = bodyObject(ctx.body);
		if (typeof body.content !== "string") throw ApiError.badRequest("missing_content", "memory file needs content");
		const message = typeof body.message === "string" ? body.message : "";
		const result = await memoryFor(ctx.runtime).writeFile(writerOf(ctx.caller), path, body.content, message);
		return {
			status: result.committed ? 201 : 200,
			body: { path, worktree: result.path, branch: result.branch, committed: result.committed, commit: result.commit },
		};
	},
};
