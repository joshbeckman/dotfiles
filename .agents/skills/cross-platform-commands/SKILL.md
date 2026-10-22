---
name: cross-platform-commands
description: Guides portable shell and Python commands in this dotfiles repository. Use when creating, changing, reviewing, or testing a command under bin/ or test/ that runs on macOS and Linux, or when designating a command for one platform.
---

# Cross-platform commands

## Contract

`bin/` commands and `test/` checks are shared unless explicitly designated otherwise. A whole command can be platform-only when its basename ends in `-macos` or `-linux`, or the line immediately after its shebang is exactly `# Platform: macOS` or `# Platform: Linux`. Use the marker for an established command whose name must stay stable. A guarded branch within a shared command does not make the whole command platform-only. Tests for a platform-only command can run only on that host, but say so.

## Before changing code

1. Read the command and its callers and tests. Check whether another agent owns the file.
2. List each operating-system dependency and the behavior on the other host. Run `uname -s` before reporting test evidence.
3. Prefer the same code path on both hosts. Use Python's `pathlib`, `datetime`, `tempfile`, `base64`, and `subprocess` for shell portability traps when Python is already a dependency. Keep subprocess argument lists separate from shell commands.
4. If an OS facility is necessary, branch on `uname -s` in shell or `sys.platform` in Python. Fail with a clear message on unknown hosts. Do not silently skip a safety check. Keep both paths tested.

## Traps to check

- macOS has no `/proc`. Use a guarded process probe (such as `ps`) and fail closed if the process state protects a lease or wake.
- BSD and GNU `stat`, `date`, `sed -i`, `ps`, `find`, `readlink`, `mktemp`, and `base64` accept different flags. Do not infer one flavor from the other. Test behavior, not just command presence. A GNU `stat -f` failure can print a filesystem dump to stdout; probe the format first or suppress that output.
- Avoid `grep -P`, `shuf`, and `realpath` as assumed system commands. Use portable `awk` or Python, or declare an installed dependency. Quote paths; avoid newline-split filenames and GNU-only `basename -a`.
- `/bin/bash` on macOS is 3.2. Avoid associative arrays, `mapfile`/`readarray`, `${var,,}`, and newer Bash features unless the command requires a declared newer Bash and invokes it by path or `env`.
- Guard macOS apps (`open`, `pbcopy`, `osascript`, `launchctl`) and Linux services (`xdg-open`, `systemctl`). Do not hard-code `/opt/homebrew` as a shared tool path.

## Proof

Add a regression test for each changed path. Stub external commands and use temporary homes; never touch live mail, services, or user files in a test. Exercise both branches with injected platform and process probes where possible. Mocked Linux behavior on macOS is **not** a Linux run. State the host for each test run, and mark the other host unverified until it runs there. Use `bash -n` or `python3 -m py_compile` for syntax, then run the relevant tests on each available host.
