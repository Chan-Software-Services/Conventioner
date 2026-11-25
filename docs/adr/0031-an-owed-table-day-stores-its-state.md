---
layer: implementation
kind: adr
describes:
  - back-end/payments.py#owed_day_transition
  - back-end/payments.py#next_owed_state
  - back-end/payments.py#state_of
  - back-end/migrations/migrate_owed_day_state.py
verified: 2026-11-16
sources:
  - T277
  - T335
status: accepted
---

# An owed table-day stores its state

## Context

An Admin set what a vendor owes for Sunday to $0, a waiver, while the vendor held a Gold table that day.
The organizer then allocated tables again, and the run did not seat the vendor on Sunday.
The $0 was still stored, but the Payment tab showed no Sunday line, so nobody could see it, and "Change the amount owed" and "Use the calculated price" were refused for a day with no line, so nobody could clear it.
Seated on Sunday later at another table, the vendor owed $0 again, with the old Admin's name on it: a waiver given for a seat they no longer held.

The product could not prevent this, because nothing stored what an owed table-day was.
The Payment tab's lines worked it out at every read from three inputs (whether the seat was held, a `freed` record, and a `set_by_hand` that was nothing, an Admin's amount, or a free's $0 that might carry the Admin's amount it replaced), sixteen combinations whose precedence was spread over four functions.
Each writer wrote the fields it cared about, so a combination nobody designed, an Admin's amount on a day not held, was reachable and invisible.

## Decision

**Each owed table-day stores its state, and one function writes it: `owed_day_transition` in [`back-end/payments.py`](../../back-end/payments.py).**

- The states are four: the day **follows the seat**, which is no record at all, so `amounts_owed` keeps only what the seat cannot say; an Admin **set** an amount; its table was **freed**, its line kept as the seat stood, with an Admin's amount if one stands; or it was **freed and waived** by the free's deduction, owing $0 and keeping the Admin's amount it replaced.
- One pure table, `next_owed_state`, says what each event (seated, freed, freed with the deduction, dropped by a run, an Admin's amount set, the calculated price used) makes of each state, and refuses the cells that would write the hidden state.
- A run that drops a day drops an Admin's amount with it, recorded in the market's history as `owed_dropped`, naming the amount and who set it (Daniel's choice, T335).
- The owner reads the record, applies the table, and writes holding what it read: an insert the unique index guards for a day's first record, otherwise a write filtered on the record's `revision`, which every write counts up; after three misses it writes nothing and says so.
- The lines are a projection of the state and the held seat (`lines`), and on a held day a freed state reads as the seat (`on_day`), so a free that stopped between its record and its seat is harmless without a transaction.
- **The fields the release before reads, `freed` and `set_by_hand`, are kept as a mirror for one release**, written from the state by every write, and the read trusts the stored state only while they agree with it (`state_of`).
  A rolled-back release writes only those fields, so on the roll-forward a record it wrote is read from what it wrote, and its next write, or the migration run again, stores the state again.
- A migration, [`back-end/migrations/migrate_owed_day_state.py`](../../back-end/migrations/migrate_owed_day_state.py), gives every record its state and drops each hidden Admin's amount already stored with the same history entry, `--dry-run` first, and is safe to run again.

The states, the table cell by cell, and the owner's callers: [payments, and what a vendor owes](../implementation/data/payments.md#the-owed-days-state).

## Consequences

- A change to what an event does to a day is one cell of one table, and a test over every (state, event) pair sees it everywhere.
- A new event, such as a free that sticks across runs, is a new column of the table, not a field beside it.
- The owner never writes an Admin's amount on a day nobody holds, the read shows none as a line, and the migration drops any already stored.
- Every write of `amounts_owed` the product makes goes through the owner, and the migration's holds what it read the same way; a test that plants a record writes the release before's shape, which the read covers.
- Dropping the mirror is a later task's, once a release with this code has run.
- Running the migration against production is a release step ([`docs/RELEASING.md`](../RELEASING.md#migrate_owed_day_statepy)).

## Considered and rejected

- **Deriving the state at every read**, as before: it would need every writer to agree on the precedence of three fields forever, and the hidden state stays reachable by any writer that forgets one.
- **A transaction across the assignment and the owed record**, so a free's record and its seat land together: not proven on the Atlas Flex cluster production runs (T277's decision 9.2), and not needed once a freed state on a held day reads as the seat.
