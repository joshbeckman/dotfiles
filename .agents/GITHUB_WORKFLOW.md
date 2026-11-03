# GitHub Workflow

## Commands

Use the PR surface owned by the repository, not a mirror or a URL path guess:

- GitHub: `gw` for reads and attributed PR/issue writes.
- Delta: `dt` for native reads and `dtw` for attributed PR create/edit/comment/review writes. Load the repository's current instructions and live Delta skill from the verified origin before work. Discover flags with `dt <command> --help`.
- Legacy Gitstream: `gsw` for attributed writes only where the owner still explicitly supports that service. Never send Delta writes to it.

Use the `pr-lookup` skill for cross-provider PR reads, `gw view-md` for GitHub issue reads, and the issue system's owning tool for other issue operations. Machine-specific hosts, repositories, and provider configuration belong in supported local setup, not shared instructions. Do not change Git configuration when the repository forbids it.

Assign a Delta PR with `dtw pr edit <PR> --add-assignee <verified-identity>`; on GitHub use `gw pr edit <PR> --add-assignee @me`. Keep new PRs draft. `dtw` accepts explicit `--body`/`--body-file`, including stdin. Agent attachment writes require an explicit body; the wrapper refuses implicit agent `submit` descriptions. Push through the repository-supported Git remote, then use `dtw pr create/edit` with a body instead. Do not install or redirect native tools to another host to work around a failure.

## References

Reference every issue or pull request with its title and full URL:

```markdown
[<issue_or_pr_title>](<issue_or_pr_url>)
```

## Comments

Write GitHub comments to a temporary file, then pass it with `gw issue comment ISSUE_OR_PR_URL --body-file TMP_FILE`.

When a comment mixes Josh's words with an agent response, write Josh's words normally, put the agent response in a blockquote, and place `agent-trailer` immediately before or after that quote.

## Attribution

**Attribution is automatic on the paths that matter, and you must not duplicate it.** For conversational prose, `gw`, `dtw`, and `gsw` put the trailer first and blockquote the agent's response. This covers PR and issue comments, reviews, and close or reopen comments. For maintained artifacts such as PR descriptions and issue bodies, the wrappers append the trailer without blockquoting. Commits get the same line with an email. The wrappers suppress an exact duplicate of the current trailer; when another agent already has a trailer, they preserve it and add the current editor's attribution. Post PR prose through the provider's wrapper (`gw`, `dtw`, or `gsw`), not the bare native command. Read-only commands and human invocations do not acquire agent attribution. Use only the generated trailer for attribution; do not append a separate `Session:` field or repeat the session URL.

## Pull Request Ownership

If you create or inherit a pull request, you own it until the change is deployed and its production result is checked, unless Josh explicitly releases or transfers ownership. Ownership does not grant permission to mark ready, enqueue, merge, or re-enqueue without Josh's instruction. The `own-pr` skill carries the lifecycle; read it before touching a PR.
