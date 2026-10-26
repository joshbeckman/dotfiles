# pana

Pana is a meta-harness for agent sessions. Sessions and users talk in threads, share a memory, and schedule future work. It replaces interactive pi in tmux, `agent-mail`, `agent-mail2`, and `agent-mail-web`.

Pana runs sessions on [pi-durable](https://github.com/earendil-works/pi/tree/main/packages/durable) with SQLite storage. It is CLI-first, with a progressive web app (PWA) for users.

[SPEC.md](SPEC.md) lists the behaviors that prove it works, grouped into work packages.

```sh
pana session create --prompt "what is the capital of france"
# creates a session and a thread between the caller and the session
# the session's answer is posted to that thread
```

## Run it

Write `~/.local/state/pana/config.json`. Only `domain` and `user` are required; [SPEC.md](SPEC.md) CFG-03 lists the rest.

```json
{
  "domain": "lantern.joshbeckman.org",
  "user": "joshbeckman",
  "defaultModel": "fireworks/accounts/fireworks/models/deepseek-v4p1-flash-1017"
}
```

Start `panad` with a provider key in its environment. It prints the providers it registered and a launch URL for the PWA.

```sh
s FIREWORKS_API_KEY -- pana/bin/panad
# panad: listening on ~/.local/state/pana/panad.sock and http://127.0.0.1:8766
# panad: model providers: fireworks
# panad: open http://localhost:8766/#<web-token>
```

As a service, load the launchd job on macOS. On Linux, `setup` enables `panad.service`. Both run `bin/panad-service`, which injects the provider keys from `s`. The log is `~/Library/Logs/panad.log` on macOS and `journalctl --user -u panad` on Linux.

```sh
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/org.joshbeckman.panad.plist
```

Use the CLI. `PANA_STATE` selects another state directory.

```sh
pana session create --prompt "What is the capital of France? Answer in one word."
pana thread read THREAD
pana thread respond --thread THREAD --after MESSAGE --body "Thanks"
```

Open the launch URL in a browser to authorize the PWA. It uses `localhost`, because Safari answers "denied" to notifications on `127.0.0.1`. For a phone, serve the port over HTTPS on the tailnet and open the `https://` launch URL that `panad` prints:

```sh
tailscale serve --bg 8766
```

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
                                └───── memory.git (bare) + worktrees
```

- `panad` is the only process that opens `pana.sqlite`. pi-durable has no cross-process locking, so the CLI never opens the file directly.
- State lives under `~/.local/state/pana/`: `pana.sqlite`, `files/`, and `memory.git`.
- All sessions share one pi-durable storage, as conversations of one Harness. pi-durable tables use the `pi_` prefix. Pana's tables (threads, messages, deliveries, schedules, file records) live in the same file, so a message append and the session wake it causes commit together.
- `panad` binds HTTP to loopback. Tailscale Serve exposes it to other devices, as agent-mail-web does today. `panad` reads its tailnet name from `tailscale status` at start and accepts requests for it.
- `panad` registers a model provider for each pi-ai provider whose API key is in its environment, such as `FIREWORKS_API_KEY`, `ANTHROPIC_API_KEY`, or `OPENAI_API_KEY`. A model ID is `provider/model-id`, e.g. `fireworks/accounts/fireworks/models/deepseek-v4p1-flash-1017`.
- `panad` runs under launchd on macOS and a systemd user unit on Linux. Both run `bin/panad-service` from the dotfiles, which rebuilds `PATH` from the login shell and injects provider credentials with `s KEY... -- panad`. The credentials live in the encrypted store and panad's environment only: pana writes no key to disk. A service job has no TTY, so the wrapper reads the store password through `S_KEY_COMMAND` from the login Keychain.
- Runtime is Node, because pi-durable is TypeScript.

### Isolation from pi

Pana runs beside the current pi setup and shares nothing with it.

- `panad` builds its own pi-durable registry with two extensions: `CodingTools` (`read`, `write`, `edit`, `bash`) from pi-durable, and `pana`, which adds the pana tools and system prompt sections.
- Sessions load no pi-coding-agent extensions, skills, prompt templates, MCP servers, or `~/.pi/agent/AGENTS.md`.
- The `bash` tool runs commands with a clean environment: `PATH`, `HOME`, `USER`, `LANG`, `TERM=dumb`, `PANA_SESSION`, `PANA_STATE`, and the `GIT_CONFIG_*` variables that set pana's hook directory. `PANA_STATE` points `pana` in `bash` at the session's own `panad`. Provider credentials stay in `panad`. `AGENT_*` and `PI_*` variables never reach a session.
- Pana keeps its state under `~/.local/state/pana/` and reads no other agent state.

### System prompt

The `pana` extension renders these sections, in order:

1. **Project.** Every `AGENTS.md` from the root of the `cwd` repo down to `cwd`.
2. **Pana.** `pana/prompt.md`, loaded only by pana. It explains threads, replies, memory, and the session's own URL, and holds hints such as where memory lives and how to search it.
3. **Profile.** The profile's instructions, rendered last as pi-durable `instructions`.

Sections that change every run, such as the current time, stay out of the prompt so provider caches stay warm.

### Tools

Every pana tool wraps one CLI command with the same arguments, output, and exit codes. A session can use either. The tools are `pana_reply`, `pana_thread_read`, `pana_thread_create`, `pana_session_create`, `pana_memory_search`, and `pana_memory_commit`.

### Commit attribution

Every commit a session authors carries this trailer:

```
Co-authored-by: AI pana://<domain>/sessions/<ulid> <<ulid>@<domain>>
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

An idle session holds no task. pi-durable drops its context from memory after a retention window. "Default-off" means this: when a run ends, nothing of the session stays in flight.

A session cannot own a background process that outlives its run.

### Mail delivery

When a message lands in a session's inbox:

- **Idle or failed:** `panad` submits the message as a pi-durable input with entry kind `pana.message`. The model sees the full body, the sender URL, the thread URL, and the message URL. Delivery marks it read.
- **Running, message from a user:** the message is a steer. It joins the current run after its tool round, or starts the next run if the current one ends first.
- **Running, message from a session:** the message queues as a follow-up and starts the next run.
- **Stopped:** the message waits in the inbox.

### Replies

The final assistant message of a run posts to the thread whose message started that run. Its head is the newest message of that thread in the session's transcript. If the thread moved during the run, `panad` does not post the reply. The next run receives the new messages and a note that the previous reply was not posted.

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

- `model` and `thinking`
- `extensions`: names from pana's registry
- `tools`: an allowlist within those extensions
- `instructions`: text rendered last in the system prompt
- `cwd`: a fixed directory, or `worktree` to create a git worktree per session

The `default` profile applies when `--profile` is absent.

## Threads

### Rules

- A thread has a participant set. Every message goes to every participant. `--cc` adds participants.
- Threads are append-only. `thread respond` requires `--after MESSAGE`, the newest message the sender has read. If the thread has a newer message, pana rejects the response with exit code 3. The sender reads the new messages, revises, and retries.
- Edits and deletes are appended as `message.revised` and `message.redacted` events. Readers show the latest revision. A session that already received the old text keeps it in its transcript, so the PWA warns before an edit.
- The subject starts as the first line of the first message. A small model replaces it asynchronously. Regenerating keeps the old subjects in history.
- Files are stored on disk under `files/<ulid>/<name>`. The database stores the path, size, media type, and uploader. Message Markdown references a file by its `pana://` URL, and the PWA rewrites it to an HTTP URL served by `panad`.

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
- Each writer edits in its own worktree. `pana memory commit` commits, rebases onto `main`, and fast-forwards `main`. A conflict exits with code 3, the same as a stale thread.
- The git author name is the writer's URL. The author email is `<id>@<domain>`, e.g. `01JB...@lantern.joshbeckman.org` or `joshbeckman@lantern.joshbeckman.org`.
- `git log` and `git blame` show every writer.

```sh
pana memory              # prints the caller's worktree path, creating it if needed
pana memory search TEXT  # full-text search over main
pana memory commit -m MSG
pana memory log [PATH]
```

A session discovers memory through a hint in `pana/prompt.md` and through the `pana_memory_*` tools.

## Scheduling

```sh
pana schedule session create --cron "0 22 * * 1-5" --prompt TEXT
pana schedule session create --at 2026-10-25T18:26:14Z --prompt TEXT
pana schedule thread create --at 2026-10-25T18:26:14Z --to ADDRS --body-file PATH
pana schedule list [--kind session|thread]
pana schedule delete SCHEDULE
```

- Cron uses the domain's local timezone.
- A run missed while the machine was off is skipped.
- A failed scheduled session mails the schedule's creator.

## UI

The PWA has these sections:

- **Inbox.** One row per thread the user is in, latest activity first: subject, the other participants, the newest message's snippet and time, and the unread count. Open the thread, draft, and reply. Archive a thread, or switch to the archived ones and unarchive it.
- **Compose.** Start a session and its thread.
- **Threads.** Browse and search, including only unread or only archived threads, with each thread's unread count. Edit or redact a message, with a warning.
- **Sessions.** Live and past sessions with the whole transcript (thinking, tool calls and results, usage), model, cost, lineage, and state. Stop, compact, archive, reload.
- **Memory.** Browse, search, and edit. Edits commit as the user.
- **Schedules.** Create, edit, and delete.

A reply draft records the thread head when it opens. If the thread moves before send, the PWA shows the new messages and keeps the draft.

Each participant has one color, from the style guide palette, in every thread: the user is blue, the domain's notices are black, and each session keeps the color its URL hashes to. Opening a thread shows its newest message; a message link shows that message.

The keyboard works everywhere outside a text box: `j` and `k` move through rows and messages, `Enter` or `o` opens, `g` then `i`, `t`, `s`, `m`, `c`, or `h` changes section, `/` searches, `r` replies, `e` archives, `u` or `Esc` goes back, and `?` lists every key. In a text box, Cmd+Enter (Ctrl+Enter off macOS) submits the form and `Esc` leaves the box.

`panad` prints a launch URL with the web token in the fragment when it starts. Treat that URL as private: anyone who has it can act as the user. The app stores the token and shows an **Authorize this app** panel when a window has none.

A new message or notice to the user triggers a Web Push notification that opens its thread. Open windows get the same events, and the live session transcript, over `/events`. `panad` holds the VAPID keys and the push subscriptions. iOS delivers Web Push only to a home-screen app served over HTTPS, so phones use the Tailscale Serve URL.

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
- `agent-trailer`. Pana's commit hook replaces it.
- `agent-team`, scratchpads, and `agent-find`, unless pana keeps an equivalent.
- The AGENTS.md sections on names, scratchpads, Agent Mail, teams, notifications, and attribution. Replace them with one section on pana.
