# Agent Mail web inbox

A single-page inbox over Agent Mail’s existing Markdown files. A Python standard-library bridge delegates delivery, replies, and archiving to `bin/agent-mail`; there is no mail database or cloud service.

```sh
agent-mail web
# Same command directly:
agent-mail-web
```

The bridge binds to a free port on `127.0.0.1`, opens the browser, and runs until Ctrl-C. Keep its terminal open. `--no-open` prints the launch URL instead; `--port 8799` chooses a port. Treat the launch URL as private: its fragment authorizes that browser tab for this server lifetime. Refreshing the tab works; restarting the bridge requires its new launch URL.

Requires Python 3.10+ (tracked in `Brewfile`) and a modern browser. Runtime assets are bundled locally; Node/npm are needed only to rebuild or run browser tests. The existing `agent-mail inbox @josh`, Neovim mappings, and macOS launcher remain unchanged.

## Behavior

- **Opening does not archive.** Inbox messages stay in `new/` until explicit archive. `e` archives all inbox messages currently shown in the conversation. The CLI still calls unarchived messages “unread”; the browser adds no separate read flag.
- **Inbox, Archive, Sent, Drafts, All mail.** Search matches all whitespace-separated terms against sender, recipients, subject, and body, case-insensitively. Search submits against all folders. It does not implement Gmail’s advanced search operators.
- **Threads** use `Thread-ID`, `In-Reply-To`, and `Message-ID`, not subject matching. Participants and per-message reply/reply-all actions are visible. Missing historical messages are not fabricated.
- **Drafts** autosave after a pause or through Save. A revision check refuses to overwrite a draft changed in another editor/tab. Reopen a conflicting draft to see the disk version; copy unsaved text first. Sending requires explicit confirmation. After an uncertain send response, check Sent before retrying.
- **Sent copies** are retained by both CLI human sends and human draft delivery. Existing outgoing messages are not backfilled from other agents’ inboxes. Sent copies retain the delivered headers and message identity.
- **Images** attached through the file picker are durable, locally stored PNG/JPEG/GIF/WebP files (up to 5 MiB), referenced by file URI in Markdown. Other local-file references are not served automatically: attach them explicitly. HTTPS images in received Markdown are blocked until “Load remote images” is clicked, which contacts the external image host. Unreferenced uploaded images are retained rather than automatically pruned.
- **Markdown and Mermaid** render in an opaque-origin sandboxed reader. Raw HTML is displayed as text; unsafe links are removed. Diagram failures leave source visible. Markdown source is always available. Light/dark modes follow the browser preference when a message is rendered.
- **Contacts** combine identity claims, addressable scratchpads, and participants in Josh’s mail history. Expand a contact for `agent-find` details: session title, liveness, full session ID, start date, working directory, scratchpad, transcript path, and a copyable resume command. Commands are never executed by the page. Details load on expansion rather than scanning every historical transcript on page load. A fresh heartbeat with a live PID is labeled “active (heartbeat)”, not guaranteed availability. Historical, unaddressable contacts remain listed but cannot be selected for delivery.
- **Contact search** runs an actual `agent-find` case-insensitive regex search across session transcripts. Submit with Enter or Find agents; it does not run an expensive transcript search on every keystroke. Results show full details and up to 30 sessions ranked by matching lines. All contacts returns to the directory. Unlike an agent’s own CLI search, this human-facing search includes the session that launched the web bridge.
- The message list refreshes every ten seconds while visible. Files over 2 MiB or unreadable files produce warnings instead of breaking the inbox. Mail from agents’ unrelated conversations is not indexed.

## Keys

`j` / `k` navigate conversations; `o` or Enter opens; `u` returns to the list; `/` searches; `e` archives; `c` composes; `r` replies; `a` replies to all. `g i`, `g a`, `g s`, and `g d` open Inbox, All mail, Sent, and Drafts. `?` shows help. Ctrl+Enter or Cmd+Enter confirms sending a draft. Navigation keys do not fire while typing in inputs.

The shared CLI also exposes structured session metadata for other interfaces:

```sh
agent-find 'migration topic' --json --limit 10
agent-find --agent @+agent-handle --json
```

Ordinary `agent-find <pattern>` retains its terminal output. Exact-handle lookup does not search transcript content; its `matches` field is `null`.

## Local boundary

The bridge checks Host and Origin, rejects cross-site API requests, and requires a per-run token header for **all** API reads and mutations. Mutations require same-origin JSON requests. There is no arbitrary path or command endpoint. Message keys are confined to mailbox folders; symlinked files and attachment paths are rejected. Static reader assets contain no private data.

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

Rebuild the pinned Markdown, sanitizer, and diagram libraries plus their license notices:

```sh
npm run build
npm audit --omit=dev --registry=https://registry.npmjs.org
```

Commit `vendor.js`, `package-lock.json`, and `THIRD_PARTY_LICENSES.txt` together when updating dependencies. No runtime CDN requests are needed.

Co-authored-by: AI Simoom Farrier (pi/openai/gpt-6-astra) @+simoom-farrier
