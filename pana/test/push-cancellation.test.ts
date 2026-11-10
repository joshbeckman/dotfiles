// Exercise the timeout through the real push transport, with DNS and HTTPS held in flight.
import { createECDH, randomBytes } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PUSH_TIMEOUT_MS, sendToSubscription } from "../src/push/index.ts";
import { startTestPanad, type TestPanad } from "./harness/index.ts";

const https = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("node:https", async (original) => ({ ...(await original<typeof import("node:https")>()), request: https.request }));

let t: TestPanad | undefined;
afterEach(async () => {
	vi.restoreAllMocks();
	https.request.mockReset();
	await t?.close();
	t = undefined;
});

function subscription() {
	const ecdh = createECDH("prime256v1");
	ecdh.generateKeys();
	return {
		id: "one", endpoint: "https://push.example/test",
		p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url"),
	};
}

describe("production push timeout", () => {
	it("cancels an in-flight DNS resolver", async () => {
		t = await startTestPanad();
		let rejectDNS!: (error: Error) => void;
		const v4 = vi.spyOn(Resolver.prototype, "resolve4").mockImplementation(() => new Promise((_resolve, reject) => { rejectDNS = reject; }) as never);
		vi.spyOn(Resolver.prototype, "resolve6").mockResolvedValue([] as never);
		const cancel = vi.spyOn(Object.getPrototypeOf(Resolver.prototype), "cancel").mockImplementation(() => rejectDNS(new Error("cancelled")));
		const sending = sendToSubscription(t.runtime, subscription(), { title: "test" });
		await vi.waitFor(() => expect(v4).toHaveBeenCalledOnce());
		await t.clock.advance(PUSH_TIMEOUT_MS);
		expect(await sending).toBe("failed");
		expect(cancel).toHaveBeenCalledOnce();
		expect(https.request).not.toHaveBeenCalled();
	});

	it("destroys an in-flight HTTPS request on the runtime deadline", async () => {
		t = await startTestPanad();
		vi.spyOn(Resolver.prototype, "resolve4").mockResolvedValue(["1.1.1.1"] as never);
		vi.spyOn(Resolver.prototype, "resolve6").mockResolvedValue([] as never);
		const request = Object.assign(new EventEmitter(), {
			end: vi.fn(),
			destroy: vi.fn((error: Error) => { request.emit("error", error); request.emit("close"); }),
		});
		https.request.mockReturnValue(request);
		const sending = sendToSubscription(t.runtime, subscription(), { title: "test" });
		await vi.waitFor(() => expect(request.end).toHaveBeenCalledOnce());
		await t.clock.advance(PUSH_TIMEOUT_MS);
		expect(await sending).toBe("failed");
		expect(request.destroy).toHaveBeenCalledOnce();
	});
});
