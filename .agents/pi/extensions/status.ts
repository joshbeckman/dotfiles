import { execFileSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => updateGitStatus(ctx));
	pi.on("agent_start", (_event, ctx) => updateGitStatus(ctx));
	pi.on("agent_end", (_event, ctx) => updateGitStatus(ctx));
	pi.on("tool_execution_end", (_event, ctx) => updateGitStatus(ctx));
}

function updateGitStatus(ctx: { cwd: string; hasUI: boolean; ui: { setStatus: (key: string, value: string | undefined) => void } }) {
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
