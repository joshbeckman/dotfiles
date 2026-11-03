# Repository Hosting Workflow

## Discover before routing

Run `git pr-cli` in the intended checkout before PR commands. It prints the selected installed client, preferring an existing attribution wrapper where available. Run that client's `--help`, then its subcommand help, to learn the native workflow. `git pr-host` provides the verified host/repository and lookup-helper capabilities when structured context is needed. A URL path alone does not identify a service; a mirror is not the PR authority.

Do not invent a common write grammar. Preserve the classified host/repository when using the selected client's native flags and follow the owning repository's current workflow for CI, review, merge, and deployment. Existing `git pr-view`, `git pr-url`, `git pr-checks`, `git pr-merged`, and `git pr-for-commit` remain optional provider-neutral read helpers. Use `git-pr-cli --help` and `git-pr-host --help` for chooser usage; Git reserves `git <command> --help` for manual pages.

Repository-specific hosts, adapter selection, and live documentation links belong in supported machine-local setup, never shared public instructions. Do not change Git configuration when the repository forbids it. A failed discovery, unsupported capability, or missing tool is a blocker, not permission to fall back to a mirror or another identity.

Issue operations use the issue system's owning tool. GitHub issue reads and writes still use `gw`. Keep new PRs draft and assign the repository's verified review owner; provider-specific assignee syntax comes from the selected client's help.

## References

Reference every issue or pull request with its title and full URL:

```markdown
[<issue_or_pr_title>](<issue_or_pr_url>)
```

## Attribution

Use an existing attribution wrapper when it is selected. If the native client has no wrapper, follow the repository and harness's supported attribution path with an explicit body and the generated trailer. The chooser grants no write permission and does not add attribution or execute a command.

Preserve other authors' attribution and suppress only the current exact duplicate. Use only the generated trailer; never add a separate `Session:` field or repeat the session URL. Do not use implicit description generation or a low-level mutation to evade required attribution. Do not post an approval again to edit its prose; first establish a supported edit path.

## Pull Request Ownership

Creating or inheriting a PR starts lifecycle ownership through deployment and proof, unless Josh explicitly releases or transfers it. Ownership grants no merge authority. Follow `own-pr` and the owning repository's workflow.
