import { createHash, randomUUID } from "node:crypto";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ApiError } from "../api/errors.ts";
import type { Handlers, RequestContext } from "../api/types.ts";
import { ConfigError, parseConfig } from "./index.ts";
import { readSourceRevision } from "./source.ts";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
function userOnly(ctx: RequestContext) {
	if (ctx.caller.kind !== "user") throw ApiError.forbidden("only the user can manage pana settings");
}

function snapshot(ctx: RequestContext) {
	const configPath = join(ctx.runtime.paths.dir, "config.json");
	const text = readFileSync(configPath, "utf8");
	let config: unknown = null;
	let configValidationError: string | undefined;
	let configRequiresRestart = true;
	try {
		config = JSON.parse(text);
		configRequiresRestart = !isDeepStrictEqual(parseConfig(config), ctx.runtime.config);
	} catch (error) { configValidationError = (error as Error).message; }
	return {
		config, configText: text, configValidationError, configPath, configRevision: digest(text),
		configRequiresRestart,
		source: readSourceRevision(),
		processes: [{ role: "panad", pid: process.pid, startedAt: ctx.runtime.processInfo?.startedAt ?? null,
			running: ctx.runtime.processInfo?.running ?? null }],
		restartAvailable: !!ctx.runtime.processInfo?.requestRestart,
		restartReason: ctx.runtime.processInfo?.requestRestart ? undefined : "Restart is only available in the panad entrypoint on macOS/Linux with Node execve support.",
	};
}

export const handlers: Handlers = {
	"settings.read": (ctx) => {
		userOnly(ctx);
		return { status: 200, headers: { "cache-control": "no-store" }, body: snapshot(ctx) };
	},
	"settings.update": (ctx) => {
		userOnly(ctx);
		const body = ctx.body as { config?: unknown; configRevision?: unknown } | undefined;
		if (!body || typeof body.configRevision !== "string") {
			throw ApiError.badRequest("invalid_settings", "config and configRevision are required; reload settings before saving");
		}
		let parsed;
		try { parsed = parseConfig(body.config); }
		catch (error) {
			if (error instanceof ConfigError) throw ApiError.badRequest("invalid_config", error.message);
			throw error;
		}
		if (parsed.domain !== ctx.runtime.config.domain || parsed.user !== ctx.runtime.config.user) {
			throw ApiError.badRequest("immutable_identity", "domain and user identify existing data and cannot be changed from settings");
		}
		const path = join(ctx.runtime.paths.dir, "config.json");
		if (digest(readFileSync(path, "utf8")) !== body.configRevision) {
			throw ApiError.stale("config.json changed since settings loaded; reload before saving");
		}
		// Keep unknown keys; write a sibling then rename so a crash cannot truncate config.json.
		const temporary = `${path}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temporary, `${JSON.stringify(body.config, null, "\t")}\n`, { mode: 0o600, flag: "wx" });
			renameSync(temporary, path);
		} finally {
			try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		}
		return { status: 200, headers: { "cache-control": "no-store" }, body: snapshot(ctx) };
	},
	"settings.restart": (ctx) => {
		userOnly(ctx);
		const restart = ctx.runtime.processInfo?.requestRestart;
		if (!restart) throw ApiError.notImplemented("this panad cannot restart itself; use its service manager");
		// Validate the on-disk config first: do not stop a healthy process for invalid config.
		try { parseConfig(JSON.parse(readFileSync(join(ctx.runtime.paths.dir, "config.json"), "utf8"))); }
		catch (error) { throw ApiError.badRequest("invalid_config", `Cannot restart: ${(error as Error).message}`); }
		return { status: 202, headers: { "content-type": "application/json" }, stream: (res) => {
			res.once("finish", restart);
			res.end(JSON.stringify({ restarting: true }));
		} };
	},
};
