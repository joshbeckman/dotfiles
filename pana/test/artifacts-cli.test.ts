import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ARTIFACT_COMMANDS } from "../src/artifacts/cli.ts";
import type { FileAttachment } from "../src/cli/body.ts";
import { invocationFor } from "../src/cli/commands.ts";

const THREAD = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ARTIFACT = "01BX5ZZKBKACTAV9WEVGEMMVRZ";

const publish = ARTIFACT_COMMANDS.find((command) => command.path.join(" ") === "artifact publish")!;
const show = ARTIFACT_COMMANDS.find((command) => command.path.join(" ") === "artifact show")!;

const dirs: string[] = [];

/** A build directory inside the test's cwd, so `--dir` stays relative with real ancestors. */
function build(): { root: string; dir: string } {
	const root = mkdtempSync(join(process.cwd(), ".artifacts-cli-"));
	dirs.push(root);
	return { root, dir: relative(process.cwd(), join(root, "build")) };
}

function recorder(): { uploads: string[]; upload: (path: string) => Promise<FileAttachment> } {
	const uploads: string[] = [];
	return {
		uploads,
		upload: async (path) => {
			uploads.push(path);
			return {
				id: `file-${uploads.length}`,
				name: basename(path),
				url: `pana://example.test/files/file-${uploads.length}/${basename(path)}`,
				mediaType: "text/plain",
			};
		},
	};
}

function write(root: string, path: string, contents = ""): void {
	const absolute = join(root, path);
	mkdirSync(join(absolute, ".."), { recursive: true });
	writeFileSync(absolute, contents);
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("artifact publish uploads", () => {
	it("uploads every regular file and sends only relative paths and file ids", async () => {
		const { dir } = build();
		write(dir, "index.html", "<html></html>");
		write(dir, "assets/app.js", "console.log(1)");
		write(dir, "assets/style.css", "body{}");
		const { uploads, upload } = recorder();

		const { params, spec } = await invocationFor(
			["artifact", "publish", THREAD, "--dir", dir, "--name", "site", "--note", "first"],
			{ upload },
		);

		expect(spec.path.join(" ")).toBe("artifact publish");
		expect(uploads.sort()).toEqual(
			[join(dir, "assets/app.js"), join(dir, "assets/style.css"), join(dir, "index.html")].sort(),
		);
		expect(JSON.parse(params.manifest as string)).toEqual([
			{ path: "assets/app.js", fileId: "file-1" },
			{ path: "assets/style.css", fileId: "file-2" },
			{ path: "index.html", fileId: "file-3" },
		]);
		const request = spec.request(params);
		expect(request.method).toBe("POST");
		expect(request.path).toBe(`/threads/${THREAD}/artifacts/site`);
		expect(request.body).toEqual({
			entry: "index.html",
			note: "first",
			files: [
				{ path: "assets/app.js", fileId: "file-1" },
				{ path: "assets/style.css", fileId: "file-2" },
				{ path: "index.html", fileId: "file-3" },
			],
		});
	});

	it("accepts a message URL as the thread", async () => {
		const { dir } = build();
		write(dir, "index.html");
		const { upload } = recorder();
		const { spec, params } = await invocationFor(
			["artifact", "publish", `pana://example.test/threads/${THREAD}?message=01ARZ3NDEKTSV4RRFFQ69G5FAW`, "--dir", dir, "--name", "site"],
			{ upload },
		);
		expect(spec.request(params).path).toBe(`/threads/${THREAD}/artifacts/site`);
	});

	it.each([
		["an absolute directory", (dir: string) => ({ dir: join(process.cwd(), dir), entry: "index.html" })],
		["a missing directory", () => ({ dir: ".artifacts-cli-missing/build", entry: "index.html" })],
		["a file as the directory", (dir: string) => ({ dir: join(dir, "index.html"), entry: "index.html" })],
		["a missing entry", (dir: string) => ({ dir, entry: "missing.html" })],
		["an absolute entry", (dir: string) => ({ dir, entry: "/index.html" })],
		["an entry that leaves the build", (dir: string) => ({ dir, entry: "../index.html" })],
	])("refuses %s before uploading", async (_name, options) => {
		const { dir } = build();
		write(dir, "index.html");
		const chosen = options(dir);
		const { uploads, upload } = recorder();
		await expect(
			invocationFor(["artifact", "publish", THREAD, "--dir", chosen.dir, "--name", "site", "--entry", chosen.entry], { upload }),
		).rejects.toThrow();
		expect(uploads).toEqual([]);
	});

	it("refuses an empty build before uploading", async () => {
		const { dir } = build();
		mkdirSync(join(process.cwd(), dir), { recursive: true });
		const { uploads, upload } = recorder();
		await expect(
			invocationFor(["artifact", "publish", THREAD, "--dir", dir, "--name", "site"], { upload }),
		).rejects.toThrow(/empty/);
		expect(uploads).toEqual([]);
	});

	it("refuses a symlinked directory before uploading", async () => {
		const { root, dir } = build();
		write(dir, "index.html");
		symlinkSync(join(root, "build"), join(root, "link"));
		const { uploads, upload } = recorder();
		await expect(
			invocationFor(["artifact", "publish", THREAD, "--dir", relative(process.cwd(), join(root, "link")), "--name", "site"], { upload }),
		).rejects.toThrow(/symlink/);
		expect(uploads).toEqual([]);
	});

	it("refuses a symlinked file inside the build before uploading", async () => {
		const { root, dir } = build();
		write(dir, "index.html");
		symlinkSync(join(root, "build", "index.html"), join(root, "build", "link.html"));
		const { uploads, upload } = recorder();
		await expect(
			invocationFor(["artifact", "publish", THREAD, "--dir", dir, "--name", "site"], { upload }),
		).rejects.toThrow(/symlink/);
		expect(uploads).toEqual([]);
	});

	it("refuses a caller that cannot upload", async () => {
		const { dir } = build();
		write(dir, "index.html");
		await expect(
			invocationFor(["artifact", "publish", THREAD, "--dir", dir, "--name", "site"]),
		).rejects.toThrow(/cannot upload/);
	});
});

describe("artifact publish text", () => {
	it("prints both refs, the preview with its expiry, the entry, and every warning", () => {
		const text = publish.formatText!({
			artifact: { id: ARTIFACT, url: `pana://example.test/artifacts/${ARTIFACT}` },
			version: { id: "VERSION", seq: 2, url: `pana://example.test/artifacts/${ARTIFACT}/v/2` },
			previewUrl: "https://example.test/a/VERSION/capability/",
			expiresAt: Date.parse("2026-01-01T00:00:00Z"),
			entry: "index.html",
			warnings: ["index.html: root-relative reference /assets/app.js", "app.js: \u001b[31mcancel\u001b[0m"],
		});
		expect(text).toBe(
			[
				`artifact: pana://example.test/artifacts/${ARTIFACT}`,
				`version: pana://example.test/artifacts/${ARTIFACT}/v/2`,
				"preview: https://example.test/a/VERSION/capability/",
				"expires: 2026-01-01T00:00:00.000Z",
				"entry: index.html",
				"warnings:",
				"  - index.html: root-relative reference /assets/app.js",
				"  - app.js: [31mcancel[0m",
				"",
			].join("\n"),
		);
	});

	it("says so when there are no warnings", () => {
		const text = publish.formatText!({
			artifact: { url: `pana://example.test/artifacts/${ARTIFACT}` },
			version: { url: `pana://example.test/artifacts/${ARTIFACT}/v/1` },
			previewUrl: "https://example.test/a/VERSION/capability/",
			expiresAt: Date.parse("2026-01-01T00:00:00Z"),
			entry: "index.html",
			warnings: [],
		});
		expect(text).toContain("warnings: none");
	});
});

describe("artifact selectors", () => {
	it("reads a versioned artifact URL as id and seq", () => {
		expect(show.request({ artifact: `pana://example.test/artifacts/${ARTIFACT}/v/2` })).toEqual({
			method: "GET",
			path: `/artifacts/${ARTIFACT}`,
			query: { seq: "2" },
		});
	});

	it("reads an artifact URL without a version", () => {
		expect(show.request({ artifact: `pana://example.test/artifacts/${ARTIFACT}` })).toEqual({
			method: "GET",
			path: `/artifacts/${ARTIFACT}`,
			query: undefined,
		});
	});

	it("refuses an artifact URL with an unknown suffix", () => {
		expect(() => show.request({ artifact: `pana://example.test/artifacts/${ARTIFACT}/v/two` })).toThrow(
			/expected an artifact URL/,
		);
	});
});
