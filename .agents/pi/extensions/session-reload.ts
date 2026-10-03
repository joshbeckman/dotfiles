import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// Tools cannot call ctx.reload(): Pi reserves it for command handlers so a
// reload can't deadlock mid-turn. The tool only records the request; once the
// run settles, the command is submitted like typed input. A queued follow-up
// would not work: Pi delivers it to the model as plain text, not a command.
//
// The reloaded runtime is a fresh copy of this extension, so the continuation
// note crosses the swap on a process global rather than in module state.
const PENDING = "__piReloadContinuation";
type Pending = { [PENDING]?: string };

export default function (pi: ExtensionAPI) {
	let requested = false;

	pi.on("agent_settled", () => {
		if (!requested) return;
		requested = false;
		// Pi defers prompts made during settlement until it is idle.
		void pi.sendUserMessage("/reload-session", { expandPromptTemplates: true });
	});

	pi.on("session_start", (event) => {
		const note = (globalThis as Pending)[PENDING];
		if (event.reason !== "reload" || note === undefined) return;
		delete (globalThis as Pending)[PENDING];
		// Deferred so the new runtime finishes starting before the next turn.
		setTimeout(() => pi.sendUserMessage(note), 0);
	});

	pi.registerCommand("reload-session", {
		description: "Reload extensions, skills, prompts, themes, and context files, keeping this session",
		handler: async (_args, ctx) => {
			await ctx.reload();
		},
	});

	pi.registerTool({
		name: "reload_session",
		label: "Reload Session",
		description:
			"Reload this Pi session's extensions, skills, prompts, themes, and context files, the same as Josh typing /reload. " +
			"The transcript, identity, and scratchpad are kept. Use only when Josh asks, or after you changed an extension, " +
			"skill, prompt, or instruction file and need the new version to continue. The reload runs after this turn; " +
			"your continuation note is then sent back to you as the next message, so make it say what to do next.",
		parameters: Type.Object({
			continuation: Type.String({ description: "What to do after the reload, written as an instruction to yourself" }),
		}),
		async execute(_toolCallId, params) {
			(globalThis as Pending)[PENDING] =
				"Reloaded at your request; extensions, skills, and instructions are current. " + params.continuation;
			requested = true;
			return {
				content: [{ type: "text", text: "Reload queued for the end of this turn. End the turn now; your continuation note will arrive next." }],
				details: {},
			};
		},
	});
}
