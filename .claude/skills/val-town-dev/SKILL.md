---
name: val-town-dev
description: This skill should be used when the user asks to "create a val", "make a val town project", "build a val", "deploy to val town", "set up a val", "clone a val", "remix a val", or mentions Val Town, vals, or the vt CLI. Provides Val Town platform knowledge, standard libraries, and vt CLI workflows.
user-invocable: true
---

# Val Town Development

Create, develop, and deploy vals on Val Town using the `vt` CLI.

## Core Workflow

### Creating a New Val

```bash
vt create <valName> [targetDir]
```

Options:
- `--public` (default), `--private`, `--unlisted` for visibility
- `--org-name <org>` to create under an organization
- `-d, --description <desc>` to set a description
- `--upload-if-exists` to upload existing files in the target directory

After creation, `cd` into the val directory and run `vt watch` to sync changes.

### Cloning an Existing Val

```bash
vt clone <username/valName> [targetDir]
```

Accepts a `username/valName` or a full `https://www.val.town/x/username/valName` URL.

### Remixing a Val

```bash
vt remix <fromValUri> [newValName] [targetDir]
```

Bootstrap from existing vals. Example: `vt remix std/reactHonoStarter myWebsite`

### Development Loop

1. `vt watch` — auto-syncs local changes to Val Town
2. `vt browse` — opens the val in a browser
3. `vt tail` — streams logs for debugging
4. `vt push` — pushes local changes (use `-d` for dry run)
5. `vt status` — shows working tree status

### Branching

```bash
vt checkout -b my-branch   # create and switch to a new branch
vt branch                   # list branches
vt checkout main            # switch back to main
```

## Val Types (Triggers)

Every val exports a default function. The function signature determines the trigger type.

### HTTP Trigger

```ts
export default async function (req: Request) {
  return new Response("Hello World");
}
```

### Cron Trigger

```ts
export default async function () {
  // runs on a schedule
}
```

### Email Trigger

```ts
export default async function (email: Email) {
  // process incoming email
}
```

## Key Platform Constraints

- Val Town runs on **Deno** in a serverless context, not Node.js
- Generate code in **TypeScript or TSX**
- Use `https://esm.sh` for npm/Deno dependencies (works in both server and browser)
- Use `Deno.env.get('KEY')` for environment variables — never bake secrets into code
- Val Town only supports text files, not binary
- No incoming WebSocket connections — use polling, long polling, or SSE
- Do NOT use Deno KV, `alert()`, `prompt()`, or `confirm()`
- `Response.redirect` is broken — use `new Response(null, { status: 302, headers: { Location: "/path" } })`
- Hono is the recommended API framework; entry point: `export default app.fetch`
- Do NOT use Hono's `serveStatic` middleware or `@hono/cors` — Val Town handles CORS automatically
- For static files, use `serveFile` and `readFile` from `https://esm.town/v/std/utils/index.ts`
- When modifying SQLite schemas, change the table name (append `_2`, `_3`, etc.) instead of ALTER TABLE
- Pin all React dependencies to 18.2.0 and include `/** @jsxImportSource https://esm.sh/react@18.2.0 */`
- Default to TailwindCSS via `<script src="https://cdn.twind.style" crossorigin></script>`
- Add `<script src="https://esm.town/v/std/catch"></script>` to HTML for client-side error capture
- Always include error re-throwing in top-level Hono apps:
  ```ts
  app.onError((err) => Promise.reject(err));
  ```

## Standard Libraries (Quick Reference)

Val Town provides hosted services importable via `https://esm.town/v/std/`:

| Library | Import | Purpose |
|---------|--------|---------|
| Blob | `https://esm.town/v/std/blob` | Key-value storage (JSON, text, binary) |
| SQLite | `https://esm.town/v/stevekrouse/sqlite/main.tsx` | Persistent SQL database |
| OpenAI | `https://esm.town/v/std/openai` | GPT completions (pre-configured) |
| Email | `https://esm.town/v/std/email` | Send emails to val owner |
| Utils | `https://esm.town/v/std/utils/index.ts` | `serveFile`, `readFile`, `listFiles` |

For detailed usage examples, API patterns, and project structure guidance, consult **`references/platform-guide.md`**.

## Typical Project Structure

```
├── backend/
│   ├── database/
│   │   ├── migrations.ts
│   │   └── queries.ts
│   ├── routes/
│   │   └── [route].ts
│   └── index.ts            # Main entry point
├── frontend/
│   ├── components/
│   │   └── App.tsx
│   ├── index.html
│   ├── index.tsx
│   └── style.css
└── shared/
    └── utils.ts            # Shared types (no Deno keyword here)
```

## Development Checklist

Before pushing a val:

- [ ] Default export matches intended trigger type
- [ ] No hardcoded secrets — using `Deno.env.get()`
- [ ] Imports use `https://esm.sh` (not bare npm specifiers)
- [ ] React deps pinned to 18.2.0 with JSX pragma
- [ ] SQLite tables use CREATE IF NOT EXISTS with versioned names
- [ ] Hono app has `app.onError((err) => Promise.reject(err))`
- [ ] Entry point is `export default app.fetch` for Hono apps

## Additional Resources

### Reference Files

For detailed library examples, Hono patterns, and platform gotchas, consult:
- **`references/platform-guide.md`** — Full Val Town platform guide with code examples for all standard libraries, utility functions, backend patterns, and common pitfalls
