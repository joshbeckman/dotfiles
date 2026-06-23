import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("compact-and", {
		description: "Compact context, then run the provided prompt",
		handler: async (args, ctx) => {
			const prompt = args.trim();

			if (!prompt) {
				ctx.ui.notify("Usage: /compact-and <prompt>", "error");
				return;
			}

			await ctx.waitForIdle();

			ctx.ui.notify("Compaction started", "info");

			ctx.compact({
				customInstructions: `Preserve context needed for this follow-up request: ${prompt}`,
				onComplete: () => {
					ctx.ui.notify("Compaction completed; sending follow-up", "info");
					pi.sendUserMessage(prompt);
				},
				onError: (error) => {
					ctx.ui.notify(`Compaction failed: ${error.message}`, "error");
				},
			});
		},
	});
}
