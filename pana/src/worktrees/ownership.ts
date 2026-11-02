// Ownership receipts live outside scratch and are retained across archive/restart. A receipt
// permits only its checkout, not the surrounding managed tree (caches may belong to other tools).
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { realPath } from "../extension/checkouts.ts";

export interface WorktreeOwner { session: string; path: string; common: string }

/** Resolve git's pointer files without spawning a process on every file write. */
export function checkoutCommon(path: string): string | undefined {
	try {
		const marker = join(path, ".git");
		if (!lstatSync(marker).isFile()) return undefined;
		const text = readFileSync(marker, "utf8");
		if (!text.startsWith("gitdir: ")) return undefined;
		const gitdir = realPath(resolve(path, text.slice(8).trim()));
		const common = join(gitdir, "commondir");
		// A same-repository pointer copied from a peer would share its index and HEAD. Git's
		// worktree-specific back-pointer must bind this metadata to this exact .git file.
		if (!existsSync(common) || realPath(resolve(gitdir, readFileSync(join(gitdir, "gitdir"), "utf8").trim())) !== realPath(marker)) return undefined;
		return realPath(resolve(gitdir, readFileSync(common, "utf8").trim()));
	} catch { return undefined; }
}

export function owners(state: string): WorktreeOwner[] {
	const dir = join(state, "worktree-owners");
	if (!existsSync(dir)) return [];
	// Malformed receipts fail closed: they grant nothing, and creation reports a collision.
	return readdirSync(dir).filter((n) => n.endsWith(".json")).flatMap((n) => {
		try {
			const value = JSON.parse(readFileSync(join(dir, n), "utf8"));
			return typeof value.session === "string" && typeof value.path === "string" && typeof value.common === "string" ? [value as WorktreeOwner] : [];
		} catch { return []; }
	});
}

export function ownedPaths(state: string, session: string): string[] {
	return owners(state).filter((o) => o.session === session && checkoutCommon(o.path) === o.common).map((o) => o.path);
}

export function saveOwner(state: string, key: string, owner: WorktreeOwner): void {
	const path = join(state, "worktree-owners", `${key}.json`);
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.tmp`;
	writeFileSync(temp, JSON.stringify(owner) + "\n", { mode: 0o600 });
	renameSync(temp, path);
}
