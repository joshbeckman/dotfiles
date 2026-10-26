// A minimal HTTP client for panad, over the Unix socket or TCP. The CLI (WP1) and the test
// harness use it. It never throws for a non-2xx status; callers map `status` with
// `statusToExitCode` (API-02).

import { request as httpRequest } from "node:http";

export type Endpoint = { socketPath: string } | { host: string; port: number; token?: string; hostHeader?: string };

export interface RequestOptions {
	body?: unknown;
	/** Raw bytes instead of JSON, e.g. an upload. */
	bytes?: Uint8Array;
	/** Sent as `Pana-Caller` (API-03). */
	caller?: string;
	headers?: Record<string, string>;
}

export interface ApiResponse<T = unknown> {
	status: number;
	headers: Record<string, string | string[] | undefined>;
	/** Parsed JSON, or undefined for an empty or non-JSON body. */
	body: T;
	raw: Buffer;
}

export function request<T = unknown>(endpoint: Endpoint, method: string, path: string, options: RequestOptions = {}): Promise<ApiResponse<T>> {
	const headers: Record<string, string> = { ...options.headers };
	let payload: Uint8Array | undefined;
	if (options.bytes) {
		payload = options.bytes;
		headers["content-type"] ??= "application/octet-stream";
	} else if (options.body !== undefined) {
		payload = Buffer.from(JSON.stringify(options.body));
		headers["content-type"] = "application/json";
	}
	if (payload) headers["content-length"] = String(payload.byteLength);
	if (options.caller) headers["pana-caller"] = options.caller;

	const target =
		"socketPath" in endpoint
			? { socketPath: endpoint.socketPath }
			: { host: endpoint.host, port: endpoint.port };
	if ("token" in endpoint && endpoint.token) headers.authorization = `Bearer ${endpoint.token}`;
	if ("hostHeader" in endpoint && endpoint.hostHeader) headers.host = endpoint.hostHeader;

	return new Promise((resolve, reject) => {
		const req = httpRequest({ ...target, method, path, headers }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("end", () => {
				const raw = Buffer.concat(chunks);
				let body: unknown;
				const type = String(res.headers["content-type"] ?? "");
				if (raw.length > 0 && type.includes("application/json")) {
					try {
						body = JSON.parse(raw.toString("utf8"));
					} catch {
						body = undefined;
					}
				}
				resolve({ status: res.statusCode ?? 0, headers: res.headers, body: body as T, raw });
			});
			res.on("error", reject);
		});
		req.on("error", reject);
		if (payload) req.write(payload);
		req.end();
	});
}
