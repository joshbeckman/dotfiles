// The pana system prompt sections (PRM-01..PRM-04).
//
// Sections render in this order and stay out of the transcript until their text changes:
// every project `AGENTS.md` from the git root of `cwd` down to `cwd` (root first), then
// `pana/prompt.md` with the session's own URL and memory path. The profile's instructions
// render last because pi-durable renders them as the final `instructions` section.

import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { section, type PromptSection } from "@earendil-works/pi-durable";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS } from "../config/index.ts";
import { scratchPath } from "../scratch/index.ts";
import type { Runtime } from "../server/runtime.ts";

/** `pana/prompt.md`, loaded only by pana. */
export const PROMPT_PATH = fileURLToPath(new URL("../../prompt.md", import.meta.url));

/** Read the prompt template. Reading per render keeps the text deterministic (PRM-04). */
export function promptTemplate(): string {
	return readFileSync(PROMPT_PATH, "utf8");
}

export interface PromptValues {
	sessionUrl: string;
	memoryPath: string;
	domain: string;
	bashTimeoutSec?: number;
	scratchPath?: string;
	scratchTtlDays?: number;
	/** When the sweep removed this session's scratch, and how large it was (SCR-06). */
	scratchRemoved?: { at: number; bytes: number | null };
}

export function fillPrompt(template: string, values: PromptValues): string {
	return template
		.replaceAll("{{session_url}}", values.sessionUrl)
		.replaceAll("{{memory_path}}", values.memoryPath)
		.replaceAll("{{scratch_path}}", values.scratchPath ?? "")
		.replaceAll("{{scratch_ttl_days}}", String(values.scratchTtlDays ?? DEFAULTS.scratch.ttlDays))
		.replaceAll("{{scratch_note}}", values.scratchRemoved ? `\n${scratchNote(values.scratchRemoved)}\n` : "")
		.replaceAll("{{domain}}", values.domain)
		.replaceAll("{{bash_timeout}}", String(values.bashTimeoutSec ?? DEFAULTS.tools.bashTimeoutSec));
}

/**
 * SCR-06. The note is fixed once written, so the section changes, and lands in the transcript,
 * only when a sweep removes the scratch.
 */
export function scratchNote(removed: { at: number; bytes: number | null }): string {
	const when = new Date(removed.at).toISOString().slice(0, 16).replace("T", " ");
	const size = removed.bytes === null ? "" : ` (${formatBytes(removed.bytes)})`;
	return `Pana removed your scratch directory at ${when} UTC${size} while you were idle. Its old files are gone; the directory you have now is new and empty.`;
}

export function formatBytes(bytes: number): string {
	const units = ["B", "KB", "MB", "GB", "TB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${unit === 0 || value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

interface PromptSessionRow {
	id: string;
	scratch_removed_at: number | null;
	scratch_removed_bytes: number | null;
}

async function promptSession(runtime: Runtime, conversationId: number): Promise<PromptSessionRow | undefined> {
	return runtime.db.get<PromptSessionRow>(
		"SELECT id, scratch_removed_at, scratch_removed_bytes FROM sessions WHERE conversation_id = ?",
		conversationId,
	);
}

/**
 * The root of the git work tree containing `cwd`, or undefined outside a repository: the nearest
 * directory, from `cwd` up, holding a `.git` directory or file (a linked worktree has a file).
 *
 * Rejected alternative: `git rev-parse --show-toplevel`. Sections render on every model request,
 * and spawning git there cost panad 13% of its CPU under the bench (BENCH.md). The bash tool's
 * clean environment sets no `GIT_DIR`, so the walk finds the root git would.
 */
async function gitRoot(env: ExecutionEnv | undefined, cwd: string, context: Context): Promise<string | undefined> {
	if (!env) return undefined;
	for (let dir = cwd; ; dir = dirname(dir)) {
		const info = await env.fileInfo(join(dir, ".git"), context);
		if (info.ok) return dir;
		if (dirname(dir) === dir) return undefined;
	}
}

/** `AGENTS.md` from the repo root down to `cwd`, root first; only `cwd/AGENTS.md` outside a repo. */
export async function agentsFiles(env: ExecutionEnv | undefined, cwd: string, context: Context): Promise<string[]> {
	const top = resolve(cwd);
	const root = await gitRoot(env, top, context);
	const dirs: string[] = [];
	if (root === undefined) {
		dirs.push(top);
	} else {
		let dir = top;
		for (;;) {
			dirs.push(dir);
			if (dir === root) break;
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}
	dirs.reverse();

	const files: string[] = [];
	for (const dir of dirs) {
		const path = join(dir, "AGENTS.md");
		if (env) {
			if (await readText(env, path, context)) files.push(path);
		} else {
			try {
				readFileSync(path);
				files.push(path);
			} catch {
				// Missing AGENTS.md: nothing to add.
			}
		}
	}
	return files;
}

async function readText(env: ExecutionEnv, path: string, context: Context): Promise<string | undefined> {
	const result = await env.readTextFile(path, context);
	return result.ok ? result.value : undefined;
}

/** One section: the project's AGENTS.md files, root first. */
export function projectSection(): PromptSection {
	return section("project", async (input, context) => {
		// REF-01: the same home default the session runtime uses.
		const cwd = resolve(input.agent.cwd ?? homedir());
		const files = await agentsFiles(input.env, cwd, context);
		if (files.length === 0) return undefined;
		const parts: string[] = [];
		for (const path of files) {
			const text = input.env ? await readText(input.env, path, context) : readFileSync(path, "utf8");
			if (text === undefined) continue;
			parts.push(`# ${relative(cwd, path) || "AGENTS.md"}\n\n${text.trim()}`);
		}
		return parts.length === 0 ? undefined : parts.join("\n\n");
	});
}

/** One section: `pana/prompt.md`, filled with this session's URL, memory, and scratch paths (PRM-03). */
export function panaSection(getRuntime: () => Runtime): PromptSection {
	return section("pana", async (input) => {
		const runtime = getRuntime();
		const row = await promptSession(runtime, input.conversationId);
		if (!row) return "This conversation is not a pana session. Do not use the pana tools.";
		const id = row.id;
		return fillPrompt(promptTemplate(), {
			sessionUrl: runtime.url({ kind: "session", id }),
			memoryPath: join(runtime.paths.memoryWorktrees, id),
			domain: runtime.config.domain,
			bashTimeoutSec: runtime.config.tools.bashTimeoutSec,
			scratchPath: scratchPath(runtime, id),
			scratchTtlDays: runtime.config.scratch.ttlDays,
			...(row.scratch_removed_at == null ? {} : { scratchRemoved: { at: row.scratch_removed_at, bytes: row.scratch_removed_bytes } }),
		});
	});
}

/** The pana extension's sections, in prompt order. */
export function createPanaSections(getRuntime: () => Runtime): PromptSection[] {
	return [projectSection(), panaSection(getRuntime)];
}
