import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { cachedSourceRevision, runningRevision, SOURCE_REFRESH_MS } from "../src/config/source.ts";

async function until(check: () => boolean): Promise<void> {
	const deadline = Date.now() + 8000;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("timed out waiting for the source snapshot to refresh");
}

// A separate file isolates this module's cache from other settings tests that can refresh it.
it("SET-02 a stale source snapshot refreshes behind the response, off the event loop", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pana-gated-git-"));
	const started = join(dir, "started");
	const gate = join(dir, "release");
	const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
	writeFileSync(join(dir, "git"), `#!/bin/sh\ntouch ${JSON.stringify(started)}\nwhile [ ! -f ${JSON.stringify(gate)} ]; do [ -d ${JSON.stringify(dir)} ] || exit 1; sleep 0.05; done\nexec ${JSON.stringify(real)} "$@"\n`, { mode: 0o755 });
	const saved = process.env.PATH;
	process.env.PATH = `${dir}:${saved ?? ""}`;
	try {
		const before = runningRevision;
		expect(before).not.toBeNull();
		const time = performance.now();
		const stale = cachedSourceRevision(Date.now() + SOURCE_REFRESH_MS + 1);
		expect(performance.now() - time).toBeLessThan(100);
		expect(stale).toBe(before);
		await until(() => existsSync(started));
		// Release git only after the event loop has observed the still-stale snapshot.
		expect(cachedSourceRevision()).toBe(stale);
		writeFileSync(gate, "");
		await until(() => cachedSourceRevision() !== stale);
		expect(cachedSourceRevision()).toEqual(before);
	} finally {
		writeFileSync(gate, "");
		process.env.PATH = saved;
		rmSync(dir, { recursive: true, force: true });
	}
});
