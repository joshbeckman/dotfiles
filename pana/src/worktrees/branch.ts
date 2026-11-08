import { gitIn } from "./git.ts";

/** Choose a new branch without changing refs or requiring network access. */
export async function generatedBranch(repo: string, parts: string[]): Promise<string> {
	const [{ stdout: refs }, { stdout: remotes }] = await Promise.all([
		gitIn(repo, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"]),
		gitIn(repo, ["remote"]),
	]);
	const prefixes = remotes.trim().split("\n").filter(Boolean)
		.map((remote) => `refs/remotes/${remote}/`).sort((a, b) => b.length - a.length);
	const branches = refs.trim().split("\n").filter(Boolean).map((ref) => {
		if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
		const prefix = prefixes.find((value) => ref.startsWith(value));
		// Keep stale tracking refs useful even after their remote configuration was removed.
		return prefix ? ref.slice(prefix.length) : ref.replace(/^refs\/remotes\/[^/]+\//, "");
	});
	const available = (candidate: string) => !branches.some((branch) =>
		branch === candidate || branch.startsWith(`${candidate}/`) || candidate.startsWith(`${branch}/`));
	const preferred = ["pana", ...parts].join("/");
	if (available(preferred)) return preferred;
	// A suffix under pana/ cannot fix a conflict with a branch named pana.
	const flat = ["pana", ...parts].join("-");
	let candidate = flat;
	for (let suffix = 2; !available(candidate); suffix++) candidate = `${flat}-${suffix}`;
	return candidate;
}
