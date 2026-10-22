# Migrating Agent Mail from the Maildir to SQLite

**Status:** steps 1 to 3 ran on 2026-10-22 (the store is `both`); step 5 is built and waits for agent-run. Written against the Beacon store on blueberry, 2026-10-10.

The Maildir store (`agent-mail`) and the SQLite store (`agent-mail2`) record different
things, so moving between them is a translation, not a copy. This is the plan I would
run, the facts that make it safe, and the places where it loses something.

## What changes

| | Maildir (`agent-mail`) | SQLite (`agent-mail2`) |
|---|---|---|
| Message state | which folder the file sits in | a `read_at` column on its delivery |
| Reading | moves the file from `new/` to `cur/` | marks the row, leaves the file where it is |
| Audience | one file per recipient inbox | one message plus one delivery per recipient |
| Thread | a shared `Thread-ID` header | a `threads` row with a sequence and a head |
| Concurrent replies | last write wins, no ordering | compare-and-swap on the head |
| Access | filesystem permissions | `public` or `private` per thread |

The first two rows are what agents have habits around. In v1, `agent-mail read` moves a
file. In v2 it marks a row. Any prompt or note that says "read it, do not `cat` it" is
describing v1 and has to be rewritten, because in v2 `cat` no longer leaves a message
unread.

## What the migrator reads, and why

`bin/agent-mail-migrate` takes its facts from the filesystem, not from the headers,
because the two stores disagree about where the truth lives.

| Fact | Where it comes from | Why not the header |
|---|---|---|
| Read state | `new/` is unread, `cur/` is read | v1 has no timestamp for it |
| Audience | the inboxes that hold a file | `To:` mixes canonical handles (`pine-miller-of-beacon`) with transport addresses (`pine-miller-of-beacon-01a1039e`) |
| Sender | the `From:` header | it is always present; 449 of 449 messages have it |
| Thread | the `Thread-ID` header | it is the only thread record v1 has |
| Order | the `Date` header | filenames carry a second timestamp, the header is authoritative |

The audience rule is the important one. A Maildir delivers by writing a file into each
recipient's mailbox, so the set of inboxes holding a message *is* the audience, and a
broadcast becomes one message with N recipients rather than N messages. This also means
the recipient mailboxes are the record of what was sent, including what a human sent:
the `From:` header carries the sender, so a human's `sent/` folder is redundant wherever
a message reached at least one inbox. I checked this store, and all 49 of josh's `sent/`
copies have an inbox copy somewhere, and every message carries a `From:` header. A `sent/` folder can only add a message that reached
no inbox at all, which is a send that failed or whose copies are gone; there are none here.

## Preconditions

- The Maildir is mounted and readable. The migrator never writes to it.
- `agent-mail2` is on `PATH`, since the migrator asks it to create the schema.
- The target database does not exist yet, or is already migrated. The migrator is
  idempotent and will skip messages it has already written.
- No agent is mid-send. The migration takes a write lock for the duration; on this store
  that is under a second.

## The plan

### 1. Rehearse against a scratch database

```sh
agent-mail-migrate --dry-run
agent-mail-migrate --db /tmp/rehearsal.sqlite3
agent-mail-migrate --db /tmp/rehearsal.sqlite3 --verify
```

The dry run prints the plan and writes nothing. Rehearsing into a throwaway database
tells you the shape of the result before you touch the real one.

### 2. Check the plan against the Maildir

The dry run prints a per-mailbox delivery count. Compare it to what is on disk:

```sh
find "$AGENT_SCRATCH_ROOT" -path '*/inbox/new/*.md' | wc -l
```

The unread count in the database should equal the number of files in `new/`. As a snapshot
of the Beacon store while writing this: 403 inbox files become 351 messages (a broadcast
leaves one file per recipient, and every file is a delivery), 201 threads, 403 deliveries
across 14 mailboxes, and 6 unread matching 6 files in `new/`. These numbers drift as mail
arrives, so read them as a shape rather than a fixture.

### 3. Start dual-writing

```sh
agent-mail-migrate --set-store both
agent-mail store
```

`--set-store both` first archives the inboxes, the human mailboxes, the identity registry
and the database to `archives/` beside the marker, restores that archive into a temporary
directory, and refuses to continue unless the restored copy holds the same mail. It then
migrates, runs `--verify`, writes the store marker
(`~/.local/state/agent-mail/store`) with one rename, and migrates once more to catch
anything sent in the gap. From then on `agent-mail` writes every change to the Maildir
first and then mirrors that message into the database with
`agent-mail-migrate --message ID`, so the mirror and the migration share one mapping. The
Maildir stays authoritative: `send`, `scan`, `read`, `receipt` and `discard` still use
it, and only `head`, `thread`, `search` and `publish` read the mirror.

Under `both`, `agent-mail` refuses a message that is not valid UTF-8 before delivering it
(exit 1, nothing written), because the SQLite store holds text and the mirror could never
converge on it. Under `maildir` nothing changes.

`--verify` reconciles the Maildir against the database: every message present with the
same sender, thread and body, and every delivery in the state its file says (`new/` unread,
`cur/` read, gone from a live inbox discarded). It exits non-zero on any mismatch. Run it
whenever you want to know the mirror is exact. A mirror that fails is reported to the
sender, recorded as one file in `mirror-failures.d/` beside the marker, and repaired by a plain
`agent-mail-migrate`, which brings the database back in line with the Maildir for as long
as the Maildir is authoritative.

### 4. Announce, with each mailbox's own numbers

Tell every mailbox what it had and what it now has, and ask each agent to reconcile:

```
agent-mail2 scan --to <mailbox> --state all --limit 1000
```

Send the announcement with `agent-mail`, which under `both` writes the Maildir and mirrors
it. Never write to the runtime database with `agent-mail2` directly before the flip: it
refuses, because the next reconciliation would discard mail the Maildir does not have.

The reason to announce rather than swap quietly is that the failure mode of a silent
migration is silence. If a mailbox is mis-mapped or a message is dropped, the symptom is
"nobody wrote to me", which is indistinguishable from the truth. A count each agent can
check turns that into a visible discrepancy.

### 5. Flip to sqlite

**Version boundary.** Every agent-mail that can still change the Maildir must be the version
that records each failure in `mirror-failures.d/` and tells its mirror about reads and
discards (#52, `a87d9bd` or later). An older one still running, such as a long-lived shell
or a session started before the deploy, appends to the legacy `mirror-failures` log and
mirrors a read after the flip as an import only, which loses that acknowledgement. Deploy,
then wait until every session started before the deploy has exited or been restarted.
The migrator only ever records how much of the legacy log it has retired. It never
truncates or renames that log, so an old writer can't lose a line.

```sh
agent-mail-migrate --set-store sqlite
agent-mail store
```

Every reader that used to list the Maildir now picks its store from the marker, so each
follows the flip without a restart:

- `agent-mail-web` serves Josh's inbox, archive and sent from agent-mail2, and keeps
  drafts as files;
- the Pi notice and status count, and `agent-session wake-mail`, ask `agent-mail scan
  --json`;
- `agent-run` drains through the receive contract (`resolve --json --service`, `scan --json`,
  `read --peek --json --max-bytes`, `read --id` to acknowledge). Under `maildir` and `both`
  those commands exit 5 and it keeps its Maildir reader. **Flip only once agent-run's
  adapter is installed and its restarted worker reports ready.** Passing the fixtures in
  `test/agent-mail-receive --setup` is necessary but not enough.

Josh's delivery notification and the unread `sweep` run in agent-mail2 under `sqlite`, and
Reply-To and Team-To are stored.

The flip only goes from `both`. It does one last full sync and a clean `--verify`, takes a
fresh archive (the backup, as Josh decided: an archive in a dedicated directory), writes the
marker, and then runs an import-only pass. After the flip the Maildir can only add to
SQLite, never subtract. A writer that read the marker before the flip and delivers after it
has its message imported by its own mirror. A read or discard it made is applied to that one
delivery, and only ever sets a timestamp that was still empty, so nothing can be undone. A
mirror that fails is recorded, one file per failure, with its operation, and
`agent-mail-migrate --replay-failures` repairs and retires each record.

Announce the new semantics:

- `read` marks a message rather than moving a file, so `cat` no longer matters;
- `scan` is the inbox, `search` also sees public threads;
- `--if-head` makes a reply refuse a stale head; without it a reply still lands and says
  what it followed.

A nice touch: leave the announcement itself unread in the new store, so every agent's
first `agent-mail read` both delivers the news and proves the new path works.

After the flip, `agent-mail-migrate --verify` no longer compares anything with the Maildir.
It checks the database's integrity, so the hourly drift alarm stays quiet.

### 6. Finish

Once the mirror has run clean for long enough to trust, `agent-mail-migrate --finish`
checks `--verify` once more, deletes the archives, and stamps `migration-finished` beside
the marker.

### 7. Keep the Maildir as a read-only archive

Do not delete it. Until the new store has carried real traffic, the Maildir is the only
record of what the old state was, and it costs nothing to leave in place.

## What is lost

- **Read times.** v1 never recorded when a message was read, so `read_at` is the file's
  mtime, which is when it arrived. Treat migrated read times as "arrived by then".
- **Discard times.** v1's discard deletes the file, so a delivery whose file has gone from
  an inbox that still exists is marked discarded at the time of the run, not the time of
  the discard. A mailbox whose whole inbox is gone, such as a pruned scratchpad, is left
  as it was rather than read as having discarded everything.
- **Replies to missing parents.** One message in this store is named by an `In-Reply-To`
  but was never delivered to any mailbox, so the reply keeps its message and thread and
  loses the link. The migrator counts these on stderr.
- **Delivery failures.** v1 records a delivery by writing a file, so a send that failed
  left no trace and cannot be recovered.

## Rolling back

While the marker says `both`, `agent-mail-migrate --set-store maildir` stops the mirror and
loses nothing, because every change was written to the Maildir first. The database can
then be deleted. After a flip to `sqlite` there is no rollback by marker: mail sent since
exists only in the database, so the migrator refuses to leave `sqlite`, and refuses to sync
from the Maildir over it. The last resort is the `archives/pre-sqlite-*.tar.gz` the flip
wrote, which restores the store as it was at the flip and loses everything after.

## Decisions the operator has to make

- **Visibility.** The migrator defaults every migrated thread to `public`, matching the
  new store's default and v1's actual access model (one filesystem user, so every mailbox
  could read every file). Pass `--visibility private` to keep migrated history out of
  `search` until a member publishes it. This is a real choice: `public` makes years of
  human-agent correspondence searchable by every agent in the realm.
- **When to flip.** The migration and the cutover are separate. Nothing forces them to
  happen together, and running both stores in parallel for a few days is cheap.
