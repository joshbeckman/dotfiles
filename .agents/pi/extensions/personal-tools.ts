import { spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

type ContentBlock = { type?: string; text?: string };
type SessionEntry = { type: string; message?: { role?: string; content?: unknown } };

export default function (pi: ExtensionAPI) {
	pi.registerCommand("preview-patch", {
		description: "Preview a commit, staged diff, or working diff as HTML",
		handler: async (args, ctx) => {
			const input = args.trim();
			const result = input === "" || input === "unstaged"
				? run("sh", ["-c", "git diff | preview-patch"], ctx.cwd)
				: input === "staged" || input === "--staged" || input === "cached" || input === "--cached"
					? run("sh", ["-c", "git diff --cached | preview-patch"], ctx.cwd)
					: run("preview-patch", input.split(/\s+/), ctx.cwd);
			notifyResult(ctx, "preview-patch", result);
		},
	});

	pi.registerCommand("preview-md", {
		description: "Preview markdown text, a file, or the last assistant response as HTML",
		handler: async (args, ctx) => {
			const input = args.trim();
			const markdown = input || lastAssistantText(ctx) || "";
			if (!markdown) {
				ctx.ui.notify("No markdown argument or assistant response found", "warning");
				return;
			}
			const result = run("preview-md", [markdown], ctx.cwd);
			notifyResult(ctx, "preview-md", result);
		},
	});

	pi.registerCommand("view-md", {
		description: "View a GitHub issue or pull request with gh view-md",
		handler: async (args, ctx) => {
			const input = args.trim();
			if (!input) {
				ctx.ui.notify("Usage: /view-md <issue-or-pr-url>", "warning");
				return;
			}
			const result = run("gh", ["view-md", ...input.split(/\s+/)], ctx.cwd);
			if (result.status !== 0) {
				notifyResult(ctx, "gh view-md", result);
				return;
			}
			pi.sendMessage({
				customType: "view-md",
				content: result.stdout.trim(),
				display: true,
				details: { args: input },
			});
		},
	});

	pi.registerCommand("proverb", {
		description: "Show a proverb from the local proverb command",
		handler: async (_args, ctx) => {
			const result = run("proverb", [], ctx.cwd);
			if (result.status !== 0) {
				notifyResult(ctx, "proverb", result);
				return;
			}
			pi.sendMessage({
				customType: "proverb",
				content: result.stdout.trim(),
				display: true,
				details: {},
			});
		},
	});
}

function lastAssistantText(ctx: ExtensionCommandContext): string | undefined {
	const branch = ctx.sessionManager.getBranch() as SessionEntry[];
	for (let i = branch.length - 1; i >= 0; i -= 1) {
		const entry = branch[i];
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		const text = extractText(entry.message.content).trim();
		if (text) return text;
	}
	return undefined;
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block: ContentBlock) => block?.type === "text" ? block.text || "" : "")
		.filter(Boolean)
		.join("\n");
}

function run(command: string, args: string[], cwd: string) {
	const result = spawnSync(command, args, { cwd, encoding: "utf8" });
	return {
		status: result.status ?? 1,
		stdout: result.stdout || "",
		stderr: result.stderr || result.error?.message || "",
	};
}

function notifyResult(ctx: ExtensionCommandContext, label: string, result: { status: number; stderr: string }) {
	if (result.status === 0) {
		ctx.ui.notify(`${label} complete`, "info");
	} else {
		ctx.ui.notify(`${label} failed: ${result.stderr.trim()}`, "error");
	}
}
