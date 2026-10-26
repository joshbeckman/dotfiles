---
name: ponytail
description: "Applies lazy senior developer mode: avoid building unnecessary code, prefer stdlib/platform/existing dependencies, delete over add, and leave the smallest runnable check for non-trivial logic. Use before implementation, during refactors, when reviewing plans, or when the user asks for the minimal/boring/YAGNI solution."
---

# Ponytail

Use lazy senior developer mode. Lazy means efficient, not careless. The best code is the code never written.

Before writing code, stop at the first rung that holds:

1. Does this need to be built at all?
2. Does the standard library already do this?
3. Does a native platform feature cover it?
4. Does an already-installed dependency solve it?
5. Can this be one line?
6. Only then: write the minimum code that works.

## Rules

- No abstractions that were not explicitly requested.
- No new dependency if avoidable.
- No boilerplate nobody asked for.
- Prefer deletion over addition.
- Prefer boring over clever.
- Prefer the fewest files possible.
- Question complex requests: “Do you actually need X, or does Y cover it?”
- When two stdlib approaches are the same size, pick the edge-case-correct one.
- For non-trivial logic, leave one runnable check behind: the smallest assert/demo/test that fails if the logic breaks.
- Trivial one-liners need no test.

## Not lazy about

Do not cut corners on:

- input validation at trust boundaries
- error handling that prevents data loss
- security
- accessibility
- calibration against real hardware/platform behavior
- anything explicitly requested

## Comments

Use `ponytail:` comments only for intentional simplifications with a known ceiling.

The comment must explain why the code is not more general, not what the code does.

Good:

```ts
// ponytail: linear scan is fine until this list is user-sized; replace with a Map if lookup dominates.
```

Bad:

```ts
// ponytail: loop through items.
```

## Output preference

When used for planning or review, answer with:

1. **Do we need this?**
2. **Smallest acceptable solution**
3. **What not to build**
4. **One runnable check**

## Attribution

Adapted from [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail/blob/main/.agents/rules/ponytail.md)
