---
name: own-pr
description: Owns an agent-authored pull request from draft through CI, review, merge queue, deployment, and production proof. Use whenever the agent creates or inherits a PR, resumes work with an open PR, or is asked to monitor, shepherd, or follow through on a PR.
argument-hint: "PR URL or current branch PR"
---

# Own a Pull Request

Opening a PR starts the ownership loop. It does not finish the task. Unless Josh explicitly releases or transfers ownership, remain responsible until the merged change is deployed and its production result is checked.

## Record ownership

Create `$AGENT_SCRATCHPAD/prs/<owner>-<repo>-<number>.md` when the PR opens. Update it after every state transition and before sleeping or handing off:

```markdown
# [PR title](full URL)

- Phase: draft | Josh review | human review | merge queue | deployment | proof | complete
- Head SHA:
- Last checked:
- Next check:
- [ ] Draft opened and Josh assigned
- [ ] CI and automated reviews passed
- [ ] Josh reviewed; reviewer preference recorded
- [ ] Human comments resolved and approvals complete
- [ ] Merged
- [ ] Deployed
- [ ] Production proof sent to Josh

## Reviewer candidates
## Open comments, failures, or conflicts
## Deployment and production evidence
```

Before winding down, transfer any incomplete PR to another live agent with `agent-mail` and this checklist; a handoff file alone does not transfer ownership.

Use the PR surface required by the repository. For GitHub writes, use `gw`; for Meteorite/Gitstream writes, use `gsw` (`gsw pr create`, `gsw pr edit`, `gsw pr comment`, `gsw pr review`, or `gsw submit`). Continue using `gw view-md` for reads and `gw pr-checks PR_URL --required` for checks as required by the global instructions. Poll the PR itself; do not rely on Josh to relay notifications.

## 1. Draft and validate

1. Open the PR as a draft and assign Josh using the repository's required wrapper.
2. Trigger required CI and repository-required automated reviews.
3. Poll checks, the conversation, review threads, and mergeability. A green check summary alone is insufficient.
4. Diagnose failures, answer every comment, push fixes, rerun affected checks/reviews, and continue until clean.
5. Rebase when the branch conflicts with or is too stale against its base. Resolve only mechanical conflicts autonomously; ask about product or risky conflicts.

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
3. Respond to every thread. Fix and push, or explain why you decline. Resolve addressed threads and re-request review when the platform requires it.
4. Return to Josh when a decision requires product judgment or reviewers disagree.

## 4. Merge queue

Never enqueue or merge without explicit permission. If Josh enqueues the PR, monitor it until merged:

- Keep polling queue state, bot comments, checks, conflicts, and staleness.
- Fix CI failures and mechanical conflicts, then tell Josh what changed and ask him to re-enqueue unless he already authorized you to do so.
- Do not treat queue acceptance as success; an ejection or stale branch reopens the loop.

Use the `get-pr-merged` skill when Josh explicitly delegates enqueueing and re-enqueueing.

## 5. Deployment and proof

After merge:

1. Get the merge commit. Read the private work-environment tooling guidance for the repository's current deployment command and run that command's `--help` before first use; deployment interfaces change.
2. Poll deployment every 30 minutes. Do not assume merged means deployed.
3. If the status command is inconclusive and the repository is not served by the deployment system, ask Josh to confirm deployment.
4. Otherwise determine the affected deployment unit, query its currently deployed commit, and prove the PR merge commit is its ancestor. SHA equality is too strict because later commits may already be deployed.
5. Once deployed, inspect the production evidence appropriate to the change: metrics, logs, behavior, rollout state, or another direct check.
6. Message Josh with the deployment state and concise proof. Report regressions immediately and own the follow-up.

Only then is the PR lifecycle complete and its clean worktree eligible for cleanup, provided no other assigned or open work remains.

## Polling cadence

Poll active CI or merge queues every 2-5 minutes, deployment every 30 minutes, and human review less often. Keep monitoring until ownership is transferred or complete. If the session cannot remain active, mail a replacement agent and leave the PR checklist with the current phase, latest head SHA, known blockers, and next check time. Do not stop until the replacement acknowledges ownership.
