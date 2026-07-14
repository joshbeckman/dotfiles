## Who I (the user) am

I am Josh Beckman (more info at https://www.joshbeckman.org/about).

My GitHub username is @!`git config github.user` and my email address is !`git config user.email`

My main text editor is !`git config core.editor`.

I make things. Not too much. Mostly for others.

## General Guidelines for Coding Agents

### Autonomy

Proceed by default. Do not ask permission for routine reading, editing, refactoring, test runs, formatting, or local inspection. Ask before actions that are irreversible, destructive, credential-bearing, externally visible, or ambiguous across a public/private boundary.

When uncertain, prefer a reversible local action plus a brief note over pausing for confirmation. Preserve momentum unless the next step could leak private information, destroy work, spend money, notify people, publish content, or mutate production/shared systems.

### Notifications

When I ask you to "ping me when", "notify me when", "let me know when", or similar, treat that as permission to send the final notification for that task. If `bin/notify-josh` is available, use it with a succinct but specific title that includes the folder, project, or topic.

If `bin/notify-josh` is not available, use this notification ladder:

1. If running on macOS and the display is active (not sleeping and not on screensaver), notify locally:
   - Send a `terminal-notifier` notification with sound.
   - Use a succinct but specific title that includes the folder, project, or topic.
   - Ring the terminal bell with `printf '\a'`.
   - If running inside tmux, set the tmux pane title to a short attention marker.
2. Otherwise, send me a push notification through the `josh-beckman-status` MCP server.

Prefer local notification when I am likely at the machine; use push when I am away, the display is asleep, or local notification is unavailable.

### Comments in Code

**Code Comment Guidelines**: Write comments that explain **why the code isn't written another way** rather than what it does. Focus on documenting "negative information" - what the code is *not* doing and why certain approaches were rejected. Comments should provide context about constraints, trade-offs, and non-obvious decisions that led to the current implementation. This is especially important for future developers and AI agents who need to understand not just the solution, but the problem space and alternatives that were considered.

**When to Comment**: Generally, avoid comments. Add comments when: (1) you chose one approach over another seemingly valid option, (2) there are non-obvious constraints or requirements driving the implementation, (3) the code might appear inefficient or strange without context, (4) you're working around external limitations, or (5) future maintainers might reasonably ask "why didn't you just...?" The goal is to prevent others from attempting "improvements" that you already considered and rejected for good reasons. Keep comments brief but include the critical context that the code itself cannot convey.

**IMPORTANT**: DO NOT add comments unless they explain why the code ISN'T written another way. Never explain what the code does - only document rejected alternatives and non-obvious constraints.

### Optimization and Refactoring

**[Simplification Protocol](https://www.joshbeckman.org/notes/567022446)**: Optimize my code around reducing state, coupling, complexity and code, in that order. I’m willing to add increased coupling if it makes my code more stateless. I’m willing to make it more complex if it reduces coupling. And I’m willing to duplicate code if it makes the code less complex. Only if it doesn’t increase state, coupling or complexity do I dedupe code.

**Rob Pike's Rules**: Don't optimize without measuring — bottlenecks occur in surprising places. Prefer simple algorithms and simple data structures; fancy ones have big constants and more bugs. Data dominates: if you've chosen the right data structures, the algorithms will be self-evident.

If you can see a better way to do it, strongly consider *keeping your mouth shut* if that way is only 5% better. If you improve by a few percent and distract by 50%, you’re probably not making things better. Save your insights for times where you think your way is 50+% better.

### Debugging & Diagnosis

When diagnosing performance or identifying 'slowest' items, carefully parse the actual metrics/timings rather than inferring from icons or labels. Confirm which items are the targets before proceeding.

## Commits

Create new commits; never amend unless explicitly asked. Ask for the PR URL rather than guessing. Use Conventional Commits: `<type>[optional scope]: <description>`.

## GitHub Workflow

Use `gw`, not `gh`, for GitHub commands. It uses the current repository and branch unless `GW_REPO` overrides them. You MUST use `gw view-md` to read issues and pull requests. Assign new pull requests to me with `--assignee @me`.

### Fast PR Lookups

| Command | Use |
|---|---|
| `gw pr-checks [PR_URL] [--required]` | Render checks as an actionable Markdown table. |
| `gw pr-url` | Print the current branch's PR URL. |
| `gw pr-merged [PR_URL]` | Print the merge timestamp; exit nonzero if the PR is not merged. |

Reference every issue or pull request with its title and full URL:

```markdown
[<issue_or_pr_title>](<issue_or_pr_url>)
```

Write GitHub comments to a temporary file, then pass it with `gw issue comment ISSUE_OR_PR_URL --body-file TMP_FILE`.

Append this trailer to every GitHub comment and review after a blank line:

```markdown
Generated-by: AI (<agent-harness>/<provider>/<model>)
```

Keep approvals brief. For change requests, identify each blocker and explain why it matters. Use Conventional Comments below.

## Comments on Pull Requests or Changes

Use **Conventional Comments** format for all PR/change comments to improve clarity and actionability:

**Format:** `<label> [decorations]: <subject>`

**Core Labels:**
- **praise:** Highlight something positive
- **nitpick:** Trivial preference-based requests (non-blocking by nature)
- **suggestion:** Propose improvements with clear reasoning
- **issue:** Highlight specific problems (pair with suggestions when possible)
- **todo:** Small, necessary changes
- **question:** Potential concerns needing clarification
- **thought:** Ideas that arise during review (non-blocking, valuable for mentoring)
- **chore:** Simple process-related tasks (include links to process docs)
- **note:** Non-blocking items to highlight

**Optional Decorations:**
- **(non-blocking):** Won't prevent acceptance
- **(blocking):** Must be resolved before acceptance
- **(if-minor):** Only resolve if changes are trivial

**Example:**
```
**suggestion (security):** Let's use the framework's DOM purifier instead.

Implementing our own could introduce vulnerabilities.
```

## General Tone and Prose

When writing prose (blog posts, documentation, comments, descriptions, PR bodies, etc.), fetch and follow the writing style guide at **https://www.joshbeckman.org/llms/prompts/tone.txt**. That file is the canonical source of truth for tone, voice, structure, and style.

## Time and Date Handling

You should use the josh-beckman-status get_current_time_of_day tool for determing what day it is (when doing things with calendars, reporting, etc.)
