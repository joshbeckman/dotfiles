// The six pana tools (TOL-01..TOL-04). Each one wraps the command of the same name: same
// arguments, same API route, same exit code, with the calling session as `Pana-Caller`.

import type { JsonValue } from "@earendil-works/chord";
import { Type, type TSchema } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { Runtime } from "../server/runtime.ts";
import { commandForTool, runPanaCommand, type CommandOutcome, type CommandParams, type PanaToolName } from "./commands.ts";

/** The value a tool gives programs: the CLI exit code, plus the response body when there is one. */
const resultSchema = Type.Object({
	exitCode: Type.Number(),
	body: Type.Optional(Type.Unknown()),
});

type ToolResultValue = {
	exitCode: number;
	body?: JsonValue;
};

function toToolResult(outcome: CommandOutcome) {
	const value: ToolResultValue = { exitCode: outcome.exitCode };
	if (outcome.body !== undefined) value.body = outcome.body as JsonValue;
	const text = outcome.text === "" ? `exit ${outcome.exitCode}` : outcome.text;
	const output = [{ type: "text" as const, text }];
	if (outcome.exitCode === 0) return { output, structuredOutput: value };
	return {
		output,
		structuredOutput: value,
		isError: true,
		diagnostics: [{ severity: "error" as const, code: "exit_code", message: outcome.message ?? "command failed" }],
	};
}

async function sessionFor(runtime: Runtime, conversationId: number): Promise<string> {
	const row = await runtime.db.get<{ id: string }>("SELECT id FROM sessions WHERE conversation_id = ?", conversationId);
	if (!row) throw new Error(`conversation ${conversationId} is not a pana session`);
	return row.id;
}

function tool(getRuntime: () => Runtime, name: PanaToolName, description: string, parameters: TSchema) {
	const command = commandForTool(name);
	return defineTool({
		name,
		description,
		parameters,
		structuredOutputSchema: resultSchema,
		async execute(args, api) {
			const runtime = getRuntime();
			const caller = await sessionFor(runtime, api.conversationId);
			const outcome = await runPanaCommand(command.command, args as unknown as CommandParams, {
				endpoint: { socketPath: runtime.paths.socket },
				caller,
			});
			return toToolResult(outcome);
		},
	});
}

export function createPanaTools(getRuntime: () => Runtime): ToolRegistration[] {
	return [
		tool(
			getRuntime,
			"pana_reply",
			"Post a message to a thread. `after` must be the newest message you have read in that thread; if the thread moved, the reply is rejected with exit code 3.",
			Type.Object({
				thread: Type.String({ description: "Thread URL or ULID" }),
				after: Type.String({ description: "The newest message you read in this thread, as a URL or ULID" }),
				body: Type.String({ description: "Markdown message body" }),
				cc: Type.Optional(Type.Array(Type.String(), { description: "Participants to add" })),
			}),
		),
		tool(
			getRuntime,
			"pana_thread_read",
			"Read a thread, or one message of it.",
			Type.Object({
				thread: Type.Optional(Type.String({ description: "Thread URL or ULID" })),
				message: Type.Optional(Type.String({ description: "Message URL or ULID; reads just that message" })),
			}),
		),
		tool(
			getRuntime,
			"pana_thread_create",
			"Start a new thread with one or more participants.",
			Type.Object({
				to: Type.Array(Type.String(), { description: "Participants: usernames, session ULIDs, or pana:// URLs" }),
				body: Type.String({ description: "Markdown message body" }),
			}),
		),
		tool(
			getRuntime,
			"pana_session_create",
			"Create a child session with its own thread.",
			Type.Object({
				prompt: Type.String({ description: "The first message to the new session" }),
				model: Type.Optional(Type.String({ description: "provider/modelId override" })),
				thinking: Type.Optional(Type.String({ description: "Thinking level" })),
				cwd: Type.Optional(Type.String({ description: "Working directory" })),
				profile: Type.Optional(Type.String({ description: "Profile name" })),
				to: Type.Optional(Type.Array(Type.String(), { description: "Extra participants on the new thread" })),
			}),
		),
		tool(
			getRuntime,
			"pana_memory_search",
			"Search the domain memory (case-insensitive) and get path, line, and text for each match.",
			Type.Object({ query: Type.String({ description: "Text to search for" }) }),
		),
		tool(
			getRuntime,
			"pana_memory_commit",
			"Commit your memory worktree to `main`. A conflict exits 3 and leaves your commit on your writer branch.",
			Type.Object({ message: Type.String({ description: "Commit message" }) }),
		),
	];
}
