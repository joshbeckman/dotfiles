import { extname } from "node:path";
import { ApiError } from "../api/errors.ts";
import type { Handlers, RequestContext } from "../api/types.ts";
import { loadFile } from "../threads/files.ts";
import { ARTIFACT_HEADERS, preview, verify } from "./capability.ts";
import { artifactView, listArtifacts, publishArtifact, versionView, type ArtifactRow, type VersionRow } from "./store.ts";

// The Host was checked by the request pipeline. TCP readers need the same origin they
// reached; socket callers use the daemon's advertised tailnet or loopback origin.
function previewOrigin(ctx: RequestContext): string | undefined {
	if (ctx.transport !== "tcp") return ctx.runtime.artifactOrigin;
	const host = ctx.headers.host;
	if (typeof host !== "string") return ctx.runtime.artifactOrigin;
	const hostname = host.split(":")[0]!.toLowerCase();
	return `${hostname === "localhost" || hostname === "127.0.0.1" ? "http" : "https"}://${host}`;
}
const MIME: Record<string,string> = { html: "text/html", css: "text/css", js: "text/javascript", mjs: "text/javascript", json: "application/json", wasm: "application/wasm", svg: "image/svg+xml", png: "image/png", jpeg: "image/jpeg", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", woff2: "font/woff2", txt: "text/plain", md: "text/markdown" };
async function bytes(ctx: RequestContext) {
	const { runtime, params } = ctx;
	if (!verify(runtime, params.version!, params.capability ?? "")) throw ApiError.forbidden("invalid or expired artifact capability");
	const version = await runtime.db.get<VersionRow>("SELECT * FROM artifact_versions WHERE id = ?", params.version!);
	if (!version) throw ApiError.notFound("artifact version");
	const path = params.rest || version.entry;
	const file = await runtime.db.get<{ id: string; name: string }>(`SELECT f.id,f.name FROM artifact_version_files vf JOIN files f ON f.id = vf.file_id WHERE vf.version_id = ? AND vf.path = ?`, version.id, path);
	if (!file) throw ApiError.notFound("artifact path");
	const loaded = await loadFile(runtime, file.id, file.name);
	const type = MIME[extname(path).slice(1).toLowerCase()];
	return { status: 200, bytes: loaded.bytes, headers: { ...ARTIFACT_HEADERS, "content-type": type ?? "application/octet-stream", ...(type ? {} : { "content-disposition": "attachment" }) } };
}
export const handlers: Handlers = {
	"artifacts.publish": async ctx => {
		const result = await publishArtifact(ctx.runtime, ctx.caller, ctx.params.id!, ctx.params.name!, ctx.body, previewOrigin(ctx));
		return { status: result.created ? 201 : 200, body: result };
	},
	"artifacts.list": async ctx => ({ status: 200, body: { artifacts: await listArtifacts(ctx.runtime, ctx.params.id!, previewOrigin(ctx)) } }),
	"artifacts.show": async ctx => {
		const artifact = await ctx.runtime.db.get<ArtifactRow>("SELECT * FROM artifacts WHERE id = ?", ctx.params.id!);
		if (!artifact) throw ApiError.notFound("artifact");
		const rows = await ctx.runtime.db.all<VersionRow>("SELECT * FROM artifact_versions WHERE artifact_id = ? ORDER BY seq", artifact.id);
		const versions = await Promise.all(rows.map(row => versionView(ctx.runtime.db, ctx.runtime, row, previewOrigin(ctx))));
		const seq = ctx.query.get("seq");
		const version = seq === null ? versions.at(-1) : versions.find(v => String(v.seq) === seq);
		if (!version) throw ApiError.notFound("artifact version");
		return { status: 200, body: { artifact: artifactView(ctx.runtime, artifact), versions: versions.map(v => ({ ...v, pinned: v.id === version.id })), version, ...preview(ctx.runtime, version.id, previewOrigin(ctx)) } };
	},
	"artifacts.bytes": bytes,
	"artifacts.entry": bytes,
	"artifacts.stats": async ctx => {
		const threads = await ctx.runtime.db.all<{threadId:string; bytes:number}>(`SELECT a.thread_id AS threadId, SUM(f.size) AS bytes FROM artifacts a JOIN artifact_versions v ON v.artifact_id = a.id JOIN artifact_version_files vf ON vf.version_id = v.id JOIN files f ON f.id = vf.file_id GROUP BY a.thread_id ORDER BY a.thread_id`);
		return { status: 200, body: { threads, bytes: threads.reduce((sum,row) => sum + row.bytes, 0) } };
	},
};
