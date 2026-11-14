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
(`ui`, `budget`, `files`, `artifacts`, `http`, `tools`, `scratch`, `objectives`) must be objects when
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
| `decisionModel` | Unset | Nonempty model reference string naming a System One model, such as `fireworks/accounts/fireworks/models/rune`. Enables both gates that ask it a question: the wake gate, which asks one yes/no probability question before waking a session for a message from another session and skips the wake when an acknowledgment or FYI clearly needs no action, and the push gate, which asks one question before a delivery buzzes the user's phone and skips the push when nothing is waiting on him (`docs/push-gate.md`). Unset turns both off and every wake and every push happens as before. One knob, two thresholds, both named constants in `src/decisions/`. The endpoint is the provider's `/v1/systemone`, and the key comes from panad's environment (for `fireworks`, `FIREWORKS_API_KEY`). Validation checks the string only, not provider availability. A model that cannot answer, times out (about 2 seconds), or is missing means the wake happens as before. |
| `defaultModel` | Unset | Nonempty model reference string used when creating a session without an explicit or profile model. Typical form: `provider/model-id`. A usable model and its provider credentials must be available; string validation alone does not verify that. |
| `spawnDepth` | `3` | Nonnegative integer. Caps recursive session creation: a parent at the depth limit cannot create another child. `0` prevents sessions from spawning children. |

### Presentation

| Key | Default | Validation and meaning |
| --- | --- | --- |
| `ui.userColor` | `"blue"` (`#002FA7`) | A hex color string in `#RGB`, `#RGBA`, `#RRGGBB`, or `#RRGGBBAA` form. Hex digits are case-insensitive; alpha, when present, is the final component. Legacy named palette values remain accepted: `blue`, `orange`, `purple`, `green`, `red`, `yellow`, `black`. Other CSS names/functions are not accepted. Applies live on a Settings save, unlike operational keys. |

The Settings color control pairs a native color picker with a free-form hex field. The
picker changes RGB while retaining any alpha component entered in the hex field. Neither
preview changes messages until you save.

For example, `"ui": { "userColor": "#7c3aed" }` chooses an opaque purple, and
`"ui": { "userColor": "#7c3aedcc" }` includes alpha. Choose a color with sufficient
contrast against both light and dark themes. A very transparent color can make the
message mark difficult to see.

### Budgets and file uploads

| Key | Default | Validation and meaning |
| --- | --- | --- |
| `budget.sessionUsd` | `100` | Nonnegative number of US dollars. A session whose recorded cost passes this amount is stopped and its creator receives a notice. `0` is a zero budget, not an unlimited budget. |
| `budget.domainDailyUsd` | `500` | Nonnegative number of US dollars. When domain spend passes this amount for the local day, new runs are refused until the next local day. This is the domain-wide backstop, including objective spend. `0` is not unlimited. |
| `files.maxBytes` | `26214400` (25 MiB) | Positive number of bytes. Maximum size of an uploaded file, and of any other request body: a body over it is refused with 413 rather than buffered (an upload over it keeps FIL-03's 400). |

### HTTP and tool safety

| Key | Default | Validation and meaning |
| --- | --- | --- |
| `http.port` | `8766` | Integer from `0` through `65535`. TCP listener port; `0` requests an available ephemeral port. This key does not disable TCP. Embedded startup options can override the port or disable TCP; they are not `config.json` keys. |
| `tools.bashTimeoutSec` | `600` | Positive number of seconds. Time limit for a `bash` call that supplies no timeout of its own. Timed-out commands are killed with their process group. |
| `tools.protectCheckouts` | `"guard"` | `"guard"`, `"sandbox"`, or `"off"`; legacy boolean `true` means `"guard"`, `false` means `"off"`. `guard` refuses file-tool writes to unowned checkout paths and execution whose actual cwd is an unowned checkout; it does not inspect Bash command text. `sandbox` additionally mounts unowned checkouts read-only where supported. `off` disables these protections. |

Prefer leaving checkout protection enabled and using a session-owned worktree. Bash writes in `guard` mode rely on the instructed owned-worktree workflow, not a shell-command allowlist. The
`sandbox` mode depends on working Linux user namespaces; where unavailable (including
macOS), it falls back to file-tool/cwd protection rather than equivalent Bash write enforcement. See [checkout protection](../README.md#isolation-from-pi)
for the workflow.

### Scratch cleanup

| Key | Default | Validation and meaning |
| --- | --- | --- |
| `scratch.ttlDays` | `8` | Positive number of days. Removes scratch for sessions idle beyond this interval, and for archived/missing sessions. Running or waiting sessions are protected from the sweep. |
| `scratch.maxTotalMB` | Unset (no size cap) | Positive number of megabytes. If remaining scratch exceeds this size, cleanup removes the longest-idle eligible scratch until it fits. It still does not remove running/waiting sessions' scratch. |

The sweeper runs on daemon startup and every 24 hours. These are scratch policies, not
project-worktree retention policies; useful work belongs in its canonical home.

### Log rotation

`panad` appends one JSONL line per request to `<state>/panad.log`, and the PWA's samples to
`<state>/client.log`. Both rotate at a size limit, keeping a small number of previous files,
so a daemon that runs for months leaves a bounded set of files.

| Key | Default | Validation and meaning |
| --- | --- | --- |
| `logs.maxBytes` | `4194304` (4 MiB) | Whole number of bytes, `0` or more. A log rotates when the next line would pass this size: the file is renamed to `<name>.1`, older files shift up, and a new file starts. `0` turns rotation off and keeps one growing file. |
| `logs.keep` | `2` | Whole number, at least `1`. Previous files kept alongside the active one, so the files hold at most `(keep + 1) × maxBytes` of log. |

Rotation happens at a line boundary, so every file is valid JSONL on its own, and the reader
behind `pana stats requests` reads the active file and the renamed ones as one continuous
history. Both logs are created `0600`, and a restart repairs a log or a rotated file that an
earlier build left readable. An operational key: a change takes effect on the next `panad`
restart.

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
profile model. Optional `subjectModel`, `decisionModel`, `defaultModel`, and `scratch.maxTotalMB` are
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
  "logs": { "maxBytes": 4194304, "keep": 2 },
  "objectives": { "maxMembersPerRun": 8, "maxDailyUserMessages": 10, "wakeMinMinutes": 5 },
  "worktreeAdapters": []
}
```

`UTC` is an explicit choice in this example; omitting `timezone` uses the system zone.
See the [behavior specification](../SPEC.md#config-and-state) and
[Settings implementation](../src/config/handlers.ts) for the persistence/restart contract.

## Artifacts

`artifacts.maxBytes` limits the sum of recorded file sizes in one version. The default is
5242880 bytes. `artifacts.maxFiles` limits the manifest to 200 files by default.
`artifacts.capMinutes` gives each authenticated open a fresh preview capability for 60 minutes
by default. Each key accepts a positive whole number. Changes apply on restart; unknown
configuration keys remain preserved.

A build uses relative asset references. A root-relative URL leaves its capability prefix.
Published versions stay immutable; there is no retention key. `pana stats artifacts` reports
cumulative version bytes by thread and overall. Uploads left unreferenced by a retry or a rejected
publish are not included in those totals and still occupy storage. A preview of a nested entry
opens its actual path so relative assets resolve beside it; a request for the capability root still
serves the entry, but a browser opening that root resolves relative assets from the root.

Artifact responses use `sandbox allow-scripts` without `allow-same-origin`. Code runs in an
opaque origin in a frame or tab. It cannot read the reader's local storage, cookies, or panad
API responses, register a service worker, or act with the reader's bearer token. The sandbox
does not block network requests or prevent an artifact from sending its own bytes elsewhere.
A no-cors request can reach panad; bearer authentication refuses unauthorized operations.
Native forms, scripted downloads, popups, and Web Push are not enabled. Interaction is
transient; reloading restores the published snapshot.
