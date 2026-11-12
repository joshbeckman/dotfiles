// SET-05: the user sets a secret from the Settings page, so a phone without a terminal can
// store a credential a session will read with `s NAME -- command`.
//
// The store here is a stand-in `s`: a shell script that keeps each value in a file of its own.
// It exercises the real spawn path, including that a value travels on stdin and never in argv,
// which is the property a real `s` call depends on.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createSenvStore, MAX_VALUE_BYTES, secretNameError, secretValueError } from "../src/secrets/index.ts";
import { startTestPanad, type TestPanad } from "./harness/index.ts";

let t: TestPanad | undefined;
const dirs: string[] = [];
afterEach(async () => {
	await t?.close();
	t = undefined;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A stand-in `s`: values in files, argv in `argv.log`, and the same refusals the real one has. */
function fakeS(): { command: string; dir: string; valueOf(name: string): string | undefined } {
	const dir = mkdtempSync(join(tmpdir(), "pana-senv-"));
	dirs.push(dir);
	const command = join(dir, "s");
	writeFileSync(
		command,
		`#!/bin/sh
dir="${dir}/store"
mkdir -p "$dir"
printf '%s\\n' "---" >> "${dir}/argv.log"
for arg in "$@"; do printf '%s\\n' "$arg" >> "${dir}/argv.log"; done
case "$1" in
  list)
    set -- "$dir"/*
    if [ ! -e "$1" ]; then printf '[]\\n'; exit 0; fi
    printf '['
    sep=''
    for file in "$dir"/*; do printf '%s"%s"' "$sep" "$(basename "$file")"; sep=','; done
    printf ']\\n'
    ;;
  set)
    name="$3"
    case "$name" in
      [A-Za-z_]*)
        case "$name" in *[!A-Za-z0-9_]*) echo "error: invalid key: \\"$name\\"" >&2; exit 1 ;; esac
        ;;
      *) echo "error: invalid key: \\"$name\\"" >&2; exit 1 ;;
    esac
    cat > "$dir/$name"
    echo "✓ saved $name"
    ;;
  rm)
    if [ ! -f "$dir/$2" ]; then echo "error: key $2 not found" >&2; exit 1; fi
    rm -f "$dir/$2"
    echo "✓ removed $2"
    ;;
  *) echo "error: unknown command $1" >&2; exit 1 ;;
esac
`,
	);
	chmodSync(command, 0o755);
	return {
		command,
		dir,
		valueOf: (name) => {
			const path = join(dir, "store", name);
			return existsSync(path) ? readFileSync(path, "utf8") : undefined;
		},
	};
}

it("SET-05 the settings page lists, sets, and removes a secret through the s store", async () => {
	const store = fakeS();
	t = await startTestPanad({ secrets: createSenvStore({ command: store.command }) });

	const empty = await t.tcp.get<any>("/secrets");
	expect(empty.status).toBe(200);
	expect(empty.body).toMatchObject({ names: [], available: true, maxValueBytes: MAX_VALUE_BYTES });
	expect(empty.headers["cache-control"]).toBe("no-store");

	const saved = await t.tcp.post<any>("/secrets", { name: "GARMIN_PASSWORD", value: "correct horse battery" });
	expect(saved.status).toBe(200);
	expect(saved.body.names).toEqual(["GARMIN_PASSWORD"]);
	// The value landed in the store whole, and never appeared in the arguments `s` saw.
	expect(store.valueOf("GARMIN_PASSWORD")).toBe("correct horse battery");
	expect(readFileSync(join(store.dir, "argv.log"), "utf8")).not.toContain("correct horse");

	// Replacing keeps one entry, with the new value.
	const replaced = await t.tcp.post<any>("/secrets", { name: "GARMIN_PASSWORD", value: "second" });
	expect(replaced.body.names).toEqual(["GARMIN_PASSWORD"]);
	expect(store.valueOf("GARMIN_PASSWORD")).toBe("second");

	await t.tcp.post("/secrets", { name: "GARMIN_EMAIL", value: "josh@example.com" });
	const listed = await t.tcp.get<any>("/secrets");
	expect(listed.body.names).toEqual(["GARMIN_EMAIL", "GARMIN_PASSWORD"]);
	// A name is all the page ever learns.
	expect(JSON.stringify(listed.body)).not.toContain("second");
	expect(JSON.stringify(listed.body)).not.toContain("josh@example.com");

	const removed = await t.tcp.delete<any>("/secrets/GARMIN_EMAIL");
	expect(removed.status).toBe(200);
	expect(removed.body.names).toEqual(["GARMIN_PASSWORD"]);
	expect(store.valueOf("GARMIN_EMAIL")).toBeUndefined();

	const gone = await t.tcp.delete<any>("/secrets/GARMIN_EMAIL");
	expect(gone.status).toBe(404);
	expect(gone.body.error.code).toBe("not_found");
});

it("SET-05 sessions cannot read or write the user's secrets", async () => {
	t = await startTestPanad({ script: [{ text: "done" }], secrets: createSenvStore({ command: fakeS().command }) });
	const created = await t.client.post<any>("/sessions", { prompt: "hello", model: "faux/faux-1" });
	const caller = created.body.session.id;
	for (const [method, path] of [["GET", "/secrets"], ["POST", "/secrets"], ["DELETE", "/secrets/ANY_NAME"]]) {
		expect((await t.client.request(method!, path!, { caller, body: method === "POST" ? { name: "A", value: "b" } : undefined })).status).toBe(403);
	}
	// The socket as the user is allowed, so this is the caller and not the transport.
	expect((await t.client.get("/secrets")).status).toBe(200);
});

it("SET-05 a name or value s could not store is refused before s runs", async () => {
	const store = fakeS();
	t = await startTestPanad({ secrets: createSenvStore({ command: store.command }) });
	const invalid = [
		{ name: "", value: "x" },
		{ name: "9LIVES", value: "x" },
		{ name: "bad-name", value: "x" },
		{ name: "has space", value: "x" },
		{ name: "A".repeat(129), value: "x" },
		{ name: "OK_NAME" },
		{ name: "OK_NAME", value: "" },
		{ name: "OK_NAME", value: 7 },
		{ name: "OK_NAME", value: "x".repeat(MAX_VALUE_BYTES + 1) },
		{ name: "OK_NAME", value: "a\u0000b" },
	];
	for (const body of invalid) {
		const refused = await t.tcp.post<any>("/secrets", body);
		expect(refused.status, JSON.stringify(body).slice(0, 60)).toBe(400);
		expect(refused.body.error.code).toBe("invalid_secret");
	}
	expect((await t.tcp.delete<any>("/secrets/bad-name")).status).toBe(400);
	expect(store.valueOf("OK_NAME")).toBeUndefined();
});

it("SET-05 a store panad cannot run reads as a state, and a write says why", async () => {
	t = await startTestPanad({ secrets: createSenvStore({ command: join(tmpdir(), "pana-no-such-s", "s") }) });
	const listed = await t.tcp.get<any>("/secrets");
	expect(listed.status).toBe(200);
	expect(listed.body).toMatchObject({ names: [], available: false });
	expect(listed.body.error).toMatch(/not installed/);
	const refused = await t.tcp.post<any>("/secrets", { name: "A", value: "b" });
	expect(refused.status).toBe(502);
	expect(refused.body.error.code).toBe("secrets_unavailable");
});

it("SET-05 an s that hangs is killed rather than holding the request open", async () => {
	const store = fakeS();
	const slow = join(store.dir, "slow-s");
	writeFileSync(slow, "#!/bin/sh\nsleep 30\n");
	chmodSync(slow, 0o755);
	t = await startTestPanad({ secrets: createSenvStore({ command: slow, timeoutMs: 150 }) });
	const refused = await t.tcp.get<any>("/secrets");
	expect(refused.status).toBe(200);
	expect(refused.body).toMatchObject({ available: false });
	expect(refused.body.error).toMatch(/did not answer/);
});

it("SET-05 name and value rules name the problem", () => {
	expect(secretNameError("GARMIN_EMAIL")).toBeUndefined();
	expect(secretNameError("_x9")).toBeUndefined();
	for (const bad of ["", "1A", "a-b", "a b", "a.b", null, undefined, 42]) expect(secretNameError(bad)).toBeTruthy();
	expect(secretValueError("x")).toBeUndefined();
	expect(secretValueError("line1\nline2")).toBeUndefined();
	for (const bad of ["", null, 42, "a\0b"]) expect(secretValueError(bad)).toBeTruthy();
});

it("SET-05 the store parses what s list prints", async () => {
	const store = fakeS();
	const senv = createSenvStore({ command: store.command });
	mkdirSync(join(store.dir, "store"), { recursive: true });
	writeFileSync(join(store.dir, "store", "B_NAME"), "b");
	writeFileSync(join(store.dir, "store", "A_NAME"), "a");
	expect(await senv.list()).toEqual(["A_NAME", "B_NAME"]);
	await senv.set("C_NAME", "c");
	expect(await senv.list()).toEqual(["A_NAME", "B_NAME", "C_NAME"]);
	await senv.remove("B_NAME");
	expect(await senv.list()).toEqual(["A_NAME", "C_NAME"]);
	await expect(senv.remove("B_NAME")).rejects.toMatchObject({ code: "not_found" });
});

it("SET-05 the real s reads a value from stdin on a store of its own", async () => {
	// The fake above models `s`; this one runs the installed binary, if there is one, against a
	// throwaway store so nothing touches the user's. It is the check that argv and stdin agree.
	const command = execFileSync("sh", ["-c", "command -v s || true"], { encoding: "utf8" }).trim();
	if (!command) return;
	const dir = mkdtempSync(join(tmpdir(), "pana-senv-real-"));
	dirs.push(dir);
	const env = { ...process.env, S_FILE: join(dir, "store.senv"), S_KEY: "test-password" };
	execFileSync(command, ["init"], { env, stdio: "ignore" });
	const senv = createSenvStore({ command, env, timeoutMs: 30_000 });
	await senv.set("PANA_SET_05", "from the settings page");
	expect(await senv.list()).toEqual(["PANA_SET_05"]);
	// `s get` refuses a non-TTY and `s` redacts its own value from a child's output, so the
	// value is checked by comparison inside the child.
	const shown = execFileSync(
		command,
		["PANA_SET_05", "--", "sh", "-c", '[ "$PANA_SET_05" = "from the settings page" ] && printf match'],
		{ env, encoding: "utf8" },
	);
	expect(shown).toBe("match");
	await senv.remove("PANA_SET_05");
	expect(await senv.list()).toEqual([]);
});
