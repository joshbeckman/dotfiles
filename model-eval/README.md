# Pi model evaluation

I use this harness to compare configured Pi models on a small set of representative tasks. It records correctness, timing, tokens, cache activity, and catalog-estimated cost as separate facts. It does not produce a composite ranking.

V1 contains one smoke fixture for each of four work categories: code development, debugging, interface design, and prose editing. Fixtures are synthetic and dependency-free. Deterministic graders remain outside the model-visible workspace.

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

The trial subprocess disables discovered extensions for a stable evaluation surface. If a selected model gets its catalog or authentication from an extension, pass that trusted extension explicitly without publishing its path:

```sh
pi-model-eval run \
  --models provider/model:low \
  --provider-extension ~/.pi/agent/extensions/provider/index.ts
```

Repeat `--provider-extension` when a provider needs more than one. The run manifest records only the count, not private extension paths. If provider authentication cannot be separated from the normal Pi extension set, `--inherit-extensions` loads that set and records the weaker isolation mode in the manifest. Use it only when needed because those extensions can alter prompts, events, and side effects.

Defaults are one repeat per fixture, 120 seconds, 200,000 tokens, 20 turns, and $0.50 per trial, plus $2 or 30 minutes for the suite. Override them with `--repeats`, `--timeout`, `--token-limit`, `--turn-limit`, `--trial-budget`, `--suite-budget`, and `--suite-timeout`.

Results stay untracked under `~/.local/share/pi-model-eval/runs/` unless `--results` or `PI_MODEL_EVAL_RESULTS` selects another directory. Each run contains:

- `manifest.json` with runtime, fixture, ordering, and limit metadata
- `trials/*/events.jsonl` with timestamped event shapes and usage; model text, tool payloads, extension data, and provider diagnostics are omitted
- `trials/*/result.json` with status, usage, timing, pricing status, and named grader checks
- `trials/*/answer.md`, a copy of the final workspace, and a `stderr.log` containing only the omitted byte count
- `report.md` with comparisons and trial failures

A timeout or observed spend stop first sends RPC `abort`, then terminates the trial process group if it does not exit. A rejected prompt, including unavailable authentication, fails immediately rather than consuming the timeout. Missing or zero catalog pricing remains unknown rather than appearing as measured zero cost.

## Fixture boundary

Every trial gets a fresh temporary workspace and session. By default, Pi starts without discovered extensions, skills, prompt templates, context files, project approval, or session persistence. The evaluation extension restricts reads and writes to relative, non-symlink paths inside the workspace and permits only exact shell commands named by the fixture. Allowed commands and graders run with a minimal environment so model-written code cannot read credentials inherited from the operator's shell.

This boundary prevents accidental access during trusted, dependency-free fixtures. It is not a hostile-code sandbox. Fixtures that require arbitrary shell execution, package installation, live services, private data, or network access need a separate design decision.

## Add a fixture

Create a directory under `model-eval/fixtures/` containing:

- `manifest.json`
- `prompt.md`
- `workspace/`
- a grader that prints JSON with `required_pass` and named `checks`
- `command_timeout_seconds` plus explicit `allowed_commands` and `allowed_files` in the manifest

The fixture version is a SHA-256 hash of all files in its directory. Hidden checks should verify outcomes rather than one exact answer. Keep expected answers and grading logic outside `workspace/` so the model cannot read them.
