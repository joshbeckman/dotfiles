---
name: analyze-overrides
description: Analyze commander-keen overrides and voter log to suggest safe_commands and safe_multi_commands promotions.
---

# Analyze Commander Keen Overrides

You are analyzing the user's commander-keen override history and voter log to find commands that have been approved often enough to promote into the permanent safe list.

## Background

Commander-keen has three data sources that capture commands not on the safelist:

1. **Overrides** (`overrides.json`): Compound commands (using `&&`, `||`, `;`) that the user manually approved. These are learned as normalized patterns for future auto-approval. Only compound commands are eligible for override learning.

2. **Voter log** (`votes.log`): All commands (simple and compound) that went through the LLM voter panel. Each entry records whether voters unanimously approved (`"allow"`) or escalated to the user (`"ask"`).

3. **Approval log** (`approvals.json`): Every executed non-compound command that wasn't fully covered by the safelist. Compound commands are handled by overrides instead. Written by PostToolUse, which only fires for commands that were approved and executed. Patterns are normalized on write and deduplicated with counts, matching the same JSON format as `overrides.json`.

By cross-referencing the voter log and approval log, we can determine **how** a command was approved:
- In `approvals.json` + `votes.log` with `"allow"` = voter auto-approved
- In `approvals.json` + `votes.log` with `"ask"` = **user approved** (voter escalated, user said yes)
- In `approvals.json` + no `votes.log` entry = approved via override match

All three data sources should be analyzed together to produce a unified set of promotion suggestions.

## Instructions

### Step 1: Read all four files

Read these four files:

- `~/.claude/hooks/commander-keen/overrides.json` (override history)
- `~/.claude/hooks/commander-keen/config.json` (current safe list)
- `~/.claude/hooks/commander-keen/votes.log` (voter log, JSONL format)
- `~/.claude/hooks/commander-keen/approvals.json` (approval log, JSON format)

If the config file does not exist, treat `safe_commands` as `[]` and `safe_multi_commands` as `{}`.

If all data files (overrides, votes.log, approvals.json) are missing or empty, tell the user there is no data to analyze yet and stop. Proceed with whichever files are available.

### Step 2: Understand the data shapes

**Overrides file** (`overrides.json`):

```json
{
  "version": 1,
  "patterns": [
    {
      "pattern": "git status",
      "first_approved": "2026-03-01T12:00:00Z",
      "last_seen": "2026-03-15T09:30:00Z",
      "count": 47
    }
  ]
}
```

Each `pattern` field contains a normalized command string. Normalization strips arguments but keeps structure:
- `"git status"` means `git status <anything>`
- `"cd && git show | grep"` means `cd <path> && git show <ref> | grep <pattern>`
- `"npm"` means any `npm` invocation (subcommands are stripped during normalization when the base command is not in `safe_multi_commands`, so this could represent `npm install`, `npm run test`, etc.)

**Config file** (`config.json`):

```json
{
  "safe_commands": ["cat", "ls", "echo"],
  "safe_multi_commands": {
    "git": ["status", "log", "diff"],
    "docker": "*"
  },
  "dangerous_commands": ["rm", "sudo", "curl"],
  "dangerous_multi_commands": {
    "git": ["push", "reset"]
  }
}
```

- `safe_commands`: single-word commands that are always allowed
- `safe_multi_commands`: commands with subcommands. The value is either `"*"` (all subcommands) or an array of allowed subcommands.
- `dangerous_commands`: commands that should never be promoted (e.g., `rm`, `sudo`, `curl`)
- `dangerous_multi_commands`: dangerous base+subcommand pairs (e.g., `git push`)

**Voter log** (`votes.log`, JSONL, one JSON object per line):

```json
{"timestamp":"2026-03-15T09:35:08Z","command":"go test ./...","result":"allow","reason":"Unanimous YES from 3 voters"}
{"timestamp":"2026-03-15T09:36:07Z","command":"rm -f foo","result":"ask","reason":"Unanimous NO from 3 voters: ..."}
```

- `result: "allow"`: voters unanimously approved, command was auto-executed
- `result: "ask"`: voters said no or split, command was escalated to the user

**Approval log** (`approvals.json`):

```json
{
  "version": 1,
  "patterns": [
    {
      "pattern": "go test",
      "first_approved": "2026-03-15T09:35:08Z",
      "last_seen": "2026-03-18T10:00:00Z",
      "count": 47
    },
    {
      "pattern": "unzip",
      "first_approved": "2026-03-15T09:36:07Z",
      "last_seen": "2026-03-15T09:36:07Z",
      "count": 1
    }
  ]
}
```

Same structure as `overrides.json`. Patterns are normalized on write using verbose normalization (preserves subcommands). Each pattern is deduplicated with a count. PostToolUse only fires for commands that were approved and executed, so every entry is a confirmed approval.

### Step 3: Parse override patterns

For each pattern in the overrides file:

1. Split on compound operators (`&&`, `||`, `;`) to get segments
2. Split each segment on `|` (pipe) to get pipeline stages
3. For each stage, extract the base command (first word) and, if present, the subcommand (second word that is not a flag starting with `-`)

Examples:
- `"git status"` -> base: `git`, subcommand: `status`
- `"cd && git show | grep"` -> three stages: (`cd`), (`git`, `show`), (`grep`)
- `"npm"` -> base: `npm`, no subcommand
- `"docker compose"` -> base: `docker`, subcommand: `compose` (represents `docker compose <anything>`)

For each extracted command, record:
- Source: `overrides`
- Approval count: the pattern's `count` field
- First seen: the pattern's `first_approved`
- Last seen: the pattern's `last_seen`

### Step 4: Parse approval log and cross-reference with voter log

#### 4a. Build a voter log index

Parse `votes.log` into a lookup structure keyed by command string. For each entry, store `result` (`"allow"` or `"ask"`) and `reason`. If a command appears multiple times, keep all entries (the same command can be voted on multiple times across sessions).

#### 4b. Parse the approval log

Read `approvals.json` and parse it as a JSON object with `version` and `patterns` fields (same structure as `overrides.json`). For each pattern entry:

1. The `pattern` field is already a normalized command string (same format as override patterns)
2. Split the pattern on compound operators (`&&`, `||`, `;`) to get segments
3. Split each segment on `|` (pipe) to get pipeline stages
4. For each stage, extract the base command (first word) and, if present, the subcommand (second word that is not a flag starting with `-`)

#### 4c. Determine approval type

For each approval log entry, look up the command in the voter log index to determine how it was approved:

- **Voter approved**: a `votes.log` entry exists for this command with `result: "allow"`
- **User approved**: a `votes.log` entry exists for this command with `result: "ask"` (the voter escalated, but the command still executed, so the user must have said yes)
- **Override approved**: no `votes.log` entry exists (the command was approved by an override match, not the voter panel)

For each extracted command, record:
- Source: `approvals`
- Approval type: `voter_approved`, `user_approved`, or `override_approved`
- Approval count: the pattern's `count` field
- First seen: the pattern's `first_approved`
- Last seen: the pattern's `last_seen`

Important parsing notes:
- The approval log now contains pre-normalized patterns (same format as overrides). No further normalization is needed.
- Pattern format: `"go test"` means `go test <anything>`, `"cd && go build"` means `cd <path> && go build <anything>`. Subcommands are already extracted during normalization.
- To cross-reference with the voter log (which contains raw commands), normalize the voter log command with the same logic and compare patterns.

### Step 5: Filter out already-safe and dangerous commands

Remove any command that is already covered by the current config:
- If a base command is in `safe_commands`, skip it
- If a base command is in `safe_multi_commands` with `"*"`, skip it
- If a base+subcommand pair is in `safe_multi_commands` as a listed subcommand, skip it

Also remove commands that are dangerous and should never be promoted:
- If a base command is in `dangerous_commands`, skip it
- If a base+subcommand pair is in `dangerous_multi_commands`, skip it

### Step 6: Merge and aggregate

Group all remaining commands by base command, combining data from overrides and approval log. For each group, compute:

- **Override approvals**: sum of `count` across override patterns containing this command (0 if only in approval log)
- **Override patterns**: number of distinct override patterns involving this command
- **Voter approved**: number of approval log entries where the approval type is `voter_approved`
- **User approved**: number of approval log entries where the approval type is `user_approved`
- **Total evidence**: override approvals + voter approved + user approved (all three represent confirmed approvals)
- **Subcommands seen**: list of distinct subcommands observed across all sources
- **First seen**: earliest timestamp across all sources
- **Last seen**: latest timestamp across all sources
- **Sources**: which data sources contributed (`overrides`, `approval_log`, or both)

### Step 7: Classify each suggestion

For each base command group:

- **`safe_commands` candidate**: The command only ever appears as a bare word with no subcommand (e.g., `"go"`, `"make"`, `"unzip"`)
- **`safe_multi_commands` candidate**: The command appears with specific subcommands (e.g., `git status`, `git log`). List the specific subcommands to allow. If the command already has some subcommands in the config, suggest adding the new ones.
- **`safe_multi_commands` with `"*"` candidate**: The command has 5+ distinct subcommands, suggesting it may be safe to allow all subcommands.

### Step 8: Output the report

#### Thresholds (adjustable)

- **Promotion threshold**: 3+ total evidence (override approvals + voter allows)
- **Too-early threshold**: fewer than 3 total evidence

#### Report format

Produce a markdown report with three sections:

**1. Summary**

State:
- Total override patterns analyzed
- Total approval log entries analyzed
- How many unique commands were found across all sources
- How many are already safe (filtered out)
- How many are dangerous (filtered out)

**2. Promotion Candidates** (3+ total evidence, ranked by total evidence descending)

For each candidate, output a block like:

```
### `go` -> safe_commands

- **Evidence**: 45 total (38 voter approved, 7 user approved, 0 override approvals)
- **Source**: approval log only
- **First seen**: 2026-01-15
- **Last seen**: 2026-03-15

Config change: add `"go"` to the `safe_commands` array.
```

Or for a multi-command candidate:

```
### `git` -> safe_multi_commands

- **Evidence**: 42 total (30 override approvals across 5 patterns, 8 voter approved, 4 user approved)
- **Subcommands to add**: `show`, `branch`
- **Source**: overrides + approval log
- **First seen**: 2026-01-15
- **Last seen**: 2026-03-15

Config change:
​```json
{
  "git": ["status", "log", "diff", "show", "branch"]
}
​```
```

If a command already exists in `safe_multi_commands` with some subcommands, show the merged list (existing + new).

**3. Too Early to Tell** (fewer than 3 total evidence)

A simple table:

| Command | Source | Voter Approved | User Approved | Override Approvals | First Seen |
|---------|--------|---------------|--------------|-------------------|------------|

### Step 9: Offer to apply

After the report, ask the user:

> Would you like me to apply these changes to `~/.claude/hooks/commander-keen/config.json`? I can apply all suggestions, or you can tell me which specific commands to promote.

If the user says yes (all or specific), read the current config file, merge the changes, and write it back with `json.MarshalIndent` style formatting (2-space indent). Preserve any existing entries.
