// Explicit, opt-in session attribution. Git owns message selection, editor invocation,
// signing, hooks, and the commit transaction; pana neither replaces hooks nor repairs
// commits afterward. Requires git commit's native --trailer support (Git >= 2.32).
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:os";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isUlid } from "../ids/index.ts";

export interface AttributedCommitOptions {
	sessionId?: string;
	domain: string;
	cwd?: string;
	/** Complete child environment; defaults to the caller's unchanged environment. */
	env?: NodeJS.ProcessEnv;
	/** Omit streams to inherit native descriptors (including terminal/editor support). */
	stdin?: AsyncIterable<Buffer | string>;
	stdout?: { write(chunk: string): unknown };
	stderr?: { write(chunk: string): unknown };
}

const LONG_FLAGS = new Set([
	"all", "patch", "interactive", "include", "only", "signoff", "no-signoff",
	"verify", "no-verify", "edit", "no-edit", "amend", "reset-author", "allow-empty",
	"allow-empty-message", "quiet", "verbose", "no-post-rewrite", "no-gpg-sign",
	"status", "no-status", "pathspec-file-nul",
]);
const LONG_VALUES = new Set([
	"message", "file", "reuse-message", "reedit-message", "template", "author", "date",
	"cleanup", "pathspec-from-file",
]);

/** An allowlist avoids Git abbreviations, dry-run aliases, and message-transforming
 * modes such as --fixup/--squash. Values and pathspecs remain opaque argv elements. */
function validateArgs(args: string[]): string | undefined {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "--") break;
		if (!arg.startsWith("-") || arg === "-") continue;
		if (arg.startsWith("--")) {
			const [name, ...value] = arg.slice(2).split("=");
			if (LONG_FLAGS.has(name!) && value.length === 0) continue;
			if (LONG_VALUES.has(name!)) {
				if (value.length === 0 && ++i >= args.length) return `missing value for ${arg}`;
				continue;
			}
			if (name === "gpg-sign" || name === "untracked-files") continue; // optional =value
			return `unsupported git commit option ${arg}; use native git for unattributed operations`;
		}
		for (let j = 1; j < arg.length; j++) {
			const flag = arg[j]!;
			if ("apiosenqv".includes(flag)) continue;
			if ("mFCct".includes(flag)) {
				if (j === arg.length - 1 && ++i >= args.length) return `missing value for -${flag}`;
				break;
			}
			if (flag === "S" || flag === "u") break; // optional attached argument
			return `unsupported git commit option -${flag}; use native git for unattributed operations`;
		}
	}
	return undefined;
}

/**
 * Run one native `git commit`, adding the current session's coauthor trailer. Arguments
 * are commit arguments only (no git-global -C/-c flags). StdIO is inherited, including
 * stdin for -F - and the editor's terminal. Returns the native failure status, or 1 for
 * validation/verification failure. Never amends a created commit to repair attribution.
 *
 * Existing other-session/coauthor trailers are retained. Reusing a message with this
 * exact attribution does not duplicate it. If hooks or an editor remove/duplicate/change
 * attribution, a created commit is left intact and the operation reports failure.
 */
export async function attributedCommit(args: string[], options: AttributedCommitOptions): Promise<number> {
	const fail = (message: string): number => {
		(options.stderr ?? process.stderr).write(`pana git commit: ${message}\n`);
		return 1;
	};
	if (!options.sessionId || !isUlid(options.sessionId)) return fail("an active PANA_SESSION (session ULID) is required");
	if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*(?::[0-9]+)?$/.test(options.domain)) return fail("invalid pana domain");
	const invalid = validateArgs(args);
	if (invalid) return fail(invalid);
	const env = options.env ?? process.env;
	const git = (argv: string[], input?: string) => spawnSync("git", argv, {
		cwd: options.cwd, env, encoding: "utf8", input,
		stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
	});
	const emailResult = git(["config", "--get", "user.email"]);
	if (emailResult.error) return fail(emailResult.error.message);
	if (emailResult.status !== 0 && emailResult.status !== 1) return fail(emailResult.stderr.trim() || "cannot read git user.email");
	const email = emailResult.stdout.trim();
	if (/[\r\n<>]/.test(email)) return fail("git user.email cannot be represented safely in a coauthor trailer");
	const identity = `AI pana://${options.domain}/sessions/${options.sessionId}`;
	const trailer = `Co-authored-by: ${identity}${email ? ` <${email}>` : ""}`;
	// A per-invocation alias cannot inherit trailer.<alias>.command/cmd from user
	// configuration. Only trailer formatting is scoped; repository hooks/signing and
	// every other Git setting remain native. Never set core.hooksPath here.
	const alias = `pana${randomUUID().replaceAll("-", "")}`;
	const config = [
		"-c", "trailer.separators=:",
		"-c", `trailer.${alias}.key=Co-authored-by`,
		"-c", `trailer.${alias}.where=end`,
		"-c", `trailer.${alias}.ifExists=addIfDifferent`,
		"-c", `trailer.${alias}.ifMissing=add`,
	];
	// Prepend our option so pathspecs cannot swallow it; leave all caller argv intact.
	const code = await new Promise<number>((resolve) => {
		const child = spawn("git", [...config, "commit", `--trailer=${alias}=${identity}${email ? ` <${email}>` : ""}`, ...args], {
			cwd: options.cwd, env,
			stdio: [options.stdin ? "pipe" : "inherit", options.stdout ? "pipe" : "inherit", options.stderr ? "pipe" : "inherit"],
		});
		let forwardingError: Error | undefined;
		const source = options.stdin ? Readable.from(options.stdin) : undefined;
		if (source && child.stdin) {
			void pipeline(source, child.stdin).catch((error: NodeJS.ErrnoException) => {
				// Early hook rejection can close stdin before its producer is finished.
				if (error.code === "EPIPE" || error.code === "ERR_STREAM_PREMATURE_CLOSE") return;
				forwardingError = error;
				child.kill();
			});
		}
		for (const [stream, writer] of [[child.stdout, options.stdout], [child.stderr, options.stderr]] as const) {
			stream?.setEncoding("utf8").on("data", (chunk: string) => writer?.write(chunk));
		}
		child.once("error", (error) => resolve(fail(error.message)));
		child.once("close", (status, signal) => {
			source?.destroy();
			const nativeCode = status ?? (signal ? 128 + constants.signals[signal] : 1);
			resolve(nativeCode !== 0 ? nativeCode : forwardingError ? fail(forwardingError.message) : 0);
		});
	});
	if (code !== 0) return code;
	const message = git(["show", "--no-show-signature", "-s", "--format=%B", "HEAD"]);
	if (message.error || message.status !== 0) return fail("commit succeeded but its message could not be verified; inspect HEAD (no repair attempted)");
	const parsed = git(["-c", "trailer.separators=:", "interpret-trailers", "--parse"], message.stdout);
	const sessionLines = parsed.stdout?.split(/\r?\n/).filter((line) => {
		const match = /^Co-authored-by:\s*(.*)$/i.exec(line);
		return match?.[1] === identity || match?.[1]?.startsWith(`${identity} <`);
	}) ?? [];
	if (parsed.error || parsed.status !== 0 || sessionLines.length !== 1 || sessionLines[0] !== trailer) {
		return fail("commit succeeded but session attribution verification failed; inspect HEAD (no repair attempted)");
	}
	return 0;
}
