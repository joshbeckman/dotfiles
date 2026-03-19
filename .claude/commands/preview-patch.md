---
description: Preview a Commit, Diff, or Patch as HTML
allowed-tools: Bash(preview-patch:*), Bash(git show:*), Bash(git diff:*)
---

Please preview a commit, diff, or patch using the `preview-patch` command.

Do this by:
1. Determining what to preview based on context:
   - If you just created a commit, use that commit ref
   - If the user is discussing a specific commit, use that ref
   - If the user wants to see uncommitted changes, pipe `git diff` to `preview-patch`
   - Default to HEAD if unclear
2. Running one of:
   - `preview-patch <COMMIT_REF>` for a commit
   - `git diff | preview-patch` for uncommitted changes
   - `git diff --staged | preview-patch` for staged changes

Just run the command directly without explanation.
