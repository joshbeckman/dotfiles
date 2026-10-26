# Shared agent configuration

Portable configuration shared by local coding-agent harnesses.

## Layout

- `AGENTS.md` — global routing contract, symlinked to Claude Code's `CLAUDE.md` and Pi's `AGENTS.md`
- `AGENT_MAIL.md` — Agent Mail protocol: threading and discovery
- `GITHUB_WORKFLOW.md` — GitHub commands, attribution, PR ownership
- `CODING_STANDARDS.md` — code quality, commits, review conventions (read when coding/reviewing)
- `USER.md` — user discovery details (read when needed)
- `skills/` — Agent Skills, symlinked/loaded by Claude Code and Pi
- `prompts/` — reusable slash-command prompts, symlinked to Claude Code `commands/` and Pi `prompts/`
- `pi/` — Pi-specific settings, keybindings, extensions, and themes

Do not put credentials, sessions, caches, OAuth state, internal proxy config, or generated package installs here. Work-only skills/prompts can live here locally, but should be ignored unless intentionally made public.
