// A realistic domain for the WP13 browser tests and screenshots: several threads with sessions,
// one thread with three participants, a notice, an archived thread, memory, and schedules.

import { sessionRuntime } from "../../src/sessions/index.ts";
import { postNotice } from "../../src/threads/index.ts";
import { FAKE_EPOCH, startTestPanad, TEST_USER, type TestPanad } from "../harness/index.ts";

export interface Seeded {
	t: TestPanad;
	/** The two-message thread from the first session. */
	capital: { sessionId: string; sessionUrl: string; threadId: string; messageIds: string[] };
	/** A thread between the user and two sessions, with a message from each. */
	group: { threadId: string; sessionUrls: string[]; messageIds: string[] };
	archivedThreadId: string;
}

const LONG_REPLY = [
	"Here is a draft release note.",
	"",
	"## pana 0.1",
	"",
	"- Threads, sessions, and memory in one place.",
	"- Every write is attributed to a URL.",
	"",
	"```sh",
	"pana session create --prompt \"hello\"",
	"```",
	"",
	"Ask if you want a shorter one.",
].join("\n");

function must(ok: boolean, what: string): void {
	if (!ok) throw new Error(what);
}

async function settle(t: TestPanad, check: () => Promise<boolean>, what: string): Promise<void> {
	const end = Date.now() + 15_000;
	for (;;) {
		await t.clock.settle();
		await sessionRuntime(t.runtime).idle();
		if (await check()) return;
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

async function messageCount(t: TestPanad, threadId: string): Promise<number> {
	const row = await t.runtime.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?", threadId);
	return row?.n ?? 0;
}

async function threadMessageIds(t: TestPanad, threadId: string): Promise<string[]> {
	const rows = await t.runtime.db.all<{ id: string }>("SELECT id FROM messages WHERE thread_id = ? ORDER BY seq", threadId);
	return rows.map((row) => row.id);
}

interface Created {
	session: { id: string; url: string };
	thread: { id: string };
}

async function session(t: TestPanad, prompt: string): Promise<Created> {
	const res = await t.client.post<Created>("/sessions", { prompt });
	must(res.status === 201, JSON.stringify(res.body));
	await settle(t, async () => (await messageCount(t, res.body.thread.id)) >= 2, `the reply to "${prompt}"`);
	await t.clock.advance(60_000);
	return res.body;
}

export async function seedDomain(): Promise<Seeded> {
	const t = await startTestPanad({
		config: { defaultModel: "faux/faux-1", timezone: "UTC" },
		script: [
			{ text: "Paris." },
			{ text: LONG_REPLY },
			{ text: "We kept the faux model and capped it at 50 ms." },
			{ text: "Paris. The release note is a different question." },
			{ text: "Agreed. One answer: **Paris**." },
			{ text: "Glad that is settled." },
			// Left for a test that composes one more session.
			{ text: "Composed from the keyboard." },
		],
	});

	const capital = await session(t, "What is the capital of France?");
	const release = await session(t, "Draft a release note for pana");
	const archived = await session(t, "Remind me what we decided about the bench");

	// Three participants: the user and two sessions, each with a message. The release session is
	// stopped first, so its messages are posted through the API and the two sessions do not wake
	// each other until the faux script runs out.
	const stop = await t.client.post(`/sessions/${release.session.id}/stop`, {});
	must(stop.status === 200, JSON.stringify(stop.body));
	const group = await t.client.post<{ thread: { id: string }; message: { id: string } }>("/threads", {
		to: [capital.session.id, release.session.id],
		body: "Both of you: compare the two answers and agree on one.",
	});
	must(group.status === 201, JSON.stringify(group.body));
	const groupId = group.body.thread.id;
	await settle(t, async () => (await messageCount(t, groupId)) >= 2, "the first session to answer the group thread");
	await t.clock.advance(60_000);
	let head = (await threadMessageIds(t, groupId)).at(-1)!;
	const fromRelease = await t.client.post(
		`/threads/${groupId}/messages`,
		{ after: head, body: "The release note stands on its own. Paris is right." },
		{ caller: release.session.id },
	);
	must(fromRelease.status === 200, JSON.stringify(fromRelease.body));
	await settle(t, async () => (await messageCount(t, groupId)) >= 4, "the first session to answer the second");
	await t.clock.advance(60_000);
	head = (await threadMessageIds(t, groupId)).at(-1)!;
	const followUp = await t.client.post(`/threads/${groupId}/messages`, { after: head, body: "Thanks, **both**. That settles it." });
	must(followUp.status === 200, JSON.stringify(followUp.body));
	await settle(t, async () => (await messageCount(t, groupId)) >= 6, "the group follow-up");
	await t.clock.advance(60_000);

	await postNotice(t.runtime, { body: "Scheduled session failed: the model was unreachable." });
	await t.clock.advance(60_000);

	const archive = await t.client.post(`/threads/${archived.thread.id}/archive`, {});
	must(archive.status === 200, "archive the thread");

	await t.client.post("/memory/files/notes/pana.md", { content: "# pana\n\nDecisions and open questions.\n" });
	await t.client.post("/schedules", { kind: "session", cron: "0 9 * * 1-5", payload: { prompt: "Morning review of open threads" } });
	await t.client.post("/schedules", {
		kind: "thread",
		at: new Date(FAKE_EPOCH + 7 * 86_400_000).toISOString(),
		payload: { to: [TEST_USER], body: "Check the bench again" },
	});

	return {
		t,
		capital: {
			sessionId: capital.session.id,
			sessionUrl: capital.session.url,
			threadId: capital.thread.id,
			messageIds: await threadMessageIds(t, capital.thread.id),
		},
		group: { threadId: groupId, sessionUrls: [capital.session.url, release.session.url], messageIds: await threadMessageIds(t, groupId) },
		archivedThreadId: archived.thread.id,
	};
}
