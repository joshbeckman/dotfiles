#!/bin/bash
# attention.sh <event>
# events: set_permission | set_question | clear
#
# Quieter replacement for terminal-notifier spam: marks the Wezterm tab
# containing the current pane with a prefix so it's visible in the tab bar.
# For permission_prompt only, also fires a single terminal-notifier so you
# get a nudge when Wezterm isn't focused. elicitation/idle/stop stay silent.
set -eu

EVENT="${1:-}"
# See session-registry.sh for why this tr is needed (raw control chars in
# Claude Code payloads break jq).
INPUT=$(cat 2>/dev/null | tr '\000-\037' ' ' || printf '{}')
CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty')
SID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty')
MSG=$(printf '%s' "$INPUT" | jq -r '.message // empty' | tr '\n"' '  ' | cut -c1-100)
DIRNAME=$(basename "${CWD:-claude}")

WEZTERM=/opt/homebrew/bin/wezterm

set_title() {
    # Guard: only meaningful when running inside Wezterm.
    [ -n "${WEZTERM_PANE:-}" ] || return 0
    "$WEZTERM" cli set-tab-title --pane-id "$WEZTERM_PANE" "$1" 2>/dev/null || true
}

case "$EVENT" in
    set_permission)
        set_title "⚠ $DIRNAME"
        # Single out-of-app nudge, only for permission — the one event worth
        # interrupting focus for. Sound is retained here deliberately.
        if command -v terminal-notifier >/dev/null 2>&1; then
            terminal-notifier \
                -message "$MSG" \
                -title "Claude $DIRNAME: permission needed" \
                -sound Ping \
                -group "$SID:permission" \
                -execute "$WEZTERM cli activate-pane --pane-id ${WEZTERM_PANE:-}" \
                -activate com.github.wez.wezterm >/dev/null 2>&1 || true
        fi
        ;;
    set_question)
        set_title "? $DIRNAME"
        ;;
    clear)
        # Empty string restores Wezterm's automatic tab title.
        set_title ""
        if [ -n "$SID" ] && command -v terminal-notifier >/dev/null 2>&1; then
            terminal-notifier -remove "$SID:permission" >/dev/null 2>&1 || true
        fi
        ;;
esac
