<img src="web/favicon.svg" alt="The pana icon: an orange and a black strand woven together" width="96" height="96">

# pana

Pana is a meta-harness for agent sessions. Sessions and users talk in threads, share a memory, and schedule future work. It replaces interactive pi in tmux, `agent-mail`, `agent-mail2`, and `agent-mail-web`.

Pana runs sessions on [pi-durable](https://github.com/earendil-works/pi/tree/main/packages/durable) with SQLite storage. It is CLI-first, with a progressive web app (PWA) for users.

## Principles

- **Idle costs nothing but storage.** No active task, no context in memory, no background process between runs.
- **Everything has a URL.** Sessions, threads, messages, memory, and schedules can be linked to and shared. A session’s URL is also its identity and address. It needs no name.
- **CLI first.** Users and agents use the same commands. Other programs can use them too.
- **UI second, not second-class.** The UI stays fast and makes common actions easy. Sessions communicate with users through messages and links.
- **One place to see the work.** Threads, sessions, memory, schedules, tool calls, costs, and state.
- **Sessions are temporary and run in parallel.** They respond quickly and release resources when a run ends.
- **Scratch is temporary. Memory lasts.** Each session has its own scratch directory. Preserve useful work in its canonical home; shared memory preserves understanding and routing pointers. Git tracks each memory change and its author.
- **Link work to the thread where it started.** Threads keep the instructions, decisions, and results; sessions identify the agents that did the work. A child session uses its own originating thread, not its parent’s. Later conversations do not change this link.
- **Threads are for communication.** Participants work together through messages. Every participant gets every message. Threads can be read and shared.
- **Read before you write.** Each new message must name the latest message the sender has read. If the thread has changed, the write fails. Read the new messages and try again. Memory changes must also resolve conflicts before publication.
- **Messages wake idle sessions.** During a run, user messages arrive after the current tool round. Messages from other sessions wait for the next run.
- **Schedule work instead of waiting.** Schedules create sessions, send messages, or wake sessions. End the run while you wait.
- **Change behavior through memory or code.** Keep local knowledge and instructions in domain memory. Make general improvements in pana itself.

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
<p>
  <img src="docs/palette.png" alt="The command palette: every action the page can do, matched fuzzily as you type, with the key each one answers to" width="49%">
  <img src="docs/palette-search.png" alt="The palette's search, asking threads and sessions at once and listing the best hits of each" width="49%">
</p>
<p>
  <img src="docs/palette-phone.png" alt="The command palette on a phone, opened from the magnifier in the top bar" width="24%">
</p>

The screenshots come from the browser test domain. Regenerate them with `node test/browser/screens.ts DIR LABEL`, and the palette's with `node test/browser/palette-shots.ts DIR`.

## Run it

Set pana up as a service in six steps. Each step is safe to repeat.

1. **Update the dotfiles.** Run `git pull` in the checkout, then `dfm install` (or `./setup`), so `~/Library/LaunchAgents/org.joshbeckman.panad.plist` links to the repo. The two-hour refresh does this, but only on a checkout that can fast-forward.

2. **Store the provider keys in `s`.** `bin/panad-service` injects each provider key the store holds, such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `FIREWORKS_API_KEY` (its `--help` lists them all). Panad writes no key to disk.

   ```sh
   s set FIREWORKS_API_KEY        # prompts, masked; or pipe a value to: s set NAME --stdin
   s list                         # names only, values redacted
   ```

   To reuse the API keys pi already has, pipe each `api_key` entry of `~/.pi/agent/auth.json` into `s set NAME --stdin`. An OAuth entry there has no key panad can use.

3. **Write `~/.local/state/pana/config.json`.** Only `domain` and `user` are required; the [configuration reference](docs/configuration.md) lists every supported key, default, and validation rule.

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

   On Linux, `setup` enables `panad.service`; restart it with `systemctl --user restart panad`. The log is `~/Library/Logs/panad.log` on macOS and `journalctl --user -u panad` on Linux. It names the providers panad registered and where the launch URL is:

   ```
   panad: listening on ~/.local/state/pana/panad.sock and http://127.0.0.1:8766
   panad: model providers: anthropic, fireworks, openai
   panad: launch URL with the web token: /Users/you/.local/state/pana/launch-url
   panad: open http://localhost:8766/
   ```

6. **Open the PWA.** Open the launch URL in a browser: `cat ~/.local/state/pana/launch-url`. That file is mode 0600, because the part after `#` is the web token, also kept in `~/.local/state/pana/web-token` (mode 0600); the log names the file instead of printing the token, since launchd and journald keep a log other users can read. The URL uses `localhost`, because Safari answers "denied" to notifications on `127.0.0.1`. A Safari web app added to the Dock starts with empty storage and shows **Authorize this app**: copy the token and paste it there.

   ```sh
   pbcopy < ~/.local/state/pana/web-token
   ```

   For a phone, serve the port over HTTPS on the tailnet and open the `https://` line of that same launch-URL file:

   ```sh
   tailscale serve --bg 8766
   ```

   Treat the token like a password. Scripts that use loopback TCP send it as `Authorization: Bearer <token>`; the `pana` CLI uses the Unix socket and needs none.

Check it with a real session:

```sh
pana session create --prompt "What is the capital of France? Answer in one word."
pana thread read THREAD
```

### Pana took the tailnet address from agent-mail-web

Pana's PWA replaced the Agent Mail web bridge, and both wanted the tailnet's `/`. The bridge and its units are retired now (`bin/retire-agent-automation` stops and disables them), so only the Tailscale Serve front stays as a step for a machine that already ran the old stack:

```sh
tailscale serve --bg 8766
```

### Other ways to run it

Run `panad` in the foreground with a key in its environment: `s FIREWORKS_API_KEY -- pana/bin/panad`. `PANA_STATE` selects another state directory, for both `panad` and the CLI.

### Settings and daemon version

Open **Settings** in the UI to edit `config.json` as JSON. See the [configuration reference](docs/configuration.md) for all supported keys, defaults, validation, and restart behavior; unknown keys are preserved. Saves are validated and reject an intervening file edit. `domain` and `user` are existing data identities, so change neither through this editor. Operational configuration changes require a restart; saving does not change active sessions halfway through a run. The **Your message color** control sets `ui.userColor` to your own hex color (`#RGB`, `#RGBA`, `#RRGGBB`, or `#RRGGBBAA`); legacy named palette colors remain supported, with blue as the default. Saving a color applies immediately to open windows and persists across restarts.

The page compares source on disk (commit SHA, message and local edits) with the revision captured when panad started, and shows the daemon's PID, start time and age. Missing Git metadata is shown as unknown. One panad serves each state directory; sessions are managed inside it, not separate pana daemon processes.

**Restart pana** confirms the interruption, closes the daemon gracefully, then replaces it with a fresh Node process using the same arguments and environment. This reloads source and configuration without depending on launchd/systemd. It requires macOS/Linux and Node's `execve`; embedded/test servers cannot restart themselves. Restart may interrupt active runs; durable sessions recover at startup. If you change `http.port`, reconnect at the new port (and update your Tailscale Serve forwarding if applicable).

To try pana from this checkout without installing the service, run `pana/scripts/try`. It writes a scratch `config.json` in `~/tmp/pana-try` (`PANA_STATE` overrides) on first run, reads the anthropic, openai, and fireworks keys from pi's `~/.pi/agent/auth.json` into `panad` only, and starts `panad` in the foreground. `--fresh` wipes the scratch state first.

`pana/scripts/smoke` checks a real model end to end on a throwaway state directory: `s FIREWORKS_API_KEY -- pana/scripts/smoke`. Add `--keep` to leave that `panad` running for a look in the PWA.

## Non-goals

- Cross-domain messaging in v1. URLs carry the domain so federation stays possible later.
- Multiple humans per domain (in v1).

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

A session has no name. Its URL is its identity and address. Its originating thread URL is its attribution. All sessions are the same agent; they differ only in configuration and transcript.

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
- `panad` binds HTTP to loopback. Tailscale Serve exposes it to other devices, as the retired agent-mail-web bridge did. `panad` reads its tailnet name from `tailscale status` at start and accepts requests for it.
- `panad` registers a model provider for each pi-ai provider whose API key is in its environment, such as `FIREWORKS_API_KEY`, `ANTHROPIC_API_KEY`, or `OPENAI_API_KEY`. A model ID is `provider/model-id`, e.g. `fireworks/accounts/fireworks/models/deepseek-v4p1-flash-1017`.
- `panad` runs under launchd on macOS and a systemd user unit on Linux. Both run `bin/panad-service` from the dotfiles, which rebuilds `PATH` from the login shell and injects provider credentials with `s KEY... -- panad`. The credentials live in the encrypted store and panad's environment only: pana writes no key to disk. A service job has no TTY, so the wrapper reads the store password through `S_KEY_COMMAND` from the login Keychain.
- Runtime is Node, because pi-durable is TypeScript.

### Isolation from pi

Pana runs beside the current pi setup and shares nothing with it.

- `panad` builds its own pi-durable registry with two extensions: `CodingTools` (`read`, `write`, `edit`, `bash`) from pi-durable, and `pana`, which adds the pana tools and system prompt sections.
- Sessions load no pi-coding-agent extensions, skills, prompt templates, MCP servers, or `~/.pi/agent/AGENTS.md`.
- The `bash` tool runs commands with a clean environment: `PATH` (with pana's own `bin` first, so `pana` in a session is this `panad`'s build), `HOME`, `USER`, `LANG`, `TERM=dumb`, `PANA_SESSION`, `PANA_THREAD`, `PANA_STATE`, `PANA_SCRATCH`, `PANA_BROWSER_SESSION`. `PANA_STATE` points `pana` in `bash` at the session's own `panad`. Provider credentials stay in `panad`. `AGENT_*` and `PI_*` variables never reach a session.
- `bin/chrome-devtools` is that `bin`, so a session's `chrome-devtools` runs the installed CLI with `--sessionId $PANA_BROWSER_SESSION` and drives its own daemon: its own socket, pid file, and headless Chrome. The scope is the session id in hex, because the CLI accepts only `[a-fA-F0-9-]` for `--sessionId` and rejects anything else on every command. Two sessions on one machine no longer share the same pages. `panad` stops the daemon when it archives the session, and sweeps every five minutes to stop the daemons of sessions idle for ten minutes. That first start also gets an `--executablePath` for the first browser the shim finds — `google-chrome`, `google-chrome-stable`, `chromium`, `chromium-browser` on `PATH`, then the Chrome app bundle on a Mac — because the CLI otherwise probes only `/opt/google/chrome`, so on a Linux box with a distro Chromium and no Chrome the daemon starts and every call then fails. A call that names its own `--sessionId`, or a shell with no `PANA_BROWSER_SESSION`, runs the CLI unchanged.
- The coding `read` tool prepares images with pi-durable’s worker-backed Photon processor, automatically honoring the model’s dimension and base64 byte limits without modifying the original. This is separate from the thread UI’s host-command resizer and requires no local image-command configuration.
- A `bash` call that names no timeout stops after `tools.bashTimeoutSec` in `config.json` (600 seconds by default). Pana kills the command's whole process group, and the model gets an error result that says the call timed out.
- Sessions normally start in scratch. Before changing a repository, identify it and
  run `pana worktree add REPO`; edit, test, and commit in the returned owned checkout.
  Profiles may explicitly request a worktree at session creation, but repo-specific
  sessions are not required. Creation records ownership and uses configured
  [managed adapters](docs/worktree-adapters.md) where needed. Generated branch names
  avoid local/cached-remote exact and slash-prefix collisions without fetching. Built-in
  Git creation isolates checkout from filter commands. It refuses a checkout with any
  effective filter attribute, including Git LFS, rather than return unconverted files.
  It preserves selected safe Git checkout settings, including line endings, and checks
  external conversion attributes against the isolated checkout. It refuses differing
  external attributes and sparse checkout. These failures leave an unowned partial tree
  for inspection; see [failure and cleanup](docs/worktree-adapters.md#failure-and-cleanup).
  Later Git commands use normal configuration and can run filters. Managed adapters run
  their own trusted creation commands and do not have this isolation.
- `tools.protectCheckouts: "guard"` (the default) protects **file-tool writes by path**:
  primary checkouts and unowned linked trees are refused, including through symlinks.
  Known peer ownership overrides an explicit cwd. Execution whose actual cwd is an
  unowned checkout is also refused. Bash **command text is not parsed or classified**;
  a command launched from scratch can name or enter a checkout. Instructions require
  changes in owned worktrees, but guard mode does not prevent arbitrary Bash writes.
- `"sandbox"` additionally mounts unowned checkouts read-only for Bash on hosts with
  working Linux user namespaces and a way to drop `CAP_SYS_ADMIN`. If those are
  unavailable (including macOS), it falls back to file-tool/cwd protection, not
  equivalent Bash write enforcement.
  `"off"` disables checkout protection entirely. Stronger cross-platform filesystem
  isolation is separate from the worktree workflow.
- Worktree receipts persist across archive/restart and are not scratch. Sessions must
  clean up their task-created trees at completion after preserving useful work and
  checking that no assigned/open work needs them (including PR deployment and proof).
  Unsafe, blocked, or still-needed trees are retained with a path and reason in the
  task thread. This is not a daemon TTL sweep or bulk-cleanup permission; see
  [failure and cleanup](docs/worktree-adapters.md#failure-and-cleanup).
- Pana keeps its state under `~/.local/state/pana/` and reads no other agent state.

### System prompt

The `pana` extension renders these sections, in order:

1. **Project.** Every `AGENTS.md` from the root of the `cwd` repo down to `cwd`.
2. **Pana.** `pana/prompt.md`, loaded only by pana. It explains threads, replies, memory, and the session's own URL, and holds hints such as where memory lives and how to search it.
3. **Profile.** The profile's instructions, rendered last as pi-durable `instructions`.

Sections that change every run, such as the current time, stay out of the prompt so provider caches stay warm.

### Tools

Every pana tool wraps one CLI command with the same arguments, output, and exit codes. A session can use either. The tools are `pana_reply`, `pana_thread_read`, `pana_thread_create`, `pana_session_create`, `pana_memory_search`, `pana_memory_commit`, and `pana_schedule_wake`.

### Attribution

Thread attribution belongs on PR descriptions, comments, reviews, and other prose writes:

```
Co-authored-by: AI pana://<domain>/threads/<ulid>
```

`panad` exports the originating thread URL as `PANA_THREAD`. `agent-trailer` uses it for
prose and the optional email form; `--raw` still reports the session ID for diagnostics.
Missing or invalid thread URLs fail rather than substituting a session or parent thread.
The `gw` wrapper adds this attribution from the session environment for supported
writes with an explicit body. Direct clients, web edits, and bodyless/editor-generated writes
are not universally covered; use the required wrappers with `--body` or `--body-file`.

Use ordinary Git commands for project commits. Pana does not require commit trailers, provide
a special commit operation, install Git hooks, or override `core.hooksPath`. Repository hooks
and signing remain entirely native. Discover a commit's PR with `git pr-for-commit <SHA>`,
then follow the PR's thread attribution. The resolver uses hosting-provider associations or
a configured PR-number merge trailer, not Pana coauthor trailers. It needs the relevant API
access or local history/configuration, and fails for missing or ambiguous associations rather
than guessing. Unpublished commits may have no PR yet.

Memory is different: it has no PR surface. Its existing writer identity, attribution, and
`pana memory commit` publication behavior are unchanged.

After upgrading from the hook-based implementation, restart `panad` so session shells receive
the new environment. Old state-directory hook files are left untouched but are no longer
installed or selected by Pana.

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

### Model retries

Transient provider/transport failures and authentication failures (such as HTTP 401) share a
budget of **16 attempts total** per model generation or compaction request. Retries back off
for 2, 4, 8, 16, and 32 seconds, then 60 seconds each: up to 11 minutes 2 seconds of backoff,
plus request time. Backoff and the attempt count survive daemon restarts; the session reports
`waiting` during backoff, and stopping it cancels the retry.

Authentication retries resolve credentials again but do not refresh a static API key in the
daemon's environment. A permanently invalid key still requires operator intervention. Billing/
quota exhaustion, permission-denied responses (403), and malformed requests do not gain retries.
Once the budget is exhausted, Pana marks the session `failed` and posts one failure notice;
there is no separate automatic session restart loop. Sending a new message can start another run.

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
- `cwd`: a fixed directory, or `worktree` to create a git worktree per session (the shape a session editing a repository should be created with: it never touches your checkout)

The `default` profile applies when `--profile` is absent. With no `--cwd` and no profile `cwd`, a session starts in its scratch directory.

## Threads

### Rules

- A thread has a participant set. Every message goes to every participant. `--cc` adds participants.
- Sessions may read any same-domain thread or message by reference, even when they are not participants. Reading does not join the thread, subscribe to future messages, or change anyone else's read state. Responding still requires participation, and another session's inbox remains private.
- Threads are append-only. `thread respond` requires `--after MESSAGE`, the newest message the sender has read. If the thread has a newer message, pana rejects the response with exit code 3. The sender reads the new messages, revises, and retries.
- Edits and deletes are appended as `message.revised` and `message.redacted` events. Readers show the latest revision. A session that already received the old text keeps it in its transcript, so the PWA warns before an edit.
- The subject starts as the first line of the first message. A small model replaces it asynchronously. Regenerating keeps the old subjects in history.
- A message may offer reply options in a fenced `choices` block. Use `- QUESTION => LABEL => REPLY` for contextual answers; `^` in the question position repeats the most recent explicit question in that fence. Buttons are grouped under their questions. Selecting adds `> QUESTION`, a blank line, and `REPLY` to the draft; another option for that question replaces the known answer, and clicking the selected option removes it. Other questions and hand-written text are preserved; hand-edited answers are not overwritten. Nothing is sent automatically, and draft text remains the only selection state. The older `- LABEL` and `- LABEL => reply` forms still toggle unquoted lines independently. `--choice` appends the same fence, and mailbox rows show labels. The first two spaced ` => ` separators delimit question and label; any later arrows belong to the reply. An orphan `^` or malformed fence stays visible as code (CLI flags report an error).

  ```choices
  - Which approach? => Fix forward => Keep the change and fix forward.
  - ^ => Revert => Revert the change.
  - When should we ship? => Today => Ship today.
  - ^ => Next release => Ship in the next release.
  ```
- Files are stored on disk under `files/<ulid>/<name>`. The database stores the path, size, media type, and uploader. The type is read from the bytes, never from the upload: a raster image previews inline, and everything else is served as a download, so no attachment can run as a page on pana's own origin. Message Markdown references a file by its `pana://` URL, and the PWA rewrites it to an HTTP URL served by `panad`. `--attach` on the CLI and the PWA's Attach button, drop, or pasted screenshot all upload through `POST /files` and append the same reference. An inline image is requested as `?w=1024`: the host's resizer (`sips` on macOS, ImageMagick elsewhere) makes that copy once, keeps it in `files/<ulid>/.resized/`, and the link opens the original. With no resizer installed, the original is served.

### Joining a thread

Only participants may respond, and a session cannot add itself: its reply is refused with 403. The way in is a participant's `--cc` on a message it sends to that thread.

```sh
# run by a participant of the target thread
pana thread respond --thread TARGET --after NEWEST --body "adding the session that has the CI history" --cc 01SESSION…
```

The added session participates from that message on: it receives that message and every later one, never the earlier ones, and its `joined_message_id` records where it joined. A session that wants in therefore asks out of band — replying in a thread it shares with a participant, or starting a thread with one (`pana thread create --to`), naming the thread it wants to join and what it would add. You are a participant in most threads and may add a session the same way, but no one is the moderator: any participant can. `pana/prompt.md` tells sessions that, so the request arrives as an ordinary message instead of as a rejected reply.

`--cc` takes a session ULID or `pana://` URL, or the user. It returns 404 for a session that does not exist and 409 for an archived one, because a thread holding an archived session accepts no deliveries at all (STA-07). There is no command to leave a thread or to remove a participant.

### Commands

```sh
pana thread create --to ADDRS (--body TEXT | --body-file PATH | --body -) [--attach PATH...] [--choice TEXT...]
pana thread respond --thread THREAD --after MESSAGE [--cc ADDRS] (--body ...) [--attach PATH...] [--choice TEXT...]
pana thread read THREAD
pana thread read --message MESSAGE
pana thread subject THREAD [--regenerate]
pana thread archive THREAD
pana thread unarchive THREAD
pana thread list [--participant ADDR]
pana thread search --query TEXT [--participant ADDR]
```

Listing and searching cover all same-domain threads, regardless of archive or read state. `--participant` selects threads that a user or session participates in, not messages they authored; use a username, session ULID, or same-domain participant URL. Both commands accept `--limit N`, `--cursor CURSOR`, and `--json`; results include `nextCursor` for pagination. Lists are newest-created first; searches return subject matches first, then message matches by relevance. Neither command marks messages read or joins threads.

Archiving only organizes a participant's inbox. It does not hide threads from discovery or stop delivery; a new delivered message unarchives the thread for its recipient.

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

### What belongs in memory

Memory should improve future judgment, not duplicate history. Before saving a note, name a
plausible future situation where it would materially help and explain why ordinary task
retrieval or canonical sources would not be enough. When in doubt, leave it in the thread.

- **Threads and PRs:** task narrative, local decisions, abandoned approaches, implementation
  details, and test/deployment receipts. Search relevant history before reviving a proposal;
  read original messages for intent and later reversals, not just search snippets.
- **Canonical sources:** project facts/status, profile context, repository documentation,
  skills, and code. Read/update the appropriate source under its authorization rules;
  memory can point there rather than maintain competing copies.
- **Shared memory:** durable reasons, distinctions, standards of evidence, useful synthesis,
  hard-to-discover operating knowledge, and concise routing pointers. A synthesis must add
  understanding, not merely paraphrase conversations or catalogue past answers.

Keep the smallest useful explanation: what matters, why, when it applies, and a source.
Separate observations from inference. Do not turn a local “not yet” into a permanent ban or
infer a general preference from one decision. Prefer updating guidance to adding another file.

Prune completed task ledgers, stale snapshots, and duplicates; Git and source conversations
retain the history without a parallel archive or rejection ledger. Necessary active automation
and handoff checkpoints are working state, not durable understanding: keep them compact,
separate, and scoped to their authorized workflows, with cleanup at completion.

These general defaults live in Pana's session prompt, not in a memory file every domain must
invent or load. Domain memory supplies local choices, canonical-source pointers, and deliberate
exceptions. These are prompt instructions, not automated quality enforcement or new permission
to edit canonical sources, change workflows/schedules, or take external actions.

#### Domain working conventions

The session prompt has one generic discovery rule: at the start of each run, consult the
optional root `AGENTS.md` in published memory (`main`). Read the entrypoint and relevant
linked workflow files from that published view, not a potentially stale writer-worktree
snapshot. This is a prompt-level convention, not automatic file injection or guaranteed
workflow execution. The entrypoint is optional: absent files are skipped without setup.

Keep `AGENTS.md` short: describe when a convention applies and link its instructions.
For example, a domain might point sessions encountering tooling friction to a journal
workflow, or scheduled reviewers to a proposal protocol. New workflows change domain
memory only; they do not require new core prompt clauses or extension tests. Don't load
all memory files, and don't treat arbitrary retrieved notes as working conventions.
Domain guidance is subordinate to higher-priority instructions and grants no additional
permissions. Workflows and schedules require their usual authorization.

Read published files with read-only Git commands in your own memory worktree. For
example, `git ls-tree main -- AGENTS.md` checks for the optional entrypoint; if present,
`git show main:AGENTS.md` reads it. Use the same published view for relevant linked files.
Don't switch branches or reset a writer worktree to refresh instructions. Continue to
edit and publish through the ordinary memory workflow. Keep domain-specific instructions,
private evidence, and recipients in memory, not in this public repository.

Merge and deploy the generic prompt change before expecting discovery in running
installations. Core tests cover the discovery contract, not individual domain workflows.

## Scratch

Scratch is disposable and memory is durable.

- Each session has its own scratch directory, `scratch/<session-id>/`, for throwaway work: scripts, downloads, clones, and output. It is `$PANA_SCRATCH` in `bash`. A session with no other working directory starts there.
- Pana removes a session's scratch when the session is archived, or when it has been idle for `scratch.ttlDays` (8 by default). A sweep runs when `panad` starts and every 24 hours. With `scratch.maxTotalMB` set, the sweep also removes the longest-idle scratch until the total fits. It never touches a running session's scratch.
- Nothing in scratch is copied to memory. The prompt tells each session to preserve useful work in its canonical home before it finishes, and to use memory for durable understanding or routing pointers, not scratch dumps.
- After a removal, the session's prompt says when it happened and how much was removed, so the note lands in its transcript and a woken session knows its old files are gone. The PWA's session header shows the current scratch size.

```sh
pana scratch [--session SESSION]   # prints a scratch path; a session's own by default
pana scratch prune [--dry-run]     # runs the sweep now and lists what it removed
```

## Scheduling

```sh
pana schedule session create --cron "0 22 * * 1-5" --prompt TEXT [--check COMMAND] [--check-cwd DIR] [--stop-after-success]
pana schedule session create --at 2026-10-25T18:26:14Z --prompt TEXT
pana schedule thread create --at 2026-10-25T18:26:14Z --to ADDRS --body-file PATH
pana schedule thread create --cron "*/5 * * * *" --to ADDRS --body TEXT [--check COMMAND] [--check-cwd DIR] [--stop-after-success]
pana schedule wake --in 10m --note TEXT [--session SESSION]
pana schedule wake --at 2026-10-25T18:26:14Z --note TEXT
pana schedule wake --cron "*/5 * * * *" --note TEXT [--check COMMAND] [--check-cwd DIR] [--stop-after-success]
pana schedule list [--kind session|thread|wake]
pana schedule update SCHEDULE [--cron CRON | --at TIME] [--check COMMAND [--check-cwd DIR] | --no-check] [--stop-after-success | --no-stop-after-success] [--subject TEXT]
pana schedule delete SCHEDULE
```

- `pana schedule update` changes one schedule in place and keeps its ID, creator, and payload. It sends only the flags it was given, so an edit that names none of the timing, check, or subject leaves them as they are. `--cron` or `--at` retimes it and reactivates it; `--no-check` removes the check; `--no-stop-after-success` keeps dispatching after a passing check. The creator or the user may update it, the same rule as delete.

- Every schedule has a short subject. All create commands (including wakes) accept `--subject "Weekly planning"`; the API uses a top-level `subject`, separate from the action payload. If omitted, the prompt/body/note's first line is shown immediately and `subjectModel`, when configured, generates a better label in the background. A model failure leaves the fallback label. Subjects are one line, at most 80 characters.
- The PWA lists subjects with timing/status metadata and keeps full instructions behind a disclosure. Conditional schedules show a readiness-check indicator, stop-after-success behavior, and the latest check status; expand Run conditions / check details for the command, working directory, timestamp, exit code, signal, error, stdout, and stderr. Editing instructions regenerates automatic subjects but keeps manually chosen labels. Clear the subject in the edit form (API `subject: null`) to return to automatic naming. Existing schedules get fallback labels immediately and background naming as they are viewed.
- Cron uses the domain's local timezone.
- A run missed while the machine was off is skipped.
- A schedule reports its own news to its creator in one thread per schedule, and only when the words change: a check that keeps failing for the same reason posts once, a new error posts again, and a passing check reopens its voice for the next failure. A session creator is woken by that mail, because only the creator or the user may repair the schedule; a user creator reads it in the inbox.
- Every kind (`session`, `thread`, `wake`) accepts `--cron`. `--check`, `--check-cwd`, and `--stop-after-success` require `--cron`; one-shot schedules reject them. Choose exactly one timing flag (`--cron` or `--at`, or `--in` for wakes).
- `--check 'COMMAND'` runs a Bash readiness check before each dispatch: exit 0 dispatches, exit 1 skips this occurrence quietly. Other exit codes, signals, launch errors, and a 30-second timeout skip dispatch and notify the creator, without waking a session. No session is created just to run a check.
- Checks run as `bash --noprofile --norc -c COMMAND` with the daemon's environment. `--check-cwd` must be an absolute directory and requires `--check`; otherwise the daemon records its own working directory at creation. This is separate from a scheduled session's `--cwd`. Timeout/shutdown kills the ordinary process group and settles without waiting for pipe closure. Checks must not daemonize, enable job control, or move children to other process groups: escaped children are not guaranteed to be terminated. Checks can execute arbitrary commands: use trusted, noninteractive commands that need no shell startup files.
- **Upgrading older checks:** Existing session-authored checks with a stored session author keep that author. Older user checks and any checks whose author record is missing are ambiguous, so they fail without executing and report `check author is missing`. They resume only after an authorized caller explicitly redefines the check with `pana schedule update SCHEDULE --check COMMAND --check-cwd DIR`, which records the caller as the check's author; the user sends it as the user, a session as itself for its own schedule. Inspect the stored command and cwd with `GET /schedules/:id` or `GET /objectives/:id/metrics` first, and take user authority only when the user intends to own that command. A metric check is redefined through `POST /objectives/:id/metrics/:name` with `check`, `checkCwd`, and its `checkEvery` or `checkCron`, which recalculates its next run from the edit time. Until then, scheduled dispatches and metric readings gated by the check are interrupted; unrelated checks continue.
- Different schedules' checks run concurrently; a schedule never overlaps its own check or dispatch. Missed cron occurrences are still skipped.
- `--stop-after-success` finishes the recurring schedule only after a successful dispatch, not merely a passing check. It also works without a check. A not-ready or failed check leaves the schedule active; dispatch success does not wait for the resulting agent run to finish.
- API creation fields are `check` (string or null), `checkCwd` (string or null), and `stopAfterSuccess` (boolean, default false). List and detail responses expose `lastCheck` (null before any check, otherwise `{checkedAt, status, exitCode, signal, stdout, stderr, error}`). Status is `passed`, `not_ready`, or `failed`; diagnostics retain at most 8 KiB per output stream. Output is diagnostic only and is never inserted into agent prompts.

For example, poll a local readiness script without starting an agent each time, then create a session once:

```sh
pana schedule session create --cron '*/5 * * * *' --check './ready.sh' --check-cwd /absolute/project --stop-after-success --prompt 'Read the readiness result and report it.'
```

### Wakeups

A session waits for things outside its run (CI, a review, a deploy, another session) by scheduling a wake and ending its run, not by sleeping in `bash`.

- `pana schedule wake` (the `pana_schedule_wake` tool) takes one of `--in` (`90s`, `10m`, `2h`, `1d`), `--at`, or `--cron`, and a `--note`. A session wakes only itself; the user may wake any session with `--session`. Use `--check` and `--stop-after-success` with `--cron` to wait for readiness without repeated agent runs.
- When it fires, the note reaches the session as a new input, as a message would, and the session runs. A stopped or archived session is not woken.
- Nothing is posted automatically at the end of a wakeup run. The note says which thread to reply in, and the session replies with `pana_reply` if it has news.
- A one-shot wake that came due while `panad` was down fires when it starts, because a session is waiting on it. Other one-offs are marked missed.
- `bash` refuses a command that sleeps 60 seconds or more, and its error names `pana schedule wake`. Shorter sleeps, such as waiting for a local server the command started, still work.

## Objectives

An objective is stated work with a lifetime: a goal, a charter, one lead session that coordinates, member sessions that do the work, metrics that say whether it worked, and budgets that stop it.

- **Lead and members.** A draft has no effects; only the user launches it, which creates the objective's thread and its one lead. The charter holds standing instructions as append-only revisions, and a session may write only `Notes`.
- **Metrics** carry a unit, a direction, a target (or none, which never finishes), an optional trailing window, and an optional check the scheduler runs with no session awake. Readings are append-only, the first is the baseline, the user sets targets, and a name never changes.
- **Limits** cap spend, lead runs, messages to the user, and active members per objective. A budget pause reads `idle`, not `stranded`, and an objective with nothing to move it is noticed to the user once. Only the user changes a limit, each change is recorded, and raising a lifetime budget lifts the pause and hands the lead's held mail back, so raising a budget resumes the work it stopped.
- **Reports** are messages in the objective's thread; **artifacts** are uploaded files linked to it. An objective may have no members: a lone lead measures, reports, and finishes it.

```sh
pana objective create --goal TEXT [--autonomy manual|auto] [--due-at TIME] [--max-daily-usd N]
pana objective launch OBJECTIVE      # also: show, list, stop, resume, done, archive
pana objective charter set OBJECTIVE --section Notes --body TEXT
pana objective metric add OBJECTIVE --name NAME --unit UNIT --direction up|down [--target N]
pana objective report OBJECTIVE --body TEXT
pana objective regenerate-lead OBJECTIVE --reason TEXT
pana objective limits set OBJECTIVE --max-total-usd N   # `--max-total-usd default` clears it
```

A failed lead leaves the objective stranded, and the user regenerates it: the next lead starts from the same briefing. [SPEC.md](SPEC.md) has the behaviours.

## Observability

`panad` writes one JSONL line per request to `<state>/panad.log`: route, caller, status, and duration, never a body or a query string. The PWA writes its own samples to `<state>/client.log`: each API call's round trip, each view's render, and every long task.

```sh
pana stats requests [--since SPAN] [--route ROUTE] [--name NAME]
```

It reads the newest 8 MB of both logs and prints a count, an error count, and p50/p95/p99 per route, worst p99 first, then the browser's samples and the slowest requests. `--since` takes an ISO time or a span such as `90s`, `30m`, `24h`, `7d`. `GET /stats/requests` answers the same JSON, with `client` beside the server's numbers.

Percentiles are nearest-rank over the window, so a route with three calls reports its three and every reading carries its count.

Both logs rotate at `logs.maxBytes` (4 MiB by default) and keep `logs.keep` previous files (2), so the state directory holds a bounded set of files instead of one that grows forever. Rotation renames a whole file, never cuts one mid-line, and the reader reads across the renamed files as one history: a window that spans a rotation still counts every request in it. `logs.maxBytes: 0` turns rotation off.

## UI

The PWA has these sections:

- **Inbox.** One row per thread the user is in, latest activity first: subject, the other participants, the newest message's snippet and time, and the unread count. Open the thread, draft, and reply. Archive a thread, or switch to the archived ones and unarchive it.
- **Threads.** New starts a session and its thread. Browse and search all same-domain threads, independent of personal archive/read state. A participant filter narrows results by thread membership. Archive or unarchive from an open thread you participate in, not from the browse list. Edit or redact a message, with a warning.
- **Sessions.** Live and past sessions. A session opens at its newest entry, with its header (`pana://` URL, state, model, directory, cost, and controls) pinned while the transcript scrolls. It shows the transcript's newest 30 entries, with **Load older entries** — and, once one page is loaded, **Load all older entries** — for the rest (thinking, tool calls and results, usage), plus model, cost, lineage, and state. Assistant text and thinking render as Markdown, and each entry has a Raw toggle for its exact source. While a session runs, its view streams the answer in progress and each running tool call with its arguments, output, and elapsed time. Stop, compact, archive, reload.
- **Memory.** Browse, search, and edit. Edits commit as the user.
- **Schedules.** Create, edit, and delete.

A reply draft records the thread head when it opens. If the thread moves before send, the PWA shows the new messages and keeps the draft.

Both composers attach files: an Attach button, a file dropped anywhere on the composer, or a screenshot pasted into the message box. The bytes upload to `panad` before the message is sent, and the body gets the same Markdown reference `--attach` writes, so the message reads the same either way.

The app measures itself: every API round trip, every view's render, and every long task it runs is posted to `panad` and read back with `pana stats requests` (see [Observability](#observability)).

The user keeps their chosen hex color across threads (blue by default), and domain notices remain black. Session identities are allocated within each thread from its append-ordered participant roster, using twelve generated colors and four overflow patterns; they do not change when the user changes their color. Opening a thread shows its newest message; a message link shows that message.

While a session works, it shows just above the reply box in its own color with a pulsing dot and what it is doing, such as "running bash · 3m", and the thread's inbox and thread-list rows carry a small working mark. Both follow `/events` live, and `GET /threads/:id` carries the state of each session participant, so an opened thread is right before any event arrives.

The keyboard works everywhere outside a text box: `j` and `k` move through rows and messages, `Enter` or `o` opens, `g` then `i`, `t`, `s`, `m`, or `h` changes section (Inbox, Threads, Sessions, Memory, Schedules), `g c` starts a new thread, `/` searches, `r` replies, `e` archives an open thread you participate in or a selected inbox thread (and returns to the list when it archives the thread you are reading), `u` or `Esc` goes back, and `?` lists every key. Cmd+K (Ctrl+K off macOS) opens the command palette: every one of those actions in one fuzzy-matched list, plus a Search command that asks threads, sessions, and memory at once and jumps straight to the hit. A magnifier in the top bar opens it on a phone, where there is no Cmd. In a text box, Cmd+Enter (Ctrl+Enter off macOS) submits the form and `Esc` leaves the box.

`panad` writes its launch URL, with the web token in the fragment, to `~/.local/state/pana/launch-url` (mode 0600) when it starts, and prints the loopback URL without it. Treat that file as private: anyone who has the URL can act as the user. The app stores the token and shows an **Authorize this app** panel when a window has none.

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

- Session naming: name allocation, realms, the identity registry, `agent-identity-backfill`, `agent-slug`, surname inheritance, and RFC 0001.
- `agent-trailer`, once `gw` derives thread attribution from `PANA_THREAD` itself. Project commits need no Pana trailer.
- `agent-team`, scratchpads, and `agent-find`, unless pana keeps an equivalent.
- The AGENTS.md sections on names, scratchpads, teams, notifications, and attribution. Replace them with one section on pana.
