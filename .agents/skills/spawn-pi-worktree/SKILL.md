---
name: spawn-pi-worktree
description: Launch an isolated Pi session in a prepared git worktree and detached tmux window. Use when asked to fan out tasks, run parallel agents, create one agent per issue, or test work across multiple repositories.
---

# Spawn Pi Worktrees

Prepare one worktree per task, then run `spawn-pi-worktree` to start Pi there. Repository-specific guidance owns worktree creation and setup; this skill owns process launch.

## Prepare

1. Read the task, repository instructions, and project-local Pi configuration.
2. Load an available repository-specific worktree skill when one applies.
3. Otherwise choose an explicit base ref and create a native worktree:

   ```sh
   git status --short
   git worktree list
   git worktree add -b <branch> /absolute/path/to/<repo>-<task> <base-ref>
   ```

4. Run the repository's setup and verification. Confirm the new top-level path and branch, and that the worktree is distinct from the coordinator's checkout.
5. Find the target tmux session with `tmux display-message -p '#S'` or `tmux list-sessions`. Creating a tmux session is outside this skill.
6. Write a reviewed prompt containing the task source, scope, acceptance checks, branch, and whether the child may commit, open a pull request, or take other external actions.

## Launch

Dry-run the first task. This prints the worktree root, branch, resolved Pi executable, and tmux command:

```sh
spawn-pi-worktree --dry-run --tmux-session <session> --title <task> \
  --cwd /absolute/worktree/path --prompt "<reviewed prompt>"
```

By default Pi performs its normal project-trust check. After inspecting and trusting project-local files, pass `--approve` for an unattended launch:

```sh
spawn-pi-worktree --approve --tmux-session <session> --title <task> \
  --cwd /absolute/worktree/path --prompt "<reviewed prompt>"
```

The launcher rejects duplicate window titles and elevated macOS memory pressure. Launch tasks separately, then verify the exact window:

```sh
tmux list-windows -t <session> -F '#S:#I:#W #{pane_current_path} #{pane_current_command}'
tmux capture-pane -pt <session>:<task> -S -80
```

## Boundaries

- One task gets one branch, worktree, Pi session, and newly created tmux window.
- Do not rename existing tmux windows or make the child rediscover its worktree.
- Do not relaunch several identical failures. Preserve their panes and diagnose the shared cause.
- The child owns work it authors. A coordinator may inspect it, but does not silently rewrite its branch or human-facing artifacts.
- Cleanup is deliberate: confirm the child is finished and its work is preserved before removing its worktree or branch.
