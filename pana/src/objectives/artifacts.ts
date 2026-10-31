// Artifacts (OBJ-31).
//
// An artifact is a row in `objective_files` pointing at a file `POST /files` already stored. The
// upload path is WP2's, unchanged (FIL-01..FIL-07: the size limit, the media type, and `?w=`
// derivatives all apply because the bytes are an ordinary file). Linking never copies bytes, and
// unlinking never deletes them: a report or a thread message may reference the same file, and a
// file's bytes never change for one id (FIL-07).

import type { SqliteExecutor } from "@earendil-works/chord/sqlite";
import { ApiError } from "../api/errors.ts";
import { isUlid, parseRef, RefError } from "../ids/index.ts";
import type { Runtime } from "../server/runtime.ts";
import type { FileRecord } from "../threads/store.ts";
import { loadObjective, objectiveId } from "./state.ts";

/** One linked file: what the objective view lists (name, size, and file URL, OBJ-31). */
export interface ObjectiveArtifactView {
	/** The file id, which `pana objective artifact remove` takes. */
	id: string;
	name: string;
	size: number;
	mediaType: string | null;
	/** The file's URL, which serves the bytes (and accepts `?w=` for a derivative). */
	url: string;
	addedAt: number;
}

/** A file id from a bare ULID or a `pana://<domain>/files/<id>/<name>` URL. */
function fileId(value: unknown, domain: string): string {
	const text = typeof value === "string" ? value.trim() : "";
	if (text.length === 0) throw ApiError.badRequest("missing_file", "an artifact needs a file id from POST /files");
	if (isUlid(text)) return text;
	try {
		const ref = parseRef(text, domain);
		if (ref.kind === "file") return ref.id;
	} catch (error) {
		if (error instanceof RefError) throw ApiError.badRequest(error.code, error.message);
		throw error;
	}
	throw ApiError.badRequest("invalid_file", `${text} is not a file`);
}

/**
 * `POST /objectives/:id/artifacts`: link an uploaded file. The CLI uploads through `POST /files`
 * first and sends the id here, so panad never reads a client path. Linking twice is the same as
 * linking once.
 */
export async function addArtifact(
	runtime: Runtime,
	value: string | null | undefined,
	input: { file?: unknown },
): Promise<{ artifact: ObjectiveArtifactView }> {
	const id = objectiveId(value, runtime.config.domain);
	const row = await loadObjective(runtime.db, id);
	const file = fileId(input.file, runtime.config.domain);
	const record = await runtime.db.get<FileRecord>("SELECT * FROM files WHERE id = ?", file);
	if (!record) throw ApiError.notFound(`file ${file}`);
	const now = runtime.clock.now();
	await runtime.db.write(async (tx) => {
		await tx.run("INSERT OR IGNORE INTO objective_files (objective_id, file_id, created_at) VALUES (?, ?, ?)", row.id, file, now);
	});
	return { artifact: await artifactView(runtime, row.id, file) };
}

/** `DELETE /objectives/:id/artifacts/:fileId`: unlink only. The file and its bytes stay. */
export async function removeArtifact(
	runtime: Runtime,
	value: string | null | undefined,
	fileValue: string | null | undefined,
): Promise<{ artifact: ObjectiveArtifactView; removed: string }> {
	const id = objectiveId(value, runtime.config.domain);
	const row = await loadObjective(runtime.db, id);
	const file = fileId(fileValue, runtime.config.domain);
	const linked = await runtime.db.get<{ file_id: string }>(
		"SELECT file_id FROM objective_files WHERE objective_id = ? AND file_id = ?",
		row.id,
		file,
	);
	if (!linked) throw ApiError.notFound(`artifact ${file} on objective ${row.id}`);
	const artifact = await artifactView(runtime, row.id, file);
	await runtime.db.write((tx) => tx.run("DELETE FROM objective_files WHERE objective_id = ? AND file_id = ?", row.id, file));
	return { artifact, removed: file };
}

/** Every artifact an objective lists, oldest link first. */
export async function objectiveArtifacts(tx: SqliteExecutor, runtime: Runtime, objectiveId: string): Promise<ObjectiveArtifactView[]> {
	const rows = await tx.all<FileRecord & { added_at: number }>(
		`SELECT f.*, of.created_at AS added_at
		   FROM objective_files of JOIN files f ON f.id = of.file_id
		  WHERE of.objective_id = ?
		  ORDER BY of.created_at, f.id`,
		objectiveId,
	);
	return rows.map((row) => viewOf(runtime, row, row.added_at));
}

async function artifactView(runtime: Runtime, objectiveId: string, file: string): Promise<ObjectiveArtifactView> {
	const row = await runtime.db.get<FileRecord & { added_at: number }>(
		`SELECT f.*, of.created_at AS added_at
		   FROM objective_files of JOIN files f ON f.id = of.file_id
		  WHERE of.objective_id = ? AND of.file_id = ?`,
		objectiveId,
		file,
	);
	if (!row) throw ApiError.notFound(`artifact ${file} on objective ${objectiveId}`);
	return viewOf(runtime, row, row.added_at);
}

function viewOf(runtime: Runtime, row: FileRecord, addedAt: number): ObjectiveArtifactView {
	return {
		id: row.id,
		name: row.name,
		size: row.size,
		mediaType: row.media_type,
		url: runtime.url({ kind: "file", id: row.id, name: row.name }),
		addedAt,
	};
}
