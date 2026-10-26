// Point the default state directory at a throwaway path, so a test that forgets `stateDir`
// can never touch ~/.local/state/pana.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PANA_STATE = mkdtempSync(join(tmpdir(), "pana-default-state-"));
