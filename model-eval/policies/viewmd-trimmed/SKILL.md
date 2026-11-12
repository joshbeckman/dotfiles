---
name: read-github-context
description: Read a GitHub issue or pull request when a task needs its body, discussion, reviews, or patch.
---

# Reading GitHub context

Read a GitHub issue or pull request with `bin/gw view-md --max-diff 0 <url>`. It renders the body, discussion, and reviews as markdown and leaves the patch out.

Read the patch only when the question needs it: `bin/gh pr diff <number>`.
