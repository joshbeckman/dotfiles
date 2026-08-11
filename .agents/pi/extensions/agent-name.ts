import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Names are derived from the session id rather than drawn fresh, so resuming or
// reloading a session keeps the same name and the same scratchpad instead of
// giving the agent amnesia. Both are injected into the system prompt rather than
// requested via a tool call: the model can't forget to do it, and it costs no turn.
//
// Name and scratchpad live in one extension because the name is the directory
// slug — splitting them would mean duplicating the derivation or exporting state.

const SCRATCH_ROOT = "/tmp/agent";

type NameContext = {
	cwd: string;
	hasUI: boolean;
	ui: { setStatus: (key: string, value: string | undefined) => void; theme: { fg: (color: string, value: string) => string } };
	sessionManager: { getSessionId: () => string | undefined; getSessionFile: () => string | undefined };
};

export default function (pi: ExtensionAPI) {
	let name: string | undefined;
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
		const sessionId = ctx.sessionManager.getSessionId();
		name = generateName(sessionId);
		// Ephemeral runs (pi -p --no-session) get no scratchpad; one-shot prompts
		// would otherwise litter /tmp/agent with dirs nobody reads.
		scratchpad = name && sessionId ? createScratchpad(name, sessionId, ctx) : undefined;
		// Exported rather than passed per-call: bash-tool children inherit the pi
		// process env, so agent-trailer and friends can read it without the model
		// having to remember to pass its own name (which it gets wrong).
		if (name) process.env.AGENT_NAME = name;
		if (scratchpad) process.env.AGENT_SCRATCHPAD = scratchpad;

		// One write, three surfaces: the session name flows into /resume, into the
		// terminal and tmux pane title via the titlebar extension's setTitle, and
		// into attention.ts marks. Labelling panes directly from here duplicated
		// that and let headless `pi -p` runs steal their parent pane's title.
		if (name && !pi.getSessionName()) pi.setSessionName(name);
		if (ctx.hasUI) ctx.ui.setStatus("agent-name", name ? ctx.ui.theme.fg("muted", `󰙃 ${name}`) : undefined);

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
		if (!name) return;
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

		const hourAgo = Date.now() - 60 * 60_000;
		while (wakes.length > 0 && wakes[0] < hourAgo) wakes.shift();
		if (wakes.length >= 4) return;

		const message = mailNotice(scratchpad, announced, name, true);
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
function mailNotice(scratchpad: string, announced: Set<string>, name: string, woken = false) {
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

function generateName(sessionId: string | undefined): string | undefined {
	try {
		const args = ["--full"];
		if (sessionId) args.push("--seed", sessionId);
		return execFileSync("random-name", args, { encoding: "utf8", timeout: 2000 }).trim() || undefined;
	} catch {
		return undefined; // random-name lives in dotfiles/bin; absent on machines without it
	}
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
