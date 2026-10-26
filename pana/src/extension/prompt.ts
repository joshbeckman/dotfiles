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
import type { Runtime } from "../server/runtime.ts";

/** `pana/prompt.md`, loaded only by pana. */
export const PROMPT_PATH = fileURLToPath(new URL("../../prompt.md", import.meta.url));

/** Read the prompt template. Reading per render keeps the text deterministic (PRM-04). */
export function promptTemplate(): string {
	return readFileSync(PROMPT_PATH, "utf8");
}

export function fillPrompt(template: string, values: { sessionUrl: string; memoryPath: string; domain: string }): string {
	return template
		.replaceAll("{{session_url}}", values.sessionUrl)
		.replaceAll("{{memory_path}}", values.memoryPath)
		.replaceAll("{{domain}}", values.domain);
}

async function sessionId(runtime: Runtime, conversationId: number): Promise<string | undefined> {
	const row = await runtime.db.get<{ id: string }>("SELECT id FROM sessions WHERE conversation_id = ?", conversationId);
	return row?.id;
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

/** One section: `pana/prompt.md`, filled with this session's URL and memory path (PRM-03). */
export function panaSection(getRuntime: () => Runtime): PromptSection {
	return section("pana", async (input) => {
		const runtime = getRuntime();
		const id = await sessionId(runtime, input.conversationId);
		if (!id) return "This conversation is not a pana session. Do not use the pana tools.";
		return fillPrompt(promptTemplate(), {
			sessionUrl: runtime.url({ kind: "session", id }),
			memoryPath: join(runtime.paths.memoryWorktrees, id),
			domain: runtime.config.domain,
		});
	});
}

/** The pana extension's sections, in prompt order. */
export function createPanaSections(getRuntime: () => Runtime): PromptSection[] {
	return [projectSection(), panaSection(getRuntime)];
}
