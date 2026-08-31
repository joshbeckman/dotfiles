---
name: own-pr
description: Owns an agent-authored pull request from draft through CI, review, merge queue, deployment, and production proof. Use whenever the agent creates or inherits a PR, resumes work with an open PR, or is asked to monitor, shepherd, or follow through on a PR.
argument-hint: "PR URL or current branch PR"
---

# Own a Pull Request

Opening a PR starts the ownership loop. It does not finish the task. Unless Josh explicitly releases or transfers ownership, remain responsible until the merged change is deployed and its production result is checked.

## Record ownership

Keep the PR URL in the session scratchpad so a resumed or replacement session can find it. Before winding down, transfer any incomplete PR to another live agent with `agent-mail` and a handoff; a handoff file alone does not transfer ownership.

Always read the PR with `gw view-md`. Use `gw pr-checks PR_URL --required` for checks and structured `gw pr view` fields for state. Poll the PR itself; do not rely on Josh to relay GitHub notifications.

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

1. Get the merge commit and continue polling the repository's current deployment-status surface. Do not assume merged means deployed.
2. If no supported deployment signal can be found, tell Josh what you checked instead of claiming deployment.
3. Once deployed, inspect the production evidence appropriate to the change: metrics, logs, behavior, rollout state, or another direct check.
4. Message Josh with the deployment state and concise proof. Report regressions immediately and own the follow-up.

Only then is the PR lifecycle complete and its clean worktree eligible for cleanup, provided no other assigned or open work remains.

## Polling cadence

Poll active CI or merge queues every 2-5 minutes. Poll human review less often, but keep monitoring until ownership is transferred or complete. If the session cannot remain active, mail a replacement agent and leave a handoff that names the PR, current phase, latest head SHA, known blockers, and next check time. Do not stop until the replacement acknowledges ownership.
