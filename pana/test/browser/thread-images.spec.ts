// FIL-07/WEB-04: a thread whose messages carry pictures paints the prose first, reads one file
// once however many messages show it, and leaves photos far off screen for the reader to reach.
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { loopbackOrigin } from "../../src/web/static.ts";
import { startTestPanad, type TestPanad } from "../harness/index.ts";
import { chromeDevtoolsAvailable, closePage, emulateViewport, evaluatePage, newPage } from "./cli.ts";

const describeBrowser = chromeDevtoolsAvailable() ? describe : describe.skip;
let t: TestPanad | undefined;
let page: number | undefined;
afterEach(async () => {
	if (page !== undefined) { await emulateViewport(""); await closePage(page); }
	page = undefined;
	await t?.close();
	t = undefined;
});

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
	let value = index;
	for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
	return value >>> 0;
});
function crc32(bytes: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(data.length, 0);
	head.write(type, 4, "ascii");
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
	return Buffer.concat([head, data, crc]);
}
/** A real PNG of the given size, with noise so a copy is a picture rather than a flat colour. */
function png(width: number, height: number, salt: number): Buffer {
	const rows = Buffer.alloc(height * (1 + width * 3));
	let seed = 7 + salt;
	for (let y = 0; y < height; y++) {
		const start = y * (1 + width * 3);
		for (let x = 0; x < width; x++) {
			seed = (seed * 1103515245 + 12345) % 2147483648;
			rows[start + 1 + x * 3] = seed % 256;
			rows[start + 2 + x * 3] = (seed >>> 8) % 256;
			rows[start + 3 + x * 3] = (seed >>> 16) % 256;
		}
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(rows, { level: 1 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

async function upload(name: string, bytes: Buffer): Promise<{ id: string; url: string }> {
	const res = await t!.client.request<{ file: { id: string; url: string } }>("POST", `/files?name=${encodeURIComponent(name)}`, {
		bytes,
		headers: { "content-type": "image/png" },
	});
	expect(res.status).toBe(201);
	return res.body.file;
}

const MESSAGES = 12;

describeBrowser("pictures in a thread", () => {
	it("WEB-04 paints every message before any bytes arrive, reads a repeated file once, and defers off-screen photos", async () => {
		t = await startTestPanad();
		const shared = await upload("shared.png", png(320, 240, 1));
		const oldest = await upload("oldest.png", png(320, 240, 2));

		const created = await t.client.post<{ thread: { id: string }; message: { id: string } }>("/threads", {
			to: ["tester"],
			body: `Message 0\n\n![oldest](${oldest.url})\n\n![shared](${shared.url})`,
		});
		expect(created.status).toBe(201);
		const id = created.body.thread.id;
		let after = created.body.message.id;
		for (let index = 1; index < MESSAGES; index++) {
			const posted = await t.client.post<{ message: { id: string } }>(`/threads/${id}/messages`, {
				after,
				body: `Message ${index}\n\n${"A line of prose. ".repeat(6)}\n\n![shared](${shared.url})`,
			});
			expect(posted.status).toBe(200);
			after = posted.body.message.id;
		}

		page = await newPage(`${loopbackOrigin(t.panad.tcpPort!)}/#${t.panad.webToken}`);
		await emulateViewport("390x844x3,mobile,touch", "light");
		await evaluatePage(`await until(() => document.querySelector('[data-testid="inbox-item"]')); return true;`);

		// Hold every file request: the messages must not wait for bytes to reach the screen.
		const held = await evaluatePage<{ messages: number; loaded: number; newest: boolean }>(`
			const original = window.fetch;
			window.__fileRequests = [];
			window.__held = [];
			window.__holdFiles = true;
			window.fetch = (...args) => {
				const url = String(args[0]);
				if (!url.includes("/files/")) return original(...args);
				window.__fileRequests.push(url);
				if (!window.__holdFiles) return original(...args);
				return new Promise((resolve, reject) => window.__held.push(() => original(...args).then(resolve, reject)));
			};
			location.hash = '#/threads/${id}';
			await until(() => document.querySelectorAll('#thread-messages .message').length === ${MESSAGES});
			await new Promise(requestAnimationFrame);
			const bodies = document.querySelectorAll('#thread-messages .body');
			return {
				messages: bodies.length,
				loaded: document.querySelectorAll('#thread-messages img[src^="blob:"]').length,
				newest: bodies[bodies.length - 1].textContent.includes('Message ${MESSAGES - 1}'),
			};
		`);
		expect(held).toEqual({ messages: MESSAGES, loaded: 0, newest: true });

		// Let the bytes through: the newest messages load, an off-screen photo does not.
		const near = await evaluatePage<{ shared: number; oldest: number; loaded: number }>(`
			window.__holdFiles = false;
			window.__held.forEach((release) => release());
			window.__held = [];
			await until(() => document.querySelectorAll('#thread-messages img[src^="blob:"]').length >= 4);
			const requests = window.__fileRequests;
			return {
				shared: requests.filter((url) => url.includes('/shared.png')).length,
				oldest: requests.filter((url) => url.includes('/oldest.png')).length,
				loaded: document.querySelectorAll('#thread-messages img[src^="blob:"]').length,
			};
		`);
		// FIL-07: eleven messages show shared.png and the browser reads it once.
		expect(near.shared).toBe(1);
		expect(near.oldest).toBe(0);
		expect(near.loaded).toBeLessThan(MESSAGES);

		// The oldest message is far above the viewport; scrolling to it brings its picture in.
		const scrolled = await evaluatePage<{ oldest: number; oldestLoaded: boolean; width: number }>(`
			window.scrollTo(0, 0);
			await until(() => {
				const image = document.querySelector('#thread-messages .message:first-of-type img');
				return image && image.src.startsWith('blob:') && image.naturalWidth > 0;
			});
			const image = document.querySelector('#thread-messages .message:first-of-type img');
			return {
				oldest: window.__fileRequests.filter((url) => url.includes('/oldest.png')).length,
				oldestLoaded: image.src.startsWith('blob:'),
				width: image.naturalWidth,
			};
		`);
		expect(scrolled).toEqual({ oldest: 1, oldestLoaded: true, width: 320 });
		// One file, one copy: the shared picture still came over the wire once.
		const reads = await evaluatePage<number>(`return window.__fileRequests.filter((url) => url.includes('/shared.png')).length;`);
		expect(reads).toBe(1);
	});
});
