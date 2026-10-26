// Shared SQLite connection for pana tables and pi-durable storage (DB-01).
//
// One adapter backs both. Pana runs its SQL through `db`, and pi-durable runs its storage
// through `SqliteStorage.open(db, { prefix: "pi_" })` on the same `PanaDatabase`. See
// `atomic.ts` for how a pana write and the pi-durable commits it causes share one transaction.

import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { PanaDatabase, type PanaDatabaseOptions } from "./atomic.ts";
import { migrate } from "./migrations.ts";

export const PI_PREFIX = "pi_";

export interface SharedDatabase {
	db: PanaDatabase;
	storage: SqliteStorage;
	/** Schema version after migration (DB-03). */
	version: number;
}

/**
 * Open the SQLite file, run pana migrations, and open pi-durable storage over the same
 * adapter under the `pi_` prefix. Closing the Harness closes the storage, which closes `db`.
 */
export async function openSharedDatabase(path: string, options: PanaDatabaseOptions = {}): Promise<SharedDatabase> {
	const db = new PanaDatabase(await openNodeSqliteDatabase(path), options);
	try {
		const version = await migrate(db);
		const storage = await SqliteStorage.open(db, { prefix: PI_PREFIX });
		return { db, storage, version };
	} catch (error) {
		await db.close().catch(() => {});
		throw error;
	}
}

export { migrate } from "./migrations.ts";
export { MIGRATIONS, SCHEMA_VERSION } from "./schema.ts";
export { PanaDatabase, SimulatedCrash, type FaultInjector } from "./atomic.ts";
export { pendingWakes, sweepWakes, wakeDeliveries, wakeRequestId, type PendingWake, type WakeSubmitter } from "./outbox.ts";
