// A push endpoint is a URL panad fetches later with the user's message content, so what may be
// stored and what may be fetched are both checked (issue #211). The pure rules are tested
// directly, and the server tests drive them through the real handlers and the fake clock.

import { afterEach, describe, expect, it } from "vitest";
import {
	MAX_SUBSCRIPTIONS,
	PUSH_TIMEOUT_MS,
	endpointProblem,
	isPublicAddress,
	setPushTransport,
} from "../src/push/index.ts";
import { publish } from "../src/web/events.ts";
import { startTestPanad, type TestPanad } from "./harness/index.ts";

let t: TestPanad | undefined;
afterEach(async () => {
	setPushTransport(t?.runtime as never, undefined);
	await t?.close();
	t = undefined;
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, what: string): Promise<void> {
	for (let i = 0; i < 400; i++) {
		await t!.clock.settle();
		const value = check();
		if (value) return;
		await sleep(5);
	}
	throw new Error(`timed out waiting for ${what}`);
}

async function subscribe(endpoint: string, keys = { p256dh: "p", auth: "a" }) {
	return t!.tcp.post<{ subscription: { id: string; endpoint: string } }>("/push/subscriptions", { endpoint, keys });
}

describe("#211 a stored endpoint must be a public https push service", () => {
	it("#211 refuses a metadata address, plain http, and names that only resolve inside a network", () => {
		for (const endpoint of [
			"http://169.254.169.254/latest/meta-data/",
			"https://169.254.169.254/latest/meta-data/",
			"https://2852039166/latest/meta-data/", // the same address as one decimal number
			"https://[::1]/wp",
			"https://localhost/wp",
			"https://pana.localhost/wp",
			"https://printer.local/wp",
			"https://metadata.google.internal/computeMetadata/v1/",
			"https://beacon.ts.net/wp",
			"https://intranet/wp",
			"https://push.example:8443/wp",
			"https://user:pass@push.example/wp",
			"not a url",
		]) {
			expect(endpointProblem(endpoint), endpoint).toBeDefined();
		}
	});

	it("#211 accepts the shapes a browser's push service actually hands out", () => {
		for (const endpoint of [
			"https://fcm.googleapis.com/fcm/send/abc:def",
			"https://updates.push.services.mozilla.com/wpush/v2/gAAAA",
			"https://web.push.apple.com/QGVsdGl4",
			"https://wns2-par02p.notify.windows.com/w/?token=x",
		]) {
			expect(endpointProblem(endpoint), endpoint).toBeUndefined();
		}
	});

	it("#211 treats loopback, link-local, private, and mapped addresses as non-public", () => {
		for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fe80::1", "fd00::1", "::ffff:169.254.169.254"]) {
			expect(isPublicAddress(address), address).toBe(false);
		}
		for (const address of ["1.1.1.1", "142.250.72.14", "2606:4700:4700::1111"]) {
			expect(isPublicAddress(address), address).toBe(true);
		}
	});
});

describe("#211 the subscription route applies those rules", () => {
	it("#211 refuses a subscription to a private address, and keeps none of it", async () => {
		t = await startTestPanad();
		for (const endpoint of ["http://169.254.169.254/latest/meta-data/", "https://169.254.169.254/", "http://push.example/wp"]) {
			const refused = await subscribe(endpoint);
			expect(refused.status, endpoint).toBe(400);
			expect(refused.body).toMatchObject({ error: { code: "invalid_subscription" } });
		}
		const listed = await t.tcp.get<{ subscriptions: unknown[] }>("/push/subscriptions");
		expect(listed.body.subscriptions).toHaveLength(0);

		// The public https shape a browser really sends still works.
		expect((await subscribe("https://fcm.googleapis.com/fcm/send/abc")).status).toBe(201);
	});

	it("#211 caps the subscriptions one participant holds", async () => {
		t = await startTestPanad();
		for (let i = 0; i < MAX_SUBSCRIPTIONS; i++) {
			expect((await subscribe(`https://push.example/${i}`)).status).toBe(201);
		}
		const refused = await subscribe("https://push.example/one-too-many");
		expect(refused.status).toBe(409);
		expect(refused.body).toMatchObject({ error: { code: "too_many_subscriptions" } });

		// Re-posting a held endpoint refreshes its keys instead of failing the cap.
		expect((await subscribe("https://push.example/0", { p256dh: "new", auth: "new" })).status).toBe(201);
		const listed = await t.tcp.get<{ subscriptions: unknown[] }>("/push/subscriptions");
		expect(listed.body.subscriptions).toHaveLength(MAX_SUBSCRIPTIONS);
	});
});

describe("#211 the fan-out lasts only as long as its budget", () => {
	it("#211 a hung endpoint does not stall a later notification", async () => {
		t = await startTestPanad();
		const sent: string[] = [];
		let release: (() => void) | undefined;
		setPushTransport(t.runtime, async (subscription: { endpoint: string }) => {
			if (subscription.endpoint.includes("hung")) {
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				return;
			}
			sent.push(subscription.endpoint);
		});
		await subscribe("https://push.example/hung");
		await subscribe("https://push.example/well-behaved");

		const pushed = publish(t.runtime, { kind: "notice", to: t.runtime.userUrl, title: "a" });
		// The healthy endpoint is reached while the hung one still holds the fan-out open.
		await until(() => sent.length === 1, "the healthy endpoint's push");
		await t.clock.advance(PUSH_TIMEOUT_MS);
		const summary = await pushed;
		expect(summary).toEqual({ sent: 1, gone: 0, failed: 1 });
		release?.();
	});

	it("#211 a row stored before these rules existed is never fetched, and is dropped", async () => {
		t = await startTestPanad();
		let fetched = 0;
		setPushTransport(t.runtime, async () => {
			fetched++;
		});
		await subscribe("https://push.example/legacy");
		await t.runtime.db.write((tx) =>
			tx.run(
				`INSERT INTO push_subscriptions (id, participant_id, endpoint, p256dh, auth, created_at)
				 VALUES ('poisoned', ?, 'http://169.254.169.254/latest/meta-data/', 'p', 'a', 0)`,
				t!.runtime.config.user,
			),
		);

		const summary = await publish(t.runtime, { kind: "notice", to: t.runtime.userUrl, title: "a" });
		expect(fetched).toBe(1);
		expect(summary).toEqual({ sent: 1, gone: 1, failed: 0 });
		const rows = await t.runtime.db.all<{ endpoint: string }>("SELECT endpoint FROM push_subscriptions");
		expect(rows.map((row) => row.endpoint)).toEqual(["https://push.example/legacy"]);
	});
});
