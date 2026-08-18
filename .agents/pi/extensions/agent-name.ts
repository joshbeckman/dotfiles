import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { memoryPressureLevel, shouldSuppressMailWake, type MemoryPressureLevel } from "./resource-pressure.js";

// Names are allocated once and never reused. Each computer owns a permanent
// realm ("of Hearth", "of Lantern") and an append-only local claim registry, so
// computers allocate independently without producing the same public identity.
// Resuming reads the allocation rather than sampling again; legacy sessions are
// recovered from their scratchpad or session JSONL and keep their old name.
//
// Identity is injected into the system prompt rather than requested via a tool
// call: the model cannot forget or re-roll it, and it costs no turn. Name and
// scratchpad stay in one extension because the name is the directory slug.

const SCRATCH_ROOT = "/tmp/agent";
const IDENTITY_ROOT = join(homedir(), ".pi", "agent", "identities");
const REALM_FILE = join(homedir(), ".config", "agent-realm");

// A child process inherits the parent's surname and pid marker. A hot reload or
// /new stays in the same pid, so it must not mistake the current session for its
// parent and turn unrelated sessions into one family.
let inheritedSurname = process.env.AGENT_IDENTITY_PID !== String(process.pid) ? normalizeSurname(process.env.AGENT_SURNAME) : undefined;
const syntheticChildSessionId = inheritedSurname ? `subagent:${randomUUID()}` : undefined;

type NameContext = {
	cwd: string;
	hasUI: boolean;
	ui: { setStatus: (key: string, value: string | undefined) => void; theme: { fg: (color: string, value: string) => string } };
	sessionManager: { getSessionId: () => string | undefined; getSessionFile: () => string | undefined };
};

export default function (pi: ExtensionAPI) {
	let name: string | undefined;
	let realm: string | undefined;
	let scratchpad: string | undefined;
	let touchedAt = 0;
	let sweptAt = 0;
	let timer: ReturnType<typeof setInterval> | undefined;
	let activeAt = Date.now();
	let userAt = Date.now();
	const wakes: number[] = [];
	// Keyed by filename, which agent-mail never reuses, so a message announced
	// before a /resume is not re-announced after it.
	const announced = new Set<string>();

	pi.on("session_start", (_event, ctx: NameContext) => {
		// A package update can remove the directory inherited by a months-old Pi
		// process. Leaving the dead override in child env makes every headless spawn
		// crash before extensions load; without it, Pi uses its bundled resources.
		if (process.env.PI_PACKAGE_DIR) {
			try {
				statSync(process.env.PI_PACKAGE_DIR);
			} catch {
				delete process.env.PI_PACKAGE_DIR;
			}
		}

		const preferredSurname = inheritedSurname;
		inheritedSurname = undefined; // applies only to the first session in this child process, never /new
		const sessionFile = ctx.sessionManager.getSessionFile();
		const ephemeral = !ctx.hasUI && !sessionFile;
		// Pi still creates an in-memory id for --no-session. Identity follows the
		// process relationship, not that id: inherited subagents are public workers
		// worth naming; ordinary one-shot prompts remain anonymous and consume none.
		const sessionId = ephemeral && !preferredSurname ? undefined : ctx.sessionManager.getSessionId() ?? syntheticChildSessionId;
		realm = readRealm();
		name = sessionId ? assignedName(sessionId) ?? recoverName(sessionId, sessionFile) ?? (realm ? allocateName(sessionId, realm, preferredSurname) : undefined) : undefined;
		scratchpad = name && sessionId ? createScratchpad(name, sessionId, ctx) : undefined;
		// Exported rather than passed per-call: bash-tool children inherit the pi
		// process env, so agent-trailer and friends can read it without the model
		// having to remember to pass its own name (which it gets wrong).
		if (name) process.env.AGENT_NAME = name;
		else delete process.env.AGENT_NAME;
		const surname = nameSurname(name);
		if (surname) process.env.AGENT_SURNAME = surname;
		else delete process.env.AGENT_SURNAME;
		process.env.AGENT_IDENTITY_PID = String(process.pid);
		if (realm) process.env.AGENT_REALM = realm;
		else delete process.env.AGENT_REALM;
		if (scratchpad) process.env.AGENT_SCRATCHPAD = scratchpad;
		else delete process.env.AGENT_SCRATCHPAD;

		// One write, three surfaces: the session name flows into /resume, into the
		// terminal and tmux pane title via the titlebar extension's setTitle, and
		// into attention.ts marks. Labelling panes directly from here duplicated
		// that and let headless `pi -p` runs steal their parent pane's title.
		if (name && !pi.getSessionName()) pi.setSessionName(name);
		if (ctx.hasUI) ctx.ui.setStatus("agent-name", name ? ctx.ui.theme.fg("muted", `󰙃 ${name}`) : sessionId && !realm ? ctx.ui.theme.fg("warning", "⚠ set agent realm") : undefined);

		// A session sitting idle at the prompt fires no turn events, so the mail
		// indicator needs its own clock or it would only ever update on activity —
		// exactly the case where nobody is reading their inbox.
		if (ctx.hasUI) armPaneTitleReset();

		if (timer) clearInterval(timer);
		if (scratchpad && ctx.hasUI) {
			showUnread(ctx, scratchpad);
			timer = setInterval(() => {
				showUnread(ctx, scratchpad as string);
				sweptAt = sweep(sweptAt);
				wakeForMail();
			}, 60_000);
		}
	});

	// Any sign of work, not just turn starts: a turn that spends 20 minutes in
	// tool calls would otherwise look idle and get "woken" mid-stride.
	pi.on("tool_call", () => {
		activeAt = Date.now();
		return undefined;
	});

	// Josh typing is the only thing that unparks a session. Tracking his input
	// separately from agent activity is what lets a parked session answer mail
	// promptly: if a wake counted as presence, every message would have to wait out
	// another 10 minutes, and the hourly budget would never be the binding limit.
	pi.on("input", () => {
		userAt = Date.now();
		return undefined;
	});

	pi.on("before_agent_start", (event) => {
		activeAt = Date.now();
		if (!name) {
			if (!realm) {
				return {
					systemPrompt: `${event.systemPrompt}\n\nThis computer has no agent realm configured, so no durable session identity was allocated. Ask Josh to choose a unique realm and write it to ${REALM_FILE}; do not invent a temporary name, because public agent names are never reused.`,
				};
			}
			return;
		}
		if (scratchpad) touchedAt = keepAlive(scratchpad, touchedAt);
		const lines = [
			`Your name for this session is ${name}. Use it when you need to identify yourself — in scratch file names, branch names, tmux titles, notifications, or when the user asks who they are talking to. Do not mention it otherwise.`,
		];
		if (scratchpad) {
			lines.push(
				`Your scratchpad for this session is ${scratchpad} (already created, contains session.md). Put working notes, plans, drafts, diffs, and handoff documents there instead of in the repo. It survives across resumes of this session, but not across reboots or three days of session inactivity, so nothing durable belongs there.`,
			);
		}
		// Mail goes in a conversation message, not the system prompt. The system
		// prompt reads as facts established at session start, so a message that
		// arrived mid-session showed up there as a paradox: one agent spent its
		// reasoning deciding whether mail from an agent it had launched *after*
		// startup could really have been waiting at startup. An injected message
		// is timestamped and ordered, so arrival during the session is legible.
		const message = scratchpad ? mailNotice(scratchpad, announced, name) : undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${lines.join("\n\n")}`, ...(message ? { message } : {}) };
	});

	// Mail arriving mid-session used to wait for the agent's next turn, which for a
	// parked session meant waiting for Josh to come back — the one case where the
	// recipient most needed to act on its own. The wake is deliberately
	// unsupervised; the budget is what keeps two agents from mailing each other
	// awake all night.
	function wakeForMail() {
		if (!scratchpad || !name) return;
		// 10 rather than 15: senders were sitting through a quarter hour to learn
		// whether anyone was home. Short enough to feel answered, long enough that a
		// pause for thought is not read as leaving.
		if (Date.now() - userAt < 10 * 60_000) return; // Josh is here; mail can wait for his turn
		if (Date.now() - activeAt < 60_000) return; // a turn is in flight or just ended
		// Warning pressure still wakes the likely owner so it can inspect or stop
		// its own work. At critical pressure, mail stays unread rather than adding
		// another unsupervised turn; existing turns remain untouched.
		const pressure = memoryPressureLevel();
		if (shouldSuppressMailWake(pressure)) return;

		const hourAgo = Date.now() - 60 * 60_000;
		while (wakes.length > 0 && wakes[0] < hourAgo) wakes.shift();
		if (wakes.length >= 4) return;

		const message = mailNotice(scratchpad, announced, name, true, pressure);
		if (!message) return;
		wakes.push(Date.now());
		activeAt = Date.now(); // the woken turn has not started yet; keep the next tick from firing too
		// followUp rather than steer: if a turn is somehow still running, mail waits
		// for its tool calls to finish instead of cutting into them.
		pi.sendMessage(message, { deliverAs: "followUp", triggerTurn: true });
	}

	pi.on("session_shutdown", (_event, ctx: NameContext) => {
		if (timer) clearInterval(timer);
		timer = undefined;
		if (ctx.hasUI) {
			ctx.ui.setStatus("agent-name", undefined);
			ctx.ui.setStatus("agent-mail", undefined);
		}
	});
}

// A dead agent's name on a live shell pane is a lie, and the pane-border format
// keeps showing it until something writes a new title. Reset to the hostname
// rather than an empty string: that is a fresh pane's default, and the
// choose-tree and pane-border formats already treat title==host as "no title"
// and fall back to the running command.
//
// Callers gate on hasUI. Headless `pi -p` runs inherit TMUX_PANE from whatever
// interactive session spawned them and would otherwise wipe its title on exit,
// which is the same hijack that made direct pane labelling a bad idea.
let paneResetArmed = false;

// On process exit, not session_shutdown: pi's own teardown writes the terminal
// title after extension shutdown handlers run, so resetting there loses the
// race. process.on("exit") is the last synchronous word.
function armPaneTitleReset() {
	if (paneResetArmed) return;
	paneResetArmed = true;
	process.on("exit", resetPaneTitle);
}

function resetPaneTitle() {
	const pane = process.env.TMUX_PANE;
	if (!process.env.TMUX || !pane) return;

	// attention.ts restores its snapshotted title on shutdown too. Dropping the
	// snapshot first makes its restore a no-op, so the two cannot fight over
	// ordering: whichever handler runs last, the pane ends up reset.
	try {
		rmSync(join(homedir(), ".pi", "agent", "attention", `${pane.replace(/[^A-Za-z0-9_.-]/g, "_")}.panetitle`), { force: true });
	} catch {}

	try {
		execFileSync("tmux", ["select-pane", "-t", pane, "-T", hostname()], { stdio: "ignore" });
	} catch {} // never let a cosmetic reset break shutdown
}

type Unread = { file: string; from: string; subject: string; at: number };

function unreadSummary(scratchpad: string): Unread[] {
	try {
		return readdirSync(join(scratchpad, "inbox", "new"))
			.filter((f) => f.endsWith(".md"))
			.map((f) => {
				const path = join(scratchpad, "inbox", "new", f);
				try {
					// Headers only. Subjects make the notice triageable without spending
					// a turn on `agent-mail read`; bodies stay unread until asked for.
					const text = readFileSync(path, "utf8").split(/\n\s*\n/, 1)[0] ?? "";
					return {
						file: f,
						from: /^From: (.*)$/m.exec(text)?.[1]?.trim() || "unknown",
						// agent-mail writes a literal "(no subject)" placeholder; treat it as
						// absent so the notice does not quote it like a real subject line.
						subject: (/^Subject: (.*)$/m.exec(text)?.[1]?.trim() || "").replace(/^\(no subject\)$/, ""),
						at: statSync(path).mtimeMs,
					};
				} catch {
					return { file: f, from: "unknown", subject: "", at: 0 }; // raced a concurrent `agent-mail read` moving it to cur/
				}
			});
	} catch {
		return []; // no inbox yet: nobody has written to this session
	}
}

// Announced once per message, not once per turn: repeating it every turn would
// train the model to skim past it, and the 4h `agent-mail sweep` escalation to
// Josh already covers mail that gets ignored.
function mailNotice(
	scratchpad: string,
	announced: Set<string>,
	name: string,
	woken = false,
	pressure?: MemoryPressureLevel,
) {
	const fresh = unreadSummary(scratchpad).filter((m) => !announced.has(m.file));
	if (fresh.length === 0) return undefined;
	for (const m of fresh) announced.add(m.file);

	// Headers only, never bodies: a flag on the doorframe, not a knock. Reading
	// stays the agent's decision.
	const lines = fresh.map(
		(m) =>
			`- from ${m.from} · ${m.subject ? `"${m.subject}"` : "(no subject)"} · at ${m.at ? new Date(m.at).toLocaleTimeString() : "unknown time"} (${describeAge(m.at)})`,
	);
	const self = scratchpad.split("/").pop() || "you";
	return {
		customType: "agent-mail",
		// Named recipient rather than a disclaimer about who did not send it. A
		// custom_message sits where the user's turns sit, so an unaddressed notice
		// reads as Josh forwarding his own mail; "to <name>" settles it in passing.
		content: [
			// Name here, inbox id only in the command below, where it is an argument
			// rather than a label.
			`agent-mail — ${fresh.length} unread message${fresh.length === 1 ? "" : "s"} to ${name}:`,
			lines.join("\n"),
			`Reading and/or reply: \`agent-mail read --to ${self}\`.`,
			...(woken && pressure === 2
				? ["System memory pressure is warning (2). Before starting more work, check whether this session owns processes that can be stopped or reduced."]
				: []),
			...(woken
				? [
						"This message woke an idle session, so Josh is probably not watching. Read it, do what it asks if it is safe to do unattended, reply only if you have something to say, and then stop rather than looking for other work.",
					]
				: []),
		].join("\n"),
		display: true,
	};
}

function describeAge(at: number): string {
	if (!at) return "age unknown";
	const mins = Math.round((Date.now() - at) / 60_000);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.round(mins / 60);
	return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function showUnread(ctx: NameContext, scratchpad: string) {
	const count = unreadSummary(scratchpad).length;
	ctx.ui.setStatus("agent-mail", count > 0 ? ctx.ui.theme.fg("warning", `✉ ${count}`) : undefined);
}

// Any live session sweeps every inbox, because the recipient of an ignored
// message is by definition not running to escalate on its own behalf.
function sweep(sweptAt: number): number {
	const now = Date.now();
	if (now - sweptAt < 30 * 60 * 1000) return sweptAt;
	execFile("agent-mail", ["sweep"], { timeout: 10_000 }, () => {}); // fire and forget; absent on machines without dotfiles
	return now;
}

function readRealm(): string | undefined {
	try {
		const raw = (process.env.AGENT_REALM || readFileSync(REALM_FILE, "utf8")).trim();
		if (!/^[a-z][a-z-]*$/i.test(raw)) return undefined;
		return `${raw[0].toUpperCase()}${raw.slice(1).toLowerCase()}`;
	} catch {
		return undefined;
	}
}

type Assignment = { sessionId: string; name: string; assignedAt: string };

function sessionKey(sessionId: string): string {
	// The full hash is only a local filename, never part of the agent's public
	// identity. Hashing accepts hand-written test ids without letting slashes or
	// other path characters escape the registry.
	return createHash("sha256").update(sessionId).digest("hex");
}

function assignedName(sessionId: string): string | undefined {
	try {
		const assignment = JSON.parse(readFileSync(join(IDENTITY_ROOT, "by-session", sessionKey(sessionId)), "utf8")) as Assignment;
		return assignment.sessionId === sessionId && assignment.name ? assignment.name : undefined;
	} catch {
		return undefined;
	}
}

function recoverName(sessionId: string, sessionFile: string | undefined): string | undefined {
	// Scratchpads are the strongest legacy source: session.md carries the full id
	// and the original name together. Do not infer identity from directory mtimes
	// or "newest" paths; that already deleted one live agent's scratchpad.
	try {
		for (const entry of readdirSync(SCRATCH_ROOT, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			try {
				const text = readFileSync(join(SCRATCH_ROOT, entry.name, "session.md"), "utf8");
				if (!text.split("\n").includes(`- session: ${sessionId}`)) continue;
				const name = /^# (.+)$/m.exec(text)?.[1]?.trim();
				if (name) return preserveAssignment(sessionId, name);
			} catch {} // another process may be creating or pruning an unrelated dir
		}
	} catch {}

	// A cleaned scratchpad can still be resumed from its durable Pi JSONL. Named
	// session titles are "<agent> · <topic>"; walk newest-first so an early title
	// from before the naming extension cannot win.
	if (sessionFile) {
		try {
			const lines = readFileSync(sessionFile, "utf8").split("\n").reverse();
			for (const line of lines) {
				if (!line.includes('"type":"session_info"') || !line.includes(" · ")) continue;
				try {
					const event = JSON.parse(line) as { name?: string };
					const candidate = event.name?.split(" · ", 1)[0]?.trim();
					if (candidate && /^[A-Z][A-Za-z'-]+ [A-Z][A-Za-z'-]+(?: of [A-Z][A-Za-z'-]+)?$/.test(candidate)) {
						return preserveAssignment(sessionId, candidate);
					}
				} catch {}
			}
		} catch {}
	}
	return undefined;
}

function preserveAssignment(sessionId: string, name: string): string {
	mkdirSync(join(IDENTITY_ROOT, "by-name"), { recursive: true });
	try {
		writeFileSync(join(IDENTITY_ROOT, "by-name", nameSlug(name)), `${sessionId}\n`, { flag: "wx" });
	} catch {} // an old duplicate is history to preserve, not silently rename
	writeAssignment(sessionId, name);
	return name;
}

function allocateName(sessionId: string, realm: string, preferredSurname: string | undefined): string | undefined {
	mkdirSync(join(IDENTITY_ROOT, "by-name"), { recursive: true });
	for (let attempt = 0; attempt < 1000; attempt += 1) {
		try {
			// A spawned process stays in its parent's project family by default. This
			// is a preference rather than a smaller hard namespace: after 64 claimed
			// candidates, fall back to the realm's full pool instead of failing.
			const args = ["--full", "--seed", `${sessionId}:${attempt}`];
			if (preferredSurname && attempt < 64) args.push("--surname", preferredSurname);
			const base = execFileSync("random-name", args, { encoding: "utf8", timeout: 2000 }).trim();
			if (!base) return undefined;
			const name = `${base} of ${realm}`;
			const claim = join(IDENTITY_ROOT, "by-name", nameSlug(name));
			try {
				writeFileSync(claim, `${sessionId}\n`, { flag: "wx" });
				writeAssignment(sessionId, name);
				return name;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
				try {
					if (readFileSync(claim, "utf8").trim() === sessionId) {
						writeAssignment(sessionId, name); // recovered a crash between the two writes
						return name;
					}
				} catch {}
			}
		} catch {
			return undefined; // random-name lives in dotfiles/bin; absent on machines without it
		}
	}
	return undefined; // corrupt or exhausted registry; do not reuse an identity
}

function writeAssignment(sessionId: string, name: string) {
	const dir = join(IDENTITY_ROOT, "by-session");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, sessionKey(sessionId));
	const tmp = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
	const assignment: Assignment = { sessionId, name, assignedAt: new Date().toISOString() };
	writeFileSync(tmp, `${JSON.stringify(assignment)}\n`, { flag: "wx" });
	renameSync(tmp, path); // same-session races write identical identity atomically
}

function nameSlug(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function nameSurname(name: string | undefined): string | undefined {
	return normalizeSurname(name?.split(/\s+/)[1]);
}

function normalizeSurname(value: string | undefined): string | undefined {
	const surname = value?.trim();
	return surname && /^[A-Za-z][A-Za-z'-]*$/.test(surname) ? surname : undefined;
}

function createScratchpad(name: string, sessionId: string, ctx: NameContext): string | undefined {
	// The slug alone collides across the ~24k name space; the id suffix keeps two
	// live sessions from writing over each other's notes.
	const dir = join(SCRATCH_ROOT, `${name.toLowerCase().replace(/\s+/g, "-")}-${sessionId.slice(0, 8)}`);
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "session.md"),
			[
				`# ${name}`,
				"",
				`- session: ${sessionId}`,
				`- session file: ${ctx.sessionManager.getSessionFile() ?? "(none)"}`,
				`- cwd: ${ctx.cwd}`,
				`- git: ${gitDescribe(ctx.cwd)}`,
				`- started: ${new Date().toISOString()}`,
				"",
			].join("\n"),
			{ flag: "wx" }, // resumed sessions keep the original metadata and any appended notes
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return dir;
		return undefined;
	}
	return dir;
}

// macOS tmp_cleaner deletes /tmp files whose atime, mtime, AND ctime are all
// older than 3 days, so a note written once early in a long-running session
// would vanish under it. Restamping on activity ties the scratchpad's lifetime
// to the session's rather than to each file's, which is the semantics we want:
// it ages out 3 days after the session goes quiet, not 3 days after a write.
function keepAlive(dir: string, touchedAt: number): number {
	const now = Date.now();
	if (now - touchedAt < 6 * 60 * 60 * 1000) return touchedAt; // hourly-ish is ample against a 3-day threshold
	try {
		const stamp = new Date(now);
		utimesSync(dir, stamp, stamp);
		for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
			try {
				utimesSync(join(entry.parentPath, entry.name), stamp, stamp);
			} catch {} // a file the agent deleted mid-walk is not worth failing the turn over
		}
	} catch {
		return touchedAt;
	}
	return now;
}

function gitDescribe(cwd: string): string {
	try {
		return execFileSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).trim();
	} catch {
		return "(not a git repo)";
	}
}
