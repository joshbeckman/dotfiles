import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cleanTranscript, extractMarkedTranscript, zshTranscriptHooks } from "../extensions/shell-escape.ts";

test("zsh hooks survive deferred setup replacing preexec_functions", () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-shell-test-"));
	const marker = "__MARKER__";
	fs.writeFileSync(
		path.join(tempDir, ".zshrc"),
		`autoload -Uz add-zsh-hook
_reset_preexec_hooks() {
  preexec_functions=()
}
add-zsh-hook preexec _reset_preexec_hooks
${zshTranscriptHooks(marker)}
`,
	);

	try {
		const result = spawnSync("zsh", ["-di"], {
			input: "echo one\necho two\nexit\n",
			encoding: "utf8",
			env: { ...process.env, ZDOTDIR: tempDir },
		});

		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, new RegExp(`${marker}:START:echo one`));
		assert.match(result.stdout, new RegExp(`${marker}:START:echo two`));
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test("cleanTranscript removes alternate-screen contents", () => {
	const transcript = [
		"before\r\n",
		"\x1b[?1049h\x1b[2Jfile contents\r\nmore file contents",
		"\x1b[?1049lafter\r\n",
	].join("");

	assert.equal(cleanTranscript(transcript), "before\nafter");
});

test("cleanTranscript handles alternate-screen modes independently", () => {
	const transcript = "before\x1b[?47h\x1b[?1047hhidden\x1b[?47lstill hidden\x1b[?1047lafter";

	assert.equal(cleanTranscript(transcript), "beforeafter");
});

test("extractMarkedTranscript omits editor rendering but keeps command output", () => {
	const marker = "__MARKER__";
	const transcript = [
		`${marker}:START:printf 'before\\n'; nvim file; printf 'after\\n'\r\n`,
		"before\r\n",
		"\x1b[?1049h\x1b[2Jfirst line of file\r\nsecond line of file\x1b[?1049l",
		"after\r\n",
		`${marker}:END:0\r\n`,
	].join("");

	assert.equal(
		extractMarkedTranscript(transcript, marker),
		"$ printf 'before\\n'; nvim file; printf 'after\\n'\nbefore\nafter",
	);
});
