# Val Town Platform Guide

Comprehensive reference for Val Town standard libraries, utility functions, project patterns, and platform-specific behavior.

## Standard Libraries — Detailed Usage

### Blob Storage

Key-value store for JSON, text, and binary data.

```ts
import { blob } from "https://esm.town/v/std/blob";

await blob.setJSON("myKey", { hello: "world" });
let data = await blob.getJSON("myKey");
let keys = await blob.list("app_");
await blob.delete("myKey");
```

### SQLite

Persistent SQL database. Always create tables before querying. When changing schemas, create a new table with a versioned name instead of using ALTER TABLE.

```ts
import { sqlite } from "https://esm.town/v/stevekrouse/sqlite/main.tsx";

const TABLE_NAME = 'my_app_users_2';

await sqlite.execute(`CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL
)`);

const { rows } = await sqlite.execute(
  `SELECT * FROM ${TABLE_NAME} WHERE id = ?`, [1]
);
```

### OpenAI

Pre-configured OpenAI client — no API key needed.

```ts
import { OpenAI } from "https://esm.town/v/std/openai";

const openai = new OpenAI();
const completion = await openai.chat.completions.create({
  messages: [
    { role: "user", content: "Say hello in a creative way" },
  ],
  model: "gpt-4o-mini",
  max_tokens: 30,
});
```

### Email

Send emails to the val owner by default.

```ts
import { email } from "https://esm.town/v/std/email";

await email({
  subject: "Hi",
  text: "Hi",
  html: "<h1>Hi</h1>"
});
```

## Utility Functions

Import with version pins:

```ts
import { readFile, serveFile, listFiles } from "https://esm.town/v/std/utils/index.ts";
```

### serveFile — Serve project files with proper content types

```ts
app.get("/frontend/*", c => serveFile(c.req.path, import.meta.url));
app.get("/shared/*", c => serveFile(c.req.path, import.meta.url));
```

### readFile — Read files from within the project

```ts
const fileContent = await readFile("/frontend/index.html", import.meta.url);
```

### listFiles — List all files in the project

```ts
const files = await listFiles(import.meta.url);
```

## Backend (Hono) Patterns

### Basic Hono Setup

```ts
import { Hono } from "https://esm.sh/hono";
import { readFile, serveFile } from "https://esm.town/v/std/utils/index.ts";

const app = new Hono();

// Always re-throw errors for full stack traces
app.onError((err) => Promise.reject(err));

// Serve static files
app.get("/frontend/*", c => serveFile(c.req.path, import.meta.url));
app.get("/shared/*", c => serveFile(c.req.path, import.meta.url));

// Serve index.html with injected initial data
app.get("/", async c => {
  let html = await readFile("/frontend/index.html", import.meta.url);

  const initialData = await fetchInitialData();
  const dataScript = `<script>
    window.__INITIAL_DATA__ = ${JSON.stringify(initialData)};
  </script>`;

  html = html.replace("</head>", `${dataScript}</head>`);
  return c.html(html);
});

// Entry point for HTTP vals
export default app.fetch;
```

### Cookies in Hono

```ts
import { deleteCookie, getCookie, setCookie } from "npm:hono/cookie";
```

### Redirects

Use `c.redirect()` in Hono. Outside Hono:

```ts
return new Response(null, {
  status: 302,
  headers: { Location: "/place/to/redirect" }
});
```

Do NOT use `Response.redirect` — it is broken on Val Town.

## Frontend Patterns

### React Setup

Start every React file with the JSX pragma:

```tsx
/** @jsxImportSource https://esm.sh/react@18.2.0 */
```

Pin all React dependencies and sub-dependencies to 18.2.0:

```ts
import React from "https://esm.sh/react@18.2.0";
import ReactDOM from "https://esm.sh/react-dom@18.2.0";
import SomeLib from "https://esm.sh/some-react-lib?deps=react@18.2.0,react-dom@18.2.0";
```

### HTML Template

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>My Val</title>
  <script src="https://cdn.twind.style" crossorigin></script>
  <script src="https://esm.town/v/std/catch"></script>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/frontend/index.tsx"></script>
</body>
</html>
```

### Images

Avoid external or base64 images. Use emojis, unicode symbols, or icon fonts. For AI-generated images inline:

```html
<img src="https://maxm-imggenurl.web.val.run/the-description-of-your-image" />
```

## Environment and Imports

- Use `Deno.env.get('KEY')` for environment variables
- Prefer APIs that don't require keys when possible
- Use `https://esm.sh` for all npm/Deno imports (ensures server + browser compatibility)
- Code in `shared/` must work in both frontend and backend — cannot use `Deno` keyword there

## Common Gotchas

1. **No Deno KV** — use Blob Storage or SQLite instead
2. **No WebSockets** — use polling, long polling, or server-sent events
3. **No `alert()`/`prompt()`/`confirm()`** — browser APIs not available
4. **No `serveStatic`** — use `serveFile` from std/utils
5. **No `@hono/cors`** — Val Town handles CORS automatically
6. **No ALTER TABLE** — create new versioned tables and copy data
7. **No binary files** — Val Town only supports text files
8. **`Response.redirect` is broken** — use `new Response(null, { status: 302, headers: { Location: url } })`
9. **React version mismatches** — all deps must be pinned to 18.2.0
10. **Weather APIs** — use open-meteo (no API key) or wttr.in as backup
