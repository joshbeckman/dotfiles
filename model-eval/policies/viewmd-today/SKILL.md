---
name: read-github-context
description: Read a GitHub issue or pull request when a task needs its body, discussion, reviews, or patch.
---

# Reading GitHub context

Read a GitHub issue or pull request with `bin/gw view-md <url>`. It renders the whole item as markdown for an agent to read: body, discussion, reviews, and the patch.

Use it before answering anything about an issue or pull request. One call returns everything a reader needs, so do not split the read.
