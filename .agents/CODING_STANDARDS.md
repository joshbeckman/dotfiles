# Coding Standards

Read this file when writing, reviewing, refactoring, or debugging code, committing, or reviewing a PR.

## Comments in Code

Comments document rejected alternatives and non-obvious constraints — **why the code isn't written another way** — never what the code does. Add one when: (1) you chose one approach over another seemingly valid option, (2) non-obvious constraints drive the implementation, (3) the code might appear inefficient or strange without context, (4) you're working around external limitations, or (5) future maintainers might reasonably ask "why didn't you just...?" Keep them brief.

## Optimization and Refactoring

**[Simplification Protocol](https://www.joshbeckman.org/notes/567022446)**: Optimize around reducing state, coupling, complexity and code, in that order.

**Rob Pike's Rules**: Don't optimize without measuring. Prefer simple algorithms and simple data structures. Data dominates: if you've chosen the right data structures, the algorithms will be self-evident.

If you can see a better way to do it, consider keeping quiet if that way is only 5% better. Save your insights for times where you think your way is 50+% better.

## Debugging & Diagnosis

When diagnosing performance or identifying the slowest items, parse actual metrics and timings rather than inferring from icons or labels. Confirm the target items before proceeding.

## Commits

Create new commits; never amend unless explicitly asked. Ask for the PR URL rather than guessing. Use Conventional Commits: `<type>[optional scope]: <description>`. Every commit must include a body after the subject and blank line explaining why the change is needed and any important behavioral or implementation constraints. An attribution trailer does not count as the body.

## Comments on Pull Requests or Changes

Keep approvals brief. For change requests, identify each blocker and explain why it matters.

Use **Conventional Comments** format for all PR/change comments:

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
