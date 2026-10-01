#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Preview Markdown
# @raycast.mode compact
# @raycast.packageName Dotfiles

# Optional parameters:
# @raycast.icon 📄
# @raycast.argument1 { "type": "text", "placeholder": "file path (blank: Finder selection)", "optional": true }
# @raycast.description Render a Markdown file in the browser with preview-md.

set -euo pipefail

# Raycast runs scripts with a minimal PATH; preview-md needs ~/bin and pandoc.
export PATH="$HOME/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

path="${1:-}"
if [ -z "$path" ]; then
  path="$(osascript -e 'tell application "Finder" to if (count of (selection as list)) > 0 then POSIX path of (item 1 of (selection as list) as alias)' 2>/dev/null || true)"
fi
# Accept ~, quoted paths, and file:// URLs pasted from other apps.
path="${path#\"}"; path="${path%\"}"; path="${path#\'}"; path="${path%\'}"
case "$path" in
  file://*) path="$(python3 -c 'import sys, urllib.parse; print(urllib.parse.unquote(urllib.parse.urlsplit(sys.argv[1]).path))' "$path")" ;;
  "~"|"~/"*) path="$HOME${path#\~}" ;;
esac

if [ -z "$path" ]; then
  echo "Give a file path or select a file in Finder"
  exit 1
fi
if [ ! -f "$path" ]; then
  echo "Not a file: $path"
  exit 1
fi

preview-md --title "$(basename "$path")" "$path" >/dev/null
echo "Previewing $(basename "$path")"
