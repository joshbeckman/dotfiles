#!/bin/bash
# session-registry.sh <event>
# events: start | running | permission | question | idle | stopped | end
#
# Maintains a file-backed registry of live Claude Code sessions under
# ~/.claude/sessions/<session_id>.json. Each event either creates, updates,
# or removes the session's entry. Consumed by the `claudes` CLI.
set -eu

EVENT="${1:-}"
# tr '\000-\037' ' ' : defensively replace raw control chars with spaces.
# Claude Code's Stop hook sometimes emits .last_assistant_message containing
# unescaped newlines, which is invalid JSON — jq rejects it. Control bytes
# inside strings needed escaping, and outside strings were only ever
# whitespace, so coercing them to space yields valid JSON either way.
INPUT=$(cat 2>/dev/null | tr '\000-\037' ' ' || printf '{}')
SID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty')
[ -z "$SID" ] && exit 0

DIR="$HOME/.claude/sessions"
mkdir -p "$DIR"
FILE="$DIR/$SID.json"
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Merge-update: read existing JSON, apply jq args, atomic replace.
# Using a temp file rather than in-place to avoid partial writes if jq fails.
update() {
    local tmp="$FILE.tmp.$$"
    local existing='{}'
    [ -f "$FILE" ] && existing=$(cat "$FILE")
    printf '%s' "$existing" | jq "$@" > "$tmp" && mv "$tmp" "$FILE"
}

case "$EVENT" in
    start)
        CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty')
        BRANCH=""
        if [ -n "$CWD" ] && [ -d "$CWD" ]; then
            BRANCH=$(cd "$CWD" && git symbolic-ref --short HEAD 2>/dev/null || printf '')
        fi
        DIRNAME=$(basename "${CWD:-unknown}")
        jq -n \
            --arg sid "$SID" \
            --arg cwd "$CWD" \
            --arg dirname "$DIRNAME" \
            --arg branch "$BRANCH" \
            --arg pane "${WEZTERM_PANE:-}" \
            --arg ts "$NOW" \
            '{session_id:$sid, cwd:$cwd, dirname:$dirname, branch:$branch,
              pane_id:$pane, state:"running", started_at:$ts, updated_at:$ts}' > "$FILE"
        ;;
    running|permission|question|idle|stopped)
        MSG=$(printf '%s' "$INPUT" \
            | jq -r '.message // .last_assistant_message // empty' \
            | tr '\n"' '  ' | cut -c1-200)
        # Backfill identity fields on every update: sessions that started
        # before these hooks existed have no `start` event, so this is the
        # only way their cwd/dirname/branch/pane_id ever get recorded.
        # Using `// .field // default` means existing values are kept.
        CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty')
        BRANCH=""
        if [ -n "$CWD" ] && [ -d "$CWD" ]; then
            BRANCH=$(cd "$CWD" && git symbolic-ref --short HEAD 2>/dev/null || printf '')
        fi
        DIRNAME=$(basename "${CWD:-unknown}")
        update --arg sid "$SID" \
               --arg cwd "$CWD" \
               --arg dirname "$DIRNAME" \
               --arg branch "$BRANCH" \
               --arg pane "${WEZTERM_PANE:-}" \
               --arg state "$EVENT" \
               --arg msg "$MSG" \
               --arg ts "$NOW" \
            '. + {session_id: (.session_id // $sid),
                  cwd: (.cwd // "" | if . == "" then $cwd else . end),
                  dirname: (.dirname // "" | if . == "" then $dirname else . end),
                  branch: (.branch // "" | if . == "" then $branch else . end),
                  pane_id: (.pane_id // "" | if . == "" then $pane else . end),
                  state: $state,
                  updated_at: $ts}
             | if $msg == "" then . else . + {last_message:$msg} end'
        ;;
    end)
        rm -f "$FILE"
        ;;
esac
