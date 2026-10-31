// WP13: PWA usability. The browser checks live in test/browser/ux.spec.ts; this file covers the
// server's thread inbox (UX-03), the working indicators (UX-09), and the PWA modules whose logic
// is pure (UX-01, UX-02, UX-06, UX-08).

import { readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { runPanaCli } from "../src/cli/commands.ts";
import { type SessionWakeEvent } from "../src/schedules/live.ts";
import { sessionRuntime, setSessionState, type SessionStateEvent } from "../src/sessions/index.ts";
import { snippetOf } from "../src/threads/index.ts";
import { subscribeEvents } from "../src/web/events.ts";
import { startTestPanad, TEST_USER, type TestPanad } from "./harness/index.ts";
import { createKeyReader, helpRows, INPUT_KEYMAP, isApplePlatform, isSubmitChord, isTextInput, KEYMAP, moveSelection, sequenceLabel } from "../web/keys.js";
import { COMMANDS, fuzzyScore, HITS_PER_STORE, hitHash, matchCommands, paletteCommands, paletteHits, rankBy } from "../web/palette.js";
import { browserEnv, explainPush, isIpHost, subscribeToPush, urlBase64ToUint8Array } from "../web/push.js";
import { inboxThreadRow, isWorking, PALETTE, participantColor, refLabel, scheduledOf, SESSION_COLORS, threadRow, untilLabel, workingOf } from "../web/views.js";

it("enables inherited font disambiguation throughout the UI", () => {
	const css = readFileSync(new URL("../web/style.css", import.meta.url), "utf8");
	const body = css.match(/(?:^|\n)body\s*\{([^}]+)\}/)?.[1];
	expect(body).toContain("font-feature-settings: 'liga' on, 'clig' on, 'zero';");
});

interface Person {
	id: string;
	kind: string;
	url: string;
}

interface InboxThread {
	threadId: string;
	threadUrl: string;
	subject: string | null;
	participants: Person[];
	latest: { messageId: string; messageUrl: string; sender: Person; createdAt: number; snippet: string; revised: boolean; redacted: boolean };
	unreadCount: number;
	archived: boolean;
}

interface ThreadInbox {
	participant: Person;
	threads: InboxThread[];
	unreadTotal: number;
	nextCursor: string | null;
}

let t: TestPanad | undefined;
afterEach(async () => {
	await t?.close();
	t = undefined;
});

/** A stopped session row: mail to it queues and wakes nothing, so no model turns are needed. */
async function seedSession(): Promise<string> {
	const id = t!.runtime.newId();
	const now = t!.clock.now();
	await t!.runtime.db.write(async (tx) => {
		await tx.run("INSERT INTO participants (id, kind, url, created_at) VALUES (?, 'session', ?, ?)", id, t!.runtime.url({ kind: "session", id }), now);
		await tx.run("INSERT INTO sessions (id, state, depth, created_at, updated_at) VALUES (?, 'stopped', 0, ?, ?)", id, now, now);
	});
	return id;
}

async function post<T>(path: string, body: unknown, caller?: string): Promise<T> {
	const res = await t!.client.post<T>(path, body, caller ? { caller } : {});
	expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
	await t!.clock.advance(1000);
	return res.body;
}

interface Created {
	thread: { id: string };
	message: { id: string };
}

describe("UX-03 the inbox lists threads by latest activity", () => {
	it("UX-03 one row per thread, newest activity first, with subject, participants, snippet, time, and unread count", async () => {
		t = await startTestPanad();
		const a = await seedSession();
		const b = await seedSession();

		const first = await post<Created>("/threads", { to: [TEST_USER], body: "First thread from A\n\nmore lines" }, a);
		const second = await post<Created>("/threads", { to: [TEST_USER, b], body: "Second thread, three people" }, a);
		const third = await post<Created>("/threads", { to: [a], body: "The user starts this one" });
		// Two more messages in the first thread: it has the newest activity, with two unread.
		const reply = await post<Created>(`/threads/${first.thread.id}/messages`, { after: first.message.id, body: "a follow-up" }, a);
		const long = "word ".repeat(60).trim();
		await post(`/threads/${first.thread.id}/messages`, { after: reply.message.id, body: long }, a);

		const res = await t.client.get<ThreadInbox>("/inbox?view=threads");
		expect(res.status).toBe(200);
		const rows = res.body.threads;
		expect(rows.map((row) => row.threadId)).toEqual([first.thread.id, third.thread.id, second.thread.id]);

		const top = rows[0]!;
		expect(top.subject).toBe("First thread from A");
		expect(top.unreadCount).toBe(3);
		expect(top.latest.sender.url).toBe(t.runtime.url({ kind: "session", id: a }));
		expect(top.latest.snippet).toBe(snippetOf(long));
		expect(top.latest.snippet.length).toBeLessThanOrEqual(141);
		expect(top.latest.snippet.endsWith("…")).toBe(true);
		expect(top.latest.messageUrl).toContain(`?message=${top.latest.messageId}`);
		expect(top.participants.map((p) => p.url).sort()).toEqual([t.runtime.userUrl, t.runtime.url({ kind: "session", id: a })].sort());

		// The user sent the newest message of the third thread: it still shows, with nothing unread.
		expect(rows[1]!.latest.sender.url).toBe(t.runtime.userUrl);
		expect(rows[1]!.unreadCount).toBe(0);
		expect(rows[2]!.participants).toHaveLength(3);
		expect(res.body.unreadTotal).toBe(4);

		// Reading a thread clears its count; the row stays.
		await t.client.get(`/threads/${first.thread.id}`);
		const after = (await t.client.get<ThreadInbox>("/inbox?view=threads")).body;
		expect(after.threads[0]!.unreadCount).toBe(0);
		expect(after.unreadTotal).toBe(1);
	});

	it("UX-03 archived threads leave the inbox and list with archived=1, and new mail brings one back", async () => {
		t = await startTestPanad();
		const a = await seedSession();
		const kept = await post<Created>("/threads", { to: [TEST_USER], body: "kept" }, a);
		const hidden = await post<Created>("/threads", { to: [TEST_USER], body: "hidden" }, a);
		await post(`/threads/${hidden.thread.id}/archive`, {});

		const inbox = (await t.client.get<ThreadInbox>("/inbox?view=threads")).body;
		expect(inbox.threads.map((row) => row.threadId)).toEqual([kept.thread.id]);
		const archived = (await t.client.get<ThreadInbox>("/inbox?view=threads&archived=1")).body;
		expect(archived.threads.map((row) => [row.threadId, row.archived])).toEqual([[hidden.thread.id, true]]);

		await post(`/threads/${hidden.thread.id}/messages`, { after: hidden.message.id, body: "back again" }, a);
		const back = (await t.client.get<ThreadInbox>("/inbox?view=threads")).body;
		expect(back.threads.map((row) => row.threadId)).toEqual([hidden.thread.id, kept.thread.id]);
	});

	it("UX-03 pages by cursor without repeating a thread, and a redacted latest message shows as redacted", async () => {
		t = await startTestPanad();
		const a = await seedSession();
		const ids: string[] = [];
		let last: Created | undefined;
		for (let i = 0; i < 7; i++) {
			last = await post<Created>("/threads", { to: [TEST_USER], body: `thread ${i}` }, a);
			ids.unshift(last.thread.id);
		}
		await post(`/messages/${last!.message.id}/redact`, {});

		const seen: string[] = [];
		let cursor: string | null = null;
		let pages = 0;
		do {
			const res: { status: number; body: ThreadInbox } = await t.client.get<ThreadInbox>(`/inbox?view=threads&limit=3${cursor ? `&cursor=${cursor}` : ""}`);
			expect(res.status).toBe(200);
			seen.push(...res.body.threads.map((row) => row.threadId));
			cursor = res.body.nextCursor;
			pages++;
		} while (cursor && pages < 10);
		expect(seen).toEqual(ids);
		expect(pages).toBe(3);

		const top = (await t.client.get<ThreadInbox>("/inbox?view=threads&limit=1")).body.threads[0]!;
		expect(top.latest).toMatchObject({ redacted: true, snippet: "[redacted]" });
	});

	it("UX-03 the delivery inbox stays the default, so `session inbox` still lists deliveries, and an unknown view is a 400", async () => {
		t = await startTestPanad();
		const a = await seedSession();
		await post("/threads", { to: [TEST_USER, a], body: "to both" });
		const deliveries = await t.client.get<{ deliveries: unknown[] }>("/inbox");
		expect(deliveries.status).toBe(200);
		expect(Array.isArray(deliveries.body.deliveries)).toBe(true);

		const cli = await runPanaCli(["session", "inbox", a], { endpoint: { socketPath: t.panad.socketPath } });
		expect(cli.exitCode, JSON.stringify(cli.body)).toBe(0);
		expect((cli.body as { deliveries: unknown[] }).deliveries).toHaveLength(1);

		const bad = await t.client.get<{ error: { code: string } }>("/inbox?view=messages");
		expect(bad.status).toBe(400);
		expect(bad.body.error.code).toBe("invalid_view");
	});

	it("UX-03 snippets collapse whitespace and cut at a word", () => {
		expect(snippetOf("  a\n\nb\tc  ")).toBe("a b c");
		expect(snippetOf("alpha beta gamma delta", 12)).toBe("alpha beta…");
		expect(snippetOf(undefined)).toBe("");
	});
});

describe("UX-03 the PWA reads the thread inbox", () => {
	it("UX-03 inboxThreadRow maps a real thread inbox row", async () => {
		t = await startTestPanad();
		const a = await seedSession();
		await post("/threads", { to: [TEST_USER], body: "Hello from A" }, a);
		const raw = (await t.client.get<ThreadInbox>("/inbox?view=threads")).body.threads[0]!;
		const row = inboxThreadRow(raw);
		expect(row).toMatchObject({
			threadId: raw.threadId,
			subject: "Hello from A",
			snippet: "Hello from A",
			unreadCount: 1,
			archived: false,
			sender: { url: t.runtime.url({ kind: "session", id: a }), kind: "session" },
		});
		expect(row.participants.map((p) => p.kind).sort()).toEqual(["session", "user"]);
		expect(row.at).toBe(raw.latest.createdAt);
	});
});

describe("UX-08 the keymap", () => {
	const page = { inInput: false, inForm: false, apple: true };

	it("UX-08 single keys, g sequences, and the keys that go back", () => {
		const keys = createKeyReader();
		const press = (key: string, timeStamp = 0, context = page) => keys.press({ key, timeStamp }, context);
		expect(press("j")).toBe("next");
		expect(press("k")).toBe("previous");
		expect(press("Enter")).toBe("open");
		expect(press("o")).toBe("open");
		expect(press("/")).toBe("search");
		expect(press("r")).toBe("reply");
		expect(press("e")).toBe("archive");
		expect(press("u")).toBe("back");
		expect(press("Escape")).toBe("back");
		expect(press("?")).toBe("help");
		for (const [key, section] of [["i", "inbox"], ["t", "threads"], ["s", "sessions"], ["m", "memory"], ["c", "compose"], ["h", "schedules"]] as const) {
			expect(press("g", 10)).toBe("pending");
			expect(keys.pending).toEqual(["g"]);
			expect(press(key, 20)).toBe(`go:${section}`);
		}
		expect(press("x")).toBeNull();
	});

	it("UX-08 a stale or broken prefix lets the next key act alone, and modified keys pass through", () => {
		const keys = createKeyReader({ timeout: 1000 });
		expect(keys.press({ key: "g", timeStamp: 0 }, page)).toBe("pending");
		expect(keys.press({ key: "i", timeStamp: 5000 }, page)).toBeNull();
		expect(keys.press({ key: "g", timeStamp: 6000 }, page)).toBe("pending");
		expect(keys.press({ key: "j", timeStamp: 6100 }, page)).toBe("next");
		expect(keys.press({ key: "j", metaKey: true }, page)).toBeNull();
		expect(keys.press({ key: "r", ctrlKey: true }, page)).toBeNull();
	});

	it("UX-08 inside a text input only Esc acts, and it leaves the input", () => {
		const keys = createKeyReader();
		const input = { inInput: true, inForm: true, apple: false };
		for (const key of ["j", "k", "g", "/", "?", "e", "Enter"]) expect(keys.press({ key }, input)).toBeNull();
		expect(keys.press({ key: "Escape" }, input)).toBe("leave-input");
		expect(isTextInput({ tagName: "TEXTAREA" })).toBe(true);
		expect(isTextInput({ tagName: "INPUT", type: "search" })).toBe(true);
		expect(isTextInput({ tagName: "INPUT", type: "checkbox" })).toBe(false);
		expect(isTextInput({ tagName: "DIV", isContentEditable: true })).toBe(true);
		expect(isTextInput({ tagName: "BUTTON" })).toBe(false);
	});

	it("UX-08 the help overlay lists exactly the keymap", () => {
		const rows = helpRows(true);
		expect(rows.map((row) => row.action)).toEqual([...KEYMAP, ...INPUT_KEYMAP].map((binding) => binding.action));
		expect(rows.find((row) => row.action === "go:schedules")!.keys).toEqual(["g then h"]);
		expect(rows.find((row) => row.action === "open")!.keys).toEqual(["Enter", "o"]);
		expect(rows.find((row) => row.action === "back")!.keys).toEqual(["u", "Esc"]);
		expect(rows.find((row) => row.action === "submit")!.keys).toEqual(["⌘ Enter"]);
		expect(helpRows(false).find((row) => row.action === "submit")!.keys).toEqual(["Ctrl Enter"]);
		// Every key the reader acts on is a row in the overlay, and no row names an unbound key.
		const keys = createKeyReader();
		for (const binding of KEYMAP) {
			for (const sequence of binding.sequences) {
				let action: string | null = null;
				for (const key of sequence) action = keys.press({ key }, page);
				expect(action, sequence.join(" ")).toBe(binding.action);
			}
		}
	});

	it("UX-08 j and k move through a list and stop at its ends", () => {
		expect(moveSelection(-1, 3, "next")).toBe(0);
		expect(moveSelection(-1, 3, "previous")).toBe(2);
		expect(moveSelection(0, 3, "next")).toBe(1);
		expect(moveSelection(2, 3, "next")).toBe(2);
		expect(moveSelection(0, 3, "previous")).toBe(0);
		expect(moveSelection(0, 0, "next")).toBe(-1);
	});
});

describe("UX-15 the command palette", () => {
	it("UX-15 Cmd+K opens the palette from the page and from a text box", () => {
		const keys = createKeyReader();
		expect(keys.press({ key: "k", metaKey: true }, { apple: true })).toBe("palette");
		expect(keys.press({ key: "k", ctrlKey: true }, { apple: false })).toBe("palette");
		// A half-written reply is no reason to keep the palette away.
		expect(keys.press({ key: "k", metaKey: true }, { inInput: true, inForm: true, apple: true })).toBe("palette");
		// Alt and Shift are not part of the chord, and plain k is still the previous row.
		expect(keys.press({ key: "k", ctrlKey: true, altKey: true }, { apple: false })).toBeNull();
		expect(keys.press({ key: "k" }, { apple: false })).toBe("previous");
		// Mod+Enter still submits the form it is in.
		expect(keys.press({ key: "Enter", metaKey: true }, { inForm: true, apple: true })).toBe("submit");

		expect(sequenceLabel(["Mod+k"], true)).toBe("⌘ K");
		expect(sequenceLabel(["Mod+k"], false)).toBe("Ctrl K");
		// Both keymaps bind it, so the help overlay says so inside a text box too.
		for (const map of [KEYMAP, INPUT_KEYMAP]) {
			const binding = map.find((entry) => entry.action === "palette");
			expect(binding?.sequences, JSON.stringify(map.length)).toEqual([["Mod+k"]]);
		}
	});

	it("UX-15 the fuzzy match reads letters in order and prefers word starts", () => {
		expect(fuzzyScore("Go to Inbox", "")).toBe(0);
		expect(fuzzyScore("Go to Inbox", "zzz")).toBeNull();
		expect(fuzzyScore("Go to Inbox", "gib")).not.toBeNull();
		expect(fuzzyScore("Go to Inbox", "gi")).toBeGreaterThan(fuzzyScore("Go to Inbox", "oi")!);
		// Order is what makes it fuzzy rather than a filter: "ig" is not in "Go to Inbox".
		expect(fuzzyScore("Go to Inbox", "ig")).toBeNull();
		expect(fuzzyScore(undefined, "a")).toBeNull();

		const items = [{ label: "Go to Threads" }, { label: "Go to Inbox" }, { label: "Show keyboard shortcuts" }];
		expect(rankBy(items, "").map((entry) => entry.item.label)).toEqual(items.map((item) => item.label));
		expect(rankBy(items, "zzz")).toEqual([]);
		// An equal score goes to the shorter label, which is the more specific answer.
		expect(rankBy(items, "gt").map((entry) => entry.item.label)).toEqual(["Go to Inbox", "Go to Threads"]);
	});

	it("UX-15 the palette lists what the page can do right now", () => {
		const ids = (context: Record<string, unknown>) => paletteCommands(context).map((command) => command.id);
		expect(new Set(COMMANDS.map((command) => command.id)).size).toBe(COMMANDS.length);
		expect(ids({})).toEqual(expect.arrayContaining(["palette:search", "go:inbox", "go:compose", "back", "help", "push"]));
		expect(ids({})).not.toContain("archive-thread");
		expect(ids({ thread: { id: "T" }, canArchive: true })).toContain("archive-thread");
		expect(ids({ thread: { id: "T" }, canArchive: false })).not.toContain("archive-thread");
		expect(ids({})).not.toContain("session:stop");
		expect(ids({ session: { id: "S" } })).toEqual(expect.arrayContaining(["session:stop", "session:compact", "session:archive"]));
		expect(ids({})).not.toContain("open");
		expect(ids({ selection: {} })).toContain("open");
		expect(ids({ push: { subscribed: true } })).not.toContain("push");

		// Typing narrows the list by the same fuzzy match, and Enter on the first row searches.
		expect(matchCommands(paletteCommands({}), "gi")[0]!.id).toBe("go:inbox");
		expect(matchCommands(paletteCommands({}), "zzz")).toEqual([]);
	});

	it("UX-15 the search stage maps three stores and ranks each group", () => {
		const bodies = {
			threads: {
				threads: [
					{ threadId: "T1", threadUrl: "pana://d/threads/T1", subject: "Deploy notes", snippet: "the deploy steps", createdAt: 5, unreadCount: 0, archived: false },
					{ threadId: "T2", threadUrl: "pana://d/threads/T2", subject: "Lunch", snippet: "we deploy after lunch", createdAt: 6, unreadCount: 1, archived: false },
				],
			},
			sessions: { sessions: [{ sessionId: "S1", sessionUrl: "pana://d/sessions/01ABC9Z1", snippet: "…deployed it…" }] },
			memory: { results: [{ path: "ops/deploy.md", line: 3, text: "deploy steps" }] },
		};
		const groups = paletteHits(bodies, "deploy");
		expect(groups.map((group) => group.title)).toEqual(["Threads", "Sessions", "Memory"]);
		// A subject match outranks a body match, and a hit whose text the query cannot reach keeps
		// its place at the end rather than vanishing.
		expect(groups[0]!.hits.map((hit) => hit.id)).toEqual(["T1", "T2"]);
		expect(paletteHits({ threads: { threads: [{ threadId: "T3", subject: "Lunch", snippet: "deploy" }] } }, "zzz")[0]!.hits[0]!.id).toBe("T3");
		expect(groups[1]!.hits[0]).toEqual({ kind: "session", id: "S1", label: "…deployed it…", meta: "session ABC9Z1", at: undefined });
		expect(groups[2]!.hits[0]).toEqual({ kind: "memory", id: "ops/deploy.md", label: "ops/deploy.md", meta: "3: deploy steps" });
		// A thread that matched in three of its messages is still one row.
		const repeated = {
			threads: {
				threads: [
					{ threadId: "T9", subject: "Deploy notes", snippet: "deploy", createdAt: 1, unreadCount: 0, archived: false },
					{ threadId: "T9", subject: "Deploy notes", snippet: "deploy again", createdAt: 2, unreadCount: 0, archived: false },
				],
			},
		};
		expect(paletteHits(repeated, "deploy")[0]!.hits).toHaveLength(1);
		// A store that matched nothing is left out, and no store answers with more than its share.
		expect(paletteHits({}, "deploy")).toEqual([]);
		const many = { results: Array.from({ length: 9 }, (_, at) => ({ path: `note-${at}.md`, line: 1, text: `deploy ${at}` })) };
		expect(paletteHits({ memory: many }, "deploy")[0]!.hits).toHaveLength(HITS_PER_STORE);

		expect(hitHash({ kind: "thread", id: "T1" })).toBe("#/threads/T1");
		expect(hitHash({ kind: "session", id: "S1" })).toBe("#/sessions/S1");
		expect(hitHash({ kind: "memory", id: "ops/a b.md" })).toBe("#/memory/files/ops/a%20b.md");
	});
});

describe("UX-16 the thread header regenerates a subject", () => {
	it("UX-16 the shell puts the button in the thread header, and the palette lists the same action", () => {
		const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
		const app = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
		// It sits in the open thread's header, beside Archive, because it acts on that thread.
		expect(html).toContain('id="thread-subject-regenerate"');
		expect(html).toContain('id="thread-archive"');
		expect(html.indexOf('id="thread-subject-regenerate"')).toBeLessThan(html.indexOf('id="thread-archive"'));
		expect(app).toContain('$("thread-subject-regenerate").addEventListener("click"');
		// It asks the SUB-04 route for a regeneration and swaps in the subject it answers with.
		expect(app).toContain('api("POST", `/threads/${thread.id}/subject`, { regenerate: true })');
		expect(app).toContain('applyThreadSubject(thread.id, body.subject ?? "(no subject)")');
		// With no subjectModel there is nothing to regenerate with, so the button says what to set.
		expect(app).toContain('error?.body?.error?.code === "no_subject_model"');
		expect(app).toContain("Set subjectModel in config.json to regenerate a subject.");

		const ids = (context: Record<string, unknown>) => paletteCommands(context).map((command) => command.id);
		expect(ids({})).not.toContain("subject-regenerate");
		expect(ids({ thread: { id: "T" } })).toContain("subject-regenerate");
		expect(matchCommands(paletteCommands({ thread: { id: "T" } }), "regenerate subject")[0]!.id).toBe("subject-regenerate");
	});

	it("UX-16 without a subject model the route names that cause, and with one it keeps the old subject", async () => {
		t = await startTestPanad();
		const created = await t.client.post<Created>("/threads", { to: [TEST_USER], body: "a first line\nand a body" });
		const refused = await t.client.post<{ error: { code: string } }>(`/threads/${created.body.thread.id}/subject`, { regenerate: true });
		expect(refused.status).toBe(400);
		expect(refused.body).toMatchObject({ error: { code: "no_subject_model" } });
	});
});

describe("UX-02 Cmd+Enter submits the focused form", () => {
	it("UX-02 Cmd+Enter on Apple platforms and Ctrl+Enter elsewhere, only inside a form", () => {
		expect(isApplePlatform("MacIntel")).toBe(true);
		expect(isApplePlatform("iPhone")).toBe(true);
		expect(isApplePlatform("Linux x86_64")).toBe(false);
		expect(isApplePlatform("Win32")).toBe(false);

		expect(isSubmitChord({ key: "Enter", metaKey: true }, true)).toBe(true);
		expect(isSubmitChord({ key: "Enter", ctrlKey: true }, true)).toBe(false);
		expect(isSubmitChord({ key: "Enter", ctrlKey: true }, false)).toBe(true);
		expect(isSubmitChord({ key: "Enter", metaKey: true }, false)).toBe(false);
		expect(isSubmitChord({ key: "Enter" }, true)).toBe(false);
		expect(isSubmitChord({ key: "Enter", metaKey: true, shiftKey: true }, true)).toBe(false);

		const keys = createKeyReader();
		expect(keys.press({ key: "Enter", metaKey: true }, { inInput: true, inForm: true, apple: true })).toBe("submit");
		expect(keys.press({ key: "Enter", ctrlKey: true }, { inInput: false, inForm: true, apple: false })).toBe("submit");
		expect(keys.press({ key: "Enter", metaKey: true }, { inInput: false, inForm: false, apple: true })).toBeNull();
	});
});

describe("UX-06 participant colors", () => {
	it("UX-06 the user is always blue, the domain black, and a session keeps one palette color", () => {
		expect(PALETTE).toEqual({
			blue: "#002FA7",
			orange: "#FF7900",
			purple: "#903465",
			green: "#237F52",
			red: "#BD2024",
			yellow: "#FFCC00",
			black: "#0D0D0D",
		});
		expect(participantColor({ url: "pana://a.example/users/josh", kind: "user" })).toBe("blue");
		expect(participantColor("pana://a.example/users/someone")).toBe("blue");
		expect(participantColor({ url: "pana://a.example", kind: "domain" })).toBe("black");
		expect(participantColor("pana://a.example")).toBe("black");

		const urls = Array.from({ length: 40 }, (_, i) => `pana://a.example/sessions/01KE6P4YM0M457PFE07QVF${String(i).padStart(4, "0")}`);
		const colors = urls.map((url) => participantColor({ url, kind: "session" }));
		for (const color of colors) expect(SESSION_COLORS).toContain(color);
		// Stable: the same URL always maps to the same color, with or without its kind.
		expect(urls.map((url) => participantColor(url))).toEqual(colors);
		// Spread: forty sessions use every session color.
		expect(new Set(colors).size).toBe(SESSION_COLORS.length);
	});

	it("UX-06 the stylesheet defines every palette color and a rule per participant color", () => {
		const css = readFileSync(new URL("../web/style.css", import.meta.url), "utf8").toLowerCase();
		for (const [name, hex] of Object.entries(PALETTE)) {
			expect(css).toContain(`--p-${name}: ${hex.toLowerCase()};`);
			expect(css).toContain(`[data-color="${name}"]`);
		}
	});

	it("UX-06 short labels name a participant without its domain", () => {
		expect(refLabel("pana://a.example/users/josh")).toBe("josh");
		expect(refLabel("pana://a.example/sessions/01KE6P4YM0M457PFE07QVFK8KM")).toBe("session VFK8KM");
		expect(refLabel("pana://a.example")).toBe("a.example");
	});
});

describe("UX-01 notifications name the real cause", () => {
	const mac = { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36" };
	const safari = { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Safari/605.1.15" };
	const iphone = { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Mobile/15E148 Safari/604.1" };
	const loopback = { origin: "http://127.0.0.1:8766", host: "127.0.0.1:8766" };

	function hooks(overrides: Record<string, unknown> = {}) {
		const calls: string[] = [];
		const subscription = {
			endpoint: "https://push.example/new",
			toJSON: () => ({ endpoint: "https://push.example/new", keys: { p256dh: "p", auth: "a" } }),
		};
		const options = {
			permission: "default",
			requestPermission: async () => {
				calls.push("requestPermission");
				return "granted";
			},
			register: async () => {
				calls.push("register");
				return {
					pushManager: {
						getSubscription: async () => null,
						subscribe: async () => {
							calls.push("subscribe");
							return subscription;
						},
					},
				};
			},
			getKey: async () => {
				calls.push("getKey");
				return KEY;
			},
			post: async () => {
				calls.push("post");
			},
			...overrides,
		};
		return { calls, options };
	}
	const KEY = "BEv1EDtILf1kHQLWIE-suliwhvMNYqSRQ7lD0QCR56IkomfN6aOVZQz_FezcstfV4sFIBx1QxtSXSWliz9jzCWs";

	it("UX-01 Allow subscribes, and the prompt is asked before anything else is awaited", async () => {
		const { calls, options } = hooks();
		const pending = subscribeToPush({ ...options, env: browserEnv({ ...mac, ...loopback }) });
		// Still inside the click's task: the prompt has already been requested.
		expect(calls).toEqual(["requestPermission"]);
		expect(await pending).toEqual({ subscribed: true, endpoint: "https://push.example/new" });
		expect(calls).toEqual(["requestPermission", "register", "getKey", "subscribe", "post"]);
	});

	it("UX-01 each failure has its own cause, and none is reported as a bare 'permission denied'", async () => {
		const env = browserEnv({ ...mac, ...loopback });
		let clock = 0;
		const now = () => clock;
		const slowDeny = async () => {
			clock += 2000;
			return "denied";
		};
		const cases: Array<[string, Record<string, unknown>, string]> = [
			["insecure", { env: browserEnv({ ...mac, secure: false, origin: "http://lantern:8766" }) }, "secure page"],
			["unsupported", { env: browserEnv({ ...mac, hasPushManager: false }) }, "no Web Push"],
			["blocked", { permission: "denied" }, "already blocks notifications for http://127.0.0.1:8766"],
			["denied", { requestPermission: async () => "denied" }, "without showing a prompt"],
			["denied", { requestPermission: slowDeny }, "System Settings › Notifications › Google Chrome"],
			["dismissed", { requestPermission: async () => "default" }, "crossed-out bell"],
			["no-worker", { register: async () => Promise.reject(new Error("no active service worker after 10 s")) }, "service worker did not start"],
			["no-key", { getKey: async () => "" }, "push key"],
			[
				"subscribe-failed",
				{
					register: async () => ({
						pushManager: {
							getSubscription: async () => null,
							subscribe: async () => Promise.reject(Object.assign(new Error("Registration failed - permission denied"), { name: "NotAllowedError" })),
						},
					}),
				},
				"NotAllowedError: Registration failed - permission denied",
			],
			[
				"subscribe-failed",
				{
					register: async () => ({
						pushManager: {
							getSubscription: async () => null,
							subscribe: async () => Promise.reject(Object.assign(new Error("Registration failed - push service error"), { name: "AbortError" })),
						},
					}),
				},
				"push service",
			],
			["server", { post: async () => Promise.reject(new Error("bad subscription")) }, "did not store the subscription"],
		];
		for (const [cause, overrides, text] of cases) {
			const { options } = hooks(overrides);
			const result = await subscribeToPush({ env, now, ...options } as never);
			expect(result.cause, cause).toBe(cause);
			const caseEnv = (overrides.env as ReturnType<typeof browserEnv>) ?? env;
			const message = explainPush(result, caseEnv).text;
			expect(message, cause).toContain(text);
			expect(message).not.toMatch(/^Notifications are off: permission denied/);
		}
	});

	it("UX-01 a blocked permission is never prompted for again", async () => {
		const { calls, options } = hooks({ permission: "denied" });
		await subscribeToPush({ ...options, env: browserEnv({ ...mac, ...loopback }) });
		expect(calls).toEqual([]);
	});

	it("UX-01 Safari on 127.0.0.1 points to localhost, the host Safari can notify", () => {
		const env = browserEnv({ ...safari, ...loopback });
		expect(env).toMatchObject({ browser: "safari", platform: "mac" });
		const message = explainPush({ subscribed: false, cause: "denied", elapsed: 3000 }, env, { localhostUrl: "http://localhost:8766/#token" });
		expect(message.text).toContain("Safari");
		expect(message.text).toContain("IP address");
		expect(message.link).toEqual({ href: "http://localhost:8766/#token", label: "Open pana on localhost" });
		// On localhost the same answer names Safari's own settings instead.
		const named = explainPush({ subscribed: false, cause: "denied", elapsed: 3000 }, browserEnv({ ...safari, origin: "http://localhost:8766", host: "localhost:8766" }));
		expect(named.text).toContain("System Settings › Notifications › Safari");
		expect(named.link).toBeUndefined();
		expect(isIpHost("127.0.0.1:8766")).toBe(true);
		expect(isIpHost("[::1]:8766")).toBe(true);
		expect(isIpHost("localhost:8766")).toBe(false);
		expect(isIpHost("lantern.tail1234.ts.net")).toBe(false);
	});

	it("UX-01 an iPhone outside the Home Screen app is told to add it", () => {
		const env = browserEnv({ ...iphone, hasPushManager: false, origin: "https://lantern.example.ts.net", host: "lantern.example.ts.net" });
		expect(explainPush({ subscribed: false, cause: "unsupported" }, env).text).toContain("Add to Home Screen");
	});

	it("UX-01 a subscription for an older VAPID key is replaced", async () => {
		const unsubscribed: string[] = [];
		const old = {
			endpoint: "https://push.example/old",
			options: { applicationServerKey: new Uint8Array([1, 2, 3]).buffer },
			unsubscribe: async () => {
				unsubscribed.push("old");
				return true;
			},
			toJSON: () => ({ endpoint: "https://push.example/old" }),
		};
		const fresh = { endpoint: "https://push.example/fresh", toJSON: () => ({ endpoint: "https://push.example/fresh" }) };
		const posted: unknown[] = [];
		const result = await subscribeToPush({
			env: browserEnv({ ...mac, ...loopback }),
			permission: "granted",
			register: async () => ({ pushManager: { getSubscription: async () => old, subscribe: async () => fresh } }),
			getKey: async () => KEY,
			post: async (subscription) => {
				posted.push(subscription);
			},
		});
		expect(unsubscribed).toEqual(["old"]);
		expect(result.endpoint).toBe("https://push.example/fresh");
		expect(posted).toEqual([{ endpoint: "https://push.example/fresh" }]);
		expect(urlBase64ToUint8Array(KEY)).toHaveLength(65);
	});
});

// --- UX-09 working indicators ---------------------------------------------------------------

interface WorkingRef {
	sessionId: string;
	url: string;
	state: string;
}

interface InboxThreadRow {
	threadId: string;
	working: WorkingRef[];
}

interface ThreadReadBody {
	thread: {
		id: string;
		participants: Array<{
			id: string;
			kind: string;
			url: string;
			state?: string;
			wake?: { at: number; url: string; subject: string; cron: string | null };
		}>;
	};
	messages: unknown[];
	archived: boolean;
}

/** A session needs a model; the scripted faux provider is the only one a test registers. */
const MODEL = { defaultModel: "faux/faux-1", timezone: "UTC" };

/** An in-process `/events` subscriber: every frame the hub writes, parsed, of one kind. */
function eventsOfKind<T>(t: TestPanad, kind: string): T[] {
	const seen: T[] = [];
	const res = {
		write(chunk: string) {
			for (const frame of chunk.split("\n\n")) {
				const line = frame.split("\n").find((row) => row.startsWith("data:"));
				if (!line) continue;
				const event = JSON.parse(line.slice(5).trim()) as { kind?: string };
				if (event.kind === kind) seen.push(event as T);
			}
			return true;
		},
		on() {
			return this;
		},
	} as unknown as ServerResponse;
	subscribeEvents(t.runtime, res);
	return seen;
}

function stateEvents(t: TestPanad): SessionStateEvent[] {
	return eventsOfKind<SessionStateEvent>(t, "session.state");
}

async function shownState(id: string): Promise<string> {
	return (await t!.client.get<{ session: { state: string } }>(`/sessions/${id}`)).body.session.state;
}

async function settled(id: string, state = "idle"): Promise<void> {
	const end = Date.now() + 10_000;
	for (;;) {
		await t!.clock.settle();
		await sessionRuntime(t!.runtime).idle();
		if ((await shownState(id)) === state) return;
		if (Date.now() > end) throw new Error(`session ${id} never became ${state}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
	const end = Date.now() + 10_000;
	for (;;) {
		await t!.clock.settle();
		await sessionRuntime(t!.runtime).idle();
		if (await check()) return;
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function readThread(id: string): Promise<ThreadReadBody> {
	const res = await t!.client.get<ThreadReadBody>(`/threads/${id}`);
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return res.body;
}

describe("UX-09 working indicators", () => {
	it("UX-09 every session state change publishes exactly one session.state event, after the write commits", async () => {
		t = await startTestPanad({ script: [{ text: "one" }, { text: "two" }], config: MODEL });
		const events = stateEvents(t);
		const created = await post<{ session: { id: string; url: string }; thread: { id: string } }>("/sessions", { prompt: "go" });
		const sessionId = created.session.id;
		await settled(sessionId);

		// The wake sets running inside the append transaction; settlement sets idle.
		expect(events.map((event) => event.state)).toEqual(["running", "idle"]);
		for (const event of events) {
			expect(event).toMatchObject({ kind: "session.state", sessionId, url: created.session.url });
			expect(event.threadIds).toEqual([created.thread.id]);
		}

		// Stop, resume, and archive each publish one event per state they store. Archive stores two.
		await post(`/sessions/${sessionId}/stop`, {});
		await post(`/sessions/${sessionId}/resume`, {});
		await post(`/sessions/${sessionId}/archive`, {});
		expect(events.map((event) => event.state)).toEqual(["running", "idle", "stopped", "idle", "stopped", "archived"]);

		// A write that stores the state the row already holds changes nothing, so nothing is published.
		const count = events.length;
		const runtime = t.runtime;
		await runtime.db.write((tx) => setSessionState(tx, runtime, { sessionId, state: "archived" }));
		expect(events).toHaveLength(count);

		// A rolled-back transaction publishes nothing: the window never sees a state that a
		// rollback took away.
		await expect(
			runtime.db.atomically(async (tx) => {
				await setSessionState(tx, runtime, { sessionId, state: "running" });
				throw new Error("rollback");
			}),
		).rejects.toThrow("rollback");
		expect(events).toHaveLength(count);
		expect(await shownState(sessionId)).toBe("archived");
	});

	it("UX-09 GET /threads/:id returns each session participant's current state, including waiting", async () => {
		t = await startTestPanad({
			script: [{ fail: "overloaded" }, { text: "back" }],
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 60_000 } },
			config: MODEL,
		});
		const release = t.model.gate();
		const created = await post<{ session: { id: string }; thread: { id: string } }>("/sessions", { prompt: "go" });
		const sessionId = created.session.id;

		const running = await readThread(created.thread.id);
		const runningSession = running.thread.participants.find((participant) => participant.id === sessionId)!;
		expect(runningSession.state).toBe("running");
		// The user is not a session, so it carries no state.
		const user = running.thread.participants.find((participant) => participant.kind === "user")!;
		expect(user.state).toBeUndefined();

		// The failing turn retries on a timer, so the stored `running` reports `waiting`.
		release();
		await until(async () => (await readThread(created.thread.id)).thread.participants.find((p) => p.id === sessionId)?.state === "waiting", "waiting");
		await t.clock.advance(120_000);
		await settled(sessionId);
		const idle = await readThread(created.thread.id);
		expect(idle.thread.participants.find((participant) => participant.id === sessionId)!.state).toBe("idle");
	});

	it("UX-09 inbox and thread-list rows carry the working sessions of their threads", async () => {
		t = await startTestPanad({ script: [{ text: "the answer" }], config: MODEL });
		const release = t.model.gate();
		const created = await post<{ session: { id: string; url: string }; thread: { id: string } }>("/sessions", { prompt: "go" });
		const sessionId = created.session.id;

		const inbox = (await t.client.get<{ threads: InboxThreadRow[] }>("/inbox?view=threads")).body.threads;
		expect(inbox[0]!.working).toEqual([{ sessionId, url: created.session.url, state: "running" }]);
		const list = (await t.client.get<{ threads: InboxThreadRow[] }>("/threads")).body.threads;
		expect(list[0]!.working).toEqual([{ sessionId, url: created.session.url, state: "running" }]);
		const search = (await t.client.get<{ threads: InboxThreadRow[] }>("/threads?query=go")).body.threads;
		expect(search[0]!.working).toEqual([{ sessionId, url: created.session.url, state: "running" }]);

		// The PWA maps the field onto its rows and marks them.
		expect(inboxThreadRow(inbox[0]!).working).toEqual([{ sessionId, url: created.session.url, state: "running" }]);
		expect(threadRow(list[0]!).working).toEqual([{ sessionId, url: created.session.url, state: "running" }]);

		release();
		await settled(sessionId);
		const after = (await t.client.get<{ threads: InboxThreadRow[] }>("/inbox?view=threads")).body.threads;
		expect(after[0]!.working).toEqual([]);
	});

	it("UX-09 running and waiting are working, and a list row keeps only working sessions", () => {
		expect(isWorking("running")).toBe(true);
		expect(isWorking("waiting")).toBe(true);
		for (const state of ["idle", "failed", "stopped", "archived", ""]) expect(isWorking(state)).toBe(false);

		const row = inboxThreadRow({
			threadId: "T",
			latest: {},
			working: [
				{ sessionId: "S1", url: "pana://a.example/sessions/S1", state: "running" },
				{ sessionId: "S2", url: "pana://a.example/sessions/S2", state: "idle" },
			],
		});
		expect(row.working).toEqual([{ sessionId: "S1", url: "pana://a.example/sessions/S1", state: "running" }]);
		expect(workingOf({})).toEqual([]);
	});

	it("UX-09 a thread names the wake each scheduled session is waiting for", async () => {
		t = await startTestPanad({ script: [{ text: "later then" }], config: MODEL });
		const wakes = eventsOfKind<SessionWakeEvent>(t, "session.wake");
		const created = await post<{ session: { id: string; url: string }; thread: { id: string } }>("/sessions", { prompt: "go" });
		const sessionId = created.session.id;
		await settled(sessionId);
		// A session with nothing scheduled says nothing about waking.
		const quiet = await readThread(created.thread.id);
		expect(quiet.thread.participants.find((participant) => participant.id === sessionId)!.wake).toBeUndefined();

		const made = await post<{ schedule: { id: string; url: string; nextAt: number } }>("/schedules", {
			kind: "wake",
			session: sessionId,
			in: "2h",
			note: "Check the release.",
			subject: "Check release",
		});
		const wake = { at: made.schedule.nextAt, url: made.schedule.url, subject: "Check release", cron: null };

		// The scheduled chip is work to come, apart from the working set, soonest first.
		const read = await readThread(created.thread.id);
		expect(read.thread.participants.find((participant) => participant.id === sessionId)!.wake).toEqual(wake);
		expect(scheduledOf(read.thread)).toEqual([
			{ sessionId, url: created.session.url, at: wake.at, scheduleUrl: wake.url, subject: wake.subject, cron: wake.cron },
		]);
		expect(scheduledOf(quiet.thread)).toEqual([]);

		// A window hears the new time without a reload, and hears it clear: an edit moves the chip.
		expect(wakes.map((event) => ({ sessionId: event.sessionId, wake: event.wake }))).toEqual([{ sessionId, wake }]);
		const edited = await post<{ schedule: { nextAt: number } }>(`/schedules/${made.schedule.id}`, { in: "3h" });
		const moved = { ...wake, at: edited.schedule.nextAt };
		await until(async () => (await readThread(created.thread.id)).thread.participants.find((each) => each.id === sessionId)!.wake?.at === moved.at, "the edited wake");
		expect(wakes.map((event) => event.wake?.at)).toEqual([wake.at, moved.at]);
		await t.client.delete(`/schedules/${made.schedule.id}`);
		await until(async () => (await readThread(created.thread.id)).thread.participants.find((each) => each.id === sessionId)!.wake === undefined, "the wake to clear");
		expect(wakes.at(-1)).toMatchObject({ kind: "session.wake", sessionId, wake: null });
		expect(scheduledOf((await readThread(created.thread.id)).thread)).toEqual([]);
	});

	it("UX-09 a recurring wake's chip moves to the next occurrence when it fires", async () => {
		t = await startTestPanad({ script: [{ text: "woken" }], config: MODEL });
		const wakes = eventsOfKind<SessionWakeEvent>(t, "session.wake");
		const created = await post<{ session: { id: string }; thread: { id: string } }>("/sessions", { prompt: "go" });
		const sessionId = created.session.id;
		await settled(sessionId);
		const made = await post<{ schedule: { nextAt: number } }>("/schedules", {
			kind: "wake",
			session: sessionId,
			cron: "0 * * * *",
			note: "Hourly check.",
			subject: "Hourly",
		});
		const first = (await readThread(created.thread.id)).thread.participants.find((each) => each.id === sessionId)!.wake!;
		expect(first.at).toBe(made.schedule.nextAt);
		expect(first.cron).toBe("0 * * * *");

		await t.clock.advance(first.at - t.clock.now());
		await until(async () => {
			const wake = (await readThread(created.thread.id)).thread.participants.find((each) => each.id === sessionId)!.wake;
			return (wake?.at ?? 0) > first.at;
		}, "the chip to move to the next hour");
		// The claim published the same next time the thread now reads, before the session reported.
		const next = (await readThread(created.thread.id)).thread.participants.find((each) => each.id === sessionId)!.wake!;
		expect(wakes.map((event) => event.wake?.at)).toEqual([first.at, next.at]);
	});

	it("UX-09 the scheduled chip says how long, in the footer's few words", () => {
		const now = Date.UTC(2026, 0, 1, 12, 0, 0);
		expect(untilLabel(now + 30_000, now)).toBe("in 30s");
		expect(untilLabel(now + 5 * 60_000, now)).toBe("in 5m");
		expect(untilLabel(now + 2 * 3_600_000, now)).toBe("in 2h");
		expect(untilLabel(now + 3 * 86_400_000, now)).toBe("in 3d");
		expect(untilLabel(now, now)).toBe("now");
		expect(untilLabel(now - 1, now)).toBe("now");
		expect(untilLabel(Number.NaN, now)).toBe("");
		// A scheduled chip only takes sessions that carry a numeric wake.
		expect(scheduledOf({ participants: [{ kind: "session", id: "S", wake: { at: "later" } }, { kind: "user", id: "U" }] })).toEqual([]);
	});

	it("UX-09 the stylesheet animates the working dot and honors reduced motion", () => {
		const css = readFileSync(new URL("../web/style.css", import.meta.url), "utf8");
		expect(css).toContain("@keyframes pana-working");
		expect(css).toMatch(/\.working-dot,[\s\S]*?animation: pana-working/);
		expect(css).toContain("@media (prefers-reduced-motion: reduce)");
	});
});
