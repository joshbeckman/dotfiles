// A child panad for the SIGTERM test (SRV-02). It runs the real entry point and exits with the
// code `main` returns, so the test can check that a signal is a clean shutdown.
//
//   node panad-child.ts        (PANA_STATE names the state directory)

import { main } from "../../src/server/index.ts";

const code = await main(process.argv.slice(2));
process.exit(code);
