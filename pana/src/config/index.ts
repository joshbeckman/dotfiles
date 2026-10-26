// Config and state layout (CFG-01..05).

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, closeSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Raised for a fatal config or startup problem, carrying the CLI exit code to use. */
export class ConfigError extends Error {
	readonly exitCode: number;
	constructor(message: string, exitCode: number) {
		super(message);
		this.name = "ConfigError";
		this.exitCode = exitCode;
	}
}

export interface Budget {
	sessionUsd: number;
	domainDailyUsd: number;
}

export interface FileLimits {
	maxBytes: number;
}

export interface HttpConfig {
	port: number;
}

export interface ToolsConfig {
	/** The time limit of a `bash` call that names none of its own (ISO-05). */
	bashTimeoutSec: number;
}

export interface ScratchConfig {
	/** Days a session may sit idle before the sweep removes its scratch (SCR-05). */
	ttlDays: number;
	/** The size all scratch may reach before the sweep removes the longest-idle; none by default. */
	maxTotalMB?: number;
}

export interface Config {
	domain: string;
	user: string;
	timezone: string;
	subjectModel?: string;
	defaultModel?: string;
	spawnDepth: number;
	budget: Budget;
	files: FileLimits;
	http: HttpConfig;
	tools: ToolsConfig;
	scratch: ScratchConfig;
}

export const DEFAULTS = {
	spawnDepth: 3,
	budget: { sessionUsd: 100, domainDailyUsd: 500 },
	files: { maxBytes: 26214400 },
	http: { port: 8766 },
	tools: { bashTimeoutSec: 600 },
	scratch: { ttlDays: 8 },
} as const;

/** The state directory, from `PANA_STATE` or `~/.local/state/pana` (CFG-01). */
export function stateDir(): string {
	const override = process.env.PANA_STATE;
	if (override && override.length > 0) return override;
	return join(homedir(), ".local", "state", "pana");
}

function systemTimezone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	} catch {
		return "UTC";
	}
}

/**
 * Read and validate `config.json` from the state directory (CFG-01..03).
 * Missing `domain` or `user` raises a ConfigError with exit code 2 naming the key.
 */
export function loadConfig(dir = stateDir()): Config {
	const path = join(dir, "config.json");
	if (!existsSync(path)) {
		throw new ConfigError(`config.json not found at ${path}`, 2);
	}
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new ConfigError(`config.json is not valid JSON: ${(error as Error).message}`, 2);
	}
	if (typeof raw !== "object" || raw === null) {
		throw new ConfigError("config.json must be a JSON object", 2);
	}
	const obj = raw as Record<string, unknown>;

	if (typeof obj.domain !== "string" || obj.domain.length === 0) {
		throw new ConfigError("config.json is missing required key: domain", 2);
	}
	if (typeof obj.user !== "string" || obj.user.length === 0) {
		throw new ConfigError("config.json is missing required key: user", 2);
	}

	const budget = (obj.budget ?? {}) as Record<string, unknown>;
	const files = (obj.files ?? {}) as Record<string, unknown>;
	const http = (obj.http ?? {}) as Record<string, unknown>;
	const tools = (obj.tools ?? {}) as Record<string, unknown>;
	const scratch = (obj.scratch ?? {}) as Record<string, unknown>;
	const maxTotalMB = positive(scratch.maxTotalMB, "scratch.maxTotalMB", "megabytes");

	return {
		domain: obj.domain,
		user: obj.user,
		timezone: typeof obj.timezone === "string" ? obj.timezone : systemTimezone(),
		subjectModel: typeof obj.subjectModel === "string" ? obj.subjectModel : undefined,
		defaultModel: typeof obj.defaultModel === "string" ? obj.defaultModel : undefined,
		spawnDepth: typeof obj.spawnDepth === "number" ? obj.spawnDepth : DEFAULTS.spawnDepth,
		budget: {
			sessionUsd: typeof budget.sessionUsd === "number" ? budget.sessionUsd : DEFAULTS.budget.sessionUsd,
			domainDailyUsd:
				typeof budget.domainDailyUsd === "number" ? budget.domainDailyUsd : DEFAULTS.budget.domainDailyUsd,
		},
		files: {
			maxBytes: typeof files.maxBytes === "number" ? files.maxBytes : DEFAULTS.files.maxBytes,
		},
		http: {
			port: typeof http.port === "number" ? http.port : DEFAULTS.http.port,
		},
		tools: {
			bashTimeoutSec: positive(tools.bashTimeoutSec, "tools.bashTimeoutSec") ?? DEFAULTS.tools.bashTimeoutSec,
		},
		scratch: {
			ttlDays: positive(scratch.ttlDays, "scratch.ttlDays", "days") ?? DEFAULTS.scratch.ttlDays,
			...(maxTotalMB === undefined ? {} : { maxTotalMB }),
		},
	};
}

/** A positive number, or undefined when absent. A zero limit would kill every call or every scratch. */
function positive(value: unknown, key: string, unit = "seconds"): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new ConfigError(`config.json ${key} must be a positive number of ${unit}`, 2);
	}
	return value;
}

export interface StatePaths {
	dir: string;
	sqlite: string;
	files: string;
	memoryGit: string;
	memoryWorktrees: string;
	scratch: string;
	profiles: string;
	defaultProfile: string;
	hooks: string;
	webToken: string;
	socket: string;
	pidFile: string;
	log: string;
}

/** Resolve every path pana keeps under the state directory. */
export function statePaths(dir = stateDir()): StatePaths {
	return {
		dir,
		sqlite: join(dir, "pana.sqlite"),
		files: join(dir, "files"),
		memoryGit: join(dir, "memory.git"),
		memoryWorktrees: join(dir, "memory", "worktrees"),
		scratch: join(dir, "scratch"),
		profiles: join(dir, "profiles"),
		defaultProfile: join(dir, "profiles", "default.json"),
		hooks: join(dir, "hooks"),
		webToken: join(dir, "web-token"),
		socket: join(dir, "panad.sock"),
		pidFile: join(dir, "panad.pid"),
		log: join(dir, "panad.log"),
	};
}

/**
 * Create the state layout on first start (CFG-04): `pana.sqlite`, `files/`, `memory.git/`,
 * `memory/worktrees/`, `scratch/`, `profiles/default.json`, `hooks/`, and a `web-token` with mode 0600.
 * Returns the resolved paths. Existing files are left untouched.
 */
export function ensureStateLayout(dir = stateDir()): StatePaths {
	const paths = statePaths(dir);
	mkdirSync(paths.dir, { recursive: true });
	mkdirSync(paths.files, { recursive: true });
	mkdirSync(paths.memoryGit, { recursive: true });
	mkdirSync(paths.memoryWorktrees, { recursive: true });
	mkdirSync(paths.scratch, { recursive: true });
	mkdirSync(paths.profiles, { recursive: true });
	mkdirSync(paths.hooks, { recursive: true });

	if (!existsSync(paths.defaultProfile)) {
		writeFileSync(paths.defaultProfile, `${JSON.stringify({}, null, "\t")}\n`, { mode: 0o644 });
	}
	if (!existsSync(paths.webToken)) {
		writeFileSync(paths.webToken, randomBytes(32).toString("base64url"), { mode: 0o600 });
	}
	if (!existsSync(paths.sqlite)) {
		// Touch the file so the layout is complete before the database adapter opens it.
		closeSync(openSync(paths.sqlite, "a"));
	}
	return paths;
}

/** Read the web token used to authenticate the TCP listener (API-04). */
export function readWebToken(dir = stateDir()): string {
	return readFileSync(statePaths(dir).webToken, "utf8").trim();
}
