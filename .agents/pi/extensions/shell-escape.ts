import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

type ShellContext = Pick<ExtensionCommandContext, "cwd" | "hasUI" | "ui">;
type ShellResult = { exitCode: number | null; transcript: string; transcriptPath?: string };

const MAX_TRANSCRIPT_CHARS = Number(process.env.PI_SHELL_ESCAPE_MAX_TRANSCRIPT_CHARS ?? 50_000);

export default function shellEscape(pi: ExtensionAPI) {
	pi.registerCommand("shell", {
		description: "Open an interactive shell; exit to return to Pi",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Interactive shell requires the TUI", "warning");
				return;
			}

			const result = await runShell(ctx, args.trim());
			pi.sendMessage({
				customType: "shell-transcript",
				content: formatTranscriptMessage(args.trim(), result),
				display: true,
				details: result,
			});
			ctx.ui.notify(`Shell exited with ${result.exitCode ?? "unknown"}`, result.exitCode === 0 ? "info" : "warning");
		},
	});

	pi.on("user_bash", async (event, ctx) => {
		if (!event.command.trim().match(/^shell(?:\s|$)/)) return;
		if (!ctx.hasUI) {
			return { result: { output: "Interactive shell requires the TUI", exitCode: 1, cancelled: false, truncated: false } };
		}

		const command = event.command.trim().replace(/^shell\s*/, "");
		const result = await runShell(ctx, command);
		const output = formatTranscriptMessage(command, result);
		return {
			result: {
				output,
				exitCode: result.exitCode ?? 1,
				cancelled: false,
				truncated: output.length < result.transcript.length,
				fullOutputPath: result.transcriptPath,
			},
		};
	});
}

async function runShell(ctx: ShellContext, command: string): Promise<ShellResult> {
	return ctx.ui.custom<ShellResult>((tui, _theme, _keybindings, done) => {
		const shell = process.env.SHELL || "/bin/zsh";
		const shellName = path.basename(shell);
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-shell-"));
		const transcriptPath = path.join(tempDir, "transcript.txt");
		const marker = `__PI_SHELL_ESCAPE_${process.pid}_${Date.now()}__`;
		const invocation = shellInvocation(shell, shellName, command, tempDir, marker);

		tui.stop();
		process.stdout.write("\x1b[2J\x1b[H");
		process.stdout.write(`Starting ${shellName}. Exit the shell to return to Pi.\n\n`);

		const result = spawnSync("script", ["-q", transcriptPath, invocation.command, ...invocation.args], {
			cwd: ctx.cwd,
			stdio: "inherit",
			env: {
				...process.env,
				...invocation.env,
				PI_SHELL_ESCAPE: "1",
			},
		});

		const transcript = readTranscript(transcriptPath, marker);
		process.stdout.write("\nReturning to Pi...\n");
		tui.start();
		tui.requestRender(true);
		done({ exitCode: result.status, transcript, transcriptPath });

		return { render: () => [], invalidate: () => {} };
	});
}

function shellInvocation(shell: string, shellName: string, command: string, tempDir: string, marker: string): { command: string; args: string[]; env: Record<string, string> } {
	if (command) return { command: shell, args: shellArgsForCommand(shellName, command), env: {} };
	if (shellName !== "zsh") return { command: shell, args: shellArgsForInteractive(shellName), env: {} };

	const zdotdir = createZshDotdir(tempDir, marker);
	return { command: shell, args: ["-il"], env: { ZDOTDIR: zdotdir } };
}

function createZshDotdir(tempDir: string, marker: string): string {
	const zdotdir = path.join(tempDir, "zdotdir");
	fs.mkdirSync(zdotdir, { recursive: true });
	writeSourceWrapper(zdotdir, ".zshenv", path.join(os.homedir(), ".zshenv"));
	writeSourceWrapper(zdotdir, ".zprofile", path.join(os.homedir(), ".zprofile"));
	writeSourceWrapper(zdotdir, ".zlogin", path.join(os.homedir(), ".zlogin"));
	fs.writeFileSync(path.join(zdotdir, ".zshrc"), `${sourceIfReadable(path.join(os.homedir(), ".zshrc"))}\n${zshTranscriptHooks(marker)}\n`);
	return zdotdir;
}

function writeSourceWrapper(dir: string, name: string, source: string) {
	fs.writeFileSync(path.join(dir, name), `${sourceIfReadable(source)}\n`);
}

function sourceIfReadable(file: string): string {
	return `[[ -r ${zshQuote(file)} ]] && source ${zshQuote(file)}`;
}

function zshTranscriptHooks(marker: string): string {
	const quotedMarker = zshQuote(marker);
	return `
autoload -Uz add-zsh-hook
__pi_shell_escape_preexec() {
  print -r -- "${marker}:START:$1"
}
__pi_shell_escape_precmd() {
  local code=$?
  print -r -- "${marker}:END:$code"
}
add-zsh-hook preexec __pi_shell_escape_preexec
add-zsh-hook precmd __pi_shell_escape_precmd
export PI_SHELL_ESCAPE_MARKER=${quotedMarker}
`;
}

function formatTranscriptMessage(command: string, result: ShellResult): string {
	const title = command ? `$ ${command}` : "interactive shell session";
	const raw = result.transcript.trim() || "[no output]";
	const transcript = truncate(raw, MAX_TRANSCRIPT_CHARS);
	const truncated = transcript.length < raw.length ? `\n\n[full transcript: ${result.transcriptPath}]` : "";
	return [`Shell transcript (${title})`, `exit: ${result.exitCode ?? "unknown"}`, "", transcript, truncated].join("\n").trimEnd();
}

function readTranscript(transcriptPath: string, marker: string): string {
	try {
		const raw = fs.readFileSync(transcriptPath, "utf8");
		return extractMarkedTranscript(raw, marker) || cleanTranscript(raw);
	} catch {
		return "[transcript unavailable]";
	}
}

function extractMarkedTranscript(raw: string, marker: string): string {
	const lines = cleanTranscript(raw).split("\n");
	const startPrefix = `${marker}:START:`;
	const endPrefix = `${marker}:END:`;
	const blocks: string[] = [];
	let current: { command: string; output: string[] } | undefined;

	for (const line of lines) {
		if (line.startsWith(startPrefix)) {
			current = { command: line.slice(startPrefix.length), output: [] };
			continue;
		}
		if (line.startsWith(endPrefix)) {
			if (current && !isShellExit(current.command)) {
				const status = line.slice(endPrefix.length).trim();
				blocks.push(formatCommandBlock(current.command, current.output.join("\n"), status));
			}
			current = undefined;
			continue;
		}
		current?.output.push(line);
	}

	return blocks.join("\n\n").trim();
}

function formatCommandBlock(command: string, output: string, status: string): string {
	const cleanedOutput = cleanCommandOutput(output);
	const statusLine = status && status !== "0" ? `\n[exit: ${status}]` : "";
	return [`$ ${command}`, cleanedOutput, statusLine].filter(Boolean).join("\n");
}

function cleanCommandOutput(output: string): string {
	const lines = output.trim().split("\n");
	while (lines.length > 0 && /^%\s*$/.test(lines[lines.length - 1] ?? "")) lines.pop();
	return lines.join("\n").trim();
}

function isShellExit(command: string): boolean {
	return /^(exit|logout)(?:\s|$)/.test(command.trim());
}

function cleanTranscript(text: string): string {
	return text
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
		.replace(/\n{4,}/g, "\n\n\n")
		.trim();
}

function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} characters]`;
}

function zshQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shellArgsForInteractive(shellName: string): string[] {
	if (shellName === "bash") return ["-l"];
	return [];
}

function shellArgsForCommand(shellName: string, command: string): string[] {
	if (shellName === "zsh" || shellName === "bash") return ["-lic", command];
	return ["-c", command];
}
