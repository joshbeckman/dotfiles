---
name: browser-testing
description: Drive and inspect a live Chrome browser via the chrome-devtools CLI (chrome-devtools-mcp) to navigate pages, click/fill/type, take screenshots and snapshots, read console and network, and run performance/Lighthouse audits. Use when the user asks to test, use, drive, or automate a browser; check how a page looks or behaves; debug a live site; capture a screenshot; or inspect console/network/performance.
---

# Browser testing (chrome-devtools CLI)

pi has no built-in MCP, so use the **CLI** shipped with `chrome-devtools-mcp`, not an MCP server config.

## Quick start

```sh
chrome-devtools status || npm i -g chrome-devtools-mcp@latest   # ensure installed
chrome-devtools navigate_page --url "https://example.com" --type url
chrome-devtools take_snapshot                                   # get element UIDs
chrome-devtools take_screenshot --filePath "$TMPDIR/shot.png"  # writes must be under $TMPDIR
chrome-devtools stop                                            # when finished
```

- A background daemon starts on first tool call and persists browser state (pages, cookies) across commands.
- Headless and isolated are the default. Pass daemon args once via `chrome-devtools start ...` (e.g. `chrome-devtools start --headless=false`); run `chrome-devtools start --help` for supported args.
- `--output-format=json` gives machine-readable output. `DEBUG=* chrome-devtools <tool>` for verbose logs.

## Workflow

1. **Navigate**: `navigate_page --url "<url>" --type url` (the URL is a flag, not positional) or `new_page "<url>"`.
2. **Locate**: `take_snapshot` returns element UIDs — interaction tools act on those UIDs, not CSS selectors.
3. **Interact**: `click "<uid>"`, `fill "<uid>" "text"`, `type_text`, `hover`, `press_key`, `drag`, `upload_file`.
4. **Verify**: `take_screenshot [--fullPage] [--filePath ...]`, re-`take_snapshot`, `list_console_messages`, `list_network_requests` / `get_network_request`.
5. **Cleanup**: `chrome-devtools stop` when the task is done.

## Common tools

| Goal | Command |
|---|---|
| Go to URL | `navigate_page --url "<url>" --type url` / `new_page "<url>"` |
| See page structure + UIDs | `take_snapshot` |
| Screenshot | `take_screenshot [--fullPage] [--filePath ...]` |
| Click / fill | `click "<uid>"` / `fill "<uid>" "<value>"` |
| Run JS | `evaluate_script "<expr>"` |
| Console / network | `list_console_messages` / `list_network_requests` |
| Performance trace | `performance_start_trace` … `performance_stop_trace` |
| Audit | `lighthouse_audit [--mode snapshot]` |
| List / switch tabs | `list_pages` / `select_page` |

## Gotchas

- **File writes are sandboxed to `$TMPDIR`.** `take_screenshot`/other file-writing tools reject paths outside the OS temp dir ("not within any of the configured workspace roots"). Write to `$TMPDIR/...` then `mv` to the destination (e.g. `~/Downloads`).
- **`navigate_page` takes flags, not a positional URL**: use `--url "<url>" --type url`. A bare positional is parsed as `--type` and errors.
- Ignore the `ExperimentalWarning: localStorage is not available` noise on stderr — harmless.

## Notes

- To use a signed-in real profile or connect to an already-running Chrome, start Chrome with `--remote-debugging-port=9222 --user-data-dir=...` and run the daemon with `chrome-devtools start --browserUrl=http://127.0.0.1:9222`.
- `wait_for` and `fill_form` are MCP-only (excluded from the CLI); use `take_snapshot` polling or individual `fill` calls instead.
- Full tool reference: https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md
