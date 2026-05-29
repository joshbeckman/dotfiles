import { execFileSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type StatusContext = {
	cwd: string;
	hasUI: boolean;
	ui: {
		setStatus: (key: string, value: string | undefined) => void;
		theme: { fg: (color: string, value: string) => string };
	};
	sessionManager: { getBranch: () => Array<{ timestamp?: string; message?: { timestamp?: number } }> };
};

export default function (pi: ExtensionAPI) {
	let lastActivityAt = Date.now();
	let timer: ReturnType<typeof setInterval> | undefined;

	function markActive(ctx: StatusContext, timestamp = Date.now()) {
		lastActivityAt = Math.max(lastActivityAt, timestamp);
		updateActivityStatus(ctx, lastActivityAt);
	}

	pi.on("session_start", (_event, ctx) => {
		lastActivityAt = latestBranchTimestamp(ctx) ?? Date.now();
		updateActivityStatus(ctx, lastActivityAt);
		updateGitStatus(ctx);
		if (timer) clearInterval(timer);
		if (ctx.hasUI) timer = setInterval(() => updateActivityStatus(ctx, lastActivityAt), 30_000);
	});

	pi.on("input", (_event, ctx) => {
		markActive(ctx);
		return { action: "continue" };
	});
	pi.on("message_end", (event, ctx) => markActive(ctx, messageTimestamp(event.message)));
	pi.on("agent_start", (_event, ctx) => markActive(ctx));
	pi.on("agent_end", (_event, ctx) => {
		markActive(ctx);
		updateGitStatus(ctx);
	});
	pi.on("tool_execution_start", (_event, ctx) => markActive(ctx));
	pi.on("tool_execution_end", (_event, ctx) => {
		markActive(ctx);
		updateGitStatus(ctx);
	});
	pi.on("user_bash", (_event, ctx) => markActive(ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		if (timer) clearInterval(timer);
		timer = undefined;
		if (ctx.hasUI) ctx.ui.setStatus("activity", undefined);
	});
}

function updateActivityStatus(ctx: StatusContext, timestamp: number) {
	if (!ctx.hasUI) return;

	const age = formatAge(Date.now() - timestamp);
	ctx.ui.setStatus("activity", ctx.ui.theme.fg(age.color, `󰥔 ${age.text}`));
}

function formatAge(deltaMs: number): { text: string; color: string } {
	const seconds = Math.max(0, Math.floor(deltaMs / 1000));
	if (seconds < 60) return { text: "now", color: "success" };
	if (seconds < 3600) return { text: `${Math.floor(seconds / 60)}m ago`, color: "success" };
	if (seconds < 86400) return { text: `${Math.floor(seconds / 3600)}h ago`, color: "warning" };
	if (seconds < 604800) return { text: `${Math.floor(seconds / 86400)}d ago`, color: "error" };
	return {
		text: new Date(Date.now() - seconds * 1000).toLocaleDateString("en-US", { month: "short", day: "2-digit" }),
		color: "error",
	};
}

function latestBranchTimestamp(ctx: StatusContext): number | undefined {
	let latest: number | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		const timestamp = entry.message?.timestamp ?? (entry.timestamp ? Date.parse(entry.timestamp) : undefined);
		if (timestamp && (!latest || timestamp > latest)) latest = timestamp;
	}
	return latest;
}

function messageTimestamp(message: unknown): number {
	const timestamp = (message as { timestamp?: number } | undefined)?.timestamp;
	return timestamp && Number.isFinite(timestamp) ? timestamp : Date.now();
}

function updateGitStatus(ctx: StatusContext) {
	if (!ctx.hasUI) return;

	const insideWorkTree = git(ctx.cwd, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
	if (!insideWorkTree) {
		ctx.ui.setStatus("git", undefined);
		return;
	}

	const shortstat = git(ctx.cwd, ["diff", "--shortstat"]).trim();
	const stagedShortstat = git(ctx.cwd, ["diff", "--cached", "--shortstat"]).trim();
	const untracked = countUntracked(ctx.cwd);
	const dirty = summarizeDiff([shortstat, stagedShortstat].filter(Boolean).join(", "), untracked);
	ctx.ui.setStatus("git", dirty ? ` ${dirty}` : undefined);
}

function summarizeDiff(shortstat: string, untracked: number): string {
	const insertions = sumMatches(shortstat, /(\d+) insertion/g);
	const deletions = sumMatches(shortstat, /(\d+) deletion/g);
	const files = sumMatches(shortstat, /(\d+) files? changed/g) + untracked;
	const pieces = [];
	if (files) pieces.push(`${files}f`);
	if (insertions) pieces.push(`+${insertions}`);
	if (deletions) pieces.push(`-${deletions}`);
	if (untracked) pieces.push(`?${untracked}`);
	return pieces.join(" ");
}

function sumMatches(input: string, pattern: RegExp): number {
	let total = 0;
	for (const match of input.matchAll(pattern)) total += Number(match[1]);
	return total;
}

function countUntracked(cwd: string): number {
	return git(cwd, ["status", "--porcelain", "--untracked-files=normal"])
		.split("\n")
		.filter((line) => line.startsWith("?? ")).length;
}

function git(cwd: string, args: string[]): string {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	} catch {
		return "";
	}
}
