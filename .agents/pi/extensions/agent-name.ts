import { execFileSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Names are derived from the session id rather than drawn fresh, so resuming or
// reloading a session keeps the same name instead of giving the agent amnesia.
// Injected into the system prompt rather than asked for via a tool call: the
// model can't forget to do it, and it costs no turn.

type NameContext = {
	hasUI: boolean;
	ui: { setStatus: (key: string, value: string | undefined) => void; theme: { fg: (color: string, value: string) => string } };
	sessionManager: { getSessionId: () => string | undefined };
};

export default function (pi: ExtensionAPI) {
	let name: string | undefined;

	pi.on("session_start", (_event, ctx: NameContext) => {
		name = generateName(ctx.sessionManager.getSessionId());
		if (ctx.hasUI) ctx.ui.setStatus("agent-name", name ? ctx.ui.theme.fg("muted", `󰙃 ${name}`) : undefined);
	});

	pi.on("before_agent_start", (event) => {
		if (!name) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\nYour name for this session is ${name}. Use it when you need to identify yourself — in scratch file names, branch names, tmux titles, notifications, or when the user asks who they are talking to. Do not mention it otherwise.`,
		};
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
