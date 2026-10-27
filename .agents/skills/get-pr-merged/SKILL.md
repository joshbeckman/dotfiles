---
name: get-pr-merged
description: Enqueue and monitor a pull request until it merges, including merge-queue failures. Use when the user asks to get a PR merged, re-enqueue a PR, babysit Merge Garden, or run a merge loop.
disable-model-invocation: true
argument-hint: "PR URL or current branch PR"
---

# Get PR Merged

Run a loop until the PR is merged or blocked on a decision only Josh can make.

This skill assumes the user has asked to merge the PR. That is permission to post `/merge`, monitor bot comments, fix merge blockers, push updates, and re-enqueue when needed.

## Observed patterns

Recent merged PRs showed Merge Garden accepting `/merge`, adding `mergeit` and `mg-merge`, then merging and deleting the branch.

## Start

1. Identify the PR URL from arguments, `gw pr status`, or the current branch.
2. Read the full PR and discussion with `git pr-view PR_URL`.
3. Check state and local changes:

```sh
gw pr view PR_URL --json state,mergedAt,mergeCommit,url,reviewDecision,mergeStateStatus,statusCheckRollup
git status --short
```

Do not overwrite unrelated local changes.

## Preconditions

Before enqueueing, make sure the PR is mergeable:

- Required human approval is present.
- Required CI is green or in progress.
- Required review threads are answered and resolved.
- The branch is up to date enough for the merge queue to accept it.

If any precondition is missing, switch into the `get-pr-green` workflow first. Return here once CI and review are satisfied.

## Enqueue

Post `/merge` through the repository's required write surface:

```sh
# Meteorite/Gitstream-managed repository
gsw pr comment PR_URL --body '/merge'

# Other GitHub repository
gw issue comment PR_URL --body '/merge'
```

Then re-read the timeline. Look for `merge-garden`, `merge-garden[bot]`, `github-actions[bot]`, or `test-oversight-service[bot]`.

## Monitor loop

On each run or scheduled wake, check once. Continue across scheduled wakes until merged:

1. Re-read PR state:

```sh
gw pr view PR_URL --json state,mergedAt,mergeCommit,headRefName,labels,statusCheckRollup,reviewDecision,mergeStateStatus
```

2. Re-read the timeline with `git pr-view PR_URL`. Bot comments are the source of truth for queue transitions.
3. Classify the latest queue state and act:
   - **Merged:** stop when `mergedAt` is non-null or the timeline says Merge Garden merged it.
   - **Queued or CI running:** schedule the next check. Do not post `/merge` again.
   - **Missing approval, failed CI, unresolved review, or stale branch:** use `get-pr-green`, fix the blocker, push, then re-enqueue.
   - **Merge-queue draft PR CI failure:** open the draft PR or CI link from the bot comment, fix the original branch, rerun CI, then re-enqueue.
   - **Merge Garden rejection:** follow the bot reason. If labels were removed, fix the blocker before re-enqueueing.
4. If still queued or CI is running, use `pana schedule wake` and end the run. Follow `own-pr` for the checklist, reply thread, schedule cleanup, and backoff: start at 5 minutes, then 15 minutes, then 1 hour when unchanged. Do not sleep, run a background watcher, or poll in a loop. Include the PR URL, checklist path, current queue state, and reply thread in the wake note. On wake, check again and reply through pana when there is new information.

## Re-enqueue rules

Post `/merge` again only when one of these is true:

- A bot explicitly says to resubmit, rebase, retry, or re-enqueue.
- You pushed a fix or rebase after a queue failure.
- Merge labels were removed and all known blockers are now clear.

Do not spam `/merge` while the PR is already queued or CI is actively running. If `mergeit` is repeatedly added and removed, inspect bot comments and checks instead of blindly retrying.

## Stop and ask Josh

Pause instead of guessing when:

- A human review asks for a product or design decision.
- The merge bot reports a policy or permission blocker you cannot satisfy locally.
- Fixing a queue failure would require risky code changes unrelated to the PR.
- The PR appears stuck for more than two queue cycles with no new bot detail.
