import { execFileSync } from "node:child_process";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

type Finding = {
	kind: "path" | "content" | "command";
	label: string;
	detail?: string;
};

const sensitivePathPatterns: Array<[string, RegExp]> = [
	["Claude settings", /(^|\/)\.claude\/settings(\.local)?\.json$/],
	["secrets file", /(^|\/)\.secrets$/],
	["git config", /(^|\/)\.gitconfig$/],
	["work-only agent skill", /(^|\/)\.agents\/skills\/(binks-pr-review|river-session|talent-shopify|worktree-setup)(\/|$)/],
	["work-only agent prompt", /(^|\/)\.agents\/prompts\/quick-demo\.md$/],
];

const sensitiveContentPatterns: Array<[string, RegExp]> = [
	["Shopify domain or identifier", /shopify\.(com|ai|io)|josh\.beckman@shopify\.com|X-Shopify-/i],
	["internal path", /\/opt\/dev|~\/world|~\/\.shopify-build-tmp|~\/\.config\/dev/i],
	["Claude proxy config", /ANTHROPIC_BASE_URL|ANTHROPIC_CUSTOM_HEADERS|apiKeyHelper/],
	["GPG signing key", /^\s*signingkey\s*=/im],
	["credential-shaped value", /\b(bearer|token|api[_-]?key|cookie|session)[\w.-]*\s*[:=]\s*["']?[A-Za-z0-9_./+:-]{20,}/i],
];

const broadStagingCommands = [
	/\bgit\s+add\s+(-A|--all|\.)\b/,
	/\bgit\s+ada\b/,
];

const publishingCommands = [
	/\bgit\s+(commit|c|ci|cm)\b/,
	/\bgit\s+push\b/,
	/\bgt\s+(submit|ship|ss)\b/,
];

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		const root = gitRoot(ctx.cwd);
		if (!root || path.basename(root) !== "dotfiles") return undefined;

		const findings = findingsForToolCall(event, ctx.cwd, root);
		if (findings.length === 0) return undefined;

		const summary = findings.map((finding) => {
			const suffix = finding.detail ? ` — ${finding.detail}` : "";
			return `- ${finding.kind}: ${finding.label}${suffix}`;
		}).join("\n");

		const message = `This operation touches public dotfiles content that may contain private/work data.\n\n${summary}\n\nProceed?`;

		if (!ctx.hasUI) {
			return { block: true, reason: `Dotfiles public-repo guard requires confirmation:\n${summary}` };
		}

		ctx.ui.notify("Dotfiles public-repo guard needs confirmation", "warning");
		pi.events.emit("attention:set", {
			marker: "⚠",
			title: "Pi dotfiles guard",
			message: "Dotfiles public-repo guard needs confirmation",
			cwd: ctx.cwd,
			notify: true,
		});
		try {
			const ok = await ctx.ui.confirm("Dotfiles public-repo guard", message);
			if (!ok) return { block: true, reason: "Blocked by dotfiles public-repo guard" };
		} finally {
			pi.events.emit("attention:clear", {});
		}

		return undefined;
	});
}

function findingsForToolCall(event: { toolName: string; input: unknown }, cwd: string, root: string): Finding[] {
	if (isToolCallEventType("write", event)) {
		return findingsForFileMutation(cwd, root, event.input.path, event.input.content);
	}

	if (isToolCallEventType("edit", event)) {
		return findingsForFileMutation(cwd, root, event.input.path, event.input.newText);
	}

	if (isToolCallEventType("bash", event)) {
		return findingsForBash(cwd, event.input.command);
	}

	return [];
}

function findingsForFileMutation(cwd: string, root: string, rawPath: unknown, rawContent: unknown): Finding[] {
	const findings: Finding[] = [];
	const filePath = typeof rawPath === "string" ? rawPath : "";
	const relativePath = relativeToRoot(cwd, root, filePath);

	for (const [label, pattern] of sensitivePathPatterns) {
		if (pattern.test(relativePath)) findings.push({ kind: "path", label, detail: relativePath });
	}

	if (typeof rawContent === "string") {
		findings.push(...findingsForContent(rawContent, relativePath));
	}

	return dedupeFindings(findings);
}

function findingsForBash(cwd: string, command: string): Finding[] {
	const findings: Finding[] = [];

	if (broadStagingCommands.some((pattern) => pattern.test(command))) {
		const diff = gitOutput(cwd, ["diff", "--"]);
		findings.push(...findingsForContent(diff, "unstaged diff"));
	}

	if (publishingCommands.some((pattern) => pattern.test(command))) {
		const stagedDiff = gitOutput(cwd, ["diff", "--cached", "--"]);
		const lastCommit = gitOutput(cwd, ["show", "--format=", "--no-ext-diff", "--unified=0", "HEAD"]);
		findings.push(...findingsForContent(stagedDiff, "staged diff"));
		if (/\bgit\s+push\b|\bgt\s+(submit|ship|ss)\b/.test(command)) {
			findings.push(...findingsForContent(lastCommit, "last commit"));
		}
	}

	return dedupeFindings(findings);
}

function findingsForContent(content: string, source: string): Finding[] {
	return sensitiveContentPatterns
		.filter(([, pattern]) => pattern.test(content))
		.map(([label]) => ({ kind: "content", label, detail: source }));
}

function gitRoot(cwd: string): string | undefined {
	return gitOutput(cwd, ["rev-parse", "--show-toplevel"])?.trim() || undefined;
}

function gitOutput(cwd: string, args: string[]): string {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	} catch {
		return "";
	}
}

function relativeToRoot(cwd: string, root: string, filePath: string): string {
	const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
	return path.relative(root, absolutePath).split(path.sep).join("/");
}

function dedupeFindings(findings: Finding[]): Finding[] {
	const seen = new Set<string>();
	return findings.filter((finding) => {
		const key = `${finding.kind}:${finding.label}:${finding.detail ?? ""}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}
