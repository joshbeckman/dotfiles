# pana web assets

The PWA that `panad` serves at `/` (WEB-01..08). Plain HTML, CSS, and ES modules: no build step, no framework. `src/web/static.ts` is the allowlist; a file not named there is not served.

| File | What |
|---|---|
| `index.html` | the shell and the six sections |
| `app.js` | hash router, API calls, and per-section rendering |
| `links.js` | pure helpers: `pana://` links, routes, drafts, notification targets, and an uploaded file's Markdown reference (FIL-02, FIL-06) |
| `views.js` | the only reader of handler response fields, the schedule form's request body, and participant colors (UX-06) |
| `render.js` | Markdown, `pana://` links, authenticated images, Mermaid |
| `push.js` | permission → subscribe → post the subscription, and the cause and fix for each failure (UX-01) |
| `keys.js` | the keymap, the key reader, and the help overlay's rows (UX-02, UX-08) |
| `palette.js` | the command palette's commands, fuzzy match, and the three stores' hits as rows (UX-15) |
| `sw.js` | push display and notification click |
| `memory-editor-vendor.js` | the memory editor bundle: CodeMirror 6 with line numbers and Markdown highlighting, loaded only when editing (MEM-12) |
| `style.css`, `fonts.css`, `fonts/` | the site style guide: IBM Plex Sans, IBM Plex Mono (Berkeley Mono when installed), and the palette black `#0D0D0D`, white, blue `#002FA7`, orange `#FF7900`, purple `#903465`, green `#237F52`, red `#BD2024`, yellow `#FFCC00`; one spacing scale, `--s1` to `--s6` |
| `manifest.webmanifest`, `favicon.svg` | installability |

## Borrowed from agent-mail-web

`renderers.js` and `mermaid-renderer.js` are copied from [`apps/agent-mail-web`](../../../apps/agent-mail-web), together with the prebuilt `vendor.js` (marked + DOMPurify) and `mermaid-vendor.js` (Mermaid). `THIRD_PARTY_LICENSES.txt` and `fonts/LICENSE.txt` come with them. To update a bundle, rebuild it there with `npm ci --ignore-scripts && npm run build`, then copy the output here. Do not edit the bundles by hand.

`vendor.js` loads from `app.js` rather than a `<script defer>` tag, so the renderer is certainly present before the first message renders. `mermaid-vendor.js` loads only when a message contains a `language-mermaid` block, as agent-mail-web does. `memory-editor-vendor.js` is the same idea for the memory editor: built in agent-mail-web from a small `memory-editor.js` entry (esbuild, IIFE, global `PanaMemoryEditor`) and fetched by `app.js` on the first edit, so browsing memory never pays for CodeMirror.

Memory files have canonical `pana://<domain>/memory/files/<path>` URLs, with each relative repository path segment percent-encoded. They resolve to the latest published file on `main`, not a writer worktree or a historical revision. The file API exposes these URLs and clicking an open file’s heading copies its URL, just like thread, message, session, and schedule self-identifiers (UX-17).

The Memory section is one view at a time (MEM-11): `#/memory` lists files and the log, `#/memory/files/<path>` is a rendered file with a Source toggle, `#/memory/commits/<hash>` is `git show`, and `#/memory/edit/<path>` (or `#/memory/new`) is the full-view editor.

On phones, editor text is 1rem (16px at the default root size) to avoid iOS focus zoom and horizontal panning, including in Home Screen web apps. CodeMirror draws its own caret, so `.cm-cursor` follows the theme's text color and is 2px wide on phones; `caret-color` alone does not style it. Selection rendering and desktop text sizing are unchanged. See CodeMirror's [styling guide](https://codemirror.net/examples/styling/) and [`drawSelection` reference](https://codemirror.net/docs/ref/#view.drawSelection). The desktop/phone light/dark regression, including live theme changes, runs with:

```sh
npm run test:web -- test/browser/memory-editor.spec.ts
```

Chrome emulation checks computed font size, cursor contrast/color, and overflow, but does not prove iOS keyboard behavior. For an iOS release check, tap and type with the software keyboard in both Safari and an installed Home Screen app: the page should stay at 1× scale, keep the gutter visible, and keep the caret visible at the end of a long file.

## Authorize a window

`panad` prints `panad: open http://127.0.0.1:<port>/#<web-token>`. The token lives in the fragment, which browsers never send to the server. The app stores it and clears the hash. Keep the launch URL private: anyone who has it can act as the user. A window with no usable token, or one that gets a 403, shows **Authorize this app** and accepts the launch URL or the token once.

## Tests

```sh
npm test          # no browser needed
npm run test:web  # drives the installed Chrome through the chrome-devtools CLI
```

The browser suite starts a real test `panad` with the scripted faux model, seeds it through the API, and asserts each section end to end, checking results through the API too. It needs `chrome-devtools` on `PATH`; without it the suite skips instead of downloading a browser. `test/integration.test.ts` also runs `views.js` against real handler output under `npm test`.

`node test/browser/screens.ts DIR LABEL` seeds a domain (`test/browser/seed.ts`) and saves a full-page screenshot of every section to `DIR/LABEL-<section>.png`, for reviewing a visual change.

Memory saves send the editor's read commit as `baseCommit` (`null` for a new file). The server fast-forwards clean writer worktrees before applying edits and rejects dirty/unpublished local work instead of overwriting or publishing it. A 409 `stale_file` leaves editor text intact: copy the edits, reload the current file, then reapply them. Existing unpublished commits from older failed saves still need explicit worktree conflict resolution; retries never discard them or add more commits.

### Signal typography

Departure Mono is self-hosted under SIL OFL 1.1 (see `fonts/DepartureMono-LICENSE.txt`).
Only session state badges and shortcut keycaps use it, at 0.6875rem (11px at the default
root size), regular weight. Unread counts, generic badges (edited/file status), navigation,
timestamps, prose, and source keep their existing Plex/Berkeley font roles. Avoid extending
Departure into tightly adjacent metadata: the mixed lettering is visually tiring.

### Message typography

Thread messages and rendered transcript text opt into `.prose`; the app's headings,
raw/tool output, and memory keep their own styles. Wide Markdown tables retain semantic
`table` elements inside keyboard-focusable, locally scrolling regions. The specimen in
`test/fixtures/message-prose.md` covers heading levels, paragraph rhythm, nested content,
code, images, and table overflow. Run its desktop/390px light/dark browser regression with:

```sh
npm run test:web -- test/browser/prose.spec.ts
PANA_PROSE_SHOTS=docs npm run test:web -- test/browser/prose.spec.ts
```

### Selection indicators

Active navigation, j/k-selected rows and messages, and the command palette's active
result share inset corner brackets and a tinted background. Navigation uses orange
corners; content uses the theme's link color. These overlays do not affect layout
or intercept clicks. Native keyboard-focus indicators remain separate. The brand
and navigation links are vertically centered; on phones, navigation keeps its own
horizontally scrolling row. Exercise desktop/phone light/dark regressions with:

```sh
npm run test:web -- test/browser/selection.spec.ts
```

The Inbox navigation uses an orange dot for any unread activity, hidden at zero.
Its tooltip and accessible image label retain the total unread delivery count
(including messages beyond the first inbox page). Numeric counts on inbox rows
are unchanged. This keeps navigation width independent of the count.

### Large thread history

Opening a thread renders the newest 30 messages, or a 30-message window around a
linked message. Earlier/later controls reveal history in 30-message chunks without
changing message order, the reply head, or scroll position when prepending history.
Keyboard focus stays on the history control (or newly loaded content at the end).
The API still returns the full thread: this bounds initial Markdown/image/diagram
work, not transfer size or server query cost. Run the large-thread regression with:

```sh
npm run test:web -- test/browser/thread-window.spec.ts
```

### Images in a thread

A message body carries its pictures inline, and one page of messages can hold dozens
of them, each a megabyte or more. The page therefore never waits for bytes:
`renderMessage()` puts the prose, links, and tables in place and returns, and the
files and Mermaid diagrams finish behind it. Three rules keep the bytes from
stalling a thread:

- **One queue.** Every message on the page shares a single line of six requests
  (`FILE_CONCURRENCY`), so the picture the reader is looking at is not stuck behind
  forty others on the same phone connection.
- **Visible first.** An image is fetched when it comes within 800 px of the viewport
  (`FILE_MARGIN`) and not before; the rest arrive as the reader scrolls to them.
  Without `IntersectionObserver`, everything loads at once through the same queue.
- **One copy per file.** `app.js` keeps a blob URL per file path for the life of the
  window (`fileUrls`, capped at 256), and `GET /files/:id/:name` answers with
  `cache-control: private, max-age=604800`, because a file's bytes never change. A
  picture shown in three messages is one request, and reopening a thread costs none.

On this host, a 20-message thread with two screen-sized photos per message, phone
viewport, throttled to Slow 4G: first paint 49.5 s → 1.0 s, the pictures on screen
49.5 s → 7.7 s, and a second visit in a fresh tab transferred 0 bytes instead of
4.6 MB. The visible result is unchanged, which is why this change has no screenshot.
Run the regression with:

```sh
npm run test:web -- test/browser/thread-images.spec.ts
```

Inline copies are only as small as the host's resizer makes them: with no `sips`,
`magick`, or `convert` installed, `?w=1024` serves the original bytes (FIL-07), so a
five-megabyte phone photo is still five megabytes. Install one to shrink them.
