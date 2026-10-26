// One SQLite transaction for a pana write and the pi-durable commits it causes (DB-01, DB-04).
//
// pi-durable 1.4.0 commits each batch with its own `db.transaction()`, and the Node adapter
// queues every other operation until that transaction ends. Sharing the adapter is therefore
// not enough: a pana transaction that called `conversation.submit()` inside it would wait on
// itself forever, and pi-durable exposes no way to add host SQL to its own commit.
//
// `PanaDatabase` wraps the adapter instead. `atomically(fn)` opens one outer transaction. While
// it is open, every operation on the wrapper, pi-durable's included, runs on that transaction,
// and each nested `transaction()` becomes a SAVEPOINT. A message insert, its deliveries, and the
// `submit()` that wakes a session then reach disk in one COMMIT, and a crash before that COMMIT
// leaves none of them.
//
// Rejected alternative: an outbox swept after the pana commit, deduplicated by pi-durable
// `requestId`. It converges after a crash but is never atomic. The outbox columns stay on
// `deliveries` as the fallback for the one case below that cannot roll back.
//
// Constraints this design accepts:
// - pi-durable adopts a commit in memory once `storage.commit()` resolves, which here is when
//   its SAVEPOINT is released, before the outer COMMIT. A crash before COMMIT loses memory and
//   disk together, so nothing diverges. A live rollback after a pi-durable commit has joined
//   would leave memory ahead of disk, so `atomically` never rolls back after that point: it
//   commits what it has and rethrows. Callers record each submission in the same transaction,
//   so deliveries not yet woken stay in the outbox (`wake_request_id` without
//   `wake_submission_id`) for `sweepWakes` to retry by `requestId`.
// - If the outer COMMIT itself fails after a join, memory is ahead of disk. `onFatal` runs, and
//   panad must close the Harness and exit so the next start recovers from disk.
// - Background pi-durable commits that land while the transaction is open join it too. They
//   become durable at the outer COMMIT, milliseconds later. This matches the window WAL with
//   `synchronous = NORMAL` already accepts.
// - Pana's other writes must not run concurrently with `atomically`: they would join it as well.
//   `atomically` serializes pana callers through its own queue. Run every pana write through
//   `atomically` or `write`.

import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "@earendil-works/chord/sqlite";

/** Thrown by a fault injector to simulate the process dying at a statement. */
export class SimulatedCrash extends Error {
	constructor(at: number, sql: string) {
		super(`simulated crash before statement ${at}: ${sql.slice(0, 60)}`);
		this.name = "SimulatedCrash";
	}
}

/**
 * Called before every statement inside `atomically`, numbered from 0 within that transaction.
 * The final call has `sql === "COMMIT"`. Throw `SimulatedCrash` to model a crash at that point.
 */
export type FaultInjector = (sql: string, index: number) => void;

export interface PanaDatabaseOptions {
	/** Called when memory may be ahead of disk. panad closes the Harness and exits. */
	onFatal?: (error: unknown) => void;
}

interface Group {
	tx: SqliteExecutor;
	index: number;
	savepoints: number;
	/** pi-durable commits (released savepoints) that have joined this transaction. */
	joined: number;
	/** Savepoints opened and not yet released or rolled back. */
	open: number;
	/** Called when `open` drops to zero. */
	drained: Array<() => void>;
}

export class PanaDatabase implements SqliteDatabase {
	readonly #inner: SqliteDatabase;
	readonly #onFatal: (error: unknown) => void;
	#group: Group | undefined;
	#queue: Promise<unknown> = Promise.resolve();
	#dead: SimulatedCrash | undefined;
	/** Callbacks waiting for the transaction in flight to commit (see `afterCommit`). */
	#afterCommit: Array<() => void> | undefined;
	/** Test hook: inject faults inside `atomically`. */
	faults: FaultInjector | undefined;

	constructor(inner: SqliteDatabase, options: PanaDatabaseOptions = {}) {
		this.#inner = inner;
		this.#onFatal = options.onFatal ?? (() => {});
	}

	/** True once a `SimulatedCrash` fired. Every later operation rejects, as in a dead process. */
	get crashed(): boolean {
		return this.#dead !== undefined;
	}

	#check(sql: string): Group | undefined {
		if (this.#dead) throw this.#dead;
		const group = this.#group;
		if (group && this.faults) {
			try {
				this.faults(sql, group.index);
			} catch (error) {
				if (error instanceof SimulatedCrash) this.#dead = error;
				throw error;
			}
		}
		if (group) group.index++;
		return group;
	}

	async exec(sql: string): Promise<void> {
		const group = this.#check(sql);
		return group ? group.tx.exec(sql) : this.#inner.exec(sql);
	}

	async run(sql: string, ...params: SqliteValue[]): Promise<void> {
		const group = this.#check(sql);
		return group ? group.tx.run(sql, ...params) : this.#inner.run(sql, ...params);
	}

	async get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
		const group = this.#check(sql);
		return group ? group.tx.get<T>(sql, ...params) : this.#inner.get<T>(sql, ...params);
	}

	async all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
		const group = this.#check(sql);
		return group ? group.tx.all<T>(sql, ...params) : this.#inner.all<T>(sql, ...params);
	}

	/**
	 * A transaction. Inside `atomically` it is a SAVEPOINT of the open transaction, which is how
	 * pi-durable's commits join pana's. Outside, it is an ordinary adapter transaction.
	 */
	async transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
		if (this.#dead) throw this.#dead;
		const group = this.#group;
		if (!group) {
			return this.#inner.transaction((tx) => callback(this.#guarded(tx)));
		}
		const name = `pana_sp_${group.savepoints++}`;
		// A background pi-durable commit can join while `fn` is finishing. The group stays open until
		// every savepoint is released; otherwise its later statements would run outside the
		// transaction, after COMMIT, and fail with "no such savepoint".
		group.open++;
		try {
			await this.exec(`SAVEPOINT ${name}`);
			let result: T;
			try {
				result = await callback(this);
			} catch (error) {
				if (!this.#dead) {
					await group.tx.exec(`ROLLBACK TO ${name}`);
					await group.tx.exec(`RELEASE ${name}`);
				}
				throw error;
			}
			await this.exec(`RELEASE ${name}`);
			group.joined++;
			return result;
		} finally {
			group.open--;
			if (group.open === 0) for (const resolve of group.drained.splice(0)) resolve();
		}
	}

	/** Wrap an ordinary transaction handle so a crash injected elsewhere stops it too. */
	#guarded(tx: SqliteExecutor): SqliteExecutor {
		const check = () => {
			if (this.#dead) throw this.#dead;
		};
		return {
			exec: async (sql) => (check(), tx.exec(sql)),
			run: async (sql, ...params) => (check(), tx.run(sql, ...params)),
			get: async (sql, ...params) => (check(), tx.get(sql, ...params)),
			all: async (sql, ...params) => (check(), tx.all(sql, ...params)),
		};
	}

	/**
	 * Run `fn` in one SQLite transaction. pi-durable commits made while it runs, such as
	 * `conversation.submit()`, commit with it. Pana callers are serialized.
	 *
	 * If `fn` throws before any pi-durable commit joined, everything rolls back. After one joined,
	 * the transaction commits what it has and the error is rethrown (see the file comment).
	 */
	atomically<T>(fn: (tx: SqliteExecutor) => Promise<T>): Promise<T> {
		const run = this.#queue.then(() => this.#atomically(fn));
		this.#queue = run.catch(() => {});
		return run;
	}

	/** A single pana write outside any wake. Serialized with `atomically` so it never joins one. */
	write<T>(fn: (tx: SqliteExecutor) => Promise<T>): Promise<T> {
		return this.atomically(fn);
	}

	/**
	 * Run `callback` once the transaction in flight commits, or at once when none is open. A
	 * callback is dropped when that transaction rolls back, so a subscriber never hears about a
	 * change a rollback took away (UX-09 publishes `session.state` this way). Callbacks run in the
	 * order they were registered, after COMMIT and before `atomically` resolves.
	 */
	afterCommit(callback: () => void): void {
		if (!this.#afterCommit) {
			runAfterCommit([callback]);
			return;
		}
		this.#afterCommit.push(callback);
	}

	async #atomically<T>(fn: (tx: SqliteExecutor) => Promise<T>): Promise<T> {
		if (this.#dead) throw this.#dead;
		const after: Array<() => void> = [];
		this.#afterCommit = after;
		let committed = false;
		let deferred: { error: unknown } | undefined;
		// Set once the callback returned and the adapter is about to COMMIT with joined pi-durable work.
		let mustCommit = false;
		let result: T;
		try {
			result = await this.#inner.transaction(async (tx) => {
				const group: Group = { tx, index: 0, savepoints: 0, joined: 0, open: 0, drained: [] };
				this.#group = group;
				try {
					let value: T | undefined;
					let failure: { error: unknown } | undefined;
					try {
						value = await fn(this);
					} catch (error) {
						failure = { error };
					}
					if (!this.#dead) {
						while (group.open > 0) await new Promise<void>((resolve) => group.drained.push(resolve));
					}
					if (failure) {
						const { error } = failure;
						if (error instanceof SimulatedCrash || this.#dead || group.joined === 0) throw error;
						deferred = failure;
					}
					this.#check("COMMIT");
					mustCommit = group.joined > 0;
					return value as T;
				} finally {
					this.#group = undefined;
				}
			});
			committed = true;
		} catch (error) {
			if (mustCommit) this.#onFatal(error);
			throw error;
		} finally {
			this.#afterCommit = undefined;
			if (committed) runAfterCommit(after);
		}
		if (deferred) throw deferred.error;
		return result;
	}

	async close(): Promise<void> {
		await this.#queue.catch(() => {});
		await this.#inner.close();
	}
}

/**
 * Run post-commit callbacks in order. One that throws must not break the commit that already
 * happened or the callbacks after it, so each failure is reported and dropped.
 */
function runAfterCommit(callbacks: ReadonlyArray<() => void>): void {
	for (const callback of callbacks) {
		try {
			callback();
		} catch (error) {
			console.error("panad: post-commit callback failed:", error instanceof Error ? error.message : error);
		}
	}
}
