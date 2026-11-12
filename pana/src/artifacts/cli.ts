import { lstatSync, readdirSync, type Stats } from "node:fs";
import { isAbsolute, join, posix } from "node:path";
import type { CommandParams, CommandSpec } from "../cli/commands.ts";
import { CommandUsageError } from "../cli/args.ts";
import type { FileAttachment } from "../cli/body.ts";
import { renderText } from "../cli/output.ts";
import { sanitizeTerminalText } from "../cli/sanitize.ts";

function text(params: CommandParams, key: string): string {
	const value = params[key];
	return typeof value === "string" ? value : "";
}

/** A URL path segment, decoded; a malformed escape is a usage error, not a crash. */
function decode(segment: string, value: string): string {
	try {
		return decodeURIComponent(segment);
	} catch {
		throw new CommandUsageError(`malformed URL: ${value}`);
	}
}

/**
 * The id at the collection root of a bare ID or a `pana://` URL (ID-02, ART-13). A message URL
 * resolves to its thread for `threads`, so every command accepts both forms.
 */
function segment(value: string, collection: "threads" | "artifacts"): string {
	if (!value.startsWith("pana://")) return value;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new CommandUsageError(`malformed URL: ${value}`);
	}
	const parts = url.pathname.split("/").filter((part) => part.length > 0);
	const index = parts.indexOf(collection);
	const id = index === -1 ? undefined : parts[index + 1];
	if (id === undefined || id.length === 0) throw new CommandUsageError(`expected a ${collection} URL, got ${value}`);
	return decode(id, value);
}

/** An artifact URL's id and optional version seq: `/artifacts/<id>` or `/artifacts/<id>/v/<seq>`. */
function artifactRef(value: string): { id: string; seq?: string } {
	if (!value.startsWith("pana://")) return { id: value };
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new CommandUsageError(`malformed URL: ${value}`);
	}
	const parts = url.pathname.split("/").filter((part) => part.length > 0);
	const index = parts.indexOf("artifacts");
	const id = index === -1 ? undefined : parts[index + 1];
	if (id === undefined || id.length === 0) throw new CommandUsageError(`expected an artifact URL, got ${value}`);
	const rest = parts.slice(index + 2);
	if (rest.length === 0) return { id: decode(id, value) };
	if (rest.length === 2 && rest[0] === "v" && /^\d+$/.test(rest[1]!)) {
		return { id: decode(id, value), seq: rest[1]! };
	}
	throw new CommandUsageError(`expected an artifact URL, got ${value}`);
}

/** The uploaded manifest `uploadBuild` wrote, or an empty one for a direct caller. */
function manifest(params: CommandParams): { path: string; fileId: string }[] {
	const value = text(params, "manifest");
	if (value.length === 0) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new CommandUsageError("invalid artifact manifest");
	}
	return Array.isArray(parsed) ? (parsed as { path: string; fileId: string }[]) : [];
}

/** A manifest path the server will accept, so a doomed build fails before its first upload. */
function relativePath(value: string, what: string): string {
	if (
		value.length === 0 ||
		value.startsWith("/") ||
		value.includes("\\") ||
		value.includes("\0") ||
		/^[a-z]:/i.test(value) ||
		/[?#]/.test(value) ||
		value.split("/").some((part) => part.length === 0 || part === "." || part === "..")
	) {
		throw new CommandUsageError(`${what} must be relative, with no dot segments, query, or fragment`);
	}
	return value;
}

function stat(path: string, what: string): Stats {
	try {
		return lstatSync(path);
	} catch (error) {
		throw new CommandUsageError(`cannot read ${what}: ${(error as Error).message}`);
	}
}

/** ART-16's text: both refs, the preview with its expiry, the entry, and every warning. */
function publishText(value: unknown): string {
	const result = value as
		| {
				artifact?: { url?: unknown };
				version?: { url?: unknown };
				previewUrl?: unknown;
				expiresAt?: unknown;
				entry?: unknown;
				warnings?: unknown;
		  }
		| null
		| undefined;
	const artifactUrl = result?.artifact?.url;
	const versionUrl = result?.version?.url;
	const previewUrl = result?.previewUrl;
	if (typeof artifactUrl !== "string" || typeof versionUrl !== "string" || typeof previewUrl !== "string") {
		return renderText(value);
	}
	const lines = [`artifact: ${sanitizeTerminalText(artifactUrl)}`, `version: ${sanitizeTerminalText(versionUrl)}`];
	lines.push(`preview: ${sanitizeTerminalText(previewUrl)}`);
	const expiresAt = result?.expiresAt;
	if (typeof expiresAt === "number" && Number.isFinite(expiresAt)) lines.push(`expires: ${new Date(expiresAt).toISOString()}`);
	if (typeof result?.entry === "string") lines.push(`entry: ${sanitizeTerminalText(result.entry)}`);
	const warnings = Array.isArray(result?.warnings) ? result.warnings.filter((warning) => typeof warning === "string") : [];
	if (warnings.length === 0) lines.push("warnings: none");
	else lines.push("warnings:", ...warnings.map((warning) => `  - ${sanitizeTerminalText(warning)}`));
	return `${lines.join("\n")}\n`;
}

export const ARTIFACT_COMMANDS: readonly CommandSpec[] = [
	{
		path: ["artifact", "publish"],
		usage: "pana artifact publish THREAD --dir PATH --name NAME [--entry FILE] [--note TEXT]",
		summary: "Publish an immutable build; use relative asset URLs, never /assets paths",
		positionals: [{ name: "THREAD", param: "thread", required: true }],
		flags: [
			{ name: "dir", syntax: "--dir PATH", type: "string", required: true, description: "Relative build directory; no symlinks" },
			{ name: "name", syntax: "--name NAME", type: "string", required: true, description: "Artifact name within the thread" },
			{ name: "entry", syntax: "--entry FILE", type: "string", description: "Relative entry file (default index.html)" },
			{ name: "note", syntax: "--note TEXT", type: "string", description: "Version note" },
		],
		request: (params) => ({
			method: "POST",
			path: `/threads/${encodeURIComponent(segment(text(params, "thread"), "threads"))}/artifacts/${encodeURIComponent(text(params, "name"))}`,
			body: {
				entry: text(params, "entry") || "index.html",
				note: text(params, "note") || undefined,
				files: manifest(params),
			},
		}),
		uploadsBuild: uploadBuild,
		formatText: publishText,
	},
	{
		path: ["artifact", "list"],
		usage: "pana artifact list THREAD",
		summary: "List a thread's builds",
		flags: [],
		positionals: [{ name: "THREAD", param: "thread", required: true }],
		request: (params) => ({
			method: "GET",
			path: `/threads/${encodeURIComponent(segment(text(params, "thread"), "threads"))}/artifacts`,
		}),
	},
	{
		path: ["artifact", "show"],
		usage: "pana artifact show ARTIFACT",
		summary: "Show immutable versions and a fresh preview",
		flags: [],
		positionals: [{ name: "ARTIFACT", param: "artifact", required: true }],
		request: (params) => {
			const ref = artifactRef(text(params, "artifact"));
			return {
				method: "GET",
				path: `/artifacts/${encodeURIComponent(ref.id)}`,
				query: ref.seq === undefined ? undefined : { seq: ref.seq },
			};
		},
	},
];

/**
 * Validate and upload one build (ART-02): every input path is checked before the first upload,
 * so a symlink, an absolute path, or a bad manifest path never spends an upload. The daemon
 * receives only uploaded file ids and manifest paths.
 */
export async function uploadBuild(
	params: CommandParams,
	upload: (path: string) => Promise<FileAttachment>,
): Promise<void> {
	const dir = text(params, "dir");
	const entry = relativePath(text(params, "entry") || "index.html", "--entry");
	if (!dir || isAbsolute(dir) || /^[a-z]:[\\/]/i.test(dir)) throw new CommandUsageError("--dir must be a relative path");
	// Check every ancestor too: a symlink outside the final subtree is still a symlink input.
	let ancestor = "";
	for (const part of dir.split("/")) {
		ancestor = join(ancestor, part);
		if (stat(ancestor, "--dir").isSymbolicLink()) throw new CommandUsageError("artifact builds cannot contain symlinks");
	}
	if (!stat(dir, "--dir").isDirectory()) throw new CommandUsageError("--dir must be a directory");
	const files: { path: string; absolute: string }[] = [];
	function walk(local: string, relative: string): void {
		const info = stat(local, "--dir");
		if (info.isSymbolicLink()) throw new CommandUsageError("artifact builds cannot contain symlinks");
		if (info.isDirectory()) {
			let names: string[];
			try {
				names = readdirSync(local).sort();
			} catch (error) {
				throw new CommandUsageError(`cannot read ${local}: ${(error as Error).message}`);
			}
			for (const name of names) walk(join(local, name), posix.join(relative, name));
			return;
		}
		if (!info.isFile()) throw new CommandUsageError("artifact builds contain only regular files");
		files.push({ path: relativePath(relative, "build file"), absolute: local });
	}
	walk(dir, "");
	if (files.length === 0) throw new CommandUsageError("artifact build is empty");
	files.sort((a, b) => a.path.localeCompare(b.path));
	if (files.some((file, index) => index > 0 && file.path === files[index - 1]!.path)) {
		throw new CommandUsageError("artifact build has duplicate paths");
	}
	if (!files.some((file) => file.path === entry)) throw new CommandUsageError("entry is not in the build");
	const uploaded: { path: string; fileId: string }[] = [];
	for (const file of files) uploaded.push({ path: file.path, fileId: (await upload(file.absolute)).id });
	params.manifest = JSON.stringify(uploaded);
}
