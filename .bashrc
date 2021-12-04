# this file is executed for interactive non-login shells
# (when you open a new window/session)

export CLICOLOR=1

# custom prompt
parse_git_dirty () {
    [[ $(git status 2> /dev/null | tail -n1 | cut -c 1-17) != "nothing to commit" ]] && echo "*"
}
parse_git_branch () {
    git branch --no-color 2> /dev/null | sed -e '/^[^*]/d' -e "s/* \(.*\)/\1$(parse_git_dirty)/"
}

PS1="\[$RESET\]\[$RED\]\D{%F}T\A \[$RESET\]in \[$BLUE\]\w\[$RESET\]\$([[ -n \$(git branch 2> /dev/null) ]] && echo \" on \")\[$PURPLE\]\$(parse_git_branch)\[$RESET\]\n\$ \[$RESET\]"

# export PS1="\d \A \W\$ " 
#       canonical -> "\h:\W \u\$ "

# load defined aliases
[[ -r ~/.bash_aliases ]] && . ~/.bash_aliases

# custom functions (consider writing them to bin/)
hello()
{
    echo "Hello $1, let us be a friend." ;
}

frr()
{
    echo "finding and replacing";
    find $1 -type f -exec sed -i "" $2 {} \;
}

# deprecated, use https://github.com/zquestz/s

google()
{
    open https://encrypted.google.com/#q=$@;
}

github()
{
    open https://github.com/search?q=$@;
}

myargs()
{
    i=0
    for arg in "$@"; do
        echo "arg$i=$arg"
        let ++i
    done
}

vcsv()
{
    sed 's/,,/, ,/g;s/,,/, ,/g' $1 | column -s, -t | less -#2 -N -S
}

docker_into_machine()
{
    eval $(docker-machine env $1)
}

wake_me_in()
{
    sleep $1; echo -e '\a'
}

generate_readme() {
    cp ~/.dotfiles/commond-readme.md ./README.md
}

source ~/src/github.com/jdxcode/gh/bash/gh.bash
source ~/src/github.com/jdxcode/gh/bash/gl.bash
source ~/src/github.com/jdxcode/gh/completions/gh.bash
source ~/src/github.com/jdxcode/gh/completions/gl.bash

# heroku autocomplete setup
HEROKU_AC_BASH_SETUP_PATH=/Users/josh/Library/Caches/heroku/autocomplete/bash_setup && test -f $HEROKU_AC_BASH_SETUP_PATH && source $HEROKU_AC_BASH_SETUP_PATH;

[ -f ~/.fzf.bash ] && source ~/.fzf.bash

[[ -f /opt/dev/sh/chruby/chruby.sh ]] && type chruby >/dev/null 2>&1 || chruby () { source /opt/dev/sh/chruby/chruby.sh; chruby "$@"; }

[[ -x /usr/local/bin/brew ]] && eval $(/usr/local/bin/brew shellenv)
