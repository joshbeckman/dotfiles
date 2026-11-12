# Pi model evaluation

I use this harness to compare configured Pi models on a small set of representative tasks. It records correctness, timing, tokens, cache activity, and catalog-estimated cost as separate facts. It does not produce a composite ranking.

V1 contains one smoke fixture for each of four work categories: code development, debugging, interface design, and prose editing. Fixtures are synthetic and dependency-free. Deterministic graders remain outside the model-visible workspace.

A second family, `viewmd-*`, covers one category: reading GitHub issues and pull requests. Six fixtures: a patch-heavy pull request, a discussion-heavy one, a small one, an issue answered from its body, an issue answered only from its timeline, and review comments with code context. Those fixtures hold a snapshot of one real item instead of a synthetic workspace, so a run can compare read policies against each other.

## Plan a run

Specify every model and thinking level explicitly:

```sh
pi-model-eval plan \
  --models provider/model-a:high,provider/model-b:high
```

The plan reports the fixture versions, trial count, timeout, spend stops, and maximum cost if every trial reaches its cap. Planning makes no model calls.

List models known to the installed Pi runtime with:

```sh
pi-model-eval models
```

## Run the smoke suite

```sh
pi-model-eval run \
  --models provider/model-a:high,provider/model-b:high
```

By default, each trial loads the extensions, skills, prompt templates, context files, settings, and authentication from the active Pi configuration. This measures a model in the environment where I actually use it rather than as a bare provider call.

The source configuration is never Pi's writable runtime directory. Each trial copies root configuration files, including settings and authentication, into a private temporary directory and points `PI_CODING_AGENT_DIR` there. Source-relative resource and local-package settings are resolved to their original absolute locations; missing selected paths fail the trial instead of silently degrading it. Installed resource directories remain discoverable from their selected source while startup package and model-catalog network updates are disabled. The private directory is removed after normal completion, failure, timeout, or interruption and is never included in run artifacts. The manifest fingerprint still describes the selected source configuration, not its disposable runtime copy.

Use another configuration directory to compare setups:

```sh
pi-model-eval run \
  --models provider/model:low \
  --config-dir ~/.pi/agent-experiment \
  --config-label experiment
```

A run can add `--extension`, `--skill`, or `--prompt-template` paths, or disable discovery with `--no-extensions`, `--no-skills`, `--no-prompt-templates`, and `--no-context-files`. The manifest records the public-safe label, discovery switches, resource counts, and an aggregate fingerprint for settings, direct resources, installed package revisions, and explicit resources. Sensitive settings values and authentication files are excluded. The manifest does not record config paths, resource names, or contents.

Defaults are one repeat per fixture, 120 seconds, 200,000 tokens, 20 turns, and $0.50 per trial, plus $2 or 30 minutes for the suite. Override them with `--repeats`, `--timeout`, `--token-limit`, `--turn-limit`, `--trial-budget`, `--suite-budget`, and `--suite-timeout`.

Results stay untracked under `~/.local/share/pi-model-eval/runs/` unless `--results` or `PI_MODEL_EVAL_RESULTS` selects another directory. Each run contains:

- `manifest.json` with runtime, fixture, ordering, and limit metadata
- `trials/*/events.jsonl` with timestamped event shapes and usage; model text, tool payloads, extension data, and provider diagnostics are omitted
- `trials/*/result.json` with status, usage, timing, pricing status, and named grader checks
- `trials/*/answer.md`, a copy of the final workspace, and a `stderr.log` containing only the omitted byte count
- `report.md` with comparisons and trial failures

A timeout or observed spend stop first sends RPC `abort`, then terminates the trial process group if it does not exit. A rejected prompt, including unavailable authentication, fails immediately rather than consuming the timeout. Missing or zero catalog pricing remains unknown rather than appearing as measured zero cost.

## Compare a tool policy

A run is one policy. Change the policy with the instructions a trial loads and with the snapshot a
stub CLI can serve, then compare runs by their `configuration.label`.

`model-eval/policies/` holds three skills for reading GitHub context: `viewmd-today` (read with
`gw view-md`), `viewmd-trimmed` (read with `gw view-md --max-diff 0`), and `targeted` (read with
`gh pr view --json`, `gh pr diff`, and `gh api`). Load one with `--skill` while discovery is off, so
no other skill leaks into the trial:

```sh
bin/pi-model-eval run \
  --models provider/model:medium \
  --fixtures viewmd-pr-diff-heavy,viewmd-pr-discussion-heavy,viewmd-pr-diff-light,viewmd-issue-context,viewmd-pr-review-hunk \
  --repeats 6 \
  --no-skills --no-context-files --no-prompt-templates --no-extensions \
  --skill model-eval/policies/viewmd-today \
  --config-label viewmd-today
```

`--snapshot-variant NAME` serves the fixture's `snapshot-NAME/` directory instead of `snapshot/`.
The `viewmd-*` fixtures ship a `removed/` variant with no view-md record, which stands for a
machine where the extension is not installed. A trial cannot read either directory; the harness
passes the selected one to the stub CLI by path.

`--env KEY=VALUE` sets an environment variable in every trial and in the bash wrapper. Both flags
are recorded in `manifest.json`.

## Fixture boundary

Every trial gets a fresh temporary workspace and session while loading the active Pi configuration. Project approval and session persistence remain disabled. The evaluation extension is added after the configured extensions. It permits read-only access to configured skill files, restricts other reads and all writes to relative, non-symlink paths inside the workspace, and permits only exact shell commands named by the fixture. Allowed commands and graders run with a minimal environment so model-written code cannot read credentials inherited from the operator's shell.

This boundary prevents accidental access during trusted, dependency-free fixtures. It is not a hostile-code sandbox. Configured extensions still execute as trusted code; configuration isolation prevents Pi-owned state writes but cannot constrain an extension that deliberately writes directly to another path. Fixtures that require arbitrary shell execution, package installation, live services, private data, or network access need a separate design decision.

## A fixture from GitHub

The `viewmd-*` fixtures read real GitHub content, so they carry a snapshot instead of live access.
`model-eval/capture.rb` records one item into a fixture:

```sh
ruby model-eval/capture.rb viewmd-pr-diff-heavy pull https://github.com/joshbeckman/dotfiles/pull/280
```

It writes gzipped `gh view-md`, `gh view-md --max-diff 0`, `gh pr view --json`, `gh pr diff`, and
`gh api .../pulls/N/comments` output under `snapshot/`, symlinks the same records without view-md
into `snapshot-removed/`, and installs `model-eval/snapshot-cli.rb` as `workspace/bin/gh` and
`workspace/bin/gw`. Commit the snapshot so the fixture version stays fixed. `test/snapshot-cli`
fails when an installed copy drifts from the source.

A fixture that uses the stub lists `"allowed_command_prefixes": ["bin/gh ", "bin/gw "]` and allows
`.calls.tsv` and `.bash.tsv`, which the stub and the boundary write. A prefix-matched command must
be one plain command: the boundary refuses chaining, redirection, substitution, and a leading
environment assignment, so a trial cannot rewrite what the stub reads.

What the stub serves: `pr view`, `pr diff`, `pr checks`, `issue view`, `api .../pulls/N/comments`,
`api .../issues/N/timeline`, `extension list`, and `view-md` with `--max-diff`. `--json` takes a field subset and `--jq` filters
it. Every call appends its name and byte count to `.calls.tsv`, so a run can report delivered bytes
next to tokens.

## Add a fixture

Create a directory under `model-eval/fixtures/` containing:

- `manifest.json`
- `prompt.md`
- `workspace/`
- a grader that prints JSON with `required_pass` and named `checks`
- `command_timeout_seconds` plus explicit `allowed_commands` and `allowed_files` in the manifest

The fixture version is a SHA-256 hash of all files in its directory. Hidden checks should verify outcomes rather than one exact answer. Keep expected answers and grading logic outside `workspace/` so the model cannot read them.
