---
name: pr-lookup
description: Find and inspect pull requests across GitHub and Gitstream from commits, branches, numbers, or URLs. Use when asked which PR contains a commit, for the current branch's PR URL, whether a PR merged, or which checks are failing.
---

# Pull Request Lookups

Use the same read-only commands in GitHub and Gitstream repositories. They infer the provider from the PR URL or repository-local configuration.

| Need | Command |
|---|---|
| PR containing a commit | `git pr-for-commit <SHA>` |
| Canonical PR URL | `git pr-url [PR_URL\|PR_NUMBER\|BRANCH]` |
| Checks ordered for action | `git pr-checks [PR_URL\|PR_NUMBER\|BRANCH] [--required]` |
| Merge timestamp | `git pr-merged [PR_URL\|PR_NUMBER\|BRANCH]` |
| Full issue or PR content | `gw view-md <URL>` |

With no selector, URL, checks, and merge commands use the current branch. They exit nonzero when the PR cannot be established, checks fail, the PR is unmerged, or a result is ambiguous. Do not turn those failures into guesses.

`git pr-checks --required` limits output to required checks when the provider exposes that distinction. Use the full form when review and optional-check context matters.

Continue using `gw view-md` to read full issues and PRs. The Git commands above are compact status and identity lookups, not substitutes for reading relevant discussion before acting.

Repository-specific provider configuration belongs in local Git config, not this public skill:

```sh
git config prLookup.provider <provider>
git config prLookup.urlTemplate 'https://example.test/pulls/{number}'
```

A configured merge-trailer workflow for `git pr-for-commit` additionally uses `prLookup.trailer` and `prLookup.baseRef`.
