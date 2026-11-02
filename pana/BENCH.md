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

The two IN-list reads that also `ORDER BY next_at, id` kept the state index in migration 13. An IN list over an expression index needs a sort either way, and without `sqlite_stat1` SQLite prefers the order it already has. Dropping the `ORDER BY` and sorting in JS moves both onto the index, which is the follow-up measured in the next subsection.

`leadRunsToday` (912 → 659 µs) and `member.created` (885 → 328 µs) still scan the `(objective_id, kind)` range and evaluate `json_extract(detail, …)` per row: the index narrows to the kind, and nothing narrows further. An expression index on `detail` is the next shape to try; it is not in this change.

A malformed `payload` on an active wake row fails index creation at boot (`malformed JSON`), where the reads today only skip the row: the seed has zero such rows (checked with `NOT json_valid(payload)`), the partial predicate keeps session and non-active schedules out of the index, and every writer goes through `JSON.stringify`. A `session_id` column would remove the risk without query changes, at the cost of writing it from every schedule writer.

### The two ordered wake reads

`brief.pendingWakes` and `live.nextWakes` used to `ORDER BY next_at, id` in SQL. Over an IN list that is a temp B-tree, and with no statistics SQLite then chose `schedules_state` over the wake index. Same seeded database as the table above (600 active wakes over 600 sessions, one wake each), two copies each side, 200 calls:

| Read | Members | `ORDER BY` in SQL, µs | Sorted in JS, µs |
|---|---|---|---|
| `brief.ts` pendingWakes | 5 | 1250 / 1252 | 29 / 28 |
| `live.ts` nextWakes | 5 | 1294 / 1243 | 36 / 36 |
| `brief.ts` pendingWakes | 50 | 1418 / 1438 | 191 / 187 |
| `live.ts` nextWakes | 50 | 1470 / 1601 | 235 / 240 |

At five members the index finds five rows and the read is 40× faster; at fifty members it does fifty seeks and reads fifty rows, so the win is 7×. The plans say the same thing: the ordered statement is `SEARCH schedules USING INDEX schedules_state (state=? AND next_at>?)` plus `USE TEMP B-TREE FOR LAST TERM OF ORDER BY`, and the sorted one is `SEARCH schedules USING INDEX schedules_wake_session (kind=? AND <expr>=? AND next_at>?)` with nothing else.

The sort moved from SQLite into V8: `bench-sql-ms` will not move measurably, and that is the expected shape, not a missing win — what the change buys is the index seek and the scan that stopped. `ANALYZE` was the alternative and is not in this change: it makes the ordered statement pick the index too (79 ms over this seeded database, measured with migration 13), but it stores statistics that go stale as `schedules` and `objective_events` grow, and it changes the planner's input everywhere, not only for these two reads. The order and its tie-break are unchanged: `(next_at, id)`, with ids compared in the ASCII byte order that `ORDER BY id` used. `test/objectives-indexes.test.ts` pins that with two wakes on one instant whose ids disagree with insertion order.

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


### The inbox's unread total (migration 14)

`unreadTotal` was a `COUNT(*)` over every unread delivery of the reader, run on every inbox call: **1,040–1,042 ms over 328 calls in the bench, 3.2 ms a call at 13,859 unread, 4% of all SQLite time** — everything larger was `COMMIT` or pi-durable. Migration 14 adds `unread_counts`, one row per participant with two buckets for the two ways the inbox reads it (`archived: false` and `archived: true`), and `src/threads/unread.ts` is the only code that writes it. The inbox now reads one row.

The counter is a cache of the same COUNT, so its cost is the write paths that keep it exact. Single deliveries, single reads, and wake marks move it by the number of rows the statement changed (`changes()`); a new delivery lands in the bucket its thread is in, and REF-04's unarchive moves the thread's unread rows with it. The rare writes that touch an open-ended set of rows — a stop returning queued mail to unread — recompute that participant from the deliveries instead of counting the delta, because a stop is rare and the truth is cheap there.

Migration 14 backfills from the same COUNT, so a migrated database and a recompute agree; it deletes first, so re-running it is a no-op rebuild (DB-03). The state is 24 bytes a participant plus a page: on a database with 49 participants it is one page, and on the bench's 350 sessions it is **4–12 KB** (two b-trees for 351 rows: 24 bytes a row plus its primary-key entry).

`test/unread-counter.test.ts` is the argument that the cache stays true: a seeded random sequence of deliveries, thread reads, message reads, per-participant archives and unarchives, notices, a session retired with `settleUnread`, and recounts, comparing the counter with the original SQL after every step, in both buckets, for every participant, and again after closing and reopening the database. It fails if a write path forgets the counter (checked by removing one).

The bench on this host, quiet (5-minute load 0.98 → 1.16 → 1.29 → 1.34 before the four runs, no other suite): base `8bbd390` → branch → base → branch, `--list-threads 10000 --json`, `PANA_BENCH_SQL` per run.

| Phase | Base, run 1 | Base, run 2 | Branch, run 1 | Branch, run 2 |
|---|---|---|---|---|
| sessions: 200 created at once | 6.8 s, 29.4/s | 7.0 s, 28.5/s | 7.0 s, 28.7/s | 7.2 s, 27.6/s |
| threads: 10,000 messages | 44.5 s, 224.6/s | 45.2 s, 221.3/s | 45.1 s, 221.7/s | 45.9 s, 217.8/s |
| broadcast: 1,000 wakes | 7.5 s, 133.7/s | 7.6 s, 132.3/s | 7.4 s, 134.8/s | 7.6 s, 131.3/s |
| fan-out: 150 sessions | 8.1 s, 18.6/s | 8.6 s, 17.5/s | 8.3 s, 18.2/s | 8.3 s, 18.0/s |
| `/inbox` route p50 / p99 | 4.89 / 6.56 ms | 4.92 / 5.82 ms | 1.71 / 2.35 ms | 1.71 / 3.16 ms |
| `/inbox` first page p50 / p99 | 5.25 / 9.14 ms | 5.34 / 7.34 ms | 2.09 / 3.93 ms | 2.11 / 4.04 ms |
| Total SQLite ms | 26,432 | 26,777 | 26,123 | 26,599 |
| Database | 46,288,896 B | 46,301,184 B | 46,301,184 B | 46,292,992 B |

The statement itself: `SELECT COUNT(*) … read_at IS NULL … thread_archives` was **1,039 / 1,053 ms over 328 calls, 3.17 / 3.21 ms a call**, and is gone from the run. In its place the inbox reads one row: **4 ms over 328 calls, 13 µs a call** — a 240× drop on that read, and 4% of all SQLite time removed. It is no longer in the top ten; the largest pana-owned statement now is the sessions FTS insert at 533–543 ms.

What the counter costs: one `unread_counts` upsert per delivery and per wake mark-read, 26,839 calls at 13 µs — **349 ms**, about 1.3% of SQLite time. The delivery insert itself is flat at **27 / 28 µs before, 28 / 28 µs after**. Net, the run's SQLite total is 178–309 ms lower, which is inside the spread between two base runs (345 ms); the place the change shows is the route, where the inbox's p50 falls from 4.9 ms to 1.7 ms.



## Disk: what a pana database holds, and what churn leaves behind

The live file was 83.3 → 93.5 MiB in about two hours on a `panad` that never restarted (`du -b` on the file and its WAL: 98,242,560 B main, 4,165,352 B `-wal` at the end). This section measures where bytes go in a pana database and what churn leaves behind, on throwaway databases built through the real routes (a script, not the bench: no bench was run). It says what the growth is not as much as what it is.

### Where the bytes are

A database after 2,000 messages across 4 threads, 6 sessions, with reads, archives and replies: 3,944,448 B, `freelist_count` 0.

| Object | Bytes | Share |
|---|---|---|
| `deliveries` | 996 K | 25% |
| its indexes: `deliveries_recipient` 296 K, `deliveries_recipient_submission` 264 K, `deliveries_recipient_unread` 56 K, primary key 464 K | 1,080 K | 27% |
| `messages` + its two indexes | 544 K | 14% |
| `messages_fts_{content,data,docsize,idx}` | 476 K | 12% |
| `subjects_fts_*`, `subjects_thread` | 12 K | — |
| everything else (`threads`, `participants`, `sessions`, `unread_counts`, …) | under 40 K | — |

**Deliveries and their indexes are 53% of the file — more than twice the message text and its full-text index together.** The FTS tables are not the disk story. One row per recipient per message, with four indexes behind it, is.

Transcript tables (`pi_*`) are not in this build: a session with a conversation adds them, and the bench's 10,400-message run ends at 46 MB with those included. This table measures the tables pana defines.

### What churn leaves behind

Redacting 1,389 of those 2,000 messages, which shrinks each body and drops its search row: 3,985,408 B with `freelist_count` 21 (**86,016 B free, 2%**). Rebuilding the same content with `VACUUM`: **3,584,000 B, 401,408 B recovered (10%)** in 49 ms — of which only 86 KB was the freelist; the rest is pages left underfull by the rewrites. An append-only sequence leaves **nothing** free: rows are added, pages fill, no page is handed back.

So the live growth is not a churn artifact of free pages: at this shape, two hours of rewriting would leave ~2% free and ~10% recoverable in total, and the file grows because it is holding more rows — mostly deliveries. A file that never shrinks is holding them at their peak, not leaking space.

### What reclaims it

| | Recovered | File after | Cost |
|---|---|---|---|
| nothing | 0 | 3,985,408 B | — |
| `PRAGMA incremental_vacuum` on a file created with `auto_vacuum=incremental` | 86,016 B (the freelist exactly) | 3,903,488 B | 21 ms |
| `VACUUM` | 401,408 B (freelist + underfull pages) | 3,584,000 B | 49 ms on 4 MB; needs room for a second copy of the file while it runs |
| `auto_vacuum=full` | — | — | no measurable write cost at this scale: the same 600-message build took 632 / 612 ms without it and 625 / 628 ms with it |

`auto_vacuum` can only be switched on an existing database by a full `VACUUM` at boot (or before the first table exists), which is a change to how panad starts and is not in this section's scope. `incremental_vacuum` reclaims the freelist and nothing more; it is cheap enough (21 ms for 4 MB) to run when idle, which is the shape to consider if free pages ever matter.

### WAL at rest

`panad` runs `journal_mode=WAL`, `synchronous=NORMAL`, `wal_autocheckpoint=1000` pages (4 MB), and `journal_size_limit=-1`; it never checkpoints on a timer, and a clean shutdown truncates the WAL to zero (chord's `close()` does). The 4 MB `-wal` on the live file is one autocheckpoint interval. Measured with 16,000 single-row transactions on a copy:

| Setting | `-wal` at rest | 16,000 transactions |
|---|---|---|
| default (`journal_size_limit=-1`, 1,000 pages) | 4,157,112 B | 1,941 ms |
| `journal_size_limit=4 MB` | 4,157,112 B (no change) | 1,952 ms |
| `journal_size_limit=1 MB` | 2,533,832 B | 2,019 / 2,084 ms |
| `wal_autocheckpoint=250` pages | 1,054,752 B | 978 ms for 4,000 transactions against 478 ms at 1,000 pages — the same bytes written, checkpoints four times as often |

A passive checkpoint does not shrink the WAL; only a checkpoint that reaches the limit does, which is why 1 MB parks it at 2.5 MB rather than 1 MB. The limit buys **1.5 MiB at rest** for what looks like a 4–7% write cost on this worst case (tiny transactions), and lowering `wal_autocheckpoint` buys 3 MB for roughly double the write time. Neither is a default worth taking without the user: they trade disk for write latency on a database whose other half of the goal is speed.

## Deliveries: the index budget

`deliveries` was 53% of the P4 database, and the largest single object in it was the primary key: `sqlite_autoindex_deliveries_1`, 464 K for a 26-byte ULID per row in a 3.9 MB file. Two questions decide what can be dropped: does every index serve a statement, and would `WITHOUT ROWID` move the whole budget down rather than around?

### Every index is selected

Every SQL in `src/` that touches `deliveries` was planned against a database of 20,000 deliveries (4,000 messages to five recipients, one in ten read, one in five with a pending wake): 20 statements, `EXPLAIN QUERY PLAN` each.

| Index | Selected by |
|---|---|
| `sqlite_autoindex_deliveries_1` (PK `id`) | `wakeDelivery`, the outbox settle, the hold release |
| `sqlite_autoindex_deliveries_2` (`message_id, recipient_id`) | the inbox's delivery times, `markMessageRead` |
| `deliveries_recipient` (`recipient_id, created_at`) | the inbox page, and nothing else |
| `deliveries_recipient_submission` (`recipient_id, wake_submission_id`) | `triggeringDelivery`, the reply's starter and newer deliveries, the stop requeue, `heldDeliveries`, the daily user-message count |
| `deliveries_recipient_unread` (`recipient_id, thread_id` where unread) | the archive settle, `markThreadRead`, the per-thread unread counts, the counter's recount |
| `deliveries_pending_wake` (`wake_request_id` where pending) | the outbox's startup sweep |

**No index is selected by nothing.** The one with a single caller, `deliveries_recipient`, serves the inbox page — 917 K for the read the inbox cannot do without. There is no bench-free drop in this table.

### `WITHOUT ROWID` costs more, not less

The same 20,000 rows and the same index definitions, rebuilt with `PRIMARY KEY (id) ... WITHOUT ROWID`, compared after a `VACUUM` on both sides:

| Object | Rowid table | `WITHOUT ROWID` | Difference |
|---|---|---|---|
| `deliveries` (the table) | 2,883,584 B | 2,830,336 B | −53,248 B |
| `sqlite_autoindex_deliveries_1` (PK) | 774,144 B | — | −774,144 B |
| `sqlite_autoindex_deliveries_2` | 1,372,160 B | 1,961,984 B | +589,824 B |
| `deliveries_recipient_unread` | 1,347,584 B | 1,921,024 B | +573,440 B |
| `deliveries_recipient` | 917,504 B | 1,470,464 B | +552,960 B |
| `deliveries_recipient_submission` | 798,720 B | 1,355,776 B | +557,056 B |
| `deliveries_pending_wake` | 61,440 B | 147,456 B | +86,016 B |
| **Total for the table and its indexes** | **8,155,136 B** | **9,687,040 B** | **+1,531,904 B (+16%)** |

The table itself saves 53 KB and the key index saves 774 KB, but every secondary index now carries the 26-byte id where it carried an 8-byte rowid, and each of the four grows by 550–590 KB. `WITHOUT ROWID` is 16% more disk for this table, and it is a table rebuild in a migration besides. It is not proposed.

### What that leaves

Nothing here saves 5% of a file without losing a plan: the four indexes and the key cost what their statements need, and the cheapest structural change (dropping the rowid duplicate) costs 16% more elsewhere. The lever on this table is the number of rows, not the shape of them: one row per recipient per message is the 53%, and retention — what to do with deliveries whose mail is read and whose thread is archived — is a product decision, not an index.

Source: `EXPLAIN QUERY PLAN` over the 20 delivery statements on a seeded database, and `dbstat` over the same rows rebuilt `WITHOUT ROWID`, 2026-11-02.

## Objectives reads in the bench (`--objectives`)

The objectives routes were measured by an ad-hoc harness until now; the default bench never drove them. This adds an opt-in phase so they are measured by the same driver, against the same request log, whenever someone is working on them:

```sh
pana/scripts/bench --objectives 3 --objective-events 2000 --json
```

`--objectives K` seeds K active objectives, each with `--objective-events N` rows in `objective_events` (default 2,000) and three sessions on the roster, **by direct SQL** — seeding is not timed and not routed, because the point is the read plan at realistic size, not the writers. It then issues `--objective-samples S` (default 50) requests to `GET /objectives`, `GET /objectives/:id` and `GET /objectives/:id/brief`, and their p50/p99 land in the usual `routes` table. Off by default: a default run does exactly the work it did before, so its `bench-throughput` and `bench-sql-ms` readings stay comparable.

### The default run is unchanged

Branch head, `--list-threads 10000`, two runs, against the pair from the previous day:

| | Previous day, run 1 / 2 | Branch, run 1 / 2 |
|---|---|---|
| threads: 10,000 messages | 227.7 / 224.8 msg/s | 222.2 / 222.6 msg/s |
| sessions: 200 created at once | 29.4 / 28.5 per s | 28.7 / 28.2 per s |
| broadcast: 1,000 wakes | 133.7 / 132.3 per s | 130.0 / 128.7 per s |
| fan-out: 150 sessions | 18.6 / 17.5 per s | 17.9 / 17.8 per s |
| Total SQLite ms | 26,033 / 26,346 | 25,960 / 25,950 |

Every phase is 1–3% lower and SQLite time is 0.3% lower; the phase is off, so that is the host, not the change — the 5-minute load was 0.90–1.29 for these runs against 0.09–0.75 for the previous day's.

### The objectives routes

`--objectives 3 --objective-events 2000`, two runs:

| Route | Run 1 p50 / p99 | Run 2 p50 / p99 |
|---|---|---|
| `objectives.list` | 21.53 / 26.02 ms | 21.57 / 24.90 ms |
| `objectives.show` | 7.80 / 9.05 ms | 7.81 / 9.13 ms |
| `objectives.brief` | 8.33 / 11.35 ms | 8.36 / 13.07 ms |

With six thousand `objective_events` behind three objectives, the event reads are cheap — that is migration 13's index doing its work. **One statement is the objective read's cost**: `objectiveUserMessagesToday` (OBJ-24),

```sql
SELECT COUNT(DISTINCT m.id) AS n FROM messages m
  JOIN sessions s ON s.id = m.sender_id
  JOIN deliveries d ON d.message_id = m.id
  JOIN participants p ON p.id = d.recipient_id AND p.kind = 'user'
 WHERE s.objective_id = ? AND m.created_at >= ? AND m.created_at < ?
```

is **1,526 / 1,539 ms over 250 calls — 6.10 / 6.16 ms a call**, and it is most of the 2.4 s the three routes spent over 50 samples each. `objectives.list` issues it once per listed objective, which is why listing three costs 21.5 ms while showing one costs 7.8 ms. That count is the next package's target, not this one's: it walks the objective's sessions' deliveries and joins `messages` per row, so it grows with the objective's message history, and a covering index or a counter in the shape of migration 14 is the choice to make against it.

### OBJ-24's user-message count

`objectiveUserMessagesToday` was the cost the objectives phase found: **6.1 ms a call, 1,526–1,539 ms over 250 calls**, and once per listed objective, which is why `GET /objectives` cost 21.5 ms while `GET /objectives/:id` cost 7.8 ms. The query counted messages to the user from the objective's sessions in the local day, and nothing indexed `messages(sender_id, created_at)`, so it read `messages` once per session.

Two ways out were measured on a 6,000-message build (200 threads, 60 sessions, three objectives of three members, deliveries to one user, ten days of history):

| | µs a call | Bytes added |
|---|---|---|
| the query as it was | 4,698 | — |
| read from the user's deliveries instead | 603 | 0 |
| the query behind `messages(sender_id, created_at)` | 82 | 220,280 (37 a row) |

The reshape is the free one, and it loses on the measurement that matters: in the bench's shape — where every message is from today, so "the user's deliveries in the window" is the whole table — the reshaped query costs **6.26 ms against the original's 6.10**, no better at all; it only wins when the day window is a small slice of history. The index wins in both shapes, so migration 15 adds it:

```sql
CREATE INDEX messages_sender_created ON messages(sender_id, created_at);
```

`SEARCH s USING INDEX sessions_objective (objective_id=?) | SEARCH m USING INDEX messages_sender_created (sender_id=? AND created_at>? AND created_at<?) | SEARCH d USING COVERING INDEX sqlite_autoindex_deliveries_2 (message_id=?)` — three sessions, a range each, no scan. Cost: 37 bytes a message (220 KB at 6,000; about 360 KB in the bench's own database), and **1.1 µs on a message insert** (4.8 → 5.9 µs for 2,000 inserts into a copy). No other statement needs the index: every other read of `messages` joins it by primary key or reads it by thread.

With `--objectives 3 --objective-events 2000`, three runs before and two after:

| Route | Before, p50 | After, p50 | |
|---|---|---|---|
| `objectives.list` | 21.53 / 21.57 / 21.68 ms | 3.28 / 3.21 ms | 6.5× |
| `objectives.show` | 7.80 / 7.81 / 7.87 ms | 1.55 / 1.51 ms | 5.0× |
| `objectives.brief` | 8.33 / 8.36 / 8.42 ms | 1.97 / 1.91 ms | 4.2× |

The 6.1 ms statement is no longer in the run's top ten; the largest pana-owned statement there is now pi-durable's `pi_tasks` insert.

`test/objectives-indexes.test.ts` asserts the plan through the routes: the OBJ-24 count must select `messages_sender_created` and must not scan `messages`. `test/objectives.test.ts` pins the set the count means — a member's report counts, the user's own reply and a domain notice do not, another objective's message does not, and yesterday's does not. `test/scale.test.ts` now runs the objectives phase at small N (one objective, twenty events, three samples), so the phase has CI coverage.
