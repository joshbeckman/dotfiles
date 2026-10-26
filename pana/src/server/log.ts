// The request log (SRV-01): one JSONL line per request in `<state>/panad.log`, written after
// the response is sent. Only routing metadata goes to the file; a body, a header, or a query
// value could carry content or a credential, so none of them are logged.

import { appendFileSync } from "node:fs";
import type { RequestLogEntry } from "./app.ts";

export interface LoggedRequest {
	ts: string;
	transport: string;
	method: string;
	path: string;
	route: string | null;
	caller: string | null;
	status: number;
	durationMs: number;
}

/** The line written for one request. `path` is the URL path; the query string is dropped. */
export function logLine(entry: RequestLogEntry, ts: number): LoggedRequest {
	return {
		ts: new Date(ts).toISOString(),
		transport: entry.transport,
		method: entry.method,
		path: entry.path,
		route: entry.route ?? null,
		caller: entry.caller ?? null,
		status: entry.status,
		durationMs: Math.round(entry.durationMs * 1000) / 1000,
	};
}

/**
 * Append one JSONL line per request to `path`. A failed write is reported and dropped: a full
 * disk must not fail a request that already answered.
 */
export function createRequestLogger(
	path: string,
	options: { now: () => number; onError?: (error: unknown) => void },
): (entry: RequestLogEntry) => void {
	return (entry) => {
		try {
			appendFileSync(path, `${JSON.stringify(logLine(entry, options.now()))}\n`);
		} catch (error) {
			options.onError?.(error);
		}
	};
}
