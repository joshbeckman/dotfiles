<img src="web/favicon.svg" alt="The pana icon: an orange and a black strand woven together" width="96" height="96">

# pana

Pana is a meta-harness for agent sessions. Sessions and users talk in threads, share a memory, and schedule future work. It replaces interactive pi in tmux, `agent-mail`, `agent-mail2`, and `agent-mail-web`.

Pana runs sessions on [pi-durable](https://github.com/earendil-works/pi/tree/main/packages/durable) with SQLite storage. It is CLI-first, with a progressive web app (PWA) for users.

[SPEC.md](SPEC.md) lists the behaviors that prove it works, grouped into work packages.

```sh
pana session create --prompt "what is the capital of france"
# creates a session and a thread between the caller and the session
# the session's answer is posted to that thread
```

<p>
  <img src="docs/inbox.png" alt="The pana inbox: one row per thread, with participants, the latest message, and unread counts" width="49%">
  <img src="docs/thread.png" alt="A pana thread: messages from the user and two sessions, each with its own colored border, above the reply box" width="49%">
</p>
<p>
  <img src="docs/session.png" alt="A pana session: its pinned header with state, model, cost, and controls, above the transcript" width="74%">
  <img src="docs/thread-phone.png" alt="A pana thread on a phone" width="24%">
</p>

The screenshots come from the browser test domain. Regenerate them with `node test/browser/screens.ts DIR LABEL`.

## Run it

Set pana up as a service in six steps. Each step is safe to repeat.

1. **Update the dotfiles.** Run `git pull` in the checkout, then `dfm install` (or `./setup`), so `~/Library/LaunchAgents/org.joshbeckman.panad.plist` links to the repo. The two-hour refresh does this, but only on a checkout that can fast-forward.

2. **Store the provider keys in `s`.** `bin/panad-service` injects each provider key the store holds, such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `FIREWORKS_API_KEY` (its `--help` lists them all). Panad writes no key to disk.

   ```sh
   s set FIREWORKS_API_KEY        # prompts, masked; or pipe a value to: s set NAME --stdin
   s list                         # names only, values redacted
   ```

   To reuse the API keys pi already has, pipe each `api_key` entry of `~/.pi/agent/auth.json` into `s set NAME --stdin`. An OAuth entry there has no key panad can use.

3. **Write `~/.local/state/pana/config.json`.** Only `domain` and `user` are required; [SPEC.md](SPEC.md) CFG-03 lists the rest.

   ```json
   {
     "domain": "lantern.joshbeckman.org",
     "user": "joshbeckman",
     "defaultModel": "fireworks/accounts/fireworks/models/deepseek-v4p1-flash-1017"
   }
   ```

4. **Install dependencies:** `cd pana && npm ci`.

5. **Start the service.** It starts `panad` only once `config.json` and `pana/node_modules` exist; until then it exits cleanly and stays down, so merging this onto a machine that is not set up for pana changes nothing.

   ```sh
   launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/org.joshbeckman.panad.plist
   launchctl kickstart -k "gui/$(id -u)/org.joshbeckman.panad"   # restart after a change
   ```

   On Linux, `setup` enables `panad.service`; restart it with `systemctl --user restart panad`. The log is `~/Library/Logs/panad.log` on macOS and `journalctl --user -u panad` on Linux. It names the providers panad registered and prints the launch URL:

   ```
   panad: listening on ~/.local/state/pana/panad.sock and http://127.0.0.1:8766
   panad: model providers: anthropic, fireworks, openai
   panad: open http://localhost:8766/#<web-token>
   ```

6. **Open the PWA.** Open the launch URL in a browser. The part after `#` is the web token, also kept in `~/.local/state/pana/web-token` (mode 0600). The URL uses `localhost`, because Safari answers "denied" to notifications on `127.0.0.1`. A Safari web app added to the Dock starts with empty storage and shows **Authorize this app**: copy the token and paste it there.

   ```sh
   pbcopy < ~/.local/state/pana/web-token
   ```

   For a phone, serve the port over HTTPS on the tailnet and open the `https://` launch URL that `panad` prints:

   ```sh
   tailscale serve --bg 8766
   ```

   Treat the token like a password. Scripts that use loopback TCP send it as `Authorization: Bearer <token>`; the `pana` CLI uses the Unix socket and needs none.

Check it with a real session:

```sh
pana session create --prompt "What is the capital of France? Answer in one word."
pana thread read THREAD
```

### Replacing agent-mail-web

Pana's PWA replaces the Agent Mail web bridge. Both want the tailnet's `/`, so stop the bridge and move Tailscale Serve to pana. `launchctl disable` keeps the bridge off after a reboot, even though `dfm install` still links its plist.

```sh
launchctl bootout "gui/$(id -u)/org.joshbeckman.agent-mail-web"
launchctl disable "gui/$(id -u)/org.joshbeckman.agent-mail-web"
tailscale serve --bg 8766
```

Agents still send mail with `agent-mail`, and `agent-mail inbox @josh` and `notify-josh` keep working; only the web UI moves. To bring the bridge back, run `launchctl enable` on the same label, `launchctl bootstrap` its plist, and `tailscale serve --bg 8765`.

### Other ways to run it

Run `panad` in the foreground with a key in its environment: `s FIREWORKS_API_KEY -- pana/bin/panad`. `PANA_STATE` selects another state directory, for both `panad` and the CLI.

To try pana from this checkout without installing the service, run `pana/scripts/try`. It writes a scratch `config.json` in `~/tmp/pana-try` (`PANA_STATE` overrides) on first run, reads the anthropic, openai, and fireworks keys from pi's `~/.pi/agent/auth.json` into `panad` only, and starts `panad` in the foreground. `--fresh` wipes the scratch state first.

`pana/scripts/smoke` checks a real model end to end on a throwaway state directory: `s FIREWORKS_API_KEY -- pana/scripts/smoke`. Add `--keep` to leave that `panad` running for a look in the PWA.

## Goals

- One place to see every session, thread, and memory edit on a domain.
- Idle sessions cost nothing but storage. Mail wakes them.
- Every write is attributed to a URL. Threads and memory share one concurrency rule: append against a known head, or be rejected.
- Agents and users use the same CLI. The PWA is the only interface a session can assume a user reads.

## Non-goals

- Cross-domain messaging in v1. URLs carry the domain so federation stays possible later.
- Multiple humans per domain in v1.
- A bridge to interactive pi. Pana replaces it.
- Migrating agent-mail history. Pana starts empty.

## Concepts

| Term | Meaning | URL |
|---|---|---|
| Domain | One machine's workspace. Formerly "realm". Globally unique, e.g. `lantern.joshbeckman.org`. | `pana://<domain>` |
| User | A human on the domain. The username is the ID, e.g. `joshbeckman`. | `pana://<domain>/users/<username>` |
| Session | One agent conversation in pi-durable. | `pana://<domain>/sessions/<ulid>` |
| Participant | A user or a session. | |
| Thread | An append-only list of messages between participants. | `pana://<domain>/threads/<ulid>` |
| Message | One entry in a thread. | `pana://<domain>/threads/<ulid>?message=<ulid>` |
| File | An attachment stored on disk. | `pana://<domain>/files/<ulid>/<name>` |
| Inbox | A participant's messages, with read state. | |
| Memory | A git repo of Markdown files shared by the domain. | |
| Schedule | A stored future session or message. | `pana://<domain>/schedules/<ulid>` |

IDs are ULIDs, except usernames. Every command accepts a URL or a bare ID. In an address list, a bare ULID is a session and anything else is a username. ULIDs are 26 uppercase Crockford characters and usernames are lowercase, so the two never collide.

A session has no name. Its URL is its identity, its attribution, and its address. All sessions are the same agent; they differ only in configuration and transcript.

## Architecture

```
  pana CLI ──unix socket──┐
                          ├── panad ── pana.sqlite (pi-durable + pana tables)
  PWA ──────HTTP──────────┘     ├───── files/
                                ├───── scratch/<session>/
                                └───── memory.git (bare) + worktrees
```

- `panad` is the only process that opens `pana.sqlite`. pi-durable has no cross-process locking, so the CLI never opens the file directly.
- State lives under `~/.local/state/pana/`: `pana.sqlite`, `files/`, `scratch/`, and `memory.git`.
- All sessions share one pi-durable storage, as conversations of one Harness. pi-durable tables use the `pi_` prefix. Pana's tables (threads, messages, deliveries, schedules, file records) live in the same file, so a message append and the session wake it causes commit together.
- `panad` binds HTTP to loopback. Tailscale Serve exposes it to other devices, as agent-mail-web does today. `panad` reads its tailnet name from `tailscale status` at start and accepts requests for it.
- `panad` registers a model provider for each pi-ai provider whose API key is in its environment, such as `FIREWORKS_API_KEY`, `ANTHROPIC_API_KEY`, or `OPENAI_API_KEY`. A model ID is `provider/model-id`, e.g. `fireworks/accounts/fireworks/models/deepseek-v4p1-flash-1017`.
- `panad` runs under launchd on macOS and a systemd user unit on Linux. Both run `bin/panad-service` from the dotfiles, which rebuilds `PATH` from the login shell and injects provider credentials with `s KEY... -- panad`. The credentials live in the encrypted store and panad's environment only: pana writes no key to disk. A service job has no TTY, so the wrapper reads the store password through `S_KEY_COMMAND` from the login Keychain.
- Runtime is Node, because pi-durable is TypeScript.

### Isolation from pi

Pana runs beside the current pi setup and shares nothing with it.

- `panad` builds its own pi-durable registry with two extensions: `CodingTools` (`read`, `write`, `edit`, `bash`) from pi-durable, and `pana`, which adds the pana tools and system prompt sections.
- Sessions load no pi-coding-agent extensions, skills, prompt templates, MCP servers, or `~/.pi/agent/AGENTS.md`.
- The `bash` tool runs commands with a clean environment: `PATH` (with pana's own `bin` first, so `pana` in a session is this `panad`'s build), `HOME`, `USER`, `LANG`, `TERM=dumb`, `PANA_SESSION`, `PANA_STATE`, `PANA_SCRATCH`, and the `GIT_CONFIG_*` variables that set pana's hook directory. `PANA_STATE` points `pana` in `bash` at the session's own `panad`. Provider credentials stay in `panad`. `AGENT_*` and `PI_*` variables never reach a session.
- A `bash` call that names no timeout stops after `tools.bashTimeoutSec` in `config.json` (600 seconds by default). Pana kills the command's whole process group, and the model gets an error result that says the call timed out.
- Pana keeps its state under `~/.local/state/pana/` and reads no other agent state.

### System prompt

The `pana` extension renders these sections, in order:

1. **Project.** Every `AGENTS.md` from the root of the `cwd` repo down to `cwd`.
2. **Pana.** `pana/prompt.md`, loaded only by pana. It explains threads, replies, memory, and the session's own URL, and holds hints such as where memory lives and how to search it.
3. **Profile.** The profile's instructions, rendered last as pi-durable `instructions`.

Sections that change every run, such as the current time, stay out of the prompt so provider caches stay warm.

### Tools

Every pana tool wraps one CLI command with the same arguments, output, and exit codes. A session can use either. The tools are `pana_reply`, `pana_thread_read`, `pana_thread_create`, `pana_session_create`, `pana_memory_search`, `pana_memory_commit`, and `pana_schedule_wake`.

### Commit attribution

Every commit a session authors carries this trailer, whose address is your own `user.email`
from git config (GitHub parses that field for coauthor credit; a session has no mailbox):

```
Co-authored-by: AI pana://<domain>/sessions/<ulid> <user.email>
```

The `bash` tool sets `core.hooksPath` through `GIT_CONFIG_COUNT` to pana's hook directory. Pana's `prepare-commit-msg` adds the trailer with `git interpret-trailers --if-exists addIfDifferent`. Each pana hook then runs the repo's own hook of the same name, so repo hooks still run.

## Sessions

### Lifecycle

| State | Meaning |
|---|---|
| `running` | A pi-durable run is in progress. |
| `waiting` | Asleep on a timer or a child task. |
| `idle` | No run. Wakes on mail. |
| `failed` | The last run failed. Wakes on mail. |
| `stopped` | A user stopped it. Mail queues but does not wake it. |
| `archived` | Read-only. |

An idle session holds no task. `panad` sets pi-durable's `contextRetentionMs` to 0, so an idle session's context leaves memory as soon as its run ends. "Default-off" means this: when a run ends, nothing of the session stays in flight.

A session cannot own a background process that outlives its run.

### Mail delivery

When a message lands in a session's inbox:

- **Idle or failed:** `panad` submits the message as a pi-durable input with entry kind `pana.message`. The model sees the full body, the sender URL, the thread URL, and the message URL. Delivery marks it read.
- **Running, message from a user:** the message is a steer. It joins the current run after its tool round, or starts the next run if the current one ends first.
- **Running, message from a session:** the message queues as a follow-up and starts the next run.
- **Stopped:** the message waits in the inbox.

### Replies

When a user's message starts a run, or the thread's first message does (the prompt that created the session), the run's final assistant message posts to that thread. Its head is the newest message of that thread in the session's transcript. If the thread moved during the run, `panad` does not post the reply. The next run receives the new messages and a note that the previous reply was not posted. An empty final message posts nothing.

When another session's follow-up starts a run, nothing posts automatically. Two sessions that auto-replied to each other would wake each other forever. A session that has something to say back uses `pana_reply`, and `pana/prompt.md` tells it not to reply just to acknowledge, agree, thank, or sign off.

To post to another thread, or mid-run, a session uses the `pana_reply` tool or `pana thread respond`.

### Limits

- Spawn depth is capped. A session at the cap cannot create sessions.
- Each session and the domain have a cost budget. Exceeding it stops the session and mails its creator.

### Commands

```sh
pana session create --prompt TEXT [--model M] [--thinking LEVEL] [--cwd DIR] [--profile NAME] [--to ADDRS]
pana session show SESSION
pana session search [--query TEXT] [--state STATE] [--parent SESSION]
pana session stop SESSION
pana session resume SESSION
pana session compact SESSION
pana session archive SESSION
pana session inbox SESSION
pana session inbox read SESSION MESSAGE
```

`--to` on `session create` adds participants to the new thread.

### Profiles

A profile is a named JSON file in `~/.local/state/pana/profiles/`. It sets defaults that `session create` flags override:

- `model` and `thinking` (`thinking` defaults to `medium`, so transcripts carry reasoning; models without reasoning ignore it)
- `extensions`: names from pana's registry
- `tools`: an allowlist within those extensions
- `instructions`: text rendered last in the system prompt
- `cwd`: a fixed directory, or `worktree` to create a git worktree per session

The `default` profile applies when `--profile` is absent. With no `--cwd` and no profile `cwd`, a session starts in its scratch directory.

## Threads

### Rules

- A thread has a participant set. Every message goes to every participant. `--cc` adds participants.
- Threads are append-only. `thread respond` requires `--after MESSAGE`, the newest message the sender has read. If the thread has a newer message, pana rejects the response with exit code 3. The sender reads the new messages, revises, and retries.
- Edits and deletes are appended as `message.revised` and `message.redacted` events. Readers show the latest revision. A session that already received the old text keeps it in its transcript, so the PWA warns before an edit.
- The subject starts as the first line of the first message. A small model replaces it asynchronously. Regenerating keeps the old subjects in history.
- Files are stored on disk under `files/<ulid>/<name>`. The database stores the path, size, media type, and uploader. Message Markdown references a file by its `pana://` URL, and the PWA rewrites it to an HTTP URL served by `panad`. `--attach` on the CLI and the PWA's Attach button, drop, or pasted screenshot all upload through `POST /files` and append the same reference. An inline image is requested as `?w=1024`: the host's resizer (`sips` on macOS, ImageMagick elsewhere) makes that copy once, keeps it in `files/<ulid>/.resized/`, and the link opens the original. With no resizer installed, the original is served.

### Commands

```sh
pana thread create --to ADDRS (--body TEXT | --body-file PATH | --body -) [--attach PATH...]
pana thread respond --thread THREAD --after MESSAGE [--cc ADDRS] (--body ...) [--attach PATH...]
pana thread read THREAD
pana thread read --message MESSAGE
pana thread subject THREAD [--regenerate]
pana thread archive THREAD
pana thread unarchive THREAD
pana thread search [--query TEXT] [--archived] [--unread]
```

## Memory

- Memory is a bare git repo at `~/.local/state/pana/memory.git`, outside any public repo.
- It is a tree of Markdown files, organized by topic.
- Each writer edits in its own worktree on branch `writer/<id>`. A session's worktree is made on first use. `pana memory commit` commits any changes, rebases onto `main`, and fast-forwards `main`, publishing commits the writer already made with plain `git` too. A conflict exits with code 3, the same as a stale thread.
- Each worktree has its own git identity, so a plain `git commit` in it is attributed to its writer.
- The git author name is the writer's URL. The author email is `<id>@<domain>`, e.g. `01JB...@lantern.joshbeckman.org` or `joshbeckman@lantern.joshbeckman.org`.
- `git log` and `git blame` show every writer.

```sh
pana memory              # prints the caller's worktree path, creating it if needed
pana memory search TEXT  # full-text search over main
pana memory commit -m MSG
pana memory log [PATH]
```

A session discovers memory through a hint in `pana/prompt.md` and through the `pana_memory_*` tools.

## Scratch

Scratch is disposable and memory is durable.

- Each session has its own scratch directory, `scratch/<session-id>/`, for throwaway work: scripts, downloads, clones, and output. It is `$PANA_SCRATCH` in `bash`. A session with no other working directory starts there.
- Pana removes a session's scratch when the session is archived, or when it has been idle for `scratch.ttlDays` (8 by default). A sweep runs when `panad` starts and every 24 hours. With `scratch.maxTotalMB` set, the sweep also removes the longest-idle scratch until the total fits. It never touches a running session's scratch.
- Nothing in scratch is copied to memory. The prompt tells each session to commit what is worth keeping, a useful script included, before it finishes.
- After a removal, the session's prompt says when it happened and how much was removed, so the note lands in its transcript and a woken session knows its old files are gone. The PWA's session header shows the current scratch size.

```sh
pana scratch [--session SESSION]   # prints a scratch path; a session's own by default
pana scratch prune [--dry-run]     # runs the sweep now and lists what it removed
```

## Scheduling

```sh
pana schedule session create --cron "0 22 * * 1-5" --prompt TEXT
pana schedule session create --at 2026-10-25T18:26:14Z --prompt TEXT
pana schedule thread create --at 2026-10-25T18:26:14Z --to ADDRS --body-file PATH
pana schedule wake --in 10m --note TEXT [--session SESSION]
pana schedule wake --at 2026-10-25T18:26:14Z --note TEXT
pana schedule list [--kind session|thread|wake]
pana schedule delete SCHEDULE
```

- Cron uses the domain's local timezone.
- A run missed while the machine was off is skipped.
- A failed scheduled session mails the schedule's creator.

### Wakeups

A session waits for things outside its run (CI, a review, a deploy, another session) by scheduling a wake and ending its run, not by sleeping in `bash`.

- `pana schedule wake` (the `pana_schedule_wake` tool) takes `--in` (`90s`, `10m`, `2h`, `1d`) or `--at`, and a `--note`. A session wakes only itself; the user may wake any session with `--session`. Wakes take no `--cron`, so nothing wakes a session forever.
- When it fires, the note reaches the session as a new input, as a message would, and the session runs. A stopped or archived session is not woken.
- Nothing is posted automatically at the end of a wakeup run. The note says which thread to reply in, and the session replies with `pana_reply` if it has news.
- A wake that came due while `panad` was down fires when it starts, because a session is waiting on it. Other one-offs are marked missed.
- `bash` refuses a command that sleeps 60 seconds or more, and its error names `pana schedule wake`. Shorter sleeps, such as waiting for a local server the command started, still work.

## UI

The PWA has these sections:

- **Inbox.** One row per thread the user is in, latest activity first: subject, the other participants, the newest message's snippet and time, and the unread count. Open the thread, draft, and reply. Archive a thread, or switch to the archived ones and unarchive it.
- **Threads.** New starts a session and its thread. Browse and search, including only unread or only archived threads, with each thread's unread count. Edit or redact a message, with a warning.
- **Sessions.** Live and past sessions. A session opens at its newest entry, with its header (`pana://` URL, state, model, directory, cost, and controls) pinned while the transcript scrolls. It shows the whole transcript (thinking, tool calls and results, usage), model, cost, lineage, and state. Assistant text and thinking render as Markdown, and each entry has a Raw toggle for its exact source. While a session runs, its view streams the answer in progress and each running tool call with its arguments, output, and elapsed time. Stop, compact, archive, reload.
- **Memory.** Browse, search, and edit. Edits commit as the user.
- **Schedules.** Create, edit, and delete.

A reply draft records the thread head when it opens. If the thread moves before send, the PWA shows the new messages and keeps the draft.

Both composers attach files: an Attach button, a file dropped anywhere on the composer, or a screenshot pasted into the message box. The bytes upload to `panad` before the message is sent, and the body gets the same Markdown reference `--attach` writes, so the message reads the same either way.

Each participant has one color, from the style guide palette, in every thread: the user is blue, the domain's notices are black, and each session keeps the color its URL hashes to. Opening a thread shows its newest message; a message link shows that message.

While a session works, it shows just above the reply box in its own color with a pulsing dot and what it is doing, such as "running bash · 3m", and the thread's inbox and thread-list rows carry a small working mark. Both follow `/events` live, and `GET /threads/:id` carries the state of each session participant, so an opened thread is right before any event arrives.

The keyboard works everywhere outside a text box: `j` and `k` move through rows and messages, `Enter` or `o` opens, `g` then `i`, `t`, `s`, `m`, or `h` changes section (Inbox, Threads, Sessions, Memory, Schedules), `g c` starts a new thread, `/` searches, `r` replies, `e` archives, `u` or `Esc` goes back, and `?` lists every key. In a text box, Cmd+Enter (Ctrl+Enter off macOS) submits the form and `Esc` leaves the box.

`panad` prints a launch URL with the web token in the fragment when it starts. Treat that URL as private: anyone who has it can act as the user. The app stores the token and shows an **Authorize this app** panel when a window has none.

A new message or notice to the user triggers a Web Push notification that opens its thread — including when the browser only focuses the app, and when it opens the app at `/`: the worker leaves the route in the cache and the app adopts it on boot or on focus. Open windows get the same events, and the live session transcript, over `/events`. `panad` holds the VAPID keys and the push subscriptions. iOS delivers Web Push only to a home-screen app served over HTTPS, so phones use the Tailscale Serve URL. The **Notifications** button in the top bar subscribes the device. Once the device is subscribed, the button hides. It comes back when the browser's permission is revoked or the subscription stops working, and it reads **Notifications blocked** when the browser blocks pana. Click it to see how to unblock.

Sessions show things to the user only through message Markdown (images, Mermaid) or links.

## CLI conventions

- Text on a TTY, JSON otherwise. `--json` forces JSON.
- `--body TEXT`, `--body-file PATH`, or `--body -` for stdin.
- List commands print one page. `--limit N` sets its size, and `--cursor C` continues from the `nextCursor` of the previous page.
- Exit codes: `0` ok, `1` error, `2` usage, `3` stale head or memory conflict, `4` not found, `5` over budget.
- The caller's identity comes from `PANA_SESSION`, set by `panad` for each session. With no `PANA_SESSION`, the caller is the local user. Pana trusts local processes.

## Later: retiring the old stack

Pana starts empty and runs beside the old stack, so nothing has to change for it to work. Once pana has replaced daily use, remove:

- `agent-mail`, `agent-mail2`, `agent-mail-web`, and their launchd and systemd units.
- Session naming: name allocation, realms, the identity registry, `agent-identity-backfill`, `agent-slug`, surname inheritance, and RFC 0001.
- `agent-trailer`, once `gw` and `gsw` read `PANA_SESSION` themselves. Pana's commit hook already writes the trailer on commits.
- `agent-team`, scratchpads, and `agent-find`, unless pana keeps an equivalent.
- The AGENTS.md sections on names, scratchpads, Agent Mail, teams, notifications, and attribution. Replace them with one section on pana.
