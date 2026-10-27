import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_IMAGE_LIMITS } from "@earendil-works/pi-durable/tools";
import { describe, expect, it } from "vitest";
import { nodeImages } from "../src/extension/images.ts";
import { imageSize } from "../src/threads/resize.ts";

const screenshot = readFileSync(join(import.meta.dirname, "fixtures/wide-screenshot.png"));

describe("coding reader image processor", () => {
	it("resizes to the default limit and reports coordinate mapping", async () => {
		const original = Buffer.from(screenshot);
		const result = await nodeImages.prepare(screenshot, "image/png", DEFAULT_IMAGE_LIMITS);
		expect(result?.resized).toEqual({ from: { width: 2050, height: 380 }, to: { width: 2000, height: 371 } });
		expect(imageSize(Buffer.from(result!.data, "base64"))).toEqual({ width: 2000, height: 371 });
		expect(result!.data.length).toBeLessThanOrEqual(DEFAULT_IMAGE_LIMITS.maxBytes);
		expect(screenshot).toEqual(original);
	});

	it("honors non-square model limits, including the height cap", async () => {
		const result = await nodeImages.prepare(screenshot, "image/png", { ...DEFAULT_IMAGE_LIMITS, maxHeight: 100 });
		const size = imageSize(Buffer.from(result!.data, "base64"));
		expect(size).toEqual({ width: 539, height: 100 });
	});

	it("also reduces images to fit the base64 byte budget", async () => {
		const result = await nodeImages.prepare(screenshot, "image/png", { ...DEFAULT_IMAGE_LIMITS, maxBytes: 1500 });
		expect(result).toBeDefined();
		expect(result!.data.length).toBeLessThanOrEqual(1500);
	});

	it("passes an already prepared image through unchanged", async () => {
		const first = await nodeImages.prepare(screenshot, "image/png", DEFAULT_IMAGE_LIMITS);
		const result = await nodeImages.prepare(Buffer.from(first!.data, "base64"), first!.mimeType, DEFAULT_IMAGE_LIMITS);
		expect(result?.data).toBe(first!.data);
		expect(result?.resized).toBeUndefined();
	});

	it("rejects corrupt image bytes without returning an attachment", async () => {
		expect(await nodeImages.prepare(new Uint8Array([1, 2, 3]), "image/png", DEFAULT_IMAGE_LIMITS)).toBeUndefined();
	});
});
