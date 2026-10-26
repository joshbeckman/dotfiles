# Dotfiles

Configuration for my macOS development environment, managed with [dfm](https://github.com/justone/dfm).

## Setup

```sh
cd $HOME
git clone git@github.com:joshbeckman/dotfiles.git .dotfiles
./.dotfiles/setup
```

The [`setup`](setup) script handles everything: symlinking dotfiles via `dfm install`, installing Homebrew formulae from `Brewfile`, and cloning plugins for zsh, tmux, and Neovim. It detects macOS vs. Linux and adjusts accordingly.

Refreshes are noninteractive: plugin updates must fast-forward, Homebrew upgrades do not ask for confirmation or quit running apps, and privileged Homebrew installers are refused. Required-step failures stop the run; optional completion-keyword failures are reported and skipped. Perform any required privileged installation manually, then retry.

[`bin/dotfiles-refresh`](bin/dotfiles-refresh) runs `setup` every two hours. On macOS that is `Library/LaunchAgents/org.joshbeckman.dotfiles-refresh.plist`, which `dfm install` links into `~/Library/LaunchAgents`; on Linux it is `.config/systemd/user/dotfiles-refresh.timer`, which `setup` links into `~/.config/systemd/user` and enables. Intervals missed while the machine was off are skipped, and a lock prevents overlapping runs. The job uses the login shell's PATH, so machine-specific toolchains resolve. It appends to `~/Library/Logs/dotfiles-refresh.log` on macOS and `~/.local/state/dotfiles-refresh/refresh.log` elsewhere, and notifies only when a run fails. Load the macOS job once after the first install; the Linux timer is enabled by `setup`:

```sh
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/org.joshbeckman.dotfiles-refresh.plist
```

GitHub email-completion lookups run four at a time and reuse GitHub CLI's HTTP cache for 24 hours, including successful empty results. The dictionary remains append-only; newly discovered GitHub usernames are resolved on the next run rather than waiting for a whole-dictionary refresh interval.

To apply macOS system preferences (key repeat, Finder settings, etc.):

```sh
./bin/set-defaults.sh
```

## What's here

### Shell

- **`.zshrc`** — primary shell config (zsh): prompt, aliases, functions, path, completions
- **`.bashrc`** / **`.bash_profile`** / **`.bash_aliases`** — legacy bash config
- **`.shellrc.load`** — shared shell initialization

### Editors

- **`.config/nvim/`** — Neovim configuration (init.vim, ftplugin overrides, keyword lists)
- **`.vimrc`** — Vim configuration

### Terminal

- **`.tmux.conf`** — tmux key bindings, status bar, and session management
- **`.wezterm.lua`** — [WezTerm](https://wezfurlong.org/wezterm/) terminal config
- **`kitty.conf`** — [Kitty](https://sw.kovidgoyal.net/kitty/) terminal config

### Git

- **`.gitconfig`** — aliases, delta pager, merge/diff settings, signing
- **`.git-templates/`** — custom git template hooks
- **`.config/gh/config.yml`** — GitHub CLI preferences and aliases

### Background jobs

- **`Library/LaunchAgents/`** — per-user launchd jobs: the two-hour dotfiles refresh, the Agent Mail web bridge ([details](apps/agent-mail-web/README.md#installed-app-and-notifications)), and `panad`, the pana daemon

- **`.config/systemd/user/`** — the two-hour refresh as a user timer and `panad.service` as a service, both linked and enabled by `setup` on Linux

`bin/panad-service` is the one entry point both units run. It rebuilds `PATH` from the login shell, then injects the provider credentials with `s`. A service job has no TTY, so `s KEY -- panad` alone would fail with `reading password from TTY`; the wrapper points `S_KEY_COMMAND` at the login Keychain instead, and no secret is written to a tracked file. Load the macOS job once after the first install:

```sh
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/org.joshbeckman.panad.plist
```

### Tools

- **`apps/raycast/`** — Raycast script commands; add this directory under Raycast Settings › Extensions › Script Commands. **Preview Markdown** runs `preview-md` on a typed path or the Finder selection.

- **`Brewfile`** — Homebrew dependencies (bat, fzf, gh, ripgrep, neovim, tmux, etc.)
- **`.psqlrc`** — PostgreSQL client preferences
- **`.irbrc`** — Ruby REPL config
- **`.gemrc`** — RubyGems settings
- **`.ripgreprc`** — ripgrep defaults
- **`.grcat`** — generic colouriser config
- **[`model-eval/`](model-eval/README.md)** — local Pi model evaluation fixtures and reporting

### Scripts (`bin/`)

Many small utilities. [Agent teams](.agents/skills/agent-teams/SKILL.md) documents `agent-team`, shared scratchpads, roster broadcasts through `agent-mail`, and membership in `agent-find`.

Run any script with `--help` or read the source — they're short.

## Conventions

- **Symlinks, not copies.** `dfm install` symlinks files into `$HOME`. Editing a dotfile here edits the live config.
- **Tests run in CI.** Every script in `test/` is a standalone test. `bin/run-tests` runs them all (or the names given) with a scratch `HOME` and a time limit, and GitHub Actions runs it on macOS and Ubuntu for every pull request and push to `master`, along with pana's suites. A test that cannot run on one platform says so near its top with `# CI-skip: linux <reason>` or `# CI-skip: macos <reason>`.
- **Shell scripts stay simple.** Scripts in `bin/` are short, single-purpose, and use `#!/bin/sh` or `#!/usr/bin/env bash` (or ruby, etc.). Prefer `set -euo pipefail` in bash scripts.
- **Dotfiles are shared across macOS and Linux.** Treat commands, setup, configs, apps, services, and tests as cross-platform by default. Guard OS-specific behavior and select only resources for the current host. A platform-only command needs a `-macos` or `-linux` suffix, or `# Platform: macOS` or `# Platform: Linux` immediately below its shebang. Designate platform-only resources by path, filename, or a documented marker. A platform check inside a shared file does not designate the whole file. State the host for every test run; one host does not prove the other. Follow [cross-platform dotfiles](.agents/skills/cross-platform-dotfiles/SKILL.md) for changes anywhere in this repo.
- **Brewfile tracks dependencies.** If a script or config relies on a Homebrew formula, add it to `Brewfile`.
- **No secrets in version control.** Credentials, tokens, and API keys live in the encrypted store managed by [`s`](https://github.com/tobi/s) (`s set NAME`, injected per-invocation with `s NAME -- cmd`), never in committed files or globally sourced env files.
- **Conventional Commits.** Commit messages follow the `type(scope): description` format (e.g. `feat(zshrc):`, `fix(nvim):`).

## Technology choices

For software in this repo, use the simplest existing tool that fits. When choosing a new one, favor:

- **Git** for history and records over time; **SQLite or PostgreSQL** for canonical data storage.
- **Bash** for local scripts; **Rust** for fast programs; **Ruby** for expressive programs.
- **JSON** for static configuration and **JSONL** for streams and logs; **HTML, CSS, and JavaScript** for interfaces and applications.
- **Events, event loops, and message passing** for concurrent work, such as actor inboxes, pipelines, and channels.

Weigh designs against the [Principles of Good Systems](https://www.joshbeckman.org/notes/principles-of-system): safety, liveness, observability, controllability, composability, and scalability.

## Work and private content

This repo is **public** and used on both personal and work (Shopify) machines. Internal tooling on the work machine writes proprietary content into tracked files — e.g. `/opt/dev/...` scripts add proxy URLs and an `apiKeyHelper` to `.claude/settings.json`; setup scripts drop a Shopify email, signing key, and internal paths into `.gitconfig`. These lines reappear after they're removed, so every commit needs a manual pass.

**Before every commit**, review staged changes and strip anything that matches:

- **Shopify identifiers** — `shopify.com`, `shopify.ai`, `shopify.io`, `josh.beckman@shopify.com`, `X-Shopify-*` headers
- **Internal paths** — `/opt/dev`, `~/world`, `~/.shopify-build-tmp`, `~/.config/dev`
- **Proxy/gateway config in `.claude/settings.json`** — `ANTHROPIC_BASE_URL`, `ANTHROPIC_CUSTOM_HEADERS`, `apiKeyHelper`
- **GPG signing keys** — `signingkey = ...` under `[user]` in `.gitconfig`
- **Anything credential-shaped** — tokens, cookies, session IDs, bearer headers

**For agents:** run `git diff --cached` before proposing a commit on this repo. If any of the above patterns appear in the staged diff, stop and flag them to the user rather than stripping silently — an unfamiliar internal URL or path may be new work content that isn't on this list yet. When in doubt, ask before committing.
