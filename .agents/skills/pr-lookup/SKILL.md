---
name: pr-lookup
description: Discover a repository's hosting adapter and inspect pull requests from commits, branches, numbers, or URLs without assuming a provider from URL path shape.
---

# Pull Request Lookups

Run `git pr-host [PR_URL|PR_NUMBER|BRANCH]` in the intended checkout first. Its JSON record identifies the verified owning host, repository, selected client, and capabilities. Runtime discovery may expose machine-local adapter information; do not copy it into public documentation or PR descriptions.

| Need | Command |
|---|---|
| Hosting/capability discovery | `git pr-host [PR_URL\|PR_NUMBER\|BRANCH]` |
| PR containing a commit | `git pr-for-commit <SHA>` |
| Canonical PR URL | `git pr-url [PR_URL\|PR_NUMBER\|BRANCH]` |
| Full PR and discussion | `git pr-view [PR_URL\|PR_NUMBER\|BRANCH]` |
| Check state | `git pr-checks [PR_URL\|PR_NUMBER\|BRANCH] [--required]` |
| Merge timestamp | `git pr-merged [PR_URL\|PR_NUMBER\|BRANCH]` |
| Attributed PR prose | `git pr-write <verb> ...` |

An adapter that cannot bind its client to the verified target reports unsupported capabilities and does not run that client. Historical routing information alone does not grant a read or write capability.

Read full content before acting. Load the repository's current workflow before writes, CI, reviews, queues, or deployment. The classifier does not grant permission for any action. Discover client flags with its `--help`; don't copy changing provider policy into this skill.

A URL path is not proof of its provider. Match the verified host and repository or an exact configured historical template. A mirror is not authoritative. Discovery, missing tooling, and page failures must remain visible; never interpret them as an empty list or silently fall back to another service.

With no selector, read commands use the current branch where supported. Ambiguous PRs, unmerged state, and failing/pending checks return nonzero statuses. `--required` filters checks only when the adapter exposes that distinction.

Commit messages and local branches supply candidates, not proof. Verify exact head/merge IDs or paginated commit membership before returning an association. Detached historical commits without surviving hints fail explicitly; don't scan every remote PR or guess from a number.

Hosts, client overrides, historical URL templates, and live documentation links belong in supported machine-local setup. The generic routing settings are repository-local `prLookup.provider`, `prLookup.remote` (default `origin`), `prLookup.host`, `prLookup.repo`, and an adapter client override. Use the repository's setup procedure; do not edit Git configuration when it forbids it. Runtime ABI/load errors are blockers, not empty results.
