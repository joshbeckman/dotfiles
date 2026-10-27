// The command palette (UX-15). Cmd+K (Ctrl+K) opens one list of everything the page can do; its
// Search command opens a second input that asks panad for threads, sessions, and memory at once
// (SRC-01, SRC-03, MEM-07). This file is data and pure functions — the commands, fuzzy matching,
// and the result rows — so Node tests drive it. app.js owns the DOM and the fetches.

import { memoryFileHref } from "./links.js";
import { memoryHitView, refLabel, threadRow } from "./views.js";

/** How many hits of each store the palette shows. A search is a jump, not a browse (SCALE-03). */
export const HITS_PER_STORE = 5;

/**
 * Every command, in the order the palette lists them before a query narrows it. `hint` is the
 * key that does the same thing outside the palette; `keywords` are extra spellings the fuzzy
 * match may use; `when` says whether the page can run it right now.
 */
export const COMMANDS = [
	{
		id: "palette:search",
		label: "Search threads, sessions, and memory",
		hint: "Enter",
		keywords: "find query fts everything everywhere",
	},
	{ id: "go:inbox", label: "Go to Inbox", hint: "g i", keywords: "unread mail" },
	{ id: "go:threads", label: "Go to Threads", hint: "g t", keywords: "conversations browse" },
	{ id: "go:sessions", label: "Go to Sessions", hint: "g s", keywords: "agents transcripts" },
	{ id: "go:memory", label: "Go to Memory", hint: "g m", keywords: "notes files" },
	{ id: "go:schedules", label: "Go to Schedules", hint: "g h", keywords: "wake cron timers" },
	{ id: "go:compose", label: "New thread", hint: "g c", keywords: "compose write message" },
	{ id: "open", label: "Open the selection", hint: "Enter", keywords: "enter row", when: (context) => Boolean(context.selection) },
	{ id: "archive-thread", label: "Archive the open thread", hint: "e", keywords: "hide unarchive", when: (context) => Boolean(context.thread) },
	{ id: "session:stop", label: "Stop the session", keywords: "kill cancel end", when: (context) => Boolean(context.session) },
	{ id: "session:compact", label: "Compact the session", keywords: "summarize shorten", when: (context) => Boolean(context.session) },
	{ id: "session:archive", label: "Archive the session", keywords: "hide", when: (context) => Boolean(context.session) },
	{ id: "session:reload", label: "Reload the transcript", keywords: "refresh fetch", when: (context) => Boolean(context.session) },
	{ id: "push", label: "Enable notifications", keywords: "push subscribe alerts", when: (context) => !context.push?.subscribed },
	{ id: "back", label: "Go back", hint: "u", keywords: "return up" },
	{ id: "help", label: "Show keyboard shortcuts", hint: "?", keywords: "keys help" },
];

/**
 * The commands this page can run, in listing order. `context` is plain data, so a test can build
 * one: `{thread, session, selection, push}`.
 */
export function paletteCommands(context = {}) {
	return COMMANDS.filter((command) => !command.when || command.when(context));
}

const WORD_START = /[^a-z0-9]/;

/**
 * A fuzzy score for `query` inside `text`, or null when its letters do not appear in order.
 * Consecutive letters and letters that start a word score higher, so "gi" prefers "Go to Inbox"
 * over "Archive the open thread", and a gap costs a little.
 */
export function fuzzyScore(text, query) {
	const source = String(text ?? "").toLowerCase();
	const needle = String(query ?? "")
		.toLowerCase()
		.replace(/\s+/g, "");
	if (needle.length === 0) return 0;
	let score = 0;
	let from = 0;
	let previous = -2;
	for (const char of needle) {
		const found = source.indexOf(char, from);
		if (found < 0) return null;
		score += 1;
		if (found === previous + 1) score += 3;
		if (found === 0 || WORD_START.test(source[found - 1])) score += 4;
		score -= Math.min(found - from, 2);
		previous = found;
		from = found + 1;
	}
	return score;
}

/**
 * `items` scored by `text`, best first: score, then the shorter text, then the order given. An
 * empty query keeps every item in the order given, so the palette opens on its own list. `keep`
 * holds on to the items the query cannot reach, at the end: a store's hits are already matches,
 * and the score only decides which comes first.
 */
export function rankBy(items, query, text = (item) => item.label, { keep = false } = {}) {
	const needle = String(query ?? "").trim();
	if (!needle) return items.map((item) => ({ item, score: 0 }));
	return items
		.map((item, index) => ({ item, index, score: fuzzyScore(text(item), needle) }))
		.filter((entry) => keep || entry.score !== null)
		.sort(
			(a, b) =>
				(b.score ?? -1) - (a.score ?? -1) ||
				String(text(a.item)).length - String(text(b.item)).length ||
				a.index - b.index,
		)
		.map(({ item, score }) => ({ item, score }));
}

/** What the fuzzy match reads for a command. */
function commandText(command) {
	return `${command.label} ${command.keywords ?? ""}`;
}

/** The commands matching `query`, best first. */
export function matchCommands(commands, query) {
	return rankBy(commands, query, commandText).map((entry) => entry.item);
}

function list(body, key) {
	if (Array.isArray(body)) return body;
	if (!body || typeof body !== "object") return [];
	return Array.isArray(body[key]) ? body[key] : [];
}

/**
 * One store's hits as palette rows: `{kind, id, label, meta}`. Each store maps its own response
 * shape here, so app.js never reads a handler's fields for the palette.
 */
export function threadHits(body) {
	return list(body, "threads").map((hit) => {
		const thread = threadRow(hit);
		return { kind: "thread", id: thread.id, label: thread.subject, meta: thread.snippet ?? "", at: thread.at };
	});
}

export function sessionHits(body) {
	return list(body, "sessions").map((hit) => {
		const id = String(hit.sessionId ?? hit.id ?? "");
		const url = String(hit.sessionUrl ?? hit.url ?? "");
		return { kind: "session", id, label: String(hit.snippet ?? ""), meta: refLabel(url) || id, at: hit.updatedAt };
	});
}

export function memoryHits(body) {
	return list(body, "results").map((hit) => {
		const file = memoryHitView(hit);
		return { kind: "memory", id: file.path, label: file.path, meta: file.text };
	});
}

/** A thread's search hits repeat once per matching message; the palette lists it once. */
function dedupe(hits) {
	const seen = new Set();
	return hits.filter((hit) => {
		const key = `${hit.kind}:${hit.id}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/** What the fuzzy match reads for a hit: its title and the line the store matched it on. */
function hitText(hit) {
	return `${hit.label} ${hit.meta ?? ""}`;
}

/**
 * The palette's search stage: three stores' responses as titled groups, each group ranked by the
 * query, empty groups dropped. `bodies` is `{threads, sessions, memory}` — any may be missing.
 */
export function paletteHits(bodies, query, limit = HITS_PER_STORE) {
	const groups = [
		["Threads", threadHits(bodies?.threads)],
		["Sessions", sessionHits(bodies?.sessions)],
		["Memory", memoryHits(bodies?.memory)],
	];
	return groups
		.map(([title, hits]) => ({
			title,
			hits: dedupe(rankBy(hits, query, hitText, { keep: true }).map((entry) => entry.item)).slice(0, limit),
		}))
		.filter((group) => group.hits.length > 0);
}

/** Where a search hit goes, as the hash route the page already understands (REF-08). */
export function hitHash(hit) {
	if (hit.kind === "thread") return `#/threads/${hit.id}`;
	if (hit.kind === "session") return `#/sessions/${hit.id}`;
	if (hit.kind === "memory") return memoryFileHref(hit.id);
	return "#/inbox";
}
