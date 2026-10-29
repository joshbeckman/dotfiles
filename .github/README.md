# CI selection

`CI` always starts with a small Ubuntu detection job. It selects jobs before
allocating runners or installing dependencies:

| Changed paths | Selected suites |
| --- | --- |
| Only Markdown under `.agents/skills/` | `agent-skills` and `pana-skills`, once on Ubuntu |
| Only `pana/` | pana typecheck and tests on Ubuntu and macOS |
| Both of the above | Both selected suites |
| Any other path | All of `test/` and pana on Ubuntu and macOS |

Non-Markdown skill files are **not** assumed to be documentation. Changes to
CI, the selector, tests, runners, dependencies outside pana, setup, or any new
unmapped path get full coverage. The full repo suite already includes the
skill checks, so they are not also run as a separate job.

PR selection compares the head against its merge base with the PR base; pushes
compare the entire before/after range. Deleted files count, and renames count
as deletion plus addition. Empty diffs, missing history, new-branch pushes,
and unrecognized events conservatively select everything. Pana is only queued
when `pana/package.json` exists in the checkout.

A Monday 08:17 UTC scheduled run and **Run workflow** (`workflow_dispatch`)
exercise all suites regardless of paths. These have separate concurrency groups
from pushes, so a selective push cannot cancel the weekly full run.
`CI result` is the stable aggregate check: detection and every selected job must
succeed, while intentionally unselected jobs must be skipped. If branch
protection is enabled, require this aggregate rather than each optional job.

The regression test is `bin/run-tests ci-selection`; it builds isolated Git
histories to exercise routing without GitHub access. Keep routing coarse until
there is a tested dependency map for individual repo tests. Skill checks only
validate structure and pinned guidance, not the quality of the prose or future
agent behavior. The weekly full run is the backstop for missed dependencies;
if it reveals one, restore full routing for that boundary before narrowing it
again.
