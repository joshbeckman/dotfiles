---
name: pr-description-discipline
description: 'Write or tighten a pull request description for high-context reviewers. Use when drafting a PR body, editing/shrinking a PR description, reviewing your own PR before pushing, or whenever the user says "write the PR description", "tighten this PR", "shorten the PR body", "review my PR description", or pastes a draft and asks for feedback.'
---

# PR descriptions: don't re-narrate the diff

A PR description is meant for busy reviewer with high context in the space
 answers **why this exists** and **anything non-obvious from the diff**
nothing else. The diff is the source of truth for *what changed*; do not
duplicate it in prose.

## The rule

For each prose paragraph, ask:

> **"Could a reviewer with the diff open arrive at this in 5 seconds?"**

If yes, delete it. The PR description's job is to **triage the review**,
not to **explain the patch**. The patch explains itself; the description
aims attention.

## Cut these — the diff already shows them

| Tempting prose | Why cut |
|---|---|
| Per-call-site narration ("Wrap X, Y, Z in `rescue Foo`...") | Rescue placements are visible in the diff. One sentence covering all of them is enough. |
| Restating an unchanged control-flow ("Accept loop keeps serving") | Visible from rescue + unchanged surrounding code. |
| Explaining a conditional log line / small branch | Visible in the diff. |
| Subtle mechanism explanations ("`IO#close` flushes the buffer, so...") | Goes in the **commit message**, not the PR body. |
| Load-bearing one-liners explained in prose | Same — commit message material. |
| A "Tests" section enumerating one test per case | Test files are self-documenting via test names. |
| "Why" / "How" / "Summary" headers around 1–3 lines each | Header overhead exceeds content. Use plain prose. |

## Keep these — they don't fit in code

- **Reproduction context** the reader can't infer from the diff
  (environment, timing, scale: *"slow preloader, `connect_timeout=5s`"*).
- **Inventory of affected sites** with file/line permalinks — answers
  "did the author find them all?" faster than reading the diff.
- **Relationships to prior work** (`Fixes #123`, "same bug as closed
  #124, with the sites that PR missed") — context the diff can't carry.
- **Open questions / deliberate omissions** (untested rescues,
  considered-and-rejected alternatives, out-of-scope pre-existing bugs).
  These shape the review.
- **Worst-case framing** when the bug's blast radius isn't obvious from
  the change itself.

## Workflow

1. **Draft freely.** Get everything down without self-censoring.
2. **Run the 5-second test on every paragraph.** Delete what fails.
3. **Move teaching content to the commit message.** Subtle mechanisms,
   load-bearing one-liners, and "the interesting thing I learned" all
   belong there. The reviewer reads the commit when they need the
   *why-this-line*; the PR body when they're triaging.
4. **Drop section headers** unless the body has 3+ distinct sections.
   "Why / How / Tests" headers around short paragraphs are pure overhead.
5. **Read the result top-to-bottom.** Aim for a description that fits in
   one screen and points the reviewer at the non-obvious parts.

## Heuristic targets

- Most PRs: under 15 lines of prose.
- A bug fix description should typically lead with the **bug summary** +
  **inventory of affected sites** and end with **open questions**. The
  fix itself rarely needs more than one sentence.
- A refactor description should lead with **why now / what was wrong**
  and end with **what's deliberately out of scope**.

## When in doubt

If you're unsure whether a paragraph survives the 5-second test, cut it.
The reviewer who actually needs the detail will read the commit message
or the diff. The reviewer who doesn't was bored by your prose.
