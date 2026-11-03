---
name: get-pr-merged
description: Enqueue and monitor a pull request until it merges, including merge-queue failures. Use when the user asks to get a PR merged, re-enqueue a PR, monitor a repository merge queue, or run a merge loop.
disable-model-invocation: true
argument-hint: "PR URL or current branch PR"
---

# Get PR Merged

Run a loop until the PR is merged or blocked on a decision only Josh can make.

This skill applies only after the user asks to merge that PR. Follow the owning repository's documented queue workflow for entrypoints, status transitions, CI, and re-enqueue behavior. The request does not authorize an undocumented bypass.

## Start

1. Run `git pr-cli` and inspect that client's native help; use `git pr-host` for structured target context, then identify the PR with `git pr-url`. Load the owning repository workflow; never infer the provider from URL path shape.
2. Read the full PR and discussion with `git pr-view PR_URL`.
3. Check state with `git pr-view PR_URL` and `git pr-checks PR_URL`; check local changes with `git status --short`. Use the selected adapter's help for additional structured state reads.

Do not overwrite unrelated local changes.

## Preconditions

Before enqueueing, make sure the PR is mergeable:

- Required human approval is present.
- Required CI is green or in progress.
- Required review threads are answered and resolved.
- The branch is up to date enough for the merge queue to accept it.

If any precondition is missing, switch into the `get-pr-green` workflow first. Return here once CI and review are satisfied.

## Enqueue

Use the queue entrypoint documented by the owning repository. Use the selected client's native documented syntax and required attribution path for its target-bound operation. Do not invent a universal comment, label, status producer, or queue state machine.

Do not substitute a direct merge when the repository requires a queue, or trigger CI/hosted reviews merely because generic guidance lists them. Read the queue's documented status surface and use `git pr-view` for supporting conversation context.

## Monitor loop

On each run or scheduled wake, check once. Continue across scheduled wakes until merged:

1. Re-read state and checks through `git pr-view`, `git pr-checks`, and `git pr-merged`; use the discovered adapter's documented structured reads when needed.

2. Re-read the timeline with `git pr-view PR_URL`. Interpret conversation events using the queue's documented status contract, not a fixed list of bot names or labels.
3. Classify the latest queue state and act:
   - **Merged:** stop when the provider reports a non-null merge timestamp (using the discovered adapter's documented field) or the timeline says the owning queue merged it.
   - **Queued or CI running:** schedule the next check. Do not enqueue again.
   - **Missing approval, failed CI, unresolved review, or stale branch:** use `get-pr-green`, fix the blocker, push, then re-enqueue.
   - **Merge-queue draft PR CI failure:** open the draft PR or CI link from the bot comment, fix the original branch, rerun CI, then re-enqueue.
   - **Queue rejection:** follow the bot reason. Fix the reported blocker before re-enqueueing.
4. If still queued or CI is running, use `pana schedule wake` and end the run. Follow `own-pr` for the checklist, reply thread, schedule cleanup, and backoff: start at 5 minutes, then 15 minutes, then 1 hour when unchanged. Do not sleep, run a background watcher, or poll in a loop. Include the PR URL, checklist path, current queue state, and reply thread in the wake note. On wake, check again and reply through pana when there is new information.

## Re-enqueue rules

Re-enqueue only when one of these is true:

- A bot explicitly says to resubmit, rebase, retry, or re-enqueue.
- You pushed a fix or rebase after a queue failure.
- The owning workflow reports that the PR left the queue and all known blockers are now clear.

Do not repeat the queue entrypoint while the PR is queued or CI is running. If state repeatedly changes without progress, inspect the documented queue surface and checks instead of blindly retrying.

## Stop and ask Josh

Pause instead of guessing when:

- A human review asks for a product or design decision.
- The merge bot reports a policy or permission blocker you cannot satisfy locally.
- Fixing a queue failure would require risky code changes unrelated to the PR.
- The PR appears stuck for more than two queue cycles with no new bot detail.
