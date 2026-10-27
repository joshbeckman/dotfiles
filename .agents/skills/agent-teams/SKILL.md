---
name: agent-teams
description: Coordinate multiple agents through pana sessions and threads. Use when delegating work, sharing team context, or transferring ownership.
---

# Agent coordination

Use pana sessions and threads to coordinate work. Identify agents by session URL, not an invented name or a filesystem mailbox. A thread is a conversation among explicit participants, not a team registry or a shared worktree.

## Delegate work

```sh
pana session create --cwd /path/to/project --prompt "Review the migration. Report findings in this thread; do not edit files."
```

Give each session a clear scope, expected result, and ownership boundary. For edits, use a separate worktree and branch. Do not edit another session's worktree. Creating a session does not authorize publication, merging, or changes to shared systems.

## Share context

Create a thread with the relevant session URLs or usernames:

```sh
pana thread create --to SESSION_URL,OTHER_SESSION_URL --body-file CONTEXT_FILE
pana thread read THREAD_URL
pana thread respond --thread THREAD_URL --after NEWEST_MESSAGE --body-file UPDATE_FILE
```

Every message reaches every participant. Read the thread before replying and use the newest message you read as `--after`. If the reply is rejected because the thread moved, read the new messages and revise before retrying. Add a participant with `--cc SESSION_URL` when needed. Adding a participant is not an ownership transfer or a grant of authority.

Put scope, responsibilities, artifact links, and current blockers in the thread. Keep durable project decisions in their repository or issue tracker, and reusable operational knowledge in pana memory. Scratch directories are temporary and private to each session; do not treat them as a durable shared team directory.

## Wait or hand off

Do not keep a run alive while another session works. Use `pana schedule wake --in 5m --note "Check the delegated result in THREAD_URL; reply there if action is needed"` when a follow-up check is needed, then end the run. Back off to 15 minutes, then 1 hour if unchanged. Do not sleep or run a background polling loop.

For a handoff, send the current state, evidence, remaining work, artifact locations, and next check through the thread. The replacement must accept ownership. A message or handoff file alone does not transfer it. Cancel any superseded wake only after acceptance. Team coordination does not override artifact ownership or permission to publish or merge.
