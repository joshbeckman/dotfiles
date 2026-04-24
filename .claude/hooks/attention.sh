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
BACKUP_DIR="$HOME/.claude/sessions"
BACKUP_FILE=""
[ -n "$SID" ] && BACKUP_FILE="$BACKUP_DIR/$SID.tabtitle"

set_title() {
    # Guard: only meaningful when running inside Wezterm.
    [ -n "${WEZTERM_PANE:-}" ] || return 0
    "$WEZTERM" cli set-tab-title --pane-id "$WEZTERM_PANE" "$1" 2>/dev/null || true
}

# Remember whatever the tab was showing before we overwrite it. Rationale:
# setting tab_title to "" reverts to "automatic" mode, which in Wezterm
# just means "show the pane title". Any zsh prompt fire between set and
# clear can stomp the pane title down to literally "zsh", so "restore to
# automatic" loses the original name. Instead we capture the concrete
# string being shown now (explicit tab_title if any, else pane title) and
# restore that exact value on clear.
snapshot_title() {
    [ -n "${WEZTERM_PANE:-}" ] || return 0
    [ -z "$BACKUP_FILE" ] && return 0
    # Don't overwrite an existing snapshot: a rapid set_question→set_permission
    # (or double-fire) would otherwise snapshot our own attention mark.
    [ -f "$BACKUP_FILE" ] && return 0
    mkdir -p "$BACKUP_DIR"
    "$WEZTERM" cli list --format json 2>/dev/null \
        | jq -r --argjson p "$WEZTERM_PANE" '
            .[] | select(.pane_id == $p)
            | (.tab_title // "") as $t
            | if $t == "" then (.title // "") else $t end
          ' 2>/dev/null | head -1 > "$BACKUP_FILE"
}

restore_title() {
    [ -n "${WEZTERM_PANE:-}" ] || return 0
    if [ -n "$BACKUP_FILE" ] && [ -f "$BACKUP_FILE" ]; then
        set_title "$(cat "$BACKUP_FILE")"
        rm -f "$BACKUP_FILE"
    else
        # No snapshot — nothing to restore. Leaving the current title in
        # place is safer than stomping it with "" (which could itself
        # reveal "zsh" if the pane title is stale).
        :
    fi
}

case "$EVENT" in
    set_permission)
        snapshot_title
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
        snapshot_title
        set_title "? $DIRNAME"
        ;;
    clear)
        restore_title
        if [ -n "$SID" ] && command -v terminal-notifier >/dev/null 2>&1; then
            terminal-notifier -remove "$SID:permission" >/dev/null 2>&1 || true
        fi
        ;;
esac
