// Shared helpers for the pana extension tests (ISO, PRM, TOL, HOK).
//
// A fake panad handler set stands in for WP2/WP3/WP5 until those packages land, so the pana
// tools and the CLI can be compared against the same API route (TOL-02).

import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import {
	defineExtension,
	defineTool,
	type ConversationId,
	type ContextView,
	type Extension,
	type JsonObject,
} from "@earendil-works/pi-durable";
import type { RouteName } from "../../src/api/routes.ts";
import type { Handlers, RequestContext } from "../../src/api/types.ts";
import type { TestPanad } from "../harness/index.ts";

/** One tool call as the model would make it, run through a nested call so tests see structuredOutput. */
export interface ToolOutcome {
	isError: boolean;
	structuredOutput?: unknown;
	diagnostics: unknown;
}

export interface ApiCall {
	route: RouteName;
	body: unknown;
	caller: string;
	params: Record<string, string>;
	query: string;
}

export interface FakeApi {
	/** Overrides keyed by route name; a route without one answers 200 with its params. */
	responses: Record<string, { status: number; body: unknown }>;
	calls: ApiCall[];
	handlers: Handlers;
}

/** Routes the pana tools call, and nothing else. */
const ROUTES: readonly RouteName[] = [
	"threads.respond",
	"threads.read",
	"messages.show",
	"threads.create",
	"sessions.create",
	"memory.search",
	"memory.commit",
];

/** A handler set for the seven routes the pana tools call, recording every request. */
export function fakeApi(responses: Record<string, { status: number; body: unknown }> = {}): FakeApi {
	const calls: ApiCall[] = [];
	const handlers: Handlers = {};
	for (const route of ROUTES) {
		handlers[route] = (request: RequestContext) => {
			calls.push({
				route,
				body: request.body,
				caller: request.caller.url,
				params: request.params,
				query: request.query.toString(),
			});
			const response = responses[route];
			return { status: response?.status ?? 200, body: response?.body ?? { route, params: request.params } };
		};
	}
	return { responses, calls, handlers };
}

/** A tool that runs another pana tool as a nested call, so the test sees its structuredOutput. */
export function captureExtension(): Extension {
	return defineExtension({
		name: "pana-test-capture",
		tools: [
			defineTool({
				name: "capture_pana",
				description: "Run a pana tool as a nested call and return its result for the test.",
				parameters: Type.Object({ tool: Type.String(), args: Type.Record(Type.String(), Type.Unknown()) }),
				async execute(args, api, context) {
					const nested = await api.executeTool(args.tool, args.args as unknown as JsonObject, context);
					const value = JSON.stringify({
						isError: nested.isError,
						structuredOutput: nested.structuredOutput,
						diagnostics: nested.diagnostics,
					});
					return { output: [{ type: "text", text: value }] };
				},
			}),
		],
	});
}

/** Run one tool call in a conversation and return what a program calling the tool would see. */
export async function runTool(t: TestPanad, conversationId: number, tool: string, args: unknown): Promise<ToolOutcome> {
	t.model.append([{ toolCalls: [{ name: "capture_pana", args: { tool, args } as unknown as JsonObject }] }, { text: "done" }]);
	const conversation = await conversationOf(t, conversationId);
	const settled = await (await conversation.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
	if (settled.status !== "done") throw new Error(`run failed: ${JSON.stringify(settled)}`);
	const page = await conversation.entries({ order: "ascending" }, 1000, undefined, ctx);
	const results = page.items.filter((entry) => entry.kind === "pi.tool-result");
	const last = results.at(-1);
	if (!last?.model) throw new Error("no tool result in the transcript");
	const message = last.model[0] as { role: string; content?: { type: string; text?: string }[] };
	const text = message.content?.find((block) => block.type === "text")?.text;
	if (text === undefined) throw new Error("tool result has no text");
	return JSON.parse(text) as ToolOutcome;
}

/** The conversation's active sections, replayed in order from its system entries. */
export function promptSections(view: ContextView): Map<string, string> {
	const sections = new Map<string, string>();
	for (const message of view.messages) {
		const system = message as { role: string; sections?: Record<string, string | null> };
		if (system.role !== "system" || !system.sections) continue;
		for (const [key, value] of Object.entries(system.sections)) {
			if (value === null) sections.delete(key);
			else sections.set(key, value);
		}
	}
	return sections;
}

/** The system prompt as one string, for substring assertions. */
export function promptText(view: ContextView): string {
	return [...promptSections(view).values()].join("\n");
}

/** The conversation handle, or a clear failure when the seed did not create it. */
export async function conversationOf(t: TestPanad, conversationId: number) {
	const conversation = await t.runtime.harness.conversation(conversationId as ConversationId, ctx);
	if (!conversation) throw new Error(`conversation ${conversationId} not found`);
	return conversation;
}

export async function contextOf(t: TestPanad, conversationId: number): Promise<ContextView> {
	const conversation = await conversationOf(t, conversationId);
	return conversation.context(ctx);
}

/** A scripted text-only turn, so a run renders its system prompt and settles. */
export function textTurn(text = "ok"): { text: string } {
	return { text };
}
