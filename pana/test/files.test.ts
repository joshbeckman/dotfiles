import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { inlineDisposition } from "../src/threads/files.ts";
import { statusToExitCode } from "../src/api/errors.ts";
import {
	appendAttachmentMarkdown,
	attachmentMarkdown,
	FILES_CACHE_CONTROL,
	findBackend,
	imageSize,
	loadFile,
	MAX_WIDTH,
	MIN_WIDTH,
	parseWidth,
	resizedImage,
} from "../src/threads/index.ts";
import { startTestPanad, TEST_DOMAIN, TEST_USER, type TestPanad } from "./harness/index.ts";

interface FileBody {
	file: {
		id: string;
		name: string;
		url: string;
		path: string;
		size: number;
		mediaType: string | null;
		uploader: { id: string; kind: string; url: string };
		createdAt: number;
	};
}

let t: TestPanad | undefined;
afterEach(async () => {
	await t?.close();
	t = undefined;
});

async function start(options: Parameters<typeof startTestPanad>[0] = {}): Promise<TestPanad> {
	t = await startTestPanad(options);
	return t;
}

const BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]);

/** A 4x2 baseline JPEG, small enough to keep inline, for the header reader (FIL-07). */
const TINY_JPEG = Buffer.from(
	"/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/wAALCAACAAQBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAB//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AZn//2Q==",
	"base64",
);

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

/** A real PNG of the given size, with noise so a smaller copy is also fewer bytes. */
function png(width: number, height: number): Buffer {
	const rows = Buffer.alloc(height * (1 + width * 3));
	let seed = 7;
	for (let y = 0; y < height; y++) {
		const start = y * (1 + width * 3);
		rows[start] = 0;
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
		chunk("IDAT", deflateSync(rows)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

async function upload(t: TestPanad, name: string, bytes: Buffer, mediaType = "image/png"): Promise<FileBody["file"]> {
	const res = await t.client.request<FileBody>("POST", `/files?name=${encodeURIComponent(name)}`, {
		bytes,
		headers: { "content-type": mediaType },
	});
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.file;
}

describe("files", () => {
	it("FIL-04 disposition headers escape unsafe characters and preserve UTF-8 names", () => {
		expect(inlineDisposition("shot\u202fPM.png")).toBe(`inline; filename="shot_PM.png"; filename*=UTF-8''shot%E2%80%AFPM.png`);
		expect(inlineDisposition("a!'()*.png")).toBe(`inline; filename="a!'()*.png"; filename*=UTF-8''a%21%27%28%29%2A.png`);
		for (const name of ['plain.png', '日本語😀.png', 'a"b\\c%\r\n\t\x7f.png', "a!'()*.png"]) {
			const header = inlineDisposition(name);
			expect(header).toMatch(/^[\x20-\x7e]+$/);
			expect(header).toMatch(/^inline; filename="[^"\\%]*"; filename\*=UTF-8''/);
			expect(decodeURIComponent(header.split("filename*=UTF-8''")[1]!)).toBe(name);
		}
	});

	it("FIL-04 FIL-07 Unicode filenames download original and inline bytes without invalid headers", async () => {
		const t = await start();
		const bytes = png(200, 100);
		for (const name of ["Screenshot 2026-10-28 at 4.00.28\u202fPM.png", "日本語😀.png", "café.png", "plain.png", 'quote"name.png']) {
			const file = await upload(t, name, bytes);
			for (const query of ["", "?w=64"]) {
				const res = await t.tcp.get(`/files/${file.id}/${encodeURIComponent(name)}${query}`);
				expect(res.status, JSON.stringify(res.body)).toBe(200);
				expect(res.headers["content-type"]).toBe("image/png");
				expect(res.headers["content-disposition"]).toBe(inlineDisposition(name));
				if (query && findBackend()) expect(imageSize(res.raw as Buffer)).toEqual({ width: 64, height: 32 });
				else expect(res.raw).toEqual(bytes);
			}
		}
	});

	it("FIL-01 upload copies the file to files/<ulid>/<basename> and records path, size, media type, and uploader", async () => {
		const t = await start();
		const file = await upload(t, "cat.png", BYTES);

		expect(file.path).toBe(`files/${file.id}/cat.png`);
		expect(existsSync(join(t.dir, file.path))).toBe(true);
		expect(readFileSync(join(t.dir, file.path))).toEqual(BYTES);
		expect(file.size).toBe(BYTES.byteLength);
		expect(file.mediaType).toBe("image/png");
		expect(file.uploader).toEqual({ id: TEST_USER, kind: "user", url: t.runtime.userUrl });
		expect(file.url).toBe(`pana://${TEST_DOMAIN}/files/${file.id}/cat.png`);

		const row = await t.runtime.db.get<{ path: string; size: number; media_type: string; uploader_id: string }>(
			"SELECT path, size, media_type, uploader_id FROM files WHERE id = ?",
			file.id,
		);
		expect(row).toEqual({ path: file.path, size: BYTES.byteLength, media_type: "image/png", uploader_id: TEST_USER });
	});

	it("FIL-02 the CLI's helper appends ![name](url) for images and [name](url) otherwise", () => {
		const image = attachmentMarkdown({ name: "cat.png", url: "pana://test.example/files/01A/cat.png", mediaType: "image/png" });
		expect(image).toBe("![cat.png](pana://test.example/files/01A/cat.png)");
		const doc = attachmentMarkdown({ name: "notes.md", url: "pana://test.example/files/01B/notes.md", mediaType: "text/markdown" });
		expect(doc).toBe("[notes.md](pana://test.example/files/01B/notes.md)");

		const body = appendAttachmentMarkdown("see attached", [
			{ name: "cat.png", url: "pana://test.example/files/01A/cat.png", mediaType: "image/png" },
			{ name: "notes.md", url: "pana://test.example/files/01B/notes.md", mediaType: "text/markdown" },
		]);
		expect(body).toBe(
			"see attached\n\n![cat.png](pana://test.example/files/01A/cat.png)\n[notes.md](pana://test.example/files/01B/notes.md)",
		);
		expect(appendAttachmentMarkdown("only text", [])).toBe("only text");
	});

	it("FIL-03 a file over files.maxBytes returns 400 and copies nothing", async () => {
		const t = await start({ config: { files: { maxBytes: 10 } } });
		const res = await t.client.request("POST", "/files?name=big.bin", {
			bytes: Buffer.alloc(11, 7),
			headers: { "content-type": "application/octet-stream" },
		});
		expect(res.status).toBe(400);
		expect(statusToExitCode(res.status)).toBe(2);
		expect(res.body).toMatchObject({ error: { code: "file_too_large", maxBytes: 10 } });
		expect(readdirSync(join(t.dir, "files"))).toEqual([]);
		expect(await t.runtime.db.get("SELECT id FROM files")).toBeUndefined();
	});

	it("FIL-04 downloads the bytes with the recorded media type, and a wrong name is 404", async () => {
		const t = await start();
		const file = await upload(t, "cat.png", BYTES);

		const ok = await t.client.get(`/files/${file.id}/cat.png`);
		expect(ok.status).toBe(200);
		expect(ok.raw).toEqual(BYTES);
		expect(String(ok.headers["content-type"])).toBe("image/png");

		const wrong = await t.client.get(`/files/${file.id}/dog.png`);
		expect(wrong.status).toBe(404);
		expect(statusToExitCode(wrong.status)).toBe(4);

		const missing = await t.client.get(`/files/${t.runtime.newId()}/cat.png`);
		expect(missing.status).toBe(404);
	});

	it("FIL-07 a width the picture already fits, a bad width, and a non-image serve the original", async () => {
		const t = await start();
		const wide = png(200, 100);
		const small = await upload(t, "small.png", png(20, 10));
		const doc = await upload(t, "notes.txt", Buffer.from("hello"), "text/plain");

		for (const query of ["", "?w=1024", "?w=abc", "?w=0", "?w=-4"]) {
			const res = await t.client.get(`/files/${small.id}/small.png${query}`);
			expect(res.status, query).toBe(200);
			expect(res.raw, query).toEqual(png(20, 10));
			// FIL-07: a file's bytes never change, so a browser may keep them and a reopened
			// thread costs no transfer.
			expect(String(res.headers["cache-control"]), query).toBe(FILES_CACHE_CONTROL);
		}
		const text = await t.client.get(`/files/${doc.id}/notes.txt?w=64`);
		expect(text.raw).toEqual(Buffer.from("hello"));

		// A width the source is not wider than and a width past the cap both leave the bytes alone.
		const original = await t.client.get(`/files/${small.id}/small.png?w=${MAX_WIDTH}`);
		expect(original.raw).toEqual(png(20, 10));
		expect(imageSize(wide)).toEqual({ width: 200, height: 100 });
	});

	it("FIL-07 ?w= serves a copy no wider than asked for, made once and kept beside the original", async () => {
		const t = await start();
		const wide = png(200, 100);
		const file = await upload(t, "wide.png", wide);
		if (!findBackend()) {
			// No resizer on this host: the original is the answer, and FIL-07's fallback is all
			// this test can check.
			const res = await t.client.get(`/files/${file.id}/wide.png?w=64`);
			expect(res.raw).toEqual(wide);
			return;
		}

		const res = await t.client.get(`/files/${file.id}/wide.png?w=64`);
		expect(res.status).toBe(200);
		expect(String(res.headers["content-type"])).toBe("image/png");
		const size = imageSize(res.raw as Buffer);
		expect(size?.width).toBe(64);
		expect(size?.height).toBe(32);
		expect((res.raw as Buffer).length).toBeLessThan(wide.length);

		// The copy is on disk beside the original, and a second request reuses it.
		const cache = join(t.dir, "files", file.id, ".resized");
		expect(readdirSync(cache)).toEqual(["64-wide.png"]);
		const again = await t.client.get(`/files/${file.id}/wide.png?w=64`);
		expect(again.raw).toEqual(res.raw);
		expect(readdirSync(cache)).toEqual(["64-wide.png"]);

		// The original is untouched, and its own request still serves full size.
		expect(readFileSync(join(t.dir, file.path))).toEqual(wide);
		expect((await t.client.get(`/files/${file.id}/wide.png`)).raw).toEqual(wide);
	});

	it("FIL-07 without a resizer, or with one that fails, the original bytes come back", async () => {
		const t = await start();
		const wide = png(200, 100);
		const file = await upload(t, "wide.png", wide);
		const loaded = await loadFile(t.runtime, file.id, "wide.png");

		expect(await resizedImage(t.runtime, loaded, 64, null)).toEqual({ bytes: loaded.bytes, mediaType: "image/png" });
		const broken = { command: "no-such-resizer", probe: [], args: () => [] };
		expect(await resizedImage(t.runtime, loaded, 64, broken)).toEqual({ bytes: loaded.bytes, mediaType: "image/png" });
		expect(readdirSync(join(t.dir, "files", file.id))).toEqual(["wide.png"]);
	});

	it("FIL-07 a requested width is clamped to the cache's range or ignored", () => {
		expect(parseWidth("64")).toBe(64);
		expect(parseWidth(" 128 ")).toBe(128);
		expect(parseWidth("1")).toBe(MIN_WIDTH);
		expect(parseWidth("99999")).toBe(MAX_WIDTH);
		expect(parseWidth("7.6")).toBe(MIN_WIDTH);
		expect(parseWidth("abc")).toBeUndefined();
		expect(parseWidth("0")).toBeUndefined();
		expect(parseWidth("")).toBeUndefined();
		expect(parseWidth(undefined)).toBeUndefined();
		expect(parseWidth(64)).toBeUndefined();
	});

	it("FIL-07 PNG and JPEG headers give the pixel size, and anything else has none", () => {
		expect(imageSize(png(3, 2))).toEqual({ width: 3, height: 2 });
		expect(imageSize(TINY_JPEG)).toEqual({ width: 4, height: 2 });
		expect(imageSize(Buffer.from("not an image"))).toBeUndefined();
		expect(imageSize(Buffer.alloc(0))).toBeUndefined();
	});

	it("FIL-05 file bytes are never stored in SQLite", async () => {
		const t = await start();
		const marker = "PANA-FILE-BYTES-MARKER-4f8a1c";
		const file = await upload(t, "marker.txt", Buffer.from(marker), "text/plain");
		expect(file.path).toBe(`files/${file.id}/marker.txt`);

		const rows = await t.runtime.db.all<Record<string, unknown>>("SELECT * FROM files");
		expect(JSON.stringify(rows)).not.toContain(marker);

		for (const name of ["pana.sqlite", "pana.sqlite-wal", "pana.sqlite-shm"]) {
			const path = join(t.dir, name);
			if (existsSync(path)) expect(readFileSync(path).includes(marker), name).toBe(false);
		}
	});
});
