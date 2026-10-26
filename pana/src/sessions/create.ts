// Session creation: profiles, model, cwd and worktrees, lineage, and the first thread (SES-01..05,
// LIM-01, LIM-03).
//
// The `sessions` row, with its `conversation_id`, commits before the thread does, because the
// thread's first message wakes the session and the pana extension resolves a session by its
// conversation. The conversation and the row share one transaction. The thread is WP2's
// `createThread`, which opens its own transaction; if it fails, the new session is archived so
// it never shows as a live session without a thread.

import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Extension, ModelRef, ToolRegistration } from "@earendil-works/pi-durable";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { ApiError } from "../api/errors.ts";
import type { Caller } from "../api/types.ts";
import type { Runtime } from "../server/runtime.ts";
import { addressList, createThread, messageBody, type ThreadResult } from "../threads/store.ts";
import { overDomainBudget } from "./budget.ts";
import type { SessionRow } from "./runtime.ts";

const run = promisify(execFile);

export const THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export const DEFAULT_PROFILE = "default";
/** The `cwd` value that asks for a git worktree per session (SES-04). */
export const WORKTREE = "worktree";
/** Always selected: without it a session has no pana tools and no auto-reply. */
const REQUIRED_EXTENSION = "pana";

export interface Profile {
	model?: string;
	thinking?: string;
	extensions?: string[];
	tools?: string[];
	instructions?: string;
	cwd?: string;
}

export interface CreateSessionInput {
	prompt?: unknown;
	model?: unknown;
	thinking?: unknown;
	cwd?: unknown;
	profile?: unknown;
	to?: unknown;
	/** The thread subject; the PWA's Compose form sends it. Default: the prompt's first line. */
	subject?: unknown;
}

function optionalString(value: unknown, field: string): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string") throw ApiError.badRequest(`invalid_${field}`, `${field} must be a string`);
	return value;
}

function stringList(value: unknown, field: string, profile: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw ApiError.badRequest("invalid_profile", `profile ${profile}: ${field} must be a list of names`);
	}
	return value as string[];
}

/** Read `<state>/profiles/<name>.json`. A missing or malformed profile is a 400 (SES-03). */
export function loadProfile(runtime: Runtime, name: string): Profile {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
		throw ApiError.badRequest("unknown_profile", `unknown profile: ${name}`);
	}
	const path = join(runtime.paths.profiles, `${name}.json`);
	if (!existsSync(path)) {
		if (name === DEFAULT_PROFILE) return {};
		throw ApiError.badRequest("unknown_profile", `unknown profile: ${name}`, { profile: name });
	}
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw ApiError.badRequest("invalid_profile", `profile ${name} is not valid JSON: ${(error as Error).message}`);
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw ApiError.badRequest("invalid_profile", `profile ${name} must be a JSON object`);
	}
	const obj = raw as Record<string, unknown>;
	const text = (key: string) => {
		const value = obj[key];
		if (value === undefined) return undefined;
		if (typeof value !== "string") throw ApiError.badRequest("invalid_profile", `profile ${name}: ${key} must be a string`);
		return value;
	};
	return {
		model: text("model"),
		thinking: text("thinking"),
		instructions: text("instructions"),
		cwd: text("cwd"),
		extensions: stringList(obj.extensions, "extensions", name),
		tools: stringList(obj.tools, "tools", name),
	};
}

/** `provider/modelId`, checked against the models panad knows. */
export function parseModel(runtime: Runtime, value: string): ModelRef {
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) {
		throw ApiError.badRequest("invalid_model", `model must be provider/modelId, got ${value}`);
	}
	const ref = { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
	// panad registers only providers whose credentials it has (INT-01), so a missing provider
	// usually means a missing key, not a typo.
	if (!runtime.models.getProvider(ref.provider)) {
		throw ApiError.badRequest(
			"unknown_model",
			`unknown model: ${value}: panad has no ${ref.provider} provider; set its API key in panad's environment`,
			{ model: value },
		);
	}
	if (!runtime.models.getModel(ref.provider, ref.modelId)) {
		throw ApiError.badRequest("unknown_model", `unknown model: ${value}`, { model: value });
	}
	return ref;
}

function parseThinking(value: string): ModelThinkingLevel {
	if (!(THINKING_LEVELS as readonly string[]).includes(value)) {
		throw ApiError.badRequest("invalid_thinking", `thinking must be one of ${THINKING_LEVELS.join(", ")}`);
	}
	return value as ModelThinkingLevel;
}

interface Selection {
	extensions?: Extension[];
	tools?: ToolRegistration[];
}

/** Resolve a profile's extension and tool names against panad's registry. */
function selection(runtime: Runtime, profile: Profile, name: string): Selection {
	const snapshot = runtime.registry.snapshot();
	const out: Selection = {};
	let selected = snapshot.installed();
	if (profile.extensions) {
		const names = profile.extensions.includes(REQUIRED_EXTENSION) ? profile.extensions : [...profile.extensions, REQUIRED_EXTENSION];
		selected = names.map((extensionName) => {
			const extension = snapshot.extension(extensionName);
			if (!extension) throw ApiError.badRequest("unknown_extension", `profile ${name}: unknown extension ${extensionName}`);
			return extension;
		});
		out.extensions = [...selected];
	}
	if (profile.tools) {
		const available = new Map<string, ToolRegistration>();
		for (const extension of selected) for (const tool of extension.tools ?? []) available.set(tool.name, tool);
		out.tools = profile.tools.map((toolName) => {
			const tool = available.get(toolName);
			if (!tool) throw ApiError.badRequest("unknown_tool", `profile ${name}: tool ${toolName} is not in its extensions`);
			return tool;
		});
	}
	return out;
}

function directory(path: string, field: string): string {
	const full = resolve(path);
	let ok = false;
	try {
		ok = statSync(full).isDirectory();
	} catch {
		ok = false;
	}
	if (!ok) throw ApiError.badRequest(`invalid_${field}`, `not a directory: ${path}`);
	return full;
}

/** SES-04: `git worktree add` under `<state>/worktrees/<id>` from the repo at `repo`. */
async function createWorktree(runtime: Runtime, repo: string, id: string): Promise<string> {
	const root = join(runtime.paths.dir, "worktrees");
	mkdirSync(root, { recursive: true });
	const path = join(root, id);
	try {
		await run("git", ["-C", repo, "worktree", "add", "-q", "-b", `pana/${id}`, path, "HEAD"]);
	} catch (error) {
		const stderr = (error as { stderr?: string }).stderr?.trim();
		throw ApiError.badRequest("invalid_cwd", `cannot create a worktree from ${repo}: ${stderr || (error as Error).message}`);
	}
	return path;
}

export interface CreatedSession extends ThreadResult {
	session: SessionRow;
}

export async function createSession(runtime: Runtime, caller: Caller, input: CreateSessionInput): Promise<CreatedSession> {
	const prompt = messageBody(input.prompt);
	const to = addressList(input.to, "recipients");
	const subject = optionalString(input.subject, "subject");
	const profileName = optionalString(input.profile, "profile") ?? DEFAULT_PROFILE;
	const profile = loadProfile(runtime, profileName);

	const modelName = optionalString(input.model, "model") ?? profile.model ?? runtime.config.defaultModel;
	if (modelName === undefined) {
		throw ApiError.badRequest("missing_model", "no model: pass --model, set one in the profile, or set defaultModel");
	}
	const model = parseModel(runtime, modelName);
	const thinkingName = optionalString(input.thinking, "thinking") ?? profile.thinking;
	const thinking = thinkingName === undefined ? undefined : parseThinking(thinkingName);
	const chosen = selection(runtime, profile, profileName);

	let parent: { id: string; depth: number } | undefined;
	if (caller.kind === "session") {
		parent = await runtime.db.get<{ id: string; depth: number }>("SELECT id, depth FROM sessions WHERE id = ?", caller.id);
		if (!parent) throw ApiError.notFound(`session ${caller.id}`);
		// LIM-01: a session at the cap cannot create sessions.
		if (parent.depth >= runtime.config.spawnDepth) {
			throw ApiError.overBudget(`session ${caller.id} is at the spawn depth limit (${runtime.config.spawnDepth})`, {
				reason: "spawn_depth",
				depth: parent.depth,
				spawnDepth: runtime.config.spawnDepth,
			});
		}
	}
	if (await overDomainBudget(runtime.db, runtime)) {
		throw ApiError.overBudget(`the domain is over its daily budget of $${runtime.config.budget.domainDailyUsd}`, { reason: "domain_budget" });
	}

	const id = runtime.newId();
	const cwdFlag = optionalString(input.cwd, "cwd");
	let cwd: string | undefined;
	if (profile.cwd === WORKTREE) {
		if (cwdFlag === undefined) throw ApiError.badRequest("missing_cwd", `profile ${profileName} makes a worktree: pass --cwd REPO`);
		cwd = await createWorktree(runtime, directory(cwdFlag, "cwd"), id);
	} else {
		const dir = cwdFlag ?? profile.cwd;
		// REF-01: with neither a flag nor a profile, the session starts in the panad user's home
		// directory. panad's own working directory belongs to whoever started the service.
		cwd = directory(dir ?? homedir(), "cwd");
	}

	const now = runtime.clock.now();
	const url = runtime.url({ kind: "session", id });
	await runtime.db.atomically(async (tx) => {
		const conversation = await runtime.harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: {
					model,
					...(thinking === undefined ? {} : { thinkingLevel: thinking }),
					...(chosen.extensions ? { extensions: chosen.extensions } : {}),
					...(chosen.tools ? { tools: chosen.tools } : {}),
					...(profile.instructions === undefined ? {} : { instructions: profile.instructions }),
					...(cwd === undefined ? {} : { cwd }),
				},
			},
			ctx,
		);
		await tx.run("INSERT INTO participants (id, kind, url, created_at) VALUES (?, 'session', ?, ?)", id, url, now);
		// `idle` until the first message's wake sets `running`, in the thread's transaction (STA-01).
		await tx.run(
			`INSERT INTO sessions (id, conversation_id, state, parent, depth, model, thinking, profile, cwd, created_at, updated_at)
			 VALUES (?, ?, 'idle', ?, ?, ?, ?, ?, ?, ?, ?)`,
			id,
			conversation.id,
			parent?.id ?? null,
			parent ? parent.depth + 1 : 0,
			`${model.provider}/${model.modelId}`,
			thinking ?? null,
			profileName,
			cwd ?? null,
			now,
			now,
		);
	});

	let thread: ThreadResult;
	try {
		thread = await createThread(runtime, caller, { to: [id, ...to], body: prompt, subject });
	} catch (error) {
		await runtime.db.write((tx) => tx.run("UPDATE sessions SET state = 'archived', updated_at = ? WHERE id = ?", now, id));
		throw error;
	}
	const session = await runtime.db.get<SessionRow>("SELECT * FROM sessions WHERE id = ?", id);
	return { session: session!, ...thread };
}
