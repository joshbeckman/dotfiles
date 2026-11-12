// WP21: the artifact spine (ART-01..ART-08, ART-16..ART-18, ART-20, ART-21). A build is an
// immutable, versioned snapshot of uploaded files, served from a capability path. The browser
// half of the slice (ART-09..ART-11, ART-14) is proved from inside a served artifact instead.

import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { statusToExitCode } from "../src/api/errors.ts";
import { matchRoute, ROUTES } from "../src/api/routes.ts";
import { uploadBuild } from "../src/artifacts/cli.ts";
import { publishArtifact } from "../src/artifacts/store.ts";
import { renderText } from "../src/cli/output.ts";
import { main, type CliIo } from "../src/cli/index.ts";
import { runPanaCommand } from "../src/cli/commands.ts";
import { ConfigError, parseConfig } from "../src/config/index.ts";
import { SimulatedCrash } from "../src/db/index.ts";
import { startTestPanad, TEST_DOMAIN, TEST_USER, type TestPanad, type TestPanadOptions } from "./harness/index.ts";

let t: TestPanad | undefined;
const tempDirs: string[] = [];
afterEach(async () => {
	await t?.close();
	t = undefined;
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function start(options: TestPanadOptions = {}): Promise<TestPanad> {
	t = await startTestPanad({
		...options,
		config: { defaultModel: "faux/faux-1", timezone: "UTC", ...(options.config ?? {}) },
		script: options.script ?? [{ text: "Understood." }],
	});
	return t;
}

interface Person {
	id: string;
	kind: string;
	url: string;
}

interface ArtifactView {
	id: string;
	threadId: string;
	name: string;
	createdBy: string;
	url: string;
}

interface VersionFileView {
	path: string;
	fileId: string;
	size: number;
}

interface VersionView {
	id: string;
	artifactId: string;
	seq: number;
	entry: string;
	note: string | null;
	createdBy: string;
	createdAt: number;
	url: string;
	files: VersionFileView[];
	previewUrl: string;
	expiresAt: number;
	pinned?: boolean;
}

interface PublishView {
	artifact: ArtifactView;
	version: VersionView;
	created: boolean;
	entry: string;
	warnings: string[];
	previewUrl: string;
	expiresAt: number;
}

interface ShowView {
	artifact: ArtifactView;
	versions: VersionView[];
}

interface ListView {
	artifacts: Array<ArtifactView & { newestVersion: VersionView | null }>;
}

interface MessageView {
	id: string;
	seq: number;
	sender: Person;
	body?: string;
}

/** A session row, without a conversation: enough for every authorization check. */
async function seedSession(state = "idle", objectiveId: string | null = null): Promise<string> {
	const id = t!.runtime.newId();
	const now = t!.clock.now();
	await t!.runtime.db.write(async (tx) => {
		await tx.run("INSERT INTO participants (id, kind, url, created_at) VALUES (?, 'session', ?, ?)", id, t!.runtime.url({ kind: "session", id }), now);
		await tx.run(
			"INSERT INTO sessions (id, state, depth, objective_id, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?)",
			id,
			state,
			objectiveId,
			now,
			now,
		);
	});
	return id;
}

/** A thread between the user and one seeded session. */
async function thread(state = "idle"): Promise<{ id: string; session: string }> {
	const session = await seedSession(state);
	const made = await t!.client.post<{ thread: { id: string; participants: Person[] } }>("/threads", {
		to: [t!.runtime.url({ kind: "session", id: session })],
		body: "Ship the build",
	});
	expect(made.status, JSON.stringify(made.body)).toBe(201);
	return { id: made.body.thread.id, session };
}

async function upload(name: string, content: string | Buffer, caller?: string): Promise<string> {
	const res = await t!.client.request<{ file: { id: string } }>("POST", `/files?name=${encodeURIComponent(name)}`, {
		bytes: Buffer.from(content),
		headers: { "content-type": "application/octet-stream" },
		...(caller ? { caller } : {}),
	});
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.file.id;
}

/** Upload every file (again, as a client does on every publish), then publish the manifest. */
async function publishBuild(
	threadId: string,
	name: string,
	files: Record<string, string>,
	options: { entry?: string; note?: string; caller?: string } = {},
): Promise<{ status: number; body: PublishView }> {
	const manifest = [];
	for (const [path, content] of Object.entries(files)) {
		manifest.push({ path, fileId: await upload(path.split("/").pop()!, content, options.caller) });
	}
	const res = await t!.client.post<PublishView>(
		`/threads/${threadId}/artifacts/${encodeURIComponent(name)}`,
		{ entry: options.entry ?? "index.html", note: options.note, files: manifest },
		options.caller ? { caller: options.caller } : {},
	);
	return { status: res.status, body: res.body };
}

async function show(artifactId: string): Promise<ShowView> {
	const res = await t!.client.get<ShowView>(`/artifacts/${artifactId}`);
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return res.body;
}

/** The path a reader opens: everything after the domain. */
function pathOf(url: string): string {
	return new URL(url).pathname;
}

function artifactsDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pana-build-"));
	tempDirs.push(dir);
	return dir;
}

function buildDir(files: Record<string, string>): string {
	const dir = artifactsDir();
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(join(dir, path, ".."), { recursive: true });
		writeFileSync(join(dir, path), content);
	}
	return dir;
}

async function command(name: string, params: Record<string, string | undefined>, caller?: string) {
	return runPanaCommand(name, params, { endpoint: { socketPath: t!.panad.socketPath }, ...(caller ? { caller } : {}) });
}

async function cli(argv: string[], options: { cwd?: string; caller?: string; tty?: boolean } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
	let stdout = "";
	let stderr = "";
	const io: Partial<CliIo> = {
		env: { PANA_STATE: t?.dir ?? "/nonexistent", ...(options.caller ? { PANA_SESSION: options.caller } : {}) },
		stdin: Readable.from([]),
		stdout: { write: (chunk: string) => (stdout += chunk), isTTY: options.tty ?? true },
		stderr: { write: (chunk: string) => (stderr += chunk), isTTY: options.tty ?? true },
	};
	const cwd = process.cwd();
	if (options.cwd) process.chdir(options.cwd);
	try {
		return { code: await main(argv, io), stdout, stderr };
	} finally {
		process.chdir(cwd);
	}
}

interface Counts {
	messages: number;
	deliveries: number;
	participants: number;
	schedules: number;
	files: number;
	artifacts: number;
	versions: number;
}

async function counts(): Promise<Counts> {
	const one = async (sql: string) => (await t!.runtime.db.get<{ n: number }>(sql))!.n;
	return {
		messages: await one("SELECT count(*) AS n FROM messages"),
		deliveries: await one("SELECT count(*) AS n FROM deliveries"),
		participants: await one("SELECT count(*) AS n FROM thread_participants"),
		schedules: await one("SELECT count(*) AS n FROM schedules"),
		files: await one("SELECT count(*) AS n FROM files"),
		artifacts: await one("SELECT count(*) AS n FROM artifacts"),
		versions: await one("SELECT count(*) AS n FROM artifact_versions"),
	};
}

// --- ART-01 --------------------------------------------------------------------

it("ART-01 a version is an immutable snapshot, and a name is unique within its thread", async () => {
	await start();
	const { id: threadId } = await thread();

	const first = await publishBuild(threadId, "site", { "index.html": "<h1>one</h1>", "app.js": "console.log(1)" });
	expect(first.status).toBe(201);
	const artifactId = first.body.artifact.id;

	// A second build repeats an unchanged file and changes the entry; the unchanged upload is a
	// new copy, because the files table has no content hash to share.
	const second = await publishBuild(threadId, "site", { "index.html": "<h1>two</h1>", "app.js": "console.log(1)" });
	expect(second.status).toBe(201);
	expect(second.body.artifact.id).toBe(artifactId);
	expect(second.body.version.seq).toBe(2);

	// The first version is untouched: same entry, same manifest, same files.
	const shown = await show(artifactId);
	expect(shown.versions.map((version) => version.seq)).toEqual([1, 2]);
	const [v1, v2] = shown.versions as [VersionView, VersionView];
	expect(v1.entry).toBe("index.html");
	expect(v1.files.map((file) => file.path)).toEqual(["app.js", "index.html"]);
	expect(v1.files.find((file) => file.path === "app.js")!.fileId).not.toBe(v2.files.find((file) => file.path === "app.js")!.fileId);
	// Both copies are stored: the slice accepts the duplicate rather than rewriting a version.
	expect(await t!.runtime.db.all("SELECT id FROM files ORDER BY created_at")).toHaveLength(4);
	expect(await t!.runtime.db.all("SELECT count(*) AS n FROM artifact_version_files")).toEqual([{ n: 4 }]);

	// The same name in another thread is a different artifact.
	const { id: otherThread } = await thread();
	const elsewhere = await publishBuild(otherThread, "site", { "index.html": "<h1>other</h1>" });
	expect(elsewhere.body.artifact.id).not.toBe(artifactId);
});

// --- ART-02 --------------------------------------------------------------------

it("ART-02 the server checks the manifest alone and deletes nothing on a refusal", async () => {
	await start();
	const { id: threadId } = await thread();
	const good = await upload("index.html", "<h1>ok</h1>");
	const before = await counts();

	type Manifest = { entry?: unknown; note?: unknown; files?: unknown };
	const attempts: Array<[string, Manifest]> = [
		["absolute file path", { entry: "index.html", files: [{ path: "/etc/passwd", fileId: good }] }],
		["dot segment", { entry: "index.html", files: [{ path: "a/../index.html", fileId: good }] }],
		["absolute entry", { entry: "/index.html", files: [{ path: "index.html", fileId: good }] }],
		["query in a path", { entry: "index.html?x=1", files: [{ path: "index.html", fileId: good }] }],
		["duplicate path", { entry: "index.html", files: [{ path: "index.html", fileId: good }, { path: "index.html", fileId: good }] }],
		["unknown file", { entry: "index.html", files: [{ path: "index.html", fileId: t!.runtime.newId() }] }],
		["entry not in the manifest", { entry: "missing.html", files: [{ path: "index.html", fileId: good }] }],
		["no files", { entry: "index.html", files: [] }],
		["no manifest", {}],
		["note that is not text", { entry: "index.html", note: 7, files: [{ path: "index.html", fileId: good }] }],
	];
	for (const [what, body] of attempts) {
		const res = await t!.client.post(`/threads/${threadId}/artifacts/site`, body);
		expect(res.status, what).toBe(400);
		expect((res.body as { error: { code: string } }).error.code, what).toBe("invalid_manifest");
	}
	// A name that could escape its route is refused too.
	for (const name of ["a/b", "a\\b"]) {
		const res = await t!.client.post(`/threads/${threadId}/artifacts/${encodeURIComponent(name)}`, {
			entry: "index.html",
			files: [{ path: "index.html", fileId: good }],
		});
		expect(res.status, name).toBe(400);
		expect((res.body as { error: { code: string } }).error.code, name).toBe("invalid_name");
	}
	// Every refusal left the uploads and the tables exactly as they were.
	expect(await counts()).toEqual(before);
});

it("ART-02 artifacts.maxFiles and artifacts.maxBytes bound a version, and files.maxBytes still applies", async () => {
	await start({ config: { artifacts: { maxFiles: 2, maxBytes: 20 } } });
	const { id: threadId } = await thread();
	const a = await upload("a.txt", "12345");
	const b = await upload("b.txt", "12345");
	const c = await upload("c.txt", "12345");
	const big = await upload("big.txt", "0123456789ab");
	const big2 = await upload("big2.txt", "0123456789ab");

	const tooMany = await t!.client.post(`/threads/${threadId}/artifacts/site`, {
		entry: "a.txt",
		files: [{ path: "a.txt", fileId: a }, { path: "b.txt", fileId: b }, { path: "c.txt", fileId: c }],
	});
	expect(tooMany.status).toBe(400);
	expect((tooMany.body as { error: { code: string } }).error.code).toBe("invalid_manifest");

	// Two files of five bytes fit under 20; two of twelve do not.
	const fits = await t!.client.post(`/threads/${threadId}/artifacts/small`, {
		entry: "a.txt",
		files: [{ path: "a.txt", fileId: a }, { path: "b.txt", fileId: b }],
	});
	expect(fits.status, JSON.stringify(fits.body)).toBe(201);
	const tooBig = await t!.client.post(`/threads/${threadId}/artifacts/site`, {
		entry: "big.txt",
		files: [{ path: "big.txt", fileId: big }, { path: "big2.txt", fileId: big2 }],
	});
	expect(tooBig.status).toBe(400);
	expect((tooBig.body as { error: { message: string } }).error.message).toContain("artifacts.maxBytes");

	// files.maxBytes is checked against the recorded size, so a limit lowered after the upload
	// still binds the manifest. A lowered limit also shrinks the request body cap, so this is
	// checked where the manifest is checked rather than through the route.
	const twelve = await upload("twelve.txt", "0123456789ab");
	const caller = { kind: "user" as const, id: TEST_USER, url: t!.runtime.userUrl };
	t!.runtime.config.files.maxBytes = 10;
	await expect(
		publishArtifact(t!.runtime, caller, threadId, "direct", { entry: "twelve.txt", files: [{ path: "twelve.txt", fileId: twelve }] }),
	).rejects.toThrow(/files.maxBytes/);
	t!.runtime.config.files.maxBytes = 26214400;
	expect(await counts()).toMatchObject({ artifacts: 1, versions: 1, messages: 2 });
});

it("ART-02 the CLI refuses a symlink, an absolute path, or a missing entry before uploading anything", async () => {
	await start();
	const dir = buildDir({ "index.html": "<h1>ok</h1>" });
	symlinkSync(join(dir, "index.html"), join(dir, "link.html"));
	const uploaded: string[] = [];
	const upload = async (path: string) => {
		uploaded.push(path);
		return { id: t!.runtime.newId(), name: "x", url: `pana://${TEST_DOMAIN}/files/x/x`, mediaType: null };
	};

	// `--dir` is relative to the caller's cwd, so a relative build is the only shape that runs.
	return expect(
		(async () => {
			const cwd = process.cwd();
			process.chdir(dir);
			try {
				await expect(uploadBuild({ dir: "/tmp", name: "site" }, upload)).rejects.toThrow(/relative/);
				await expect(uploadBuild({ dir: join(dir, "index.html"), name: "site" }, upload)).rejects.toThrow(/relative/);
				await expect(uploadBuild({ dir: ".", name: "site" }, upload)).rejects.toThrow(/symlink/);
				rmSync(join(dir, "link.html"));
				await expect(uploadBuild({ dir: ".", name: "site", entry: "../index.html" }, upload)).rejects.toThrow(/relative/);
				await expect(uploadBuild({ dir: ".", name: "site", entry: "missing.html" }, upload)).rejects.toThrow(/entry/);
				expect(uploaded).toEqual([]);

				// The same refusal reaches the user as a usage error, before a byte moves.
				symlinkSync(join(dir, "index.html"), join(dir, "link.css"));
				const refused = await cli(["artifact", "publish", t!.runtime.newId(), "--dir", ".", "--name", "site"]);
				expect(refused.code).toBe(2);
				expect(refused.stderr).toContain("symlink");
				expect(await t!.runtime.db.get("SELECT id FROM files")).toBeUndefined();
			} finally {
				process.chdir(cwd);
			}
		})(),
	).resolves.toBeUndefined();
});

// --- ART-03 --------------------------------------------------------------------

it("ART-03 publish, list, and show answer a version", async () => {
	await start();
	const { id: threadId, session } = await thread();

	const first = await publishBuild(threadId, "site", { "index.html": "<h1>one</h1>" }, { caller: session, note: "first cut" });
	expect(first.status).toBe(201);
	expect(first.body.created).toBe(true);
	expect(first.body.version.seq).toBe(1);
	expect(first.body.artifact.threadId).toBe(threadId);
	expect(first.body.artifact.name).toBe("site");
	expect(first.body.artifact.url).toBe(`pana://${TEST_DOMAIN}/artifacts/${first.body.artifact.id}`);
	expect(first.body.version.url).toBe(`pana://${TEST_DOMAIN}/artifacts/${first.body.artifact.id}/v/1`);

	const listed = await t!.client.get<ListView>(`/threads/${threadId}/artifacts`);
	expect(listed.status).toBe(200);
	expect(listed.body.artifacts).toHaveLength(1);
	expect(listed.body.artifacts[0]).toMatchObject({ id: first.body.artifact.id, name: "site", threadId });
	const newest = listed.body.artifacts[0]!.newestVersion!;
	expect(newest).toMatchObject({ seq: 1, entry: "index.html", createdBy: session, createdAt: t!.clock.now() });

	// A second, different build lists as the newest version, and show keeps both oldest first.
	const second = await publishBuild(threadId, "site", { "index.html": "<h1>two</h1>" }, { caller: session, note: "second cut" });
	expect(second.status).toBe(201);
	expect(second.body.version.seq).toBe(2);
	const after = await t!.client.get<ListView>(`/threads/${threadId}/artifacts`);
	expect(after.body.artifacts[0]!.newestVersion!.seq).toBe(2);

	const shown = await show(first.body.artifact.id);
	expect(shown.versions.map((version) => [version.seq, version.note])).toEqual([[1, "first cut"], [2, "second cut"]]);
	for (const version of shown.versions as Array<VersionView & {previewUrl: string}>) {
		expect(pathOf(version.previewUrl)).toMatch(new RegExp(`^/a/${version.id}/[^/]+/$`));
		expect((await fetch(version.previewUrl)).status).toBe(200);
	}
	expect(shown.versions[0]!.files.map((file) => file.path)).toEqual(["index.html"]);
	expect(shown.versions.map(v => v.pinned)).toEqual([false, false]);
	// A versioned read mints a preview for the version it answers, not for the newest one.
	const pinned = await t!.client.get<ShowView>(`/artifacts/${first.body.artifact.id}?seq=1`);
	expect(pinned.body.versions.map(v => v.pinned)).toEqual([true, false]);
	expect((await t!.tcp.get(pathOf(pinned.body.versions[0]!.previewUrl))).raw.toString()).toBe("<h1>one</h1>");
	expect((await t!.client.get(`/artifacts/${first.body.artifact.id}?seq=9`)).status).toBe(404);

	// Unknown ids and threads are 404s, not empty answers.
	expect((await t!.client.get(`/threads/${t!.runtime.newId()}/artifacts`)).status).toBe(404);
	expect((await t!.client.get(`/artifacts/${t!.runtime.newId()}`)).status).toBe(404);
});

// --- ART-04 --------------------------------------------------------------------

it("ART-03 ART-17 the identical manifest is the existing version, and a retried publish adds nothing", async () => {
	await start();
	const { id: threadId, session } = await thread();
	const build = { "index.html": "<h1>one</h1>", "app.js": "run()" };

	const first = await publishBuild(threadId, "site", build, { caller: session, note: "first cut" });
	expect(first.status).toBe(201);

	// A retry after a lost response re-uploads the same bytes and re-publishes the same paths.
	// The manifest is the uploaded contents, not the upload ids, so this is the existing version:
	// 200, no v2, and no second message.
	const retried = await publishBuild(threadId, "site", build, { caller: session, note: "a changed note" });
	expect(retried.status).toBe(200);
	expect(retried.body.created).toBe(false);
	expect(retried.body.version.id).toBe(first.body.version.id);
	expect(retried.body.version.seq).toBe(1);
	expect(await t!.runtime.db.all("SELECT seq FROM artifact_versions")).toEqual([{ seq: 1 }]);
	expect(await t!.runtime.db.all("SELECT count(*) AS n FROM messages WHERE body LIKE '%published%'")).toEqual([{ n: 1 }]);
	// The accepted uploads of a refused publish are left behind, as ART-02 allows.
	expect(await t!.runtime.db.all("SELECT count(*) AS n FROM files")).toEqual([{ n: 4 }]);
});

it("ART-04 the user, a participant, and an objective's lead or member write; a stopped session does not", async () => {
	await start();
	const { id: threadId, session } = await thread();
	const outsider = await seedSession();

	const mine = await publishBuild(threadId, "site", { "index.html": "<h1>mine</h1>" });
	expect(mine.status).toBe(201);
	const theirs = await publishBuild(threadId, "site", { "index.html": "<h1>theirs</h1>" }, { caller: session });
	expect(theirs.status).toBe(201);
	expect(theirs.body.version.createdBy).toBe(session);

	const refused = await t!.client.post(`/threads/${threadId}/artifacts/site`, { entry: "index.html", files: [] }, { caller: outsider });
	expect(refused.status).toBe(403);

	// A stopped or archived session keeps read access and loses the write.
	const manifest = { entry: "index.html", files: [{ path: "index.html", fileId: await upload("index.html", "<h1>later</h1>", session) }] };
	for (const state of ["stopped", "archived"]) {
		await t!.runtime.db.write((tx) => tx.run("UPDATE sessions SET state = ? WHERE id = ?", state, session));
		expect((await t!.client.get(`/threads/${threadId}/artifacts`, { caller: session })).status, state).toBe(200);
		const write = await t!.client.post(`/threads/${threadId}/artifacts/site`, manifest, { caller: session });
		expect(write.status, state).toBe(403);
	}
});

it("ART-04 an objective's lead and members write to its thread; nobody else does", async () => {
	await start({ script: [{ text: "I lead this." }] });
	const made = await t!.client.post<{ objective: { id: string } }>("/objectives", { goal: "Cut the energy bill" });
	const launched = await t!.client.post<{ objective: { id: string; lead: { id: string }; thread: { id: string } } }>(
		`/objectives/${made.body.objective.id}/launch`,
	);
	expect(launched.status, JSON.stringify(launched.body)).toBe(200);
	const { lead, thread: objectiveThread } = launched.body.objective;
	const threadId = objectiveThread.id;

	const asLead = await publishBuild(threadId, "site", { "index.html": "<h1>lead</h1>" }, { caller: lead.id });
	expect(asLead.status).toBe(201);

	const member = await seedSession("idle", made.body.objective.id);
	const asMember = await publishBuild(threadId, "site", { "index.html": "<h1>member</h1>" }, { caller: member });
	expect(asMember.status).toBe(201);

	const stranger = await seedSession();
	const refused = await publishBuild(threadId, "site", { "index.html": "<h1>stranger</h1>" }, { caller: stranger });
	expect(refused.status).toBe(403);
	expect((refused.body as unknown as { error: { code: string } }).error.code).toBe("forbidden");
});

// --- ART-05 --------------------------------------------------------------------

it("ART-05 a publish appends one domain message, delivers nothing, and leaves the mailbox alone", async () => {
	await start();
	const { id: threadId, session } = await thread();
	const before = await counts();

	const published = await publishBuild(threadId, "site", { "index.html": "<h1>hi</h1>" }, { caller: session, note: "first" });
	expect(published.status).toBe(201);
	const after = await counts();
	expect(after).toMatchObject({
		messages: before.messages + 1,
		deliveries: before.deliveries,
		participants: before.participants,
		schedules: before.schedules,
	});

	const read = await t!.client.get<{ messages: MessageView[] }>(`/threads/${threadId}`);
	const appended = read.body.messages.at(-1)!;
	expect(appended.seq).toBe(before.messages + 1);
	// Authored by the domain participant, never by the publishing session (ART-20).
	expect(appended.sender).toMatchObject({ kind: "domain", url: `pana://${TEST_DOMAIN}` });
	expect(appended.sender.id).not.toBe(session);
	// It names the publisher, the artifact, the version, its time, and a pinned link; never a capability.
	const body = appended.body ?? "";
	expect(body).toContain(t!.runtime.url({ kind: "session", id: session }));
	expect(body).toContain("site");
	expect(body).toContain("v1");
	expect(body).toContain(`pana://${TEST_DOMAIN}/artifacts/${published.body.artifact.id}/v/1`);
	expect(body).toContain(new Date(t!.clock.now()).toISOString());
	expect(body).not.toContain("/a/");
	expect(body).not.toContain(published.body.previewUrl);

	// The thread inbox lists it as that thread's latest activity: a consequence of the append,
	// not a filter, and no delivery row made it appear there.
	const inbox = await t!.client.get<{ threads: Array<{ threadId: string; latest: { messageId: string } }> }>("/inbox?view=threads");
	expect(inbox.body.threads.find((entry) => entry.threadId === threadId)!.latest.messageId).toBe(appended.id);

	// A publish is not mail and unarchives nothing: an archived thread stays archived.
	expect((await t!.client.post(`/threads/${threadId}/archive`)).status).toBe(200);
	const second = await publishBuild(threadId, "site", { "index.html": "<h1>two</h1>" }, { caller: session });
	expect(second.status).toBe(201);
	expect(await t!.runtime.db.get("SELECT 1 FROM thread_archives WHERE thread_id = ? AND participant_id = ?", threadId, TEST_USER)).toBeTruthy();
	expect((await t!.client.get<{ threads: Array<{ threadId: string }> }>("/inbox?view=threads")).body.threads.some((entry) => entry.threadId === threadId)).toBe(false);
});

// --- ART-06 --------------------------------------------------------------------

it("ART-06 an objective's artifacts are its thread's, and a draft has none", async () => {
	await start({ script: [{ text: "I lead this." }] });
	const draft = await t!.client.post<{ objective: { id: string } }>("/objectives", { goal: "Retire the boiler" });
	const drafted = await t!.client.get<{ objective: Record<string, unknown> }>(`/objectives/${draft.body.objective.id}`);
	expect(drafted.body.objective.thread).toBeNull();

	const launched = await t!.client.post<{ objective: { id: string; lead: { id: string }; thread: { id: string } } }>(
		`/objectives/${draft.body.objective.id}/launch`,
	);
	const threadId = launched.body.objective.thread.id;
	await publishBuild(threadId, "site", { "index.html": "<h1>hi</h1>" });

	// The thread's artifacts are the objective's: read through the route the objective names.
	const shown = await t!.client.get<{ objective: { thread: { id: string } } }>(`/objectives/${draft.body.objective.id}`);
	expect(shown.body.objective.thread.id).toBe(threadId);
	const listed = await t!.client.get<ListView>(`/threads/${shown.body.objective.thread.id}/artifacts`);
	expect(listed.body.artifacts.map((artifact) => artifact.name)).toEqual(["site"]);
	// ART-06: the objective response gains no field of its own for its builds.
	expect(shown.body.objective).not.toHaveProperty("builds");
});

it("ART-06 a linked objective file stays a download and is never read as a build", async () => {
	await start({ script: [{ text: "I lead this." }] });
	const draft = await t!.client.post<{ objective: { id: string } }>("/objectives", { goal: "Retire the boiler" });
	const fileId = await upload("report.html", "<h1>report</h1>");
	const linked = await t!.client.post(`/objectives/${draft.body.objective.id}/artifacts`, { file: fileId });
	expect(linked.status, JSON.stringify(linked.body)).toBe(201);

	const view = await t!.client.get<{ objective: { artifacts: Array<{ id: string; name: string; url: string }> } }>(
		`/objectives/${draft.body.objective.id}`,
	);
	expect(view.body.objective.artifacts).toMatchObject([{ id: fileId, name: "report.html", url: `pana://${TEST_DOMAIN}/files/${fileId}/report.html` }]);
	// An uploaded file linked to an objective records no version: nothing becomes an executable preview.
	expect(await t!.runtime.db.all("SELECT seq FROM artifact_versions")).toEqual([]);
	expect(await t!.runtime.db.all("SELECT name FROM artifacts")).toEqual([]);
});

// --- ART-07 --------------------------------------------------------------------

it("ART-07 bytes come from the capability path, the root serves the entry, and everything else is refused", async () => {
	await start();
	const { id: threadId } = await thread();
	const published = await publishBuild(threadId, "site", {
		"index.html": "<h1>hello</h1>",
		"assets/app.js": "console.log(1)",
		"data.json": '{"ok":true}',
	});
	expect(published.status).toBe(201);
	const { previewUrl, version } = published.body;
	expect(new URL(previewUrl).origin).toBe(`http://localhost:${t!.panad.tcpPort}`);
	expect(pathOf(previewUrl)).toBe(`/a/${version.id}/${pathOf(previewUrl).split("/")[3]}/`);
	const capability = pathOf(previewUrl).split("/")[3]!;

	// The path segment is the capability, so a relative URL inside the build inherits it.
	const entry = await t!.tcp.get(pathOf(previewUrl));
	expect(entry.status, JSON.stringify(entry.body)).toBe(200);
	expect(entry.raw.toString()).toBe("<h1>hello</h1>");
	expect(entry.headers["content-type"]).toBe("text/html");

	const inherited = await t!.tcp.get(`/a/${version.id}/${capability}/assets/app.js`);
	expect(inherited.status).toBe(200);
	expect(inherited.raw.toString()).toBe("console.log(1)");
	expect(inherited.headers["content-type"]).toBe("text/javascript");
	const json = await t!.tcp.get(`/a/${version.id}/${capability}/data.json`);
	expect(json.headers["content-type"]).toBe("application/json");

	// An empty, foreign, or expired capability is 403; a path outside the manifest is 404.
	expect((await t!.tcp.get(`/a/${version.id}/`)).status).toBe(403);
	expect((await t!.tcp.get(`/a/${version.id}/not-a-capability/`)).status).toBe(403);
	const other = await publishBuild(threadId, "site2", { "index.html": "<h1>two</h1>" });
	const foreign = pathOf(other.body.previewUrl).split("/")[3]!;
	expect((await t!.tcp.get(`/a/${version.id}/${foreign}/`)).status).toBe(403);
	expect((await t!.tcp.get(`/a/${version.id}/${capability}/missing.js`)).status).toBe(404);

	await t!.clock.advance(61 * 60_000);
	expect((await t!.tcp.get(`/a/${version.id}/${capability}/`)).status).toBe(403);
});

it("ART-07 a publish reports root-relative references, and the build's relative ones are served", async () => {
	await start();
	const { id: threadId } = await thread();
	const published = await publishBuild(threadId, "site", {
		"index.html": '<script src="/assets/app.js"></script><link href="./site.css"><a href="//cdn.example/x">cdn</a>',
		"site.css": "body{color:red}",
	});
	expect(published.status).toBe(201);
	expect(published.body.entry).toBe("index.html");
	expect(published.body.warnings).toEqual(["index.html: root-relative reference /assets/app.js"]);

	// Two paths: the referenced relative ones are the manifest's, so they answer.
	const capability = pathOf(published.body.previewUrl).split("/")[3]!;
	expect((await t!.tcp.get(`/a/${published.body.version.id}/${capability}/site.css`)).status).toBe(200);
});

// --- ART-08 --------------------------------------------------------------------

it("ART-08 a capability is minted only by an authenticated route, and grants bytes and nothing else", async () => {
	await start();
	const { id: threadId } = await thread();
	// No bearer token, no caller: the write path refuses before it mints anything.
	const unauth = await fetch(`http://127.0.0.1:${t!.panad.tcpPort}/threads/${threadId}/artifacts/site`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ entry: "index.html", files: [] }),
	});
	expect(unauth.status).toBe(403);
	expect(((await unauth.json()) as { error: { code: string } }).error.code).toBe("unauthorized");

	const published = await publishBuild(threadId, "site", { "index.html": "<h1>hi</h1>" });
	const path = pathOf(published.body.previewUrl);
	// The bytes route is the one credential-free route.
	const anonymous = await fetch(`http://127.0.0.1:${t!.panad.tcpPort}${path}`);
	expect(anonymous.status).toBe(200);
	expect(await anonymous.text()).toBe("<h1>hi</h1>");
	// The same path is not a capability for another resource: it is a path on the bytes route only.
	const other = await fetch(`http://127.0.0.1:${t!.panad.tcpPort}/a/${published.body.version.id}/wrong/`);
	expect(other.status).toBe(403);
	// And a capability does not authenticate the API.
	const api = await fetch(`http://127.0.0.1:${t!.panad.tcpPort}/inbox`, { headers: { authorization: `Bearer ${path}` } });
	expect(((await api.json()) as { error: { code: string } }).error.code).toBe("unauthorized");
});

it("ART-08 the signing key is private state, capabilities are redacted from the log, and pana:// URLs carry none", async () => {
	await start();
	const { id: threadId } = await thread();
	const published = await publishBuild(threadId, "site", { "index.html": "<h1>hi</h1>" });
	const keyPath = join(t!.dir, "artifact-signing-key");
	expect(statSync(keyPath).mode & 0o777).toBe(0o600);
	expect(readFileSync(keyPath)).toHaveLength(32);

	// A preview is never a durable link: the pinned URLs the API returns carry no capability.
	expect(published.body.version.url).not.toContain("/a/");
	expect(published.body.artifact.url).not.toContain("/a/");

	const capability = pathOf(published.body.previewUrl).split("/")[3]!;
	await t!.tcp.get(pathOf(published.body.previewUrl));
	const log = readFileSync(join(t!.dir, "panad.log"), "utf8");
	expect(log).toContain("/a/[redacted]");
	expect(log).not.toContain(capability);

	// A key panad cannot read as its own refuses to serve: no bytes leave an unverifiable artifact.
	chmodSync(keyPath, 0o644);
	const refused = await t!.tcp.get(pathOf(published.body.previewUrl));
	expect(refused.status).toBe(500);
	expect(refused.raw.length).toBeLessThan(200);
});

// --- ART-16 --------------------------------------------------------------------

it("ART-16 pana artifact publish uploads the build, prints the three URLs, and reports the entry and warnings", async () => {
	await start();
	const { id: threadId } = await thread();
	const dir = buildDir({
		"index.html": '<script src="/assets/app.js"></script>',
		"assets/app.js": "console.log(1)",
	});

	const published = await cli(["artifact", "publish", threadId, "--dir", ".", "--name", "site", "--note", "first cut"], { cwd: dir });
	expect(published.code, published.stderr).toBe(0);
	const artifactId = (await t!.runtime.db.get<{ id: string }>("SELECT id FROM artifacts"))!.id;
	const versionId = (await t!.runtime.db.get<{ id: string }>("SELECT id FROM artifact_versions"))!.id;
	expect(published.stdout).toContain(`artifact:`);
	expect(published.stdout).toContain(`http://localhost:${t!.panad.tcpPort}/a/`);
	expect(published.stdout).toContain(`pana://${TEST_DOMAIN}/artifacts/${artifactId}`);
	expect(published.stdout).toContain(`pana://${TEST_DOMAIN}/artifacts/${artifactId}/v/1`);
	expect(published.stdout).toContain(`/a/${versionId}/`);
	expect(published.stdout).toContain("expires:");
	expect(published.stdout).toContain("entry: index.html");
	expect(published.stdout).toContain("index.html: root-relative reference /assets/app.js");

	// The preview the command printed is the one a reader opens.
	const previewLine = published.stdout.split("\n").find((line) => line.trim().startsWith("preview:"))!;
	const previewUrl = previewLine.slice(previewLine.indexOf("http://")).trim();
	const served = await fetch(previewUrl);
	expect(served.status).toBe(200);

	// `--json` carries the ids, the resolved version, and the preview with its expiry.
	const asJson = await cli(["artifact", "publish", threadId, "--dir", ".", "--name", "other", "--json"], { cwd: dir });
	expect(asJson.code, asJson.stderr).toBe(0);
	const body = JSON.parse(asJson.stdout) as PublishView;
	expect(body.created).toBe(true);
	expect(body.version.seq).toBe(1);
	expect(body.artifact.url).toBe(`pana://${TEST_DOMAIN}/artifacts/${body.artifact.id}`);
	expect(body.version.url).toBe(`pana://${TEST_DOMAIN}/artifacts/${body.artifact.id}/v/1`);
	expect(pathOf(body.previewUrl)).toMatch(new RegExp(`^/a/${body.version.id}/[^/]+/$`));
	expect(body.expiresAt).toBe(t!.clock.now() + 3_600_000);
	const jsonPreview = await fetch(`http://127.0.0.1:${t!.panad.tcpPort}${pathOf(body.previewUrl)}`);
	expect(jsonPreview.status).toBe(200);
	expect(body.warnings).toEqual(["index.html: root-relative reference /assets/app.js"]);
	// The version the entry names is the one the root serves.
	expect(body.entry).toBe("index.html");
	expect(artifactId).toBe((await t!.runtime.db.get<{ id: string }>("SELECT id FROM artifacts WHERE name = 'site'"))!.id);
	expect(versionId).toBe((await t!.runtime.db.get<{ id: string }>("SELECT id FROM artifact_versions WHERE artifact_id = ?", artifactId))!.id);

	const listed = await cli(["artifact", "list", threadId]);
	expect(listed.stdout).toContain("site");
	expect(listed.stdout).toContain(`pana://${TEST_DOMAIN}/artifacts/${artifactId}`);
	const shown = await cli(["artifact", "show", `pana://${TEST_DOMAIN}/artifacts/${artifactId}`]);
	expect(shown.stdout).toContain("first cut");
	expect(shown.stdout).toContain("assets/app.js");
});

// --- ART-17 --------------------------------------------------------------------

it("ART-17 a publish is one transaction: a crash at the message leaves no artifact, version, or message", async () => {
	await start();
	const { id: threadId } = await thread();
	const before = await counts();
	// Crash exactly where the domain message is appended: the artifact row, the version row, and
	// the file rows are already written inside the same transaction, and none of them may survive.
	t!.runtime.db.faults = (sql, index) => {
		if (/^\s*INSERT INTO messages/.test(sql)) throw new SimulatedCrash(index, sql);
	};
	const crashed = await publishBuild(threadId, "site", { "index.html": "<h1>boom</h1>" }).catch((error: unknown) => ({ error }));
	t!.runtime.db.faults = undefined;
	// The connection may die with the transaction; the durable result is what matters.
	expect(typeof crashed === "object" && crashed !== null).toBe(true);

	// The upload happened before the publish and stays unreferenced; the rest rolled back together.
	await t!.stop();
	const raw = await openNodeSqliteDatabase(join(t!.dir, "pana.sqlite"));
	try {
		expect(await raw.all("SELECT name FROM artifacts")).toEqual([]);
		expect(await raw.all("SELECT seq FROM artifact_versions")).toEqual([]);
		expect(await raw.all("SELECT * FROM artifact_version_files")).toEqual([]);
		expect(await raw.get("SELECT count(*) AS n FROM files")).toEqual({ n: before.files + 1 });
		expect(await raw.get("SELECT count(*) AS n FROM messages")).toEqual({ n: before.messages });
	} finally {
		await raw.close();
	}
	t = undefined;
});

// --- ART-18 --------------------------------------------------------------------

it("ART-18 artifacts config has three positive whole-number keys with defaults, and preserves unknown ones", async () => {
	const bare = parseConfig({ domain: TEST_DOMAIN, user: TEST_USER });
	expect(bare.artifacts).toEqual({ maxBytes: 5242880, maxFiles: 200, capMinutes: 60 });
	const set = parseConfig({
		domain: TEST_DOMAIN,
		user: TEST_USER,
		artifacts: { maxBytes: 1024, maxFiles: 3, capMinutes: 5, retentionDays: 7 },
	});
	expect(set.artifacts).toEqual({ maxBytes: 1024, maxFiles: 3, capMinutes: 5 });

	for (const bad of [{ maxBytes: 0 }, { maxFiles: -1 }, { capMinutes: 1.5 }, { maxBytes: "60" }, { capMinutes: null }]) {
		expect(() => parseConfig({ domain: TEST_DOMAIN, user: TEST_USER, artifacts: bad }), JSON.stringify(bad)).toThrow(ConfigError);
	}
	expect(() => parseConfig({ domain: TEST_DOMAIN, user: TEST_USER, artifacts: [] })).toThrow(/artifacts must be an object/);

	// A settings save rewrites config.json, so a key pana does not know survives it.
	await start();
	const read = await t!.client.get<{ config: Record<string, unknown>; configRevision: string }>("/settings");
	const saved = await t!.client.post("/settings", {
		config: { ...read.body.config, artifacts: { maxFiles: 10 }, extra: { keep: true } },
		configRevision: read.body.configRevision,
	});
	expect(saved.status, JSON.stringify(saved.body)).toBe(200);
	const onDisk = JSON.parse(readFileSync(join(t!.dir, "config.json"), "utf8")) as { artifacts: unknown; extra: unknown };
	expect(onDisk.artifacts).toEqual({ maxFiles: 10 });
	expect(onDisk.extra).toEqual({ keep: true });

	const docs = readFileSync(join(import.meta.dirname, "..", "docs", "configuration.md"), "utf8");
	for (const key of ["artifacts.maxBytes", "artifacts.maxFiles", "artifacts.capMinutes"]) expect(docs).toContain(key);
});

it("ART-18 a capability lasts artifacts.capMinutes, and the configured value applies on restart", async () => {
	const probe = await start({ config: { artifacts: { capMinutes: 2 } } });
	const { id: threadId } = await thread();
	const published = await publishBuild(threadId, "site", { "index.html": "<h1>hi</h1>" });
	expect(published.body.expiresAt).toBe(t!.clock.now() + 2 * 60_000);
	const config = JSON.parse(readFileSync(join(t!.dir, "config.json"), "utf8")) as Record<string, unknown>;
	writeFileSync(join(t!.dir, "config.json"), JSON.stringify({ ...config, artifacts: { capMinutes: 5 } }));
	await probe.stop();

	await start({ stateDir: probe.dir });
	expect(t!.runtime.config.artifacts.capMinutes).toBe(5);
	const shown = await show(published.body.artifact.id);
	expect(shown.versions[0]!.expiresAt).toBe(t!.clock.now() + 5 * 60_000);
	// Each authorized read renews the capability it hands back, and the older one still works
	// until its own expiry.
	expect((await t!.tcp.get(pathOf(published.body.previewUrl))).status).toBe(200);
});

// --- ART-20 --------------------------------------------------------------------

it("ART-20 the published message is the domain's, names the publisher, and a stopped session can still read it", async () => {
	await start();
	const { id: threadId, session } = await thread();
	const published = await publishBuild(threadId, "site", { "index.html": "<h1>hi</h1>" }, { caller: session });
	expect(published.body.version.createdBy).toBe(session);

	const read = await t!.client.get<{ messages: MessageView[] }>(`/threads/${threadId}`);
	const message = read.body.messages.at(-1)!;
	const domain = await t!.runtime.db.get<{ id: string; kind: string; url: string }>("SELECT id, kind, url FROM participants WHERE id = ?", message.sender.id);
	expect(domain).toEqual({ id: message.sender.id, kind: "domain", url: `pana://${TEST_DOMAIN}` });
	// The session's own row is not the sender: it would read as a post the session already made.
	expect(message.sender.id).not.toBe(session);
	expect(message.body).toContain(t!.runtime.url({ kind: "session", id: session }));

	// A stopped session keeps the read access it needs to retry its stale reply.
	await t!.runtime.db.write((tx) => tx.run("UPDATE sessions SET state = 'stopped' WHERE id = ?", session));
	expect((await t!.client.get(`/threads/${threadId}`, { caller: session })).status).toBe(200);
	expect((await t!.client.get(`/artifacts/${published.body.artifact.id}`, { caller: session })).status).toBe(200);
});

// --- ART-21 --------------------------------------------------------------------

it("ART-21 storage is reported per thread and overall, counting every version", async () => {
	await start();
	const one = await thread();
	const two = await thread();
	const a = await publishBuild(one.id, "site", { "index.html": "12345" });
	const b = await publishBuild(one.id, "site", { "index.html": "1234567890" });
	const c = await publishBuild(two.id, "report", { "index.md": "123" }, { entry: "index.md" });

	const stats = await t!.client.get<{ threads: Array<{ threadId: string; bytes: number }>; bytes: number }>("/stats/artifacts");
	expect(stats.status).toBe(200);
	expect(stats.body.threads).toEqual([
		{ threadId: one.id, bytes: 5 + 10 },
		{ threadId: two.id, bytes: 3 },
	]);
	expect(stats.body.bytes).toBe(18);
	expect([a, b, c].map((published) => published.status)).toEqual([201, 201, 201]);

	const printed = await cli(["stats", "artifacts"]);
	expect(printed.code, printed.stderr).toBe(0);
	expect(printed.stdout).toContain(one.id);
	expect(printed.stdout).toContain(two.id);
	expect(printed.stdout).toContain("18");

	// Withdrawing a version is not in this slice: no route deletes one.
	expect(ROUTES.some((route) => route.method === "DELETE" && route.pattern.startsWith("/artifacts"))).toBe(false);
	expect(matchRoute("DELETE", `/artifacts/${a.body.artifact.id}`)).toBeUndefined();
});

it("ART-21 the CLI and the route print the same numbers", async () => {
	await start();
	const { id: threadId } = await thread();
	await publishBuild(threadId, "site", { "index.html": "1234567890" });
	const { body } = await command("stats artifacts", {});
	expect(body).toEqual({ threads: [{ threadId, bytes: 10 }], bytes: 10 });
	expect(renderText(body)).toContain(threadId);
	expect(statusToExitCode(200)).toBe(0);
});
