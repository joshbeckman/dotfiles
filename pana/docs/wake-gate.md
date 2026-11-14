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

That leaves 103 texts, 44 labeled action and 59 not. A label derived from "did the recipient
reply" is not usable: the same text gets both labels, because sessions answer courtesy mail too.

Each candidate question is asked over the state a wake carries, rendered by `deliveryText` in
`src/threads/render.ts`. The frame matters: without the `New message. / From: / Thread: /
Subject:` header, plain task assignments score near zero, because a bare imperative reads as
narration rather than mail.

## The measurement

Every variant ran twice, and the counts bootstrap over examples (4,000 resamples, 90% interval
shown for the shipped row). Skipped negatives are the saving; skipped positives are the cost.

At threshold 0.15:

| Question | skipped negatives | missed action | reruns agree |
| --- | --- | --- | --- |
| original: "need to act", asks for work only | 52/59 (88%) | 7 | - |
| terse: "contains a request, question, assignment, or decision?" | 45/59 (76%) | 1 [0-3] | 101/103 |
| few-shot examples in the instructions | 48/59 (81%) | 4 [1-7] | 99/103 |
| numbered checklist | 35/59 (59%) | 3 [1-6] | 96/103 |
| "you are the recipient, what do you do next?" | 44/59 (75%) | 2 [0-5] | 98/103 |
| "when in doubt answer yes" | 38/59 (64%) | 2 [0-4] | 97/103 |
| **shipped: must-follow, unrequested reports are no** | **50/59 (85%) [45-54]** | **2 [0-4]** | **103/103** |

Thresholds move the tradeoff but do not fix a wording. The original at 0.25 misses 8 of 44, more
than at 0.15. The shipped wording at 0.1 misses 1 and skips 49, at 0.25 skips 50 and misses 2.

The original wording's misses were all one shape: a request inside a status report. "PR 306 now has
green checks, I need its merge before I can run the test" scored 0.002, and "One more server gap:
the event needs the inserted messageId" scored 0.011.

Run-to-run noise is real: the same wording scored two misses on one pass and four on the next, so
treat differences of one or two as noise. What survives the noise is the comparison between the
original, which missed a fifth of the action mail it was given, and every rewording after it.

## What the shipped wording says

> Does the receiving session need to act on this message? Answer yes when the message contains a
> request, question, assignment, blocker, or decision the recipient must follow, wherever it
> appears in the message. Answer no for answers or reports the recipient did not ask for, and for
> acknowledgments, agreements, thanks, and sign-offs.

"Wherever it appears" is the clause that paid: it catches an ask buried mid-paragraph, and the
"unrequested" qualifier keeps courtesy out while still waking the recipient for an answer it asked
for. That last case is what the first live skip got wrong: an answer to a question scored 0.133
under the original.

## What is still wrong

Two of the 44 remain below the threshold: a report whose only request is "leave that tree to me",
and a synthetic prompt fixture that no peer sends. The corpus is 103 messages labeled by one
reader, so the margins are directional. A second labeler on the same texts is the next thing to
add if the gate's misses start to matter.

## Re-running it

The harness is ~120 lines of Python: fetch threads with the domain's web token, dedupe, then POST
`{model, state, questions}` to `https://api.fireworks.ai/inference/v1/systemone` with
`accounts/fireworks/models/rune` under `S_KEY_COMMAND` from the `s` store. Keep the labels you
assign, run every variant twice, and rerun after any change to the question, the model, or the
provider.
