// Keyboard handling for the PWA (UX-02, UX-08). The keymap is data: the key handler and the help
// overlay both read it, so the overlay lists exactly what the keys do. Nothing here touches the
// DOM, so Node tests drive it with plain event objects.

/** Bindings that work outside text inputs. Each sequence is a list of `KeyboardEvent.key` values. */
export const KEYMAP = [
	{ action: "next", sequences: [["j"]], description: "Select the next row or message" },
	{ action: "previous", sequences: [["k"]], description: "Select the previous row or message" },
	{ action: "open", sequences: [["Enter"], ["o"]], description: "Open the selection" },
	{ action: "go:inbox", sequences: [["g", "i"]], description: "Go to Inbox" },
	{ action: "go:threads", sequences: [["g", "t"]], description: "Go to Threads" },
	{ action: "go:sessions", sequences: [["g", "s"]], description: "Go to Sessions" },
	{ action: "go:memory", sequences: [["g", "m"]], description: "Go to Memory" },
	{ action: "go:compose", sequences: [["g", "c"]], description: "New thread" },
	{ action: "go:schedules", sequences: [["g", "h"]], description: "Go to Schedules" },
	{ action: "search", sequences: [["/"]], description: "Focus search" },
	{ action: "reply", sequences: [["r"]], description: "Focus the reply box" },
	{ action: "archive", sequences: [["e"]], description: "Archive the open or selected thread" },
	{ action: "back", sequences: [["u"], ["Escape"]], description: "Go back" },
	{ action: "help", sequences: [["?"]], description: "Show or hide this help" },
];

/** Bindings that work inside text inputs. `Mod` is Cmd on macOS and Ctrl elsewhere. */
export const INPUT_KEYMAP = [
	{ action: "submit", sequences: [["Mod+Enter"]], description: "Submit the form" },
	{ action: "leave-input", sequences: [["Escape"]], description: "Leave the text input" },
];

/** How long a prefix such as `g` waits for its second key, in milliseconds. */
export const SEQUENCE_TIMEOUT = 1500;

const TEXT_INPUT_TYPES = new Set(["", "text", "search", "email", "url", "tel", "password", "number", "date", "datetime-local", "time", "month", "week"]);

/** True for an element that takes typed text, where single keys must stay letters. */
export function isTextInput(element) {
	if (!element) return false;
	if (element.isContentEditable) return true;
	const tag = String(element.tagName ?? "").toUpperCase();
	if (tag === "TEXTAREA" || tag === "SELECT") return true;
	if (tag !== "INPUT") return false;
	return TEXT_INPUT_TYPES.has(String(element.type ?? "").toLowerCase());
}

/** True on macOS and iOS, where the submit chord uses Cmd instead of Ctrl. */
export function isApplePlatform(platform) {
	return /mac|iphone|ipad|ipod/i.test(String(platform ?? ""));
}

/** UX-02: Cmd+Enter on Apple platforms, Ctrl+Enter elsewhere. */
export function isSubmitChord(event, apple) {
	if (event.key !== "Enter" || event.altKey || event.shiftKey) return false;
	return apple ? Boolean(event.metaKey) && !event.ctrlKey : Boolean(event.ctrlKey) && !event.metaKey;
}

/** How a sequence reads in the help overlay. */
export function sequenceLabel(sequence, apple) {
	return sequence
		.map((key) => {
			if (key === "Mod+Enter") return apple ? "⌘ Enter" : "Ctrl Enter";
			if (key === "Escape") return "Esc";
			return key;
		})
		.join(" then ");
}

/** The overlay's rows, in keymap order: one row per binding, its sequences joined by "or". */
export function helpRows(apple) {
	const row = (binding, scope) => ({
		scope,
		action: binding.action,
		keys: binding.sequences.map((sequence) => sequenceLabel(sequence, apple)),
		description: binding.description,
	});
	return [...KEYMAP.map((binding) => row(binding, "page")), ...INPUT_KEYMAP.map((binding) => row(binding, "input"))];
}

function same(a, b) {
	return a.length === b.length && a.every((key, i) => key === b[i]);
}

function startsWith(sequence, prefix) {
	return prefix.length < sequence.length && prefix.every((key, i) => key === sequence[i]);
}

/**
 * A key reader with the state a sequence needs: the keys typed so far and when. `press` returns
 * the action to run, `"pending"` while a prefix waits for its next key, or null when the key is
 * not bound and should keep its default behaviour.
 *
 * `context.inInput` says focus is in a text input; `context.inForm` says focus is inside a form;
 * `context.apple` picks the submit chord.
 */
export function createKeyReader({ keymap = KEYMAP, timeout = SEQUENCE_TIMEOUT } = {}) {
	let pending = [];
	let pendingAt = 0;
	const bindingFor = (sequence) => keymap.find((binding) => binding.sequences.some((candidate) => same(candidate, sequence)));
	const isPrefix = (sequence) => keymap.some((binding) => binding.sequences.some((candidate) => startsWith(candidate, sequence)));

	function press(event, context = {}) {
		if (isSubmitChord(event, Boolean(context.apple))) {
			pending = [];
			return context.inForm ? "submit" : null;
		}
		if (context.inInput) {
			pending = [];
			return event.key === "Escape" ? "leave-input" : null;
		}
		if (event.metaKey || event.ctrlKey || event.altKey) {
			pending = [];
			return null;
		}
		const at = Number(event.timeStamp ?? 0);
		if (pending.length > 0 && at - pendingAt > timeout) pending = [];
		const sequence = [...pending, event.key];
		const exact = bindingFor(sequence);
		if (exact) {
			pending = [];
			return exact.action;
		}
		if (isPrefix(sequence)) {
			pending = sequence;
			pendingAt = at;
			return "pending";
		}
		pending = [];
		// A broken sequence ("g" then "j") still lets its last key act on its own.
		return sequence.length > 1 ? press(event, context) : null;
	}

	return {
		get pending() {
			return [...pending];
		},
		reset() {
			pending = [];
		},
		press,
	};
}

/** The next selection index for `next` or `previous`, clamped to the list. -1 means none. */
export function moveSelection(index, count, action) {
	if (count <= 0) return -1;
	if (index < 0 || index >= count) return action === "previous" ? count - 1 : 0;
	if (action === "next") return Math.min(index + 1, count - 1);
	if (action === "previous") return Math.max(index - 1, 0);
	return index;
}
