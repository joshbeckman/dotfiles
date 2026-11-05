// Config and state layout (CFG-01..05).

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, closeSync, openSync, renameSync, unlinkSync } from "node:fs";
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

/** File-path protection and optional filesystem isolation for unowned checkouts. */
export type CheckoutGuard = "guard" | "sandbox" | "off";

export const CHECKOUT_GUARDS: readonly CheckoutGuard[] = ["guard", "sandbox", "off"];

export interface ToolsConfig {
	/** The time limit of a `bash` call that names none of its own (ISO-05). */
	bashTimeoutSec: number;
	/**
	 * `guard` protects file-tool writes and the actual execution cwd, not Bash command text;
	 * `sandbox` additionally mounts unowned checkouts read-only where namespaces are supported;
	 * `off` disables checkout protection. Without a supported sandbox, Bash writes rely on
	 * the instructed worktree workflow rather than a shell-command allowlist.
	 */
	protectCheckouts: CheckoutGuard;
}

export interface ScratchConfig {
	/** Days a session may sit idle before the sweep removes its scratch (SCR-05). */
	ttlDays: number;
	/** The size all scratch may reach before the sweep removes the longest-idle; none by default. */
	maxTotalMB?: number;
}

/**
 * Objective defaults (OBJ-16, OBJ-24, OBJ-18). An objective row overrides any of them per
 * objective; these are what a new objective starts with.
 */
export interface ObjectivesConfig {
	/** OBJ-16: the most member creates one lead run may attempt before the excess is refused. */
	maxMembersPerRun: number;
	/** OBJ-24: the messages an objective's sessions may send the user per local day. */
	maxDailyUserMessages: number;
	/** OBJ-18: the quiet interval between a lead's runs before a held delivery starts one. */
	wakeMinMinutes: number;
}

/** Machine-local integration for repositories with a managed tree lifecycle. No shell evaluation. */
export interface WorktreeAdapter {
	/** Absolute shared git directory (`git rev-parse --git-common-dir`). */
	repo: string;
	/** Absolute directory containing managed trees. */
	root: string;
	/** Checkout directory within each tree, e.g. "src". */
	subdir?: string;
	/** Executable and arguments; placeholders: {name}, {branch}, {path}, {repo}. */
	create: string[];
}

export const USER_COLORS = ["blue", "orange", "purple", "green", "red", "yellow", "black"] as const;
export type UserColor = (typeof USER_COLORS)[number] | `#${string}`;

export function isUserColor(value: unknown): value is UserColor {
	return typeof value === "string" && ((USER_COLORS as readonly string[]).includes(value) || /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value));
}

export interface Config {
	/** Presentation preferences apply immediately after a settings save. */
	ui?: { userColor: UserColor };
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
	objectives: ObjectivesConfig;
	worktreeAdapters?: WorktreeAdapter[];
}

export const DEFAULTS = {
	spawnDepth: 3,
	budget: { sessionUsd: 100, domainDailyUsd: 500 },
	files: { maxBytes: 26214400 },
	http: { port: 8766 },
	tools: { bashTimeoutSec: 600, protectCheckouts: "guard" },
	scratch: { ttlDays: 8 },
	objectives: { maxMembersPerRun: 8, maxDailyUserMessages: 10, wakeMinMinutes: 5 },
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
 * A restart sets `PANA_CONFIG` to the configuration it validated, and reads exactly that file.
 */
export function loadConfig(dir = stateDir()): Config {
	const path = configSnapshotPath() ?? join(dir, "config.json");
	if (!existsSync(path)) {
		throw new ConfigError(`config.json not found at ${path}`, 2);
	}
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new ConfigError(`config.json is not valid JSON: ${(error as Error).message}`, 2);
	}
	return parseConfig(raw);
}

/** Validate the same configuration shape at startup and before a settings save. */
export function parseConfig(raw: unknown): Config {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new ConfigError("config.json must be a JSON object", 2);
	}
	const obj = raw as Record<string, unknown>;

	if (typeof obj.domain !== "string" || obj.domain.length === 0) {
		throw new ConfigError("config.json is missing required key: domain", 2);
	}
	if (typeof obj.user !== "string" || obj.user.length === 0) {
		throw new ConfigError("config.json is missing required key: user", 2);
	}

	for (const key of ["budget", "files", "http", "tools", "scratch", "objectives", "ui"]) {
		if (obj[key] !== undefined && (!obj[key] || typeof obj[key] !== "object" || Array.isArray(obj[key]))) {
			throw new ConfigError(`config.json ${key} must be an object`, 2);
		}
	}
	for (const key of ["timezone", "subjectModel", "defaultModel"]) {
		if (obj[key] !== undefined && (typeof obj[key] !== "string" || !obj[key])) {
			throw new ConfigError(`config.json ${key} must be a nonempty string`, 2);
		}
	}
	if (obj.timezone !== undefined) {
		try { new Intl.DateTimeFormat("en", { timeZone: obj.timezone as string }); }
		catch { throw new ConfigError("config.json timezone must be a valid time zone", 2); }
	}
	const ui = (obj.ui ?? {}) as Record<string, unknown>;
	if (ui.userColor !== undefined && !isUserColor(ui.userColor)) {
		throw new ConfigError("config.json ui.userColor must be a hex color (#RGB, #RGBA, #RRGGBB or #RRGGBBAA) or a legacy palette name", 2);
	}
	const budget = (obj.budget ?? {}) as Record<string, unknown>;
	const files = (obj.files ?? {}) as Record<string, unknown>;
	const http = (obj.http ?? {}) as Record<string, unknown>;
	const tools = (obj.tools ?? {}) as Record<string, unknown>;
	const scratch = (obj.scratch ?? {}) as Record<string, unknown>;
	const objectives = (obj.objectives ?? {}) as Record<string, unknown>;
	const maxTotalMB = positive(scratch.maxTotalMB, "scratch.maxTotalMB", "megabytes");

	return {
		ui: { userColor: (ui.userColor ?? "blue") as UserColor },
		worktreeAdapters: worktreeAdapters(obj.worktreeAdapters),
		domain: obj.domain,
		user: obj.user,
		timezone: typeof obj.timezone === "string" ? obj.timezone : systemTimezone(),
		subjectModel: typeof obj.subjectModel === "string" ? obj.subjectModel : undefined,
		defaultModel: typeof obj.defaultModel === "string" ? obj.defaultModel : undefined,
		spawnDepth: nonnegative(obj.spawnDepth, "spawnDepth", true) ?? DEFAULTS.spawnDepth,
		budget: {
			sessionUsd: nonnegative(budget.sessionUsd, "budget.sessionUsd") ?? DEFAULTS.budget.sessionUsd,
			domainDailyUsd:
				nonnegative(budget.domainDailyUsd, "budget.domainDailyUsd") ?? DEFAULTS.budget.domainDailyUsd,
		},
		files: {
			maxBytes: positive(files.maxBytes, "files.maxBytes", "bytes") ?? DEFAULTS.files.maxBytes,
		},
		http: {
			port: portNumber(http.port) ?? DEFAULTS.http.port,
		},
		tools: {
			bashTimeoutSec: positive(tools.bashTimeoutSec, "tools.bashTimeoutSec") ?? DEFAULTS.tools.bashTimeoutSec,
			protectCheckouts: checkoutGuard(tools.protectCheckouts) ?? DEFAULTS.tools.protectCheckouts,
		},
		scratch: {
			ttlDays: positive(scratch.ttlDays, "scratch.ttlDays", "days") ?? DEFAULTS.scratch.ttlDays,
			...(maxTotalMB === undefined ? {} : { maxTotalMB }),
		},
		objectives: {
			maxMembersPerRun:
				positive(objectives.maxMembersPerRun, "objectives.maxMembersPerRun", "members") ?? DEFAULTS.objectives.maxMembersPerRun,
			maxDailyUserMessages:
				positive(objectives.maxDailyUserMessages, "objectives.maxDailyUserMessages", "messages") ??
				DEFAULTS.objectives.maxDailyUserMessages,
			wakeMinMinutes:
				positive(objectives.wakeMinMinutes, "objectives.wakeMinMinutes", "minutes") ?? DEFAULTS.objectives.wakeMinMinutes,
		},
	};
}

function worktreeAdapters(value: unknown): WorktreeAdapter[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new ConfigError("worktreeAdapters must be an array", 2);
	return value.map((item) => {
		if (!item || typeof item !== "object" ||
			typeof item.repo !== "string" || !item.repo.startsWith("/") ||
			typeof item.root !== "string" || !item.root.startsWith("/") ||
			!Array.isArray(item.create) || item.create.length === 0 ||
			item.create.some((arg: unknown) => typeof arg !== "string" || arg.length === 0) ||
			(item.subdir !== undefined && (typeof item.subdir !== "string" ||
				!item.subdir || item.subdir.startsWith("/") || item.subdir.split("/").some((p: string) => p === "." || p === "..")))) {
			throw new ConfigError("worktreeAdapters entries require absolute repo/root, relative subdir, and nonempty create argv", 2);
		}
		return { repo: item.repo, root: item.root, subdir: item.subdir, create: item.create };
	});
}

/** `tools.protectCheckouts`: a mode name, or a boolean where `true` means the default mode. */
function checkoutGuard(value: unknown): CheckoutGuard | undefined {
	if (value === undefined) return undefined;
	if (value === true) return "guard";
	if (value === false) return "off";
	if (typeof value === "string" && (CHECKOUT_GUARDS as readonly string[]).includes(value)) return value as CheckoutGuard;
	throw new ConfigError(`tools.protectCheckouts must be one of ${CHECKOUT_GUARDS.join(", ")}`, 2);
}

function nonnegative(value: unknown, key: string, integer = false): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) {
		throw new ConfigError(`config.json ${key} must be a nonnegative ${integer ? "integer" : "number"}`, 2);
	}
	return value;
}

function portNumber(value: unknown): number | undefined {
	const port = nonnegative(value, "http.port", true);
	if (port !== undefined && port > 65535) throw new ConfigError("config.json http.port must be between 0 and 65535", 2);
	return port;
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
		webToken: join(dir, "web-token"),
		socket: join(dir, "panad.sock"),
		pidFile: join(dir, "panad.pid"),
		log: join(dir, "panad.log"),
	};
}

/**
 * Create the state layout on first start (CFG-04): `pana.sqlite`, `files/`, `memory.git/`,
 * `memory/worktrees/`, `scratch/`, `profiles/default.json`, and a `web-token` with mode 0600.
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

	if (!existsSync(paths.defaultProfile)) {
		writeFileSync(paths.defaultProfile, `${JSON.stringify({}, null, "\t")}\n`, { mode: 0o644 });
	}
	// CFG-04: install the web token if there is none, and replace a corrupt one, so a bad write
	// can never lock every TCP client out (API-04).
	readWebToken(dir);
	if (!existsSync(paths.sqlite)) {
		// Touch the file so the layout is complete before the database adapter opens it.
		closeSync(openSync(paths.sqlite, "a"));
	}
	return paths;
}

/**
 * Read the token that authenticates the TCP listener (API-04). A missing, empty, or malformed
 * token is regenerated instead of locking every client out; the replacement is written to a
 * sibling and renamed, so a crash or a full disk cannot leave a partial token behind.
 */
export function readWebToken(dir = stateDir()): string {
	const paths = statePaths(dir);
	try {
		const token = readFileSync(paths.webToken, "utf8").trim();
		if (isWebToken(token)) return token;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return writeWebToken(paths.webToken);
}

/** A generated token: 32 random bytes in base64url. 32 characters is the floor we accept. */
export function isWebToken(value: string): boolean {
	return /^[A-Za-z0-9_-]{32,}$/.test(value);
}

function writeWebToken(path: string): string {
	const token = randomBytes(32).toString("base64url");
	if (!isWebToken(token)) throw new Error(`generated web token is not valid: ${JSON.stringify(token)}`);
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, token, { mode: 0o600, flag: "wx" });
		renameSync(temporary, path);
	} finally {
		try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	}
	return token;
}

/**
 * The configuration snapshot a `settings.restart` validated and handed on through `PANA_CONFIG`.
 * Only that start reads it: the path is dropped and the file removed as soon as it is loaded, so
 * a later start, and a service manager's restart, read `config.json` again.
 */
function configSnapshotPath(): string | undefined {
	const override = process.env.PANA_CONFIG;
	return override && override.length > 0 ? override : undefined;
}

/** Consume a restart snapshot after it loaded: forget the path and remove the file. */
export function consumeConfigSnapshot(): void {
	const path = configSnapshotPath();
	if (!path) return;
	delete process.env.PANA_CONFIG;
	try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
