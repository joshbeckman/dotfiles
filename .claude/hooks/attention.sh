#!/bin/bash
# attention.sh <event>
# events: set_permission | set_question | clear
#
# Quieter replacement for terminal-notifier spam: marks the tmux window
# containing the current pane with a prefix so it's visible in the status
# bar's window list. For permission_prompt only, also fires a single
# terminal-notifier so you get a nudge when ghostty isn't focused, and a
# tmux display-message toast for clients attached to the same session.
# elicitation/idle/stop stay silent.
set -eu

EVENT="${1:-}"
# See session-registry.sh for why this tr is needed (raw control chars in
# Claude Code payloads break jq).
INPUT=$(cat 2>/dev/null | tr '\000-\037' ' ' || printf '{}')
CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty')
SID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty')
MSG=$(printf '%s' "$INPUT" | jq -r '.message // empty' | tr '\n"' '  ' | cut -c1-100)
DIRNAME=$(basename "${CWD:-claude}")

BACKUP_DIR="$HOME/.claude/sessions"
BACKUP_FILE=""
[ -n "$SID" ] && BACKUP_FILE="$BACKUP_DIR/$SID.tabtitle"

set_window_name() {
    # Guard: only meaningful when running inside tmux with a known pane.
    [ -n "${TMUX:-}" ] && [ -n "${TMUX_PANE:-}" ] || return 0
    tmux rename-window -t "$TMUX_PANE" "$1" 2>/dev/null || true
}

# Save window name AND automatic-rename setting. tmux rename-window has the
# side effect of disabling automatic-rename, so without restoring the option
# we'd lose process-driven names on restore.
snapshot_title() {
    [ -n "${TMUX:-}" ] && [ -n "${TMUX_PANE:-}" ] || return 0
    [ -z "$BACKUP_FILE" ] && return 0
    # Don't overwrite an existing snapshot: a rapid set_question→set_permission
    # (or double-fire) would otherwise snapshot our own attention mark.
    [ -f "$BACKUP_FILE" ] && return 0
    mkdir -p "$BACKUP_DIR"
    local name auto
    name=$(tmux display-message -t "$TMUX_PANE" -p '#W' 2>/dev/null || printf '')
    auto=$(tmux show-window-options -t "$TMUX_PANE" -v automatic-rename 2>/dev/null || printf 'on')
    printf '%s\n%s\n' "$name" "$auto" > "$BACKUP_FILE"
}

restore_title() {
    [ -n "${TMUX:-}" ] && [ -n "${TMUX_PANE:-}" ] || return 0
    [ -n "$BACKUP_FILE" ] && [ -f "$BACKUP_FILE" ] || return 0
    local name auto
    name=$(sed -n '1p' "$BACKUP_FILE")
    auto=$(sed -n '2p' "$BACKUP_FILE")
    [ -n "$name" ] && tmux rename-window -t "$TMUX_PANE" "$name" 2>/dev/null || true
    # Re-enable automatic-rename only if it was on before — flipping it on
    # for windows the user had explicitly named would clobber their choice.
    [ "$auto" = "on" ] && tmux set-window-option -t "$TMUX_PANE" automatic-rename on 2>/dev/null || true
    rm -f "$BACKUP_FILE"
}

# In-tmux toast. Only displays on clients attached to the pane's session;
# users on a different tmux session won't see it (terminal-notifier covers
# that case for the permission event).
tmux_toast() {
    [ -n "${TMUX:-}" ] && [ -n "${TMUX_PANE:-}" ] || return 0
    tmux display-message -t "$TMUX_PANE" -d 4000 "$1" 2>/dev/null || true
}

case "$EVENT" in
    set_permission)
        snapshot_title
        set_window_name "⚠ $DIRNAME"
        tmux_toast "⚠ Claude $DIRNAME: permission needed — $MSG"
        # Single out-of-app nudge, only for permission — the one event worth
        # interrupting focus for. Sound is retained here deliberately.
        if command -v terminal-notifier >/dev/null 2>&1; then
            # -execute runs via sh; tmux select-window/select-pane both
            # accept a global pane id like %23 and resolve session+window
            # automatically. No -c flag because the most-recently-attached
            # client is the right target for the user-facing tmux.
            terminal-notifier \
                -message "$MSG" \
                -title "Claude $DIRNAME: permission needed" \
                -sound Ping \
                -group "$SID:permission" \
                -execute "tmux select-window -t ${TMUX_PANE:-} 2>/dev/null; tmux select-pane -t ${TMUX_PANE:-} 2>/dev/null" \
                -activate com.mitchellh.ghostty >/dev/null 2>&1 || true
        fi
        ;;
    set_question)
        snapshot_title
        set_window_name "? $DIRNAME"
        ;;
    clear)
        restore_title
        if [ -n "$SID" ] && command -v terminal-notifier >/dev/null 2>&1; then
            terminal-notifier -remove "$SID:permission" >/dev/null 2>&1 || true
        fi
        ;;
esac
