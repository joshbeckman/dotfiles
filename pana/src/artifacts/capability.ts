import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants, closeSync, fstatSync, openSync, readFileSync, writeFileSync, linkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Runtime } from "../server/runtime.ts";

// Read through a descriptor without following symlinks. Existing keys must remain private.
function signingKey(runtime: Runtime, create = true): Buffer {
	const path = join(runtime.paths.dir, "artifact-signing-key");
	if (create) {
		// Publish only a completely written key; link does not replace another writer's key.
		const temp = join(runtime.paths.dir, `.artifact-key-${randomBytes(16).toString("hex")}`);
		try {
			writeFileSync(temp, randomBytes(32), { mode: 0o600, flag: "wx" });
			try { linkSync(temp, path); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
		} finally { try { unlinkSync(temp); } catch { /* No temp file was made. */ } }
	}
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new Error("artifact signing key must be mode 0600");
		const key = readFileSync(fd);
		if (key.length !== 32) throw new Error("invalid artifact signing key");
		return key;
	} finally { closeSync(fd); }
}
function signature(key: Buffer, version: string, expiry: string) {
	return createHmac("sha256", key).update(`${version}:${expiry}`).digest("base64url");
}
export function preview(runtime: Runtime, version: string, origin = runtime.artifactOrigin ?? `http://localhost:${runtime.config.http.port}`, entry?: string) {
	const expiresAt = runtime.clock.now() + runtime.config.artifacts.capMinutes * 60_000;
	const expiry = String(expiresAt);
	const capability = `${expiry}.${signature(signingKey(runtime), version, expiry)}`;
	// A nested entry must be opened at its own path for its relative assets to resolve.
	const suffix = entry?.includes("/") ? entry.split("/").map(encodeURIComponent).join("/") : "";
	return { previewUrl: `${origin}/a/${version}/${capability}/${suffix}`, expiresAt };
}
export function verify(runtime: Runtime, version: string, capability: string): boolean {
	const match = /^(\d+)\.([A-Za-z0-9_-]{43})$/.exec(capability);
	if (!match || Number(match[1]) <= runtime.clock.now()) return false;
	const expected = signature(signingKey(runtime, false), version, match[1]!);
	return timingSafeEqual(Buffer.from(expected), Buffer.from(match[2]!));
}
export const ARTIFACT_HEADERS = {
	"content-security-policy": "sandbox allow-scripts",
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
	"access-control-allow-origin": "*",
	"cache-control": "no-store",
};
/** Credential exemption is GET only and exactly this shape; the Host gate still runs. */
export function isArtifactRequest(method: string, path: string) {
	return method === "GET" && /^\/a\/[0-9A-HJKMNP-TV-Z]{26}(?:\/[^/]*(?:\/.*)?)?$/.test(path);
}
export function redactArtifactPath(path: string) {
	return /^\/a(?:\/|$)/.test(path) ? "/a/[redacted]" : path;
}
