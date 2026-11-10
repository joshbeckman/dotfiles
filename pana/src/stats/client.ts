// The PWA's samples, written down (OBS-03). The browser measures its own API calls, view renders,
// and long tasks, batches them, and posts the batch to `POST /stats/client`; panad appends one
// JSONL line per sample to `<state>/client.log`.
//
// This is not content and not a credential: a sample is a kind, a name (a route or a section),
// a duration, and an optional status. Anything else in the body is rejected rather than stored,
// so no message text and no token can reach the file.

import { isSafeClientName } from "../../web/perf.js";
import { ApiError } from "../api/errors.ts";
import { RotatingLog } from "../logs/index.ts";
import { CLIENT_KINDS, type ClientKind } from "./summary.ts";

/** Samples one request may carry. A batch is a flush, not a history. */
export const CLIENT_BATCH_MAX = 200;
/** Longest sample name kept: a route or a section, not a URL with ids in it. */
export const CLIENT_NAME_MAX = 120;
/** Longest sample kept. A client that claims an hour is a bug, not a measurement. */
export const CLIENT_DURATION_MAX_MS = 600_000;

export interface ClientSample {
	kind: ClientKind;
	name: string;
	durationMs: number;
	status?: number;
}

/** A validated batch, or a 400 that names the first sample that is not one. */
export function clientSamples(body: unknown): ClientSample[] {
	const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
	const samples = record.samples;
	if (!Array.isArray(samples)) throw ApiError.badRequest("invalid_samples", "samples must be an array of client samples");
	if (samples.length > CLIENT_BATCH_MAX) {
		throw ApiError.badRequest("too_many_samples", `at most ${CLIENT_BATCH_MAX} samples a batch, got ${samples.length}`);
	}
	return samples.map((value, index) => clientSample(value, index));
}

function clientSample(value: unknown, index: number): ClientSample {
	const where = `sample ${index + 1}`;
	if (typeof value !== "object" || value === null) throw ApiError.badRequest("invalid_sample", `${where} is not an object`);
	const record = value as Record<string, unknown>;
	const kind = record.kind;
	if (typeof kind !== "string" || !(CLIENT_KINDS as readonly string[]).includes(kind)) {
		throw ApiError.badRequest("invalid_sample", `${where} has no kind; expected one of ${CLIENT_KINDS.join(", ")}`);
	}
	const name = record.name;
	if (typeof name !== "string" || !isSafeClientName(kind, name)) {
		throw ApiError.badRequest("invalid_sample", `${where} needs a known name for its kind`);
	}
	const durationMs = record.durationMs;
	if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0 || durationMs > CLIENT_DURATION_MAX_MS) {
		throw ApiError.badRequest("invalid_sample", `${where} needs a durationMs from 0 to ${CLIENT_DURATION_MAX_MS}`);
	}
	const status = record.status;
	if (status !== undefined && (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599)) {
		throw ApiError.badRequest("invalid_sample", `${where} has a status that is not an HTTP status`);
	}
	return {
		kind: kind as ClientKind,
		name,
		durationMs: Math.round(durationMs * 1000) / 1000,
		...(status === undefined ? {} : { status }),
	};
}

/** The line written for one sample. `ts` is panad's clock, not the browser's. */
export function clientLine(sample: ClientSample, now: number): string {
	return `${JSON.stringify({ ts: new Date(now).toISOString(), kind: sample.kind, name: sample.name, durationMs: sample.durationMs, ...(sample.status === undefined ? {} : { status: sample.status }) })}\n`;
}

export interface ClientLogOptions {
	/** Rotate when the file would pass this size. `0` keeps one growing file (OBS-06). */
	maxBytes?: number;
	/** Previous files to keep. */
	keep?: number;
	onError?: (error: unknown) => void;
}

/**
 * Append the batch. Returns how many lines were written; a write failure is reported, not
 * thrown, because a page must not fail because a measurement could not be written.
 */
export async function appendClientSamples(
	path: string,
	samples: readonly ClientSample[],
	now: number,
	options: ClientLogOptions = {},
): Promise<number> {
	if (samples.length === 0) return 0;
	const log = new RotatingLog({
		path,
		maxBytes: options.maxBytes ?? 0,
		keep: options.keep ?? 1,
		...(options.onError ? { onError: options.onError } : {}),
	});
	for (const sample of samples) log.append(clientLine(sample, now));
	return samples.length;
}
