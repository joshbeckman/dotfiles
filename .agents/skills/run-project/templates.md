# Project templates

## Root issue

```markdown
<One paragraph stating the goal, why it matters, and what success changes.>

## Scope

- <Included outcome or boundary>
- <Included outcome or boundary>

Out of scope: <important exclusions, if any>.

## Timeline

- Started: YYYY-MM-DD
- Estimated completion: YYYY-MM-DD

## Approach

<Only the durable strategy, precedent, constraints, or sequencing that child issues need to share.>
```

Keep current progress in GitHub's native sub-issue list rather than copying it into the body.

## Child issue

```markdown
Project: <root issue URL>

<Child-specific outcome, constraints, and definition of done. Do not repeat the root issue.>
```

## Pull request relationship block

```markdown
Project: <root issue URL>
Closes <child issue URL>
```

Add only review context that cannot be inferred quickly from the diff, root issue, or child issue.
