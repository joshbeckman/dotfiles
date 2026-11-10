// The git this module runs on a caller-chosen repository (GUARD-03).
//
// `repo` comes from the caller, so both the path and the `.git/config` behind it are theirs. Git
// executes what that config names — hooks on `worktree add`, `core.fsmonitor` on anything that
// reads the index, and filters during checkout — as panad, with panad's environment. panad's own
// environment is no safer to hand over: `GIT_DIR`, `GIT_WORK_TREE` or `GIT_CONFIG_*` from the
// shell that started panad point the child at a repository other than the one validated here.
// So every call builds its environment and disables fsmonitor and the hooks these calls can run.
// Checkout also needs an isolated config: there is no Git option that disables all named filters.

import { execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

// Newer Git can run configured hooks even with hooksPath disabled. A no-checkout add can
// update refs (reference-transaction); explicitly disable that event and post-checkout too.
const NEUTRAL = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null",
	"-c", "hook.reference-transaction.enabled=false", "-c", "hook.post-checkout.enabled=false"];

/** The variables a git child needs; nothing else from panad's environment, and no `GIT_*`. */
const KEEP = ["PATH", "HOME", "TMPDIR", "USER", "LANG", "TERM"] as const;

/** A built environment for a git child, never panad's. */
export function scrubbedEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: "0" };
	for (const key of KEEP) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	env.PATH ??= "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
	return env;
}

/** Run git in `repo` in argv form; resolves with its output and rejects on a non-zero exit. */
export function gitIn(repo: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
	return run("git", [...NEUTRAL, "-C", repo, ...args], { env: scrubbedEnv() });
}

// Git's conversion controls that can be passed as inert values, not executable commands.
const CHECKOUT_CONFIG = /^core\.(autocrlf|eol|safecrlf|symlinks|sparsecheckout|sparsecheckoutcone|checkroundtripencoding|protecthfs|protectntfs|ignorecase|precomposeunicode|filemode)$/;
const CONVERSION_ATTRS = new Set(["filter", "text", "crlf", "eol", "ident", "working-tree-encoding"]);
const MAX_OUTPUT = 64 * 1024 * 1024;

async function checkoutConfig(path: string): Promise<string[]> {
	let output: string;
	try {
		({ stdout: output } = await run("git", [...NEUTRAL, "-C", path, "config", "--includes", "--null", "--get-regexp", CHECKOUT_CONFIG.source], {
			env: scrubbedEnv(), maxBuffer: MAX_OUTPUT,
		}));
	} catch (error) {
		if ((error as { code?: number }).code === 1) return [];
		throw error;
	}
	const entries = output.split("\0").filter(Boolean).map((entry) => {
		const split = entry.indexOf("\n");
		return split < 0 ? [entry, undefined] as const : [entry.slice(0, split), entry.slice(split + 1)] as const;
	});
	const sparse = entries.filter(([key]) => key === "core.sparsecheckout").at(-1);
	if (sparse && (sparse[1] === undefined || !/^(false|no|off|0)$/i.test(sparse[1]))) {
		throw new Error("sparse checkout is not supported by isolated worktree creation; use a trusted adapter");
	}
	return entries.filter(([key]) => key !== "core.sparsecheckout" && key !== "core.sparsecheckoutcone")
		.flatMap(([key, value]) => ["-c", value === undefined ? key : `${key}=${value}`]);
}

// Keep NUL-delimited paths as bytes: Git filenames need not be valid UTF-8.
function checkAttributes(args: string[], env: NodeJS.ProcessEnv, paths: Buffer): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const child = spawn("git", [...args, "check-attr", "--cached", "--all", "-z", "--stdin"], { env });
		const output: Buffer[] = [];
		const errors: Buffer[] = [];
		let size = 0;
		let tooLarge = false;
		child.stdout.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_OUTPUT) { tooLarge = true; child.kill(); }
			else output.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => { if (errors.reduce((n, b) => n + b.length, 0) < MAX_OUTPUT) errors.push(chunk); });
		child.stdin.on("error", () => { /* Report the child's exit instead of EPIPE. */ });
		child.on("error", reject);
		child.on("close", (code) => {
			if (tooLarge) reject(new Error("checkout attribute output exceeds 64 MiB"));
			else if (code !== 0) reject(new Error(`git check-attr failed: ${Buffer.concat(errors).toString().trim()}`));
			else resolve(Buffer.concat(output));
		});
		child.stdin.end(paths);
	});
}

function conversionAttributes(output: Buffer): Map<string, { path: string; attr: string; value: string }> {
	const parts: Buffer[] = [];
	let start = 0;
	for (let i = 0; i < output.length; i++) if (output[i] === 0) {
		parts.push(output.subarray(start, i));
		start = i + 1;
	}
	if (start !== output.length || parts.length % 3 !== 0) throw new Error("invalid git check-attr output");
	const result = new Map<string, { path: string; attr: string; value: string }>();
	for (let i = 0; i < parts.length; i += 3) {
		const path = parts[i]!;
		const attr = parts[i + 1]!.toString();
		if (!CONVERSION_ATTRS.has(attr)) continue;
		result.set(`${path.toString("base64")}:${attr}`, { path: path.toString(), attr, value: parts[i + 2]!.toString("base64") });
	}
	return result;
}

/** Populate a registered, no-checkout worktree without trusting any filter configuration. */
export async function checkoutIsolated(path: string, common: string): Promise<void> {
	const [{ stdout: commit }, { stdout: index }, { stdout: format }] = await Promise.all([
		gitIn(path, ["rev-parse", "--verify", "HEAD^{commit}"]),
		gitIn(path, ["rev-parse", "--path-format=absolute", "--git-path", "index"]),
		gitIn(path, ["rev-parse", "--show-object-format"]),
	]);
	const dir = mkdtempSync(join(tmpdir(), "pana-checkout-"));
	try {
		// Git has no wildcard override for filter drivers. An empty private git dir also blocks
		// drivers from included, worktree, global and system config without an enumeration race.
		const env = { ...scrubbedEnv(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1" };
		await run("git", ["init", "--bare", "-q", `--object-format=${format.trim()}`, "--template=", dir], { env });
		const isolatedEnv = { ...env, GIT_OBJECT_DIRECTORY: join(common, "objects"), GIT_INDEX_FILE: index.trim() };
		const actualEnv = { ...scrubbedEnv(), GIT_INDEX_FILE: index.trim() };
		const isolated = ["--git-dir", dir, "--work-tree", path, ...NEUTRAL, "-c", "core.attributesFile=/dev/null", ...await checkoutConfig(path), "-C", path];
		await run("git", [...isolated, "read-tree", commit.trim()], { env: isolatedEnv });
		const { stdout: paths } = await run("git", [...NEUTRAL, "-C", path, "ls-files", "-z"], { env: actualEnv, encoding: "buffer", maxBuffer: MAX_OUTPUT });
		const [actualOutput, isolatedOutput] = await Promise.all([
			checkAttributes([...NEUTRAL, "-C", path], actualEnv, paths),
			checkAttributes(isolated, isolatedEnv, paths),
		]);
		const actual = conversionAttributes(actualOutput);
		const safe = conversionAttributes(isolatedOutput);
		for (const value of actual.values()) if (value.attr === "filter") {
			// Even `-filter` is refused: check-attr prints it identically to filter=unset.
			throw new Error(`checkout filter attribute on ${JSON.stringify(value.path)} cannot run safely; use a trusted adapter`);
		}
		for (const key of new Set([...actual.keys(), ...safe.keys()])) {
			const a = actual.get(key);
			const b = safe.get(key);
			if (a?.value !== b?.value) {
				const value = a ?? b!;
				throw new Error(`checkout attribute ${value.attr} on ${JSON.stringify(value.path)} differs outside the committed tree; use a trusted adapter`);
			}
		}
		await run("git", [...isolated, "read-tree", "--reset", "-u", commit.trim()], { env: isolatedEnv });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
