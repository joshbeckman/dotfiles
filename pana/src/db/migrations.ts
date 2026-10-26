// Migration runner (DB-03). Numbered, idempotent, and refusing a database newer than the code.

import type { SqliteDatabase } from "@earendil-works/chord/sqlite";
import { ConfigError } from "../config/index.ts";
import { MIGRATIONS, SCHEMA_VERSION } from "./schema.ts";

async function userVersion(db: SqliteDatabase): Promise<number> {
	const row = await db.get<{ user_version: number }>("PRAGMA user_version");
	return row?.user_version ?? 0;
}

/**
 * Apply every pending pana migration inside its own transaction, then advance
 * `PRAGMA user_version`. Re-running is a no-op (idempotent). A database whose recorded
 * version is newer than this code refuses to open with exit code 1 (DB-03).
 */
export async function migrate(db: SqliteDatabase): Promise<number> {
	const current = await userVersion(db);
	if (current > SCHEMA_VERSION) {
		throw new ConfigError(
			`pana.sqlite is at schema version ${current}, newer than this build (${SCHEMA_VERSION}). Upgrade pana.`,
			1,
		);
	}
	for (const migration of MIGRATIONS) {
		if (migration.version <= current) continue;
		// `user_version` is transactional, so a crash mid-migration leaves the old version and no new tables.
		// PRAGMA takes no bindings; the version is an integer from MIGRATIONS.
		await db.transaction(async (tx) => {
			await tx.exec(migration.sql);
			await tx.exec(`PRAGMA user_version = ${migration.version}`);
		});
	}
	return userVersion(db);
}
