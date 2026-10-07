---
name: browser-testing
description: Drive and inspect a live Chrome browser via the chrome-devtools CLI (chrome-devtools-mcp) to navigate pages, click/fill/type, take screenshots and snapshots, read console and network, and run performance/Lighthouse audits. Use when the user asks to test, use, drive, or automate a browser; check how a page looks or behaves; debug a live site; capture a screenshot; or inspect console/network/performance.
---

# Browser testing (chrome-devtools CLI)

pi has no built-in MCP, so use the **CLI** shipped with `chrome-devtools-mcp`, not an MCP server config.

## Read the contract from the install, not from here

The package ships the CLI documentation for its own version. Resolve the package the running executable belongs to, rather than whichever copy a package-manager root happens to hold:

```sh
exe=$(command -v chrome-devtools) || { echo "chrome-devtools is not on PATH" >&2; exit 1; }
target=$(sed -n 's/^# cmd-shim-target=//p' "$exe" 2>/dev/null | tail -1)
[ -n "$target" ] || target=$(readlink -f "$exe")
pkg=$(printf '%s' "$target" | sed -n 's|^\(.*/chrome-devtools-mcp\)/.*|\1|p')
docs="$pkg/skills/chrome-devtools-cli/SKILL.md"
[ -f "$docs" ] || { echo "no bundled CLI docs; use chrome-devtools <tool> --help" >&2; exit 1; }
printf '%s\n' "$docs"
```

Read that file before trusting any example. The argument style changed between versions — required arguments are positional on 1.10.x and flags on 1.6.x — so the installed copy is the only description that matches the installed CLI. If it is missing, `chrome-devtools <tool> --help` is the fallback.

## Local setup

- **Install with pnpm, not npm.** `npm i -g` fails where the npm prefix is `/usr`; `pnpm add -g chrome-devtools-mcp@latest` needs no sudo.
- **Chromium, not Google Chrome.** On a machine without Google Chrome the CLI fails with `Could not find Google Chrome executable`; start the daemon once with the path:
  ```sh
  chrome-devtools start --executablePath /usr/bin/chromium
  ```

## Workflow

The background server starts implicitly; do not run `start`/`status`/`stop` before each call. Start it once with `--executablePath` if this machine needs it.

1. **Find the page**: list the open pages, and select the one to work with when there is more than one. Exact arguments: the upstream file.
2. **Locate**: take a snapshot of that page; it returns element `<uid>`s. Interaction tools act on those UIDs, not CSS selectors.
3. **Act**: click, fill, type text, hover, press keys, drag, or upload, using the UIDs from the snapshot. Exact arguments: the upstream file.
4. **Verify**: screenshot, re-snapshot, or read the console, the network, or a Lighthouse audit. Exact arguments: the upstream file.
5. **Stop** the daemon when the task is done.

## Gotchas

- **File access depends on the version.** 1.10.x has full filesystem access by default (`--allowUnrestrictedPaths=true`), so `--filePath` can write anywhere. 1.6.0 refuses writes outside the OS temp dir ("not within any of the configured workspace roots"), so write to `$TMPDIR` and `mv`. That boundary was observed on two machines (1.6.0 on macOS, 1.10.1 on blueberry), not bisected to a release; when unsure, write to `$TMPDIR`.
- `wait_for` and `fill_form` are MCP-only in the versions seen; poll with `take_snapshot` or make individual `fill` calls.
- Ignore the `ExperimentalWarning: localStorage is not available` noise on stderr.

## Notes

- Signed-in profile or already-running Chrome: start Chrome with `--remote-debugging-port=9222 --user-data-dir=...`, then `chrome-devtools start --browserUrl=http://127.0.0.1:9222`.
- Tool reference: https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md
