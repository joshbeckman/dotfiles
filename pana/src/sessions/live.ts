// UX-12: work in progress, streamed to open windows.
//
// pi-durable commits the running generation's partial answer and each running tool call's
// output to the conversation's `pi.live` document, at most every 100 ms. The session runtime's
// commit listener already sees those commits; `LiveFeed` turns them into `session.live` events.
//
// Two rules keep it cheap at scale (BENCH.md):
// - Nothing is built while no window is subscribed. A window that opens later reads the current
//   state from `GET /sessions/:id` and `GET /threads/:id` instead.
// - Each session publishes at most once per `LIVE_INTERVAL_MS`. The newest state wins; the ones
//   between are dropped, because each event carries the whole state, not a delta.
//
// Events go through the session runtime's FIFO queue, behind the `session.entry` events of the
// same commits, so a window never sees an in-progress block vanish before its committed entry.

import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { LiveDoc, type ConversationId, type EntryId, type LiveState, type TaskId } from "@earendil-works/pi-durable";
import type { Runtime } from "../server/runtime.ts";
import { publish } from "../web/index.ts";

export const LIVE_INTERVAL_MS = 250;

/** The tail of a running tool's output an event carries. The committed result has all of it. */
export const LIVE_OUTPUT_BYTES = 16 * 1024;

export interface LiveBlock {
	type: "thinking" | "text" | "toolCall";
	text?: string;
	name?: string;
	arguments?: unknown;
}

export interface LiveTool {
	callId: string;
	name: string;
	status: "pending" | "running" | "done";
	/** The full arguments: from the assistant entry for a model call, the slot for a nested one. */
	arguments?: unknown;
	output?: string;
	/** Bytes of output dropped before `output`, by pi-durable's bounds or by `LIVE_OUTPUT_BYTES`. */
	droppedBytes?: number;
	/** Runtime-clock milliseconds when the call started running. */
	startedAt?: number;
	parentCallId?: string;
}

export interface LiveView {
	/** Runtime-clock milliseconds when this view was built, so a window can correct for clock skew. */
	at: number;
	/** The partial answer of the generation in progress. */
	generation?: { attempt: number; blocks: LiveBlock[]; retryAt?: number; retryError?: string };
	tools: LiveTool[];
	compacting: boolean;
	/** What the session is doing, in a few words: "thinking", "writing", "running bash". */
	activity: string;
	/** When that activity started, for its elapsed time; absent when unknown. */
	since?: number;
}

export interface SessionLiveEvent {
	kind: "session.live";
	sessionId: string;
	url: string;
	/** `null` once the run is over: the committed entries replace whatever was in progress. */
	live: LiveView | null;
	[detail: string]: unknown;
}

type Enqueue = (job: () => Promise<void>, what: string) => void;

/** Per-session throttle from `pi.live` commits to `session.live` events. */
export class LiveFeed {
	readonly #runtime: Runtime;
	readonly #enqueue: Enqueue;
	readonly #pending = new Map<ConversationId, LiveState | null>();
	readonly #scheduled = new Map<ConversationId, (() => void) | undefined>();
	/** When each conversation last published a non-null view; absent once it published `null`. */
	readonly #last = new Map<ConversationId, number>();
	readonly #sessions = new Map<ConversationId, string | undefined>();
	#closed = false;

	constructor(runtime: Runtime, enqueue: Enqueue) {
		this.#runtime = runtime;
		this.#enqueue = enqueue;
	}

	/** A commit changed a conversation's `pi.live`. Call only while a window is subscribed. */
	note(conversationId: ConversationId, value: LiveState | null): void {
		if (this.#closed) return;
		this.#pending.set(conversationId, value);
		if (this.#scheduled.has(conversationId)) return;
		const { clock } = this.#runtime;
		const wait = (this.#last.get(conversationId) ?? -Infinity) + LIVE_INTERVAL_MS - clock.now();
		if (wait <= 0) {
			this.#scheduled.set(conversationId, undefined);
			this.#enqueue(() => this.#flush(conversationId), "live event");
			return;
		}
		// Not a background timer: a clock may decline those, and this one carries the newest state.
		const cancel = clock.setTimer(() => this.#enqueue(() => this.#flush(conversationId), "live event"), wait, { background: false });
		this.#scheduled.set(conversationId, cancel);
	}

	close(): void {
		this.#closed = true;
		for (const cancel of this.#scheduled.values()) cancel?.();
		this.#scheduled.clear();
		this.#pending.clear();
	}

	async #flush(conversationId: ConversationId): Promise<void> {
		this.#scheduled.delete(conversationId);
		if (!this.#pending.has(conversationId)) return;
		const value = this.#pending.get(conversationId) ?? null;
		this.#pending.delete(conversationId);
		const sessionId = await this.#sessionOf(conversationId);
		if (sessionId === undefined) return;
		const live = await liveView(this.#runtime, conversationId, value);
		if (live === null) {
			// Nothing was in progress, and the window already knows it.
			if (!this.#last.has(conversationId)) return;
			this.#last.delete(conversationId);
		} else {
			this.#last.set(conversationId, this.#runtime.clock.now());
		}
		const event: SessionLiveEvent = { kind: "session.live", sessionId, url: this.#runtime.url({ kind: "session", id: sessionId }), live };
		await publish(this.#runtime, event);
	}

	async #sessionOf(conversationId: ConversationId): Promise<string | undefined> {
		if (this.#sessions.has(conversationId)) return this.#sessions.get(conversationId);
		const row = await this.#runtime.db.get<{ id: string }>("SELECT id FROM sessions WHERE conversation_id = ?", conversationId);
		// A miss is not cached: the session row may commit after its conversation's first commit.
		if (row) this.#sessions.set(conversationId, row.id);
		return row?.id;
	}
}

/** The live view of one session now, for a window that opens mid-run. `null` while idle. */
export async function currentLive(runtime: Runtime, conversationId: number | null): Promise<LiveView | null> {
	if (conversationId === null) return null;
	const value = await runtime.harness.snapshot(LiveDoc, conversationId as ConversationId, ctx);
	return liveView(runtime, conversationId as ConversationId, value ?? null);
}

/** Map `pi.live` to what a window renders. `null` when nothing is in progress. */
export async function liveView(runtime: Runtime, conversationId: ConversationId, value: Readonly<LiveState> | null): Promise<LiveView | null> {
	if (!value) return null;
	const generation = value.generation;
	const slots = value.tools ?? [];
	const nested = value.nestedTools ?? [];
	const compacting = (value.compactions ?? []).some((compaction) => compaction.blocking);
	if (value.run === undefined && generation === undefined && slots.length === 0 && !compacting) return null;

	const tools: LiveTool[] = [];
	const assistants = new Map<number, Map<string, unknown>>();
	for (const slot of slots) {
		const task = slot.taskId === undefined ? undefined : await runtime.harness.getTask(slot.taskId, ctx);
		const input = task?.input as { kind?: string; assistant?: number } | undefined;
		let args: unknown;
		if (input?.kind === "model" && typeof input.assistant === "number") {
			args = (await callArguments(runtime, conversationId, input.assistant, assistants)).get(slot.callId);
		}
		tools.push(toolView(slot, args, task?.startedAt));
	}
	for (const slot of nested) {
		const task = await runtime.harness.getTask(slot.taskId as TaskId, ctx);
		tools.push({ ...toolView(slot, slot.arguments, task?.startedAt), parentCallId: slot.parentCallId });
	}

	const view: LiveView = { at: runtime.clock.now(), tools, compacting, activity: "working" };
	if (generation) {
		const message = generation.message as { content?: unknown } | undefined;
		view.generation = { attempt: generation.attempt, blocks: liveBlocks(message?.content) };
		if (generation.retry) {
			view.generation.retryAt = generation.retry.at;
			view.generation.retryError = generation.retry.error;
		}
	}
	Object.assign(view, activityOf(view));
	return view;
}

function toolView(slot: NonNullable<LiveState["tools"]>[number] | NonNullable<LiveState["nestedTools"]>[number], args: unknown, startedAt: number | undefined): LiveTool {
	const tool: LiveTool = { callId: slot.callId, name: slot.name, status: slot.status };
	if (args !== undefined) tool.arguments = args;
	if (startedAt !== undefined) tool.startedAt = startedAt;
	if (slot.output !== undefined) {
		const tail = tailBytes(slot.output, LIVE_OUTPUT_BYTES);
		tool.output = tail.text;
		const dropped = (slot.droppedBytes ?? 0) + tail.dropped;
		if (dropped > 0) tool.droppedBytes = dropped;
	}
	return tool;
}

/** The arguments of each tool call in one assistant entry, read once per flush. */
async function callArguments(runtime: Runtime, conversationId: ConversationId, entryId: number, cache: Map<number, Map<string, unknown>>): Promise<Map<string, unknown>> {
	const cached = cache.get(entryId);
	if (cached) return cached;
	const calls = new Map<string, unknown>();
	cache.set(entryId, calls);
	const conversation = await runtime.harness.conversation(conversationId, ctx);
	if (!conversation) return calls;
	const page = await conversation.entries({ minEntryId: entryId as EntryId, maxEntryId: entryId as EntryId }, 1, undefined, ctx);
	for (const message of page.items[0]?.model ?? []) {
		const content = (message as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (block?.type === "toolCall" && typeof block.id === "string") calls.set(block.id, block.arguments ?? {});
		}
	}
	return calls;
}

/** The blocks of a partial answer, in order. */
function liveBlocks(content: unknown): LiveBlock[] {
	if (!Array.isArray(content)) return [];
	const blocks: LiveBlock[] = [];
	for (const block of content) {
		if (block?.type === "thinking" && typeof block.thinking === "string") blocks.push({ type: "thinking", text: block.thinking });
		else if (block?.type === "text" && typeof block.text === "string") blocks.push({ type: "text", text: block.text });
		else if (block?.type === "toolCall") blocks.push({ type: "toolCall", name: String(block.name ?? ""), arguments: block.arguments ?? {} });
	}
	return blocks;
}

/** UX-12: the few words the thread's working chip shows, and when that activity started. */
export function activityOf(view: Pick<LiveView, "generation" | "tools" | "compacting">): { activity: string; since?: number } {
	const running = view.tools.filter((tool) => tool.status === "running" && tool.parentCallId === undefined);
	if (running.length > 0) {
		const first = running[0]!;
		const more = running.length > 1 ? ` +${running.length - 1}` : "";
		return { activity: `running ${first.name}${more}`, ...(first.startedAt === undefined ? {} : { since: first.startedAt }) };
	}
	if (view.compacting) return { activity: "compacting" };
	const generation = view.generation;
	if (generation?.retryAt !== undefined) return { activity: "waiting to retry" };
	const last = generation?.blocks.at(-1);
	if (last?.type === "thinking") return { activity: "thinking" };
	if (last?.type === "text") return { activity: "writing" };
	if (last?.type === "toolCall") return { activity: `calling ${last.name}` };
	if (generation) return { activity: "thinking" };
	return { activity: "working" };
}

/** UX-12: what each working session is doing now, for a freshly opened thread's chips. */
export async function liveActivities(runtime: Runtime, sessions: ReadonlyArray<{ id: string; conversationId: number | null }>): Promise<Map<string, Pick<LiveView, "activity" | "since" | "at">>> {
	const out = new Map<string, Pick<LiveView, "activity" | "since" | "at">>();
	for (const session of sessions) {
		const live = await currentLive(runtime, session.conversationId);
		if (!live) continue;
		out.set(session.id, { activity: live.activity, at: live.at, ...(live.since === undefined ? {} : { since: live.since }) });
	}
	return out;
}

/** The last `max` bytes of `text`, cut at a character boundary, and how many bytes were dropped. */
function tailBytes(text: string, max: number): { text: string; dropped: number } {
	const bytes = Buffer.byteLength(text);
	if (bytes <= max) return { text, dropped: 0 };
	const buffer = Buffer.from(text);
	let start = bytes - max;
	// Skip UTF-8 continuation bytes so the tail starts on a whole character.
	while (start < bytes && (buffer[start]! & 0xc0) === 0x80) start++;
	return { text: buffer.subarray(start).toString(), dropped: start };
}
