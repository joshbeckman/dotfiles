# pana bench

`scripts/bench` proves pana holds up under a large fan-out (SCALE-01, SCALE-02). This file records its results on this machine, each bottleneck it found, and the fix (SCALE-04).

## Run it

```sh
pana/scripts/bench                      # N=200 sessions, M=1000 threads of K=5 messages
pana/scripts/bench --list-threads 10000 # then grow to 10,000 threads and time every list route
pana/scripts/bench --help               # every option
```

The bench starts a real `panad` child on a temporary state directory, with a faux model that answers from the transcript it is given. It drives `panad` only through the Unix socket, as the CLI does, and waits for answers on `/events`. Latency per route comes from `panad`'s own request log, so it covers the sessions' tool calls too. When the run ends, the bench stops `panad` and checks the database. It exits 1 when a check fails.

| Phase | What it does |
|---|---|
| sessions | N sessions created at once. Each answers its first prompt. |
| threads | M threads between the user and those sessions, C=50 in flight. The user sends K messages to each and waits for each answer. |
| broadcast | 5 messages to one thread with all N sessions. Each append delivers to and wakes N sessions in one transaction. |
| fan-out | 10 sessions that each create 2 children per level, down to `spawnDepth` 3: 150 sessions. |
| lists | Seed the inbox to 10,000 threads and 200 schedules, then time 50 first pages of each list route and walk each one by cursor. |

These environment variables reach the bench's `panad` alone:

| Variable | Effect |
|---|---|
| `PANA_BENCH_NODE_ARGS` | Node flags, e.g. `--cpu-prof --cpu-prof-dir=DIR` |
| `PANA_BENCH_SQL=FILE` | Time every SQLite statement and write the totals to `FILE` |
| `PANA_BENCH_SETTINGS` | pi-durable settings as JSON, e.g. `{"contextRetentionMs":600000}` |
| `PANA_BENCH_STDERR=1` | Print `panad`'s stderr, and its memory after a full collection (with `--expose-gc`) |

## Machine

Apple M2, 8 cores, 8 GB, macOS 26.5, Node 26.12, SQLite 3.54. The faux model takes 20 ms a request. The bench and `panad` share the machine.

## Results

N=200, M=1000, K=5, then 10,000 threads. "Before" is the code this package started from (`6fdb299`). "After" is this branch, with WP11's archives and unread counts merged and migration 5's indexes. Both runs pass every SCALE-02 check. Runs vary by about 20% from one to the next; the speedups below held in every pair.

| Phase | Before | After | |
|---|---|---|---|
| sessions: 200 created at once | 1.1 s, 174/s | 0.8 s, 244/s | answers p50 1143 → 815 ms |
| threads: 10,000 messages | 28.7 s, 349/s | 14.1 s, 707/s | answer p50 / p99 279 / 433 → 142 / 191 ms |
| broadcast: 1,000 wakes | 3.1 s, 324/s | 1.8 s, 552/s | post p50 552 → 401 ms |
| fan-out: 150 sessions | 2.5 s, 61/s | 1.3 s, 114/s | |

Server time per route, from the request log, in ms:

| Route | Before p50 / p99 | After p50 / p99 |
|---|---|---|
| `threads.create` | 3.53 / 7.01 | 0.29 / 2.44 |
| `threads.respond` | 1.92 / 6.97 | 0.92 / 5.36 |
| `sessions.create` | 2.40 / 9.56 | 2.08 / 7.18 |
| `inbox.list` | 94.75 / 107.58 | 1.77 / 2.23 |
| `threads.search` | 1.55 / 2.11 | 0.13 / 0.41 |
| `sessions.search` | 0.47 / 3.17 | 0.30 / 2.04 |
| `schedules.list` | 0.63 / 1.63 | 0.24 / 1.63 |

Lists at 10,000 threads, as the client saw them (SCALE-03). Before, `/inbox` and `/schedules` returned everything, and `/threads` and `/sessions` returned one capped page with no way to the rest.

| List | Items | Before: first call p50 / p99, size | After: first page p50 / p99, size | After: every page p99 |
|---|---|---|---|---|
| `/inbox` | 13,859 | 118 / 151 ms, 9.5 MB | 1.9 / 2.7 ms, 35 KB | 2.9 ms over 278 pages |
| `/threads` | 10,000 | 1.6 / 2.4 ms, first 50 only | 0.18 / 0.50 ms | 0.85 ms over 200 pages |
| `/sessions` | 350 | 0.6 / 1.0 ms, first 50 only | 0.39 / 0.59 ms | 0.44 ms over 7 pages |
| `/schedules` | 200 | 0.9 / 2.8 ms, 81 KB | 0.34 / 0.51 ms | 2.1 ms over 4 pages |

| | Before | After |
|---|---|---|
| Requests | 14,422 | 14,903 |
| `panad` RSS peak / end | 563 / 342 MB | 346 / 346 MB |
| Live heap after a full collection | 70 MB | 37 MB |
| Database | 41.8 MB | 40.2 MB |

RSS mostly measures how much heap V8 keeps between collections, so it moves with throughput. The live heap is the number that grows with sessions.

### 1,000 sessions

`--sessions 1000 --threads 2000 --concurrency 100 --broadcast 0 --fanout 0`: more sessions, so more kept state. Measured before the WP11 merge.

| | Before | After |
|---|---|---|
| threads: 20,000 messages | 96.6 s, 207/s | 28.5 s, 702/s |
| answer p50 / p99 | 976 / 1589 ms | 283 / 388 ms |
| Live heap after a full collection | 86 MB | 39 MB |

### Live work in progress (WP13)

UX-12 publishes `session.live` while a window is subscribed, and the bench's own `/events` connection is one, so every bench run now builds and streams live views: up to one per session every 250 ms. N=200, M=1000, K=5, without the list phase. "Before" is `574bf4c`, "after" is the UX-12 branch; both pass every SCALE-02 check.

| Phase | Before | After, run 1 | After, run 2 |
|---|---|---|---|
| sessions: 200 created at once | 7.5 s, 26.7/s | 7.5 s, 26.8/s | 7.3 s, 27.5/s |
| threads: 10,000 messages | 19.5 s, 512/s; answer p50 / p99 188 / 340 ms | 20.7 s, 482/s; 201 / 339 ms | 19.9 s, 503/s; 193 / 323 ms |
| broadcast: 1,000 wakes | 2.7 s, 375/s; post p50 / p99 510 / 561 ms | 2.7 s, 365/s; 504 / 662 ms | 3.0 s, 334/s; 445 / 958 ms |
| fan-out: 150 sessions | 12.2 s | 11.5 s | 12.6 s |
| `threads.respond` p50 / p99 | 1.11 / 10.51 ms | 1.13 / 12.64 ms | 1.09 / 12.35 ms |

The differences are inside the run-to-run spread. A second "before" run was cut short when the disk filled.

Two things changed since the results above, both before WP13:

- At N=200 the bench failed: concurrent session creates each add a memory worktree, and an add that failed under contention could leave its branch behind, so the retry failed with "a branch named ... already exists". The retry now checks the branch again (`574bf4c`).
- `sessions.create` p50 went from 2.08 ms to about 4.3 s, and the sessions and fan-out phases from 0.8 s and 1.3 s to about 7.5 s and 12 s. A session now gets its memory worktree when it is created, and 200 concurrent `git worktree add` runs dominate. This is the next bottleneck to look at.

## Bottlenecks and fixes

Each was found with a CPU profile of the bench's `panad` or with `PANA_BENCH_SQL`, and confirmed by a run with and without the fix.

| # | Bottleneck | Evidence | Fix |
|---|---|---|---|
| 1 | Every message append and every first subject ran `DELETE FROM messages_fts WHERE message_id = ?` (or `subjects_fts ... thread_id`). Those are UNINDEXED FTS5 columns, so each delete scanned the whole index. | 27% of CPU by the end of the threads phase, growing with history. `threads.create` p50 3.5 ms at 10,000 threads. | A new message has no index row, and a thread with no subject has no subject row, so those writes only insert. Revisions, redactions, and regenerated subjects still delete by scan; they are rare user actions. No migration. `threads.create` p50 is now 0.27 ms. |
| 2 | The project prompt section ran `git rev-parse --show-toplevel` on every model request. | `spawn` was 13% of CPU. | Walk up from `cwd` to the nearest `.git` through the execution environment. The bash tool's clean environment sets no `GIT_DIR`, so it finds the root git would. |
| 3 | pi-durable kept each idle conversation's context for ten minutes, and checks every kept context again on each task change. | At 1,000 sessions, with fixes 1 and 2 in place: threads phase 67.0 s with the default, 43.9 s with 0; RSS at the end 637 MB against 397 MB. Live heap 86 → 39 MB. | `panad` defaults `contextRetentionMs` to 0, as the README promises: an idle session costs nothing but storage. A session's next run reads its transcript back from SQLite, which takes milliseconds against a model call of seconds. `documentRetentionMs` 0 was slower (55 s), so it keeps its default. |
| 4 | The delivery hook checked the thread for archived sessions once per recipient, and that query reads every participant: P² rows for a message to P sessions. | Broadcast `threads.respond` to 200 sessions p50 41.5 ms. | Check once per append; one append calls the hook for all its recipients inside one transaction. p50 35.9 ms. |
| 5 | List routes returned whole tables. | `/inbox` with 13,859 items: 9.5 MB and 118 ms a call, read inside the write line. | SCALE-03: `limit`, `cursor`, `nextCursor` on all four list routes, the CLI flags, and "Load more" in the PWA. WP11's archived and unread filters page with them. The inbox answers `unreadTotal`, so the PWA badge still counts past the first page. |
| 6 | WP11's unread count ran once per listed thread, and found the reader's deliveries through `(recipient_id, created_at)`, so each count read the whole inbox. The auto-reply's lookup by submission read every delivery of the session the same way. | After the WP11 merge, a `/threads` page took 60 ms with 14,000 deliveries; `/inbox` 4 ms. | Migration 5: `(recipient_id, wake_submission_id)`, and a partial index on `(recipient_id, thread_id)` where `read_at` is null. A `/threads` page takes 0.18 ms, `/inbox` 1.9 ms. |

## Measured and left alone

- **The write line (`db.atomically`).** In the threads phase all 16,000 pana transactions started with no other caller waiting, and so did the 2,005 of the broadcast. `node:sqlite` is synchronous, so the event loop already serializes the work; the queue only orders it. pi-durable made 15,604 transactions of its own, and 10,600 of its commits joined a pana transaction. Group commit would have to delay commits to batch them.
- **COMMIT.** It is the largest single SQLite cost: 31,604 commits for 10,400 messages, 145 µs mean (59 µs p50, 3.3 ms p99 when a WAL checkpoint lands), 47% of all SQLite time. Half of them are pi-durable's own.
- **The session settle queue** (`src/sessions/runtime.ts`). Over 19,841 jobs it never held more than 3, and the longest wait was 8.5 ms. Settling a run takes 0.26 ms.
- **Delivery fan-out.** An append to 200 sessions holds the write line for about 36 ms, 0.18 ms a recipient, most of it pi-durable's `submit()`. The broadcast's client latency is mostly the previous message's 200 runs on the CPU.
- **The request log.** `appendFileSync` costs 28 µs a line; a descriptor held open costs 2 µs. That is about 1% of a run, so it stays as it is.

## What is left

- pi-durable's scheduler checks every context it keeps on each task change (`#settleIdle`). With retention 0 it keeps only busy conversations, but with 1,000 sessions created at once that check was still 14% of CPU. That belongs upstream.
- After these fixes `panad` is CPU-bound, and SQLite is about 55% of its CPU. BEGIN and COMMIT alone are a quarter.
- The inbox's `unreadTotal` reads every unread delivery of the reader through the partial index: 1.9 ms with 13,859 unread. A counter column would make it constant, at the cost of state to keep right.
- Searches page by offset, so a deep page re-reads the hits before it.

## Objectives reads: the JSON-scan indexes (migration 13)

Every objectives read filtered a JSON key with nothing behind it: `json_extract(detail, '$.session')` and friends on `objective_events`, `json_extract(payload, '$.session')` on `schedules`. `objective_events` grows with every run start and end, and the wake reads ran once per member on every objective status read.

Two indexes and one drop, in migration 13:

- `objective_events_kind (objective_id, kind, at)` replaces `objective_events_objective (objective_id, at)`. Every production read filters `kind` as well, and none orders by `at` alone (the one `SELECT … ORDER BY at` left is in a test), so the old index paid a write on the fastest-growing table for nothing. At 200,000 events the new index is 10.8 MB, the dropped one was 8.4 MB.
- `schedules_wake_session (kind, json_extract(payload, '$.session'), next_at, id) WHERE kind = 'wake' AND state = 'active'`. `kind` leads because the reads pass an IN list of members and only a leading equality term lets SQLite seek once per member; `next_at, id` last so a single-session read takes its order from the index. Partial, so its cost tracks pending wakes rather than schedule history: 48 KB with 5,000 schedules and 600 active wakes.

Measured on a VACUUMed copy of the seeded database below: 51,044,352 → 53,424,128 bytes, +2.38 MB net.

### The seeded database

The default bench never drives the objectives routes, so this is the direct evidence. A throwaway database under scratch, 5,000 schedules (3,000 session, 1,250 thread, 750 wake — 600 of them active, 150 of those hold wakes) against 500 sessions and 50 objectives, and 200,000 `objective_events` across those 50 objectives: 40% `run.started`, 35% `run.ended`, 8% `member.created`, 2% `member.refused`, 2% `run.refused`, and 1% each of `budget`, `charter.set`, `escalated`, `stranded`, `limits.set`, `behind`, `regenerated`. `detail` carries `{session, run, lead}` on a start, `{session, run}` on an end, `{condition}` on a budget or refusal. Each query shape was prepared, warmed for 10 calls, then timed over 100–300 calls on identical copies of the file; updates ran inside a savepoint and were rolled back. Two independent copies each side.

| Query shape (call site) | Before, µs/call | After, µs/call |
|---|---|---|
| `state.ts` hasPendingWake (IN list, LIMIT 1) | 14.2 / 15.0 | 13.5 / 10.8 |
| `gates.ts` memberWakes (IN list) | 1452.6 / 1302.0 | 29.1 / 21.8 |
| `store.ts` sessionWakes | 1515.1 / 1370.1 | 13.5 / 14.0 |
| `lead.ts` cancelWakes (UPDATE) | 1552.7 / 1297.1 | 20.6 / 19.7 |
| `hold.ts` clearHold (UPDATE) | 1925.8 / 1256.2 | 20.8 / 19.9 |
| `hold.ts` upsertHoldWake select | 697.6 / 631.4 | 8.5 / 8.7 |
| `brief.ts` pendingWakes (IN list, ORDER BY next_at) | 1670.2 / 1383.8 | 1628.1 / 1404.2 |
| `live.ts` nextWakes (IN list, ORDER BY next_at) | 1525.9 / 1331.5 | 1625.3 / 1443.8 |
| `limits.ts` leadRunsToday | 912.0 / 801.0 | 659.2 / 628.7 |
| `limits.ts` lastLeadRunEnd | 8.7 / 8.1 | 9.2 / 9.1 |
| `brief.ts` leadRunsTotal | 1228.7 / 1169.1 | 884.3 / 791.0 |
| `hold.ts` budget prior | 18.8 / 18.8 | 9.9 / 9.1 |
| `hold.ts` run.refused prior | 11.8 / 11.6 | 10.9 / 10.1 |
| `hold.ts` member.created count | 884.7 / 825.0 | 328.4 / 277.6 |
| `hold.ts` currentLeadRun | 16.6 / 14.5 | 15.6 / 11.2 |
| `hold.ts` member.refused prior | 621.3 / 590.0 | 75.9 / 65.9 |
| `limits.ts` objectiveRunsToday (no JSON) | 354.5 / 316.8 | 71.2 / 67.9 |

An inserted `objective_events` row costs 5.8 / 5.0 µs before and 5.9 / 5.4 µs after — one index replaced another. An inserted active wake costs 14.3 / 12.7 µs before and 17.0 / 16.9 µs after.

Plans, from `EXPLAIN QUERY PLAN` over the same statements (the test in `test/objectives-indexes.test.ts` asserts these through the routes):

| Read | Before | After |
|---|---|---|
| hasPendingWake, memberWakes, cancelWakes, clearHold, upsertHoldWake | `schedules_state (state=?)` or `(state=? AND next_at>?)` | `schedules_wake_session (kind=? AND <expr>=?[ AND next_at>?])` |
| sessionWakes | `schedules_state (state=? AND next_at>?)`, temp B-tree for the last ORDER BY term | `schedules_wake_session (kind=? AND <expr>=? AND next_at>?)` |
| pendingWakes, nextWakes | `schedules_state (state=? AND next_at>?)`, temp B-tree | unchanged |
| every `objective_events` read | `objective_events_objective (objective_id=[ AND at>? AND at<?])` | `objective_events_kind (objective_id=? AND kind=?[ AND at>? AND at<?])` |
| objectiveRunsToday | `objective_events_objective` range, table lookup per row | covering `objective_events_kind` |

The two IN-list reads that also `ORDER BY next_at, id` keep the state index. An IN list over an expression index needs a sort either way, and without `sqlite_stat1` SQLite prefers the order it already has. Dropping the `ORDER BY` and sorting in JS moves both onto the index (143 µs and 80 µs, measured), and so does `ANALYZE` — 79 ms over this database. Neither is in this change.

`leadRunsToday` (912 → 659 µs) and `member.created` (885 → 328 µs) still scan the `(objective_id, kind)` range and evaluate `json_extract(detail, …)` per row: the index narrows to the kind, and nothing narrows further. An expression index on `detail` is the next shape to try; it is not in this change.

A malformed `payload` on an active wake row fails index creation at boot (`malformed JSON`), where the reads today only skip the row: the seed has zero such rows (checked with `NOT json_valid(payload)`), the partial predicate keeps session and non-active schedules out of the index, and every writer goes through `JSON.stringify`. A `session_id` column would remove the risk without query changes, at the cost of writing it from every schedule writer.

### The bench on this host

Raspberry Pi 5, 4 cores, 16 GB, Debian 13, Node 24.21.0, SQLite 3.53.4. `pana/scripts/bench --list-threads 10000 --json`, `PANA_BENCH_SQL` per run, two runs each, interleaved base → branch → base → branch. The bench drives no objectives route, so this only shows that the change costs nothing elsewhere. The 5-minute load average before each of the four runs was 0.09, 0.58, 0.69, 0.75.

| Phase | Base `0fb36aa`, run 1 | Base, run 2 | Branch, run 1 | Branch, run 2 |
|---|---|---|---|---|
| sessions: 200 created at once | 6.9 s, 28.8/s | 6.9 s, 29.1/s | 6.8 s, 29.4/s | 6.9 s, 28.9/s |
| threads: 10,000 messages | 43.9 s, 227.7/s; answer p50 / p99 427 / 609 ms | 44.5 s, 224.8/s; 428 / 659 ms | 43.5 s, 230.0/s; 420 / 618 ms | 44.1 s, 226.6/s; 425 / 609 ms |
| broadcast: 1,000 wakes | 7.5 s, 133.1/s; post p50 / p99 189 / 1369 ms | 7.5 s, 133.1/s; 172 / 727 ms | 7.6 s, 131.1/s; 162 / 714 ms | 7.5 s, 132.6/s; 169 / 693 ms |
| fan-out: 150 sessions | 8.3 s, 18.2/s | 8.1 s, 18.5/s | 8.1 s, 18.5/s | 7.9 s, 19.1/s |
| Requests | 14,965 | 14,967 | 14,967 | 14,965 |
| `panad` RSS peak | 488 MB | 455 MB | 478 MB | 462 MB |
| Database | 46,288,896 B | 46,276,608 B | 46,252,032 B | 46,268,416 B |

Lists at 10,000 threads, first page p50 / p99 in ms, and every-page p99:

| List | Base, run 1 | Base, run 2 | Branch, run 1 | Branch, run 2 |
|---|---|---|---|---|
| `/inbox` (13,859) | 5.28 / 8.89, pages 8.21 | 5.23 / 7.38, pages 8.24 | 5.21 / 7.13, pages 8.98 | 5.18 / 7.21, pages 9.52 |
| `/threads` (10,000) | 1.32 / 6.08, pages 2.94 | 1.29 / 6.11, pages 2.98 | 1.40 / 5.34, pages 2.87 | 1.36 / 4.76, pages 3.09 |
| `/sessions` (350) | 1.62 / 1.98, pages 1.73 | 1.65 / 3.64, pages 1.92 | 1.63 / 2.25, pages 1.87 | 1.61 / 2.06, pages 1.72 |
| `/schedules` (200) | 1.41 / 10.63, pages 3.12 | 1.41 / 5.67, pages 1.55 | 1.41 / 1.79, pages 1.59 | 1.42 / 3.52, pages 5.94 |

Every difference above is inside the run-to-run spread (threads 224.8–230.0 msg/s over the four runs). The branch was 1% faster in the threads phase and 1% slower in broadcast; neither is larger than the spread between two base runs.

Total SQLite time, summing every statement in `PANA_BENCH_SQL`'s output: 26,033 ms and 26,346 ms base, 25,801 ms and 26,271 ms branch — 1.4% and 0.3% apart, inside the same spread. The ten most expensive statements are the same ten, in the same order, on both sides: `COMMIT` 5,048–5,154 ms over 48,190 commits, pi-durable's `INSERT INTO pi_tasks` 1,446–1,469 ms over 26,940 calls, `SELECT record FROM pi_conversations` 1,045–1,075 ms over 103,858 calls, the inbox's unread count 1,040–1,042 ms over 328 calls, `INSERT OR IGNORE INTO pi_record_ids` 879–916 ms, `SELECT record FROM pi_entries` 890–908 ms and 679–697 ms over 5,623 calls, `DELETE FROM pi_document_revisions` 750–768 ms, `INSERT INTO deliveries` 545–554 ms, `INSERT OR REPLACE INTO sessions_fts` 533–543 ms.

This bench creates no objectives, so the two new indexes have almost no rows to hold there: the database is 46.25–46.29 MB on both sides, and the migration moves no measured statement. The seeded database above is what shows the indexes paying.

