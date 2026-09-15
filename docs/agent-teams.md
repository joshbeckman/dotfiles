# Agent teams

`agent-team` manages explicit teams with stable `@team/<slug>` handles, one coordinator, and a shared scratchpad. An agent can belong to several teams. Membership records agreed responsibilities; it does not infer hierarchy from surnames, launches, or messages.

## Commands

These examples assume the named agents already have permanent identity-registry entries. Creating a team does not create or launch agents.

```sh
agent-team create orchard --coordinator @+alder-turner-of-hearth \
  --name 'Orchard maintenance' --purpose 'Coordinate the orchard project'
agent-team join @team/orchard --agent @+birch-weaver-of-hearth --scope 'Review migrations'
agent-team show @team/orchard
agent-team search orchard
agent-team list --json
agent-team members @team/orchard
agent-team scratchpad @team/orchard
```

| Command | Behavior |
|---|---|
| `create SLUG --coordinator AGENT` | Creates the record and scratchpad; the coordinator is its first member. Optional `--name` and `--purpose`. |
| `show TEAM` | Shows coordinator, current members, purpose, and scratchpad. JSON also includes history. |
| `list`, `search QUERY` | Lists active and archived teams; search matches handle, name, or purpose case-insensitively. |
| `join TEAM [--agent AGENT] [--scope TEXT]` | Starts a membership interval. Repeating an active join is a no-op, not a scope edit. |
| `leave TEAM [--agent AGENT]` | Ends membership without erasing history. The coordinator must transfer first. |
| `transfer TEAM --coordinator AGENT --accept` | Transfers to an existing current member and records the handoff. `--accept` attests the incoming coordinator’s agreement; it does not obtain or verify that agreement. |
| `archive TEAM` | Freezes the roster and record, disables broadcasts, and retains history and scratchpad. No delete, unarchive, or handle reuse in this version. |
| `members TEAM` | Emits current canonical agent handles, one per line. Refuses archived teams. |
| `scratchpad TEAM` | Prints the team’s shared working directory. |

Commands accept `orchard`, `team/orchard`, or `@team/orchard`. Mail requires the explicit team prefix. Slugs are lowercase ASCII letters/digits with internal `.`, `_`, or `-`, at most 64 characters; invalid input is rejected rather than renamed into another team’s handle. Handles stay fixed through handoffs.

All commands except `scratchpad` accept `--json`. `show` and mutations emit an object; `list` and `search` emit arrays; `members` emits current membership objects. A successful read does not create an absent team root.

`join` and `leave` default to the caller’s permanent identity, preferring `AGENT_SCRATCHPAD` over `AGENT_HANDLE`. A human invocation without agent identity must supply `--agent`. Canonical agent handles and verified transport aliases are accepted; human addresses, unknown identities, mismatched session suffixes, and ambiguous aliases are rejected.

## Team mail

```sh
agent-mail send --to @team/orchard --subject 'Review ready' --body-file update.md
agent-mail send --to @team/orchard --to @josh --body-file update.md
```

Team addresses also work in a draft’s `To:` field and through `agent-mail deliver`.

- The roster is expanded once per distinct addressed team per send/delivery. The coordinator is included, even if also the sender. Overlapping teams and direct aliases are deduplicated by resolved inbox.
- Registered agent handles resolve through the permanent identity claim to a session-qualified scratchpad, including pre-realm aliases. A bare-name directory cannot override that route. Missing, malformed, or ambiguous registered targets fail rather than falling back to a different mailbox; aliases to the same physical scratchpad are deduplicated. Explicit session-qualified addresses stay pinned to their exact directory, even when it is missing; unregistered legacy names retain filesystem lookup.
- Every recipient is resolved and checked before delivery starts. Missing or archived teams, malformed roster output, unreachable members, and team-member addresses conflicting with human addresses fail visibly. No silent skipping.
- `To:` stores the concrete recipient snapshot. `Team-To:` retains the addressed team handles as informational provenance. Reply-all uses the original recipients, not the team’s later roster. Membership changes neither add recipients to an old thread nor revoke former recipients from its reply-all list. Address the team explicitly again to use the new roster.
- Teams cannot be senders or `Reply-To` targets and have no separate inbox. `agent-mail addr`, `read`, and `inbox` do not turn a team scratchpad into a mailbox. Member delivery retains existing notifications, wakeups, Sent copies, and receipts.
- A send validates before copying, but delivery is not a transaction across filesystems. A disk error partway through can leave partial delivery. Check receipts/Sent before retrying. A failed draft delivery can retain the concrete roster snapshot so a retry does not silently target newly joined members.

## Discovery

`agent-find` adds active team membership to its existing terminal and JSON session results. Membership is matched by full session ID, not transcript mentions or name prefixes.

The `teams` array contains each team’s `handle`, `name`, `coordinator`, `scope`, `joinedAt`, `scratchpad`, and a derived `role` (`coordinator` or `member`). Archived teams and ended intervals are excluded. No membership is `[]`; an unreadable or damaged team registry produces `teams: null`, a `teamsWarning`, and a stderr warning while ordinary session discovery continues.

The web inbox can send a manually entered team address through its composer. Contact and thread participant cards show active team handles, names, and roles; expand a membership for its coordinator, contribution scope, join time, and shared scratchpad. Unavailable metadata is shown separately from no active memberships. Refresh the page or repeat a contact search to get a new roster snapshot. The Teams page lists active and archived teams and searches handle, name, or purpose. Expand a team for its roster, scratchpad, coordinator history, and ended memberships; expand a roster contact for session details. Message team opens a draft for active teams, while archived teams remain read-only. Refresh reloads the selected directory. Creation, enrollment, transfers, and archival still use the CLI.

## Storage and boundaries

Private state defaults to `~/.local/state/agent/teams`, separate from individual scratchpads:

```text
teams/
  .lock
  orchard/
    team.json
    scratchpad/
```

`AGENT_TEAM_ROOT` overrides that root. `AGENT_IDENTITIES_DIR` selects the existing `by-name` registry. Mail delivery uses the usual `AGENT_MAIL_ROOT`, `AGENT_SCRATCH_ROOT`, and `AGENT_HUMAN_MAIL_ROOT` settings. State is local to the computer’s agent realm; no cross-machine group delivery is provided.

The version-1 record holds the handle, display name, purpose, status, coordinator, membership intervals, creation/update times, and coordination/archive history. Absolute scratchpad paths are derived for output rather than stored as another source of truth. Root locking covers each read-modify-write operation. Records are bounded to 1 MiB and replaced atomically using private temporary files; directories use `0700` and records/locks `0600`. Symlinked roots, team directories, scratchpads, records, and locks are refused. New teams are built in private `.creating-*` directories and published by directory rename only after both record and scratchpad exist. An interrupted creation can leave unpublished staging data, which enumeration ignores; it cannot reserve the requested handle or hide healthy teams.

Use the scratchpad for shared working notes and handoffs. Durable project decisions and deliverable status still belong in their repositories, issues, and project records. Coordinate roster changes and obtain handoff agreement through Agent Mail before recording them. Membership grants neither artifact ownership nor permission to publish, merge, or interrupt another agent.

These controls prevent accidental corruption and unsafe paths, not access by another program running as the same OS user. There is no authentication, automatic membership, leader failover, nested team expansion, or new monitoring process.

## Checks

All tests use isolated team roots, identity registries, scratchpads, and mailboxes:

```sh
test/agent-team
/bin/bash test/agent-mail
test/agent-find
test/agent-team-integration
test/agent-mail-web
cd apps/agent-mail-web && npm test
```

The lifecycle suite exercises concurrent joins, departures, creates, and transfer/leave races. Integration tests invoke the real three CLIs to check broadcasts, historical aliases, draft delivery, reply snapshots after roster changes, and discovery failure reporting.

Co-authored-by: AI Simoom Farrier (pi/openai/gpt-6-astra) @+simoom-farrier
