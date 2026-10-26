// The pana CLI (WP1). Not built yet.
//
// TODO(WP1): implement CLI-01..07 from SPEC.md. Talk to panad only through
// `request({ socketPath }, ...)` from src/api/client.ts, send `Pana-Caller` from `PANA_SESSION`,
// and map statuses with `statusToExitCode` from src/api/errors.ts.

export async function main(_argv: string[]): Promise<number> {
	console.error("pana: the CLI is not built yet (WP1)");
	return 1;
}
