---
name: autoresearch
description: Autonomous iteration loop inspired by Andrej Karpathy's autoresearch. Modify a file, evaluate, keep or revert, repeat forever. Use for any optimization task with a measurable metric — skills, prompts, configs, ML training, code. Use when the user mentions "autoresearch", wants to run autonomous experiments, wants to iterate on something overnight, says "optimize this", "run experiments on this", or wants to leave Claude running while they sleep. Also use when improving skills, prompts, or agents iteratively.
---

# autoresearch

This is Andrej Karpathy's autoresearch pattern from https://github.com/karpathy/autoresearch, generalized. An autonomous loop where you modify files, evaluate the result, keep improvements, and discard failures — forever, until manually interrupted. Originally built for ML training; works for anything with a measurable metric.

## Setup

To set up a new experiment, work with the user to:

1. **Agree on a run tag**: propose a tag based on today's date (e.g. `mar9`). The branch `autoresearch/<tag>` must not already exist — this is a fresh run.
2. **Create the branch**: `gt create autoresearch/<tag>` from the current branch.
3. **Determine the scope**: Ask the user (if not already clear from the conversation):
   - **Modifiable files** — what file(s) can you edit? This is your `train.py`. Everything within these files is fair game.
   - **Frozen files** — what file(s) must you NOT touch? This is your `prepare.py`. These contain the evaluation harness, ground truth, test data, etc.
   - **Evaluation command** — how do you run an experiment? A shell command, a skill invocation, an LLM-as-judge call, etc.
   - **Metric extraction** — how do you get the number out? A grep pattern, JSON path, last line of stdout, a score you compute yourself, etc.
   - **Metric direction** — is lower better (like loss) or higher better (like accuracy)?
   - **Expected duration** — roughly how long does one evaluation take? (Needed for timeout: runs exceeding 2x this are killed.)
4. **Read the in-scope files**: Read all modifiable and frozen files for full context. Understand what you're working with before changing anything.
5. **Verify the evaluation works**: Run the evaluation command once. If it fails, fix the environment before proceeding. Don't start the loop with a broken harness.
6. **Initialize results.tsv**: Create `results.tsv` with just the header row. The baseline will be recorded after the first run.
7. **Confirm and go**: Confirm setup looks good.

Once you get confirmation, kick off the experimentation.

## Experimentation

**What you CAN do:**

- Modify the designated modifiable files. Everything within them is fair game: structure, logic, parameters, approach, style — whatever you think will improve the metric.

**What you CANNOT do:**

- Modify frozen files. They are read-only. They contain the fixed evaluation, ground truth, and constraints.
- Install new packages or add dependencies beyond what's already available.
- Modify the evaluation harness or metric computation.

**The goal is simple: optimize the metric.** Everything within the modifiable files is fair game. The only constraint is that the evaluation runs without crashing.

**Simplicity criterion**: All else being equal, simpler is better. A small improvement that adds ugly complexity is not worth it. Conversely, removing something and getting equal or better results is a great outcome — that's a simplification win. When evaluating whether to keep a change, weigh the complexity cost against the improvement magnitude. A tiny metric improvement that adds 20 lines of hacky code? Probably not worth it. A tiny metric improvement from deleting code? Definitely keep. An improvement of ~0 but much simpler code? Keep.

**The first run**: Your very first run should always be to establish the baseline, so you will run the evaluation as-is without making any changes.

## Evaluation types

The evaluation can take several forms. Agree on one during setup.

**Shell command**: Run a command, extract metric from output. Redirect to `run.log` to avoid flooding context:

```
<command> > run.log 2>&1
grep "<pattern>" run.log
```

**Skill invocation**: Invoke another Claude skill (e.g., a healthcheck skill) against a test input. Parse its structured output into a numeric score. The skill invocation happens inline — just use the skill as you normally would, then parse its output.

**LLM-as-judge**: Read the modified files and evaluate them against a rubric you define during setup. Score yourself on each criterion (e.g., 0-10), average them. This is fast but less grounded than real execution — use it when real execution is too slow. Note: you are scoring your own work, so there is an inherent bias. Prefer shell commands or skill invocations when possible, and treat LLM-as-judge scores as directional, not definitive.

## Logging results

When an experiment is done, log it to `results.tsv` (tab-separated, NOT comma-separated — commas break in descriptions).

The TSV has a header row and 4 columns:

```
commit	metric	status	description
```

1. git commit hash (short, 7 chars)
2. metric value achieved — use 0.000000 for crashes
3. status: `keep`, `discard`, or `crash`
4. short text description of what this experiment tried

Example:

```
commit	metric	status	description
a1b2c3d	0.9979	keep	baseline
b2c3d4e	0.9932	keep	increase learning rate to 0.04
c3d4e5f	1.0050	discard	switch to GeLU activation
d4e5f6g	0.0000	crash	doubled model width (OOM)
```

## The experiment loop

The experiment runs on a dedicated branch (e.g. `autoresearch/mar9`).

LOOP FOREVER:

1. **Print status** so the user can see you're alive: `Experiment N: <what you're trying>`
2. Look at the git state: the current branch/commit we're on
3. Save the current commit: `BEFORE=$(git rev-parse HEAD)`
4. Modify the in-scope file(s) with an experimental idea.
5. `gt modify --commit` to amend the branch with your changes
6. Run the evaluation (redirect output — do NOT use tee or let output flood your context)
7. Extract the metric
8. If the metric extraction is empty or the run crashed, check the logs. If it's something dumb and easy to fix (e.g. a typo, a missing import), fix it and re-run. If you can't get things to work after more than a few attempts, give up.
9. Record the results in the tsv (NOTE: do not commit the results.tsv file, leave it untracked by git)
10. If the metric improved, you "advance" the branch — the amended commit stays, update best metric. Print: `KEEP (N.NN -> N.NN): <description>`
11. If the metric is equal or worse, discard: `git reset --hard $BEFORE` to revert to the pre-amend state. Print: `DISCARD (N.NN): <description>`

The idea is that you are a completely autonomous researcher trying things out. If they work, keep. If they don't, discard. And you're advancing the branch so that you can iterate. If you feel like you're getting stuck in some way, you can rewind but you should probably do this very very sparingly (if ever).

**Timeout**: If a run exceeds 2x the expected duration, kill it and treat it as a failure (discard and revert).

**Crashes**: If it's something dumb and easy to fix (e.g. a typo, a missing import), fix it and re-run. If you can't get things to work after more than a few attempts, give up, log "crash" as the status in the tsv, and move on.

**NEVER STOP**: Once the experiment loop has begun (after the initial setup), do NOT pause to ask the human if you should continue. Do NOT ask "should I keep going?" or "is this a good stopping point?". The human might be asleep, or gone from a computer and expects you to continue working _indefinitely_ until you are manually stopped. You are autonomous. If you run out of ideas, think harder — read documentation and related code for new angles, re-read the in-scope files, try combining previous near-misses, try more radical changes, try simplifying. The loop runs until the human interrupts you, period.

**Diversity**: After 5 consecutive discards, step back and try a fundamentally different approach rather than incremental tweaks on the same idea.

As an example use case, a user might leave you running while they sleep. If each experiment takes ~5 minutes then you can run approx 12/hour, for a total of about 100 over the duration of the average human sleep. The user then wakes up to experimental results, all completed by you while they slept!

**Context management**: During long runs, your conversation history grows. Keep each iteration lean — don't re-read files you already understand unless you need to. Use `results.tsv` as your memory of what you've tried. If you feel your context getting heavy, briefly review the TSV and the current state of the modifiable files rather than re-reading the entire history.

## Recipes

### Skill iteration

```
Modify: .claude/skills/my-skill/SKILL.md + rules/*.md
Frozen: the evaluation harness (a companion skill, test cases, /skill-creator evals)
Evaluate: run the companion skill or eval suite against test inputs
Metric: completeness/quality score (higher is better)
```

### Prompt optimization

```
Modify: prompts/system-prompt.md
Frozen: eval.py, test-cases/
Evaluate: python eval.py --prompt prompts/system-prompt.md
Metric: accuracy from stdout (higher is better)
```

### Agent improvement

```
Modify: .claude/agents/my-agent.md
Frozen: test harness, evaluation criteria
Evaluate: run agent against test scenarios, score outputs
Metric: average quality score (higher is better)
```
