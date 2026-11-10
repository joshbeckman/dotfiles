// The request pipeline shared by both listeners: resolve the caller, match the route, run the
// handler, and render errors as `{"error": {...}}` (API-01, API-03..05).

import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ApiError } from "../api/errors.ts";
import { matchRoute, pathExists } from "../api/routes.ts";
import type { Caller, Handlers, HandlerResult, RequestContext, Transport } from "../api/types.ts";
import { parseRef, RefError } from "../ids/index.ts";
import { isStaticAssetPath } from "../web/static.ts";
import type { Runtime } from "./runtime.ts";

/** Hosts TCP accepts besides the Tailscale names (API-05). */
export const LOOPBACK_HOSTS = ["127.0.0.1", "localhost"] as const;

export interface AppOptions {
	runtime: Runtime;
	handlers: Handlers;
	webToken: string;
	/** The machine's Tailscale names, e.g. `lantern.tailnet.ts.net`. */
	tailscaleNames?: readonly string[];
	/** Called once per request after the response is sent. WP1 logs it (SRV-01). */
	onRequest?: (entry: RequestLogEntry) => void;
	/**
	 * What a failed request really threw, for the local log. A 500 body carries none of it: a
	 * message can name a path, a query, or a subprocess's diagnostics (API-01).
	 */
	onError?: (error: unknown, what: string) => void;
}

export interface RequestLogEntry {
	transport: Transport;
	method: string;
	path: string;
	route?: string;
	caller?: string;
	status: number;
	durationMs: number;
}

export type RequestListener = (req: IncomingMessage, res: ServerResponse) => void;

export function createApp(options: AppOptions, transport: Transport): RequestListener {
	return (req, res) => {
		void handle(options, transport, req, res);
	};
}

async function handle(options: AppOptions, transport: Transport, req: IncomingMessage, res: ServerResponse): Promise<void> {
	const started = performance.now();
	const method = req.method ?? "GET";
	const target = req.url ?? "/";
	let url: URL | undefined;
	let status = 500;
	let routeName: string | undefined;
	let caller: Caller | undefined;
	try {
		// A request target that is not a URL, such as `//` from a browser's speculative probe, must
		// not take the daemon down: every other request on both transports would die with it.
		url = parseTarget(target);
		// The app shell loads in a browser, which cannot attach the bearer token to a page load,
		// so the shell assets are the one public part of the TCP surface. Everything else,
		// including unknown paths, keeps API-04's token check.
		const publicShell = transport === "tcp" && method === "GET" && isStaticAssetPath(url.pathname);
		caller = await resolveCaller(options, transport, req, publicShell);
		// The body is read only once the caller is resolved, and never past the route's limit
		// (API-06): a refused request buffers none of it. The route is matched here so the limit
		// is known before a byte is read; the not-found error still comes after the JSON body,
		// as it did when every body was read first.
		const match = matchRoute(method, url.pathname);
		const rawBody = await readBody(req, options.runtime.config.files.maxBytes, match?.route.name);
		const body = parseJsonBody(req, rawBody);
		if (!match) {
			throw pathExists(url.pathname)
				? new ApiError(404, "not_found", `${method} is not allowed on ${url.pathname}`)
				: ApiError.notFound(`no route for ${method} ${url.pathname}`);
		}
		routeName = match.route.name;
		const handler = options.handlers[match.route.name];
		if (!handler) {
			throw ApiError.notImplemented(`${match.route.name} is not implemented yet`, {
				route: match.route.name,
				wp: match.route.wp,
			});
		}
		const ctx: RequestContext = {
			runtime: options.runtime,
			transport,
			caller,
			params: match.params,
			query: url.searchParams,
			body,
			report: options.onError,
			rawBody,
			headers: req.headers,
		};
		const result = await handler(ctx);
		status = result.status;
		await send(res, result);
	} catch (error) {
		const apiError = toApiError(error);
		status = apiError.status;
		// The detail stays here, in panad's own log, and the caller gets the generic body.
		if (apiError.status === 500) options.onError?.(error, `${method} ${url?.pathname ?? target}`);
		if (!res.headersSent) {
			await send(res, { status: apiError.status, body: apiError.toBody() });
		} else {
			res.destroy();
		}
	} finally {
		options.onRequest?.({
			transport,
			method,
			path: url?.pathname ?? target,
			route: routeName,
			caller: caller?.url,
			status,
			durationMs: performance.now() - started,
		});
	}
}

/** The request target as a URL: an origin-form path against a fixed base. */
function parseTarget(target: string): URL {
	try {
		return new URL(target, "http://panad");
	} catch {
		throw ApiError.badRequest("invalid_path", `the request target is not a URL: ${JSON.stringify(target)}`);
	}
}

/**
 * Resolve the caller (API-03, API-04, API-05).
 * TCP: the Host must be loopback or a Tailscale name, and the bearer token must match; the
 * caller is always the configured user. Socket: `Pana-Caller` names a known session, or the
 * caller is the configured user.
 */
async function resolveCaller(options: AppOptions, transport: Transport, req: IncomingMessage, publicShell = false): Promise<Caller> {
	const { config, userUrl } = options.runtime;
	const user: Caller = { kind: "user", id: config.user, url: userUrl };

	if (transport === "tcp") {
		const host = hostName(req.headers.host);
		const allowed = new Set<string>([...LOOPBACK_HOSTS, ...(options.tailscaleNames ?? []).map((n) => n.toLowerCase())]);
		if (!host || !allowed.has(host)) {
			throw new ApiError(403, "forbidden_host", `Host ${req.headers.host ?? "(none)"} is not allowed`);
		}
		if (!publicShell && !tokenMatches(req.headers.authorization, options.webToken)) {
			throw ApiError.unauthorized("missing or wrong bearer token");
		}
		return user;
	}

	const header = req.headers["pana-caller"];
	const value = Array.isArray(header) ? header[0] : header;
	if (value === undefined || value === "") return user;

	let ref;
	try {
		ref = parseRef(value, config.domain);
	} catch (error) {
		if (error instanceof RefError) throw ApiError.badRequest(error.code, `Pana-Caller: ${error.message}`);
		throw error;
	}
	if (ref.kind !== "session") {
		throw ApiError.badRequest("invalid_caller", "Pana-Caller must name a session");
	}
	const row = await options.runtime.db.get<{ id: string }>("SELECT id FROM sessions WHERE id = ?", ref.id);
	if (!row) throw ApiError.badRequest("unknown_caller", `unknown session in Pana-Caller: ${ref.id}`);
	return { kind: "session", id: ref.id, url: options.runtime.url(ref) };
}

/** The Host header without its port, lowercased. Handles `[::1]:8766`. */
export function hostName(header: string | undefined): string | undefined {
	if (!header) return undefined;
	const value = header.trim().toLowerCase();
	if (value.startsWith("[")) {
		const end = value.indexOf("]");
		return end === -1 ? undefined : value.slice(1, end);
	}
	const colon = value.lastIndexOf(":");
	return colon === -1 ? value : value.slice(0, colon);
}

function tokenMatches(header: string | undefined, token: string): boolean {
	if (!header) return false;
	const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
	if (!match) return false;
	const given = Buffer.from(match[1]!);
	const expected = Buffer.from(token);
	return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * API-06: the whole body, or a refusal. The bytes are kept only up to `limit`, so an oversized
 * body costs one read ahead of the refusal rather than all of itself, and the connection drains
 * what is left after the response instead of the daemon holding it.
 */
function readBody(req: IncomingMessage, limit: number, route: string | undefined): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const declared = Number(req.headers["content-length"]);
		if (Number.isFinite(declared) && declared > limit) {
			reject(tooLarge(limit, route));
			return;
		}
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > limit) {
				// Refuse at the byte that crosses the limit, and stop keeping any of the rest.
				reject(tooLarge(limit, route));
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

/** FIL-03 keeps its 400 for an upload's own limit; every other route answers 413 (API-06). */
function tooLarge(maxBytes: number, route: string | undefined): ApiError {
	if (route === "files.upload") {
		return ApiError.badRequest("file_too_large", `file is over the ${maxBytes} byte limit`, { maxBytes });
	}
	return new ApiError(413, "payload_too_large", `request body is over the ${maxBytes} byte limit`, { maxBytes });
}

function parseJsonBody(req: IncomingMessage, raw: Buffer): unknown {
	if (raw.length === 0) return undefined;
	// Only a body the caller labels JSON is parsed as JSON. A missing `content-type` is not a
	// claim of one: the PWA uploads a file as raw bytes through `fetch`, which sends no header,
	// and parsing those bytes as JSON would reject every browser attachment before its route
	// ran (400 `invalid_json`, `route: null` in the log).
	const type = String(req.headers["content-type"] ?? "");
	if (!type.includes("application/json")) return undefined;
	try {
		return JSON.parse(raw.toString("utf8"));
	} catch {
		throw ApiError.badRequest("invalid_json", "request body is not valid JSON");
	}
}

/** The body of every 500: a caller learns that panad failed, not what it was doing. */
const INTERNAL_MESSAGE = "internal error";

function toApiError(error: unknown): ApiError {
	if (error instanceof ApiError) {
		// 502 and 501 name what the caller asked for and stay as they are; a 500 is panad's own
		// failure, and its message is the fastest way to leak the inside of the process.
		return error.status === 500 ? new ApiError(500, error.code, INTERNAL_MESSAGE) : error;
	}
	if (error instanceof RefError) return ApiError.badRequest(error.code, error.message);
	return new ApiError(500, "internal", INTERNAL_MESSAGE);
}

async function send(res: ServerResponse, result: HandlerResult): Promise<void> {
	const headers: Record<string, string> = { ...result.headers };
	if (result.stream) {
		res.writeHead(result.status, headers);
		await result.stream(res);
		return;
	}
	let payload: Uint8Array | undefined;
	if (result.bytes) {
		payload = result.bytes;
		headers["content-type"] ??= "application/octet-stream";
	} else if (result.body !== undefined) {
		payload = Buffer.from(JSON.stringify(result.body));
		headers["content-type"] = "application/json";
	}
	headers["content-length"] = String(payload?.byteLength ?? 0);
	res.writeHead(result.status, headers);
	res.end(payload);
}
