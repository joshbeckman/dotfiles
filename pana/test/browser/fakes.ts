// A seeded fake panad for the browser tests (WEB-03). The handlers answer the WP0 route
// contract with the shapes the PWA reads; other packages return 501 in this worktree.

import { ApiError } from "../../src/api/errors.ts";
import type { Handlers, RequestContext } from "../../src/api/types.ts";

export const NOW = 1_760_000_000_000;
const PNG_1X1 = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
	"base64",
);

export interface FakeMessage {
	id: string;
	body: string;
	senderUrl: string;
	createdAt: number;
	revised?: boolean;
	redacted?: boolean;
}

export interface FakeThread {
	id: string;
	subject: string;
	participants: Array<{ url: string }>;
	messages: FakeMessage[];
}

export interface FakeSession {
	id: string;
	state: string;
	model: string;
	createdAt: number;
	updatedAt: number;
	costUsd?: number;
}

export interface Call {
	method: string;
	route: string;
	body: unknown;
	params: Record<string, string>;
}

export interface FakeWorld {
	domain: string;
	userUrl: string;
	sessionUrl: string;
	threads: Map<string, FakeThread>;
	sessions: FakeSession[];
	transcript: Map<string, Array<{ role: string; text: string; at: number }>>;
	schedules: Array<Record<string, unknown>>;
	files: Record<string, string>;
	moved: boolean;
	calls: Call[];
}

const MARKDOWN = [
	"## Rendered heading",
	"",
	"Some **bold** text and a [session link](pana://test.example/sessions/S1).",
	"",
	"![pixel](pana://test.example/files/F1/pixel.png)",
	"",
	"```mermaid",
	"graph TD; A-->B;",
	"```",
].join("\n");

export function createWorld(): FakeWorld {
	const domain = "test.example";
	const userUrl = `pana://${domain}/users/tester`;
	const sessionUrl = `pana://${domain}/sessions/01JB000000000000000000S1`;
	const threads = new Map<string, FakeThread>();
	threads.set("T1", {
		id: "T1",
		subject: "A rendered thread",
		participants: [{ url: userUrl }, { url: sessionUrl }],
		messages: [
			{ id: "M1", body: MARKDOWN, senderUrl: userUrl, createdAt: NOW + 1000 },
			{ id: "M2", body: "Ready when you are.", senderUrl: sessionUrl, createdAt: NOW + 2000 },
		],
	});
	const sessions: FakeSession[] = [
		{ id: "S1", state: "idle", model: "faux", createdAt: NOW, updatedAt: NOW + 1000, costUsd: 0.01 },
		{ id: "S2", state: "stopped", model: "faux", createdAt: NOW, updatedAt: NOW + 2000 },
	];
	const transcript = new Map<string, Array<{ role: string; text: string; at: number }>>([
		[
			"S1",
			[
				{ role: "user", text: "go", at: NOW + 1000 },
				{ role: "assistant", text: "working", at: NOW + 1500 },
			],
		],
	]);
	return {
		domain,
		userUrl,
		sessionUrl,
		threads,
		sessions,
		transcript,
		schedules: [
			{ id: "SC1", kind: "session", state: "active", cron: "0 9 * * *", payload: { prompt: "daily standup" }, nextAt: NOW + 86_400_000 },
		],
		files: { "notes.md": "# Notes\n\nhello memory\n" },
		moved: false,
		calls: [],
	};
}

function record(world: FakeWorld, ctx: RequestContext, route: string): void {
	world.calls.push({ method: ctx.transport === "tcp" ? "tcp" : "socket", route, body: ctx.body, params: ctx.params });
}

export function fakeHandlers(world: FakeWorld): Handlers {
	const threadBody = (id: string): FakeThread | undefined => world.threads.get(id);
	const compose = (text: string, to: string[], subject?: string): FakeThread => {
		const id = "T2";
		const created: FakeThread = {
			id,
			subject: subject ?? text.split("\n")[0] ?? "new thread",
			participants: [{ url: world.userUrl }, ...to.map((name) => ({ url: `pana://${world.domain}/users/${name}` }))],
			messages: [{ id: "M10", body: text, senderUrl: world.userUrl, createdAt: NOW + 4000 }],
		};
		world.threads.set(id, created);
		return created;
	};
	const withNewer = (thread: FakeThread): FakeThread =>
		world.moved && thread.id === "T1"
			? { ...thread, messages: [...thread.messages, { id: "M3", body: "A newer message arrived.", senderUrl: world.sessionUrl, createdAt: NOW + 3000 }] }
			: thread;

	return {
		"inbox.list": (ctx) => {
			record(world, ctx, "inbox.list");
			const thread = world.threads.get("T1")!;
			const last = thread.messages[thread.messages.length - 1]!;
			return {
				status: 200,
				body: {
					items: [
						{
							threadId: thread.id,
							messageId: last.id,
							subject: thread.subject,
							senderUrl: last.senderUrl,
							createdAt: last.createdAt,
							read: false,
						},
					],
				},
			};
		},

		"threads.create": (ctx) => {
			record(world, ctx, "threads.create");
			const body = (ctx.body ?? {}) as { to?: string[]; body?: string; subject?: string };
			const created = compose(body.body ?? body.subject ?? "new thread", body.to ?? [], body.subject);
			return { status: 201, body: { thread: created } };
		},

		// Compose starts a session and its thread, as SES-01 does.
		"sessions.create": (ctx) => {
			record(world, ctx, "sessions.create");
			const body = (ctx.body ?? {}) as { prompt?: string; to?: string[]; subject?: string };
			const created = compose(body.prompt ?? "", body.to ?? [], body.subject);
			const session = { id: "S3", state: "running", model: "faux", createdAt: NOW + 4000, updatedAt: NOW + 4000 };
			world.sessions.push(session);
			world.transcript.set(session.id, [{ role: "user", text: body.prompt ?? "", at: NOW + 4000 }]);
			return { status: 201, body: { session, thread: { id: created.id }, message: created.messages[0] } };
		},

		"threads.search": (ctx) => {
			record(world, ctx, "threads.search");
			const query = (ctx.query.get("query") ?? "").toLowerCase();
			const threads = [...world.threads.values()]
				.filter((thread) => thread.subject.toLowerCase().includes(query) || thread.id.toLowerCase().includes(query))
				.map((thread) => ({ id: thread.id, subject: thread.subject, updatedAt: NOW, senderUrl: thread.participants[0]?.url }));
			return { status: 200, body: { threads } };
		},

		"threads.read": (ctx) => {
			record(world, ctx, "threads.read");
			const id = ctx.params.id ?? "";
			const thread = threadBody(id);
			if (!thread) throw ApiError.notFound(`thread ${id}`);
			return { status: 200, body: withNewer(thread) };
		},

		"threads.respond": (ctx) => {
			record(world, ctx, "threads.respond");
			const id = ctx.params.id ?? "";
			const thread = threadBody(id);
			if (!thread) throw ApiError.notFound(`thread ${id}`);
			const body = (ctx.body ?? {}) as { body?: string; after?: string };
			const newest = world.moved && thread.id === "T1" ? "M3" : thread.messages[thread.messages.length - 1]!.id;
			if (body.after !== newest) throw ApiError.stale("thread moved", { newer: [newest] });
			const message = { id: `M${thread.messages.length + 10}`, body: body.body ?? "", senderUrl: world.userUrl, createdAt: NOW + 5000 };
			thread.messages.push(message);
			return { status: 201, body: { message } };
		},

		"messages.markRead": (ctx) => {
			record(world, ctx, "messages.markRead");
			return { status: 200, body: { read: true } };
		},

		"messages.revise": (ctx) => {
			record(world, ctx, "messages.revise");
			const body = (ctx.body ?? {}) as { body?: string };
			for (const thread of world.threads.values()) {
				const message = thread.messages.find((entry) => entry.id === ctx.params.id);
				if (message) {
					message.body = body.body ?? message.body;
					message.revised = true;
				}
			}
			return { status: 200, body: { revised: true } };
		},

		"messages.redact": (ctx) => {
			record(world, ctx, "messages.redact");
			for (const thread of world.threads.values()) {
				const message = thread.messages.find((entry) => entry.id === ctx.params.id);
				if (message) {
					message.redacted = true;
					message.body = "";
				}
			}
			return { status: 200, body: { redacted: true } };
		},

		"files.download": (ctx) => {
			record(world, ctx, "files.download");
			return { status: 200, bytes: PNG_1X1, headers: { "content-type": "image/png" } };
		},

		"sessions.search": (ctx) => {
			record(world, ctx, "sessions.search");
			return { status: 200, body: { sessions: world.sessions } };
		},

		"sessions.show": (ctx) => {
			record(world, ctx, "sessions.show");
			const session = world.sessions.find((entry) => entry.id === ctx.params.id);
			if (!session) throw ApiError.notFound(`session ${ctx.params.id ?? ""}`);
			return { status: 200, body: { session } };
		},

		"sessions.transcript": (ctx) => {
			record(world, ctx, "sessions.transcript");
			return { status: 200, body: { entries: world.transcript.get(ctx.params.id ?? "") ?? [] } };
		},

		"sessions.stop": (ctx) => {
			record(world, ctx, "sessions.stop");
			const session = world.sessions.find((entry) => entry.id === ctx.params.id);
			if (session) session.state = "stopped";
			return { status: 200, body: { session } };
		},

		"sessions.compact": (ctx) => {
			record(world, ctx, "sessions.compact");
			const entries = world.transcript.get(ctx.params.id ?? "") ?? [];
			entries.push({ role: "assistant", text: "compacted summary", at: NOW + 6000 });
			world.transcript.set(ctx.params.id ?? "", entries);
			return { status: 200, body: { compacted: true } };
		},

		"memory.worktree": (ctx) => {
			record(world, ctx, "memory.worktree");
			return {
				status: 200,
				body: { path: "/tmp/pana-memory", files: [{ path: "notes.md", size: world.files["notes.md"]!.length }] },
			};
		},

		"memory.worktree.create": (ctx) => {
			record(world, ctx, "memory.worktree.create");
			return { status: 201, body: { path: "/tmp/pana-memory" } };
		},

		"memory.search": (ctx) => {
			record(world, ctx, "memory.search");
			const query = ctx.query.get("query") ?? "";
			return { status: 200, body: { results: [{ path: "notes.md", snippet: `match for ${query}` }] } };
		},

		"memory.log": (ctx) => {
			record(world, ctx, "memory.log");
			return { status: 200, body: { commits: [{ sha: "abc1234", subject: "memory start", at: NOW }] } };
		},

		"memory.files.read": (ctx) => {
			record(world, ctx, "memory.files.read");
			const path = ctx.params.rest ?? "";
			return { status: 200, body: { path, content: world.files[path] ?? "" } };
		},

		"memory.files.write": (ctx) => {
			record(world, ctx, "memory.files.write");
			const path = ctx.params.rest ?? "";
			const body = (ctx.body ?? {}) as { content?: string };
			world.files[path] = body.content ?? "";
			return { status: 200, body: { path, content: world.files[path] } };
		},

		"schedules.list": (ctx) => {
			record(world, ctx, "schedules.list");
			return { status: 200, body: { schedules: world.schedules } };
		},

		"schedules.create": (ctx) => {
			record(world, ctx, "schedules.create");
			const body = (ctx.body ?? {}) as { kind?: string; cron?: string; payload?: unknown };
			const schedule = { id: "SC2", kind: body.kind ?? "session", state: "active", cron: body.cron ?? "", payload: body.payload ?? {}, nextAt: NOW + 1000 };
			world.schedules.push(schedule);
			return { status: 201, body: { schedule } };
		},

		"schedules.update": (ctx) => {
			record(world, ctx, "schedules.update");
			const body = (ctx.body ?? {}) as Record<string, unknown>;
			world.schedules = world.schedules.map((schedule) =>
				schedule.id === ctx.params.id ? { ...schedule, ...body, id: schedule.id } : schedule,
			);
			return { status: 200, body: { schedule: world.schedules.find((schedule) => schedule.id === ctx.params.id) } };
		},

		"schedules.delete": (ctx) => {
			record(world, ctx, "schedules.delete");
			world.schedules = world.schedules.filter((schedule) => schedule.id !== ctx.params.id);
			return { status: 204 };
		},
	};
}
