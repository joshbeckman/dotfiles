import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "retitle_session",
		label: "Retitle Session",
		description: "Rename the current Pi session to match the active task or topic.",
		promptSnippet: "Retitle the current session when its active task or topic changes",
		promptGuidelines: [
			"Call retitle_session near the start of a session and whenever the user's request materially changes the active subtask or topic; do not retitle for routine steps within the same task.",
			"Give retitle_session a concise 3–7 word title for the current work, replacing rather than accumulating prior topics.",
		],
		parameters: Type.Object({
			title: Type.String({ minLength: 1, maxLength: 80, description: "A concise title for the current work" }),
		}),
		async execute(_toolCallId, params) {
			const topic = params.title.trim();
			if (!topic) throw new Error("Session title cannot be blank");

			// AGENT_NAME comes from the naming extension via the process env rather
			// than from the model, which would misremember or re-roll it. Composing
			// here keeps the model's job to "describe the work".
			const agent = process.env.AGENT_NAME;
			const title = agent && !topic.startsWith(agent) ? `${agent} · ${topic}` : topic;

			const previous = pi.getSessionName();
			if (previous !== title) pi.setSessionName(title);

			return {
				content: [{ type: "text", text: previous === title ? `Session title remains: ${title}` : `Session retitled: ${title}` }],
				details: { previous, title },
			};
		},
	});
}
