// Immutable builds. Only publish writes; every authorization and append shares its transaction.
import type { SqliteExecutor } from "@earendil-works/chord/sqlite";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { ApiError } from "../api/errors.ts";
import type { Caller } from "../api/types.ts";
import { requireOnObjective } from "../objectives/state.ts";
import type { ObjectiveRow } from "../objectives/schema.ts";
import type { Runtime } from "../server/runtime.ts";
import { insertDomainMessage, type FileRecord } from "../threads/store.ts";
import { preview } from "./capability.ts";

export interface ArtifactRow { id: string; thread_id: string; name: string; created_by: string; created_at: number }
export interface VersionRow { id: string; artifact_id: string; seq: number; entry: string; note: string | null; created_by: string; created_at: number }
export interface ManifestFile { path: string; fileId: string }
export function artifactUrl(runtime: Runtime, id: string, seq?: number) {
	return `pana://${runtime.config.domain}/artifacts/${id}${seq === undefined ? "" : `/v/${seq}`}`;
}
export function artifactView(runtime: Runtime, row: ArtifactRow) {
	return { id: row.id, threadId: row.thread_id, name: row.name, createdBy: row.created_by, createdAt: row.created_at, url: artifactUrl(runtime, row.id) };
}
export async function versionView(tx: SqliteExecutor, runtime: Runtime, row: VersionRow, origin?: string) {
	const files = await tx.all<ManifestFile & { size: number }>(`SELECT vf.path, vf.file_id AS fileId, f.size FROM artifact_version_files vf JOIN files f ON f.id = vf.file_id WHERE version_id = ? ORDER BY vf.path`, row.id);
	return { id: row.id, artifactId: row.artifact_id, seq: row.seq, entry: row.entry, note: row.note, createdBy: row.created_by, createdAt: row.created_at, url: artifactUrl(runtime, row.artifact_id, row.seq), files, ...preview(runtime, row.id, origin, row.entry) };
}

/** Read only a recorded upload under the file store. Fail closed if it is missing. */
function fileBytes(runtime: Runtime, row: FileRecord): Buffer {
	const root = resolve(runtime.paths.files);
	const path = resolve(runtime.paths.dir, row.path);
	if (!path.startsWith(root + sep)) throw new Error("invalid stored file path");
	return readFileSync(path);
}

/**
 * ART-01: a version owns whole copies. An API manifest may name a file id that an earlier version
 * already recorded, or the same id at two paths, and the `files` table has no content hash to
 * share, so record a second row with its own bytes instead of aliasing the first.
 */
async function versionFileId(tx: SqliteExecutor, runtime: Runtime, source: FileRecord, used: ReadonlySet<string>, now: number): Promise<string> {
	if (!used.has(source.id) && !await tx.get("SELECT 1 FROM artifact_version_files WHERE file_id = ? LIMIT 1", source.id)) return source.id;
	const id = runtime.newId();
	const root = resolve(runtime.paths.files);
	const absolute = resolve(root, id, source.name);
	if (!absolute.startsWith(root + sep)) throw new Error("invalid stored file path");
	const bytes = fileBytes(runtime, source);
	mkdirSync(join(root, id), { recursive: true, mode: 0o700 });
	writeFileSync(absolute, bytes, { mode: 0o600 });
	// Nothing deletes these bytes when the transaction rolls back. A write that joined pi-durable
	// work commits what it has and rethrows, so a failing publish may still own this row; an
	// unreferenced copy is garbage, a missing one is a corrupt version.
	await tx.run(
		"INSERT INTO files (id,name,path,size,media_type,uploader_id,created_at) VALUES (?,?,?,?,?,?,?)",
		id,
		source.name,
		join("files", id, source.name),
		bytes.byteLength,
		source.media_type,
		source.uploader_id,
		now,
	);
	return id;
}

/** User, active participant, or active objective member. Never joins or revives a session. */
export async function requireArtifactWriter(tx: SqliteExecutor, caller: Caller, threadId: string) {
	if (!await tx.get("SELECT id FROM threads WHERE id = ?", threadId)) throw ApiError.notFound(`thread ${threadId}`);
	if (caller.kind === "user") return;
	const session = await tx.get<{ state: string }>("SELECT state FROM sessions WHERE id = ?", caller.id);
	if (!session || ["archived", "stopped"].includes(session.state)) throw ApiError.forbidden("stopped or archived sessions cannot publish");
	if (await tx.get("SELECT 1 FROM thread_participants WHERE thread_id = ? AND participant_id = ?", threadId, caller.id)) return;
	const objective = await tx.get<ObjectiveRow>("SELECT * FROM objectives WHERE thread_id = ?", threadId);
	if (objective) return requireOnObjective(tx, objective, caller);
	throw ApiError.forbidden(`session ${caller.id} is not a writer of thread ${threadId}`);
}

export function manifestPath(value: unknown): string {
	if (typeof value !== "string" || !value || value.startsWith("/") || value.includes("\\") || value.includes("\0") || value.split("/").some(p => !p || p === "." || p === "..") || /^[a-z]:/i.test(value) || /[?#]/.test(value)) throw ApiError.badRequest("invalid_manifest", "manifest paths must be relative with no dot segments, query, or fragment");
	return value;
}
async function validate(tx: SqliteExecutor, runtime: Runtime, body: unknown) {
	if (!body || typeof body !== "object") throw ApiError.badRequest("invalid_manifest", "a manifest is required");
	const input = body as { entry?: unknown; files?: unknown; note?: unknown };
	const entry = manifestPath(input.entry);
	if (!Array.isArray(input.files) || !input.files.length || input.files.length > runtime.config.artifacts.maxFiles) throw ApiError.badRequest("invalid_manifest", "manifest file count exceeds limits");
	if (input.note !== undefined && typeof input.note !== "string") throw ApiError.badRequest("invalid_manifest", "note must be text");
	const paths = new Set<string>();
	const files: ManifestFile[] = [];
	const records = new Map<string, FileRecord>();
	let size = 0;
	for (const item of input.files) {
		if (!item || typeof item !== "object") throw ApiError.badRequest("invalid_manifest", "invalid file");
		const path = manifestPath(item.path);
		if (paths.has(path) || typeof item.fileId !== "string") throw ApiError.badRequest("invalid_manifest", "duplicate path or missing file id");
		const record = await tx.get<FileRecord>("SELECT * FROM files WHERE id = ?", item.fileId);
		if (!record) throw ApiError.badRequest("invalid_manifest", `unknown file ${item.fileId}`);
		if (record.size > runtime.config.files.maxBytes) throw ApiError.badRequest("invalid_manifest", "file exceeds files.maxBytes");
		size += record.size;
		paths.add(path); files.push({ path, fileId: item.fileId }); records.set(item.fileId, record);
	}
	if (!paths.has(entry) || size > runtime.config.artifacts.maxBytes) throw ApiError.badRequest("invalid_manifest", "missing entry or version exceeds artifacts.maxBytes");
	files.sort((a,b) => a.path.localeCompare(b.path));
	return { entry, files, records, note: (input.note as string | undefined) ?? null };
}

export async function publishArtifact(runtime: Runtime, caller: Caller, threadId: string, name: string, body: unknown, origin?: string) {
	if (!name.trim() || name.length > 200 || /[\/\\\x00-\x1f\x7f]/.test(name)) throw ApiError.badRequest("invalid_name", "artifact needs a name");
	const result = await runtime.db.write(async tx => {
		await requireArtifactWriter(tx, caller, threadId);
		const input = await validate(tx, runtime, body);
		const now = runtime.clock.now();
		let artifact = await tx.get<ArtifactRow>("SELECT * FROM artifacts WHERE thread_id = ? AND name = ?", threadId, name);
		if (!artifact) {
			artifact = { id: runtime.newId(), thread_id: threadId, name, created_by: caller.id, created_at: now };
			await tx.run("INSERT INTO artifacts (id,thread_id,name,created_by,created_at) VALUES (?,?,?,?,?)", artifact.id, threadId, name, caller.id, now);
		}
		const newest = await tx.get<VersionRow>("SELECT * FROM artifact_versions WHERE artifact_id = ? ORDER BY seq DESC LIMIT 1", artifact.id);
		if (newest) {
			const view = await versionView(tx, runtime, newest, origin);
			view.files.sort((a, b) => a.path.localeCompare(b.path));
			// Every CLI attempt uploads new file IDs. Compare bytes and paths, not upload IDs,
			// so a committed publish can be retried after losing its response.
			let identical = newest.entry === input.entry && view.files.length === input.files.length;
			for (let i = 0; identical && i < input.files.length; i++) {
				const old = view.files[i]!;
				const next = input.files[i]!;
				if (old.path !== next.path) { identical = false; break; }
				if (old.fileId === next.fileId) continue;
				const a = await tx.get<FileRecord>("SELECT * FROM files WHERE id = ?", old.fileId);
				const b = await tx.get<FileRecord>("SELECT * FROM files WHERE id = ?", next.fileId);
				if (!a || !b || a.size !== b.size || !fileBytes(runtime, a).equals(fileBytes(runtime, b))) identical = false;
			}
			if (identical) return { artifact: artifactView(runtime, artifact), version: view, created: false };
		}
		const version: VersionRow = { id: runtime.newId(), artifact_id: artifact.id, seq: (newest?.seq ?? 0) + 1, entry: input.entry, note: input.note, created_by: caller.id, created_at: now };
		await tx.run("INSERT INTO artifact_versions (id,artifact_id,seq,entry,note,created_by,created_at) VALUES (?,?,?,?,?,?,?)", version.id, artifact.id, version.seq, version.entry, version.note, caller.id, now);
		const used = new Set<string>();
		for (const file of input.files) {
			const fileId = await versionFileId(tx, runtime, input.records.get(file.fileId)!, used, now);
			used.add(fileId);
			await tx.run("INSERT INTO artifact_version_files (version_id,path,file_id) VALUES (?,?,?)", version.id, file.path, fileId);
		}
		await insertDomainMessage(tx, runtime, threadId, `${caller.url} published ${JSON.stringify(name).replace(/[\[\]<>`*_]/g, "\\$&")} v${version.seq} at ${new Date(now).toISOString()}: ${artifactUrl(runtime, artifact.id, version.seq)}`, now);
		return { artifact: artifactView(runtime, artifact), version: await versionView(tx, runtime, version, origin), created: true };
	});
	// Warning discovery is not manifest validation. Never interpret uploaded bytes as paths.
	const warnings: string[] = [];
	for (const file of result.version.files) {
		if (!/\.(html?|css|[cm]?js)$/i.test(file.path)) continue;
		const record = await runtime.db.get<FileRecord>("SELECT * FROM files WHERE id = ?", file.fileId);
		try {
			const text = fileBytes(runtime, record!).toString("utf8");
			for (const match of text.matchAll(/(?:["'`(=]\s*)(\/(?!\/)[^\s"'`<>)]*)/g)) warnings.push(`${file.path}: root-relative reference ${match[1]}`);
		} catch { warnings.push(`${file.path}: could not inspect references`); }
	}
	return { ...result, ...preview(runtime, result.version.id, origin, result.version.entry), warnings, entry: result.version.entry };
}
export async function listArtifacts(runtime: Runtime, threadId: string, origin?: string) {
	if (!await runtime.db.get("SELECT id FROM threads WHERE id = ?", threadId)) throw ApiError.notFound(`thread ${threadId}`);
	const rows = await runtime.db.all<ArtifactRow>("SELECT * FROM artifacts WHERE thread_id = ? ORDER BY name", threadId);
	return Promise.all(rows.map(async row => {
		const version = await runtime.db.get<VersionRow>("SELECT * FROM artifact_versions WHERE artifact_id = ? ORDER BY seq DESC LIMIT 1", row.id);
		return { ...artifactView(runtime, row), newestVersion: version ? await versionView(runtime.db, runtime, version, origin) : null };
	}));
}
