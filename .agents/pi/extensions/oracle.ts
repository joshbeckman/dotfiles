import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

type TextDeltaEvent = {
	type: "message_update";
	assistantMessageEvent?: {
		type?: string;
		delta?: string;
	};
};

const ORACLE_SKILL_PATH = path.join(os.homedir(), ".agents", "skills", "oracle", "SKILL.md");
const DEFAULT_ORACLE_MODEL = "anthropic/claude-opus-4-5";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("oracle", {
		description: "Ask an isolated Oracle sub-session for deep analysis",
		handler: async (args, ctx) => {
			const task = args.trim();
			if (!task) {
				ctx.ui.notify("Usage: /oracle <task>", "warning");
				return;
			}

			ctx.ui.setStatus("oracle", "consulting Oracle...");
			try {
				const answer = await consultOracle(task, ctx);
				pi.sendMessage({
					customType: "oracle",
					content: `## Oracle\n\n${answer.trim()}`,
					display: true,
					details: { task },
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Oracle failed: ${message}`, "error");
			} finally {
				ctx.ui.setStatus("oracle", undefined);
			}
		},
	});
}

async function consultOracle(task: string, ctx: ExtensionCommandContext): Promise<string> {
	const oraclePrompt = readOraclePrompt();
	const loader = new DefaultResourceLoader({
		cwd: ctx.cwd,
		agentDir: getAgentDir(),
		appendSystemPromptOverride: (base) => [...base, oraclePrompt],
	});
	await loader.reload();

	const model = await chooseOracleModel(ctx);
	const { session } = await createAgentSession({
		cwd: ctx.cwd,
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(ctx.cwd),
		model,
		thinkingLevel: "high",
	});

	const chunks: string[] = [];
	const unsubscribe = session.subscribe((event) => {
		if (isTextDeltaEvent(event)) chunks.push(event.assistantMessageEvent.delta ?? "");
	});

	try {
		await session.prompt(buildOracleTask(task));
		return chunks.join("").trim() || "Oracle returned no text.";
	} finally {
		unsubscribe();
		session.dispose();
	}
}

async function chooseOracleModel(ctx: ExtensionCommandContext) {
	const preferred = process.env.PI_ORACLE_MODEL || DEFAULT_ORACLE_MODEL;
	const [provider, ...idParts] = preferred.split("/");
	const id = idParts.join("/");
	const preferredModel = provider && id ? ctx.modelRegistry.find(provider, id) : undefined;

	if (!preferredModel) return ctx.model;

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(preferredModel);
	if (auth.ok && auth.apiKey) return preferredModel;

	if (ctx.hasUI) {
		ctx.ui.notify(`Oracle model ${preferred} unavailable; using current/default model`, "warning");
	}
	return ctx.model;
}

function readOraclePrompt(): string {
	const content = readFileSync(ORACLE_SKILL_PATH, "utf8");
	return stripFrontmatter(content).trim();
}

function stripFrontmatter(content: string): string {
	if (!content.startsWith("---\n")) return content;
	const end = content.indexOf("\n---\n", 4);
	return end === -1 ? content : content.slice(end + "\n---\n".length);
}

function buildOracleTask(task: string): string {
	return [
		"Use Oracle-level analysis for this task.",
		"Investigate with tools as needed, then return a concise but thorough answer.",
		"",
		"<task>",
		task,
		"</task>",
	].join("\n");
}

function isTextDeltaEvent(event: unknown): event is TextDeltaEvent {
	return Boolean(
		event &&
			typeof event === "object" &&
			(event as { type?: unknown }).type === "message_update" &&
			(event as TextDeltaEvent).assistantMessageEvent?.type === "text_delta",
	);
}
