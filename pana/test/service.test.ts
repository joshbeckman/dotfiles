// WP9: service units, install, and gw/gsw attribution (SVC-01..04, GW-01).
//
// These tests read real tracked files and run the real shell scripts in
// subprocesses. The one thing they never do is start a daemon or reach the
// network: panad and `s` are stubs, and every HOME is a temp directory.

import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const panaRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(panaRoot, "..");
const isMac = process.platform === "darwin";

const temps: string[] = [];
afterEach(() => {
	for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function read(path: string): string {
	return readFileSync(join(repo, path), "utf8");
}

function tempHome(): string {
	const dir = mkdtempSync(join(tmpdir(), "pana-service-"));
	temps.push(dir);
	mkdirSync(join(dir, "bin"), { recursive: true });
	return dir;
}

function writeExecutable(path: string, body: string): void {
	writeFileSync(path, body);
	chmodSync(path, 0o755);
}

/** Run a command and return its output, failing the test with both streams on error. */
async function exec(file: string, args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}) {
	try {
		return await run(file, args, { cwd: repo, ...options, timeout: 30_000 });
	} catch (error) {
		const failure = error as { stdout?: string; stderr?: string; message: string };
		throw new Error(`${file} ${args.join(" ")} failed: ${failure.message}\n${failure.stdout ?? ""}\n${failure.stderr ?? ""}`);
	}
}

/** A fake `s` that records its arguments and injects one key, like the real one. */
const FAKE_S = `#!/bin/sh
printf '%s\\n' "$*" >>"$S_LOG"
printf 'S_KEY_COMMAND=%s\\n' "\${S_KEY_COMMAND:-}" >>"$S_LOG"
[ -z "\${S_KEY:-}" ] || printf 'S_KEY=set\\n' >>"$S_LOG"
if [ "\${1:-}" = list ]; then
  printf '  ANTHROPIC_API_KEY    [REDACTED]\\n'
  printf '  GITHUB_TOKEN         [REDACTED]\\n'
  exit 0
fi
while [ $# -gt 0 ] && [ "$1" != -- ]; do shift; done
shift
ANTHROPIC_API_KEY="$FAKE_SECRET" exec "$@"
`;

const FAKE_PANAD = `#!/bin/sh
printf 'args=%s\\n' "$*" >>"$PANAD_LOG"
printf 'ANTHROPIC_API_KEY=%s\\n' "\${ANTHROPIC_API_KEY:+present}" >>"$PANAD_LOG"
`;

/** A fake gh/gs that copies whichever body flag it was given. */
const FAKE_GITHUB = `#!/usr/bin/env bash
set -euo pipefail
args=("$@")
for ((i = 0; i < \${#args[@]}; i++)); do
  case "\${args[i]}" in
    --body-file|-F) cat "\${args[i + 1]}" >"$CAPTURE"; exit 0 ;;
    --body-file=*) cat "\${args[i]#--body-file=}" >"$CAPTURE"; exit 0 ;;
    --body|-b|--comment|-c) printf '%s\\n' "\${args[i + 1]}" >"$CAPTURE"; exit 0 ;;
  esac
done
: >"$CAPTURE"
`;

describe("WP9 service units", () => {
	it("SVC-01 Library/LaunchAgents/org.joshbeckman.panad.plist runs panad at login and restarts it on exit", async () => {
		const plist = read("Library/LaunchAgents/org.joshbeckman.panad.plist");

		expect(plist).toContain("<string>org.joshbeckman.panad</string>");
		// RunAtLoad is "at login" and KeepAlive with SuccessfulExit=false is
		// "restart it on exit", except for a deliberate clean stop.
		expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
		const keepAlive = /<key>KeepAlive<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(plist);
		expect(keepAlive?.[1]).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/);

		const program = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]+)<\/string>/.exec(plist);
		expect(program?.[1]).toMatch(/\/bin\/panad-service$/);
		// The job runs a script in this checkout, not a path baked into the plist.
		expect(statSync(join(repo, "bin", "panad-service")).mode & 0o100).not.toBe(0);
		// launchd's own PATH has no node, and the plist has to say so or the first
		// launch fails before the wrapper can fix it.
		expect(plist).toMatch(/<key>PATH<\/key>\s*<string>[^<]*homebrew[^<]*<\/string>/);

		if (isMac) await expect(exec("plutil", ["-lint", join(repo, "Library/LaunchAgents/org.joshbeckman.panad.plist")])).resolves.toBeTruthy();
	});

	it("SVC-02 .config/systemd/user/panad.service does the same on Linux, and setup enables it", () => {
		const unit = read(".config/systemd/user/panad.service");
		expect(unit).toMatch(/^ExecStart=%h\/dotfiles\/bin\/panad-service$/m);
		// The same rule as launchd's KeepAlive: restart on failure, stay down after
		// a deliberate stop.
		expect(unit).toMatch(/^Restart=on-failure$/m);
		expect(unit).toMatch(/^WantedBy=default\.target$/m);

		// setup links it beside the timers and enables it, because a linked unit that
		// is never enabled does nothing. test/setup runs that branch end to end.
		const setup = read("setup");
		const unitLoop = /for unit in ([^;]+); do/.exec(setup);
		expect(unitLoop?.[1]).toContain("panad.service");
		expect(setup).toMatch(/systemctl --user enable panad\.service/);
		expect(setup).not.toMatch(/enable --now panad\.service/);
	});

	it("SVC-03 the service injects provider credentials with s KEY... -- panad, and pana never writes them to disk", async () => {
		const home = tempHome();
		const log = (name: string) => join(home, name);
		writeExecutable(join(home, "bin", "s"), FAKE_S);
		writeExecutable(join(home, "bin", "panad-stub"), FAKE_PANAD);
		writeExecutable(join(home, "bin", "uname"), "#!/bin/sh\nprintf 'Darwin\\n'\n");
		// The wrapper starts panad only on a machine pana is set up for.
		mkdirSync(join(home, ".local", "state", "pana"), { recursive: true });
		writeFileSync(join(home, ".local", "state", "pana", "config.json"), '{"domain":"test.example","user":"tester"}\n');

		await exec("/bin/bash", [join(repo, "bin", "panad-service"), "one"], {
			env: {
				HOME: home,
				PATH: `${join(home, "bin")}:/usr/bin:/bin`,
				PANAD: join(home, "bin", "panad-stub"),
				S_LOG: log("s.log"),
				PANAD_LOG: log("panad.log"),
				FAKE_SECRET: "fixture-secret-value",
			},
		});

		const sLog = readFileSync(log("s.log"), "utf8");
		// Named keys after `--`, so a session's bash tool cannot inherit the rest of
		// the store (ISO-04).
		expect(sLog).toMatch(/ANTHROPIC_API_KEY -- .*\/panad-stub one/);
		expect(sLog).not.toContain("GITHUB_TOKEN");
		// The store password comes from the Keychain: a launchd job has no TTY, so
		// bare `s KEY -- panad` would fail with "reading password from TTY".
		expect(sLog).toContain("S_KEY_COMMAND=security find-generic-password -s s-secrets -w");
		expect(sLog).not.toContain("S_KEY=set");
		expect(readFileSync(log("panad.log"), "utf8")).toContain("ANTHROPIC_API_KEY=present");

		// Nothing pana can write holds the credential: it exists only in panad's
		// environment for as long as the process runs.
		expect(readdirSync(join(home, ".local", "state", "pana"))).toEqual(["config.json"]);
		for (const file of ["bin/panad-service", "Library/LaunchAgents/org.joshbeckman.panad.plist", ".config/systemd/user/panad.service"]) {
			expect(read(file)).not.toMatch(/S_KEY=\S|_API_KEY=\S/);
		}
	});

	it("SVC-04 Brewfile lists any new formula pana needs", () => {
		// panad runs on Node, and it is the only runtime dependency a service needs.
		const engines = JSON.parse(read("pana/package.json")).engines as { node: string };
		expect(engines.node).toContain("22.18");
		expect(read("Brewfile")).toMatch(/^brew "node"$/m);
		// `s` is not a formula: setup fetches the release binary.
		expect(read("setup")).toContain("installing s (encrypted env store)");
	});
});

describe("WP9 attribution", () => {
	it("GW-01 gw and gsw attribute posts when PANA_SESSION is set, using the session URL in the trailer", async () => {
		const home = tempHome();
		const capture = join(home, "captured");
		mkdirSync(join(home, ".local", "state", "pana"), { recursive: true });
		writeFileSync(join(home, ".local", "state", "pana", "config.json"), JSON.stringify({ domain: "test.example", user: "tester" }));
		writeExecutable(join(home, "bin", "gh"), FAKE_GITHUB);
		writeExecutable(join(home, "bin", "gs"), FAKE_GITHUB);

		const session = "01JB8ZQ4V0K3W9X2Y7Z5A6B8C9";
		const trailer = `Co-authored-by: AI pana://test.example/sessions/${session}`;
		// A pana session's bash tool has none of the harness variables agent-trailer
		// sniffs, so an explicit environment is also what the service really gets.
		const env = {
			HOME: home,
			PATH: `${join(home, "bin")}:${join(repo, "bin")}:/usr/bin:/bin`,
			CAPTURE: capture,
			PANA_SESSION: session,
		};

		await exec("/bin/bash", [join(repo, "bin", "gw"), "issue", "comment", "1", "--body", "Pana finding."], { env });
		expect(readFileSync(capture, "utf8")).toBe(`${trailer}\n\n> Pana finding.\n`);

		await exec("/bin/bash", [join(repo, "bin", "gsw"), "pr", "edit", "1", "--body", "Pana description."], { env });
		expect(readFileSync(capture, "utf8")).toBe(`Pana description.\n\n${trailer}\n`);

		// The commit form in pana/README.md takes the matching mailbox, so the same
		// session is attributable in Git history.
		const email = await exec("/bin/bash", [join(repo, "bin", "agent-trailer"), "--email"], { env });
		expect(email.stdout.trim()).toBe(`${trailer} <${session}@test.example>`);
	});
});
