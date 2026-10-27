// Real native Git tests, portable to macOS and Linux. All config/HOME are isolated.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { attributedCommit } from "../src/git/commit.ts";

const SESSION = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const DOMAIN = "test.example";
const TRAILER = `Co-authored-by: AI pana://${DOMAIN}/sessions/${SESSION} <tester@test.example>`;
const moduleURL = new URL("../src/git/commit.ts", import.meta.url).href;
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
	const root = mkdtempSync(join(tmpdir(), "pana-git-commit-"));
	roots.push(root);
	const repo = join(root, "repo");
	const home = join(root, "home");
	mkdirSync(repo);
	mkdirSync(home);
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: join(home, ".gitconfig"), GIT_EDITOR: "true", LC_ALL: "C",
	};
	const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8" });
	git("init", "-q");
	git("config", "user.name", "tester");
	git("config", "user.email", "tester@test.example");
	git("config", "commit.gpgSign", "false");
	writeFileSync(join(repo, "file"), "one\n");
	git("add", "file");
	function run(args: string[], input?: string, session: string | undefined = SESSION, extraEnv: NodeJS.ProcessEnv = {}, cwd = repo) {
		const script = `import { attributedCommit } from ${JSON.stringify(moduleURL)}; process.exitCode = await attributedCommit(process.argv.slice(1), {sessionId: ${JSON.stringify(session)}, domain: ${JSON.stringify(DOMAIN)}});`;
		return spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, "--", ...args], {
			cwd, env: { ...env, ...extraEnv }, input, encoding: "utf8",
		});
	}
	function hook(name: string, body: string, dir = join(repo, ".git", "hooks")) {
		mkdirSync(dir, { recursive: true });
		const file = join(dir, name);
		writeFileSync(file, `#!/bin/sh\nset -eu\n${body}\n`);
		chmodSync(file, 0o755);
	}
	const message = () => git("show", "--no-show-signature", "-s", "--format=%B", "HEAD").trim();
	return { root, repo, home, env, git, run, hook, message };
}

describe("explicit session-attributed git commit", () => {
	it("forwards injected stdin/stdout/stderr and reports validation through the supplied writer", async () => {
		const s = setup();
		let stdout = "";
		let stderr = "";
		const options = {
			cwd: s.repo, env: s.env, sessionId: SESSION, domain: DOMAIN,
			stdout: { write: (chunk: string) => { stdout += chunk; } },
			stderr: { write: (chunk: string) => { stderr += chunk; } },
			stdin: (async function* () { yield "feat: "; yield Buffer.from("streamed\n"); })(),
		};
		expect(await attributedCommit(["-F", "-"], options)).toBe(0);
		expect(stdout).toContain("feat: streamed");
		expect(stderr).toBe("");
		expect(s.message()).toBe(`feat: streamed\n\n${TRAILER}`);
		expect(await attributedCommit(["--dry-run"], options)).toBe(1);
		expect(stderr).toContain("unsupported git commit option");
	});

	it("adds one trailer to multiple -m paragraphs and keeps argv shell metacharacters literal", () => {
		const s = setup();
		const result = s.run(["-m", "feat: $(touch BAD)", "-m", "body with 'quotes'; & text"]);
		expect(result.status, result.stderr).toBe(0);
		expect(s.message()).toBe(`feat: $(touch BAD)\n\nbody with 'quotes'; & text\n\n${TRAILER}`);
	});

	it.each(["-F", "--file"])("lets Git read %s message files", (option) => {
		const s = setup();
		writeFileSync(join(s.repo, "message.txt"), "feat: file message\n\nits body\n");
		const result = s.run([option, "message.txt"]);
		expect(result.status, result.stderr).toBe(0);
		expect(s.message()).toBe(`feat: file message\n\nits body\n\n${TRAILER}`);
	});

	it("inherits stdin for -F -", () => {
		const s = setup();
		const result = s.run(["-F", "-"], "feat: stdin\n\nbody\n");
		expect(result.status, result.stderr).toBe(0);
		expect(s.message()).toBe(`feat: stdin\n\nbody\n\n${TRAILER}`);
	});

	it("amends with --no-edit without duplicating attribution, even if another coauthor follows", () => {
		const s = setup();
		expect(s.run(["-m", `feat: first\n\n${TRAILER}\nCo-authored-by: Other <other@test.example>\nCo-authored-by: AI pana://test.example/sessions/01ARZ3NDEKTSV4RRFFQ69G5FAW <tester@test.example>`]).status).toBe(0);
		const before = s.message();
		writeFileSync(join(s.repo, "file"), "two\n");
		const result = s.run(["-a", "--amend", "--no-edit"]);
		expect(result.status, result.stderr).toBe(0);
		expect(s.message()).toBe(before);
		expect(s.message().split(TRAILER)).toHaveLength(2);
	});

	it("supports combined short options, -C reuse-message and pathspecs", () => {
		const s = setup();
		expect(s.run(["-qmfeat: initial"]).status).toBe(0);
		writeFileSync(join(s.repo, "file"), "two\n");
		const result = s.run(["-CHEAD", "--", "file"]);
		expect(result.status, result.stderr).toBe(0);
		expect(s.message()).toBe(`feat: initial\n\n${TRAILER}`);
	});

	it("uses the default merge message and editor natively", () => {
		const s = setup();
		s.git("commit", "-qm", "initial");
		writeFileSync(join(s.repo, "file"), "two\n");
		s.git("add", "file");
		writeFileSync(join(s.repo, ".git", "MERGE_MSG"), "Merge fixture\n\nmerge detail\n");
		const result = s.run([]);
		expect(result.status, result.stderr).toBe(0);
		expect(s.message()).toBe(`Merge fixture\n\nmerge detail\n\n${TRAILER}`);
	});

	it("shows attribution to the native editor before commit", () => {
		const s = setup();
		const editor = join(s.root, "editor.sh");
		writeFileSync(editor, `#!/bin/sh\nset -eu\ngrep -F '${TRAILER}' "$1" > editor-seen\nprintf 'feat: edited\\n\\n' > "$1"\ncat editor-seen >> "$1"\n`);
		chmodSync(editor, 0o755);
		const result = s.run([], undefined, SESSION, { GIT_EDITOR: editor });
		expect(result.status, result.stderr).toBe(0);
		expect(s.message()).toBe(`feat: edited\n\n${TRAILER}`);
	});

	it("native prepare/commit hooks run at repository top level with attribution already present", () => {
		const s = setup();
		mkdirSync(join(s.repo, "sub"));
		s.hook("prepare-commit-msg", `pwd > prepare-cwd\ngrep -F '${TRAILER}' "$1" > prepare-seen\nprintf '%s' "$2" > prepare-source`);
		s.hook("commit-msg", `pwd > commit-cwd\ngrep -F '${TRAILER}' "$1" > commit-seen`);
		const result = s.run(["-m", "feat: hooked"], undefined, SESSION, {}, join(s.repo, "sub"));
		expect(result.status, result.stderr).toBe(0);
		for (const name of ["prepare", "commit"]) {
			expect(readFileSync(join(s.repo, `${name}-cwd`), "utf8").trim()).toBe(s.git("rev-parse", "--show-toplevel").trim());
			expect(readFileSync(join(s.repo, `${name}-seen`), "utf8").trim()).toBe(TRAILER);
		}
		expect(readFileSync(join(s.repo, "prepare-source"), "utf8")).toBe("message");
	});

	it.each(["pre-commit", "prepare-commit-msg", "commit-msg"])("preserves native %s rejection without creating a commit", (name) => {
		const s = setup();
		s.hook(name, "echo native-rejection >&2\nexit 42");
		const result = s.run(["-m", "feat: rejected"]);
		// git commit itself maps rejected hooks to status 1; preserve that exact status.
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("native-rejection");
		expect(spawnSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: s.repo, env: s.env }).status).not.toBe(0);
	});

	it.each(["remove", "duplicate", "change"])("detects hook attribution %s, leaving the created commit unchanged", (mode) => {
		const s = setup();
		const body = mode === "remove" ? `printf 'hook replacement\\n' > "$1"`
			: mode === "duplicate" ? `printf '${TRAILER}\\n' >> "$1"`
			: `printf 'hook replacement\\n\\nCo-authored-by: AI pana://${DOMAIN}/sessions/${SESSION} <changed@test.example>\\n' > "$1"`;
		s.hook("commit-msg", `${body}\ncp "$1" hook-message`);
		const result = s.run(["-m", "feat: changed"]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("attribution verification failed");
		expect(result.stderr).toContain("no repair attempted");
		expect(s.message()).toBe(readFileSync(join(s.repo, "hook-message"), "utf8").trim());
		expect(s.git("rev-list", "--count", "HEAD").trim()).toBe("1");
	});

	it("honors configured relative core.hooksPath natively", () => {
		const s = setup();
		s.git("config", "core.hooksPath", ".hooks");
		s.hook("pre-commit", "echo configured-hook >&2\nexit 1", join(s.repo, ".hooks"));
		const result = s.run(["-m", "feat: rejected"]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("configured-hook");
		expect(s.git("config", "--get", "core.hooksPath").trim()).toBe(".hooks");
	});

	it("preserves ordinary commit failure with nothing staged", () => {
		const s = setup();
		s.git("commit", "-qm", "initial");
		const before = s.git("rev-parse", "HEAD");
		const result = s.run(["-m", "nothing to commit"]);
		expect(result.status).toBe(1);
		expect(result.stdout).toContain("nothing to commit");
		expect(result.stderr).not.toContain("verification failed");
		expect(s.git("rev-parse", "HEAD")).toBe(before);
	});

	it("respects an explicit --no-verify without changing prepare-commit-msg behavior", () => {
		const s = setup();
		s.hook("pre-commit", "exit 1");
		s.hook("commit-msg", "exit 1");
		s.hook("prepare-commit-msg", `grep -F '${TRAILER}' "$1" > prepare-seen`);
		const result = s.run(["--no-verify", "-m", "feat: explicit skip"]);
		expect(result.status, result.stderr).toBe(0);
		expect(readFileSync(join(s.repo, "prepare-seen"), "utf8").trim()).toBe(TRAILER);
	});

	it("does not attribute ordinary native git commits", () => {
		const s = setup();
		s.git("commit", "-qm", "ordinary");
		expect(s.message()).toBe("ordinary");
	});

	it("refuses outside-session explicit commits before invoking Git", () => {
		const s = setup();
		const result = s.run(["-m", "must not commit"], undefined, "");
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("active PANA_SESSION");
		expect(spawnSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: s.repo, env: s.env }).status).not.toBe(0);
	});

	it.each(["--dry-run", "--short", "--porcelain", "--fixup=HEAD", "--squash=HEAD", "--trailer=custom", "--am", "-h"])("rejects ambiguous/noncommitting option %s before creating a commit", (option) => {
		const s = setup();
		const result = s.run([option, "-m", "not committed"]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("unsupported git commit option");
	});

	it("does not change native signing configuration or bypass signing failures", () => {
		const s = setup();
		const signer = join(s.root, "signer.sh");
		writeFileSync(signer, "#!/bin/sh\necho native-signer-invoked >&2\nexit 1\n");
		chmodSync(signer, 0o755);
		s.git("config", "commit.gpgSign", "true");
		s.git("config", "gpg.program", signer);
		const result = s.run(["-m", "signed"]);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("native-signer-invoked");
		expect(s.git("config", "--get", "commit.gpgSign").trim()).toBe("true");
	});

	it("normalizes trailer separators for its own operation without modifying repository config", () => {
		const s = setup();
		s.git("config", "trailer.separators", "=");
		const result = s.run(["-m", "feat: trailer"]);
		expect(result.status, result.stderr).toBe(0);
		expect(s.message()).toBe(`feat: trailer\n\n${TRAILER}`);
		expect(s.git("config", "--get", "trailer.separators").trim()).toBe("=");
	});
});
