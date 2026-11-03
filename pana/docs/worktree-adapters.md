# Managed repository worktrees

Some repositories require trees to be materialized by their own tooling, in a particular
location, rather than by bare `git worktree add`. Configure that integration in the
machine's Pana `config.json`, not in a public project or shared memory:

```json
{
  "worktreeAdapters": [{
    "repo": "/absolute/shared/git-directory",
    "root": "/absolute/managed/trees",
    "subdir": "src",
    "create": ["tree-tool", "add", "{name}", "--branch", "{branch}"]
  }]
}
```

`repo` must match `git rev-parse --path-format=absolute --git-common-dir` from any
checkout of that repository. The create executable runs in the source checkout,
with arguments passed directly (no shell evaluation). It must create the expected
checkout at `root/pana-session-name/subdir` on `{branch}` (the generated external tree ID
is lowercase, including session and name), reusing an existing branch
if its own lifecycle supports that. `{repo}` is the source checkout path, not the
shared git directory; `{path}` is the full expected checkout path. Omit `subdir` for
repositories whose checkout is the tree directory itself. Use absolute paths in
configuration; `~` and environment variables are not expanded.

Both `pana worktree add REPO` and profiles with `cwd: "worktree"` use this adapter.
Ordinary repositories still use Pana's state layout, but profile-created trees now
use `<state>/worktrees/<session>/<repo-name>`, like the API. Existing profile cwd values
and state-layout trees remain usable. Previously verified owned adapter trees retain
their original paths, including case-preserving IDs. Always use the returned path.

A command exit of zero is not enough: Pana checks the path, shared repository,
branch, and worktree-specific git registration/back-pointer before publishing ownership.
Ownership records under `<state>/worktree-owners`
are retained across restart and archive. No external existing tree is auto-adopted,
and another session's linked tree is not writable merely because `.git` is a file.
Known peer ownership overrides even an explicit cwd, and implicit-cwd shell execution
in an unowned checkout is refused. These are accidental-write guards, not a security
boundary against arbitrary code;
`guard` mode cannot infer every shell expression. `sandbox` adds read-only mounts on
hosts supporting user mount namespaces; macOS has only the admission/file guards.

## Failure and cleanup

Adapter failures never fall back to Git or another location. Partial creation without
an ownership receipt fails closed on retry: report the error and ask the user to
inspect/reconcile or remove the partial tree using its supported lifecycle. Pana does
not undo materializer side effects or delete a tree automatically. A branch may also
remain after a failed Git creation; ordinary Git creation can reuse that branch.

Project trees are not scratch and have no automatic TTL cleanup. Before an authorized
removal, preserve all work and check outstanding assignments/PRs; use the repository's
own removal tool for managed trees. Retained receipts grant no access after the git
pointer changes to a different repository. Do not hand-edit a receipt to claim a tree.

For rollout, the owner should first test the configured tool on a fresh session tree,
verify both allowed owner writes and refused peer writes, and check that ordinary
repositories still work. Stop if the destination, branch or repository differs from
the returned result; leave user trees unchanged and correct the configuration. Unit
tests use fake materializers and temporary repositories on macOS and Linux, never
proprietary repository tooling.
