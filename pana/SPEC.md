# pana behavior spec

This spec turns [README.md](README.md) into testable behaviors. Each `- [ ]` item is one test. A work package is done when all its items pass on macOS and Linux. So far every item has run on macOS only; Linux is unverified.

The README says what pana is. This file says how to check that it works. If they disagree, fix the README first, then this file.

## Conventions

- **Language.** TypeScript on Node 22+. pi-durable is TypeScript, so pana is too.
- **Layout.** All code lives in `pana/`. `pana/bin/pana` and `pana/bin/panad` are the entry points. `bin/pana` in the dotfiles is a symlink to `pana/bin/pana`.
- **Tests.** Vitest. Most tests run `panad` in-process against a temp state directory, a fake clock (pi-durable's `now` and `setTimer`), and pi-ai's faux provider with scripted responses. The end-to-end and smoke tests (INT-04, INT-05) run the real `panad` entry point as a child process with the same scripted faux model. No test calls a real model or touches `~/.local/state/pana`.
- **IDs.** Item IDs (`API-03`) are stable. Add new items at the end of a section. Never renumber.
- **Domain in examples.** `test.example`.

## Work packages

| WP | Scope | Depends on |
|---|---|---|
| WP0 | Foundation: scaffold, config, IDs and URLs, schema, API contract, test harness | none |
| WP1 | `panad` server, transports, CLI framework | WP0 |
| WP2 | Threads, messages, deliveries, inbox, files | WP0 |
| WP3 | Session runtime: lifecycle, delivery, replies, limits | WP0, WP2 |
| WP4 | `pana` extension: system prompt, tools, isolation, git hooks | WP0, WP1 |
| WP5 | Memory | WP0 |
| WP6 | Scheduling | WP2, WP3 |
| WP7 | Subjects and search | WP2 |
| WP8 | PWA and Web Push | WP1 |
| WP9 | Service units, install, `gw`/`gsw` attribution | WP1 |
| WP10 | Integration: providers, push, the PWA on real handlers, end-to-end and smoke tests | WP0–WP9 |

WP0 goes first, built by one agent. It fixes every shared contract: schema, API routes, error shapes, and test helpers. After WP0 merges, WP1, WP2, WP4, WP5, and WP7 can run in parallel. Each builds against the WP0 contracts and fakes what it needs from the others.

---

## WP0: Foundation

### Config and state

- [x] **CFG-01** `panad` reads `~/.local/state/pana/config.json`. `PANA_STATE` overrides the state directory.
- [x] **CFG-02** `config.json` requires `domain` and `user`. `panad` exits with code 2 and names the missing key if either is absent.
- [x] **CFG-03** Optional keys and defaults: `timezone` (system zone), `subjectModel` (none), `defaultModel`, `spawnDepth` (3), `budget.sessionUsd` (100), `budget.domainDailyUsd` (500), `files.maxBytes` (26214400), `http.port` (8766), `tools.bashTimeoutSec` (600), `scratch.ttlDays` (8), `scratch.maxTotalMB` (none).
- [x] **CFG-04** `panad` creates the state layout on first start: `pana.sqlite`, `files/`, `memory.git/`, `memory/worktrees/`, `scratch/`, `profiles/default.json`, `hooks/`, `web-token`. `web-token` has mode 0600.
- [x] **CFG-05** A second `panad` on the same state directory exits with code 1 and a message naming the running PID.

### IDs and URLs

- [x] **ID-01** New IDs are monotonic ULIDs. Two IDs made in the same millisecond sort in creation order.
- [x] **ID-02** `parseRef` accepts a bare ULID, a bare username, or a `pana://` URL, and returns `{kind, id}` for `session`, `user`, `thread`, `message`, `file`, `schedule`.
- [x] **ID-03** In an address list, a 26-character uppercase Crockford string is a session. Any other bare string is a username.
- [x] **ID-04** A URL with a domain other than the configured one is rejected with code `foreign_domain`.
- [x] **ID-05** `formatUrl` and `parseRef` round-trip every kind, including `threads/<id>?message=<id>`.

### Schema

- [x] **DB-01** pi-durable and pana share one `pana.sqlite` through one adapter. pi-durable tables use the `pi_` prefix.
- [x] **DB-02** Pana tables: `participants`, `sessions`, `threads`, `thread_participants`, `messages`, `message_events`, `deliveries`, `files`, `schedules`, `push_subscriptions`, `subjects`, plus FTS5 tables `messages_fts` and `sessions_fts`.
- [x] **DB-03** Migrations run at startup, are numbered, and are idempotent. A database newer than the code refuses to open with code 1.
- [x] **DB-04** A message insert, its deliveries, and the pi-durable submission that wakes a recipient session commit in one transaction. A crash injected between any two statements leaves none of them.

### API contract

The API is HTTP with JSON bodies. `panad` serves the same routes on two listeners: a Unix socket at `<state>/panad.sock` (mode 0600) for the CLI, and TCP on `127.0.0.1:<http.port>` for the PWA.

| Method | Route | Purpose |
|---|---|---|
| POST | `/sessions` | create a session and its thread |
| GET | `/sessions` | search (`query`, `state`, `parent`) |
| GET | `/sessions/:id` | show |
| GET | `/sessions/:id/transcript` | transcript entries |
| POST | `/sessions/:id/stop`, `/resume`, `/compact`, `/archive` | control |
| GET | `/inbox` | caller's inbox, with `unreadCount` (`participant` lets a user view a session's inbox; `view=threads` lists one row per thread) |
| POST | `/threads` | create a thread |
| GET | `/threads` | search (`query`, `archived`, `unread`) |
| GET | `/threads/:id` | read |
| POST | `/threads/:id/messages` | respond |
| POST | `/threads/:id/subject` | regenerate subject |
| POST | `/threads/:id/archive`, `/unarchive` | archive for the caller |
| GET | `/messages/:id` | read one message |
| POST | `/messages/:id/read` | mark read |
| POST | `/messages/:id/revisions`, `/redact` | edit, redact |
| POST | `/files` | upload |
| GET | `/files/:id/:name` | download |
| GET, POST | `/memory/worktree`, `/memory/search`, `/memory/commit`, `/memory/log`, `/memory/files/*` | memory |
| GET | `/memory/files` | list the files on `main` |
| DELETE | `/memory/files/*` | commit a file removal as the caller, preserving Git history |
| GET, POST, DELETE | `/schedules`, `/schedules/:id` | scheduling |
| GET, POST | `/push/key`, `/push/subscriptions` | Web Push |
| GET | `/events` | server-sent events for the PWA: `delivery`, `notice`, `session.entry`, `session.state`, `session.live` |

- [x] **API-01** Errors return `{"error": {"code", "message", ...details}}`.
- [x] **API-02** Status codes map to CLI exit codes: 400 → 2, 404 → 4, 409 → 3, 402 → 5, any other non-2xx → 1.
- [x] **API-03** On the socket, the caller is the session named by the `Pana-Caller` header, or the configured user when the header is absent. An unknown session in `Pana-Caller` returns 400.
- [x] **API-04** On TCP, every request needs `Authorization: Bearer <web-token>`. A missing or wrong token returns 403. The caller is always the configured user.
- [x] **API-05** TCP accepts `Host` values of `127.0.0.1`, `localhost`, and the machine's Tailscale name. Any other `Host` returns 403.

### Test harness

- [x] **TST-01** `startTestPanad({script})` returns a running `panad` on a temp directory with a fake clock, a faux model, and a socket client.
- [x] **TST-02** A faux model script can return text, tool calls, failures, and usage with cost, per turn.
- [x] **TST-03** `clock.advance(ms)` fires due pi-durable sleeps and pana schedules.

---

## WP1: Server and CLI

- [x] **SRV-01** `panad` starts, listens on both transports, and logs one JSONL line per request to `<state>/panad.log` with route, caller, status, and duration. Bodies are never logged.
- [x] **SRV-02** On SIGTERM, `panad` stops accepting requests, closes the Harness, and exits 0. Runs in progress resume at the next start.
- [x] **SRV-03** After a crash mid-run, the next start calls `harness.resume()` and the run finishes.
- [x] **CLI-01** `pana` talks only to the socket. If `panad` is not running, it exits 1 with `panad is not running`.
- [x] **CLI-02** `pana` sends `Pana-Caller` from `PANA_SESSION` when set.
- [x] **CLI-03** Output is text when stdout is a TTY and JSON otherwise. `--json` forces JSON.
- [x] **CLI-04** `--body TEXT`, `--body-file PATH`, and `--body -` (stdin) are mutually exclusive. Two of them, or none where a body is required, exit 2.
- [x] **CLI-05** Exit codes follow API-02.
- [x] **CLI-06** `pana --help` and `pana <noun> --help` list every command in the README.
- [x] **CLI-07** Unknown commands and flags exit 2 with usage.

---

## WP2: Threads, messages, inbox, files

### Threads

- [x] **THR-01** `thread create --to A,B` creates a thread whose participants are the caller, A, and B.
- [x] **THR-02** Every message goes to every participant except its sender, as one delivery row each.
- [x] **THR-03** `thread respond` without `--after` exits 2.
- [x] **THR-04** `thread respond --after M` where M is the thread's newest message appends the message.
- [x] **THR-05** `thread respond --after M` where M is older than the newest message returns 409 with the IDs of the newer messages, and appends nothing.
- [x] **THR-06** `--after` naming a message in another thread returns 400.
- [x] **THR-07** Two concurrent responds with the same `--after` produce exactly one append and one 409.
- [x] **THR-08** `--cc C` adds C as a participant. C receives this message and later ones, not earlier ones.
- [x] **THR-09** A caller who is not a participant cannot respond (403), except the user, who may respond to any thread and becomes a participant.
- [x] **THR-10** `thread read` returns messages in order with sender URLs, timestamps, and current revisions, and marks them read for the caller.

### Edits and redactions

- [x] **EDT-01** Only the user may revise or redact. A session gets 403.
- [x] **EDT-02** A revision appends a `message.revised` event. Reads show the newest body and a `revised` flag. The original stays in `message_events`.
- [x] **EDT-03** A redaction appends `message.redacted`. Reads show `[redacted]` and no body.
- [x] **EDT-04** No code path issues `UPDATE` or `DELETE` on `messages`. A test greps the source.
- [x] **EDT-05** Revisions and redactions do not create deliveries and do not wake sessions.

### Inbox

- [x] **INB-01** `session inbox S` lists S's deliveries with message ID, thread ID, subject, sender, recipients, time, and read state, newest first.
- [x] **INB-02** `session inbox read S M` returns the full message and marks it read for S.
- [x] **INB-03** `GET /inbox` with no `participant` returns the caller's inbox. A session may not read another session's inbox (403). The user may read any.

### Notices

- [x] **NTC-01** `panad` posts notices as the domain URL `pana://<domain>`. A notice delivers to users only and never wakes a session.

### Files

- [x] **FIL-01** `--attach PATH` copies the file to `files/<ulid>/<basename>` and records path, size, media type, and uploader.
- [x] **FIL-02** The CLI appends a Markdown reference per attachment: `![name](url)` for images, `[name](url)` otherwise.
- [x] **FIL-03** A file over `files.maxBytes` returns 400 and copies nothing.
- [x] **FIL-04** `GET /files/:id/:name` serves the bytes with the recorded media type. A wrong name returns 404.
- [x] **FIL-05** File bytes are never stored in SQLite.
- [x] **FIL-06** Both PWA composers attach files: an Attach button, a file dropped on the composer, and a screenshot pasted into the message box each upload through `POST /files` and append the FIL-02 Markdown reference to the body, so the composer shows exactly the message it sends. A failed upload says why and leaves the body unchanged.
- [x] **FIL-07** `GET /files/:id/:name?w=N` serves an image no wider than N pixels (16 to 2048, clamped; anything else serves the original). The copy is made on first request by the host's resizer (`sips`, `magick`, or `convert`) and kept in `files/<ulid>/.resized/`, so a second request and a reopened thread read it again. The original bytes are never modified and no derivative outlives a failed run. A request at or above the source width, a type the resizer does not handle (only JPEG and PNG are), a host with no resizer, and a resizer that fails all serve the original. The PWA asks for `?w=1024` for an inline image and links the original.

---

## WP3: Session runtime

### Create

- [x] **SES-01** `session create --prompt P` creates a session, a thread with the caller and the session, and a first message with body P from the caller. It returns all three as JSON.
- [x] **SES-02** `--to` adds more participants to that thread.
- [x] **SES-03** Profile values apply, and flags override them. An unknown profile returns 400.
- [x] **SES-04** `cwd: "worktree"` creates a git worktree for the session under `<state>/worktrees/<ulid>` from the repo named by `--cwd`.
- [x] **SES-05** A session created by a session records `parent`. Its depth is the parent's plus one.

### States

- [x] **STA-01** A new session is `running` until its first run settles, then `idle`.
- [x] **STA-02** A run that ends `unanswered` sets `failed` and posts a notice in the triggering thread.
- [x] **STA-03** A session asleep on a timer or a child task reports `waiting`.
- [x] **STA-04** `session stop` aborts the current run and sets `stopped`.
- [x] **STA-05** `session resume` on a stopped session sets `idle` and delivers queued mail in order.
- [x] **STA-06** `session search --state S` returns only sessions in state S.
- [x] **STA-07** Archived sessions are read-only. Messages to them return 409.

### Delivery

- [x] **DLV-01** A message to an idle or failed session submits a pi-durable input with entry kind `pana.message`, and the session becomes `running`.
- [x] **DLV-02** The model input contains the sender URL, the thread URL, the message URL, the subject, the body, and the local path of each attachment.
- [x] **DLV-03** Delivery to a session marks the message read for it.
- [x] **DLV-04** A message from a session to a running session queues as a follow-up and starts the next run.
- [x] **DLV-05** A message from a user to a running session submits a steer. It reaches the model after the current tool round. If the run ends first, it starts the next run.
- [x] **DLV-06** A message to a stopped session wakes nothing and stays unread.
- [x] **DLV-07** Messages from one session to a thread do not wake that same session.

### Replies

- [x] **RPL-01** When a run settles, its final assistant text posts to the thread whose message started the run, from the session, subject to RPL-06.
- [x] **RPL-02** The auto-post's head is the newest message of that thread in the session's transcript.
- [x] **RPL-03** If the thread moved during the run, the reply is not posted. The next run's input lists the new messages and says the previous reply was not posted.
- [x] **RPL-04** If the session already posted to the triggering thread during the run, there is no auto-post.
- [x] **RPL-05** An empty final answer posts nothing.
- [x] **RPL-06** A run started by another session's follow-up posts nothing automatically. Only a run started by a user's message, or by the thread's first message (the prompt that created the session), auto-posts. A session that needs to answer another session uses `pana_reply`.

### Limits

- [x] **LIM-01** A session at `spawnDepth` gets 402 from `session create`.
- [x] **LIM-02** A session whose cost passes `budget.sessionUsd` is stopped, and a notice goes to its creator.
- [x] **LIM-03** When the domain's cost for the local day passes `budget.domainDailyUsd`, new runs do not start, `session create` returns 402, and the user gets a notice. Runs resume the next local day.
- [x] **LIM-04** `session show` reports cost from pi-durable usage.

---

## WP4: The pana extension

### Isolation

- [x] **ISO-01** The registry holds only `CodingTools` and `pana`. A test asserts the installed extension names.
- [x] **ISO-02** A session's system prompt contains nothing from `~/.pi/agent`.
- [x] **ISO-03** `bash` runs with exactly `PATH` (pana's own `bin` first), `HOME`, `USER`, `LANG`, `TERM=dumb`, `PANA_SESSION`, `PANA_STATE`, `PANA_SCRATCH` (SCR-01), `PANA_BROWSER_SESSION` (ISO-06), and the `GIT_CONFIG_*` variables from HOK-01. A test runs `env` and compares.
- [x] **ISO-04** Provider credentials never appear in `bash` output, the transcript, or `panad.log`.
- [x] **ISO-06** `bash` exports `PANA_BROWSER_SESSION=pana-<session>`. `bin/chrome-devtools`, first on a session's `PATH` (ISO-03), runs the installed CLI with `--sessionId` that value, so every session drives its own chrome-devtools daemon (socket, pid file, and headless Chrome) instead of the machine-wide one. The first call starts that daemon with `--isolated`, because a daemon the CLI starts implicitly opens the machine-wide Chrome profile and the next session's daemon then cannot ("The browser is already running for …/chrome-devtools-mcp-cli/chrome-profile"); a daemon that is already running is never started again, because `start` restarts it and closes its pages, and `status`/`stop` start nothing. A call that carries its own `--sessionId`, or a shell with no `PANA_BROWSER_SESSION`, runs the CLI unchanged; a second copy of pana's `bin` on the same `PATH` does not re-enter the shim, and no CLI on `PATH` is exit 127, not a loop.
- [x] **ISO-07** panad stops a session's daemon (`chrome-devtools --sessionId pana-<session> stop`) when it archives the session, and sweeps every five minutes on `runtime.clock` to stop the daemons of archived sessions, of sessions idle for ten minutes or more, and of sessions it has no row for. A running or waiting session keeps its daemon, and the next `chrome-devtools` call starts a fresh one.

### System prompt

- [x] **PRM-01** Sections render in order: project `AGENTS.md` files, `pana/prompt.md`, profile instructions.
- [x] **PRM-02** Project section: every `AGENTS.md` from the git root of `cwd` down to `cwd`, root first. Outside a git repo, only `cwd/AGENTS.md`.
- [x] **PRM-03** The pana section includes the session's URL, the memory worktree path, and the memory commands.
- [x] **PRM-04** Rendering the prompt twice for the same session gives identical text.
- [x] **PRM-06** The rendered prompt directs sessions encountering meaningful tool, documentation, environment, or instruction friction to the optional `toil/README.md` workflow in their memory worktree. It requires deduplication, evidence and observed costs, excludes ordinary task difficulty and retry inflation, skips absent workflows without unsolicited setup, and grants no authority beyond journal maintenance.
- [x] **PRM-05** The rendered house rules permit a fast-forward of the user's checkout only on explicit user request. The session verifies checkout path, branch, remote/upstream, and working-tree status; requires no staged or tracked changes; leaves untracked files untouched; uses `git pull --ff-only` without autostash; and never switches branches, stashes, discards changes, resets, rebases, or resolves conflicts automatically. It stops when fast-forward is impossible or local files would be overwritten. Other sessions' worktrees and memory publishing remain protected.

### Tools

- [x] **TOL-01** Tools: `pana_reply`, `pana_thread_read`, `pana_thread_create`, `pana_session_create`, `pana_memory_search`, `pana_memory_commit`, and `pana_schedule_wake` (WAK-01).
- [x] **TOL-02** Each tool calls the same API route as its CLI command, with the session as caller. For every tool, a test runs the tool and the CLI command with equal inputs and compares results.
- [x] **TOL-03** A tool error carries the CLI exit code in `structuredOutput.exitCode`.
- [x] **TOL-04** `pana_reply` requires `after`, as THR-03 does.

### Git hooks

- [x] **HOK-01** `bash` sets `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_0=core.hooksPath`, and `GIT_CONFIG_VALUE_0=<state>/hooks`.
- [x] **HOK-02** A commit made through `bash` carries exactly one `Co-authored-by: AI pana://<domain>/sessions/<ulid> <user.email>`, with the address from git config.
- [x] **HOK-03** `git commit --amend` and a second commit do not duplicate the trailer.
- [x] **HOK-04** Every standard hook name in `<state>/hooks` runs the repo's own hook of that name, looked up from local `core.hooksPath`, then global `core.hooksPath`, then `$(git rev-parse --git-path hooks)`. Its exit code is preserved.
- [x] **HOK-05** A repo with a failing `pre-commit` still blocks the commit.
- [x] **HOK-06** Commits made outside pana are unchanged.

---

## WP5: Memory

- [x] **MEM-01** On first start, `memory.git` is a bare repo with one empty commit on `main`.
- [x] **MEM-02** `pana memory` prints the caller's worktree path, creating `memory/worktrees/<id>` on branch `writer/<id>` from `main` if needed. A session's worktree is also made on first use (its first prompt render or tool call). Each worktree has its own git identity, so a plain `git commit` in it is authored by its writer.
- [x] **MEM-03** `pana memory commit -m M` stages all changes, commits with author name = caller URL and email = `<id>@<domain>`, rebases onto `main`, and moves `main` with a compare-and-swap `git update-ref`. With a clean tree it still publishes commits the writer made with plain `git`.
- [x] **MEM-04** A rebase conflict aborts the rebase, leaves the commit on `writer/<id>`, and exits 3 with the conflicting paths.
- [x] **MEM-05** Two writers committing different files at once both land on `main`.
- [x] **MEM-06** `pana memory commit` with no changes exits 0 and creates no commit.
- [x] **MEM-07** `pana memory search T` runs a case-insensitive `git grep` over `main` and returns path, line, and text.
- [x] **MEM-08** `pana memory log [PATH]` returns commits with author URL, time, and message.
- [x] **MEM-09** Memory edits from the PWA commit as the user through the same path as MEM-03.
- [x] **MEM-10** `GET /memory/commits/:hash` returns a commit's hash, message, author, time, parents, and each changed file's status, line counts, and unified patch. An unknown hash is 404; a value that is not a hash is 400 and never reaches git as an option.
- [x] **MEM-11** The Memory view shows one thing at a time: a browse view with the file list and the log, one rendered file with a Source toggle and an Edit button, one commit, or the editor. A file view does not show the file list or an edit pane, and a log row opens its commit view.
- [x] **MEM-12** Editing or creating a memory file opens a full-view CodeMirror editor with line numbers and Markdown highlighting, loaded only when editing. The save chord in the form commits as the user, and a new file names its path first.
- [x] **MEM-13** A memory file has an explicit Delete action with confirmation and cancellation. Confirming commits its removal as the user through the normal publish path, returns to the file list, and preserves Git history. `DELETE /memory/files/*` rejects missing files, unsafe paths, and dirty/unpublished writer worktrees; clean stale worktrees fast-forward before deletion.

---

## WP6: Scheduling

- [x] **SCH-01** `schedule session create --cron C --prompt P` stores a schedule. At each cron time in `timezone`, it creates a session as SES-01 with the schedule's creator as caller.
- [x] **SCH-02** `--at T` runs once at T, then the schedule is `done`.
- [x] **SCH-03** `--cron` and `--at` together, or neither, exit 2. A past `--at` exits 2.
- [x] **SCH-04** `schedule thread create --at T --to A --body-file F` creates the thread at T, from the creator. The body is read at schedule time, not run time.
- [x] **SCH-05** On startup, a cron schedule whose time passed while `panad` was down skips to its next future time. A one-off whose time passed is marked `missed` and a notice goes to its creator.
- [x] **SCH-06** A scheduled session that fails posts a notice to the creator.
- [x] **SCH-07** `schedule list [--kind]` and `schedule delete` work. A deleted schedule never fires.
- [x] **SCH-08** A DST change fires a daily cron job once per day.
- [x] **SCH-09** All schedule kinds (`session`, `thread`, `wake`) accept recurring `--cron` schedules with optional `--check COMMAND`, `--check-cwd DIR`, and `--stop-after-success` (API `check: string | null`, `checkCwd: string | null`, `stopAfterSuccess: boolean`, default false). These options require cron; checks must be nonempty; check cwd requires a check and an absolute directory. Without an explicit check cwd, creation captures the daemon's `process.cwd()`, not the client's or a scheduled session's cwd. Without a check, `check` and `checkCwd` are null.
- [x] **SCH-10** Before dispatch, a check exiting 0 passes and dispatches the scheduled action; exit 1 means not ready and skips that occurrence. Each result is persisted and exposed as `lastCheck` in list/detail responses: `{checkedAt, status: "passed" | "not_ready" | "failed", exitCode, signal, stdout, stderr, error}`, or null before any check. A skipped occurrence leaves the recurring schedule active for its next future time.
- [x] **SCH-11** Any other check exit code, signal, timeout, or execution error records `failed`, skips dispatch, and posts a failure notice to the creator. No session is created or woken for a not-ready or failed check; exit 1 produces no failure notice.
- [x] **SCH-12** Checks run `bash --noprofile --norc -c COMMAND` with the daemon's environment and recorded check cwd, with a 30-second timeout and at most 8 KiB retained per stdout/stderr stream. Timeout/shutdown settles without waiting for pipe EOF and kills the ordinary process group. Checks must not daemonize, enable job control, or move children to other groups; escaped children are not guaranteed to be terminated. Check output is diagnostic only, never added to agent prompts.
- [x] **SCH-13** Checks for different schedules run concurrently, without overlap of a single schedule's check/dispatch. Missed cron occurrences continue to skip rather than replay, including after restart.
- [x] **SCH-14** `--stop-after-success` finishes a recurring schedule only after successful dispatch, not after a passing check alone. It works with or without a check; not-ready/failed checks or a failed dispatch do not finish it. Dispatch success means the action was submitted, not that the resulting session completed successfully.


---

## WP7: Subjects and search

- [x] **SUB-01** A new thread's subject is the first line of its first message, trimmed to 80 characters.
- [x] **SUB-02** With `subjectModel` set, a background job replaces the subject. Thread create does not wait for it.
- [x] **SUB-03** A failed subject job leaves the first-line subject and logs the failure.
- [x] **SUB-04** `thread subject --regenerate` reads the current conversation, makes a new subject, and keeps the old ones in `subjects`. It respects revisions and redactions; long conversations use up to 100 recent readable messages and a 32,000-character input budget, truncating individual messages to preserve recent context. Initial background naming still uses the first message.
- [x] **SRC-01** `thread search --query Q` searches subjects and message bodies with FTS5 and returns thread, message, and a snippet.
- [x] **SRC-02** Redacted text is removed from the index. Revised text replaces the old text.
- [x] **SRC-03** `session search --query Q` searches user and assistant text of transcripts, indexed when each run settles.

---

## WP8: PWA and Web Push

- [x] **WEB-01** `panad` serves the PWA at `/` on TCP. `panad` prints a launch URL with the token in the fragment.
- [x] **WEB-02** The app stores the token. A 403 shows an "Authorize this app" panel, as in agent-mail-web.
- [x] **WEB-03** Sections: Inbox, Compose, Threads, Sessions, Memory, Schedules. Each works end to end in a browser test against a test `panad`.
- [x] **WEB-04** Messages render Markdown, images, and Mermaid. Reuse `apps/agent-mail-web/renderers.js` and `mermaid-renderer.js`.
- [x] **WEB-05** `pana://` links render as links to the matching app routes or `/files/` URLs.
- [x] **WEB-06** The Sessions view streams a live transcript through `/events` and has stop, compact, and reload controls.
- [x] **WEB-07** A reply draft records the thread head when opened. On a 409, the app shows the new messages and keeps the draft.
- [x] **WEB-08** Editing or redacting a message asks for confirmation and says that sessions keep what they already received.
- [x] **WEB-09** The app icon is the woven braid (`web/favicon.svg`). `panad` serves PNG copies without the token: a 180 px `apple-touch-icon.png` for iOS home screens, 192 and 512 px icons, and a 512 px maskable icon. The shell links the touch icon, the manifest lists all of them, and push notifications use the 192 px icon.
- [x] **PSH-01** `panad` makes VAPID keys on first start and serves the public key at `/push/key`.
- [x] **PSH-02** The app subscribes after the user allows notifications and posts the subscription.
- [x] **PSH-03** Each delivery to the user and each notice sends a push. Clicking it opens the thread.
- [x] **PSH-04** A subscription that returns 404 or 410 is deleted.
- [x] **PSH-05** A click lands on its thread however the browser delivers it. The worker navigates the window where it may, messages the page, and opens one when none is open; it also leaves the route in Cache Storage, which the page adopts on boot and on focus. A delivery's notification tag names its thread, so a browser that drops the notification's `data` still says where the click goes.

---

## WP9: Service and integration

- [x] **SVC-01** `Library/LaunchAgents/org.joshbeckman.panad.plist` runs `panad` at login and restarts it on exit.
- [x] **SVC-02** `.config/systemd/user/panad.service` does the same on Linux, and `setup` enables it.
- [x] **SVC-03** The service injects provider credentials with `s KEY... -- panad`. Pana never writes them to disk.
- [x] **SVC-04** `Brewfile` lists any new formula pana needs.
- [x] **GW-01** `gw` and `gsw` attribute posts when `PANA_SESSION` is set, using the session URL in the trailer.

---

## WP10: Integration

Each package was built against contracts and fakes. These items prove the packages work together.

- [x] **INT-01** `panad` registers every pi-ai provider whose credentials are in its environment. Model IDs are `provider/model-id`. `config.defaultModel` is the model of a session with no model or profile model. A model from an unregistered provider is a 400 that names the provider.
- [x] **INT-02** The PWA reads the real handler shapes in every view, and `npm run test:web` runs its flows against a real test `panad` with the faux model. Editing a schedule keeps its time: the form shows an `--at` time, and an update with neither `cron` nor `at` keeps the stored time.
- [x] **INT-03** Every delivery to the user and every notice publishes a Web Push and an `/events` event after its transaction commits. A failed push does not roll back the message. pi-durable commits stream the session transcript through `/events`.
- [x] **INT-04** One test drives only `pana/bin/pana` against a real `panad` child process with a scripted faux model: `session create`, a `bash` call that runs `pana memory` and `pana memory commit` and makes a git commit, the answer in `thread read`, a second wake from `thread respond --after`, the session URL in `memory log`, and the commit trailer.
- [x] **INT-05** `pana/scripts/smoke` starts a throwaway `panad` with the provider keys in its environment, creates a session from the CLI, and prints the thread and the PWA launch URL. `PANA_SMOKE_FAUX=1` runs it with the faux model, and `--keep` leaves `panad` running.
- [x] **INT-06** README has a "Run it" section: `config.json`, `panad` directly and as a service, the CLI, and the PWA. README and this spec match what the build does.

---

## WP11: Refinements from first use

- [x] **REF-01** A session with no `--cwd` and no profile `cwd` runs in the panad user's `HOME`, whatever panad's own working directory is. SCR-02 later replaced the HOME default with the session's scratch directory; panad's own working directory is still never used.
- [x] **REF-02** `pana session archive SESSION` calls `POST /sessions/:id/archive`. Only the user may archive. An archived session follows STA-07. The PWA session view has an Archive button that asks for confirmation.
- [x] **REF-03** `pana thread archive THREAD` and `pana thread unarchive THREAD` call `POST /threads/:id/archive` and `/unarchive`. Archiving is per participant: it hides the thread from that participant's inbox and default thread list only. `GET /threads?archived=1` and `pana thread search --archived` list archived threads.
- [x] **REF-04** A new message delivered to a participant unarchives the thread for that participant.
- [x] **REF-05** Inbox items and thread list items carry the caller's `unreadCount`. `GET /threads?unread=1` and `pana thread search --unread` return only threads with unread messages.
- [x] **REF-06** The PWA marks threads with unread messages and shows their count. The nav shows the inbox unread count. Both update live from `/events`, and opening a thread clears its count.
- [x] **REF-07** The PWA inbox and thread views have Archive and Unarchive buttons.
- [x] **REF-08** Every ID and `pana://` URL the PWA shows is a link to its view: sessions to the session view, threads to the thread, messages to the thread scrolled to the message, schedules to the schedule, files to the file, and the user to the inbox. That includes senders, participants, headers, and `pana://` URLs inside message bodies and transcripts.
- [x] **REF-09** The session view shows the complete transcript: thinking blocks (collapsed by default), every tool call with its full arguments, every tool result with its full output (collapsed when long), system and compaction entries, and per-turn usage.

## WP12: Scale

- [x] **SCALE-01** `pana/scripts/bench` drives a real `panad` child with the faux model through the socket. It creates N sessions concurrently (default 200), M threads (default 1000) of K messages each (default 5), and a fan-out where sessions create child sessions up to `spawnDepth`. It reports throughput, p50 and p99 latency per route, panad RSS, and database size.
- [x] **SCALE-02** Under the bench, no request fails. Every message is delivered exactly once to every recipient, and every session run posts its reply. The bench checks this from the database.
- [x] **SCALE-03** List routes (`/inbox`, `/threads`, `/sessions`, `/schedules`) take `limit` and a `cursor` and return a `nextCursor`. With 10,000 threads, each list call answers in under 100 ms at p99. The PWA lists load more on scroll or with a button.
- [x] **SCALE-04** `pana/BENCH.md` records the bench results on this machine, each bottleneck found, and its fix.

## WP13: PWA usability

- [x] **UX-01** Clicking Notifications and choosing Allow in the browser prompt subscribes to Web Push, in Chrome on `http://127.0.0.1` and on the Tailscale HTTPS URL. When the browser does block notifications, the app names the real cause and how to fix it, instead of a generic "permission denied".
- [x] **UX-02** Cmd+Enter (Ctrl+Enter off macOS) submits the form that has focus, in every form: reply, compose, edit, memory, schedules.
- [x] **UX-03** The inbox lists threads, not messages. It shows one row per thread the user participates in and has not archived, ordered by latest activity. Each row shows the subject, the participants, a snippet of the latest message, its time, and a clear unread mark with the count.
- [x] **UX-04** Edit and Redact are small secondary controls on each message, not full-size buttons.
- [x] **UX-05** Opening a thread scrolls to its latest message. A link to a specific message scrolls to that message.
- [x] **UX-06** In a thread, each participant's messages have a left border in that participant's own color. A participant keeps the same color in every thread, and the user always has the same color. Colors come from the style guide palette.
- [x] **UX-07** The PWA's layout is consistent. Labels and controls align vertically, spacing has one rhythm, and every control sits visibly inside the form or section it acts on.
- [x] **UX-08** Vim-like keyboard navigation works everywhere outside text inputs. `j`/`k` move the selection through list rows and thread messages. `Enter` or `o` opens the selection. `g` then `i`/`t`/`s`/`m`/`c`/`h` goes to Inbox, Threads, Sessions, Memory, Compose, or Schedules. `/` focuses search, `r` focuses the reply box, `e` archives the open or selected thread and, from an open thread, returns to the list it was opened from, `u` or `Esc` goes back, and `?` shows a help overlay. `Esc` leaves a text input.
- [x] **UX-09** The bottom of a thread, just above the reply box, shows which participant sessions are working right now (state `running`, or `waiting`), in their participant colors, with a small animated indicator. Indicators appear and disappear live. Every session state change publishes a `session.state` event `{sessionId, state}` on `/events`, from one helper that every state write goes through. `GET /threads/:id` returns each session participant's current state, so a freshly opened thread is right before any event arrives. Inbox and thread-list rows show a small working mark for threads with a working session.
- [x] **UX-10** Opening a session scrolls to its newest transcript entry. The session's header, details, controls, and `pana://` URL stay pinned below the nav while the transcript scrolls. New live entries are followed only when the reader is already at the bottom.
- [x] **UX-13** The nav has no Compose item. A New button on the Threads page opens the composer, and the nav marks Threads while it is open. `g c` still opens it.
- [x] **UX-11** The session view renders assistant text and thinking as Markdown, sanitized the same way as thread messages. Every entry has a Raw toggle that shows its exact source text, so nothing the renderer hides is lost.
- [x] **UX-12** The session view streams work in progress. While a session runs, it shows the generation in progress (thinking and text as they stream) and every running tool call (its name, full arguments, elapsed time, and output as it streams). The stream comes from pi-durable's `pi.live` document through `/events`. In-progress blocks are replaced by the committed entries when they land. The thread's working chip (UX-09) names what the session is doing, e.g. "running bash · 3m".
- [x] **UX-14** The Notifications button shows only when there is something to do. When this device is subscribed, it is hidden. When the browser blocks notifications, it reads "Notifications blocked", and a click explains the fix. Otherwise it reads "Notifications", and a click asks and subscribes. A window that loads with permission already granted keeps it hidden while the quiet re-subscribe runs, and shows it again if that fails.
- [x] **UX-15** Cmd+K (Ctrl+K) opens a command palette over whatever is in front, including a half-written reply, and closes back to it. It lists every action the page can take in that state — the sections, New thread, opening the selection, archiving, a session's own controls, notifications, back, help — matched fuzzily as you type, with the arrows and Enter choosing. Its Search command opens a second input that asks threads, sessions, and memory at once and shows the best hits of each in one list, ranked by the same match. A phone has no Cmd, so a magnifier button in the top bar opens it too.
- [x] **UX-16** The open thread's header has a Regenerate subject button, and the command palette lists the same action while a thread is open. It asks the subject model through `POST /threads/:id/subject` with `regenerate`, swaps the thread's heading for the new subject without reloading the thread, and leaves the old subjects in the thread's history (SUB-04). With no `subjectModel` in config.json it says to set one, rather than showing a generic failure.
- [x] **MOB-01** At a 390 px phone viewport, no view scrolls sideways or clips text: inbox, thread, threads, compose, sessions, session, memory, and schedules. Wide content scrolls only inside its own block, such as a code block. `test/browser/mobile.spec.ts` emulates the phone and measures every element.
- [x] **MOB-02** Long unbroken text (a pasted URL, a model ID, a path, a `pana://` URL, a message ID) wraps inside its row instead of widening the page.
- [x] **MOB-03** On a phone, a view header puts Back and the title on one row and the controls on their own row below. The session title is the session's short label, as everywhere else, and the full ID stays in its `pana://` URL.
- [x] **ISO-05** A `bash` tool call without a timeout gets a default one (`tools.bashTimeoutSec` in config.json, default 600). A call that hits it is killed with its whole process group, and the model gets an error result that says it timed out.

## WP16: Scratch

A session's scratch directory is its own place for throwaway work: scripts, downloads, clones, and output. Scratch is disposable and memory is durable, so pana deletes scratch on its own schedule and never copies it into memory.

- [x] **SCR-01** Each session has a scratch directory at `scratch/<session-id>/` under the state directory. panad creates it whenever it opens the session's environment, so it exists at the start of every run, even after a sweep removed it. The `bash` tool exports its path as `PANA_SCRATCH`. `pana scratch` (`GET /scratch`) prints the caller's path, and the user's call names a session with `--session`.
- [x] **SCR-02** A session created with no `--cwd` and no profile `cwd` starts in its scratch directory. This replaces REF-01's HOME default. An explicit `--cwd`, a profile `cwd`, and a profile worktree still win.
- [x] **SCR-03** `pana/prompt.md` gives the session its scratch path. It says scratch is for throwaway work and will be deleted, and that anything worth keeping, a useful script included, goes to memory with `pana memory commit`.
- [x] **SCR-04** Archiving a session removes its scratch directory.
- [x] **SCR-05** panad sweeps scratch when it starts and every 24 hours after, on `runtime.clock`. The sweep removes scratch that belongs to an archived session, to no session at all, or to a session whose state is not `running` or `waiting` and whose `updated_at` is older than `scratch.ttlDays` (config.json, default 8). When `scratch.maxTotalMB` is set and the remaining scratch is larger, it then removes the longest-idle scratch until the total fits. It never removes the scratch of a `running` or `waiting` session. Each removal checks the state and renames the directory inside one write transaction, so a wake cannot start a run between the check and the removal. The renamed directory is deleted after the commit.
- [x] **SCR-06** Each removal records `scratch_removed_at` and `scratch_removed_bytes` on the session. The pana prompt section then says when the scratch was removed, why, and how large it was. The section's change puts that note in the session's transcript once, and a session woken later knows its old files are gone.
- [x] **SCR-07** `pana scratch prune [--dry-run]` (`POST /scratch/prune`, the user only) runs the sweep now and lists each scratch it removed, or would remove, with its session, reason, and size. `GET /sessions/:id` includes `scratch: {path, bytes}`, `bytes` null when the directory does not exist, and the PWA's session header shows the size.

## WP17: Wakeups

A session waits for anything outside its run by scheduling a wake and ending the run. Sleeping in `bash` held a run, and its budget, open for nothing.

- [x] **WAK-01** `pana schedule wake (--in DURATION | --at TIME | --cron CRON) --note TEXT [--session SESSION]` (`POST /schedules` with `kind: "wake"`), and the `pana_schedule_wake` tool. `--in` takes `90s`, `10m`, `2h`, or `1d`. A session wakes only itself, and naming another session is 403. The user must name a session. A wake needs a note, and cannot target an archived session (409). Migration 7 adds `wake` to the schedule kinds.
- [x] **WAK-02** When a wake fires, the scheduler submits its note to the session as input (`pana.wake` entry, `followUp` when busy, `requestId` `pana.wake:<schedule>` for one-shots or `pana.wake:<schedule>:<occurrence timestamp>` for cron) and sets the session `running`, the same way a delivery does. A stopped or archived session is not woken. Nothing is posted at the end of the run, because RPL-01 finds no delivery behind it. The input says so, and the note names where to reply.
- [x] **WAK-03** A one-shot wake that came due while `panad` was down fires at startup. This is the one exception to SCH-05, because a session is waiting on it.
- [x] **WAK-04** `pana schedule list --kind wake` lists pending wakes, and `pana schedule delete` cancels one.
- [x] **WAK-05** `pana/prompt.md` has a Waiting section. It tells the session never to sleep or poll for something outside its run, to schedule a wake with a note that names the thread to reply in, to back off when the thing is still not ready, and that `bash` refuses long sleeps.
- [x] **WAK-06** `bash` refuses a command whose longest `sleep` is 60 seconds or more, with an error that names `pana schedule wake`. GNU `sleep 1m 30s` counts as 90. Shorter sleeps run, so a command can still wait for a local server it started.
- [x] **WAK-07** A one-shot wake that reaches its session is deleted as soon as it fires, not after a grace period: the scheduler marks the schedule `deleted` in the same fire, once `wakeScheduled` says the note was submitted. So `pana schedule list --kind wake` lists only wakes that are still pending, and the list stays honest as sessions wake and end. A wake that reached no session, because its session is stopped or archived, keeps its row as `done`, so `done` means claimed but never woken rather than `fired`. The deleted row stays in the table, but `GET /schedules/:id` and `pana schedule delete` answer 404 for it, and the `Schedule:` URL inside the wake's input is a dead link. That is deliberate: the URL stays in the input because a dead reference beats an unanswerable `which wake was this?`.
