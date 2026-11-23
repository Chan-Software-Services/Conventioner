---
layer: implementation
kind: adr
describes:
  - .github/workflows/test.yml
  - scripts/ci_suite.py
  - scripts/promote_check.py
verified: 2026-11-24
sources:
  - T510
status: accepted
---

# A commit the merge queue tested is not tested again on `dev`

The nodes it constrains: [CI and the gate](../implementation/testing/ci-and-the-gate.md#which-suite-a-run-runs), [the test map](../implementation/testing/the-test-map.md) and [the release process](../RELEASING.md#how-a-promotion-proves-itself).
It narrows [ADR 0027](0027-main-moves-only-through-promote.md), "`main` moves only through Promote", in which run proves a commit.

## Context

Every pull request merged into `dev` ran the whole Test suite three times: on its head, on the merge queue's trial commit, and on the push to `dev`.
The queue merges by the very trial commit it tested, so the third run tested the same tree again: on PR 375's `3c1d7e14`, queue run 44308245312 and push run 44324061105, both green, about 165 runner minutes for nothing new.
On GitHub Free's 20 jobs at once, that run also made every other pull request's and queue entry's shards wait for runners.
It could not simply go, because Promote read only the push run, and the push run alone recorded the test map.
A per-pull-request job that ran the changed specs again had caught no flaky spec in its trial week, and asked a runner more of every pull request's run.

## Decision

**On a push to `dev`, a first job, `suite`, reads the queue's Test run on the pushed commit, and the run warms the caches or runs the whole suite.**
[`scripts/ci_suite.py`](../../scripts/ci_suite.py) prints `warm` when the newest run of `dev`'s queue on the commit passed (or is still going with every job passed or skipped), and `full` otherwise; a warm push runs only `warm-caches`, which restores or makes the caches the pull requests read and fails nothing.
Every doubt is `full`: no queue run, one that did not pass, GitHub unread, and any output of the script that is not one of its words, which [`.github/workflows/test.yml`](../../.github/workflows/test.yml)'s step shell turns into `full`, as the jobs read `suite` skipped or failed.
A pull request's run, a trial commit's and a push to `main`'s skip `suite` and run as before.

**Promote takes the newest Test run on the commit, from `dev`'s queue or a push to `dev`.**
[`scripts/promote_check.py`](../../scripts/promote_check.py) decides by the newest by `run_number`, which grows across events in one workflow, so a merged commit is decided by its push run (green when warm, whatever the suite said when it ran the whole suite), and a commit the queue merged inside a batch, which has no push run of its own, by its queue run.
A nightly run, a hand-started one and a pull request's never count.

**The test map is made by a nightly Test run on `dev`'s tip**, which runs only the shards, recording, and the `test-map` job, and does nothing when that commit already has a map; `gh workflow run test.yml --ref dev` makes one on demand.
No other run records any more, so recording, which slowed the suite, is never on the path to a merge.

**The per-pull-request repeat of the changed specs is removed whole**: its job, its script and its test.

## Consequences

- A clean merge costs its pull request's run, its queue run and a push run of two short jobs, plus its share of a night's map, about 165 runner minutes fewer than before.
- A commit that reached `dev` without the queue still gets the whole suite on its push.
- Promote's link may be a warm push run's, which tests nothing; that run's summary names and links the queue's run that proved the commit.
- A whole-suite push run that fails on a commit whose queue run passed refuses the promotion, as before; a re-run of its failed jobs makes it pass.
- The test map is up to a day behind `dev`, which its readers already allowed for; a red nightly run that ran only the shards and `test-map` is information only, since no rule reads those checks, and the next night tries again.
- A nightly or hand-started run whose `suite` job itself fails (a runner or checkout failure, since the script says `map` on any doubt) runs the whole suite on `dev`'s tip, as any empty word does, and posts the required checks there under their names, newer than the queue's.
  A red one among them may lead `main`'s rule to refuse the App's fast-forward of that commit, while Promote's own check, which reads no nightly run, passes; `main` stays unmoved, and a re-run of that run's failed jobs, then Promote again, moves it.
- `main`'s rule that requires the six checks reads the App's fast-forward to a queue-tested commit through the queue run's checks and the warm push's skipped ones, which GitHub reports as success.

## Considered and rejected

- **Waiting in the push run until the queue's run is marked completed**: the wait holds a runner and needs a timeout of its own, while the queue merges only once its required checks have passed, so the run's jobs already say what its status says seconds later (run 44308245312 was last updated 4 seconds before push run 44324061105 was created).
- **Recording the map in the queue's run**: on `3c1d7e14` the recording push run spent 127 minutes in tests across its shards against the queue run's 99 (+28%), about 6 minutes more on the path to every merge, plus the 6-minute `test-map` job, and a test near its timeout that failed only while recording would drop a pull request from the queue.
- **A workflow of its own for the map**: it would repeat the shards' setup and matrix, which the Test workflow already holds, and two workflows would have to agree on them.
