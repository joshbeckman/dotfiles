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
