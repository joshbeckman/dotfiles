# The wake gate's question

The wake gate asks a System One model one `noul` question about each delivery and skips the wake
below `WAKE_GATE_THRESHOLD` (`src/decisions/gate.ts`). The wording of that question decides what
gets skipped, so it is measured rather than guessed.

## The corpus

Built from this domain's own history, not written by hand:

1. Page every thread from `GET /threads` and read each one from `GET /threads/:id`.
2. Keep every message whose sender is a session and whose body is non-empty, and pair it with each
   session participant other than the sender. That is one delivery.
3. Collapse duplicates by normalized text: the batch tests post the same prompt to many sessions.
4. Label each surviving text by hand: does the recipient need to act on it? Requests, questions,
   assignments, decisions the recipient must follow, and blockers are yes; acknowledgments,
   agreements, thanks, sign-offs, and unprompted status reports are no.

A label derived from "did the recipient reply" is not usable: the same text gets both labels,
because sessions answer courtesy mail too.

## The measurement

Each candidate question is asked of the same state a wake would carry, rendered by
`deliveryText` in `src/threads/render.ts`. The frame matters: without the `New message. / From: /
Thread: / Subject:` header, plain task assignments score near zero, because a bare imperative
reads as narration rather than mail.

With 103 texts (44 labeled action, 59 not), skipped negatives are the saving and skipped positives
are the cost:

| Question | threshold | skipped negatives | missed action |
| --- | --- | --- | --- |
| original ("need to act", answer text only) | 0.15 | 52/59 (88%) | 7 |
| original | 0.25 | 53/59 (90%) | 8 |
| current (asks anywhere, asks for merge/rebase) | 0.05 | 40/59 (68%) | 2 |
| current | 0.1 | 45/59 (76%) | 2 |
| current | **0.15** | 46/59 (78%) | 2 |
| current | 0.25 | 50/59 (85%) | 3 |
| asks plus answers-to-questions | 0.15 | 39/59 (66%) | 3 |
| short ("would the next action change?") | 0.15 | 21/59 (36%) | 5 |

The original wording's misses were the ones that matter in practice: "PR 306 now has green checks,
I need its merge before I can run the test", "One more server gap: the event needs the messageId",
"your worktree was cut from stale master, run git fetch and rebase". Each is a request inside a
status report, and each scored under 0.05.

The current wording keeps most of the saving and finds the asks. Raising the threshold is the wrong
lever: it moved the original from seven misses to eight. Rewording moved it to two.

## What is still wrong

Two of the 44 remain below the threshold at 0.15: a report whose only request is "leave that tree
to me", and a synthetic prompt fixture that no peer sends. The corpus is 103 messages, labeled by
one reader, so treat the margins as directional, not as a confidence interval.

## Re-running it

The harness is ~60 lines of Python: fetch threads with the domain's web token, dedupe, then POST
`{model, state, questions}` to `https://api.fireworks.ai/inference/v1/systemone` with
`accounts/fireworks/models/rune` under `S_KEY_COMMAND` from the `s` store. Keep the labels you
assign, and rerun after any change to the question, the model, or the provider.
