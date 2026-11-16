---
layer: implementation
kind: adr
describes:
  - front-end/src/utils/useAutosave.ts#transition
verified: 2026-11-16
sources:
  - T277
  - T271
  - T420
status: accepted
---

# An autosave's state is one phase union moved only by its table

## Context

An organizer planning a market on Market Setup reads one line to know whether the server holds what they typed: "Saving…", "Plan saved", a failed line with Retry, or a refused line.
T277 reproduced two states that line should never reach: "Saving…" for good with nothing out, and "refused" beside an edit the server did not have.
T271 gave the line one owner, `useAutosave`, and fixed both, but its state was still a status string written at eight places beside ten other variables (edit counts, the edits the save out carried, a wanted flag, a held flag, a held edit), and the order the line must keep was a comment.
Any change could bring either state back, since nothing said which combinations of those variables were legal.

## Decision

**An autosave's state is one phase union, with the screen's hold beside it, and only one pure function moves it: `transition(state, event)` in [`front-end/src/utils/useAutosave.ts`](../../front-end/src/utils/useAutosave.ts).**

- The phases are six: `clean` (nothing unsaved, nothing out, with `saved` while "Plan saved" shows), `pausing` (an edit waits for its pause), `held` (an edit waits for the hold to end), `sending` (a save out, with what follows it and whether its answer drops everything), `failed` and `refused`.
- The hold is a flag beside the phase, not a phase: the Pricing card's hold outlives a failure, a refusal and a dropped edit.
- The events are the edit, the pause's end, a save's three answers, the person losing the right to write, the hold on and off, a flush, the screen taking the server's copy, and "Plan saved" ending.
- `transition` answers the next state and whether to start a save, and answers the same state object, with no send, for every pair not in the table, so a pair nobody designed changes nothing.
- The status, its sentence and `unsaved` are read from the phase (`statusOf`, `messageOf`, `unsavedIn`), never stored beside it, so "Saving…" with nothing out, or a refused line beside an edit made after the refusal, is no phase at all.
- The composable around the table owns only the timers and the save out's promise, and feeds events; who may write is asked where it was, and answers by the `lost` event.
- A screen saved a click at a time is the same table with no pause (`delay: 0`), and a screen with no Retry takes its copy back on a failure as on a refusal (`takesBackOnFailure`).

The table cell by cell, and every behaviour it keeps: [the autosave](../implementation/modules/plan-autosave.md#the-queue).

## Consequences

- A change to what an event does in a phase is one cell of one table, and a test per cell (`theAutosaveIsOneTransitionTable.test.ts`) sees it, beside a walk over every state reachable from clean that checks no pause runs under the hold.
- T271's behaviour suite (`useAutosave.test.ts`, `anAutosaveMayKeepARefusedCopy.test.ts`) passes unchanged: the interface every screen uses is the same.
- One visible change: a failed line gives way to the next edit, which is sent within its pause, and comes back if that save fails too; before, the failed line stood through the edit's pause.
- The review lists and the form tab can save one write at a time on the same table, rather than each keeping its own flags.

## Considered and rejected

- **Keeping the variables and adding asserts on their combinations**: the asserts would be a second statement of the table, kept in step by hand, and a missed combination would still be reachable.
- **The hold as a phase only**, as T277's report sketched it: a hold that begins in `failed` or `refused` would have to forget the failure or the refusal, and the failed line would vanish under the hold though the plan is not saved.
- **A state machine library**: the table is six rows of plain TypeScript with no dependency, and a library adds a bundle and a vocabulary for what one `switch` says.
