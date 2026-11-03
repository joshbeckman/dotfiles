---
name: pr-lookup
description: Find and inspect pull requests across GitHub, Delta, and legacy Gitstream from commits, branches, numbers, or URLs. Use when asked which PR contains a commit, for the current branch's PR URL, whether a PR merged, or which checks are failing.
---

# Pull Request Lookups

Use the same read-only commands in GitHub, Delta, and legacy Gitstream repositories. Route by verified host and repository configuration, never by `/pull/` versus `/pulls/` alone. A GitHub mirror is not the PR authority for a Delta-backed origin.

For Delta, load the repository's current instructions and live Delta skill from its verified origin before work. `dt` is the native read surface; `dtw` is the attributed PR prose-write surface. Read `dt <command> --help` for current flags. If local provider settings still identify a retired service, report them and reconcile through repository-supported machine setup; never edit Git configuration when the repository forbids it. Historical links must remain usable without redirecting writes to a retired service.

| Need | Command |
|---|---|
| PR containing a commit | `git pr-for-commit <SHA>` |
| Canonical PR URL | `git pr-url [PR_URL\|PR_NUMBER\|BRANCH]` |
| Full PR content and discussion | `git pr-view [PR_URL\|PR_NUMBER\|BRANCH]` |
| Checks ordered for action | `git pr-checks [PR_URL\|PR_NUMBER\|BRANCH] [--required]` |
| Merge timestamp | `git pr-merged [PR_URL\|PR_NUMBER\|BRANCH]` |
| Full GitHub issue content | `gw view-md <ISSUE_URL>` |

With no selector, URL, checks, and merge commands use the current branch. They exit nonzero when the PR cannot be established, checks fail, the PR is unmerged, or a result is ambiguous. Do not turn those failures into guesses.

`git pr-checks --required` limits output to required checks when the provider exposes that distinction. Use the full form when review and optional-check context matters.

Use `git pr-view` to read full PR content and discussion before acting. Continue using `gw view-md` for GitHub issues.

Repository-specific hosts and provider settings belong in machine-local setup, not this public skill. Where repository policy permits configuration, the generic settings include:

```sh
# provider is github, delta, or gitstream
git config prLookup.provider delta
git config prLookup.urlTemplate 'https://example.test/pulls/{number}'
```

Do not treat a missing or ambiguous commit association as permission to guess a PR or fall back to a mirror. Legacy merge-trailer mappings are not proof of a new provider association.

The helpers read repository-local `prLookup.remote` (default `origin`), with optional `prLookup.host` and `prLookup.repo` overrides. A positively identified Delta origin supersedes stale legacy routing without rewriting configuration; a failed discovery is not permission to fall back to a mirror. Legacy URL selectors need an exact configured template or matching explicitly configured host and repository.

Delta commit association uses local branch, subject/link, trailer, or configured-base merge hints to find candidates, then verifies exact head/merge SHA or paginated commit membership. Detached old commits without surviving candidate hints fail explicitly; the helper does not scan every remote PR. The routing helper requires Ruby with its JSON/URI standard libraries. A runtime LoadError must be reported, not treated as an empty PR result.

A configured merge-trailer workflow for `git pr-for-commit` additionally uses `prLookup.trailer` and `prLookup.baseRef`.
