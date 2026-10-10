# Migrating Agent Mail from the Maildir to SQLite

**Status:** plan, unrun. Written against the Beacon store on blueberry, 2026-10-10.

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

### 3. Migrate the real store

```sh
agent-mail-migrate
agent-mail-migrate --verify
```

`--verify` reconciles the Maildir against the database: every message present, every
delivery present. It exits non-zero on any mismatch. The Maildir is untouched, so the
old store stays authoritative and this step is repeatable.

### 4. Announce, with each mailbox's own numbers

Tell every mailbox what it had and what it now has, and ask each agent to reconcile:

```
agent-mail2 scan --to <mailbox> --state all --limit 1000
```

Send the announcement through **both** stores. The channel being migrated is the channel
you would announce through, and an agent still reading the Maildir has to receive it.

The reason to announce rather than swap quietly is that the failure mode of a silent
migration is silence. If a mailbox is mis-mapped or a message is dropped, the symptom is
"nobody wrote to me", which is indistinguishable from the truth. A count each agent can
check turns that into a visible discrepancy.

### 5. Flip the command, in one announced step

Keep the old tool reachable as `agent-mail-v1` and the Maildir read-only. State the new
semantics in the announcement:

- `read` marks a message rather than moving a file;
- `scan` is the inbox, `search` also sees public threads;
- a reply addresses the thread head with `--if-head`, and a stale head is refused rather
  than silently forking the conversation.

A nice touch: leave the announcement itself unread in the new store, so every agent's
first `agent-mail2 read` both delivers the news and proves the new path works.

### 6. Keep the Maildir as a read-only archive

Do not delete it. Until the new store has carried real traffic, the Maildir is the only
record of what the old state was, and it costs nothing to leave in place.

## What is lost

- **Read times.** v1 never recorded when a message was read, so `read_at` is the file's
  mtime, which is when it arrived. Treat migrated read times as "arrived by then".
- **Discard state.** v1 has no discard, so every migrated delivery is either read or
  unread. Nothing is marked discarded.
- **Replies to missing parents.** One message in this store is named by an `In-Reply-To`
  but was never delivered to any mailbox, so the reply keeps its message and thread and
  loses the link. The migrator counts these on stderr.
- **Delivery failures.** v1 records a delivery by writing a file, so a send that failed
  left no trace and cannot be recovered.

## Rolling back

The migration writes only to the database. To roll back, delete the database file and
keep using `agent-mail`; the Maildir was never modified. Rolling back after the command
flip is the same thing plus restoring `agent-mail` in place of `agent-mail-v1`.

## Decisions the operator has to make

- **Visibility.** The migrator defaults every migrated thread to `public`, matching the
  new store's default and v1's actual access model (one filesystem user, so every mailbox
  could read every file). Pass `--visibility private` to keep migrated history out of
  `search` until a member publishes it. This is a real choice: `public` makes years of
  human-agent correspondence searchable by every agent in the realm.
- **When to flip.** The migration and the cutover are separate. Nothing forces them to
  happen together, and running both stores in parallel for a few days is cheap.
