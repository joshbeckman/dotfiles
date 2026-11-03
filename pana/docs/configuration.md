# Configuration reference

Panad reads `config.json` from `~/.local/state/pana/` at startup. `PANA_STATE` overrides
that state directory; it is an environment variable, not a configuration key. The same
JSON validation runs before a save from **Settings**. This reference covers the keys
recognized by [`Config` and `parseConfig`](../src/config/index.ts).

## Start with identity

Only `domain` and `user` are required:

```json
{
  "domain": "pana.example.org",
  "user": "alice"
}
```

This starts the daemon with the defaults below. To create sessions, also configure a
`defaultModel`, choose a model in a session profile, or supply a model when creating the
session. Provider credentials are separate from this file; see [Run it](../README.md#run-it).
Do not put credentials or the web authorization token in `config.json`.

## Saving and applying changes

- **Your message color (`ui.userColor`) applies live when saved through Settings.**
  Existing user messages and participant marks update in connected windows, and new
  connections receive the current color. Session colors and black domain notices do not
  change. A preview or an unsaved JSON edit does not change messages.
- **All operational settings require a daemon restart.** Saving writes the file but does
  not change budgets, models, checkout protection, ports, or other operational settings
  halfway through a running session. Direct file edits are loaded on restart, including
  edits to `ui.userColor` that did not go through Settings.
- `domain` and `user` identify existing records. Settings refuses changes to either;
  changing identity in a file is not a data migration.
- Settings saves are user-only, validate the whole configuration, and write atomically.
  Each save carries the revision read by the editor. An intervening file edit produces a
  conflict rather than overwriting it. Refresh status keeps the unsaved draft and its
  original revision; Reload configuration asks before discarding edits.
- Restart is separate from save, requires confirmation, and interrupts active runs.
  Invalid on-disk configuration blocks a requested restart. Embedded daemons or runtimes
  without restart support show an unavailable button; use the service manager instead.

Unknown keys, including nested keys, are preserved in the JSON written by Settings.
They are not part of the parsed runtime configuration and do not acquire behavior just
because they are saved. Omitted supported keys receive runtime defaults; defaults are
not automatically inserted into the saved file. Comments and original whitespace are
not preserved when saving JSON.

## Validation rules

The file must be a JSON object, not an array or `null`. Optional nested sections
(`ui`, `budget`, `files`, `http`, `tools`, `scratch`, `objectives`) must be objects when
present. An empty object uses that section's defaults. Omit an optional value to use its
default; `null` is not a substitute for omission. Numeric values must be finite JSON
numbers, not quoted strings. Except where an integer is explicitly required below,
validation permits fractional numbers.

### Identity, time, and models

| Key | Default | Validation and meaning |
| --- | --- | --- |
| `domain` | Required | Nonempty string. The domain used in pana URLs and records; choose a host such as `pana.example.org`, without a URL scheme. Startup checks nonemptiness, not hostname syntax. Immutable in Settings. |
| `user` | Required | Nonempty string. The local user's name/address component. Immutable in Settings. |
| `timezone` | System time zone, falling back to `UTC` | Nonempty time-zone string accepted by `Intl.DateTimeFormat`, such as `America/Chicago` or `UTC`. Used for cron schedules and local-day accounting. |
| `subjectModel` | Unset | Nonempty model reference string. Enables background thread/schedule naming and subject regeneration. When unset, initial names use the fallback first line. Configuration validation does not check provider availability. |
| `defaultModel` | Unset | Nonempty model reference string used when creating a session without an explicit or profile model. Typical form: `provider/model-id`. A usable model and its provider credentials must be available; string validation alone does not verify that. |
| `spawnDepth` | `3` | Nonnegative integer. Caps recursive session creation: a parent at the depth limit cannot create another child. `0` prevents sessions from spawning children. |

### Presentation

| Key | Default | Validation and meaning |
| --- | --- | --- |
| `ui.userColor` | `"blue"` (`#002FA7`) | A hex color string in `#RGB`, `#RGBA`, `#RRGGBB`, or `#RRGGBBAA` form. Hex digits are case-insensitive; alpha, when present, is the final component. Legacy named palette values remain accepted: `blue`, `orange`, `purple`, `green`, `red`, `yellow`, `black`. Other CSS names/functions are not accepted. Applies live on a Settings save, unlike operational keys. |

For example, `"ui": { "userColor": "#7c3aed" }` chooses an opaque purple, and
`"ui": { "userColor": "#7c3aedcc" }` includes alpha. Choose a color with sufficient
contrast against both light and dark themes. A very transparent color can make the
message mark difficult to see.

### Budgets and file uploads

| Key | Default | Validation and meaning |
| --- | --- | --- |
| `budget.sessionUsd` | `100` | Nonnegative number of US dollars. A session whose recorded cost passes this amount is stopped and its creator receives a notice. `0` is a zero budget, not an unlimited budget. |
| `budget.domainDailyUsd` | `500` | Nonnegative number of US dollars. When domain spend passes this amount for the local day, new runs are refused until the next local day. This is the domain-wide backstop, including objective spend. `0` is not unlimited. |
| `files.maxBytes` | `26214400` (25 MiB) | Positive number of bytes. Maximum size of an uploaded file. |

### HTTP and tool safety

| Key | Default | Validation and meaning |
| --- | --- | --- |
| `http.port` | `8766` | Integer from `0` through `65535`. TCP listener port; `0` requests an available ephemeral port. This key does not disable TCP. Embedded startup options can override the port or disable TCP; they are not `config.json` keys. |
| `tools.bashTimeoutSec` | `600` | Positive number of seconds. Time limit for a `bash` call that supplies no timeout of its own. Timed-out commands are killed with their process group. |
| `tools.protectCheckouts` | `"guard"` | `"guard"`, `"sandbox"`, or `"off"`; legacy boolean `true` means `"guard"`, `false` means `"off"`. `guard` refuses checkout writes and commands that enter protected checkouts. `sandbox` adds per-call read-only checkout mounts where supported. `off` disables these protections. |

Prefer leaving checkout protection enabled and using a session-owned worktree. The
`sandbox` mode depends on the host's mount/sandbox facilities; it does not make every
platform support the same isolation mechanism. See [checkout protection](../README.md#isolation-from-pi)
for the workflow.

### Scratch cleanup

| Key | Default | Validation and meaning |
| --- | --- | --- |
| `scratch.ttlDays` | `8` | Positive number of days. Removes scratch for sessions idle beyond this interval, and for archived/missing sessions. Running or waiting sessions are protected from the sweep. |
| `scratch.maxTotalMB` | Unset (no size cap) | Positive number of megabytes. If remaining scratch exceeds this size, cleanup removes the longest-idle eligible scratch until it fits. It still does not remove running/waiting sessions' scratch. |

The sweeper runs on daemon startup and every 24 hours. These are scratch policies, not
project-worktree retention policies; useful work belongs in its canonical home.

### Objective defaults

These values configure objective gates/defaults, not the optional fields of an objective
limits API request. They must be positive numbers even though the things being counted
are members/messages. Per-objective values can override applicable defaults.

| Key | Default | Validation and meaning |
| --- | --- | --- |
| `objectives.maxMembersPerRun` | `8` | Positive number. Maximum member creations by one lead run. |
| `objectives.maxDailyUserMessages` | `10` | Positive number. Default objective cap on messages sent to the user per local day; used when the objective has no own value. |
| `objectives.wakeMinMinutes` | `5` | Positive number of minutes. Default quiet interval between a lead's runs before held delivery can start one; used when the objective has no own value. |

Other objective limits, such as `maxDailyUsd`, `maxTotalUsd`, `maxDailyLeadTurns`, and
`maxActiveMembers`, are set on an objective, not as supported top-level configuration
keys. See [objectives](../README.md#objectives).

## Managed worktree adapters

`worktreeAdapters` defaults to `[]`. When present, it must be an array of entries with
this structure:

| Entry key | Default | Validation and meaning |
| --- | --- | --- |
| `repo` | Required | Absolute path to the repository's shared Git directory, as identified by `git rev-parse --path-format=absolute --git-common-dir`. Not the ordinary checkout root. Matching uses resolved paths. |
| `root` | Required | Absolute path to the directory containing managed trees. |
| `subdir` | Omitted (checkout at the tree root) | Nonempty relative path to the checkout inside each managed tree, for example `src`. Must not start with `/` or contain `.` or `..` path components. |
| `create` | Required | Nonempty array of nonempty strings: executable followed by arguments. Runs without shell evaluation, in the requested repository checkout, with a ten-minute timeout. |

An illustrative machine-local adapter (the executable is supplied by that machine,
not built into pana):

```json
{
  "worktreeAdapters": [
    {
      "repo": "/srv/git/project.git",
      "root": "/srv/trees",
      "subdir": "src",
      "create": ["/usr/local/bin/create-project-tree", "{name}", "{branch}", "{path}"]
    }
  ]
}
```

Recognized placeholders can appear inside any `create` argument:

- `{name}`: the sanitized, lowercase managed tree ID, including the session ID and worktree name.
- `{branch}`: the requested branch, or the collision-safe branch generated by pana.
- `{path}`: the expected checkout destination, including `subdir` if configured.
- `{repo}`: the repository checkout path supplied/resolved for the worktree request;
  this is not the adapter's shared-Git-directory `repo` field.

The expected destination is `<root>/<name>/<subdir>` (or `<root>/<name>` without
`subdir`). The materializer must create a valid worktree there for the matching shared
repository. Pana verifies ownership and the resulting checkout before using it. It
will not adopt an existing unowned managed destination. No shell expansion is applied
to arguments: `~`, `$HOME`, pipes, and redirections are not interpreted by pana.

This is a trusted machine-local command integration; only configure executables you
intend the daemon to run. It configures creation, not arbitrary command execution by
sessions or an automatic removal command. Repositories without a matching adapter use
ordinary Git worktrees under the state directory. See the [adapter workflow and
troubleshooting guide](worktree-adapters.md) for creation and ownership checks.

## Example with defaults made explicit

The following is valid without model configuration; sessions still need an explicit or
profile model. Optional `subjectModel`, `defaultModel`, and `scratch.maxTotalMB` are
omitted rather than set to `null`.

```json
{
  "domain": "pana.example.org",
  "user": "alice",
  "timezone": "UTC",
  "ui": { "userColor": "blue" },
  "spawnDepth": 3,
  "budget": { "sessionUsd": 100, "domainDailyUsd": 500 },
  "files": { "maxBytes": 26214400 },
  "http": { "port": 8766 },
  "tools": { "bashTimeoutSec": 600, "protectCheckouts": "guard" },
  "scratch": { "ttlDays": 8 },
  "objectives": { "maxMembersPerRun": 8, "maxDailyUserMessages": 10, "wakeMinMinutes": 5 },
  "worktreeAdapters": []
}
```

`UTC` is an explicit choice in this example; omitting `timezone` uses the system zone.
See the [behavior specification](../SPEC.md#config-and-state) and
[Settings implementation](../src/config/handlers.ts) for the persistence/restart contract.
