import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { afterEach, expect, it } from "vitest";
import { MIGRATIONS, migrate, SCHEMA_VERSION } from "../src/db/index.ts";
import { subscribeEvents } from "../src/web/events.ts";
import { startTestPanad, TEST_USER, type TestPanad } from "./harness/index.ts";

let t: TestPanad | undefined;
afterEach(async () => { await t?.close(); t = undefined; });

async function session(t: TestPanad): Promise<string> {
	const id = t.runtime.newId();
	await t.runtime.db.write(async tx => {
		await tx.run("INSERT INTO participants (id, kind, url, created_at) VALUES (?, 'session', ?, ?)", id, t.runtime.url({ kind: "session", id }), t.clock.now());
		await tx.run("INSERT INTO sessions (id, state, depth, created_at, updated_at) VALUES (?, 'idle', 0, ?, ?)", id, t.clock.now(), t.clock.now());
	});
	return id;
}

async function fixture() {
	t = await startTestPanad();
	const member = await session(t);
	const outsider = await session(t);
	const made = await t.client.post<{ thread: { id: string; participants: Array<{ id: string; role: string }> } }>("/threads", { to: [member], body: "role searchable text" });
	expect(made.status).toBe(201);
	return { t, member, outsider, id: made.body.thread.id, initial: made.body.thread.participants };
}

it("stores self-declared roles and exposes them in every thread participant view", async () => {
	const { t, member, id, initial } = await fixture();
	expect(initial.every(p => p.role === "participant")).toBe(true);
	const path = `/threads/${id}/role`;
	const result = await t.client.request<{ threadId: string; participantId: string; role: string }>("PUT", path, { caller: member, body: { role: "  investigator  " } });
	expect(result.status).toBe(200);
	expect(result.body).toEqual({ threadId: id, participantId: member, role: "investigator" });
	const read = await t.client.get<{ thread: { participants: Array<{ id: string; role: string }> } }>(`/threads/${id}`);
	expect(read.body.thread.participants.find(p => p.id === member)?.role).toBe("investigator");
	expect(read.body.thread.participants.find(p => p.id === TEST_USER)?.role).toBe("participant");
	for (const path of ["/threads", "/threads?query=searchable", "/inbox?view=threads"]) {
		const response = await t.client.get<{ threads: Array<{ threadId: string; participants: Array<{ id: string; role: string }> }> }>(path);
		expect(response.status).toBe(200);
		expect(response.body.threads.find(row => row.threadId === id)?.participants.find(p => p.id === member)?.role).toBe("investigator");
	}
	for (const role of [null, "participant"]) {
		await t.client.request("PUT", path, { caller: member, body: { role: "reviewer" } });
		const reset = await t.client.request<{ role: string }>("PUT", path, { caller: member, body: { role } });
		expect(reset.body.role).toBe("participant");
		expect(await t.runtime.db.get("SELECT * FROM thread_participant_roles WHERE thread_id = ? AND participant_id = ?", id, member)).toBeUndefined();
	}
});

it("validates labels and refuses nonmembers and attempts to target someone else", async () => {
	const { t, member, outsider, id } = await fixture();
	const path = `/threads/${id}/role`;
	for (const body of [{}, { role: "" }, { role: "   " }, { role: "x".repeat(33) }, { role: "ok\n" }, { role: "\ttext" }, { role: "x\u0085y" }, { role: "x\u2028y" }, { role: 3 }, { role: {} }, { role: "reviewer", participant: member }]) {
		expect((await t.client.request("PUT", path, { body })).status, JSON.stringify(body)).toBe(400);
	}
	expect((await t.client.request("PUT", `${path}?participant=${member}`, { body: { role: "reviewer" } })).status).toBe(400);
	expect((await t.client.request("PUT", path, { caller: outsider, body: { role: "reviewer" } })).status).toBe(403);
	expect((await t.client.request("PUT", `/threads/${t.runtime.newId()}/role`, { body: { role: "reviewer" } })).status).toBe(404);
	expect((await t.client.request("PUT", path, { body: { role: "😀".repeat(32) } })).status).toBe(200);
	expect((await t.client.request("PUT", path, { body: { role: "😀".repeat(33) } })).status).toBe(400);
});

it("streams only committed changes without messages, deliveries, wakes, or unread changes", async () => {
	const { t, member, id } = await fixture();
	const output: string[] = [];
	const response = new EventEmitter() as ServerResponse;
	response.write = ((chunk: string) => { output.push(chunk); return true; }) as ServerResponse["write"];
	const stop = subscribeEvents(t.runtime, response, { id: TEST_USER, kind: "user", url: t.runtime.userUrl });
	const snapshot = async () => Promise.all(["messages", "deliveries", "unread_counts", "pi_submissions"].map(table => t.runtime.db.all(`SELECT * FROM ${table}`)));
	const before = await snapshot();
	const path = `/threads/${id}/role`;
	try {
		t.runtime.db.faults = (sql) => { if (sql === "COMMIT") throw new Error("commit rejected"); };
		expect((await t.client.request("PUT", path, { caller: member, body: { role: "reviewer" } })).status).toBe(500);
		t.runtime.db.faults = undefined;
		expect(output.join("")).not.toContain("thread.role");
		expect(await t.runtime.db.get("SELECT * FROM thread_participant_roles WHERE thread_id = ?", id)).toBeUndefined();
		expect((await t.client.request("PUT", path, { caller: member, body: { role: "reviewer" } })).status).toBe(200);
		const frames = output.filter(frame => frame.startsWith("event: thread.role"));
		expect(frames).toHaveLength(1);
		expect(JSON.parse(frames[0]!.split("data: ")[1]!.trim())).toMatchObject({ kind: "thread.role", threadId: id, participantId: member, role: "reviewer" });
		await t.client.request("PUT", path, { caller: member, body: { role: "reviewer" } });
		expect(output.filter(frame => frame.startsWith("event: thread.role"))).toHaveLength(1);
		expect(await snapshot()).toEqual(before);
	} finally { t.runtime.db.faults = undefined; stop(); }
});

it("upgrades an existing database without changing membership, and migration is idempotent", async () => {
	const { t, id } = await fixture();
	const before = await t.runtime.db.all("SELECT * FROM thread_participants WHERE thread_id = ?", id);
	await t.runtime.db.write(async tx => {
		await tx.exec("DROP TABLE thread_participant_roles; PRAGMA user_version = 19;");
	});
	expect(await migrate(t.runtime.db)).toBe(SCHEMA_VERSION);
	const migration = MIGRATIONS.find(m => m.name === "thread participant roles")!;
	await t.runtime.db.write(tx => tx.exec(migration.sql));
	expect(await t.runtime.db.all("SELECT * FROM thread_participants WHERE thread_id = ?", id)).toEqual(before);
	const read = await t.client.get<{ thread: { participants: Array<{ role: string }> } }>(`/threads/${id}`);
	expect(read.body.thread.participants.every(p => p.role === "participant")).toBe(true);
});

it("removes a label with its membership so a later join gets the default", async () => {
	const { t, member, id } = await fixture();
	await t.client.request("PUT", `/threads/${id}/role`, { caller: member, body: { role: "reviewer" } });
	await t.runtime.db.write(async tx => {
		await tx.run("DELETE FROM thread_participants WHERE thread_id = ? AND participant_id = ?", id, member);
		await tx.run("INSERT INTO thread_participants (thread_id, participant_id, joined_at) VALUES (?, ?, ?)", id, member, t.clock.now());
	});
	const read = await t.client.get<{ thread: { participants: Array<{ id: string; role: string }> } }>(`/threads/${id}`);
	expect(read.body.thread.participants.find(p => p.id === member)?.role).toBe("participant");
});

it("reads participants by reference without marking any deliveries read", async () => {
	const { t, member, outsider, id } = await fixture();
	const last = await t.runtime.db.get<{ id: string }>("SELECT id FROM messages WHERE thread_id = ?", id);
	const reply = await t.client.post(`/threads/${id}/messages`, { after: last!.id, body: "unseen reply" }, { caller: member });
	expect(reply.status).toBe(200);
	expect((await t.client.request("PUT", `/threads/${id}/role`, { caller: member, body: { role: "investigator" } })).status).toBe(200);
	const snapshot = async () => ({
		deliveries: await t.runtime.db.all<{ read_at: number | null }>("SELECT * FROM deliveries ORDER BY id"),
		unread: await t.runtime.db.all("SELECT * FROM unread_counts ORDER BY participant_id"),
		members: await t.runtime.db.all("SELECT * FROM thread_participants ORDER BY participant_id"),
	});
	const before = await snapshot();
	expect(before.deliveries.filter(d => d.read_at === null)).toHaveLength(2);
	const path = `/threads/${id}/participants`;
	const asUser = await t.tcp.get<{ participants: Array<{ id: string; role: string }> }>(path);
	const asMember = await t.client.get<{ participants: Array<{ id: string; role: string }> }>(path, { caller: member });
	const asOutsider = await t.client.get<{ participants: Array<{ id: string; role: string }> }>(path, { caller: outsider });
	for (const response of [asUser, asMember, asOutsider]) {
		expect(response.status).toBe(200);
		expect(response.body.participants.find(p => p.id === member)?.role).toBe("investigator");
		expect(response.body.participants.find(p => p.id === TEST_USER)?.role).toBe("participant");
	}
	expect(await snapshot()).toEqual(before);
	expect((await t.client.get(`/threads/${t.runtime.newId()}/participants`, { caller: outsider })).status).toBe(404);
	const read = await t.client.get<{ thread: { participants: unknown[] } }>(`/threads/${id}`);
	expect(asUser.body.participants).toEqual(read.body.thread.participants);
});
