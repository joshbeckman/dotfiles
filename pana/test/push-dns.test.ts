// Generate a disposable TLS certificate for the loopback-only server with OpenSSL.
import { createECDH, randomBytes } from "node:crypto";
import webpush from "web-push";
import { Resolver } from "node:dns/promises";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Agent } from "node:https";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isPublicAddress, publicPushAgent, sendPinnedRequest } from "../src/push/index.ts";

afterEach(() => vi.restoreAllMocks());
const signal = () => new AbortController().signal;
function fakeResolver(v4: string[], v6: string[]) {
	return { resolve4: vi.fn(async () => v4), resolve6: vi.fn(async () => v6), cancel: vi.fn() } as unknown as Resolver;
}
function agentLookup(agent: Agent, hostname: string, options: { family: number; all: boolean }): Promise<unknown> {
	return new Promise((resolve, reject) => {
		agent.options.lookup!(hostname, options, ((error: Error | null, address: unknown, family: number) => {
			if (error) reject(error);
			else resolve(options.all ? address : { address, family });
		}) as never);
	});
}

describe("push DNS pinning", () => {
	it("uses only validated answers even if DNS would rebind on the next lookup", async () => {
		const resolver = fakeResolver(["1.1.1.1"], ["2606:4700:4700::1111"]);
		const agent = await publicPushAgent("https://push.example/path", signal(), resolver);
		vi.mocked(resolver.resolve4).mockResolvedValue(["127.0.0.1"] as never);
		expect(await agentLookup(agent, "push.example", { family: 0, all: true })).toEqual([
			{ address: "1.1.1.1", family: 4 }, { address: "2606:4700:4700::1111", family: 6 },
		]);
		expect(await agentLookup(agent, "push.example", { family: 4, all: false })).toEqual({ address: "1.1.1.1", family: 4 });
		expect(await agentLookup(agent, "push.example", { family: 6, all: false })).toEqual({ address: "2606:4700:4700::1111", family: 6 });
		await expect(agentLookup(agent, "other.example", { family: 0, all: false })).rejects.toThrow("no validated address");
		expect(resolver.resolve4).toHaveBeenCalledTimes(1);
		expect(resolver.resolve6).toHaveBeenCalledTimes(1);
		agent.destroy();
	});

	it("fails closed for empty, failed, or mixed public/private DNS answers", async () => {
		await expect(publicPushAgent("https://push.example/", signal(), fakeResolver([], []))).rejects.toThrow("does not resolve");
		await expect(publicPushAgent("https://push.example/", signal(), fakeResolver(["1.1.1.1", "169.254.169.254"], []))).rejects.toThrow("non-public address");
		const resolver = fakeResolver(["1.1.1.1"], []);
		vi.mocked(resolver.resolve6).mockRejectedValue(new Error("DNS failed") as never);
		await expect(publicPushAgent("https://push.example/", signal(), resolver)).rejects.toThrow("DNS failed");
		for (const address of ["::ffff:a9fe:a9fe", "0:0:0:0:0:0:0:1", "::a9fe:a9fe"]) {
			expect(isPublicAddress(address), address).toBe(false);
		}
	});

	it("cancels an in-flight DNS lookup and starts none for an already aborted signal", async () => {
		const controller = new AbortController();
		let rejectDNS!: (error: Error) => void;
		const resolver = fakeResolver([], []);
		vi.mocked(resolver.resolve4).mockImplementation(() => new Promise((_resolve, reject) => { rejectDNS = reject; }) as never);
		vi.mocked(resolver.cancel).mockImplementation(() => rejectDNS(new Error("cancelled")));
		const pending = publicPushAgent("https://push.example/", controller.signal, resolver);
		controller.abort();
		await expect(pending).rejects.toThrow("cancelled");
		expect(resolver.cancel).toHaveBeenCalledTimes(1);
		const unused = fakeResolver([], []);
		await expect(publicPushAgent("https://push.example/", controller.signal, unused)).rejects.toThrow("aborted");
		expect(unused.resolve4).not.toHaveBeenCalled();
	});

	it("keeps SNI, Host and certificate verification, and aborts a hanging request", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pana-push-tls-"));
		const config = join(dir, "openssl.cnf");
		writeFileSync(config, "[req]\ndistinguished_name = dn\n[dn]\n[v3_req]\nsubjectAltName = DNS:push.example\n");
		execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "key.pem"),
			"-out", join(dir, "cert.pem"), "-days", "1", "-subj", "/CN=push.example", "-config", config, "-extensions", "v3_req"], { stdio: "ignore" });
		const cert = readFileSync(join(dir, "cert.pem"));
		const key = readFileSync(join(dir, "key.pem"));
		let host = "";
		let sni = "";
		let authorization = "";
		let onHang!: () => void;
		const hanging = new Promise<void>((resolve) => { onHang = resolve; });
		const server = createServer({ key, cert }, (req, res) => {
			host = req.headers.host ?? "";
			sni = (req.socket as import("node:tls").TLSSocket).servername || "";
			authorization = req.headers.authorization ?? "";
			if (req.url === "/hang") onHang();
			else { res.statusCode = req.url === "/gone" ? 410 : 200; res.end("ok"); }
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const port = (server.address() as { port: number }).port;
		const get = async (hostname: string, path = "/", abortSignal = signal(), push = false) => {
			const endpoint = `https://${hostname}:${port}${path}`;
			const agent = await publicPushAgent(endpoint, abortSignal, fakeResolver(["1.1.1.1"], []));
			// Route only the test socket to loopback; the first test checks the actual pinned lookup.
			agent.options.ca = cert;
			agent.options.lookup = ((_host: string, options: { all?: boolean }, cb: (...args: unknown[]) => void) => {
				if (options.all) cb(null, [{ address: "127.0.0.1", family: 4 }]);
				else cb(null, "127.0.0.1", 4);
			}) as typeof agent.options.lookup;
			const ecdh = createECDH("prime256v1");
			ecdh.generateKeys();
			const keys = webpush.generateVAPIDKeys();
			const details = push ? webpush.generateRequestDetails({
				endpoint, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") },
			}, "private message", { vapidDetails: { subject: "mailto:pana@example.com", ...keys } }) : { method: "POST", headers: {} };
			try { await sendPinnedRequest(endpoint, details, agent, abortSignal); }
			finally { agent.destroy(); }
		};
		try {
			await get("push.example", "/", signal(), true);
			expect(authorization).toMatch(/^vapid /i);
			expect(host).toBe(`push.example:${port}`);
			expect(sni).toBe("push.example");
			await expect(get("wrong.example")).rejects.toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
			await expect(get("push.example", "/gone")).rejects.toMatchObject({ statusCode: 410 });
			const controller = new AbortController();
			const pending = get("push.example", "/hang", controller.signal);
			await hanging;
			controller.abort();
			await expect(pending).rejects.toThrow("push send aborted");
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
