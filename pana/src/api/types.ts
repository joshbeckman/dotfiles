// Shared API types: the caller identity and the handler contract.

import type { ServerResponse } from "node:http";
import type { Runtime } from "../server/runtime.ts";
import type { RouteName } from "./routes.ts";

export type Transport = "socket" | "tcp";

/** The resolved caller of a request (API-03, API-04). */
export interface Caller {
	kind: "user" | "session";
	/** A username or a session ULID. */
	id: string;
	/** The caller's `pana://` URL, used for attribution. */
	url: string;
}

export interface RequestContext {
	runtime: Runtime;
	transport: Transport;
	caller: Caller;
	params: Record<string, string>;
	query: URLSearchParams;
	/** Parsed JSON body; undefined for an empty or non-JSON body. */
	body: unknown;
	/** The raw request bytes, for uploads. */
	rawBody: Buffer;
	headers: Record<string, string | string[] | undefined>;
}

/**
 * What a handler returns. Exactly one of `body` (JSON), `bytes`, or `stream` is used;
 * none means an empty body. Throw an `ApiError` for a failure.
 */
export interface HandlerResult {
	status: number;
	body?: unknown;
	bytes?: Uint8Array;
	headers?: Record<string, string>;
	/** Takes over the response, for server-sent events. Called after status and headers are written. */
	stream?: (res: ServerResponse) => void | Promise<void>;
}

export type Handler = (ctx: RequestContext) => Promise<HandlerResult> | HandlerResult;

export type Handlers = Partial<Record<RouteName, Handler>>;
