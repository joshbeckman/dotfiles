// Point the default state directory at a throwaway path, so a test that forgets `stateDir`
// can never touch ~/.local/state/pana.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "pana-default-state-"));
process.env.PANA_STATE = dir;
afterAll(() => rmSync(dir, { recursive: true, force: true }));
