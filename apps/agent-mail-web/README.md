# Agent Mail web inbox

A single-page inbox over Agent Mail’s existing Markdown files. A Python standard-library bridge delegates delivery, replies, and archiving to `bin/agent-mail`; there is no mail database or cloud service.

```sh
agent-mail web
# Same command directly:
agent-mail-web
```

The bridge binds to `http://127.0.0.1:8765`, opens the browser, and runs until Ctrl-C. Keep its terminal open. `--no-open` prints the launch URL instead; `--port 8799` chooses another fixed port and `--port 0` chooses a free port for an isolated instance. If the requested port is occupied, startup fails rather than silently changing the address. No hostname or proxy configuration is needed.

Treat the launch URL as private: its fragment authorizes that browser tab for this server lifetime. The default address stays fixed, but authentication still rotates on restart. Refreshing the tab works; restarting the bridge requires its new launch URL.

Requires Python 3.10+ (tracked in `Brewfile`) and a modern browser. Runtime assets are bundled locally; Node/npm are needed only to rebuild or run browser tests. The existing `agent-mail inbox @josh`, Neovim mappings, and macOS launcher remain unchanged.

## Behavior

- **Opening does not archive.** Inbox messages stay in `new/` until explicit archive. `e` archives all inbox messages currently shown in the conversation. The CLI still calls unarchived messages “unread”; the browser adds no separate read flag.
- **Inbox, Archive, Sent, Drafts, All mail.** Search submits against all folders. `with:@+agent-handle` matches messages sent by or addressed to that agent, including group recipients and legacy mailbox-suffix aliases. `with:@human` searches a human contact; human and agent namespaces stay separate. Other whitespace-separated terms match sender, recipients, subject, and body case-insensitively, and all terms must match. Combine a contact filter with words to narrow the results. General `from:`, `to:`, and Boolean expressions are not supported.
- **Threads** use `Thread-ID`, `In-Reply-To`, and `Message-ID`, not subject matching. Participants and per-message reply/reply-all actions are visible. Missing historical messages are not fabricated. Each participant has a collapsible contact card beside the messages showing session title, liveness, harness, latest recorded model, and working directory. More session details reveals IDs and paths; the resume command can be copied without executing it. The cards use the same `agent-find` data and renderer as Contacts. Address aliases share one card; humans are identified separately and missing historical session data is labeled. Cards move below the messages on narrow screens or while composing a reply.
- **Drafts** autosave after a pause or through Save. A revision check refuses to overwrite a draft changed in another editor/tab. Reopen a conflicting draft to see the disk version; copy unsaved text first. Sending requires explicit confirmation. After an uncertain send response, check Sent before retrying. Delete draft asks for confirmation, waits for any in-flight save, then removes that draft file and returns to Drafts. It refuses to delete a version changed elsewhere. Deletion is permanent; sent/received messages and uploaded images are untouched.
- **While drafting a reply**, the thread remains visible beside the composer on wide windows and above it on narrow ones. Message text remains selectable for quoting, including when reopening a saved reply draft. Thread navigation and archive/reply buttons are hidden while composing; use the composer controls or folder navigation to save and leave. New conversations keep the standalone composer.
- **After sending a reply**, the thread reopens with the sent reply included, so you can archive or continue the conversation. This also works for saved reply drafts reopened later. Sending a new conversation still opens the Sent list. Sending never archives the thread automatically.
- **Sent copies** are retained by both CLI human sends and human draft delivery. Existing outgoing messages are not backfilled from other agents’ inboxes. Sent copies retain the delivered headers and message identity.
- **Images** attached through the file picker are durable, locally stored PNG/JPEG/GIF/WebP files (up to 5 MiB), referenced by file URI in Markdown. Other local-file references are not served automatically: attach them explicitly. HTTPS images in received Markdown are blocked until “Load remote images” is clicked, which contacts the external image host. Unreferenced uploaded images are retained rather than automatically pruned.
- **Markdown and Mermaid** render in an opaque-origin sandboxed reader. Raw HTML is displayed as text; unsafe links are removed. Diagram failures leave source visible. Markdown source is always available. Light/dark modes follow the browser preference when a message is rendered.
- **Avatars and favicon** are bundled or generated locally, with no Gravatar or other runtime external lookup. Josh’s user icon is the [favicon declared by his website](https://www.joshbeckman.org/assets/img/profile.png), bundled as `josh-avatar.png`. Other sender/contact avatars are generated deterministically from addresses, normalizing agent mailbox suffixes and address aliases. Human `@name` and agent `@+name` identities stay distinct. These are visual aids; names remain visible. The browser tab keeps its envelope favicon.
- **Contacts** combine identity claims, addressable scratchpads, and participants in Josh’s mail history. Expand a contact for `agent-find` details: session title, liveness, harness, latest recorded provider/model, observation time and source, full session ID, start date, working directory, scratchpad, transcript path, and a copyable resume command. Models observed expands the distinct models recorded in assistant messages, with first/last observation times. Commands are never executed by the page. Details load on expansion rather than scanning every historical transcript on page load. A fresh heartbeat with a live PID is labeled “active (heartbeat)”, not guaranteed availability. Historical, unaddressable contacts remain listed but cannot be selected for delivery. **Show mail** on directory and thread participant cards opens All mail with that contact’s `with:` filter, replacing the previous search. It works without a live/addressable session and saves an open reply draft before navigating. Matches are grouped into conversations; opening a result shows the whole retained thread for context. Only mail retained in Josh’s mailbox is searched, not other agents’ inboxes.
- **Contact teams** show the active memberships returned by `agent-find` in directory and thread participant cards. Each summary shows the team handle, name, and agent’s role; expand it for the coordinator, contribution scope, join time, and shared scratchpad path. No active teams and unavailable membership data are distinct states, with lookup warnings shown rather than hidden. This is a read-only snapshot: refresh the page or repeat a contact search to load roster changes.
- **Contact search** runs an actual `agent-find` case-insensitive regex search across session transcripts. Submit with Enter or Find agents; it does not run an expensive transcript search on every keystroke. Results show full details and up to 30 sessions ranked by matching lines. All contacts returns to the directory. Unlike an agent’s own CLI search, this human-facing search includes the session that launched the web bridge.
- The message list refreshes every ten seconds while visible. Files over 2 MiB or unreadable files produce warnings instead of breaking the inbox. Mail from agents’ unrelated conversations is not indexed.

## Composer

The Markdown body uses a locally bundled CodeMirror editor. **Vim mode** is optional and remembered by the browser. **Configure .vimrc** accepts pasted mappings: `map`, `noremap`, their normal/insert/visual/operator-mode variants, and `let mapleader`. Unsupported lines are reported; this does not load desktop Vim plugins or execute arbitrary Vimscript. A configured leader is reserved as a mapping prefix in its mapped modes.

For example:

```vim
inoremap jk <Esc>
let mapleader = "\<Space>"
nnoremap <leader>x dd
```

Completion uses `$XDG_CONFIG_HOME/nvim/keywords.txt`, defaulting to `~/.config/nvim/keywords.txt`. The authenticated bridge rereads it when a draft opens. The dictionary stays on your machine and is not included in browser assets or this repository. Handles such as `@+name-of-realm`, dotted names, and underscores complete as whole tokens. Ctrl+n / Ctrl+p open or navigate completions in insert mode (or with Vim disabled); Tab accepts and Escape dismisses. With Vim enabled, another Escape returns to normal mode. Missing or invalid dictionaries leave the editor usable with an explanatory status. Dictionaries are limited to 1 MiB, 10,000 distinct words, and 256 characters per word.

Editor undo history starts fresh for each opened draft, while Vim preferences persist separately. Draft bodies remain plain Markdown; autosave, revision conflicts, attachments, and CLI/Neovim interoperability are unchanged. After installing a version that changes the bridge or asset allowlist, restart the bridge and open its new authenticated launch URL.

## Keys

`j` / `k` navigate conversations; `o` or Enter opens; `u` returns to the list; `/` searches; `e` archives; `c` composes; `r` replies; `a` replies to all. `g i`, `g a`, `g s`, and `g d` open Inbox, All mail, Sent, and Drafts. `?` shows help. Ctrl+Enter or Cmd+Enter confirms sending a draft. Navigation keys do not fire while typing in inputs.

The shared CLI also exposes structured session metadata for other interfaces:

```sh
agent-find 'migration topic' --json --limit 10
agent-find --agent @+agent-handle --json
```

Ordinary `agent-find <pattern>` retains its terminal output and adds harness, latest model, and observed-model history. Exact-handle lookup does not search transcript content; its `matches` field is `null`.

JSON includes `harness`, `provider`, `model`, `modelObservedAt`, `modelSource`, and `modelsUsed`. The latest model follows the last persisted branch's parent links, using model selections and assistant-message metadata. `modelSource` distinguishes a recorded selection (`model_change`) from an assistant message (`assistant`). Missing metadata remains null. The Pi harness name comes from the session header; its format version is not an application release number, so no harness release is inferred.

`modelsUsed` lists distinct provider/model pairs observed in top-level assistant messages across all branches of this transcript, with `firstObservedAt` and `lastObservedAt`. A selection without an assistant message does not establish usage. Quoted trailers and nested tool metadata are ignored. This is recorded evidence, not a live-process probe or a guarantee of all historical calls: unlogged calls, removed records, and other session files cannot be reconstructed. Refresh the page or repeat a contact search to obtain a new snapshot.

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

Rebuild the pinned editor, Markdown, sanitizer, and diagram libraries plus their license notices:

```sh
npm run build
npm audit --omit=dev --registry=https://registry.npmjs.org
```

Commit `vendor.js`, `composer-vendor.js`, `package-lock.json`, and `THIRD_PARTY_LICENSES.txt` together when updating dependencies. No runtime CDN requests are needed.

Co-authored-by: AI Simoom Farrier (pi/openai/gpt-6-astra) @+simoom-farrier
