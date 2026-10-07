---
name: try-workspaces
description: Create and find ephemeral workspaces under ~/src/tries with tobi/try. Use when starting an experiment or project directory outside an existing repo, when asked to make a workspace or a try directory, or when locating a previous workspace.
---

# try workspaces

`try` (github.com/tobi/try) keeps experiments in one dated tree instead of scattering `test2`, `test2`, and `actually-working` around the filesystem. Workspaces live under `TRY_PATH`, default `~/src/tries`, named `YYYY-MM-DD-<name>`.

**Every workspace is a git repository.** A clone or a `try` worktree already is one; a plain directory gets `git init` before any work, so the experiment has history and can be kept or dropped without losing it.

## Create a workspace

A person at a terminal:

```sh
try <name>          # create or jump to a dated workspace
try                 # fuzzy-search every workspace, most recent first
try . <name>        # dated worktree of the current repo
try clone <url>     # clone into a dated workspace
```

An agent, with no terminal:

```sh
# A dated worktree of the current repo. try detaches HEAD, so branch before
# committing or the work lands on no branch.
eval "$(try exec . <name>)"
git switch -c <branch>

# A clone works the same way.
eval "$(try exec clone https://github.com/<owner>/<repo>.git)"

# A plain workspace: try needs a TTY to create a brand-new directory, so make the
# dated path directly and initialise it.
path="${TRY_PATH:-$HOME/src/tries}/$(date +%F)-<name>"
mkdir -p "$path" && cd "$path" && git init
```

Only `try exec . <name>` and `try exec clone <url>` work without a TTY. Selecting an existing workspace or creating a new plain directory goes through the interactive picker and fails with "try requires an interactive terminal".

## Prefer a branch for task work

`try`'s worktree is `git worktree add --detach`. For work that needs a branch, the same dated path without the detach is:

```sh
git worktree add -b <branch> "${TRY_PATH:-$HOME/src/tries}/$(date +%F)-<name>"
```

Use `try exec .` when the dated path is the point and the branch is not.

## Find a workspace

```sh
try <query>     # interactive fuzzy search, most recent first (a person)
```

There is no non-interactive lookup: `try exec <query>` also opens the picker. From a script, list the tree instead: `ls "${TRY_PATH:-$HOME/src/tries}"`.

## Notes

- The interactive commands run through a shell function from `eval "$(try init)"` in `.zshrc`. Without it, `try` prints the script it would run.
- `TRY_PATH` and `TRY_PROJECTS` move the roots; the defaults are `~/src/tries` and its parent.
- Install: `brew install try` on macOS (already in the Brewfile), `gem install --user-install try-cli` on Linux (already in `setup`).
