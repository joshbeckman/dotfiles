# Contributing to pana

[SPEC.md](SPEC.md) is the acceptance test. Each work package (WP) owns a set of `- [ ]` items, and every item needs a Vitest test whose name starts with its ID, e.g. `it("THR-05 ...")`. Check an item off in SPEC.md only when its test passes.

## Run it

```sh
cd pana
npm install
npm test           # Vitest, all suites (no browser)
npm run test:web   # the PWA browser suite against a real test panad (installed Chrome + chrome-devtools CLI)
PANA_SMOKE_FAUX=1 scripts/smoke   # a throwaway panad end to end; drop the variable and pass a key for a real model
scripts/bench      # the scale bench (not in npm test); BENCH.md has its results
npx tsc --noEmit   # must be clean before you report
```

Node 22.18 or newer runs the `.ts` sources directly, so there is no build step. `bin/pana` and `bin/panad` import `src/cli/index.ts` and `src/server/index.ts`.

## UI changes

A change to the PWA shows its effect in the PR: a screenshot of the before and after, or a short video, taken from the browser test domain. `node test/browser/screens.ts DIR LABEL` shoots every section; a single feature takes its own script the way `test/browser/palette-shots.ts` does.

Attach the shots to the PR. Do not commit them.

```sh
gw pr create --body-file body.md --attach ./shots/before.png --attach ./shots/after.png
gw pr edit 123 --body-file body.md --attach ./shots/after.png # an existing PR
gw pr comment 123 --attach './shots/shot.png#the phone width' # evidence after the fact
```

`--attach` (gh 2.99 or newer; `gw` passes it through) uploads each file to GitHub and rewrites the body's reference to it, `![before](./shots/before.png)`, into the uploaded URL. It takes images and video, up to 50 files per command. The branch and `master` then never carry the evidence.

Do not link a relative path to a file that stays out of the commit: GitHub resolves it against the default branch, so it renders as a broken image until the merge. Without `--attach`, an absolute `raw.githubusercontent.com` URL pinned to the commit renders (as #79 did), but the file still merges.

`pana/docs/` holds only the shots `pana/README.md` shows. Evidence for a single PR does not go there.

### Thread identity palette

`node scripts/session-palette.js` regenerates `web/session-palette.js` and its marked CSS block;
`--check` verifies reproducibility. The offline, dependency-free sampler is Glasbey-style greedy
max-min selection, not an official or universally colorblind-safe palette. Its first stage samples
paired OKLCH colors and determines the fixed category order and approved dark palette.
A second stage makes the light **graphic accents** vivid: it maximizes
normal-vision separation with a chroma preference, keeps hue within 30° of the dark category,
excludes user-blue hues, and checks all simulated pair distances. Thin borders/dots target
contrast ≥3 against white; the separate same-hue `--who-text` variants retain ≥4.5 for text.
No runtime sampling or color-science dependency is shipped. Tests audit all 66 pairs per theme/vision,
reserved-color separation, stronger light-mode separation and the unchanged dark palette.
Numerical floors are regression guards, not accessibility certifications.

Twelve checked-in farthest-first orders provide a well-separated sequence for each starting
color. A stable thread-ID hash chooses the starting color; no per-render randomness, runtime
color search, or saved session metadata is needed. Append-only participant order keeps existing
assignments stable across joins, reloads, themes and user-color preference changes.
Solid/dashed/dotted/double borders and swatches change
before each color reuse; all 48 combinations eventually repeat, so direct labels stay essential.
`PANA_COLOR_SHOTS_DIR=DIR npm run test:web -- test/browser/ux.spec.ts -t '13 sessions'` captures
the large-thread boundary in light/dark themes at desktop/phone widths.

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
| `scripts/bench`, `test/bench` | WP12 | the scale bench and its faux model; results in `BENCH.md` |

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
