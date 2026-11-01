# Vendored build source for pana's bundles

Agent Mail is retired. `bin/agent-mail`, `bin/agent-mail2`, and `bin/agent-mail-web` are gone,
`setup` stops and disables their units, and no session sends or reads mail any more. This
directory survives for one reason: it pins the packages and entry points that build three
bundles pana serves from `pana/web/`.

| entry | bundle | consumer |
|---|---|---|
| `renderers.js` | `vendor.js` (marked + DOMPurify) | `pana/web/app.js` and `render.js` |
| `mermaid-renderer.js` | `mermaid-vendor.js` (Mermaid) | `pana/web/render.js` |
| `memory-editor.js` | `memory-editor-vendor.js` (CodeMirror 6, global `PanaMemoryEditor`) | pana's memory editor |

Nothing else here runs. The inbox UI (`index.html`, `app.js`, `style.css`, the reader and
transcript pages, `sw.js`, the icons) and its browser test (`browser-test.mjs`) drove the
retired bridge; they are kept with the build so a rebuild reproduces what pana ships, and
their documentation lives in this file's history.

## Build

```sh
cd apps/agent-mail-web
npm ci --ignore-scripts
npm run build
```

`build.mjs` regenerates `vendor.js`, `mermaid-vendor.js`, `composer-vendor.js`,
`memory-editor-vendor.js`, and `THIRD_PARTY_LICENSES.txt` from `package-lock.json`. Copy the
output pana consumes into `pana/web/` ([pana/web/README.md](../../pana/web/README.md)) and
commit the bundles, the lockfile, and the licence notices together. Do not edit a bundle by
hand.

`npm test` needs the deleted bridge to serve the app, so it cannot run here; use `git log` on
this directory if the bridge ever has to come back.

Co-authored-by: AI Simoom Farrier @+simoom-farrier
Co-authored-by: AI Carrick Bailey of Hearth @+carrick-bailey-of-hearth
