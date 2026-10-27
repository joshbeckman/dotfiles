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

The Memory section is one view at a time (MEM-11): `#/memory` lists files and the log, `#/memory/files/<path>` is a rendered file with a Source toggle, `#/memory/commits/<hash>` is `git show`, and `#/memory/edit/<path>` (or `#/memory/new`) is the full-view editor.

## Authorize a window

`panad` prints `panad: open http://127.0.0.1:<port>/#<web-token>`. The token lives in the fragment, which browsers never send to the server. The app stores it and clears the hash. Keep the launch URL private: anyone who has it can act as the user. A window with no usable token, or one that gets a 403, shows **Authorize this app** and accepts the launch URL or the token once.

## Tests

```sh
npm test          # no browser needed
npm run test:web  # drives the installed Chrome through the chrome-devtools CLI
```

The browser suite starts a real test `panad` with the scripted faux model, seeds it through the API, and asserts each section end to end, checking results through the API too. It needs `chrome-devtools` on `PATH`; without it the suite skips instead of downloading a browser. `test/integration.test.ts` also runs `views.js` against real handler output under `npm test`.

`node test/browser/screens.ts DIR LABEL` seeds a domain (`test/browser/seed.ts`) and saves a full-page screenshot of every section to `DIR/LABEL-<section>.png`, for reviewing a visual change.
