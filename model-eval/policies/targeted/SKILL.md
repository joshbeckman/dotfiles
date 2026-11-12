---
name: read-github-context
description: Read a GitHub issue or pull request when a task needs its body, discussion, reviews, or patch.
---

# Reading GitHub context

Read a GitHub issue or pull request with the narrowest command that answers the question.

- Body and discussion: `bin/gh pr view <number> --json title,body,comments,reviews,files`
- Issue body and discussion: `bin/gh issue view <number> --json title,body,comments`
- Patch: `bin/gh pr diff <number>`
- Review comments with the code each one points at: `bin/gh api repos/<owner>/<repo>/pulls/<number>/comments`

Add `--jq` to a command when you need one field of a large result.
