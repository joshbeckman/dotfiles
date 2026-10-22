---
name: cross-platform-dotfiles
description: Guides cross-platform changes throughout this dotfiles repository. Use when creating, changing, reviewing, or testing any script, config, setup step, service, editor integration, app, or documentation that may run or be installed on macOS and Linux.
---

# Cross-platform dotfiles

## Contract

Treat the whole repository as shared between macOS and Linux: `setup`, `bin/`, shell and editor configs, apps, services, tests, and their docs. A file's language does not determine its target host. Check callers, installers, and indirect dependencies before declaring a change portable.

A whole **command** can target one platform when its basename ends in `-macos` or `-linux`, or the line immediately after its shebang is exactly `# Platform: macOS` or `# Platform: Linux`. Use the marker when the command name must stay stable. A platform branch inside a shared command does not designate the command. For a non-command resource, use an explicit platform path (such as `Library/LaunchAgents/` or `.config/systemd/user/`), a platform-specific filename, or a documented platform marker where its format permits comments. For formats without comments, document the target in the adjacent README or installer. A shared entrypoint must select the correct resource instead of loading both.

## Work through the boundary

1. Read the changed file, its callers, setup/link rules, and tests. Check whether another agent owns it. List every host-dependent command, path, API, dependency, and file format.
2. Prefer one path that runs on both hosts. In shell, use POSIX tools and Bash 3.2 when Bash is needed. In Python, use `pathlib`, `datetime`, `tempfile`, `base64`, and argument-list `subprocess` calls when they solve a portability trap. Apply the same check to Ruby, Perl, JavaScript, Swift, editor config, and any other language in this repo.
3. Guard an OS-only facility at the point of use (`uname -s`, `sys.platform`, or the language's platform API). Provide the other host's path, or designate the whole artifact as platform-only. Fail clearly on an unknown host. Do not silently skip a safety check.
4. Check installation too: shared setup must not link a macOS-only plist on Linux, enable a systemd timer on macOS, assume one package manager, or launch a tool missing from that host's dependencies. Keep platform-specific resources in their platform paths.
5. Add a regression check for each changed behavior. Stub external tools and use temporary homes; never touch live mail, services, or user files. State the actual host for every test run. A simulated platform branch is not proof that the other host works.

## Traps to check

- macOS has no `/proc`. Use a guarded process probe (such as `ps`) and fail closed when a lease or wake depends on it.
- BSD and GNU `stat`, `date`, `sed -i`, `ps`, `find`, `readlink`, `mktemp`, and `base64` accept different flags. Probe actual behavior; GNU `stat -f` can print a filesystem dump to stdout on failure.
- Do not assume `grep -P`, `shuf`, or a `realpath` executable. Quote paths and avoid GNU-only `basename -a`. `/bin/bash` on macOS is 3.2: avoid associative arrays, `mapfile`/`readarray`, and `${var,,}` unless a declared newer Bash is invoked.
- macOS `open`, `pbcopy`, `osascript`, and `launchctl` differ from Linux `xdg-open` and `systemctl`. Do not hard-code `/opt/homebrew` as a shared tool path. Check native app and editor dependencies as well as CLI flags.

## Proof

Run syntax checks and relevant tests on each available host. A macOS pass does not verify Linux, or vice versa. Mark an unavailable host unverified and name the command needed to check it there. For a platform-only artifact, run it on its designated host and verify that the shared installer does not select it on the other host.
