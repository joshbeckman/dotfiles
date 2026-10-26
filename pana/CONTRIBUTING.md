# Contributing to pana

[SPEC.md](SPEC.md) is the acceptance test. Each work package (WP) owns a set of `- [ ]` items, and every item needs a Vitest test whose name starts with its ID, e.g. `it("THR-05 ...")`. Check an item off in SPEC.md only when its test passes.

## Run it

```sh
cd pana
npm install
npm test           # Vitest, all suites (no browser)
npm run test:web   # the PWA browser suite against a real test panad (installed Chrome + chrome-devtools CLI)
PANA_SMOKE_FAUX=1 scripts/smoke   # a throwaway panad end to end; drop the variable and pass a key for a real model
npx tsc --noEmit   # must be clean before you report
```

Node 22.18 or newer runs the `.ts` sources directly, so there is no build step. `bin/pana` and `bin/panad` import `src/cli/index.ts` and `src/server/index.ts`.

## Layout

One directory per work package, so parallel agents rarely edit the same file.

| Path | Owner | What |
|---|---|---|
| `src/config` | WP0 | `config.json`, defaults, state layout |
| `src/ids` | WP0 | ULIDs, `parseRef`, `formatUrl` |
| `src/db` | WP0 | schema, migrations, the shared adapter, wakes |
| `src/api` | WP0 | route table, error shapes, exit codes, HTTP client |
| `src/server` | WP0, WP1 | `startPanad`, request pipeline, runtime |
| `src/cli` | WP1 | the `pana` command: parsing, output, and the one command layer the extension tools also use |
| `src/threads` | WP2 | threads, messages, inbox, notices, files |
| `src/sessions` | WP3 | session runtime; `wake.ts` submits session wakes |
| `src/extension` | WP4 | the `pana` pi-durable extension |
| `src/memory` | WP5 | memory |
| `src/schedules` | WP6 | scheduling |
| `src/search` | WP7 | subjects and search |
| `src/web`, `src/push` | WP8 | the PWA and Web Push |
| `web/` | WP8 | the PWA assets served by panad |
| `test/harness` | WP0 | `startTestPanad`, fake clock, scripted model |
| `test/fixtures/faux-panad.ts` | WP10 | the real `panad` entry point with a scripted faux model, for child-process tests |
| `scripts/smoke` | WP10 | a real-model smoke run on a temp state directory |

Put your tests in `test/<package>.test.ts`. Mark unbuilt work with `TODO(WPn)`.

## Contracts

Change these only with a reason in your report.

- **Schema.** `src/db/schema.ts`. Add a new numbered migration at the end of `MIGRATIONS`. Never edit or renumber one that has shipped.
- **Routes.** `src/api/routes.ts`. Handler names are stable.
- **Errors.** Throw `ApiError` from `src/api/errors.ts`. The body is `{"error": {"code", "message", ...details}}`, and `statusToExitCode` maps 400 → 2, 404 → 4, 409 → 3, 402 → 5, and anything else non-2xx → 1.
- **Callers.** A handler gets `ctx.caller`, a user or a session, already resolved and authorized for the transport. Do not read `Pana-Caller` or `Authorization` yourself.
- **Clock and IDs.** Use `runtime.clock` and `runtime.newId()`, never `Date.now()` or a timer of your own. The fake clock then drives your code too.

## Writing to the database

pi-durable and pana share one SQLite connection, `runtime.db`. Write pana rows through `runtime.db.write(fn)` or `runtime.db.atomically(fn)`, never with a bare `runtime.db.run()`. A write outside them can be pulled into another caller's transaction.

`atomically` also captures pi-durable commits made while `fn` runs. A message append that wakes a session looks like this:

```ts
await runtime.db.atomically(async (tx) => {
	await tx.run("INSERT INTO messages ...", ...);
	await tx.run("INSERT INTO deliveries (..., wake_request_id) VALUES (..., ?)", ..., wakeRequestId(deliveryId));
	await wakeDeliveries(tx, wakes, runtime.wake); // calls conversation.submit() inside the same transaction
});
```

A crash anywhere before COMMIT leaves none of it. If `fn` throws after a submit already joined, the transaction commits what it has and rethrows, and the startup sweep finishes the remaining wakes by `requestId`. The comment at the top of `src/db/atomic.ts` explains why. `test/harness/wake-fixture.ts` is a working example.

Never `UPDATE` or `DELETE` rows in `messages` (EDT-04). Edits are rows in `message_events`.

## Add a route

1. If the route is new, add it to `ROUTES` in `src/api/routes.ts` and to the API table in SPEC.md.
2. Implement it in your package's `handlers.ts`, keyed by the route name:

   ```ts
   export const handlers: Handlers = {
   	"threads.read": async (ctx) => {
   		const thread = await ctx.runtime.db.get("SELECT * FROM threads WHERE id = ?", ctx.params.id);
   		if (!thread) throw ApiError.notFound(`thread ${ctx.params.id}`);
   		return { status: 200, body: thread };
   	},
   };
   ```

3. `src/server/handlers.ts` already merges every package's `handlers`. Until a handler exists, the route answers 501 `not_implemented`.

## Use the test harness

```ts
import { startTestPanad, type TestPanad } from "./harness/index.ts";

let t: TestPanad;
afterEach(() => t.close());

it("THR-04 ...", async () => {
	t = await startTestPanad({
		script: [
			{ toolCalls: [{ name: "pana_reply", args: { body: "hi" } }], usage: { costUsd: 0.01 } },
			{ text: "done" },
			{ fail: "provider error" },
		],
	});
	const res = await t.client.post("/threads", { to: ["joshbeckman"], body: "hello" });
	const asSession = await t.client.get("/inbox", { caller: sessionId });
	await t.clock.advance(60_000); // fires due pi-durable sleeps and runtime.clock timers
});
```

- `t.client` talks to the Unix socket as the user, or as a session with `{ caller }`. `t.tcp` talks to TCP with the web token.
- `t.runtime` is the live panad: `db`, `harness`, `config`, `paths`, `clock`, `newId`, `url`.
- `t.model.append(turns)` queues more model turns. Turns are consumed in order across all sessions.
- `startTestPanad({ stateDir: t.dir })` after `t.stop()` restarts on the same state.
- Pass `handlers`, `registry`, `settings`, or `wake` to replace a piece another package has not built yet.
- The domain is `test.example` and the user is `tester`. Retries are off, so a scripted failure fails the run.

Tests never call a real model, never touch `~/.local/state/pana`, and never need the network.
