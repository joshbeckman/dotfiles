// Child process for the DB-04 crash test. It seeds a thread, then appends a message that wakes a
// session and dies with SIGKILL before statement `k` of that transaction. The parent reopens the
// database and checks that nothing of the append survived.
//
//   node crash-child.ts DIR count   prints the statement list and exits 0
//   node crash-child.ts DIR K       kills itself before statement K

import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openSharedDatabase } from "../../src/db/index.ts";
import { monotonicUlidFactory } from "../../src/ids/index.ts";
import { defaultWakeSubmitter } from "../../src/sessions/wake.ts";
import type { Runtime } from "../../src/server/runtime.ts";
import { createScriptedModel } from "../harness/model.ts";
import { appendAndWake, seedThread } from "../harness/wake-fixture.ts";

const [dir, mode] = process.argv.slice(2) as [string, string];
const { db, storage } = await openSharedDatabase(join(dir, "pana.sqlite"));
const model = createScriptedModel([{ text: "ok" }]);
const harness = await Harness.open(storage, { models: model.models, registry: createRegistry() }, ctx);
const newId = monotonicUlidFactory();
const fixture = await seedThread(db, harness, newId, Date.now(), { domain: "test.example", user: "tester" });
const runtime = { db, harness, url: () => "pana://test.example/x" } as unknown as Runtime;

const statements: string[] = [];
const kill = mode === "count" ? undefined : Number(mode);
db.faults = (sql, index) => {
	statements.push(sql);
	if (index === kill) process.kill(process.pid, "SIGKILL");
};

await appendAndWake(db, fixture, newId, Date.now(), "hello", defaultWakeSubmitter(() => runtime), (appended) => {
	writeFileSync(join(dir, "plan.json"), JSON.stringify({ fixture, appended }));
});
db.faults = undefined;
process.stdout.write(JSON.stringify({ statements }));
await harness.close(ctx);
