// List pagination (SCALE-03). Every list route takes `limit` and `cursor` and answers with
// `nextCursor`, null on the last page.
//
// A cursor is opaque to clients: base64url JSON of the sort key of the last item returned. The
// next page starts strictly after that key, so rows added while a client pages through a list
// never shift or repeat the rows it has not read yet. Search results, ordered by FTS rank, have
// no stable key; their cursor is an offset.

import { ApiError } from "./errors.ts";

export const MAX_LIMIT = 500;

export type CursorKey = Array<string | number | null>;

export interface Page<T> {
	items: T[];
	nextCursor: string | null;
}

/** `limit` from a query string: a positive integer up to `MAX_LIMIT`, or `fallback` when absent. */
export function parseLimit(value: string | null | undefined, fallback: number): number {
	if (value === null || value === undefined || value === "") return fallback;
	const limit = Number(value);
	if (!Number.isInteger(limit) || limit < 1) throw ApiError.badRequest("invalid_limit", "limit must be a positive integer");
	return Math.min(limit, MAX_LIMIT);
}

export function encodeCursor(key: CursorKey): string {
	return Buffer.from(JSON.stringify(key)).toString("base64url");
}

/** The sort key in a cursor, checked against the number and types of the route's key fields. */
export function decodeCursor(value: string | null | undefined, shape: ReadonlyArray<"string" | "number" | "nullable-number">): CursorKey | undefined {
	if (value === null || value === undefined || value === "") return undefined;
	let key: unknown;
	try {
		key = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
	} catch {
		key = undefined;
	}
	const fits =
		Array.isArray(key) &&
		key.length === shape.length &&
		shape.every((type, i) => {
			const field = key[i];
			if (type === "string") return typeof field === "string";
			if (type === "number") return typeof field === "number" && Number.isFinite(field);
			return field === null || (typeof field === "number" && Number.isFinite(field));
		});
	if (!fits) throw ApiError.badRequest("invalid_cursor", "cursor is not one this list returned");
	return key as CursorKey;
}

/**
 * Turn `limit + 1` fetched rows into one page: the extra row only says there is more, and the
 * cursor is the key of the last row kept.
 */
export function pageOf<T>(rows: T[], limit: number, keyOf: (row: T) => CursorKey): Page<T> {
	if (rows.length <= limit) return { items: rows, nextCursor: null };
	const items = rows.slice(0, limit);
	return { items, nextCursor: encodeCursor(keyOf(items[items.length - 1]!)) };
}

/** An offset cursor, for lists ordered by search rank. */
export function decodeOffset(value: string | null | undefined): number {
	const key = decodeCursor(value, ["number"]);
	const offset = key?.[0] as number | undefined;
	if (offset === undefined) return 0;
	if (!Number.isInteger(offset) || offset < 0) throw ApiError.badRequest("invalid_cursor", "cursor is not one this list returned");
	return offset;
}
