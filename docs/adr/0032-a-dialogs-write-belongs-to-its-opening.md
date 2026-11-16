---
layer: implementation
kind: adr
describes:
  - front-end/src/utils/useSubmit.ts
  - front-end/src/utils/useDialogSubmit.ts
  - front-end/src/components/AppDialog.vue
verified: 2026-11-16
sources:
  - T277
  - T411
status: accepted
---

# A writing dialog's request state is one table keyed by its opening, and the shell holds it

## Context

An organizer recorded a payment on a slow network and closed Record payment while the write was out.
Opened again, it read "Recording…" and was disabled; the first write's refusal appeared in the new opening, and its success closed the new opening and dropped what they had typed.
Each dialog kept its own `busy` and its own error, so each had to remember to reset them on opening, to disable its confirm while it wrote, and to hold its closes, and most did not.
The shell's hold, `closeDisabled`, was opt-in: 12 of the 38 files that draw `AppDialog` held while they wrote, and several confirms were never disabled, so a double press deleted a market twice or made two organizations.
The sign-in pages had the same shape without a dialog: Send code pressed twice sent two requests, and the server's one-code wait refused the second over a good code.

## Decision

**A form's submit is one transition table, `submitStep` in [`useSubmit.ts`](../../front-end/src/utils/useSubmit.ts): editing, sending, refused with its sentence, or done, in an opening each answer is tied to.**

- A submit is taken from any phase but sending, so a second press while one is out sends nothing.
- An answer moves only the opening it was sent in; an earlier opening's goes to the form's `late` handler, and none is heard once the component is gone.
- An edit takes a refusal, or a save that stays open, back to editing; an opening starts editing again, whatever is still out.
- `useSubmit({ scope })` holds it for a page's form, a change of `scope` being a new opening.

**A dialog's is the same table keyed by what it is open on, [`useDialogSubmit`](../../front-end/src/utils/useDialogSubmit.ts), handed to [`AppDialog`](../../front-end/src/components/AppDialog.vue) as `submission`, from which the shell derives the hold.**

- While any of a dialog's submissions sends, the shell refuses every close and disables the confirm; it says a single form's refusal in its error line until a field changes, unless the dialog says it itself (`says: 'self'`).
- `opening` is the dialog's `open` prop, or the thing its parent opened it with, so a close and a reopen, or an opening on another thing, is a new opening.
- A dialog whose `done` hands the answer to its parent hands a late answer on by the parent's refresh path, never by the event that closes: Record payment's late account goes to the Payment tab as `refreshed`.
- `closeDisabled` and `confirmDisabled` stay for holds that are no write, a file drawn or downloaded and a confirm a field turns on and off.

The rules are in [dialogs](../implementation/conventions/dialogs.md#the-rules).

## Consequences

- No dialog that writes on a press keeps a `busy` or an error of its own for its write, and none of them can forget the hold: a dialog on its submission holds through its write with nothing else asked.
- Every file that draws `AppDialog` is said to write or not, on the lists of [`everyWritingDialogUsesTheSubmit.test.ts`](../../front-end/src/__tests__/everyWritingDialogUsesTheSubmit.test.ts), which fails a new one until it is, and a writing dialog with no submission.
- An answer for an earlier opening cannot close, mark or fill the one the person is in, whatever the network does.
- A re-read inside a write asks the submission whether its opening still stands (`isCurrent`, handed to `send`), so no dialog keeps a count of its openings for its writes; Manage market keeps one only for the reads no write sends, as it opens and when its permissions change, which no submission holds.
- A request that never answers holds its dialog until a reload, since there is no timer and no retry, as before.
- Browser history is not a close: Back during a held write still takes the page, and the opening and the unmount rule only keep the late answer out of what comes after.

## Considered and rejected

- **A guard per dialog** (resetting `busy` on opening, a sequence number per dialog): the shape the product had, a rule each dialog must remember; most did not.
- **Holding by `closeDisabled` everywhere**: it holds the closes but leaves the confirm, the reset on opening and the late answer to each dialog.
- **A timeout that ends the hold**: the write may still land after it, which is the late answer this decision keeps out.
