# Repository Hosting Workflow

## Discover before routing

Run `git pr-host` in the intended checkout before PR commands. It reports the owning host, repository, selected client, and supported capabilities. Use the same classifier for URL selectors; neither `/pull/` nor `/pulls/` alone identifies a service. A mirror is not the PR authority.

Use `git pr-view`, `git pr-url`, `git pr-checks`, `git pr-merged`, and `git pr-for-commit` for provider-neutral reads. Use `git pr-write <verb> ...` for attributed PR create/edit/comment/review writes. Use `git-pr-host --help` and `git-pr-write --help` for interface usage (Git reserves `git <command> --help` for manual pages); load the owning repository's current workflow before CI, review, merge, or deployment actions. Repository instructions override generic examples here.

Repository-specific hosts, adapter selection, and live documentation links belong in supported machine-local setup, never shared public instructions. Do not change Git configuration when the repository forbids it. A failed discovery, unsupported capability, or missing tool is a blocker, not permission to fall back to a mirror or another identity.

Issue operations use the issue system's owning tool. GitHub issue reads and writes still use `gw`. Keep new PRs draft and assign the repository's verified review owner; provider-specific assignee syntax comes from the selected client's help.

## References

Reference every issue or pull request with its title and full URL:

```markdown
[<issue_or_pr_title>](<issue_or_pr_url>)
```

## Attribution

The write interface uses the selected adapter's attribution wrapper. Conversational prose carries the generated trailer and a blockquote; maintained artifacts append the trailer. Preserve other authors' attribution and suppress only the current exact duplicate. Use only the generated trailer; never add a separate `Session:` field or repeat the session URL.

Supply an explicit `--body` or `--body-file` for prose and agent attachment writes. If an adapter generates descriptions implicitly or cannot attribute a low-level mutation, stop and use its supported explicit-body workflow. Human body bytes remain unchanged. Do not post an approval again to edit its prose; first establish a supported edit path.

## Pull Request Ownership

Creating or inheriting a PR starts lifecycle ownership through deployment and proof, unless Josh explicitly releases or transfers it. Ownership grants no merge authority. Follow `own-pr` and the owning repository's workflow.
