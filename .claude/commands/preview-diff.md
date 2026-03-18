---
description: Preview Last Diff as styled HTML
allowed-tools: Bash(preview-diff:*) Bash(git diff*)
---

Please take the current git diff (staged and unstaged) and pass it to the `preview-diff` command for visual preview.

Do this by running: `git diff HEAD | preview-diff`

If there are no changes against HEAD, try `git diff` for unstaged changes, or `git diff --cached` for staged changes.

Just run the command directly without explanation.
