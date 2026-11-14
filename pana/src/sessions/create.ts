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
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { ApiError } from "../api/errors.ts";
import type { Caller } from "../api/types.ts";
import type { Runtime } from "../server/runtime.ts";
import { addressList, createThread, messageBody, type ThreadResult } from "../threads/store.ts";
import { memberBriefing } from "../objectives/brief.ts";
import { memberCreateGate } from "../objectives/hold.ts";
import { assertObjectiveOpen, objectiveUrl, recordObjectiveEvent } from "../objectives/state.ts";
import { overDomainBudget } from "./budget.ts";
import type { SessionRow } from "./runtime.ts";
import { setSessionState } from "./state.ts";
import { addWorktree } from "../worktrees/index.ts";
import { ensureScratch } from "../scratch/index.ts";
import { MAX_SESSION_COUNT } from "./limits.ts";

export { MAX_SESSION_COUNT };

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
	/** How many sessions to start in the one thread (SES-06). Default 1. */
	count?: unknown;
}

/** The session count a create asks for: a whole number from 1 to `MAX_SESSION_COUNT`. */
function sessionCount(value: unknown): number {
	if (value === undefined || value === null || value === "") return 1;
	const count = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
	if (!Number.isInteger(count) || count < 1) {
		throw ApiError.badRequest("invalid_count", `count must be a whole number of sessions, 1 or more`, { count: String(value) });
	}
	if (count > MAX_SESSION_COUNT) {
		throw ApiError.badRequest("invalid_count", `count must be at most ${MAX_SESSION_COUNT}`, { count, max: MAX_SESSION_COUNT });
	}
	return count;
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

export interface CreatedSession extends ThreadResult {
	/** The first session the create made; kept for callers that start one. */
	session: SessionRow;
	/** Every session the create made, in order, `session` first (SES-06). */
	sessions: SessionRow[];
}

/** Without a flag or profile value, sessions think, so the transcript has reasoning to show. */
export const DEFAULT_THINKING = "medium";

export async function createSession(runtime: Runtime, caller: Caller, input: CreateSessionInput): Promise<CreatedSession> {
	let prompt = messageBody(input.prompt);
	const to = addressList(input.to, "recipients");
	const subject = optionalString(input.subject, "subject");
	const count = sessionCount(input.count);
	const profileName = optionalString(input.profile, "profile") ?? DEFAULT_PROFILE;
	const profile = loadProfile(runtime, profileName);

	const modelName = optionalString(input.model, "model") ?? profile.model ?? runtime.config.defaultModel;
	if (modelName === undefined) {
		throw ApiError.badRequest("missing_model", "no model: pass --model, set one in the profile, or set defaultModel");
	}
	const model = parseModel(runtime, modelName);
	const thinking = parseThinking(optionalString(input.thinking, "thinking") ?? profile.thinking ?? DEFAULT_THINKING);
	const chosen = selection(runtime, profile, profileName);

	let parent: { id: string; depth: number; objective_id: string | null } | undefined;
	// OBJ-16: the per-run member cap needs the run the create belongs to.
	let objectiveRun: string | null = null;
	if (caller.kind === "session") {
		parent = await runtime.db.get<{ id: string; depth: number; objective_id: string | null }>(
			"SELECT id, depth, objective_id FROM sessions WHERE id = ?",
			caller.id,
		);
		if (!parent) throw ApiError.notFound(`session ${caller.id}`);
		if (parent.objective_id !== null) {
			// OBJ-07: a member of a closed objective accepts no member create.
			await assertObjectiveOpen(runtime.db, parent.id);
			// OBJ-13..OBJ-16, OBJ-20, OBJ-21: only the lead creates members, within the roster and
			// per-run caps, and never for a paused objective. A create of N sessions asks the gate
			// for N members, so a batch cannot slip past either cap.
			objectiveRun = (await memberCreateGate(runtime.db, runtime, parent.objective_id, parent.id, count)).run;
			// OBJ-15: a session created for an objective carries the objective URL in its prompt.
			prompt = `Objective: ${objectiveUrl(runtime, parent.objective_id)}\n\n${prompt}`;
		}
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

	// OBJ-11: a member created for an objective carries the charter's scope and guidance after the
	// prompt the lead wrote, so the task reads first and the standing instructions follow. It is
	// text, not a permission: OBJ-12.
	if (parent?.objective_id !== null && parent?.objective_id !== undefined) {
		prompt = `${prompt}\n\n---\n\n${await memberBriefing(runtime, parent.objective_id)}`;
	}

	const cwdFlag = optionalString(input.cwd, "cwd");
	if (profile.cwd === WORKTREE && cwdFlag === undefined) {
		throw ApiError.badRequest("missing_cwd", `profile ${profileName} makes a worktree: pass --cwd REPO`);
	}
	const modelRef = `${model.provider}/${model.modelId}`;
	const now = runtime.clock.now();
	const ids = Array.from({ length: count }, () => runtime.newId());
	// SES-06: sessions started together share a batch id, which keeps them from mailing each other
	// in their thread. A create of one leaves it NULL.
	const batch = count > 1 ? runtime.newId() : null;
	// Directories before the write: a worktree is a git process, not work for the transaction.
	const dirs = new Map<string, string | undefined>();
	for (const id of ids) dirs.set(id, await sessionCwd(runtime, id, profile, cwdFlag));
	await runtime.db.atomically(async (tx) => {
		// SES-06: N sessions share the prompt, model, profile and thread; each keeps its own
		// conversation, scratch or worktree, and row.
		for (const id of ids) {
			const cwd = dirs.get(id);
			const url = runtime.url({ kind: "session", id });
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
				`INSERT INTO sessions (id, conversation_id, state, parent, depth, model, thinking, profile, cwd, objective_id, created_at, updated_at)
				 VALUES (?, ?, 'idle', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				id,
				conversation.id,
				parent?.id ?? null,
				parent ? parent.depth + 1 : 0,
				modelRef,
				thinking ?? null,
				profileName,
				cwd ?? null,
				// OBJ-15: inherited from the parent at create time, the way `depth` is.
				parent?.objective_id ?? null,
				now,
				now,
			);
			// SES-06: the batch row is what keeps these siblings out of each other's delivery.
			if (batch !== null) await tx.run("INSERT INTO session_batches (session_id, batch, created_at) VALUES (?, ?, ?)", id, batch, now);
			if (parent?.objective_id != null) {
				await recordObjectiveEvent(tx, runtime, {
					objectiveId: parent.objective_id,
					kind: "member.created",
					actorId: caller.id,
					detail: { session: parent.id, member: id, run: objectiveRun },
				});
			}
		}
	});

	let thread: ThreadResult;
	try {
		// SES-06: one thread holds every session the create made, so the first message wakes them all
		// and each answers from its own conversation.
		thread = await createThread(runtime, caller, { to: [...ids, ...to], body: prompt, subject });
	} catch (error) {
		// UX-09: the failed create is seen by a window through the same helper as every other state.
		await runtime.db.write(async (tx) => {
			for (const id of ids) await setSessionState(tx, runtime, { sessionId: id, state: "archived" });
		});
		throw error;
	}
	const rows: SessionRow[] = [];
	for (const id of ids) rows.push((await runtime.db.get<SessionRow>("SELECT * FROM sessions WHERE id = ?", id))!);
	return { session: rows[0]!, sessions: rows, ...thread };
}

/** The directory a session starts in: its own worktree, the given directory, or its scratch (SES-04, SCR-02). */
async function sessionCwd(runtime: Runtime, id: string, profile: Profile, cwdFlag: string | undefined): Promise<string | undefined> {
	if (profile.cwd === WORKTREE) return (await addWorktree(runtime, id, { repo: directory(cwdFlag!, "cwd") })).path;
	const dir = cwdFlag ?? profile.cwd;
	// SCR-02: with neither a flag nor a profile, the session starts in its own scratch, which the
	// sweep cleans up; HOME collected every session's stray files. panad's own working directory
	// belongs to whoever started the service.
	return dir === undefined ? ensureScratch(runtime, id) : directory(dir, "cwd");
}
