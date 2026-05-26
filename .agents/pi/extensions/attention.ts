import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type AttentionEvent = {
	marker?: string;
	title?: string;
	message?: string;
	cwd?: string;
	notify?: boolean;
};

const STATE_DIR = path.join(os.homedir(), ".pi", "agent", "attention");

export default function (pi: ExtensionAPI) {
	pi.events.on("attention:set", (event: AttentionEvent) => {
		setAttention(event);
	});

	pi.events.on("attention:clear", () => {
		clearAttention();
	});

	pi.on("session_shutdown", () => {
		clearAttention();
	});
}

function setAttention(event: AttentionEvent) {
	const pane = process.env.TMUX_PANE;
	if (!process.env.TMUX || !pane) return;

	const cwd = event.cwd || process.cwd();
	const dirname = path.basename(cwd) || "pi";
	const marker = event.marker || "⚠";
	const windowName = `${marker} ${dirname}`;

	snapshotTitle(pane);
	tmux(["rename-window", "-t", pane, windowName]);

	if (event.message) {
		tmux(["display-message", "-t", pane, "-d", "4000", event.message.slice(0, 180)]);
	}

	if (event.notify) {
		notify(event.title || `Pi ${dirname}`, event.message || "Pi needs attention", pane);
	}
}

function clearAttention() {
	const pane = process.env.TMUX_PANE;
	if (!process.env.TMUX || !pane) return;

	const stateFile = statePath(pane);
	if (!fs.existsSync(stateFile)) return;

	const [name = "", auto = "on"] = fs.readFileSync(stateFile, "utf8").split("\n");
	if (name) tmux(["rename-window", "-t", pane, name]);
	if (auto === "on") tmux(["set-window-option", "-t", pane, "automatic-rename", "on"]);
	fs.rmSync(stateFile, { force: true });
}

function snapshotTitle(pane: string) {
	const stateFile = statePath(pane);
	if (fs.existsSync(stateFile)) return;

	fs.mkdirSync(STATE_DIR, { recursive: true });
	const name = tmuxOutput(["display-message", "-t", pane, "-p", "#W"]);
	const auto = tmuxOutput(["show-window-options", "-t", pane, "-v", "automatic-rename"]) || "on";
	fs.writeFileSync(stateFile, `${name}\n${auto}\n`);
}

function statePath(pane: string): string {
	return path.join(STATE_DIR, `${pane.replace(/[^A-Za-z0-9_.-]/g, "_")}.tabtitle`);
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

function notify(title: string, message: string, pane: string) {
	const notifier = commandPath("terminal-notifier");
	if (!notifier) return;

	spawn(notifier, [
		"-title", title,
		"-message", message.slice(0, 180),
		"-sound", "Ping",
		"-group", `pi:${pane}`,
		"-execute", `tmux select-window -t ${pane} 2>/dev/null; tmux select-pane -t ${pane} 2>/dev/null`,
	], { detached: true, stdio: "ignore" }).unref();
}

function commandPath(command: string): string | undefined {
	try {
		return execFileSync("command", ["-v", command], { encoding: "utf8" }).trim();
	} catch {
		try {
			return execFileSync("which", [command], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		} catch {
			return undefined;
		}
	}
}
