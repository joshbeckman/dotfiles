import { execFileSync } from "node:child_process";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type AttentionEvent = {
	marker?: string;
	title?: string;
	message?: string;
	cwd?: string;
	notify?: boolean;
	bell?: boolean;
};

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
			title: pi.getSessionName() || "Pi finished",
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
	const windowName = `${marker} ${attentionTitle(event)}`;

	tmux(["rename-window", "-t", pane, windowName]);
	tmux(["select-pane", "-t", pane, "-T", windowName]);
	if (event.bell !== false) ringBell();

	if (event.message) {
		tmux(["display-message", "-t", pane, "-d", "4000", event.message.slice(0, 180)]);
	}
}

function clearAttention(pi: ExtensionAPI, cwd = process.cwd()) {
	const pane = process.env.TMUX_PANE;
	if (!process.env.TMUX || !pane) return;

	twrename(cwd);
	tmux(["select-pane", "-t", pane, "-T", sessionTitle(pi.getSessionName(), cwd)]);
}

function attentionTitle(event: AttentionEvent): string {
	const title = event.title || firstLine(event.message) || "Pi needs attention";
	return title.replace(/\s+/g, " ").trim().slice(0, 80);
}

function firstLine(text?: string): string | undefined {
	return text?.split("\n").find((line) => line.trim())?.trim();
}

function sessionTitle(name: string | undefined | null, cwd: string): string {
	const dirname = path.basename(cwd) || "pi";
	return name ? `π - ${name} - ${dirname}` : `π - ${dirname}`;
}

function twrename(cwd: string) {
	try {
		execFileSync("twrename", [], { cwd, stdio: "ignore" });
	} catch {
		// Best effort: attention marks must never break agent work.
	}
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
