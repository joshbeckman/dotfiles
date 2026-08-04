---
name: get-pr-merged
description: Enqueue and monitor a pull request until it merges, including merge-queue failures and PR staleness. Use when the user asks to get a PR merged, re-enqueue a PR, babysit Graphite or Merge Garden, or run a merge loop.
disable-model-invocation: true
argument-hint: "PR URL or current branch PR"
---

# Get PR Merged

Run a loop until the PR is merged or blocked on a decision only the user can make.

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
- The branch is fresh enough for the merge queue to accept it.

If any precondition is missing, switch into the `get-pr-green` workflow first. Return here once CI and review are satisfied.

## Staleness check

Run this before the first `/merge` and during each monitor loop. Shopify's freshness limit is based on commits behind the target branch. Treat `4000` commits behind as approaching the `5000` commit limit from the Slack reference.

```sh
STALE_COMMITS=$(gh pr-staleness PR_URL)
printf 'PR is %s commits behind target\n' "$STALE_COMMITS"
```

If `gh pr-staleness` is unavailable, use the compare API directly:

```sh
COMPARE_URL=$(gh pr view PR_URL --json headRefName,baseRefName,headRepositoryOwner,headRepository -q '"repos/\(.headRepositoryOwner.login)/\(.headRepository.name)/compare/\(.baseRefName)...\(.headRefName)"')
STALE_COMMITS=$(gh api "$COMPARE_URL" --jq '.behind_by')
```

If `STALE_COMMITS` is `4000` or greater, or a bot reports the PR is stale or failing freshness, rebase on the target branch, push to origin, then re-enqueue to merge-when-ready:

```sh
BASE_REF=$(gh pr view PR_URL --json baseRefName -q '.baseRefName')
HEAD_REF=$(gh pr view PR_URL --json headRefName -q '.headRefName')
git status --short
git fetch origin "$BASE_REF"
gh pr checkout PR_URL
git rebase "origin/$BASE_REF"
git push --force-with-lease origin "HEAD:$HEAD_REF"
```

Continue only if the worktree is clean or the changes are yours. Resolve only mechanical conflicts. If the rebase requires product or risky code decisions, stop and ask the user.

## Enqueue

Post `/merge` as a PR comment using a body file:

```sh
gh issue comment PR_URL --body '/merge'
```

Then re-read the timeline. Look for `merge-garden`, `merge-garden[bot]`, `graphite-app`, `graphite-app[bot]`, `github-actions[bot]`, or `test-oversight-service[bot]`.

## Monitor loop

Repeat until merged:

1. Re-read PR state:

```sh
gh pr view PR_URL --json state,mergedAt,mergeCommit,headRefName,baseRefName,labels,statusCheckRollup,reviewDecision,mergeStateStatus
```

2. Run the staleness check. If the PR is approaching the freshness limit, rebase on the target branch, push to origin, and re-enqueue.
3. Re-read timeline with `gh view-md`. Bot comments are the source of truth because Graphite edits a single "Merge activity" comment over time.
4. Classify the latest queue state and act:
   - **Merged:** stop when `mergedAt` is non-null or the timeline says merged by Graphite or Merge Garden.
   - **Queued or CI running:** keep polling. Do not post `/merge` again unless the staleness check required a rebase and push.
   - **Missing approval, failed CI, unresolved review, or stale branch:** use `get-pr-green`, fix the blocker, push, then re-enqueue.
   - **Graphite unexpected git error:** rebase or restack, push, then post `/merge` again.
   - **Merge-queue draft PR CI failure:** open the draft PR or CI link from the bot comment, fix the original branch, rerun CI, then re-enqueue.
   - **Merge Garden rejection:** follow the bot reason. If labels were removed, fix the blocker before re-enqueueing.
5. Sleep 2-5 minutes while queued or CI is running; poll sooner after pushing fixes.

## Re-enqueue rules

Post `/merge` again only when one of these is true:

- A bot explicitly says to resubmit, rebase, retry, or re-enqueue.
- You pushed a fix or rebase after a queue failure.
- You rebased because the staleness check was approaching the freshness limit.
- Merge labels were removed and all known blockers are now clear.

Do not spam `/merge` while the PR is already queued or CI is actively running. If `mergeit` is repeatedly added and removed, inspect bot comments and checks instead of blindly retrying.

## Stop and ask the user

Pause instead of guessing when:

- A human review asks for a product or design decision.
- The merge bot reports a policy or permission blocker you cannot satisfy locally.
- Fixing a queue failure would require risky code changes unrelated to the PR.
- The PR appears stuck for more than two queue cycles with no new bot detail.
