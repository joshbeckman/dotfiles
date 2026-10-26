// PANA_BENCH_SQL=FILE: time every SQLite call panad makes, by SQL text, and write the totals to
// FILE as JSON when panad exits. A CPU profile shows that SQLite is busy; this shows which
// statement. Bench-only: it patches node:sqlite in the bench's panad child.

import { writeFileSync } from "node:fs";
import { DatabaseSync, StatementSync } from "node:sqlite";

interface Stat {
	calls: number;
	ms: number;
}

export function recordSql(file: string): void {
	const stats = new Map<string, Stat>();
	const sqlOf = new WeakMap<object, string>();
	const commits: number[] = [];
	const add = (sql: string, ms: number) => {
		const key = sql.replace(/\s+/g, " ").trim().slice(0, 160);
		const stat = stats.get(key) ?? { calls: 0, ms: 0 };
		stat.calls++;
		stat.ms += ms;
		stats.set(key, stat);
	};
	const db = DatabaseSync.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
	const exec = db.exec!;
	db.exec = function (this: unknown, sql: unknown) {
		const t0 = performance.now();
		try {
			return exec.call(this, sql);
		} finally {
			const ms = performance.now() - t0;
			if (sql === "COMMIT") commits.push(ms);
			add(String(sql), ms);
		}
	};
	const prepare = db.prepare!;
	db.prepare = function (this: unknown, sql: unknown) {
		const statement = prepare.call(this, sql) as object;
		sqlOf.set(statement, String(sql));
		return statement;
	};
	const statement = StatementSync.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
	for (const name of ["run", "get", "all"]) {
		const original = statement[name]!;
		statement[name] = function (this: object, ...args: unknown[]) {
			const t0 = performance.now();
			try {
				return original.apply(this, args);
			} finally {
				add(sqlOf.get(this) ?? "?", performance.now() - t0);
			}
		};
	}
	process.on("exit", () => {
		const rows = [...stats].map(([sql, s]) => ({ sql, calls: s.calls, ms: Math.round(s.ms), usPerCall: Math.round((s.ms / s.calls) * 1000) }));
		rows.sort((a, b) => b.ms - a.ms);
		commits.sort((a, b) => a - b);
		const at = (q: number) => Math.round((commits[Math.floor(q * (commits.length - 1))] ?? 0) * 1000);
		const commit = { count: commits.length, p50us: at(0.5), p90us: at(0.9), p99us: at(0.99), p999us: at(0.999), maxUs: at(1) };
		writeFileSync(file, JSON.stringify({ commit, statements: rows }, null, 1));
	});
}
