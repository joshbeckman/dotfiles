// The real panad entry point with a scripted faux model instead of provider credentials. The
// end-to-end test (INT-04) and `scripts/smoke` in faux mode (INT-05) run it as a child process.
//
//   PANA_STATE=DIR PANA_FAUX_SCRIPT=script.json node faux-panad.ts
//
// PANA_FAUX_SCRIPT names a JSON file holding a `Script` (test/harness/model.ts). Sessions must
// use the model `faux/faux-1`.

import { readFileSync } from "node:fs";
import { main } from "../../src/server/index.ts";
import { createScriptedModel, type Script } from "../harness/model.ts";

const source = process.env.PANA_FAUX_SCRIPT;
const script = (source ? JSON.parse(readFileSync(source, "utf8")) : []) as Script;
const model = createScriptedModel(script);

process.exit(await main(process.argv.slice(2), { models: model.models }));
