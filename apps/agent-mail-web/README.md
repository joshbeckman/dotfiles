# Agent Mail web inbox

A single-page inbox over Agent Mail’s existing Markdown files. A Python standard-library bridge delegates delivery, replies, and archiving to `bin/agent-mail`; there is no mail database or cloud service.

```sh
agent-mail web
# Same command directly:
agent-mail-web
```

The bridge binds to `http://127.0.0.1:8765`, opens the browser, and runs until Ctrl-C. Keep its terminal open. `--no-open` prints the launch URL instead; `--port 8799` chooses another fixed port and `--port 0` chooses a free port for an isolated instance. If Agent Mail already holds the requested port, the command opens that bridge instead of starting another. Any other occupant makes startup fail rather than silently changing the address. No hostname or proxy configuration is needed.

Treat the launch URL as private. Its fragment authorizes that window, which keeps the token in local storage so it can relaunch at `/`. The token lives in the human mailbox as `.web-token` (mode 0600) and persists across bridge restarts. Delete it and restart the bridge to rotate it; every window then needs the new launch URL.

The bridge prints both launch URLs at startup, so its log contains the token as well. That log is a secret-bearing file: reading it to find the URL is fine, copying its output somewhere is not. Under launchd it is `~/.local/state/agent-mail/web.log`; under systemd the bridge prints to stdout, so the journal is the only copy and the command is `journalctl --user -u agent-mail-web`.

Storage belongs to the app container, not the origin. Chrome's installed app shares the browser profile, so it already sees the token a tab stored. Safari gives a Dock web app its own container, which never sees it. So any window that has no usable token, or gets a 403 from the bridge, shows an **Authorize this app** panel: paste the launch URL or the token once per container. The app verifies it against the bridge before storing it, so a stale token cannot displace a working one.

### Reaching it from another device

The bridge binds to `127.0.0.1`, so it is not on the network by default. To reach it from a
phone or another machine, put [Tailscale Serve](https://tailscale.com/kb/1247/funnel-serve-use-cases)
in front of it rather than binding more widely: Serve terminates HTTPS on the machine's
tailnet name and proxies to the loopback port, so a machine without Tailscale is unaffected.
HTTPS certificates have to be enabled for the tailnet first, and iOS needs HTTPS to install
the app to the home screen at all.

```sh
launchctl kickstart -k "gui/$(id -u)/org.joshbeckman.agent-mail-web"   # restart on the new code
tailscale serve --bg 8765                                              # https://<machine>.<tailnet>.ts.net
tailscale serve --https=443 off                                        # undo
```

The bridge detects its own tailnet name from `tailscale status` rather than being told, so a
renamed tailnet or a new machine needs no configuration. It answers to that name in addition
to loopback, and prints both launch URLs at startup; the tailnet one is what a phone uses.
On Linux, supervise it with a systemd user unit instead of the plist, and enable lingering so
it runs without a login session:

```ini
# ~/.config/systemd/user/agent-mail-web.service
[Unit]
Description=Agent Mail web bridge (loopback)
[Service]
# PATH matters for what the bridge shells out to: agent-mail resolves notify-josh
# through it, so a mail sent from the app still reaches the notification ladder.
Environment=PATH=%h/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=%h/dotfiles/bin/agent-mail-web --no-open
Restart=on-failure
[Install]
WantedBy=default.target
```

```sh
systemctl --user enable --now agent-mail-web
loginctl enable-linger "$USER"
```

If you are enabling this from a process that is not a login session — an agent running as a
system service, for instance — `systemctl --user` fails with `$DBUS_SESSION_BUS_ADDRESS and
$XDG_RUNTIME_DIR not defined`, because there is no user bus to talk to. Target the
logged-in user's bus instead:

```sh
systemctl --machine="$USER@.host" --user enable --now agent-mail-web
```

One caveat on the user unit, observed on the first Linux machine to run this: it has twice
lost its `default.target.wants` symlink across a reboot there. The directory survives, the
symlink does not, `is-enabled` reports disabled afterwards, and the root cause was never
found. That failure is silent in the worst way: the service works until a reboot and then
does not come back, with no error anywhere. So check `systemctl --user is-enabled
agent-mail-web` after a reboot. The fallback that machine has needed is a system unit under
`/etc/systemd/system` instead of a user unit.

Verify a new bridge from the command line before trusting it, and mind the header name: the
bridge reads `X-Agent-Mail-Token`, so a request carrying `Authorization: Bearer` gets the same 403
as no token at all, which reads like a failed setup rather than a wrong guess.

```sh
TOKEN="$(cat "$(agent-mail addr @josh | sed 's|/inbox$||')/.web-token")"
curl -s -o /dev/null -w '%{http_code}\n' -H "X-Agent-Mail-Token: $TOKEN" \
  http://127.0.0.1:8765/api/messages   # 200; without the header, 403
```

Read the status codes in order, because each one names a different fault. Without a token every
route answers 403 regardless of what was asked for, so a 403 means the token is missing or wrong
and says nothing about the request. A 404 means the token was accepted and the handle or route was
not. A 404 reading `Unknown endpoint` for a route that exists in `bin/agent-mail-web` is the third
case: the process predates the pull that added it, so restart the bridge rather than looking for a
typo.

On a systemd host, check the bridge two ways, because the two fail independently: something
listening on the port means it is up, and the `default.target.wants` symlink means it comes back
after a reboot. A running-but-disabled bridge looks healthy from the inbox right up until the next
reboot. Read the socket and the symlink directly rather than asking `systemctl --user`, which
cannot reach the user bus from a service context:

```sh
ss -ltn | grep 8765
ls ~/.config/systemd/user/default.target.wants/agent-mail-web.service
```

Two consequences worth knowing. The token is per machine, so each bridge's launch URL
authorizes that machine only, and each is a separate origin: one installed app per machine.
And reaching the bridge over the tailnet makes the token the only check on any device that
can reach the port, so restrict who can reach it with a Tailscale ACL if the tailnet has
devices you do not control.

### Installed app and notifications

`Library/LaunchAgents/org.joshbeckman.agent-mail-web.plist` keeps the bridge running in the background; `dfm install` links it. Load it after stopping any manual bridge on port 8765:

```sh
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/org.joshbeckman.agent-mail-web.plist
```

Open the launch URL once, then install: in Chrome, use the install button in the address bar; in Safari, use File › Add to Dock. Safari needs one more step, because a Safari web app starts with its own empty storage container. Copy the token to the clipboard and paste it into the app's **Authorize this app** panel:

```sh
pbcopy < "$(agent-mail addr @josh | sed 's|/inbox$||')/.web-token"
```

Click **Enable notifications** in the app header to allow alerts. While any Agent Mail window is open, including in the background, new inbox mail raises a notification when the window isn't focused. Clicking it opens the thread. Nothing is delivered while the app is closed; the existing `notify-josh` alerts still cover that. A phone cannot reach this loopback-only bridge.

Requires Python 3.10+ (tracked in `Brewfile`) and a modern browser. Runtime assets are bundled locally, including the self-hosted IBM Plex WOFF2 files in `fonts/` (SIL OFL, licence alongside them). The app no longer depends on fonts installed on the machine, which is what a Dock web app failed to resolve. Node/npm are needed only to rebuild or run browser tests. The existing `agent-mail inbox @josh` and Neovim mappings remain unchanged. No application bundle is installed: `~/Applications/Agent Mail.app` belongs to the Safari web app, and setup no longer writes to that path.

## Behavior

- **Opening does not archive.** Inbox messages stay in `new/` until explicit archive. `e` archives all inbox messages currently shown in the conversation. The CLI still calls unarchived messages “unread”; the browser adds no separate read flag.
- **Inbox, Archive, Sent, Drafts, All mail.** Archive contains received messages explicitly moved out of Inbox; All mail combines Inbox, Archive, Sent and Drafts. Opening a result in either view shows its whole retained thread. Search submits against all folders. `with:@+agent-handle` matches messages sent by or addressed to that agent, including group recipients and legacy mailbox-suffix aliases. `with:@human` searches a human contact; human and agent namespaces stay separate. Other whitespace-separated terms match sender, recipients, subject, and body case-insensitively, and all terms must match. Combine a contact filter with words to narrow the results. General `from:`, `to:`, and Boolean expressions are not supported.
- **Threads** use `Thread-ID`, `In-Reply-To`, and `Message-ID`, not subject matching. Participants and per-message reply/reply-all actions are visible. Missing historical messages are not fabricated. Each participant has a collapsible contact card beside the messages showing session title, liveness, harness, latest recorded model, and working directory. More session details reveals IDs and paths; the resume command can be copied without executing it. The cards use the same `agent-find` data and renderer as Contacts. Expand a participant to load their session details; opening a message does not run those inspections. Address aliases share one card; humans are identified separately and missing historical session data is labeled. Cards move below the messages on narrow screens or while composing a reply.
- **Compose recipients** have contact cards beside the editor, or below it on narrow screens and split-pane replies. Choosing a known handle loads session title, liveness, latest recorded model and working directory; manually typed handles are inspected when you leave the To field. Changing recipients updates the cards without changing the message. Human contacts stay distinct from agents; team cards show their current roster, which is resolved again at delivery.
- **Drafts** autosave after a pause or through Save. A revision check refuses to overwrite a draft changed in another editor/tab. Reopen a conflicting draft to see the disk version; copy unsaved text first. Clicking Send or pressing Ctrl+Enter / Cmd+Enter sends directly, without a confirmation dialog. After an uncertain send response, check Sent before retrying. Delete draft asks for confirmation, waits for any in-flight save, then removes that draft file and returns to Drafts. It refuses to delete a version changed elsewhere. Deletion is permanent; sent/received messages and uploaded images are untouched.
- **While drafting a reply**, the thread remains visible beside the composer on wide windows and above it on narrow ones. Message text remains selectable for quoting, including when reopening a saved reply draft. Thread navigation and archive/reply buttons are hidden while composing; use the composer controls or folder navigation to save and leave. New conversations keep the standalone composer.
- **After sending a reply**, the thread reopens with the sent reply included, so you can archive or continue the conversation. This also works for saved reply drafts reopened later. Sending a new conversation still opens the Sent list. Sending never archives the thread automatically.
- **Sent copies** are retained by both CLI human sends and human draft delivery. Existing outgoing messages are not backfilled from other agents’ inboxes. Sent copies retain the delivered headers and message identity.
- **Images** attached through the file picker are durable, locally stored PNG/JPEG/GIF/WebP files (up to 5 MiB), referenced by file URI in Markdown. Other local-file references are not served automatically: attach them explicitly. HTTPS images in received Markdown are blocked until “Load remote images” is clicked, which contacts the external image host. Unreferenced uploaded images are retained rather than automatically pruned.
- **Markdown and Mermaid** render in an opaque-origin sandboxed reader. Raw HTML is displayed as text; unsafe links are removed. Diagram failures leave source visible. Markdown source is always available. Light/dark modes follow the browser preference when a message is rendered.
- **Avatars and favicon** are bundled or generated locally, with no Gravatar or other runtime external lookup. Josh’s user icon is the [favicon declared by his website](https://www.joshbeckman.org/assets/img/profile.png), bundled as `josh-avatar.png`. Registered agents can supply a [scratchpad SVG avatar](#agent-avatars), with identicon fallback. Other sender/contact avatars are generated deterministically from addresses, normalizing agent mailbox suffixes and address aliases. Human `@name` and agent `@+name` identities stay distinct. These are visual aids; names remain visible. The browser tab keeps its envelope favicon.
- **Contacts** combine identity claims, addressable scratchpads, and participants in Josh’s mail history. Expand a contact for `agent-find` details: session title, liveness, harness, latest recorded provider/model, observation time and source, full session ID, start date, working directory, scratchpad, transcript path, and a copyable resume command. Models observed expands the distinct models recorded in assistant messages, with first/last observation times. Commands are never executed by the page. Details load on expansion rather than scanning every historical transcript on page load. A fresh heartbeat with a live PID is labeled “active (heartbeat)”, not guaranteed availability. Historical, unaddressable contacts remain listed but cannot be selected for delivery. **View transcript** on directory and thread participant cards opens a read-only journal for the exact registered Pi session. The journal loads bounded pages, polls for appended entries while visible, and labels itself as an all-branches append journal rather than a reconstruction of the current branch. Text is rendered inert; thinking and tool calls are collapsed; image payloads are omitted. **Show mail** on directory and thread participant cards opens All mail with that contact’s `with:` filter, replacing the previous search. It works without a live/addressable session and saves an open reply draft before navigating. Matches are grouped into conversations; opening a result shows the whole retained thread for context. Only mail retained in Josh’s mailbox is searched, not other agents’ inboxes.
- **Contact teams** show the active memberships returned by `agent-find` in directory and thread participant cards. Each summary shows the team handle, name, and agent’s role; expand it for the coordinator, contribution scope, join time, and shared scratchpad path. No active teams and unavailable membership data are distinct states, with lookup warnings shown rather than hidden. This is a read-only snapshot: refresh the page or repeat a contact search to load roster changes.
- **Teams** lists active and archived teams from `agent-team`. Submit a handle/name/purpose search, or use All teams and Refresh for a new snapshot. Expand a team for its purpose, coordinator, shared scratchpad, creation/update times, roster, coordinator history, and ended memberships. Roster contacts load session details on expansion. Message team opens a draft addressed to the active team; archived teams cannot be messaged. Leaving a composer for Teams saves the draft first. Team creation and membership changes remain CLI operations. Lookup failure clears stale results and is distinct from an empty directory.
- **Contact search** runs an actual `agent-find` case-insensitive regex search across session transcripts. Submit with Enter or Find agents; it does not run an expensive transcript search on every keystroke. Results show full details and up to 30 sessions ranked by matching lines. All contacts returns to the directory. Unlike an agent’s own CLI search, this human-facing search includes the session that launched the web bridge.
- The message list refreshes every ten seconds while visible. Files over 2 MiB or unreadable files produce warnings instead of breaking the inbox. Mail from agents’ unrelated conversations is not indexed.

## Agent avatars

Save an optional `avatar.svg` in the agent's session scratchpad; no PNG companion or separate profile registry is required.

- **Format:** SVG namespace and a finite `viewBox`, at most 100 KiB, 256 elements and 8 KiB per attribute.
- **Supported:** paths, shapes, groups, local gradients/clipping, and title/description text. Use presentation attributes rather than CSS.
- **Rejected:** scripts, event handlers, CSS, external resources, embedded images, links, `use`, animation, nested SVGs and visible text/fonts. Symlinked files, pads and identity claims are not served.

The authenticated bridge resolves registered identities and validates the drawing; the browser renders it as an image, never inline page markup. Missing, unreadable, ambiguous or rejected files retain the generated identicon. Refresh the page to pick up edits. Current artwork appears on old messages too; historical avatars are not preserved.

## Composer

The Markdown body uses a locally bundled CodeMirror editor. **Vim mode** is optional and remembered by the browser. **Configure .vimrc** accepts pasted mappings: `map`, `noremap`, their normal/insert/visual/operator-mode variants, and `let mapleader`. Unsupported lines are reported; this does not load desktop Vim plugins or execute arbitrary Vimscript. A configured leader is reserved as a mapping prefix in its mapped modes.

For example:

```vim
inoremap jk <Esc>
let mapleader = "\<Space>"
nnoremap <leader>x dd
```

Completion uses `$XDG_CONFIG_HOME/nvim/keywords.txt`, defaulting to `~/.config/nvim/keywords.txt`. The authenticated bridge rereads it when a draft opens. The dictionary stays on your machine and is not included in browser assets or this repository. Handles such as `@+name-of-realm`, dotted names, and underscores complete as whole tokens. Ctrl+n / Ctrl+p open or navigate completions in insert mode (or with Vim disabled); Tab accepts and Escape dismisses. With Vim enabled, another Escape returns to normal mode. Missing or invalid dictionaries leave the editor usable with an explanatory status. Dictionaries are limited to 1 MiB, 10,000 distinct words, and 256 characters per word.

Editor undo history starts fresh for each opened draft, while Vim preferences persist separately. Draft bodies remain plain Markdown; autosave, revision conflicts, attachments, and CLI/Neovim interoperability are unchanged. After installing a version that changes the bridge or asset allowlist, restart the bridge and refresh; the token is unchanged.

## Keys

`j` / `k` navigate conversations; `o` or Enter opens; `u` returns to the list; `/` searches; `e` archives; `c` composes; `r` replies; `a` replies to all. `g i`, `g a`, `g s`, and `g d` open Inbox, All mail, Sent, and Drafts; `g c` opens Contacts and `g t` opens Teams. `?` shows help. Ctrl+Enter or Cmd+Enter sends a draft. Navigation keys do not fire while typing in inputs.

The shared CLI also exposes structured session metadata for other interfaces:

```sh
agent-find 'migration topic' --json --limit 10
agent-find --agent @+agent-handle --json
```

Ordinary `agent-find <pattern>` retains its terminal output and adds harness, latest model, and observed-model history. Exact-handle lookup does not search transcript content; its `matches` field is `null`.

JSON includes `harness`, `provider`, `model`, `modelObservedAt`, `modelSource`, and `modelsUsed`. The latest model follows the last persisted branch's parent links, using model selections and assistant-message metadata. `modelSource` distinguishes a recorded selection (`model_change`) from an assistant message (`assistant`). Missing metadata remains null. The Pi harness name comes from the session header; its format version is not an application release number, so no harness release is inferred.

`modelsUsed` lists distinct provider/model pairs observed in top-level assistant messages across all branches of this transcript, with `firstObservedAt` and `lastObservedAt`. A selection without an assistant message does not establish usage. Quoted trailers and nested tool metadata are ignored. This is recorded evidence, not a live-process probe or a guarantee of all historical calls: unlogged calls, removed records, and other session files cannot be reconstructed. Refresh the page or repeat a contact search to obtain a new snapshot.

## Local boundary

The bridge checks Host and Origin, rejects cross-site API requests, and requires the bridge's token header for **all** API reads and mutations. Mutations require same-origin JSON requests. There is no arbitrary path or command endpoint. Message keys are confined to mailbox folders; symlinked files and attachment paths are rejected. Static reader assets contain no private data.

Mail content cannot access the parent page or its token. The sandboxed reader has no API credentials and cannot submit forms or execute inline scripts. Markdown HTML is sanitized, Mermaid runs in strict mode, and CSP restricts resource loading. Only the trusted reader script runs to size the frame and forward keyboard shortcuts. These safeguards are for untrusted mail and unrelated websites, not a malicious process running as the same OS user.

## Checks and rebuilding

From the repository root:

```sh
test/agent-mail
test/agent-mail-web
test/agent-find
```

Browser checks use isolated fixture mailboxes and an installed Chrome, never the real inbox:

```sh
cd apps/agent-mail-web
npm ci --ignore-scripts
npm test
# Optional alternative Chromium executable:
CHROME_EXECUTABLE=/path/to/chromium npm test
```

Rebuild the pinned editor, Markdown, sanitizer, and diagram libraries plus their license notices:

```sh
npm run build
npm audit --omit=dev --registry=https://registry.npmjs.org
```

Commit `vendor.js`, `composer-vendor.js`, `package-lock.json`, and `THIRD_PARTY_LICENSES.txt` together when updating dependencies. No runtime CDN requests are needed.

Co-authored-by: AI Simoom Farrier @+simoom-farrier
