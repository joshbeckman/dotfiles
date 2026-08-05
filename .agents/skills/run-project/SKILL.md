---
name: run-project
description: Runs a GitHub project organized around one root issue, native sub-issues, one project label, zone labels, and one closing PR per child issue. Use when starting, planning, auditing, updating, or reporting on a project; creating project issues or PRs; or when the user says "run this project".
argument-hint: "root issue URL or project slug"
---

# Run Project

Treat GitHub as the project system. Do not create a parallel tracker or manually duplicate state that GitHub can derive.

## Project contract

Every project has:

- One root issue carrying `proj:<slug>`.
- A concise root body with the goal, context, scope, start date, and estimated end date.
- Native GitHub sub-issues representing independently completable outcomes.
- `proj:<slug>` on the root, every child issue, and every implementation PR.
- One `//...` label for each zone an issue or PR touches. Do not put every project zone on the root unless the root itself represents work in those zones. Only relevant for working in `shop/world`.
- One development PR per child issue.
- `Closes <child URL>` in each PR body so GitHub links and closes the child.
- `Project: <root URL>` in every child issue and PR body so a reader can reach the main context in one click.

The root issue is the source of project context. Child issues should not repeat its full rationale.

## Start or restore

1. Resolve the root issue from the argument or ask for it.
2. Read it with `gw view-md ROOT_URL`.
3. Inspect labels and native sub-issues:

```sh
GW_REPO=OWNER/REPO gw issue view NUMBER --json number,title,state,url,labels,assignees,body
GW_REPO=OWNER/REPO gw api repos/OWNER/REPO/issues/NUMBER/sub_issues --paginate
```

4. Identify the project slug, dates, open children, linked PRs, and contract violations.
5. Report the current state and the single most useful next action. Do not edit GitHub merely to normalize formatting.

## Create the root

Draft the body from [templates.md](templates.md). Keep the goal legible to someone outside the work. Choose a stable, lowercase kebab-case slug and create `proj:<slug>` in each repository only when first needed.

Give each project label its own color so projects stay distinguishable at a glance in issue lists. List the colors already taken by existing `proj:` labels and pick an unused one:

```sh
GW_REPO=OWNER/REPO gw api repos/OWNER/REPO/labels --paginate --jq '.[] | select(.name | startswith("proj:")) | "\(.name) #\(.color)"'
GW_REPO=OWNER/REPO gw label create "proj:<slug>" --color COLOR --description "Project: <root title>"
```

Reuse the same color for the label across repositories in one project. Do not default to a single house color for every project, and do not recolor existing labels while creating a new one.

Before creating issues, labels, comments, or other externally visible state, show the exact proposed mutation and get confirmation.

## Create a child issue

1. Define one outcome that one PR can close. Split work that requires independent PRs.
2. Include `Project: <root URL>` and only child-specific context or acceptance criteria.
3. Apply `proj:<slug>` and every zone the work touches.
4. Assign the owner.
5. Create the issue, then attach it through GitHub's native sub-issue relationship:

```sh
CHILD_ID=$(GW_REPO=CHILD_OWNER/CHILD_REPO gw api repos/CHILD_OWNER/CHILD_REPO/issues/CHILD_NUMBER --jq .id)
GW_REPO=ROOT_OWNER/ROOT_REPO gw api --method POST repos/ROOT_OWNER/ROOT_REPO/issues/ROOT_NUMBER/sub_issues -F sub_issue_id="$CHILD_ID"
```

Linking in prose does not replace the native sub-issue relationship.

## Open or audit a PR

A project PR must:

- implement exactly one child issue;
- contain `Project: <root URL>`;
- contain `Closes <child URL>` rather than merely `Relates to`;
- carry `proj:<slug>` and the same applicable zone labels;
- be assigned to the user;
- avoid re-narrating context already available in the root issue.

Use full URLs so relationships remain unambiguous across repositories. Follow the `pr-description-discipline` skill for the rest of the body.

## Run and report

- Use native child issue state as progress; do not maintain a second checkbox list or percentage.
- Read linked PRs before reporting a child as blocked, in progress, or done.
- Update the root only when the goal, scope, dates, or durable context changes.
- Comment only for decisions, milestones, blockers, or changes readers need to discover.
- Close the root after all intended children are closed or explicitly removed from scope.
- Build a bespoke readout only when it communicates evidence or metrics GitHub does not represent.

When auditing, separate contract violations from optional improvements. Propose the smallest repair set and confirm before applying it.
