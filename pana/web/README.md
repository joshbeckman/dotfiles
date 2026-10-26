# pana web assets

The PWA that `panad` serves at `/` (WEB-01..08). Plain HTML, CSS, and ES modules: no build step, no framework. `src/web/static.ts` is the allowlist; a file not named there is not served.

| File | What |
|---|---|
| `index.html` | the shell and the six sections |
| `app.js` | hash router, API calls, and per-section rendering |
| `links.js` | pure helpers: `pana://` links, routes, drafts, notification targets |
| `render.js` | Markdown, `pana://` links, authenticated images, Mermaid |
| `push.js` | permission → subscribe → post the subscription |
| `sw.js` | push display and notification click |
| `style.css`, `fonts.css`, `fonts/` | the site style guide: IBM Plex Sans, blue `#002FA7`, orange `#FF7900`, black `#0D0D0D`, white |
| `manifest.webmanifest`, `favicon.svg` | installability |

## Borrowed from agent-mail-web

`renderers.js` and `mermaid-renderer.js` are copied from [`apps/agent-mail-web`](../../../apps/agent-mail-web), together with the prebuilt `vendor.js` (marked + DOMPurify) and `mermaid-vendor.js` (Mermaid). `THIRD_PARTY_LICENSES.txt` and `fonts/LICENSE.txt` come with them. To update a bundle, rebuild it there with `npm ci --ignore-scripts && npm run build`, then copy the output here. Do not edit the bundles by hand.

`vendor.js` loads from `app.js` rather than a `<script defer>` tag, so the renderer is certainly present before the first message renders. `mermaid-vendor.js` loads only when a message contains a `language-mermaid` block, as agent-mail-web does.

## Authorize a window

`panad` prints `panad: open http://127.0.0.1:<port>/#<web-token>`. The token lives in the fragment, which browsers never send to the server. The app stores it and clears the hash. Keep the launch URL private: anyone who has it can act as the user. A window with no usable token, or one that gets a 403, shows **Authorize this app** and accepts the launch URL or the token once.

## Tests

```sh
npm test          # no browser needed
npm run test:web  # drives the installed Chrome through the chrome-devtools CLI
```

The browser suite starts its own `panad` with seeded fake handlers (`test/browser/fakes.ts`) and asserts each section end to end. It needs `chrome-devtools` on `PATH`; without it the suite skips instead of downloading a browser.
