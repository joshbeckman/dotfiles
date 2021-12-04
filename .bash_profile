# this file is executed for login shells
# (when you start up your machine on most systems,
# or every new window on macs)

# for npm path
export PATH=/usr/local/share/npm/bin:$PATH

# for pkgconfig path
export PKG_CONFIG_PATH="/opt/local/lib/pkgconfig:$PKG_CONFIG_PATH"

# for gitcompletion
if [ -f ~/.git-completion.bash ]; then
  . ~/.git-completion.bash
fi

#export PYTHONPATH=/usr/local/lib/python2.7/site-packages:$PYTHONPATH
export PATH=/usr/local/bin:$PATH

# Setting PATH for Python 2.7
# The orginal version is saved in .bash_profile.pysave
#PATH="/Library/Frameworks/Python.framework/Versions/2.7/bin:${PATH}"
#export PATH

# Add RVM to PATH for scripting
export PATH="$PATH:$HOME/.rvm/bin" 

# Android development helpers
export ANDROID_HOME=~/Library/Android/sdk
PATH="~/Library/Android/sdk/tools:~/Library/Android/sdk/platform-tools:${PATH}"

# Load RVM into a shell session *as a function*
[[ -s "$HOME/.rvm/scripts/rvm" ]] && source "$HOME/.rvm/scripts/rvm" 

# golang-style path
export GOPATH=$HOME/projects/golang
export PATH=$PATH:$GOPATH/bin

# set macvim as editor
export EDITOR="vim"

# let other programs know that we are using bash
export SHELL=/bin/bash

# adding custom bin functions to path
# export PATH=$PATH:/Users/Joshua/bin

# for ruby 2.1.0 by default, for osx
# export PATH=/Users/Joshua/.rvm/gems/ruby-2.1.0/bin:$PATH
# rvm use 2.1.0

# Color definitions (taken from Color Bash Prompt HowTo).
# Some colors might look different of some terminals.
# For example, I see 'Bold Red' as 'orange' on my screen,
# hence the 'Green' 'BRed' 'Red' sequence I often use in my prompt.
# Normal Colors
Black='\e[0;30m'        # Black
Red='\e[0;31m'          # Red
Green='\e[0;32m'        # Green
Yellow='\e[0;33m'       # Yellow
Blue='\e[0;34m'         # Blue
Purple='\e[0;35m'       # Purple
Cyan='\e[0;36m'         # Cyan
White='\e[0;37m'        # White
# Bold
BBlack='\e[1;30m'       # Black
BRed='\e[1;31m'         # Red
BGreen='\e[1;32m'       # Green
BYellow='\e[1;33m'      # Yellow
BBlue='\e[1;34m'        # Blue
BPurple='\e[1;35m'      # Purple
BCyan='\e[1;36m'        # Cyan
BWhite='\e[1;37m'       # White
# Background
On_Black='\e[40m'       # Black
On_Red='\e[41m'         # Red
On_Green='\e[42m'       # Green
On_Yellow='\e[43m'      # Yellow
On_Blue='\e[44m'        # Blue
On_Purple='\e[45m'      # Purple
On_Cyan='\e[46m'        # Cyan
On_White='\e[47m'       # White
NC="\e[m"               # Color Reset
ALERT=${BWhite}${On_Red} # Bold White on red background
# Simple
MAGENTA="\033[1;31m"
ORANGE="\033[1;33m"
GREEN="\033[1;32m"
PURPLE="\033[1;35m"
BLUE="\033[1;34m"
WHITE="\033[1;37m"
CYAN="\033[1;36m"
BLACK="\033[1;30m"
RED="\033[1;31m"
BOLD=""
RESET="\033[m"

# brew install fortune, for fun :)
# fortune

[[ -r ~/.bashrc ]] && . ~/.bashrc
[[ -r ~/.profile ]] && . ~/.profile
if [ -e /Users/joshbeckman/.nix-profile/etc/profile.d/nix.sh ]; then . /Users/joshbeckman/.nix-profile/etc/profile.d/nix.sh; fi # added by Nix installer
