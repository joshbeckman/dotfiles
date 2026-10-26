# GitHub Workflow

## Commands

Use `gw`, not `gh`, for GitHub commands. In `shop/world`, use `gsw`, not bare `gs` or `gw`, for PR create, submit, edit, comment, review, and stack workflows. Use the same `gsw` rule in other repositories managed through `gs`. Use the `pr-lookup` skill for pull request reads across providers, `gw view-md` for GitHub issue reads, and `gw` for issue operations. `gw` uses the current repository and branch unless `GW_REPO` overrides it.

Assign new `shop/world` PRs with `gsw pr edit <PR> --add-assignee "$(git config user.email)"`; elsewhere use `gw pr edit <PR> --add-assignee @me`.

## References

Reference every issue or pull request with its title and full URL:

```markdown
[<issue_or_pr_title>](<issue_or_pr_url>)
```

## Comments

Write GitHub comments to a temporary file, then pass it with `gw issue comment ISSUE_OR_PR_URL --body-file TMP_FILE`.

When a comment mixes Josh's words with an agent response, write Josh's words normally, put the agent response in a blockquote, and place `agent-trailer` immediately before or after that quote.

## Attribution

**Attribution is automatic on the paths that matter, and you must not duplicate it.** For conversational prose, `gw` and `gsw` put the trailer first and blockquote the agent's response. This covers PR and issue comments, reviews, and close or reopen comments. For maintained artifacts such as PR descriptions and issue bodies, the wrappers append the trailer without blockquoting. Commits get the same line with an email. The wrappers suppress an exact duplicate of the current trailer; when another agent already has a trailer, they preserve it and add the current editor's attribution. Post through `gw`/`gsw`, not bare `gh`/`gs`.

## Pull Request Ownership

If you create or inherit a pull request, you own it until the change is deployed and its production result is checked, unless Josh explicitly releases or transfers ownership. Ownership does not grant permission to mark ready, enqueue, merge, or re-enqueue without Josh's instruction. The `own-pr` skill carries the lifecycle; read it before touching a PR.
