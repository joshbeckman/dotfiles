import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	CustomEditor,
	SettingsManager,
	type ExtensionAPI,
	type KeybindingsManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

type EditorPane = { filePath: string; paneId: string; statusPath: string };

export default function tmuxExternalEditor(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui" || !process.env.TMUX) return;

		const editorCommand = SettingsManager.create(ctx.cwd, undefined, {
			projectTrusted: ctx.isProjectTrusted(),
		}).getExternalEditorCommand();

		ctx.ui.setEditorComponent(
			(tui, theme, keybindings) =>
				new TmuxExternalEditor(tui, theme, keybindings, ctx.cwd, editorCommand, (message, level) =>
					ctx.ui.notify(message, level),
				),
		);
	});
}

class TmuxExternalEditor extends CustomEditor {
	private readonly appTui: TUI;
	private readonly bindings: KeybindingsManager;
	private readonly cwd: string;
	private readonly editorCommand: string;
	private readonly notify: (message: string, level: "info" | "warning") => void;
	private editing = false;

	constructor(
		appTui: TUI,
		theme: Theme,
		bindings: KeybindingsManager,
		cwd: string,
		editorCommand: string,
		notify: (message: string, level: "info" | "warning") => void,
	) {
		super(appTui, theme, bindings);
		this.appTui = appTui;
		this.bindings = bindings;
		this.cwd = cwd;
		this.editorCommand = editorCommand;
		this.notify = notify;
	}

	override handleInput(data: string): void {
		if (!this.bindings.matches(data, "app.editor.external")) {
			super.handleInput(data);
			return;
		}

		if (this.editing) {
			this.notify("External editor is already open", "warning");
			return;
		}

		const pane = openEditorPane(this.cwd, this.editorCommand, this.getText());
		if (typeof pane === "string") {
			this.notify(`Could not open editor pane: ${pane}`, "warning");
			super.handleInput(data);
			return;
		}

		this.editing = true;
		void collectEditorPane(pane)
			.then((result) => {
				if (result.status !== 0) {
					this.notify(`Editor exited with ${result.status ?? "unknown"}`, "warning");
					return;
				}
				this.setText(result.content);
				this.appTui.requestRender();
			})
			.finally(() => {
				this.editing = false;
			});
	}
}

function openEditorPane(cwd: string, editorCommand: string, content: string): EditorPane | string {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-editor-"));
	const filePath = path.join(tempDir, "prompt.md");
	const statusPath = path.join(tempDir, "status");
	const launcherPath = path.join(tempDir, "launch.sh");

	fs.writeFileSync(filePath, content, "utf8");
	fs.writeFileSync(
		launcherPath,
		`#!/bin/sh\n${editorCommand} ${shellQuote(filePath)}\nstatus=$?\nprintf '%s\\n' "$status" > ${shellQuote(statusPath)}\nexit "$status"\n`,
		{ mode: 0o700 },
	);

	const args = ["split-window", "-v", "-l", "50%", "-c", cwd, "-P", "-F", "#{pane_id}"];
	if (process.env.TMUX_PANE) args.push("-t", process.env.TMUX_PANE);
	args.push(shellQuote(launcherPath));

	const result = spawnSync("tmux", args, { encoding: "utf8" });
	if (result.error) return result.error.message;
	if (result.status !== 0) return result.stderr.trim() || `tmux exited with ${result.status}`;
	return { filePath, paneId: result.stdout.trim(), statusPath };
}

async function collectEditorPane(pane: EditorPane): Promise<{ content: string; status: number | null }> {
	while (!fs.existsSync(pane.statusPath) && tmuxPaneExists(pane.paneId)) {
		await new Promise((resolve) => setTimeout(resolve, 100));
	}

	const status = Number.parseInt(readFile(pane.statusPath), 10);
	return {
		content: readFile(pane.filePath).replace(/\n$/, ""),
		status: Number.isNaN(status) ? null : status,
	};
}

function tmuxPaneExists(paneId: string): boolean {
	const result = spawnSync("tmux", ["display-message", "-p", "-t", paneId, "#{pane_id}:#{pane_dead}"], {
		encoding: "utf8",
	});
	return result.stdout.trim() === `${paneId}:0`;
}

function readFile(file: string): string {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return "";
	}
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}
