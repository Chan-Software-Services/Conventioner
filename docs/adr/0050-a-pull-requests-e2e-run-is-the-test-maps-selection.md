---
layer: implementation
kind: adr
describes:
  - .github/workflows/test.yml
  - scripts/affected-specs.py
  - front-end/scripts/e2e-shards.ts
verified: 2026-11-26
sources:
  - T605
  - T612
status: accepted
---

# A pull request's E2E run is the test map's selection; the merge queue's run is whole

The nodes it constrains: [CI and the gate](../implementation/testing/ci-and-the-gate.md#what-a-pull-requests-e2e-run-runs) and [the test map](../implementation/testing/the-test-map.md#choosing-a-builders-specs).
It narrows [ADR 0043](0043-a-commit-the-queue-tested-is-not-tested-again-on-dev.md) in what a pull request's run runs.

## Context

Before this decision, every pull request ran the whole E2E suite on ten shards, about 100 test minutes and about 150 of its run's 165 runner minutes a head, whatever it changed.
GitHub Free's 20 jobs at once are the team's bottleneck, so the minutes a pull request spent on specs its change could not reach held back every other pull request and queue entry.
The merge queue already ran every suite on the commit it would merge.

T605 counted two weeks of CI, from 2026-11-11 to 11-25: [the test map](../implementation/testing/the-test-map.md) named every one of the 26 failed specs that were caused by their run's change; the other 14 were flaky or date-bound, and the 6 of them it did not name were specs their change could not reach.
The map named a mean 71% of the suite's test minutes for a head, and none of its specs for 62 of the 366 heads, docs, CI and unit-test changes.
Five of those 6 failures had sent a pull request's builder to fix a spec its change never touched.
The count of the map's precision is thin: only 4 pull requests tested its precise rules with a real failure.

## Decision

**A pull request into `dev` runs the E2E spec files the test map names for its change, with no cap, and none when it names none.**
[`scripts/affected-specs.py ci`](../../scripts/affected-specs.py) chooses the files and [only as many shards as their minutes need](../implementation/testing/ci-and-the-gate.md#what-a-pull-requests-e2e-run-runs), so that each holds about a whole run's share of the suite, and [`front-end/scripts/e2e-shards.ts`](../../front-end/scripts/e2e-shards.ts) deals the files to them.
Its `e2e` check passes when every shard passed and they ran exactly the named files, each once, or when no file was named and no shard ran.

**The merge queue's run is whole, and its `e2e` check demands every spec file.**
It checks without the selection's list and refuses a shard that dealt less than the suite, so no fault of the selection can slim it unseen.
So every check that can block a merge still runs before it.

**Every doubt runs the whole suite**: no map, a map made more than seven days ago, and a selection that failed or printed anything but one well-formed decision.
So does every other run that runs the shards, a hotfix's pull request into `main` among them.
[`.github/workflows/test.yml`](../../.github/workflows/test.yml) holds the shell that reads the decision, and its shards and `e2e` read an empty one as the whole suite.

**A change to the E2E run's own machinery names every spec**, as the map's [rule 4](../implementation/testing/the-test-map.md#choosing-a-builders-specs) lists it.
So its builder sees the shards run on the pull request, and can iterate without a queue trip.

**The queue's run audits each failure against what the pull request's run would have run**, so a spec the slimmed run left out is named, and the count of misses goes on.
A failure it names that the change caused is the ground to send the pull request's run back to the whole suite.

## Consequences

- A docs or unit-test change, or a CI change outside the E2E run's own machinery, runs no E2E shard, and a change that names few specs takes few runners.
- A flaky or date-bound spec surfaces on the merge queue, or on a later pull request whose change names it, rather than on an unrelated one; a queue failure ejects the trial commit's pull request and needs a fix of its own.
- A spec the map left out, one newer than the map among them, is first run on the queue, where a miss costs one ejected trial commit, never a red `dev`.
- A change to the E2E run's own machinery pays a whole run on its pull request.
- The queue's audit is how the map's precision keeps being counted; it decides the selection again when it runs, so it is not a record of what the pull request's run did.
- A pull request's run waits for `e2e-select`, which reads the map from GitHub, before its shards start.

## Considered and rejected

- **Keeping the pull request's run whole**: it saves nothing, and every flaky or date-bound spec keeps surfacing on whichever pull request meets it first.
- **Slimming the merge queue's run too, with the nightly run as the net**: it saves the most, and a miss would merge to `dev` and show only on a nightly run that blocks nothing.
- **Narrowing the rules that name the whole suite first, and counting again**: it would raise the saving, but each file placed is a new way to miss, which only another count would test.
- **A cap on the pull request's selection, as a builder's run has**: a spec the cap cut would be one the map named for the change, left to the queue.
