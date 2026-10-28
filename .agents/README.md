# Shared agent configuration

Portable configuration shared by local coding-agent harnesses.

## Layout

- `AGENTS.md` — global routing contract, symlinked to Claude Code's `CLAUDE.md` and Pi's `AGENTS.md`
- `AGENT_MAIL.md` — historical Agent Mail protocol, read only when explicitly using legacy tools
- `GITHUB_WORKFLOW.md` — GitHub commands, attribution, PR ownership
- `CODING_STANDARDS.md` — code quality, commits, review conventions (read when coding/reviewing)
- `USER.md` — user discovery details (read when needed)
- `skills/` — Agent Skills, symlinked/loaded by Claude Code and Pi
- `prompts/` — reusable slash-command prompts, symlinked to Claude Code `commands/` and Pi `prompts/`
- `pi/` — Pi-specific settings, keybindings, extensions, and themes

Do not put credentials, sessions, caches, OAuth state, internal proxy config, or generated package installs here. Work-only skills/prompts can live here locally, but should be ignored unless intentionally made public.

## Direct clients

Pana owns session coordination. Direct Pi and Claude starts do not allocate legacy names, create mailboxes, poll mail, acquire parking leases, or register lifecycle state. Their shared instructions use the current conversation for replies. Existing transcripts, identity records, scratchpads, and mail archives remain on disk; legacy archive tools are still available on explicit request.

Pi retains its independent UI, tool, safety, and commit-attribution extensions. Its settings list the retained extension entrypoints rather than loading an entire directory. Claude retains its status line and the unrelated machine-provided `skills-update.mjs` SessionStart hook. Machine-specific authentication hooks are not managed here.
