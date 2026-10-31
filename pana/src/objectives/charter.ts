// The charter (OBJ-09, OBJ-10): exactly six sections, every change an immutable revision.
//
// A write appends one `objective_charter_revisions` row with its author and time; nothing issues
// `UPDATE` or `DELETE` on that table, and the charter is the newest revision of each section.
// `objectives.charter_rev` is the revision number a reader saw, which `baseRev` compares against
// so a stale editor gets 409 `stale_charter` rather than writing over a change it never read
// (the MEM-09 shape).
//
// OBJ-10: the user may write every section; a session may write only `Notes`, so a lead cannot
// widen its own authority. The rule keeps `Cancel` and `Escalation` the user's to grant (EDT-01).
//
// The renderer for both audiences is in `brief.ts`, because the charter text and the briefing are
// one document; this module only stores and reads.

import type { SqliteExecutor } from "@earendil-works/chord/sqlite";
import { ApiError } from "../api/errors.ts";
import type { Caller } from "../api/types.ts";
import type { Runtime } from "../server/runtime.ts";
import { CHARTER_SECTIONS, objectBody, type CharterSection, type ObjectiveRow } from "./schema.ts";
import { loadObjective, objectiveId, personView, recordObjectiveEvent, type ObjectivePersonView } from "./state.ts";

const CANONICAL = new Map<string, CharterSection>(CHARTER_SECTIONS.map((section) => [section.toLowerCase(), section]));

/** OBJ-09: a section name, matched case-insensitively, stored in its canonical spelling. */
export function charterSection(value: unknown): CharterSection {
	if (typeof value === "string") {
		const canonical = CANONICAL.get(value.trim().toLowerCase());
		if (canonical !== undefined) return canonical;
	}
	throw ApiError.badRequest("invalid_section", `section must be one of ${CHARTER_SECTIONS.join(", ")}, got ${typeof value === "string" ? value : "(none)"}`);
}

/** The same parse for a query filter, where an absent section means "every section". */
export function optionalCharterSection(value: string | undefined): CharterSection | undefined {
	return value === undefined || value.trim() === "" ? undefined : charterSection(value);
}

/** A section's text: any string, including empty, which grants nothing. */
export function charterText(value: unknown): string {
	if (typeof value !== "string") throw ApiError.badRequest("missing_body", "a charter section needs --body TEXT or --body-file PATH");
	return value;
}

export interface CharterRevisionRow {
	id: string;
	objective_id: string;
	rev: number;
	section: CharterSection;
	body: string;
	created_by: string;
	created_at: number;
}

/** One revision as a reader sees it: who wrote it, and when. */
export interface CharterRevisionView {
	id: string;
	rev: number;
	section: CharterSection;
	body: string;
	author: ObjectivePersonView;
	at: number;
}

export interface CharterSectionView {
	rev: number;
	body: string;
	author: ObjectivePersonView;
	at: number;
}

/** `GET /objectives/:id/charter` and the `charter set` answer. */
export interface CharterView {
	objective: string;
	/** The current revision number; pass it back as `baseRev` when you write. */
	rev: number;
	/** The newest revision of each section, canonical spelling, `null` where never written. */
	sections: Record<CharterSection, CharterSectionView | null>;
	/** The revisions named by the request, newest first. */
	revisions: CharterRevisionView[];
}

function revisionView(runtime: Runtime, row: CharterRevisionRow): CharterRevisionView {
	return {
		id: row.id,
		rev: row.rev,
		section: row.section,
		body: row.body,
		author: personView(runtime, row.created_by),
		at: row.created_at,
	};
}

/** Every revision, newest first. */
export async function charterRevisions(db: SqliteExecutor, objectiveId: string, section?: CharterSection): Promise<CharterRevisionRow[]> {
	return db.all<CharterRevisionRow>(
		`SELECT * FROM objective_charter_revisions
		  WHERE objective_id = ?${section === undefined ? "" : " AND section = ?"}
		  ORDER BY rev DESC`,
		objectiveId,
		...(section === undefined ? [] : [section]),
	);
}

/** OBJ-09: the charter is the newest revision of each section. */
export async function charterSections(db: SqliteExecutor, objectiveId: string): Promise<Record<CharterSection, CharterRevisionRow | undefined>> {
	const rows = await charterRevisions(db, objectiveId);
	const out = {} as Record<CharterSection, CharterRevisionRow | undefined>;
	for (const section of CHARTER_SECTIONS) out[section] = rows.find((row) => row.section === section);
	return out;
}

async function charterView(runtime: Runtime, row: ObjectiveRow, revisions: CharterRevisionRow[]): Promise<CharterView> {
	const sections = {} as Record<CharterSection, CharterSectionView | null>;
	for (const section of CHARTER_SECTIONS) {
		const newest = revisions.find((revision) => revision.section === section);
		sections[section] = newest === undefined ? null : { rev: newest.rev, body: newest.body, author: personView(runtime, newest.created_by), at: newest.created_at };
	}
	return { objective: runtime.url({ kind: "objective", id: row.id }), rev: row.charter_rev, sections, revisions: revisions.map((revision) => revisionView(runtime, revision)) };
}

/** `GET /objectives/:id/charter` (OBJ-09): every revision, or one section's, newest first. */
export async function charterLog(runtime: Runtime, value: string | null | undefined, section?: CharterSection): Promise<CharterView> {
	const id = objectiveId(value, runtime.config.domain);
	const row = await loadObjective(runtime.db, id);
	return charterView(runtime, row, await charterRevisions(runtime.db, id, section));
}

export interface SetCharterInput {
	section?: unknown;
	body?: unknown;
	baseRev?: unknown;
}

function baseRevision(value: unknown): number | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		throw ApiError.badRequest("invalid_base_rev", "baseRev must be a non-negative integer revision number");
	}
	return value;
}

/**
 * `POST /objectives/:id/charter` (OBJ-09, OBJ-10): append one revision. A session may write only
 * `Notes`. `baseRev` is the revision the caller read; a charter that moved since then is 409
 * `stale_charter` and writes nothing. Omitted `baseRev` writes the newest version.
 */
export async function setCharter(runtime: Runtime, caller: Caller, value: string | null | undefined, raw: unknown): Promise<CharterView> {
	const input = objectBody(raw) as SetCharterInput;
	const id = objectiveId(value, runtime.config.domain);
	const section = charterSection(input.section);
	const body = charterText(input.body);
	const baseRev = baseRevision(input.baseRev);

	// OBJ-10: a lead cannot widen its own authority; only the user grants Cancel or Escalation.
	if (caller.kind === "session" && section !== "Notes") {
		throw ApiError.forbidden(`a session may write only the charter's Notes, not ${section}`, { section });
	}

	await runtime.db.atomically(async (tx) => {
		const row = await loadObjective(tx, id);
		if (baseRev !== undefined && baseRev !== row.charter_rev) {
			throw new ApiError(409, "stale_charter", `charter ${id} is at revision ${row.charter_rev}, not ${baseRev}`, {
				objective: id,
				charterRev: row.charter_rev,
				baseRev,
			});
		}
		const now = runtime.clock.now();
		const rev = row.charter_rev + 1;
		await tx.run(
			"INSERT INTO objective_charter_revisions (id, objective_id, rev, section, body, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			runtime.newId(),
			id,
			rev,
			section,
			body,
			caller.id,
			now,
		);
		await tx.run("UPDATE objectives SET charter_rev = ?, updated_at = ? WHERE id = ?", rev, now, id);
		await recordObjectiveEvent(tx, runtime, { objectiveId: id, kind: "charter.set", actorId: caller.id, detail: { section, rev } });
	});

	const row = await loadObjective(runtime.db, id);
	return charterView(runtime, row, await charterRevisions(runtime.db, id));
}
