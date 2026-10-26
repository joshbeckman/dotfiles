# pana behavior spec

This spec turns [README.md](README.md) into testable behaviors. Each `- [ ]` item is one test. A work package is done when all its items pass in CI on macOS and Linux.

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
- [x] **CFG-03** Optional keys and defaults: `timezone` (system zone), `subjectModel` (none), `defaultModel`, `spawnDepth` (3), `budget.sessionUsd` (100), `budget.domainDailyUsd` (500), `files.maxBytes` (26214400), `http.port` (8766).
- [x] **CFG-04** `panad` creates the state layout on first start: `pana.sqlite`, `files/`, `memory.git/`, `memory/worktrees/`, `profiles/default.json`, `hooks/`, `web-token`. `web-token` has mode 0600.
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
| GET, POST, DELETE | `/schedules`, `/schedules/:id` | scheduling |
| GET, POST | `/push/key`, `/push/subscriptions` | Web Push |
| GET | `/events` | server-sent events for the PWA |

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

- [x] **RPL-01** When a run settles, its final assistant text posts to the thread whose message started the run, from the session.
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
- [x] **ISO-03** `bash` runs with exactly `PATH`, `HOME`, `USER`, `LANG`, `TERM=dumb`, `PANA_SESSION`, `PANA_STATE`, and the `GIT_CONFIG_*` variables from HOK-01. A test runs `env` and compares.
- [x] **ISO-04** Provider credentials never appear in `bash` output, the transcript, or `panad.log`.

### System prompt

- [x] **PRM-01** Sections render in order: project `AGENTS.md` files, `pana/prompt.md`, profile instructions.
- [x] **PRM-02** Project section: every `AGENTS.md` from the git root of `cwd` down to `cwd`, root first. Outside a git repo, only `cwd/AGENTS.md`.
- [x] **PRM-03** The pana section includes the session's URL, the memory worktree path, and the memory commands.
- [x] **PRM-04** Rendering the prompt twice for the same session gives identical text.

### Tools

- [x] **TOL-01** Tools: `pana_reply`, `pana_thread_read`, `pana_thread_create`, `pana_session_create`, `pana_memory_search`, `pana_memory_commit`.
- [x] **TOL-02** Each tool calls the same API route as its CLI command, with the session as caller. For every tool, a test runs the tool and the CLI command with equal inputs and compares results.
- [x] **TOL-03** A tool error carries the CLI exit code in `structuredOutput.exitCode`.
- [x] **TOL-04** `pana_reply` requires `after`, as THR-03 does.

### Git hooks

- [x] **HOK-01** `bash` sets `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_0=core.hooksPath`, and `GIT_CONFIG_VALUE_0=<state>/hooks`.
- [x] **HOK-02** A commit made through `bash` carries exactly one `Co-authored-by: AI pana://<domain>/sessions/<ulid> <<ulid>@<domain>>`.
- [x] **HOK-03** `git commit --amend` and a second commit do not duplicate the trailer.
- [x] **HOK-04** Every standard hook name in `<state>/hooks` runs the repo's own hook of that name, looked up from local `core.hooksPath`, then global `core.hooksPath`, then `$(git rev-parse --git-path hooks)`. Its exit code is preserved.
- [x] **HOK-05** A repo with a failing `pre-commit` still blocks the commit.
- [x] **HOK-06** Commits made outside pana are unchanged.

---

## WP5: Memory

- [x] **MEM-01** On first start, `memory.git` is a bare repo with one empty commit on `main`.
- [x] **MEM-02** `pana memory` prints the caller's worktree path, creating `memory/worktrees/<id>` on branch `writer/<id>` from `main` if needed.
- [x] **MEM-03** `pana memory commit -m M` stages all changes, commits with author name = caller URL and email = `<id>@<domain>`, rebases onto `main`, and moves `main` with a compare-and-swap `git update-ref`.
- [x] **MEM-04** A rebase conflict aborts the rebase, leaves the commit on `writer/<id>`, and exits 3 with the conflicting paths.
- [x] **MEM-05** Two writers committing different files at once both land on `main`.
- [x] **MEM-06** `pana memory commit` with no changes exits 0 and creates no commit.
- [x] **MEM-07** `pana memory search T` runs a case-insensitive `git grep` over `main` and returns path, line, and text.
- [x] **MEM-08** `pana memory log [PATH]` returns commits with author URL, time, and message.
- [x] **MEM-09** Memory edits from the PWA commit as the user through the same path as MEM-03.

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

---

## WP7: Subjects and search

- [x] **SUB-01** A new thread's subject is the first line of its first message, trimmed to 80 characters.
- [x] **SUB-02** With `subjectModel` set, a background job replaces the subject. Thread create does not wait for it.
- [x] **SUB-03** A failed subject job leaves the first-line subject and logs the failure.
- [x] **SUB-04** `thread subject --regenerate` makes a new subject and keeps the old ones in `subjects`.
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
- [x] **PSH-01** `panad` makes VAPID keys on first start and serves the public key at `/push/key`.
- [x] **PSH-02** The app subscribes after the user allows notifications and posts the subscription.
- [x] **PSH-03** Each delivery to the user and each notice sends a push. Clicking it opens the thread.
- [x] **PSH-04** A subscription that returns 404 or 410 is deleted.

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

- [x] **REF-01** A session with no `--cwd` and no profile `cwd` runs in the panad user's `HOME`, whatever panad's own working directory is.
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
- [x] **UX-08** Vim-like keyboard navigation works everywhere outside text inputs. `j`/`k` move the selection through list rows and thread messages. `Enter` or `o` opens the selection. `g` then `i`/`t`/`s`/`m`/`c`/`h` goes to Inbox, Threads, Sessions, Memory, Compose, or Schedules. `/` focuses search, `r` focuses the reply box, `e` archives the open or selected thread, `u` or `Esc` goes back, and `?` shows a help overlay. `Esc` leaves a text input.
- [x] **UX-09** The bottom of a thread, just above the reply box, shows which participant sessions are working right now (state `running`, or `waiting`), in their participant colors, with a small animated indicator. Indicators appear and disappear live. Every session state change publishes a `session.state` event `{sessionId, state}` on `/events`, from one helper that every state write goes through. `GET /threads/:id` returns each session participant's current state, so a freshly opened thread is right before any event arrives. Inbox and thread-list rows show a small working mark for threads with a working session.
