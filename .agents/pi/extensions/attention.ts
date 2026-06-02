import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type AttentionEvent = {
	marker?: string;
	title?: string;
	message?: string;
	cwd?: string;
	notify?: boolean;
	bell?: boolean;
};

const STATE_DIR = path.join(os.homedir(), ".pi", "agent", "attention");

export default function (pi: ExtensionAPI) {
	pi.events.on("attention:set", (event: AttentionEvent) => {
		setAttention(event);
	});

	pi.events.on("attention:clear", (event?: AttentionEvent) => {
		clearAttention(pi, event?.cwd);
	});

	pi.on("agent_start", (_event, ctx) => {
		clearAttention(pi, ctx.cwd);
	});

	pi.on("agent_end", (_event, ctx) => {
		setAttention({
			marker: "✓",
			title: finishedTitle(pi, ctx),
			message: "Pi finished and is waiting for input",
			cwd: ctx.cwd,
		});
	});

	pi.on("session_shutdown", (_event, ctx) => {
		clearAttention(pi, ctx.cwd);
	});
}

function setAttention(event: AttentionEvent) {
	const pane = process.env.TMUX_PANE;
	if (!process.env.TMUX || !pane) return;

	const marker = event.marker || "⚠";
	const paneTitle = `${marker} ${attentionTitle(event)}`;

	snapshotPaneTitle(pane);
	tmux(["select-pane", "-t", pane, "-T", paneTitle]);
	if (event.bell !== false) ringBell();

	if (event.message) {
		tmux(["display-message", "-t", pane, "-d", "4000", event.message.slice(0, 180)]);
	}
}

function clearAttention(_pi: ExtensionAPI, _cwd = process.cwd()) {
	const pane = process.env.TMUX_PANE;
	if (!process.env.TMUX || !pane) return;

	const stateFile = statePath(pane);
	if (!fs.existsSync(stateFile)) return;

	const paneTitle = fs.readFileSync(stateFile, "utf8");
	tmux(["select-pane", "-t", pane, "-T", paneTitle]);
	fs.rmSync(stateFile, { force: true });
}

function attentionTitle(event: AttentionEvent): string {
	const title = event.title || firstLine(event.message) || "Pi needs attention";
	return title.replace(/\s+/g, " ").trim().slice(0, 80);
}

function firstLine(text?: string): string | undefined {
	return text?.split("\n").find((line) => line.trim())?.trim();
}

function snapshotPaneTitle(pane: string) {
	const stateFile = statePath(pane);
	if (fs.existsSync(stateFile)) return;

	fs.mkdirSync(STATE_DIR, { recursive: true });
	fs.writeFileSync(stateFile, tmuxOutput(["display-message", "-t", pane, "-p", "#{pane_title}"]));
}

function statePath(pane: string): string {
	return path.join(STATE_DIR, `${pane.replace(/[^A-Za-z0-9_.-]/g, "_")}.panetitle`);
}

function finishedTitle(pi: ExtensionAPI, ctx: ExtensionContext): string {
	return pi.getSessionName() || latestSubstantiveUserRequest(ctx) || path.basename(ctx.cwd) || "Pi finished";
}

function latestSubstantiveUserRequest(ctx: ExtensionContext): string | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index] as any;
		if (entry.type !== "message" || entry.message?.role !== "user") continue;
		const title = requestTitle(extractText(entry.message.content));
		if (title && !isContinuation(title)) return title;
	}
	return undefined;
}

function requestTitle(text: string): string | undefined {
	const line = text
		.split("\n")
		.map((part) => part.trim())
		.find((part) => part && !part.startsWith("```") && !part.startsWith("<"));
	if (!line) return undefined;
	return line.replace(/^[-*]\s+/, "").replace(/\s+/g, " ").slice(0, 80);
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.filter((item: any) => item.type === "text" && item.text)
		.map((item: any) => item.text)
		.join("\n")
		.trim();
}

function isContinuation(text: string): boolean {
	return /^(go on|continue|yes|yes please|yep|ok|okay|sure|do it|sounds good)[.!?\s]*$/i.test(text);
}

function ringBell() {
	process.stdout.write("\u0007");
}

function tmux(args: string[]) {
	try {
		execFileSync("tmux", args, { stdio: "ignore" });
	} catch {
		// Best effort: attention marks must never break agent work.
	}
}

function tmuxOutput(args: string[]): string {
	try {
		return execFileSync("tmux", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return "";
	}
}
