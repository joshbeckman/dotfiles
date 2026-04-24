#!/bin/bash
# Claude Code status line - Catppuccin Mocha style

# Read JSON input from stdin
input=$(cat)

# Catppuccin Mocha colors (256-color approximations)
PEACH='\033[38;5;215m'
PINK='\033[38;5;218m'
GREEN='\033[38;5;114m'
BLUE='\033[38;5;111m'
SKY='\033[38;5;117m'
TEAL='\033[38;5;116m'
MAUVE='\033[38;5;141m'
RESET='\033[0m'

# Extract values from JSON
MODEL=$(echo "$input" | jq -r '.model.display_name // "claude"')
CONTEXT=$(echo "$input" | jq -r '.context_window.used_percentage // 0' | cut -d'.' -f1)
COST=$(echo "$input" | jq -r '.cost.total_cost_usd // 0')
TRANSCRIPT=$(echo "$input" | jq -r '.transcript_path // empty')

# Get git branch and dirty state if in repo
GIT_BRANCH=""
GIT_DIRTY=""
if git rev-parse --git-dir > /dev/null 2>&1; then
    BRANCH=$(git branch --show-current 2>/dev/null)
    [ -n "$BRANCH" ] && GIT_BRANCH=" ${GREEN} ${BRANCH}${RESET}"
    STAT=$(git diff --shortstat 2>/dev/null)
    if [ -n "$STAT" ]; then
        ADDS=$(echo "$STAT" | grep -oE '[0-9]+ insertion' | grep -oE '[0-9]+')
        DELS=$(echo "$STAT" | grep -oE '[0-9]+ deletion' | grep -oE '[0-9]+')
        DIRTY=""
        [ -n "$ADDS" ] && DIRTY="+${ADDS}"
        [ -n "$DELS" ] && DIRTY="${DIRTY}-${DELS}"
        [ -n "$DIRTY" ] && GIT_DIRTY=" ${PEACH}${DIRTY}${RESET}"
    fi
fi

# Format cost to 2 decimal places, only show if > $0.00
COST_DISPLAY=""
if [ "$(echo "$COST > 0" | bc -l 2>/dev/null)" = "1" ]; then
    COST_FMT=$(printf "%.2f" "$COST")
    COST_DISPLAY=" ${TEAL}󰄛 \$${COST_FMT}${RESET}"
fi

# Cache hit rate aggregated across the session transcript
CACHE_DISPLAY=""
if [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ]; then
    CACHE_RATE=$(jq -s '
        [.[] | select(.message.usage) | .message.usage] as $u |
        ([$u[] | .cache_read_input_tokens // 0] | add // 0) as $r |
        ([$u[] | .input_tokens // 0] | add // 0) as $i |
        ([$u[] | .cache_creation_input_tokens // 0] | add // 0) as $c |
        ($r + $i + $c) as $total |
        if $total > 0 then (($r * 100 / $total) | floor) else empty end
    ' < "$TRANSCRIPT" 2>/dev/null)
    [ -n "$CACHE_RATE" ] && CACHE_DISPLAY=" ${BLUE}󰃨 ${CACHE_RATE}%${RESET}"
fi

# Context color based on usage
if [ "$CONTEXT" -gt 75 ]; then
    CTX_COLOR="${PEACH}"
elif [ "$CONTEXT" -gt 50 ]; then
    CTX_COLOR="${MAUVE}"
else
    CTX_COLOR="${SKY}"
fi

# Build the status line
echo -e "${MAUVE} ${MODEL}${RESET}${GIT_BRANCH}${GIT_DIRTY} ${CTX_COLOR}󰮉 ${CONTEXT}%${RESET}${CACHE_DISPLAY}${COST_DISPLAY}\n"
