import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { statusToExitCode } from "../src/api/errors.ts";
import { appendAttachmentMarkdown, attachmentMarkdown } from "../src/threads/index.ts";
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

async function upload(t: TestPanad, name: string, bytes: Buffer, mediaType = "image/png"): Promise<FileBody["file"]> {
	const res = await t.client.request<FileBody>("POST", `/files?name=${encodeURIComponent(name)}`, {
		bytes,
		headers: { "content-type": mediaType },
	});
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.file;
}

describe("files", () => {
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
