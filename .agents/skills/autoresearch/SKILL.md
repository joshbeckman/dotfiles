---
name: autoresearch
description: Run an approved, bounded experiment loop against a fixed evaluator, keeping verified improvements and recording rejected trials. Use when the user requests autoresearch, repeated optimization experiments, or an overnight research run; ordinary edits do not authorize an experiment loop.
---

# Autoresearch

Adapted from [Andrej Karpathy’s autoresearch](https://github.com/karpathy/autoresearch): change a candidate, measure it against a fixed evaluator, keep improvements, and learn from rejected trials.

## Agree on the run

Before running even a baseline, record the following in `run.md` under the session scratchpad and obtain approval for anything not already authorized:

- An unused run tag and branch, an approved committed base, and the repository’s worktree/setup procedure.
- Exact modifiable paths and frozen inputs: evaluator, metric extraction, tests, ground truth, dependencies, and configuration. Resolve symlinks; modifiable paths must not escape the isolated workspace.
- The evaluation command, correctness checks, metric direction, acceptance threshold, and any tie-break rule. For noisy metrics, fix seeds and a repeat/aggregation policy before comparing candidates.
- A finite iteration or elapsed-time limit, per-trial timeout, bounded retries, and a spending cap if calls cost money. An overnight request is not permission to run forever or spend without a limit.
- Permitted side effects and outputs, process cleanup, and any required credentials. Use scoped secret injection; never record secret values in logs or the run manifest.

Existing experiment pauses remain in force. This skill does not authorize paid/live model calls, new dependencies, publishing, merging, or writes to production/shared systems. Ask before widening the approved scope.

## Isolate and establish the baseline

1. Create a dedicated run worktree and branch from the approved committed base. Do not stash, reset, or silently omit someone else’s uncommitted target work; obtain an approved baseline first. Follow repository-specific setup rules. Where plain Git worktrees are supported, with `RUN_BRANCH`, `RUN_DIR`, and `BASE` chosen above:

   ```sh
   git worktree add -b "$RUN_BRANCH" "$RUN_DIR/worktree" "$BASE"
   ```

2. Keep `run.md`, `results.tsv`, patches, and per-trial logs in the private run directory, outside the worktree. Start from a clean index and worktree. Record the initial commit and frozen-input identities.
3. Agent/model evaluations need private writable configuration as well as isolated workspaces and transcripts. `--no-session` alone is not isolation. Use the existing isolated runner, such as `pi-model-eval` when applicable; never disable live retry/compaction settings or save and restore shared configuration around trials. Isolation of files is not a sandbox for untrusted extensions or programs.
4. Run the approved baseline unchanged. Require successful checks and a finite, parseable metric; record it as the initial best result. If setup, credentials, or the evaluator fail, stop rather than changing frozen files or pretending the failure is a score.

## Experiment loop

Continue without asking after every trial, but only within the approved limits. At each iteration:

1. Check the stop conditions and resource-pressure controls. Do not bypass blocked subagents or background execution. Verify the run branch, expected HEAD, clean index/worktree, and unchanged frozen inputs; stop on unexpected changes or another actor’s work.
2. State one hypothesis. Change only allowed paths, inspect the diff, and stage those paths explicitly. Create a **new Conventional Commit** with a substantive body and runtime-generated attribution. Record its SHA as the candidate; never amend or rewrite earlier trials.
3. Run the fixed evaluator and correctness checks with logs outside the worktree. Bound the trial by the remaining time/spending budget; do not start one that cannot fit. Apply the agreed timeout to this trial’s processes only. Check that evaluation did not alter tracked inputs or leave unexpected untracked files; stop and retain evidence if isolation was violated.
4. Treat a failed check, timeout, missing metric, NaN, or infinity as a failed trial, not numeric zero. Record `NA` for an unavailable metric. Infrastructure failures pause the run; ordinary candidate failures may continue within the retry/failure budget.
5. **Keep:** only when correctness passes and the pre-agreed acceptance rule holds. Record the candidate SHA and metric as the new best. Prefer simpler changes within the agreed tie-break rule, not by changing the scoring rule afterward.
6. **Reject:** first save the candidate diff, logs, and reason. Only if HEAD is still this run’s candidate and the index/worktree are clean, undo that candidate with:

   ```sh
   git revert --no-commit "$CANDIDATE"
   ```

   Inspect the inverse diff, then create a new attributed Conventional Commit explaining the rejection and naming the candidate SHA. Confirm its tree matches the last accepted tree before the next trial. Stop on conflicts or unexpected changes; never use a hard reset, broad clean, or forced worktree removal to recover.
7. Append the outcome to `results.tsv` and update `run.md` with the best accepted SHA/metric and current branch HEAD. Accepted and rejected trials remain traceable without rewriting history.

Do not repair or optimize the evaluator during the run. If it must change, end this run, get approval, and establish a new baseline. A model judging its own work is exploratory evidence, not independent validation; require the agreed external checks before claiming an improvement.

## Record and finish

Use one TSV row per evaluation. Record the evaluated candidate SHA, not the subsequent rejection commit:

```text
trial	candidate_sha	metric	status	description
0	<base-sha>	0.42	baseline	Unchanged baseline
1	<candidate-sha>	0.39	keep	Lower is better; correctness passed
2	<candidate-sha>	NA	failed	Trial timed out; candidate reverted
```

Stop at the agreed limit, on user cancellation, exhausted retries, unsafe resource conditions, or a scope/ownership/isolation problem. Terminate only processes owned by this run. Do not turn a pause into an unapproved repair project.

Send Josh the baseline versus best result, validation limits, best accepted SHA, patch against the original base, and artifact paths through Agent Mail. Preserve failed-trial evidence. Integration, publication, and cleanup are separate actions subject to the usual permissions; do not automatically merge the experimental branch or delete its worktree. A resumed run must recheck its contract, remaining budget, and actual Git state before continuing.
