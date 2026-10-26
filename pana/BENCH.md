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

N=200, M=1000, K=5, then 10,000 threads. "Before" is the code this package started from (`6fdb299`). "After" is this branch. Both runs pass every SCALE-02 check. Runs vary by about 20% from one to the next; the speedups below held in every pair.

| Phase | Before | After | |
|---|---|---|---|
| sessions: 200 created at once | 1.1 s, 174/s | 0.9 s, 232/s | answers p50 1143 → 857 ms |
| threads: 10,000 messages | 28.7 s, 349/s | 14.0 s, 714/s | answer p50 / p99 279 / 433 → 139 / 197 ms |
| broadcast: 1,000 wakes | 3.1 s, 324/s | 1.9 s, 523/s | post p50 552 → 308 ms |
| fan-out: 150 sessions | 2.5 s, 61/s | 1.4 s, 109/s | |

Server time per route, from the request log, in ms:

| Route | Before p50 / p99 | After p50 / p99 |
|---|---|---|
| `threads.create` | 3.53 / 7.01 | 0.27 / 2.37 |
| `threads.respond` | 1.92 / 6.97 | 0.88 / 4.87 |
| `sessions.create` | 2.40 / 9.56 | 2.03 / 6.55 |
| `inbox.list` | 94.75 / 107.58 | 0.38 / 0.98 |
| `threads.search` | 1.55 / 2.11 | 0.07 / 0.25 |
| `sessions.search` | 0.47 / 3.17 | 0.29 / 2.51 |
| `schedules.list` | 0.63 / 1.63 | 0.24 / 1.41 |

Lists at 10,000 threads, as the client saw them (SCALE-03). Before, `/inbox` and `/schedules` returned everything, and `/threads` and `/sessions` returned one capped page with no way to the rest.

| List | Items | Before: first call p50 / p99, size | After: first page p50 / p99, size | After: every page p99 |
|---|---|---|---|---|
| `/inbox` | 13,859 | 118 / 151 ms, 9.5 MB | 0.5 / 2.4 ms, 34 KB | 1.9 ms over 278 pages |
| `/threads` | 10,000 | 1.6 / 2.4 ms, first 50 only | 0.12 / 0.34 ms | 0.42 ms over 200 pages |
| `/sessions` | 350 | 0.6 / 1.0 ms, first 50 only | 0.39 / 1.0 ms | 0.39 ms over 7 pages |
| `/schedules` | 200 | 0.9 / 2.8 ms, 81 KB | 0.35 / 0.53 ms | 0.39 ms over 4 pages |

| | Before | After |
|---|---|---|
| Requests | 14,422 | 14,907 |
| `panad` RSS peak / end | 563 / 342 MB | 418 / 418 MB |
| Live heap after a full collection | 70 MB | 45 MB |
| Database | 41.8 MB | 41.8 MB |

RSS mostly measures how much heap V8 keeps between collections, so it moves with throughput. The live heap is the number that grows with sessions.

### 1,000 sessions

`--sessions 1000 --threads 2000 --concurrency 100 --broadcast 0 --fanout 0`: more sessions, so more kept state.

| | Before | After |
|---|---|---|
| threads: 20,000 messages | 96.6 s, 207/s | 28.5 s, 702/s |
| answer p50 / p99 | 976 / 1589 ms | 283 / 388 ms |
| Live heap after a full collection | 86 MB | 39 MB |

## Bottlenecks and fixes

Each was found with a CPU profile of the bench's `panad` or with `PANA_BENCH_SQL`, and confirmed by a run with and without the fix.

| # | Bottleneck | Evidence | Fix |
|---|---|---|---|
| 1 | Every message append and every first subject ran `DELETE FROM messages_fts WHERE message_id = ?` (or `subjects_fts ... thread_id`). Those are UNINDEXED FTS5 columns, so each delete scanned the whole index. | 27% of CPU by the end of the threads phase, growing with history. `threads.create` p50 3.5 ms at 10,000 threads. | A new message has no index row, and a thread with no subject has no subject row, so those writes only insert. Revisions, redactions, and regenerated subjects still delete by scan; they are rare user actions. No migration. `threads.create` p50 is now 0.27 ms. |
| 2 | The project prompt section ran `git rev-parse --show-toplevel` on every model request. | `spawn` was 13% of CPU. | Walk up from `cwd` to the nearest `.git` through the execution environment. The bash tool's clean environment sets no `GIT_DIR`, so it finds the root git would. |
| 3 | pi-durable kept each idle conversation's context for ten minutes, and checks every kept context again on each task change. | At 1,000 sessions, with fixes 1 and 2 in place: threads phase 67.0 s with the default, 43.9 s with 0; RSS at the end 637 MB against 397 MB. Live heap 86 → 39 MB. | `panad` defaults `contextRetentionMs` to 0, as the README promises: an idle session costs nothing but storage. A session's next run reads its transcript back from SQLite, which takes milliseconds against a model call of seconds. `documentRetentionMs` 0 was slower (55 s), so it keeps its default. |
| 4 | The delivery hook checked the thread for archived sessions once per recipient, and that query reads every participant: P² rows for a message to P sessions. | Broadcast `threads.respond` to 200 sessions p50 41.5 ms. | Check once per append; one append calls the hook for all its recipients inside one transaction. p50 35.9 ms. |
| 5 | List routes returned whole tables. | `/inbox` with 13,859 items: 9.5 MB and 118 ms a call, read inside the write line. | SCALE-03: `limit`, `cursor`, `nextCursor` on all four list routes, the CLI flags, and "Load more" in the PWA. |

## Measured and left alone

- **The write line (`db.atomically`).** In the threads phase all 16,000 pana transactions started with no other caller waiting, and so did the 2,005 of the broadcast. `node:sqlite` is synchronous, so the event loop already serializes the work; the queue only orders it. pi-durable made 15,604 transactions of its own, and 10,600 of its commits joined a pana transaction. Group commit would have to delay commits to batch them.
- **COMMIT.** It is the largest single SQLite cost: 31,604 commits for 10,400 messages, 145 µs mean (59 µs p50, 3.3 ms p99 when a WAL checkpoint lands), 47% of all SQLite time. Half of them are pi-durable's own.
- **The session settle queue** (`src/sessions/runtime.ts`). Over 19,841 jobs it never held more than 3, and the longest wait was 8.5 ms. Settling a run takes 0.26 ms.
- **Delivery fan-out.** An append to 200 sessions holds the write line for about 36 ms, 0.18 ms a recipient, most of it pi-durable's `submit()`. The broadcast's client latency is mostly the previous message's 200 runs on the CPU.
- **The request log.** `appendFileSync` costs 28 µs a line; a descriptor held open costs 2 µs. That is about 1% of a run, so it stays as it is.

## What is left

- pi-durable's scheduler checks every context it keeps on each task change (`#settleIdle`). With retention 0 it keeps only busy conversations, but with 1,000 sessions created at once that check was still 14% of CPU. That belongs upstream.
- After these fixes `panad` is CPU-bound, and SQLite is about 55% of its CPU. BEGIN and COMMIT alone are a quarter.
- The auto-reply and failure-notice lookups find a delivery by `(recipient_id, wake_submission_id)` through the `(recipient_id, created_at)` index, so they read every delivery of the session. That is 30–70 µs today. An index needs a migration; it waits so it does not collide with WP11's.
- Searches page by offset, so a deep page re-reads the hits before it.
