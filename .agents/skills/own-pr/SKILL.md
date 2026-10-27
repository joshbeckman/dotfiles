---
name: own-pr
description: Owns an agent-authored pull request from draft through CI, review, merge queue, deployment, and production proof. Use whenever the agent creates or inherits a PR, resumes work with an open PR, or is asked to monitor, shepherd, or follow through on a PR.
argument-hint: "PR URL or current branch PR"
---

# Own a Pull Request

Opening a PR starts the ownership loop. It does not finish the task. Unless Josh explicitly releases or transfers ownership, remain responsible until the merged change is deployed and its production result is checked.

## Record ownership

Create a PR checklist in your pana scratch directory. Update it after every state transition and before ending a run or handing off. Record the pana thread for updates so scheduled wakeups know where to reply.

```markdown
# [PR title](full URL)

- Phase: draft | Josh review | human review | merge queue | deployment | proof | complete
- Head SHA:
- Last checked:
- Next check:
- Update thread:
- Pending wake schedule:
- [ ] Draft opened and Josh assigned
- [ ] PR linked from every issue it solves
- [ ] CI and automated reviews passed
- [ ] Josh reviewed; reviewer preference recorded
- [ ] Human comments resolved and approvals complete
- [ ] Material feedback decisions and revisions confirmed with Josh, if any
- [ ] Merged
- [ ] Deployed
- [ ] Production proof sent to Josh

## Reviewer candidates
## Open comments, failures, or conflicts
## Deployment and production evidence
```

This checklist is an ephemeral execution log, not a second project tracker. When `run-project` applies, native issue state remains the durable source of project progress; do not copy this checklist into the root issue.

Before ending a run with an incomplete PR, schedule the next check with `pana schedule wake` as described below, or transfer ownership to another session through a pana thread with this checklist. A handoff file alone does not transfer ownership; the replacement must accept it.

`own-pr` owns lifecycle state and transitions. Use `pr-description-discipline` for the body, `binks-pr-review` for applicable local preflight, `get-pr-green` for CI/review repair, `get-pr-merged` only after explicit merge authority, and `run-project` for project metadata. None releases lifecycle ownership.

Use the PR surface required by the repository. For GitHub writes, use `gw`; for Meteorite/Gitstream writes, use `gsw` (`gsw pr create`, `gsw pr edit`, `gsw pr comment`, `gsw pr review`, or `gsw submit`). Load `pr-lookup` for cross-provider PR content, URL, commit, checks, and merge-status reads; continue using `gw view-md` for GitHub issues. Poll the PR itself; do not rely on Josh to relay notifications.

## 1. Draft and validate

1. Open the PR as a draft and assign Josh using the repository's required wrapper.
2. After the PR has a stable URL, comment on every issue it claims to solve. The comment must say that work has opened and link the PR by its full title and URL, so issue readers can find current and historical implementation work. Write the comment to a scratchpad file and post it with `gw issue comment ISSUE_URL --body-file FILE`. Do not duplicate an existing link, comment on issues listed only as related context, or expose a private PR from a more-public issue. If visibility is unclear, ask Josh first.
3. When inheriting a PR, read each source issue with `gw view-md`; backfill a missing PR comment before continuing.
4. Trigger required CI and repository-required automated reviews.
5. Check CI, the conversation, review threads, and mergeability. A green check summary alone is insufficient. Schedule the next check with `pana schedule wake` when waiting on external progress.
6. Diagnose failures, answer every comment, push fixes, rerun affected checks/reviews, and continue until clean. Update the checklist after handling each change.
7. Rebase when the branch conflicts with or is too stale against its base. Resolve only mechanical conflicts autonomously; ask about product or risky conflicts.

## 2. Ask Josh to review

Only after CI and automated reviews pass, send Josh:

- the PR title and full URL;
- the evidence that it is green;
- three proposed high-context human reviewers, each with a brief reason.

Choose candidates from ownership files, blame/history of the changed code, and recent related PRs. Do not optimize for availability alone.

Do not mark the PR ready or request human review yet. Josh may comment, request changes, choose reviewers, or mark it ready himself. Continue the loop after every change.

## 3. Human review

Once Josh marks the PR ready or explicitly asks you to do so:

1. Request review from Josh's preferred reviewers; otherwise use the proposed candidates he accepted.
2. Poll for comments, submitted reviews, new conflicts, and check regressions.
3. Respond to every thread. Proceed autonomously on corrections and mechanical fixes that preserve the approved direction. Fix and push, or explain why you decline. Resolve addressed threads and re-request review when the platform requires it.
4. Do not silently accept feedback that materially changes behavior, scope, architecture, interfaces, data handling, rollout, user experience, or the PR's accepted risk and tradeoffs. Before editing, message Josh with the feedback link, what would change, the viable options, and your recommendation; wait for his direction.
5. After a material revision, message Josh with the new head SHA and a concise before/after summary, then ask him to review the revised direction. Do this even when the reviewer request seemed unambiguous or the implementation is already green.
6. Return to Josh when reviewers disagree or any decision requires product, design, security, operational, or prioritization judgment.

## 4. Merge queue

Never enqueue or merge without explicit permission. If Josh enqueues the PR, monitor it until merged:

- Keep polling queue state, bot comments, checks, conflicts, and staleness.
- Fix CI failures and mechanical conflicts, then tell Josh what changed and ask him to re-enqueue unless he already authorized you to do so.
- Do not treat queue acceptance as success; an ejection or stale branch reopens the loop.

Use the `get-pr-merged` skill when Josh explicitly delegates enqueueing and re-enqueueing.

## 5. Deployment and proof

After merge:

1. Get the merge commit.
2. Use `verify-conveyor-deployment` when available; it is the source of truth for Conveyor commands, help-first checks, unsupported repositories, affected zones, and commit-ancestry fallback. For other deployment systems, use the repository's supported status surface or ask Josh when none exists.
3. Check deployment directly. If it is pending, schedule another check with `pana schedule wake` and end the run. Start with 30 minutes between deployment checks and back off when unchanged. Do not assume merged means deployed.
4. Once deployed, inspect the production evidence appropriate to the change: metrics, logs, behavior, rollout state, or another direct check.
5. Message Josh with the deployment state and concise proof. Report regressions immediately and own the follow-up.

Only then is the PR lifecycle complete. Mark the checklist complete and cancel any pending wake for this PR with `pana schedule delete SCHEDULE`. The clean worktree is then eligible for cleanup, provided no other assigned or open work remains.

## Scheduled checks

Never wait inside a run for CI, reviews, the merge queue, deployment, or another session. Check the current state once, record it, schedule a wake, and end the run. Do not use sleep loops, background watchers, or repeated conversational polling.

```sh
pana schedule wake --in 5m --note "Check PR_URL: CI, reviews, queue, and conflicts; update CHECKLIST_PATH. Reply in THREAD_URL with new results or a blocker. If still pending, schedule another wake and end the run."
```

Use real URLs and paths in the note. Include the current phase, head SHA, known blockers, and the specific next check. A wake resumes the session; it does not itself check the PR or post the run's final response. On wake, read the update thread, check the PR, and use `pana thread respond --thread THREAD_URL --after NEWEST_MESSAGE --body-file UPDATE_FILE` when there is new information to report.

Start active CI or merge-queue checks at 5 minutes. If unchanged, back off to 15 minutes, then 1 hour. Start deployment checks at 30 minutes and human-review checks less often; back off when unchanged. Check sooner after pushing a fix when useful, but schedule the wait rather than staying in a loop.

Keep at most one pending wake for this PR. Use `pana schedule list --kind wake` to find it and `pana schedule delete SCHEDULE` to cancel it when replacing it, completing the work, or handing ownership to another session. Record the schedule ID and next check time in the checklist. If scheduling fails, report the exact error and the uncovered next check; do not silently drop ownership.

Keep monitoring until ownership is transferred or complete. For a transfer, send the checklist and current context through a pana thread and obtain the replacement's acceptance before canceling your wake. Shared memory can retain durable decisions, but neither memory nor a handoff file transfers ownership by itself.
