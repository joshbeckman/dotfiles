// The pana git hook directory (HOK-01..HOK-06).
//
// `bash` points git at `<state>/hooks` through `GIT_CONFIG_*` and exports `PANA_SESSION`.
// Every standard hook name is a small POSIX sh shim that execs `_pana-hook.sh`, which runs
// the repository's own hook of that name and then, for prepare-commit-msg, adds the pana
// co-author trailer. Both scripts stay POSIX so they run on macOS and Linux.

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Git's documented hooks (githooks(5)). A shim is installed for each. */
export const STANDARD_HOOKS = [
	"applypatch-msg",
	"pre-applypatch",
	"post-applypatch",
	"pre-commit",
	"pre-merge-commit",
	"prepare-commit-msg",
	"commit-msg",
	"post-commit",
	"pre-rebase",
	"post-checkout",
	"post-merge",
	"pre-push",
	"pre-receive",
	"update",
	"proc-receive",
	"post-receive",
	"post-update",
	"reference-transaction",
	"push-to-checkout",
	"pre-auto-gc",
	"post-rewrite",
	"sendemail-validate",
	"fsmonitor-watchman",
	"p4-changelist",
	"p4-prepare-changelist",
	"p4-post-changelist",
	"p4-pre-submit",
	"post-index-change",
] as const;

export const HOOK_RUNNER = "_pana-hook.sh";
export const HOOK_DOMAIN_FILE = "_pana_domain";

/**
 * The trailer a pana session's commits carry (HOK-02). The address is the user's own git
 * `user.email`, which GitHub parses for coauthor credit; a pana session has no mailbox of its
 * own. An empty email omits the address rather than inventing one.
 */
export function commitTrailer(domain: string, sessionId: string, email: string): string {
	const address = email === "" ? "" : ` <${email}>`;
	return `Co-authored-by: AI pana://${domain}/sessions/${sessionId}${address}`;
}

function shim(name: string): string {
	return `#!/bin/sh
# pana git hook shim (${name}): run pana's hook runner for this name.
exec "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/${HOOK_RUNNER}" "${name}" "$@"
`;
}

const RUNNER = `#!/bin/sh
# pana's git hook runner.
#
# Git runs the shim named after the hook; the shim execs this script with the hook name.
# This script runs the repository's own hook of that name first, then adds the pana
# co-author trailer to prepare-commit-msg. The exit code of the repository's hook is the
# script's exit code, so a failing repo hook still blocks the commit (HOK-04, HOK-05).

set -u

name=$1
shift

pana_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

# Where the repository's own hooks live: local core.hooksPath, then global core.hooksPath,
# then the path git itself resolves. The GIT_CONFIG_* variables that point git at pana's
# directory are command-scope config, so this lookup must not read them: --local and
# --global read the config files only, and GIT_CONFIG_COUNT=0 clears the rest.
find_repo_hook() {
	hook_name=$1
	dir=""
	local_dir=$(git config --local --get core.hooksPath 2>/dev/null) || local_dir=""
	if [ -n "$local_dir" ]; then
		dir=$local_dir
	else
		global_dir=$(git config --global --get core.hooksPath 2>/dev/null) || global_dir=""
		if [ -n "$global_dir" ]; then
			dir=$global_dir
		else
			dir=$(GIT_CONFIG_COUNT=0 git rev-parse --git-path hooks 2>/dev/null) || dir=""
		fi
	fi
	[ -n "$dir" ] || return 1
	case $dir in
	/*) ;;
	*) dir="$(git rev-parse --show-toplevel 2>/dev/null)/$dir" ;;
	esac
	printf '%s/%s\\n' "$dir" "$hook_name"
}

status=0
repo_hook=$(find_repo_hook "$name") || repo_hook=""
if [ -n "$repo_hook" ] && [ -x "$repo_hook" ]; then
	hook_dir=$(CDPATH= cd -- "$(dirname -- "$repo_hook")" && pwd)
	# Never run pana's own shim again, even if a repository points its hooks at pana's directory.
	if [ "$hook_dir" != "$pana_dir" ]; then
		"$repo_hook" "$@" || status=$?
	fi
fi

if [ "$status" -eq 0 ] && [ "$name" = "prepare-commit-msg" ] && [ -n "\${PANA_SESSION:-}" ] && [ -f "$pana_dir/${HOOK_DOMAIN_FILE}" ]; then
	domain=$(cat "$pana_dir/${HOOK_DOMAIN_FILE}")
	message=\${1:-}
	if [ -n "$domain" ] && [ -n "$message" ] && [ -f "$message" ]; then
		# The address is the user's own, from git config: a session is attributed by its URL,
		# and GitHub parses the address for coauthor credit. Inventing a session mailbox here
		# would name an address nobody can receive mail at.
		email=$(git config --get user.email 2>/dev/null) || email=""
		trailer="Co-authored-by: AI pana://$domain/sessions/$PANA_SESSION"
		if [ -n "$email" ]; then
			trailer="$trailer <$email>"
		fi
		git interpret-trailers --if-exists addIfDifferent --in-place \\
			--trailer "$trailer" "$message" || status=$?
	fi
fi

exit $status
`;

/**
 * Write the hook directory: one shim per standard hook name, the shared runner, and the
 * domain the trailer needs. Idempotent; each start refreshes the scripts and the domain.
 */
export function installGitHooks(dir: string, domain: string): void {
	mkdirSync(dir, { recursive: true });
	writeScript(join(dir, HOOK_RUNNER), RUNNER);
	for (const name of STANDARD_HOOKS) writeScript(join(dir, name), shim(name));
	writeFileSync(join(dir, HOOK_DOMAIN_FILE), `${domain}\n`, { mode: 0o644 });
	chmodSync(join(dir, HOOK_DOMAIN_FILE), 0o644);
}

function writeScript(path: string, content: string): void {
	writeFileSync(path, content, { mode: 0o755 });
	// writeFileSync's mode applies only when it creates the file.
	chmodSync(path, 0o755);
}
