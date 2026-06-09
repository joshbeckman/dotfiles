---
name: get-pr-merged
description: Enqueue and monitor a pull request until it merges, including merge-queue failures. Use when the user asks to get a PR merged, re-enqueue a PR, babysit Graphite or Merge Garden, or run a merge loop.
disable-model-invocation: true
argument-hint: "PR URL or current branch PR"
---

# Get PR Merged

Run a loop until the PR is merged or blocked on a decision only Josh can make.

This skill assumes the user has asked to merge the PR. That is permission to post `/merge`, monitor bot comments, fix merge blockers, push updates, and re-enqueue when needed.

## Observed patterns

Recent merged PRs showed two common paths:

- Graphite accepted `/merge`, hit an unexpected git error, required rebasing and resubmitting, then merged after another `/merge`.
- Merge Garden accepted `/merge`, added `mergeit` and `mg-merge`, then merged and deleted the branch.

## Start

1. Identify the PR URL from arguments, `gh pr status`, or the current branch.
2. View it with `gh view-md PR_URL --max-diff 1000`. If Ruby gems are broken, run:

```sh
ruby --disable=gems ~/.local/share/gh/extensions/gh-view-md/gh-view-md PR_URL --max-diff 1000
```

3. Check state and local changes:

```sh
gh pr view PR_URL --json state,mergedAt,mergeCommit,url,reviewDecision,mergeStateStatus,statusCheckRollup
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

Post `/merge` as a PR comment using a body file:

```sh
printf '/merge\n\nGenerated-by: AI (Pi/OpenAI/GPT-5.5)\n' > /tmp/merge-comment.md
gh issue comment PR_URL --body-file /tmp/merge-comment.md
```

Then re-read the timeline. Look for `merge-garden`, `merge-garden[bot]`, `graphite-app`, `graphite-app[bot]`, `github-actions[bot]`, or `test-oversight-service[bot]`.

## Monitor loop

Repeat until merged:

1. Re-read PR state:

```sh
gh pr view PR_URL --json state,mergedAt,mergeCommit,headRefName,labels,statusCheckRollup,reviewDecision,mergeStateStatus
```

2. Re-read timeline with `gh view-md`. Bot comments are the source of truth because Graphite edits a single "Merge activity" comment over time.
3. Classify the latest queue state and act:
   - **Merged:** stop when `mergedAt` is non-null or the timeline says merged by Graphite or Merge Garden.
   - **Queued or CI running:** keep polling. Do not post `/merge` again.
   - **Missing approval, failed CI, unresolved review, or stale branch:** use `get-pr-green`, fix the blocker, push, then re-enqueue.
   - **Graphite unexpected git error:** rebase or restack, push, then post `/merge` again.
   - **Merge-queue draft PR CI failure:** open the draft PR or CI link from the bot comment, fix the original branch, rerun CI, then re-enqueue.
   - **Merge Garden rejection:** follow the bot reason. If labels were removed, fix the blocker before re-enqueueing.
4. Sleep 2-5 minutes while queued or CI is running; poll sooner after pushing fixes.

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
