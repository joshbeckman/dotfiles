import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Names are derived from the session id rather than drawn fresh, so resuming or
// reloading a session keeps the same name and the same scratchpad instead of
// giving the agent amnesia. Both are injected into the system prompt rather than
// requested via a tool call: the model can't forget to do it, and it costs no turn.
//
// Name and scratchpad live in one extension because the name is the directory
// slug — splitting them would mean duplicating the derivation or exporting state.

const SCRATCH_ROOT = "/tmp/agent";

type NameContext = {
	cwd: string;
	hasUI: boolean;
	ui: { setStatus: (key: string, value: string | undefined) => void; theme: { fg: (color: string, value: string) => string } };
	sessionManager: { getSessionId: () => string | undefined; getSessionFile: () => string | undefined };
};

export default function (pi: ExtensionAPI) {
	let name: string | undefined;
	let scratchpad: string | undefined;

	pi.on("session_start", (_event, ctx: NameContext) => {
		const sessionId = ctx.sessionManager.getSessionId();
		name = generateName(sessionId);
		// Ephemeral runs (pi -p --no-session) get no scratchpad; one-shot prompts
		// would otherwise litter /tmp/agent with dirs nobody reads.
		scratchpad = name && sessionId ? createScratchpad(name, sessionId, ctx) : undefined;
		if (ctx.hasUI) ctx.ui.setStatus("agent-name", name ? ctx.ui.theme.fg("muted", `󰙃 ${name}`) : undefined);
	});

	pi.on("before_agent_start", (event) => {
		if (!name) return;
		const lines = [
			`Your name for this session is ${name}. Use it when you need to identify yourself — in scratch file names, branch names, tmux titles, notifications, or when the user asks who they are talking to. Do not mention it otherwise.`,
		];
		if (scratchpad) {
			lines.push(
				`Your scratchpad for this session is ${scratchpad} (already created, contains session.md). Put working notes, plans, drafts, diffs, and handoff documents there instead of in the repo. It survives across resumes of this session but not across reboots, so nothing durable belongs there.`,
			);
		}
		return { systemPrompt: `${event.systemPrompt}\n\n${lines.join("\n\n")}` };
	});

	pi.on("session_shutdown", (_event, ctx: NameContext) => {
		if (ctx.hasUI) ctx.ui.setStatus("agent-name", undefined);
	});
}

function generateName(sessionId: string | undefined): string | undefined {
	try {
		const args = ["--full"];
		if (sessionId) args.push("--seed", sessionId);
		return execFileSync("random-name", args, { encoding: "utf8", timeout: 2000 }).trim() || undefined;
	} catch {
		return undefined; // random-name lives in dotfiles/bin; absent on machines without it
	}
}

function createScratchpad(name: string, sessionId: string, ctx: NameContext): string | undefined {
	// The slug alone collides across the ~24k name space; the id suffix keeps two
	// live sessions from writing over each other's notes.
	const dir = join(SCRATCH_ROOT, `${name.toLowerCase().replace(/\s+/g, "-")}-${sessionId.slice(0, 8)}`);
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "session.md"),
			[
				`# ${name}`,
				"",
				`- session: ${sessionId}`,
				`- session file: ${ctx.sessionManager.getSessionFile() ?? "(none)"}`,
				`- cwd: ${ctx.cwd}`,
				`- git: ${gitDescribe(ctx.cwd)}`,
				`- started: ${new Date().toISOString()}`,
				"",
			].join("\n"),
			{ flag: "wx" }, // resumed sessions keep the original metadata and any appended notes
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return dir;
		return undefined;
	}
	return dir;
}

function gitDescribe(cwd: string): string {
	try {
		return execFileSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).trim();
	} catch {
		return "(not a git repo)";
	}
}
