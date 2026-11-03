import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import type { SourceRevision } from "../src/config/source.ts";

interface Snapshot {
	directory: string;
	running: SourceRevision;
	current: SourceRevision;
}
let directory: string | undefined;
let child: ChildProcess | undefined;
afterEach(async () => {
	if (child && child.exitCode === null && child.signalCode === null) {
		const exited = new Promise<void>((done) => child!.once("exit", () => done()));
		child.kill("SIGKILL");
		await exited;
	}
	child = undefined;
	if (directory) rmSync(directory, { recursive: true, force: true });
	directory = undefined;
});

/** Await one child IPC event, not a polling probe of a live service. */
function nextSnapshot(process: ChildProcess): Promise<Snapshot> {
	return new Promise((done, reject) => {
		const timer = setTimeout(() => { clean(); reject(new Error("source snapshot child timed out")); }, 10000);
		function clean() {
			clearTimeout(timer);
			process.off("message", message);
			process.off("exit", exit);
			process.off("error", error);
		}
		function message(value: unknown) { clean(); done(value as Snapshot); }
		function exit(code: unknown) { clean(); reject(new Error(`source snapshot child exited ${code}`)); }
		function error(error: Error) { clean(); reject(error); }
		process.once("message", message);
		process.once("exit", exit);
		process.once("error", error);
	});
}

it("SET-02 running source stays frozen as HEAD and local fingerprint advance; a fresh child import captures both", async () => {
	directory = mkdtempSync(join(tmpdir(), "pana-source-snapshot-"));
	const sourceRoot = join(directory, "pana");
	const configRoot = join(sourceRoot, "src", "config");
	mkdirSync(configRoot, { recursive: true });
	// Exercise the real module's import.meta.url-derived default directory, never the live checkout.
	const modulePath = join(configRoot, "source.ts");
	copyFileSync(new URL("../src/config/source.ts", import.meta.url), modulePath);
	writeFileSync(join(directory, "package.json"), '{"type":"module"}\n');
	const marker = join(sourceRoot, "marker.ts");
	writeFileSync(marker, "export const marker = 1;\n");
	const git = (...args: string[]) => execFileSync("git", ["-C", directory!, ...args], { encoding: "utf8", stdio: "pipe" });
	git("init");
	git("config", "user.name", "Test");
	git("config", "user.email", "test@example.com");
	git("add", ".");
	git("-c", "commit.gpgsign=false", "commit", "-m", "initial source");

	const importLine = `import {sourceDirectory, runningRevision, readSourceRevision} from ${JSON.stringify(pathToFileURL(modulePath).href)};`;
	const snapshot = "({directory:sourceDirectory,running:runningRevision,current:readSourceRevision()})";
	child = spawn(process.execPath, ["--input-type=module", "--eval", `${importLine}
		process.on("message", () => process.send(${snapshot}));
		process.send(${snapshot});`], { env: { PATH: process.env.PATH, HOME: directory }, stdio: ["ignore", "ignore", "inherit", "ipc"] });
	const initial = await nextSnapshot(child);
	expect(realpathSync(initial.directory)).toBe(realpathSync(sourceRoot));
	expect(initial.running).not.toBeNull();
	expect(initial.running.sha).toBe(git("rev-parse", "HEAD").trim());
	expect(initial.running.message).toBe("initial source");
	expect(initial.running.dirty).toBe(false);
	expect(initial.current).toEqual(initial.running);

	writeFileSync(marker, "export const marker = 2;\n");
	git("add", ".");
	git("-c", "commit.gpgsign=false", "commit", "-m", "advanced source");
	const committedResponse = nextSnapshot(child);
	child.send("read");
	const committed = await committedResponse;
	expect(committed.running).toEqual(initial.running);
	expect(committed.current.sha).toBe(git("rev-parse", "HEAD").trim());
	expect(committed.current.sha).not.toBe(initial.running.sha);
	expect(committed.current.message).toBe("advanced source");
	expect(committed.current.dirty).toBe(false);

	writeFileSync(marker, "export const marker = 3;\n");
	const editedResponse = nextSnapshot(child);
	child.send("read");
	const edited = await editedResponse;
	expect(edited.running).toEqual(initial.running);
	expect(edited.current.sha).toBe(committed.current.sha);
	expect(edited.current.dirty).toBe(true);
	expect(edited.current.fingerprint).not.toBe(committed.current.fingerprint);

	// SET-03 covers actual panad execve. A fresh Node import here isolates source recapture.
	const fresh = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "--eval", `${importLine}
		console.log(JSON.stringify(${snapshot}));`], { env: { PATH: process.env.PATH, HOME: directory }, encoding: "utf8", timeout: 10000 })) as Snapshot;
	expect(fresh.running).toEqual(edited.current);
	expect(fresh.current).toEqual(fresh.running);
	expect(fresh.running.sha).not.toBe(initial.running.sha);
	expect(fresh.running.fingerprint).not.toBe(initial.running.fingerprint);
});
