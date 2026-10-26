// The request pipeline shared by both listeners: resolve the caller, match the route, run the
// handler, and render errors as `{"error": {...}}` (API-01, API-03..05).

import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ApiError } from "../api/errors.ts";
import { matchRoute, pathExists } from "../api/routes.ts";
import type { Caller, Handlers, HandlerResult, RequestContext, Transport } from "../api/types.ts";
import { parseRef, RefError } from "../ids/index.ts";
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
	const url = new URL(req.url ?? "/", "http://panad");
	let status = 500;
	let routeName: string | undefined;
	let caller: Caller | undefined;
	try {
		const rawBody = await readBody(req);
		caller = await resolveCaller(options, transport, req);
		const body = parseJsonBody(req, rawBody);
		const match = matchRoute(method, url.pathname);
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
			rawBody,
			headers: req.headers,
		};
		const result = await handler(ctx);
		status = result.status;
		await send(res, result);
	} catch (error) {
		const apiError = toApiError(error);
		status = apiError.status;
		if (!res.headersSent) {
			await send(res, { status: apiError.status, body: apiError.toBody() });
		} else {
			res.destroy();
		}
	} finally {
		options.onRequest?.({
			transport,
			method,
			path: url.pathname,
			route: routeName,
			caller: caller?.url,
			status,
			durationMs: performance.now() - started,
		});
	}
}

/**
 * Resolve the caller (API-03, API-04, API-05).
 * TCP: the Host must be loopback or a Tailscale name, and the bearer token must match; the
 * caller is always the configured user. Socket: `Pana-Caller` names a known session, or the
 * caller is the configured user.
 */
async function resolveCaller(options: AppOptions, transport: Transport, req: IncomingMessage): Promise<Caller> {
	const { config, userUrl } = options.runtime;
	const user: Caller = { kind: "user", id: config.user, url: userUrl };

	if (transport === "tcp") {
		const host = hostName(req.headers.host);
		const allowed = new Set<string>([...LOOPBACK_HOSTS, ...(options.tailscaleNames ?? []).map((n) => n.toLowerCase())]);
		if (!host || !allowed.has(host)) {
			throw new ApiError(403, "forbidden_host", `Host ${req.headers.host ?? "(none)"} is not allowed`);
		}
		if (!tokenMatches(req.headers.authorization, options.webToken)) {
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

function readBody(req: IncomingMessage): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

function parseJsonBody(req: IncomingMessage, raw: Buffer): unknown {
	if (raw.length === 0) return undefined;
	const type = String(req.headers["content-type"] ?? "");
	if (type && !type.includes("application/json")) return undefined;
	try {
		return JSON.parse(raw.toString("utf8"));
	} catch {
		throw ApiError.badRequest("invalid_json", "request body is not valid JSON");
	}
}

function toApiError(error: unknown): ApiError {
	if (error instanceof ApiError) return error;
	if (error instanceof RefError) return ApiError.badRequest(error.code, error.message);
	const message = error instanceof Error ? error.message : String(error);
	return new ApiError(500, "internal", message);
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
