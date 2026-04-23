# Dotfiles

Configuration for my macOS development environment, managed with [dfm](https://github.com/justone/dfm).

## Setup

```sh
cd $HOME
git clone git@github.com:joshbeckman/dotfiles.git .dotfiles
./.dotfiles/setup
```

The [`setup`](setup) script handles everything: symlinking dotfiles via `dfm install`, installing Homebrew formulae from `Brewfile`, and cloning plugins for zsh, tmux, and Neovim. It detects macOS vs. Linux and adjusts accordingly.

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

### Tools

- **`Brewfile`** — Homebrew dependencies (bat, fzf, gh, ripgrep, neovim, tmux, etc.)
- **`.psqlrc`** — PostgreSQL client preferences
- **`.irbrc`** — Ruby REPL config
- **`.gemrc`** — RubyGems settings
- **`.ripgreprc`** — ripgrep defaults
- **`.grcat`** — generic colouriser config

### Scripts (`bin/`)

Many small utilities.

Run any script with `--help` or read the source — they're short.

## Conventions

- **Symlinks, not copies.** `dfm install` symlinks files into `$HOME`. Editing a dotfile here edits the live config.
- **Shell scripts stay simple.** Scripts in `bin/` are short, single-purpose, and use `#!/bin/sh` or `#!/usr/bin/env bash` (or ruby, etc.). Prefer `set -euo pipefail` in bash scripts.
- **Brewfile tracks dependencies.** If a script or config relies on a Homebrew formula, add it to `Brewfile`.
- **No secrets in version control.** Credentials, tokens, and API keys belong in files sourced separately (e.g. a `.secrets` file), not committed here.
- **Conventional Commits.** Commit messages follow the `type(scope): description` format (e.g. `feat(zshrc):`, `fix(nvim):`).

## Work and private content

This repo is **public** and used on both personal and work (Shopify) machines. Internal tooling on the work machine writes proprietary content into tracked files — e.g. `/opt/dev/...` scripts add proxy URLs and an `apiKeyHelper` to `.claude/settings.json`; setup scripts drop a Shopify email, signing key, and internal paths into `.gitconfig`. These lines reappear after they're removed, so every commit needs a manual pass.

**Before every commit**, review staged changes and strip anything that matches:

- **Shopify identifiers** — `shopify.com`, `shopify.ai`, `shopify.io`, `josh.beckman@shopify.com`, `X-Shopify-*` headers
- **Internal paths** — `/opt/dev`, `~/world`, `~/.shopify-build-tmp`, `~/.config/dev`
- **Proxy/gateway config in `.claude/settings.json`** — `ANTHROPIC_BASE_URL`, `ANTHROPIC_CUSTOM_HEADERS`, `apiKeyHelper`
- **GPG signing keys** — `signingkey = ...` under `[user]` in `.gitconfig`
- **Anything credential-shaped** — tokens, cookies, session IDs, bearer headers

**For agents:** run `git diff --cached` before proposing a commit on this repo. If any of the above patterns appear in the staged diff, stop and flag them to the user rather than stripping silently — an unfamiliar internal URL or path may be new work content that isn't on this list yet. When in doubt, ask before committing.
