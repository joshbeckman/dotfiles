import { deflateSync } from "node:zlib";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// A reasoning model that degenerates streams one thinking block of hundreds of thousands of
// characters, sometimes for a quarter of an hour, with no tool calls and no visible text. The
// provider's own thinking budget does not stop it: on the OpenAI-compatible path that setting
// is injected as a chat-template kwarg, which Fireworks ignores, so the limit has to be
// enforced here, against the stream, or not at all.
//
// The tell is that the block stops carrying information and starts repeating, and a window of
// the text compresses to almost nothing. The threshold is set from measurement rather than
// taste, because both ways of being wrong are expensive: too high and an honest turn is
// aborted, too low and a loop runs for another ten minutes.
//
//   nine recorded runaway blocks (67k to 651k characters)     0.0090 - 0.0134
//   loops whose repeated unit is 100 to 4,000 characters       0.028  - 0.039
//   redundant but legitimate: a file listing, a table, log lines  0.085 - 0.111
//   453 ordinary thinking blocks of 4,096 characters or more    0.272  - 0.552
//
// So 0.05 sits 3.7x above every runaway ever recorded here and 1.7x below the most redundant
// thing an honest block is likely to contain. The three-streak requirement asks for about
// 5,100 contiguous characters below that ratio, which is where the runaways already were.
//
// A loop whose repeated unit is longer than the window shows no repetition inside it and is
// left to MAX_THINKING_CHARS instead, at a cost of a few minutes rather than a lost session.
export const TAIL_WINDOW = 4096;
export const CHECK_EVERY = 512;
export const REPEAT_RATIO = 0.05;
export const REPEAT_STREAK = 3;

// The backstop for a block that degenerates without repeating. The largest ordinary thinking
// block ever recorded here is 39,329 characters, so this is three times the worst honest case,
// and past the 16,384-token budget that `high` thinking nominally asks for, which is as much
// as the guard can know about what a provider intends to allow.
export const MAX_THINKING_CHARS = 120_000;

// Showing the running size is what makes the fault visible before it trips: a status line that
// reads `thinking 45k` is a different signal from a spinner, and it is the one that was
// missing when a looping seat looked busy for thirteen minutes.
export const STATUS_AFTER = 8_192;
export const STATUS_EVERY_MS = 2_000;

export type TripReason = "repetition" | "length";

export interface ThinkingState {
	chars: number;
	tail: string;
	sinceCheck: number;
	streak: number;
	tripped: TripReason | undefined;
}

export function newThinking(): ThinkingState {
	return { chars: 0, tail: "", sinceCheck: 0, streak: 0, tripped: undefined };
}

/** Compressed bytes over UTF-8 bytes: degenerate text approaches zero, ordinary prose sits near 0.4. */
export function compressionRatio(text: string): number {
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes === 0) return 1;
	return deflateSync(text).length / bytes;
}

/** Returns the reason to stop once, then nothing, so a stream that keeps arriving cannot trip twice. */
export function feedThinking(state: ThinkingState, delta: string): TripReason | undefined {
	if (state.tripped) return undefined;

	state.chars += delta.length;
	state.tail += delta;
	if (state.tail.length > TAIL_WINDOW * 2) state.tail = state.tail.slice(-TAIL_WINDOW);
	state.sinceCheck += delta.length;

	if (state.tail.length >= TAIL_WINDOW && state.sinceCheck >= CHECK_EVERY) {
		state.sinceCheck = 0;
		const ratio = compressionRatio(state.tail.slice(-TAIL_WINDOW));
		state.streak = ratio < REPEAT_RATIO ? state.streak + 1 : 0;
		if (state.streak >= REPEAT_STREAK) return (state.tripped = "repetition");
	}

	if (state.chars >= MAX_THINKING_CHARS) return (state.tripped = "length");
	return undefined;
}

export default function (pi: ExtensionAPI) {
	const STATUS_KEY = "thinking-loop-breaker";
	const ENTRY_TYPE = "thinking-loop-breaker";

	let state = newThinking();
	let enabled = true;
	let statusAt = 0;

	// Accounting is per assistant message rather than per thinking block, because a provider is
	// free to start a new block whenever it likes: a counter that reset with each one could be
	// restarted for ever without ever filling.
	pi.on("message_start", () => {
		state = newThinking();
	});

	pi.on("message_update", (event, ctx) => {
		const update = event.assistantMessageEvent;
		if (update?.type !== "thinking_delta" || !enabled) return;

		const reason = feedThinking(state, update.delta);
		if (reason) {
			trip(reason, ctx);
			return;
		}

		if (state.chars < STATUS_AFTER) return;
		const now = Date.now();
		if (now - statusAt < STATUS_EVERY_MS) return;
		statusAt = now;
		ctx.ui.setStatus(STATUS_KEY, `thinking ${Math.round(state.chars / 1_000)}k`);
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message.role === "assistant") clear(ctx);
	});
	pi.on("turn_end", (_event, ctx) => clear(ctx));

	function clear(ctx: ExtensionContext) {
		state = newThinking();
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}

	function trip(reason: TripReason, ctx: ExtensionContext) {
		const chars = state.chars;
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.notify(`Thinking loop broken: ${chars.toLocaleString("en-US")} characters (${reason}). Turn aborted.`, "warning");
		// Recorded before the abort so the post-mortem can find the trips that were caught,
		// not only the ones that got away.
		pi.appendEntry(ENTRY_TYPE, {
			reason,
			chars,
			ratio: Number(compressionRatio(state.tail.slice(-TAIL_WINDOW)).toFixed(4)),
			threshold: REPEAT_RATIO,
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
			thresholdChars: MAX_THINKING_CHARS,
			at: new Date().toISOString(),
		});
		ctx.abort();
	}

	pi.registerCommand("thinking-loop-breaker", {
		description: "Break a runaway thinking block (on|off|limits)",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "off" || arg === "on") {
				enabled = arg === "on";
				ctx.ui.notify(`Thinking loop breaker ${enabled ? "on" : "off"}.`, enabled ? "info" : "warning");
				return;
			}
			if (arg !== "" && arg !== "limits" && arg !== "status") {
				ctx.ui.notify("Usage: /thinking-loop-breaker [on|off|limits]", "warning");
				return;
			}
			ctx.ui.notify(
				`Thinking loop breaker ${enabled ? "on" : "off"}: ${REPEAT_STREAK} windows under ratio ${REPEAT_RATIO} in ` +
					`${TAIL_WINDOW.toLocaleString("en-US")} characters, or ${MAX_THINKING_CHARS.toLocaleString("en-US")} characters in one message.`,
				"info",
			);
		},
	});
}
