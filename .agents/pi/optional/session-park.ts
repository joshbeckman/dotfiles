import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// Not auto-loaded: parking stays opt-in until a live pilot is agreed. Enable per
// session with `pi -e ~/.agents/pi/optional/session-park.ts`.
//
// All parking state lives in bin/agent-session so the lease, records, and
// resume checks have one implementation. This extension only reports its own
// process and exposes the park tool.

function agentSession(args: string[], input?: string) {
	const result = spawnSync("agent-session", [...args, "--json"], { encoding: "utf8", input, timeout: 15_000 });
	let output: Record<string, unknown> | undefined;
	try {
		output = result.stdout ? JSON.parse(result.stdout) : undefined;
	} catch {}
	return { status: result.status, output, error: (result.stderr || result.error?.message || "").trim() };
}

export default function (pi: ExtensionAPI) {
	let leased: string | undefined;
	const release = () => {
		if (leased) agentSession(["exited", leased, "--pid", String(process.pid)]);
		leased = undefined;
	};
	process.on("exit", release);

	pi.on("session_start", (_event, ctx) => {
		release();
		// --no-session and subagent children have no transcript to resume.
		const sessionId = ctx.sessionManager.getSessionId();
		if (!ctx.sessionManager.getSessionFile() || !sessionId) return;
		const result = agentSession(["started", sessionId, "--pid", String(process.pid)]);
		if (result.status === 0) leased = sessionId;
		else if (result.status === 3 && ctx.hasUI)
			ctx.ui.notify(`Another Pi process (pid ${result.output?.leaseHolder}) already has this session open. Don't run both.`, "warning");
	});

	pi.on("session_shutdown", release);

	pi.registerTool({
		name: "park_session",
		label: "Park Session",
		description:
			"Gracefully exit this Pi process so it stops using memory, keeping the transcript, identity, scratchpad, and mail. " +
			"The session can be reopened later with its history intact. Before calling: finish or checkpoint your work, " +
			"stop your own background jobs (bg_list, bg_stop), and account for each one here. Do not park if a job must keep " +
			"running for someone else, such as a dev server Josh is using; stay awake instead. Any job you did not stop is " +
			"killed at shutdown. Restart notes are for your judgment after waking and are never replayed automatically.",
		parameters: Type.Object({
			jobs: Type.Array(
				Type.Object({
					command: Type.String(),
					cwd: Type.String(),
					reason: Type.String({ description: "What the job was for" }),
					restart: Type.Boolean({ description: "Whether it will probably be needed after waking" }),
				}),
				{ description: "Background jobs you stopped before parking; [] if none were running" },
			),
			notes: Type.String({ description: "What to check or do first after waking" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const fail = (text: string) => ({ content: [{ type: "text" as const, text }], details: {}, isError: true });
			if (!leased || leased !== ctx.sessionManager.getSessionId()) return fail("This session has no parking lease; it cannot be parked.");
			if (ctx.hasPendingMessages()) return fail("Messages are queued for this session. Handle them before parking.");
			const result = agentSession(["park", leased, "--pid", String(process.pid)], JSON.stringify(params));
			if (result.status !== 0) return fail(`Parking refused: ${result.error}`);
			ctx.shutdown();
			return {
				content: [{ type: "text" as const, text: `Parked. Notes saved to ${result.output?.notes}. Pi exits after this response; keep it to one line.` }],
				details: result.output ?? {},
			};
		},
	});

	pi.registerCommand("park", {
		description: "Ask the agent to stop its jobs, write restart notes, and park this session",
		handler: async (_args, ctx) => {
			if (!ctx.isIdle()) return ctx.ui.notify("Wait for the current turn to finish before parking.", "warning");
			pi.sendUserMessage(
				"Park this session. Checkpoint anything unsaved, list and stop your background jobs, then call park_session with each stopped job and notes for waking. If a job must keep running, don't park; tell me why.",
			);
		},
	});
}
