// Ownership records live in pana's database, which only panad writes. A tree's owner is retained
// across archive/restart, and a record permits only its checkout, not the surrounding managed tree
// (caches may belong to other tools).
//
// They were JSON files under `<state>/worktree-owners` until migration 16: `exec()` re-reads
// ownership on every call, so a file any `bash` command could write was a grant any `bash` command
// could forge. `adoptLegacyOwners` carries a pre-database install's records across once.
import { existsSync, lstatSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import type { PanaDatabase } from "../db/atomic.ts";
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

export async function owners(db: PanaDatabase): Promise<WorktreeOwner[]> {
	return db.all<WorktreeOwner>("SELECT session, path, common FROM worktree_owners");
}

export async function ownedPaths(db: PanaDatabase, session: string): Promise<string[]> {
	return (await owners(db)).filter((o) => o.session === session && checkoutCommon(o.path) === o.common).map((o) => o.path);
}

const RECORD = "INSERT INTO worktree_owners (path, session, common) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET session = excluded.session, common = excluded.common";

export async function saveOwner(db: PanaDatabase, owner: WorktreeOwner): Promise<void> {
	await db.write((tx) => tx.run(RECORD, owner.path, owner.session, owner.common));
}

/**
 * GUARD-07: adopt the `worktree-owners` directory a build before migration 16 wrote, once. A
 * record whose git pointer no longer agrees with it grants nothing and is dropped; a directory
 * that appears after the adoption is not authority, so a session cannot reintroduce one.
 */
export async function adoptLegacyOwners(db: PanaDatabase, state: string): Promise<void> {
	const dir = join(state, "worktree-owners");
	const adopted = `${dir}.migrated`;
	if (existsSync(adopted) || !existsSync(dir)) return;
	const keeping: WorktreeOwner[] = [];
	for (const name of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
		try {
			const value = JSON.parse(readFileSync(join(dir, name), "utf8"));
			if (typeof value.session !== "string" || typeof value.path !== "string" || typeof value.common !== "string") continue;
			if (checkoutCommon(value.path) !== value.common) continue;
			keeping.push({ session: value.session, path: value.path, common: value.common });
		} catch {
			// A malformed record failed closed before this change too, and still grants nothing.
		}
	}
	await db.write(async (tx) => {
		for (const owner of keeping) await tx.run(RECORD, owner.path, owner.session, owner.common);
	});
	try {
		renameSync(dir, adopted);
	} catch {
		// Left in place: adoption is idempotent, and the records it holds still face the git check.
	}
}
