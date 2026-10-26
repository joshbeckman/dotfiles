// A child process that dies in the middle of a run (SRV-03). It opens the same state a panad
// does, commits a submission, and SIGKILLs itself from inside the first model request — the run
// task is stored and unfinished, exactly as a crash leaves it.
//
//   node crash-run-child.ts DIR

import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureStateLayout } from "../../src/config/index.ts";
import { openSharedDatabase } from "../../src/db/index.ts";
import { FAUX_MODEL } from "../harness/model.ts";

const dir = process.argv[2]!;
ensureStateLayout(dir);
const { storage } = await openSharedDatabase(join(dir, "pana.sqlite"));

const faux = fauxProvider();
const models = createModels();
const die = () => {
	const stream = createAssistantMessageEventStream();
	writeFileSync(join(dir, "crashed"), "1");
	process.kill(process.pid, "SIGKILL");
	return stream;
};
models.setProvider({ ...faux.provider, stream: die as never, streamSimple: die as never });

const harness = await Harness.open(storage, { models, registry: createRegistry(), settings: { retry: { maxRetries: 0 } } }, ctx);
const root = await harness.root(ctx, { agent: { model: FAUX_MODEL } });
await root.submit({ type: "input", content: "work that a crash interrupts" }, ctx);
// The model request kills this process. Keep the event loop alive in case it never arrives.
setInterval(() => {}, 1000);
