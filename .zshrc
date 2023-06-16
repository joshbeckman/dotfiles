# If you come from bash you might have to change your $PATH.
# export PATH=$HOME/bin:/usr/local/bin:$PATH

# Print a message in color.
# https://bytefreaks.net/gnulinux/bash/cecho-a-function-to-print-using-different-colors-in-bash
cecho () {
  declare message=${1:-""}
  declare   color=${2:-"default"}

  # declare -A colors
  # colors=(
  #         [default]="\e[39m"
  #           [black]="\e[30m"
  #             [red]="\e[31m"
  #           [green]="\e[32m"
  #          [yellow]="\e[33m"
  #            [blue]="\e[34m"
  #         [magenta]="\e[35m"
  #            [cyan]="\e[36m"
  #            [gray]="\e[37m"
  #       [light-red]="\e[91m"
  #     [light-green]="\e[92m"
  #    [light-yellow]="\e[93m"
  #      [light-blue]="\e[94m"
  #   [light-magenta]="\e[95m"
  #      [light-cyan]="\e[96m"
  #      [light-gray]="\e[97m"
  # )

  # color=${colors[$color]}

  # ZSH understands the colors black, red, green, yellow, blue, magenta, cyan and white
  echo -en "%F{${color}}${message}%f"
}

# Show colorful chevrons according to what month it is.
seasonal_chevrons () {
  local date=$(date)
  local chevrons="❯❯❯"

  case $date in
    # spring
    *Mar*|*Apr*|*May*)
      chevrons="$(cecho ❯ cyan)$(cecho ❯ green)$(cecho ❯ yellow)"
      ;;
    # summer
    *Jun*|*Jul*|*Aug*)
      chevrons="$(cecho ❯ green)$(cecho ❯ yellow)$(cecho ❯ magenta)"
      ;;
    # fall
    *Sep*|*Oct*|*Nov*)
      chevrons="$(cecho ❯ yellow)$(cecho ❯ magenta)$(cecho ❯ red)"
      ;;
    # winter
    *Dec*|*Jan*|*Feb*)
      chevrons="$(cecho ❯ blue)$(cecho ❯ cyan)$(cecho ❯ yellow)"
      ;;
    *)
      ;;
  esac

  echo -en $chevrons
}

# Return the branch name if we're in a git repo, or nothing otherwise.
git_check () {
  local gitBranch=$(git branch 2> /dev/null | sed -e "/^[^*]/d" -e "s/* \(.*\)/\1/")
  if [[ $gitBranch ]]; then
    echo -en $gitBranch
    return
  fi
}

# Return the status of the current git repo.
git_status () {
  local gitBranch="$(git_check)"
  if [[ $gitBranch ]]; then
    local statusCheck=$(git status 2> /dev/null)
    if [[ $statusCheck =~ 'Your branch is ahead' ]]; then
      echo -en 'ahead'
    elif [[ $statusCheck =~ 'Changes to be committed' ]]; then
      echo -en 'staged'
    elif [[ $statusCheck =~ 'no changes added' ]]; then
      echo -en 'modified'
    elif [[ $statusCheck =~ 'Untracked files' ]]; then
      echo -en 'modified'
    elif [[ $statusCheck =~ 'working tree clean' ]]; then
      echo -en 'clean'
    fi
  fi
}

# Return a color based on the current git status.
git_status_color () {
  local gitStatus="$(git_status)"
  local statusText=''
  case $gitStatus in
    clean*)
      statusText="green"
      ;;
    modified*)
      statusText="magenta"
      ;;
    staged*)
      statusText="yellow"
      ;;
    ahead*)
      statusText="cyan"
      ;;
    *)
      statusText="white"
      ;;
  esac
  echo -en $statusText
}

# Print a label for the current git branch if it isn't master.
git_branch () {
  local gitBranch="$(git_check)"
  if [[ $gitBranch && $COLUMNS -gt 79 ]]; then
    echo -en "%F{#616161}⌥%f %F{"$(git_status_color)"}$gitBranch%f"
  fi
}

# Print a dot indicating the current git status.
git_dot () {
  local gitCheck="$(git_check)"
  if [[ $gitCheck ]]; then
    local gitStatus="$(git_status)"
    local gitStatusDot='●'
    if [[ $gitStatus == 'staged' ]]; then
      local gitStatusDot='◍'
    elif [[ $gitStatus == 'modified' ]]; then
      local gitStatusDot='○'
    fi
    echo -en "%F{"$(git_status_color)"}$gitStatusDot%f "
  fi
}

# Get the current directory, truncate it, and make it blue
fancy_dir () {
  echo -en "%F{cyan}%-55<…<%~%<<%f"
  return
}

setopt prompt_subst

# export PS1='$(fancy_dir) $(git_branch) $(git_dot)$(seasonal_chevrons) '
export PS1='%n $(fancy_dir) $(seasonal_chevrons) '
. ~/.zsh/git-prompt.sh
export RPROMPT=$'$(__git_ps1 "%s")'

# Enable history search, ctrl-e, ctrl-a, etc.
bindkey -e

# Path to your oh-my-zsh installation.
# export ZSH="$HOME/.oh-my-zsh"

# Set name of the theme to load --- if set to "random", it will
# load a random theme each time oh-my-zsh is loaded, in which case,
# to know which specific one was loaded, run: echo $RANDOM_THEME
# See https://github.com/robbyrussell/oh-my-zsh/wiki/Themes
# SOLARIZED_THEME="light"
# ZSH_THEME="spaceship"
# SPACESHIP_TIME_SHOW=true

# solarized light colors
# SPACESHIP_TIME_COLOR=136
# SPACESHIP_EXEC_TIME_COLOR=136
# SPACESHIP_USER_COLOR=136
# SPACESHIP_DIR_COLOR=37
# SPACESHIP_GOLANG_COLOR=37
# SPACESHIP_DOCKER_COLOR=37
# SPACESHIP_GIT_BRANCH_COLOR=125
# SPACESHIP_ELIXIR_COLOR=125
# SPACESHIP_GIT_STATUS_COLOR=160
# SPACESHIP_USER_COLOR_ROOT=160
# SPACESHIP_PACKAGE_COLOR=160
# SPACESHIP_RUBY_COLOR=160

SPACESHIP_PROMPT_ORDER=(
  time          # Time stamps section
  user          # Username section
  dir           # Current directory section
  host          # Hostname section
  git           # Git section (git_branch + git_status)
  package       # Package version
  #elixir        # Elixir section
  xcode         # Xcode section
  swift         # Swift section
  #golang        # Go section
  #rust          # Rust section
  #haskell       # Haskell Stack section
  #julia         # Julia section
  docker        # Docker section
  #aws           # Amazon Web Services section
  #conda         # conda virtualenv section
  #pyenv         # Pyenv section
  #ember         # Ember.js section
  #kubecontext   # Kubectl context section
  #terraform     # Terraform workspace section
  exec_time     # Execution time
  line_sep      # Line break
  battery       # Battery level and status
  #vi_mode       # Vi-mode indicator
  jobs          # Background jobs indicator
  exit_code     # Exit code section
  char          # Prompt character
)
SPACESHIP_GIT_SYMBOL="⌥ "
SPACESHIP_CHAR_SYMBOL="❯❯❯ "

# Set list of themes to pick from when loading at random
# Setting this variable when ZSH_THEME=random will cause zsh to load
# a theme from this variable instead of looking in ~/.oh-my-zsh/themes/
# If set to an empty array, this variable will have no effect.
# ZSH_THEME_RANDOM_CANDIDATES=( "robbyrussell" "agnoster" )

# Uncomment the following line to use case-sensitive completion.
# CASE_SENSITIVE="true"

# Uncomment the following line to use hyphen-insensitive completion.
# Case-sensitive completion must be off. _ and - will be interchangeable.
# HYPHEN_INSENSITIVE="true"

# Uncomment the following line to disable bi-weekly auto-update checks.
# DISABLE_AUTO_UPDATE="true"

# Uncomment the following line to automatically update without prompting.
# DISABLE_UPDATE_PROMPT="true"

# Uncomment the following line to change how often to auto-update (in days).
# export UPDATE_ZSH_DAYS=13

# Uncomment the following line if pasting URLs and other text is messed up.
# DISABLE_MAGIC_FUNCTIONS=true

# Uncomment the following line to disable colors in ls.
# DISABLE_LS_COLORS="true"

# Uncomment the following line to disable auto-setting terminal title.
# DISABLE_AUTO_TITLE="true"

# Uncomment the following line to enable command auto-correction.
# ENABLE_CORRECTION="true"

# Uncomment the following line to display red dots whilst waiting for completion.
# COMPLETION_WAITING_DOTS="true"

# Uncomment the following line if you want to disable marking untracked files
# under VCS as dirty. This makes repository status check for large repositories
# much, much faster.
# DISABLE_UNTRACKED_FILES_DIRTY="true"

# Uncomment the following line if you want to change the command execution time
# stamp shown in the history command output.
# You can set one of the optional three formats:
# "mm/dd/yyyy"|"dd.mm.yyyy"|"yyyy-mm-dd"
# or set a custom format using the strftime function format specifications,
# see 'man strftime' for details.
# HIST_STAMPS="mm/dd/yyyy"

# Would you like to use another custom folder than $ZSH/custom?
# ZSH_CUSTOM=/path/to/new-custom-folder

# Which plugins would you like to load?
# Standard plugins can be found in ~/.oh-my-zsh/plugins/*
# Custom plugins may be added to ~/.oh-my-zsh/custom/plugins/
# Example format: plugins=(rails git textmate ruby lighthouse)
# Add wisely, as too many plugins slow down shell startup.
plugins=(
    # docker
    # docker-compose
    # docker-machine
    # git-extras
)

# source $ZSH/oh-my-zsh.sh

# User configuration

# export BROWSER=w3m

# export MANPATH="/usr/local/man:$MANPATH"

# You may need to manually set your language environment
# export LANG=en_US.UTF-8

# Preferred editor for local and remote sessions
export EDITOR='nvim'

# ripgrep config path
export RIPGREP_CONFIG_PATH=~/.ripgreprc

# Compilation flags
# export ARCHFLAGS="-arch x86_64"

# Set personal aliases, overriding those provided by oh-my-zsh libs,
# plugins, and themes. Aliases can be placed here, though oh-my-zsh
# users are encouraged to define aliases within the ZSH_CUSTOM folder.
# For a full list of active aliases, run `alias`.
#
# Example aliases
# alias zshconfig="mate ~/.zshrc"
# alias ohmyzsh="mate ~/.oh-my-zsh"
alias buildctags="~/dotfiles/.git-templates/hooks/ctags"
alias dateu="date -u +\"%Y-%m-%dT%H:%M:%SZ\""
alias ef='nvim "$(fzf)"'
alias l='ls -FGA'

# kitty terminal emulator control commands
# function kt () {
#   kitty @ focus-tab --match title:$1
# }
# function ktt () {
#   kitty @ set-tab-title $@
# }
# function kw () {
#   kitty @ focus-window --match title:$1
# }
# function kwt () {
#   kitty @ set-window-title $@
# }

# search files and open in vim as quickfix
function rgv () {
    nvim -q <(rg --vimgrep $@) -c :cwindow
}

function proverb () {
    curl https://notes.joshbeckman.org/humans.txt --silent | head -n 1
}

# Load Git completion
zstyle ':completion:*:*:git:*' script ~/.zsh/git-completion.bash
fpath=(~/.zsh $fpath)

autoload -Uz compinit && compinit

# compinit
# bash completion and gh
# autoload bashcompinit
# bashcompinit
# source ~/src/github.com/jdxcode/gh/bash/gh.bash
# source ~/src/github.com/jdxcode/gh/completions/gh.bash
# source ~/src/github.com/jdxcode/gh/bash/gl.bash
# source ~/src/github.com/jdxcode/gh/completions/gl.bash

. $HOME/.shellrc.load

[ -f /opt/dev/dev.sh ] && source /opt/dev/dev.sh
if [ -e ~/.nix-profile/etc/profile.d/nix.sh ]; then . ~/.nix-profile/etc/profile.d/nix.sh; fi # added by Nix installer

[ -f ~/.fzf.zsh ] && source ~/.fzf.zsh

[[ -f /opt/dev/sh/chruby/chruby.sh ]] && type chruby >/dev/null 2>&1 || chruby () { source /opt/dev/sh/chruby/chruby.sh; chruby "$@"; }
if [ -e /Users/joshbeckman/.nix-profile/etc/profile.d/nix.sh ]; then . /Users/joshbeckman/.nix-profile/etc/profile.d/nix.sh; fi # added by Nix installer

[[ -x /usr/local/bin/brew ]] && eval $(/usr/local/bin/brew shellenv)

[[ -x /opt/homebrew/bin/brew ]] && eval $(/opt/homebrew/bin/brew shellenv)

# attach to an existing tmux session if any exists
# (useful for remote shell logins with this setup)
if [ "$TMUX" = ""  ]; then tmux new -As0; fi
proverb
