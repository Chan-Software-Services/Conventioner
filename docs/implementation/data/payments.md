---
layer: implementation
kind: data
describes:
  - back-end/payments.py
  - back-end/api/payments.py
  - back-end/datatypes.py#PaymentEntry
  - back-end/app.py#get_vendor_account
  - back-end/app.py#record_payment
  - back-end/api/placements.py#remove_placement
  - front-end/src/utils/payments.ts
  - front-end/src/components/VendorPaymentTab.vue
  - front-end/src/components/RecordPaymentDialog.vue
  - front-end/src/components/ChangeOwedDialog.vue
  - front-end/src/utils/useAmountField.ts
  - front-end/src/components/RowMenu.vue
  - back-end/app.py#record_refund
  - back-end/app.py#set_amount_owed
  - back-end/app.py#use_calculated_price
  - back-end/app.py#edit_payment
  - back-end/app.py#remove_payment
  - back-end/app.py#get_market_payments
  - back-end/app.py#verify_payment_indexes
  - back-end/migrations/migrate_owed_day_state.py
  - back-end/tests/fixtures/balance_states.json
verified: 2026-11-18
sources:
  - T92
  - E44/F01/S01
  - E44/F01/S02
  - E42/F01/S04
  - E44/F02/S01
  - T263
  - T270
  - T201
  - T315
  - T335
  - T318
  - T422
  - T411
  - T421
---

# Payments, and what a vendor owes

What each vendor owes for each table-day, and the payments an organizer records against it.
[`back-end/payments.py`](../../../back-end/payments.py) owns both collections, and every reader and writer goes through it; [`back-end/api/payments.py`](../../../back-end/api/payments.py) loads the market, asks the table and answers the drawer's Payment tab ([the vendor drawer](../../business/flows/vendor-drawer.md)).

Conventioner tracks what is expected and what came in, not accounting (Daniel, T92 Q5): vendors pay outside the app, by e-transfer or cash (Q7), and an organizer records each payment by hand.

## The amount owed, per table-day

**A line per table-day**: the date, the table, its tier, full or half, and the amount owed for it.
By default the amount is the price of the seat the vendor holds that day, by the price group their answers put them in (`Groups` and `row_prices` in [`back-end/pricing.py`](../../../back-end/pricing.py), [a price follows the table](../../business/rules/a-price-follows-the-table.md)), and the line names the group as the date card does ("North Wing 1, Gold, full table, Example College student + club member"), so a line nobody has set follows its seat: a seat moved from Gold to Silver owes the Silver price (Q26: "the pricing scheme sets the default amount owed by calculating it").
The seats are read off the market's stored assignment, through the same rows and the same pricing the drawer's date cards read (`derive_market_table_rows`, `seats_by_vendor`), so a line and its date card never disagree.
A seat held now is never copied into these collections; only what the assignment cannot say is kept, as the day's state.

### The owed day's state

Each owed table-day is in one of four states, `OwedState` in [`back-end/payments.py`](../../../back-end/payments.py) ([ADR 0031](../../adr/0031-an-owed-table-day-stores-its-state.md)):

- **Follows the seat** (`FollowsSeat`): no record at all.
  The day owes the price of the seat it holds, and has no line without one.
- **Set** (`SetByHand`): an Admin set the amount (`HandAmount`, its `cents`, `by` and `at`), $0 being the waiver (Q26: "instead of a button to waive, the admin will set amount owed to zero"); there is no waive control anywhere.
  It belongs to the vendor's day, not the table, so a move of the seat keeps it.
- **Freed** (`Freed`): the day's table was freed, and its line is kept as the seat stood (`FreedSeat`, the seat and who freed it and when), owing the Admin's amount if one stands, else what the seat cost the day it was freed.
- **Freed and waived** (`FreedWaived`): freed by a free that ticked the deduction, so the line owes $0, set by that free, and keeps the Admin's amount the $0 replaced (`before`), if one stood.

**One table says what each event makes of each state**: `next_owed_state(state, event, *, held, cents, seat, by, at)`, a pure function that raises `OwedEventRefused` on a refused cell.
The events are `OwedEvent`: `seated` (a placement, a move, a swap or a run that seats the day), `freed` (a free unticked), `freed_with_deduction` (a free ticked), `dropped_by_run` (a run that leaves the vendor without a table that day), `admin_sets` ("Change the amount owed") and `admin_calculated` ("Use the calculated price").
`held` is whether the day is held in the assignment the write read, and `seat` the seat a free frees.
The rows for following the seat and set are a held day's, and the rows for the two freed states a day not held; `s` is the freed seat, `a` an Admin's amount and `b` the one a waiver replaced, if any:

| From \ event     | seated                                                   | freed       | freed_with_deduction | dropped_by_run                           | admin_sets      | admin_calculated                  |
| ---------------- | -------------------------------------------------------- | ----------- | -------------------- | ---------------------------------------- | --------------- | --------------------------------- |
| follows the seat | follows the seat                                         | freed(s)    | waived(s, none)      | follows the seat                         | set(cents)      | follows the seat, nothing written |
| set(a)           | set(a)                                                   | freed(s, a) | waived(s, a)         | follows the seat, `owed_dropped` names a | set(cents)      | follows the seat                  |
| freed(s, a)      | set(a)                                                   | refused     | refused              | freed(s, a)                              | freed(s, cents) | freed(s)                          |
| freed(s)         | follows the seat                                         | refused     | waived(s, none)      | freed(s)                                 | freed(s, cents) | freed(s), nothing written         |
| waived(s, b)     | set(b), or follows the seat with no b; `owed_taken_back` | refused     | refused              | waived(s, b)                             | freed(s, cents) | freed(s)                          |

`freed(s)` is a freed line with no Admin's amount, and `waived` is freed and waived.

- **An Admin's change on a day with no line is refused**: `admin_sets` and `admin_calculated` on following the seat with the day not held raise `OwedEventRefused`, since an Admin's amount on a day nobody holds is a line nobody sees, and the owner never writes one.
  The routes refuse such a day before the owner, 404, "That vendor holds no table that day, so nothing is owed for it." (`NO_LINE`), and answer a refused cell the same.
- **A free needs a held day**: `freed` on a day not held is refused; `freed_with_deduction` on a day not held is Free pressed again ([freeing a table asks](#freeing-a-table-asks)), taken only from `freed(s)`.
- **Seated again, a freed day's Admin's amount is set again**, `freed(s, a)` to `set(a)`, as a waiver's `b` is: the amount belongs to the vendor's day (T335's question 1, Daniel's choice).
- **"Use the calculated price" on a free's $0 owes the freed seat's price again**, `waived(s, b)` to `freed(s)`, and does not put `b` back: the control does what its words say, and an Admin who wants their amount back sets it (T335's question 2, Daniel's choice).
- **An Admin's amount set on a freed line stays a freed line** owing that amount, kept with its seat, so the line still says where it came from.
- **An Admin's change keeps a stored freed seat even on a held day**: `admin_sets` and `admin_calculated` do not read a freed record through `on_day` (below) first, since the Admin's request read the seat held, and a free in flight has written its record before its seat goes.
  Kept with the seat, the amount reads as set while the seat is held and as the freed line's once it goes, so either way the free ends, the day is right.
- **A run that drops a day drops an Admin's amount with it** (Daniel's choice, T335): `set(a)` with `dropped_by_run` leaves no record, and the market's history records `owed_dropped`, naming the amount and who set it, under the run's row `assign`, by whoever allocated tables ("… allocated tables, leaving Alice Example without a table on May 8, 2099, so the $0.00 admin@example.com set for that day was dropped").
  Seated on that day again later, the vendor owes the new seat's price.
- **An Admin's amount never stays hidden on a day not held**: a seating that finds one on a day seated afresh (a release before T335 left it, or a drop that did not land) drops it the same way, recording `owed_dropped` by whoever seated the vendor, marked `held_no_table` in its subject, with the migration's sentence, since nobody dropped it ("Alice Example held no table on May 8, 2099, so the $0.00 admin@example.com set for that day was dropped").
- **A free's $0 taken back is recorded** only for a day not held in the assignment the write read, which is a day that really read as freed: `owed_taken_back`, under the seating's own row `assign`, by whoever placed the vendor or ran the assignment ("… seated Alice Example again on May 8, 2099, taking back the $0.00 set when the table was freed"), from the $0 to what the day owes now, the Admin's amount where the $0 replaced one.
- Manage market's "Kind of change" lists `owed_dropped` and `owed_taken_back` under Assignment, and under Payments beside the changes to what is owed they undo ([the market's history](history.md#reading-it)).

### Reading the state

- **`state_of(doc)` never raises**: no record follows the seat; a record whose stored `state` agrees with its legacy fields ([below](#the-legacy-fields-a-mirror-for-one-release)) is its `state`; one with no `state`, or one whose legacy fields disagree with it, is read from the legacy fields (`derive_from_legacy`), and a disagreement logs a warning naming the market id, the date and the record id, never an address.
  A record whose fields cannot be read at all logs the same way and reads as following the seat.
- **`on_day(state, held)` is the state a day reads as, and a held seat always wins** (T270): on a held day a freed state reads as seating the day makes it, `set` to the Admin's amount it holds (`amount`, or a waiver's `before`), else following the seat.
  A freed record on a held day is a free that stopped before its seat went, or a seating that stopped before it tidied the day, so a table the vendor holds never reads as given away, and the day's next seating, drop or free tidies the record.
  On a day not held, `set` (an amount a release before T335 left on a day a run dropped, or one whose drop did not land) reads as following the seat, with a warning by market id, date and record id; the migration, or the day's next seating, drops it ([the migration](#the-migration)).
- **The lines are a projection** (`lines(seats, kept)`) of each day's state as it reads and the seat held on it, reading nothing else of the record: a held day reads its seat and price, or the Admin's amount with `owedSetBy` and `owedSetAt`; a freed day reads the seat as it was freed, `freed` true with `freedBy` and `freedAt`, owing the Admin's amount or the seat's price, or the free's $0 with `owedByFree` true and the free as who set it; a day neither held nor freed has no line.

The tab tells the amounts apart: a free's $0 reads "Removed when the table was freed, by …", an amount set by hand "Set by …", with the calculated price struck beside it and when it was set.
A freed line says where its number came from: the seat, and that it was freed and when ("North Wing 1, Gold, full table - table freed Oct 30, 2026", `lineSource` in `payments.ts`; Daniel: "from Sunday, now deleted").

### The legacy fields, a mirror for one release

Every write also stores the record's `freed` and `set_by_hand` as the release before T335 writes them (`legacy_fields(state)`), so a rollback past it reads every line as this release does: `set(a)` is `set_by_hand` `a`; `freed(s, a)` is `freed` (the seat's fields, and who freed it and when) with `set_by_hand` `a` where one stands; `waived(s, b)` is `freed` with `set_by_hand` `{cents: 0, by, at, by_free: true}`, the free's, and `replaced: b` where `b` stood.
A rolled-back release writes only those fields, so `state_of` trusts the stored `state` only while they equal `legacy_fields(state)`: on the roll-forward, a record that release wrote is read from what it wrote, and its next write, or the migration run again, stores its state again.
`derive_from_legacy` is `legacy_fields` read backwards, the two inverses over every state; a free's $0 with no freed seat (a free of the release before that stopped on a held day) reads as the Admin's amount it replaced, or as following the seat.
Dropping the mirror is a later task's, once a release with this code has run.

### The one writer

`owed_day_transition(market_id, vendor_email, date, event, *, held, by, cents=None, seat=None)` in `payments.py` is the only function that writes an `amounts_owed` record.
`held` is the seat the day holds in the assignment the caller read, or None; for `seated` it is the seat held before the write, so a day seated afresh reads its freed state and a day held already reads through `on_day`.
It reads the record, applies `next_owed_state` to the state the day reads as, and writes nothing when the result is the stored state exactly and that state is trusted; otherwise:

- with no record read, it inserts the state, its mirror and `revision` 1, or nothing for following the seat; a record created since is refused by the unique index ([below](#one-vendors-day-is-one-owed-record-by-the-database)), and it reads the day again;
- with a record read, it updates the state, its mirror and the `revision` counted up, or deletes the record for following the seat, filtered on its `_id` and the `revision` read (`$exists: false` on a record no release counted); a miss reads the day again;
- after `OWED_TRIES` (3) reads it raises `OwedDayChanged`, having written nothing, and a refused cell raises `OwedEventRefused`, having written nothing too.

It answers an `OwedTransition`: the state the record stored as read (`stored`), the state the day read as (`before`), the state it stored (`after`), the record as read, the revision written and the `_id` of the record written (`record_id`), and `changed`, whether what the day reads as changed, which alone the history records on, so a write that only tidies a stopped free's record on a held day records nothing.
Its `undo()` puts the record's own fields back as they were read, or takes away a record it made, only while the record it wrote, by its `_id`, still holds the revision written: a write that landed since is the day's, a record made since at the same revision included, and `undo()` answers False, having put nothing back.
Neither caller's events end in following the seat, so it refuses to undo a write that deleted the record (`ValueError`).

Its callers are in [`back-end/api/payments.py`](../../../back-end/api/payments.py):

- `set_amount_owed` and `use_calculated_price` (both through `_change_owed`) refuse a day with no line, 404 `NO_LINE`, then send `admin_sets` or `admin_calculated` with the seat held (`seats_by_vendor`).
  A refused cell, the line gone meanwhile, answers 404 too, and so does an Admin's amount written as a write of the assignment that left the vendor without the day landed: once the owner has written a `set`, the stored assignment is read again (`_holds_now`), and a day no longer held is put back as it was read (`undo()`), so the amount never stands on a day with no line.
  When nothing was put back, the run's own tidy of the day landed after the owner's write, dropped the amount and recorded `owed_dropped`: the amount was set, so the request answers the account as the market now stands, with no line that day, and records `owed_set` at the time the owner wrote the amount (`HandAmount.at`), so the history reads the set before the drop.
  A day that kept changing answers 409, "What this vendor owes for that day kept changing as it was saved, so nothing was changed. Try again." (`OWED_KEPT_CHANGING`); a change that left the day reading as it did answers the account with no history entry.
- `keep_freed_line` sends `freed` or `freed_with_deduction` with the seat held, for a free ([below](#freeing-a-table-never-changes-either-amount-by-itself)), and `deduct_freed_day` sends `freed_with_deduction` with nothing held, for Free pressed again.
- `assignment_written(asked, *, seated, held_before, dropped)` runs after every write of the assignment ([placements](../modules/placements.md) says which days each write hands it): each seated day takes `seated` and each dropped day `dropped_by_run`, recording `owed_taken_back` and `owed_dropped` as the table says, through `asked`, the write's Assign asking.
  It reads only the market's records that may move, in one read (`records_that_may_move`: every record holding a freed line, and any on a date seated afresh or dropped), so a run never reads the market's records one by one.
  An `OwedDayChanged` or a refused cell there never fails the assignment's write, which has landed: it is logged as a failure a route goes on past is ([an exception never reaches a client](../conventions/an-exception-never-reaches-a-client.md)), an error naming the market id and the date with its frames, and the day reads through `on_day` until its next write.

### Freeing a table never changes either amount by itself

Q26: after the cancellation deadline "the amount owed and amount paid dont change even though the table did".
`remove_placement` in [`back-end/api/placements.py`](../../../back-end/api/placements.py), the one door that frees a seat ([placements](../modules/placements.md)), writes the day's owed record through the owner before it frees the seat (`keep_freed_line`), `freed`, or `freed_with_deduction` when the deduction was asked (below), so a line that could not be kept leaves the seat where it was, and no stop after the seat leaves the day freed and owing its full amount.
The record's write and the seat's are not one transaction: a free that stops between them leaves a freed record on a held day, which reads as the seat (`on_day`).
A free whose seat write is refused because another change to the tables landed first undoes its record (`undo()`), which lands only while the record still holds what this free wrote, so a free of the same seat that landed meanwhile keeps its own record, with any $0 its deduction set.
A seat write that fails any other way may have reached the database before its error, a network error on the way back, so the record goes back only while the stored assignment still seats the vendor that day (`_still_holds`); a seat that went keeps its line and any $0, and one that cannot be read again keeps them too, read over by the held seat until the day's next seating, drop or free.
A day whose record kept changing under the free frees nothing, 409, "What this vendor owes for that day changed as the seat was freed, so nothing was freed. Try again." (`OWED_CHANGED_UNDER_FREE`); an Admin's amount set in between is the one the free keeps, as the freed line's or as the $0's `before`, never written over.
The line stays, owing what the seat cost the day it was freed, until an Admin sets it; seated again that day, the line follows the table above.
A run keeps no line for a seat of its own that a later run moves: it runs only in assignment, before results are published, while the assignment is still being made, and every hand placement is a pin each run keeps.
Every free keeps the line, before results are published too (Daniel chose this over dropping it, after T121's review).

### Freeing a table asks

Q26: "when we remove a table, promp the user to ask if it should also dedudct from amount owed".
Whoever may change the amount owed is asked in the placement dialog, beside "Free this seat", "Also remove its $15.00 from what Alice owes? (Cancelled before the deadline: a refund may be due.)", unticked, naming what the day's line owes, set by hand or calculated, read from the vendor's account as the dialog opens; a line that owes nothing asks nothing.
Ticked, the free sends `deductOwed: true`, and `remove_placement` asks the row "Change the amount owed" before it frees anything; the owner's one write then keeps the freed line owing $0 before the seat goes, keeping any Admin's amount as `before`.
The amount paid is untouched, so a vendor who paid reads paid more than owed, a refund to issue.
A free of a vendor who has checked in that day is asked about first, before the line is kept, so the question writes no line; "Free anyway" sends the same `deductOwed` again with `whileHere: true` (T318, [placements](../modules/placements.md)).
The "owed set" entry it records once the seat is freed runs from what the line owed as the request read it, while the seat was held, to 0, and reads nothing again.
Pressing Free again, ticked, on a day the vendor no longer holds finishes a deduction a free from before T270 left undone: on a freed line holding no Admin's amount it sets the free's $0 (`deduct_freed_day`, with its "owed set" entry), and answers `{"removed": 0}`; on any other day it writes nothing.
Anyone else frees the seat with no such question, and the line stays owed for an Admin to decide.

### The migration

[`back-end/migrations/migrate_owed_day_state.py`](../../../back-end/migrations/migrate_owed_day_state.py), `[--dry-run]`, gives every record of every live market (`tombstone.live`) the state the read gives it, judged by the same rule (`read_record`), against the days the market's stored assignment holds:

- a record whose `state` is absent or disagrees with its legacy fields is stored as `on_day` of `derive_from_legacy`, and one that follows the seat is deleted;
- an Admin's amount on a day not held, its state stored or not, is deleted with an `owed_dropped` entry recorded with no actor, through the history's unasked door (`MIGRATION_DROPS_UNASKED`, [the market's history](history.md)), and `by_migration` in its subject ("Alice Example held no table on May 8, 2099, so the $0.00 admin@example.com set for that day was dropped");
- a trusted state is otherwise left, a freed one on a held day included, since a free writes its record before its seat goes and may be in flight.

Each write holds the record as read (its `_id` and the fields its owner writes, `OWNED_FIELDS`: `state`, the legacy fields and `revision`) and counts `revision` up from the one read; a record that changed meanwhile is read again with the assignment, up to three tries, then listed as skipped, and a record that cannot be read is left and listed.
It prints each record it changes by market id, date and record id with what it sets, never a name or an address, and a count ("would set" on a dry run), and is safe to run again.
It runs right after the deploy, `--dry-run` first, and again after any roll-forward past a rollback ([releasing](../../RELEASING.md#migrate_owed_day_statepy)): until it runs, such a hidden amount is dropped only when its day is next seated.

## The amount paid

**The sum of the vendor's entries still standing**: each an amount in whole cents of the market's currency, e-transfer or cash, the day it was paid, an optional note, and who recorded it and when (Q15, Q7b).
An entry is a payment, or a refund: money given back, recorded once it is given (Q26: "when the refund is settled they can come back and adjust amount paid so it zeros out"), the same fields, stored as a negative amount and shown "-$15.00", "Refund by e-transfer, given …".
The app never proposes a refund (Q20), and there is no "refund due" state: paid more than owed, "Paid $15.00 more than owed", is the sign one is to be issued.

**An edit or a removal keeps the entry's own history**: an edit sets the entry's fields and pushes what it read before onto its `changes`, with who and when; a removal marks it `removed_by` and `removed_at`, pushes the same, and leaves it listed, its amount struck, out of the amount paid.
Either way the entry still reads "Recorded by …", with "Edited by …" or "Removed by …" under it.
A removed entry is changed no more.

**An edit or a removal lands only on the entry as the server read it** (T335): two Admins editing one entry at once used to blur what its `changes` said each read, and an edit could land on an entry removed a moment before.
`edit_payment` and `remove_payment` in `payments.py` take the entry as `_change_entry` in `api/payments.py` read it, and write with `find_one_and_update` filtered on its id, `removed_at` null and as many lines in `changes` as it read (`entry_as_read`), so the history's `before` and the entry's own `changes` line are the read the write held.
A miss reads the entry again and raises `EntryChanged`, saying whether it was changed or removed, and is not tried again, since the person decided on the entry as it stood; `_change_entry` answers it 409 (`EntryChangedMeanwhile`), with the account as it stands under `account`, and records nothing in the history:

- an edit of an entry changed meanwhile: "This payment changed while your change was being saved, so it was not saved. It now reads as shown behind this: close this and edit it again if it should still change.";
- an edit of an entry removed meanwhile: "This payment was removed while your change was being saved, so it was not saved.";
- a removal of an entry changed meanwhile: "This payment changed while it was being removed, so it was not removed. It now reads as shown behind this: close this and remove it again if it should still go.";
- a removal of an entry removed meanwhile: "This payment was already removed."

Each says "This refund …" for a refund.
An entry already removed when the request first reads it, as the dialog still showing it standing meets one another Admin removed before, is refused the same way, 409 with the removed sentence and the account showing it struck; an id the market has no entry by is not found, 404 (`NO_ENTRY`).
The edit dialog keeps its refusal shown and hands the account on (`refreshed`), and `VendorPaymentTab`'s removal confirmation stays open on its refusal with the account shown behind it, its Remove disabled until it is opened again, since it still reads the entry it was opened on; `accountAsItStands` in `payments.ts` reads the account off any 409 that carries one.

## The stored shape

Two collections, each snake_case with the market foreign key `market_id` and the vendor's address lowercased (`vendor_email`), like `vendor_notes`:

**`payments`**, one document per payment or refund:

- `id`
- `market_id`
- `vendor_email`
- `kind`: `payment` or `refund`; none on an entry before refunds, which reads as a payment
- `cents`: negative for a refund
- `method`: `e-transfer` or `cash`
- `paid_on`: `YYYY-MM-DD`
- `note`: blank for none
- `recorded_by`
- `recorded_at`
- `request_key`: the press of Record it was recorded by; none on an entry before T270, or from an older tab
- `changes`: each edit or removal, `{by, at, what, before}`
- `removed_by`
- `removed_at`

**`amounts_owed`**, one document per vendor per table-day that does not follow its seat:

- `market_id`
- `vendor_email`
- `date`
- `state`: [the day's state](#the-owed-days-state):
  - `kind`: `set`, `freed` or `freed_waived`
  - `amount`: an Admin's amount, `{cents, by, at}`: on `set`, and on `freed` where one stands
  - `seat`: the seat as it was freed, `{table_code, tier, table_choice, cents, group}`, `cents` null where unpriced: on `freed` and `freed_waived`
  - `freed`: who freed it and when, `{by, at}`: on `freed` and `freed_waived`
  - `waiver`: the free that ticked the deduction, `{by, at}`: on `freed_waived`
  - `before`: the Admin's amount the waiver replaced, `{cents, by, at}`: on `freed_waived` where one stood
- `revision`: counted up by every write of the record, which the next write holds; none on a record no release counted
- `freed` and `set_by_hand`: [the legacy mirror](#the-legacy-fields-a-mirror-for-one-release), as the release before T335 reads them:
  - `freed`: the seat's `table_code`, `tier`, `table_choice`, `cents` and `group`, and `by` and `at`
  - `set_by_hand`: `cents`, `by` and `at`, and on the $0 a free's deduction set `by_free` and, where it replaced an Admin's amount, `replaced`, that amount's `cents`, `by` and `at`

A payment's or a refund's body is `PaymentEntry` in [`back-end/datatypes.py`](../../../back-end/datatypes.py), strict, so an amount sent as text or with a fraction of a cent is refused rather than read: from 1 cent to $100,000, the most a price cell holds; a date that is a calendar day; a note of at most 500 characters.
`payments` is indexed on `market_id, vendor_email` ([lookup indexes](lookup-indexes.md)) and unique on `market_id, request_key` where the key is a string (below), `amounts_owed` is unique on `market_id, vendor_email, date` (below), and both are deleted with the market (`delete_for_market`, called by [market deletion](../modules/market-deletion.md)).

### One vendor's day is one owed record, by the database

The one `amounts_owed` document per vendor's day is the database's to hold, not the writers' (T270).
A day's first record is an insert, and two writes that land at once on a day with no record both read none: without the index an Admin setting the amount as an Editor freed the seat could leave two records, and whichever the server found first won, so the amount set did not stick or the freed line was lost.

- `ensure_payment_indexes` builds `amounts_owed_vendor_day_unique`, unique on `(market_id, vendor_email, date)`, through [`unique_indexes.py`](../../../back-end/unique_indexes.py), and `app.py`'s `verify_payment_indexes` refuses to boot without it, naming any duplicates by market id, date and record id, never by address ([OPERATIONS.md](../../OPERATIONS.md#when-the-back-end-refuses-to-boot)).
- The owner's insert refused by it reads the day again and lands on the record the first write made, as any later write does, holding its `revision`: the day holds what each wrote, an Admin's amount that won being kept by a free as the freed line's or as the $0's `before`.
- The index's prefix serves a vendor's days and a market's, so `amounts_owed` has no lookup index of its own; a database that already held the old `(market_id, vendor_email)` one keeps it, which is harmless.

### A payment is recorded once per press

An organizer who pressed Record payment, got an error because the answer never arrived, and pressed it again recorded the payment twice, and the vendor read as paid twice (T270).
Each opening of the dialog to record a payment or a refund is now one entry, however often Record is pressed:

- `RecordPaymentDialog` makes a request key with `crypto.randomUUID()` as it opens in payment or refund mode and sends it as `requestKey` on every press of that opening (`recordPayment` and `recordRefund` in `payments.ts`); an edit sends none.
- `_record_entry` in `api/payments.py` reads it with `string_field` and takes it out of the body before `PaymentEntry`, which forbids any other field, reads the rest; absent or null, the entry is recorded as before, so a tab on an older bundle during a deploy still works, and anything else that is not a UUID is refused 400, "A payment's request key must be a UUID.".
  It is stored as `request_key`, in the one lowercase spelling of the UUID, and never reaches the account's entries or the history.
- When the market already holds an entry with the key (`entry_with_request_key`), or the insert is refused by the index because a press with it landed first, the stored entry decides (`same_entry`): the same vendor, kind and fields answer the account as it stands, 200, with no new entry and no history entry; anything else is refused 409 (`AlreadyRecorded`), "This payment was already recorded, as it was first sent. Close this and edit it if it should read differently." ("This refund …" for a refund), with the account as it stands under `account`.
  The dialog keeps that refusal shown and stays open until a field changes or Record is pressed again, and hands the account on (`refreshed`), which `VendorPaymentTab` shows, so the entry the first press recorded appears behind it.
- `ensure_payment_indexes` builds `payments_request_key_unique`, unique on `(market_id, request_key)`, partial to documents whose `request_key` is a string, through [`unique_indexes.py`](../../../back-end/unique_indexes.py), and `verify_payment_indexes` refuses to boot without it ([OPERATIONS.md](../../OPERATIONS.md#when-the-back-end-refuses-to-boot)); no entry before it had a key, so no older database holds a duplicate.
- **The dialog's write belongs to its opening** (T411, [dialogs](../conventions/dialogs.md#the-rules)): it writes through `useDialogSubmit`, opened on its `open` prop, so nothing closes it while it records, a second press sends nothing, and the confirm reads "Recording…" ("Saving…" for an edit).
  An answer that lands after the dialog was closed and opened again, which only its parent can do while it records, leaves the new opening alone: never `saved`, which would close it, but the account it carries, a success's or a 409's, handed on as `refreshed`, so the account behind the dialog is true.
- **Change the amount owed and the tab's confirmation belong to their opening the same way** (T411): `ChangeOwedDialog` writes through `useDialogSubmit` opened on its `open` prop, reading "Saving…" while it saves, and hands a late answer's account on as `refreshed`, which the tab shows behind the dialog without closing it.
  The tab's confirmation of "Use the calculated price" and of a removal writes through one opened on the confirmation it shows, so it is held while it writes, sends once for two presses, opens afresh with no word of a refusal it met before, and a late answer's account shows on the tab, never closing what is open; its refused-as-changed state (`confirmSpent`) stays the tab's.
- **The tab's account is the vendor's it is open on** (T421): `VendorPaymentTab` reads it as one keyed read ([`useServerRead`](../../../front-end/src/utils/useServerRead.ts), [reads keyed by market](../modules/market-store.md#reads-keyed-by-market)), keyed by the market and the vendor's address, so moving the drawer from Ana to Ben says "Loading…" at once, never Ana's totals, and Ana's read answering late lands nowhere.
  A move closes any dialog open on the last vendor, and `RecordPaymentDialog` and `ChangeOwedDialog` are keyed by the account, so one opened on Ana unmounts with her and nothing it answers after lands on Ben's tab.
  Each hands the tab its write as it is sent (`sending`), how a parent hears of a write that outlives its dialog: one that succeeds after the move tells Payments to read its totals again, taking nothing into Ben's account, and reads Ana's account again when the tab has come back to her meanwhile, since her read on coming back may have been served before the write; one that succeeds once the tab itself is gone (the drawer closed, or another of its tabs chosen) calls what the page provides (`PAYMENT_WRITTEN` in [`payments.ts`](../../../front-end/src/utils/payments.ts)), on which Payments reads its totals again; a refused or failed write tells nothing more than its dialog did.
  The tab's own confirmations, a removal and "Use the calculated price", call it too when they succeed once the tab is gone, and, like the dialogs, read the vendor's account again when they succeed after the tab moved away and came back to that vendor.
  Every write's answer, `saved` and `refreshed` alike, is taken through `adopt` into the account it was made on, so a confirmation sent on Ana that answers on Ben's tab changes nothing there.
- Two openings of the dialog make two keys and record two payments: two organizers recording the same e-transfer from two dialogs still record it twice, which an Admin cures by removing one.

**No applicant endpoint reads either**: what a vendor owes is for organizers only (Q20.2), which is why it is kept apart from the application, as the organizer's notes are.

## Reading and recording

Every route is in [`back-end/app.py`](../../../back-end/app.py) (`get_vendor_account`, `record_payment`, `record_refund`, `set_amount_owed`, `use_calculated_price`, `edit_payment`, `remove_payment`), and every write answers the vendor's account as it now reads.

- `GET /markets/:id/payments` (`market_payments`) answers [the Payments page](../../business/flows/payments.md): `currency`; `vendors`, each vendor with a line or any entry, by address, with `owedCents` and `paidCents` as their own account reads them, and `balanceState` and `compares` as it serves them (below), which the page's lists read; `offersPaymentStates` (below); `totals`, `byTier` and `byDate`, each `owedCents`, `paidCents`, `stillOwedCents` and `paidMoreCents`.
  Its accounts are `accounts` (below), the same `lines` and `account` the drawer's tab reads, so the page, the tab and the export never disagree on what a vendor owes, paid or is.
  `market_summary` in `payments.py` shares what each vendor paid across their lines by what each owes, evenly where they owe nothing, to the cent by largest remainder (`shares`), so a vendor's lines are all owing or all paid more, and each breakdown adds up to `totals`, which are each vendor's figures summed; a vendor with no line puts what they paid under a `tier` and `date` of null, last, unless it comes to nothing (a payment removed), which adds no row.
  It sums by the rule the states are read by (`compares`, below): what an account that compares with nothing paid counts toward `paidCents` but never toward `paidMoreCents`, in `totals` or any share of them (T153 review finding 12), so on a market with no prices `paidCents` less `owedCents` need not equal `paidMoreCents` less `stillOwedCents`.
  Tiers come in the market's order, a tier it no longer has after them; dates in order.
  It asks the table's Read row.
- `GET /markets/:id/payments/:email` (`vendor_account`) answers one vendor's account: `currency` (null on a market that sets no prices), `lines` (each `date`, `tableCode`, `tier`, `tableChoice`, `group`, `priceCents`, `owedCents`, `owedSetBy`, `owedSetAt`, `owedByFree`, `freed`, and `freedAt` and `freedBy` for a freed seat), `payments` (the last recorded first), `owedCents` and `paidCents`, and `balanceState` and `compares` (below); an unpriced line owes nothing toward the total.
  It asks the table's Read row: anyone with a role reads it.
- `POST /markets/:id/payments/:email` (`record_payment`), body `{cents, method, paidOn, note}` and the press's `requestKey`, records one payment, once per key ([above](#a-payment-is-recorded-once-per-press)), and answers the account as it now reads.
  It asks the row "Record a payment", an Editor's by default (Q15: "editors can"; [what each role may do](../../business/rules/what-each-role-may-do.md)), refuses an archived market, and a vendor the market has no application from, 404, as a seat is.
- `PUT /markets/:id/payments/:email/owed/:date`, body `{cents}` from 0 to $100,000, sets a table-day's amount owed, and `DELETE` on the same path uses the calculated price again; both ask the row "Change the amount owed", an Admin's by default (Q26: "this number can be changed by the admin"), refuse a day with no line, 404, and a day that kept changing as it was saved, 409 ([the one writer](#the-one-writer)).
- `POST /markets/:id/payments/:email/refunds` records a refund, `PUT /markets/:id/payment-entries/:payment_id` edits an entry and `DELETE` on it removes it; all three ask the row "Adjust the amount paid", an Admin's by default, and an entry of another market, or one removed, is not found, 404; an edit or a removal that meets another change of the entry is refused, 409 ([above](#the-amount-paid)).
- Each write is recorded in [the market's history](history.md), through the asking of its row its load returned ([the market's actions](../modules/market-actions.md)): a payment under `record-payment`; an amount owed set, a free's deduction included, or set back to the calculated price under `change-owed`, subject `{date, currency}`, the line's `owed_cents` before and after; an amount dropped with a day or a free's $0 taken back under `assign` ([the owed day's state](#the-owed-days-state)); a refund, an edit or a removal under `adjust-paid`, subject `{payment_id, payment_kind, currency}`, the entry's fields before and after; `payment_kind` (`payment` or `refund`, on `record-payment` too) words an edit that changed no amount.
  Each names the vendor, so it reads in their drawer's History tab as in Manage market's ([reading the market's history](../../business/flows/reading-the-markets-history.md)), worded by [`historyReaders/payments.ts`](../../../front-end/src/utils/historyReaders/payments.ts) ("… recorded a payment of $50.00 from Alice Example", "… set what Alice Example owes on May 8, 2099 to $0.00", "… recorded a refund of $15.00 to Alice Example"), opening to its fields in the Payment tab's words and money.

`accounts` in `back-end/api/payments.py` answers every vendor's account on the market at once, by address, each as `vendor_account` answers it, for every vendor with a seat, a kept line or an entry, from one read of each collection (`amounts_owed_by_vendor`, `payments_by_vendor`), a record with no address being nobody's; its caller has asked the table already.
The vendor export reads it for its money columns and its payment filter ([J15, export the vendors](../../business/flows/vendors.md#j15-export-the-vendors-to-a-csv)), and only when one is asked for; `market_money` reads it for the Payments page (`market_payments`, which asks the table first) and for the Stats tab's money headlines and its Money card (`count_money` in `back-end/market_stats.py`, [where the money stands](../../business/flows/stats.md#n5-see-where-the-money-stands)), so the two tell the same figures.
`balance_state` in `back-end/payments.py` reads an account: `owes` while the amount owed is above the amount paid, `over` below it, `paid` when they are equal and something is owed, and none for nothing owed and nothing paid (`BALANCE_STATES` holds the words, "Owes", "Paid in full", "Paid more than owed").
On a market with no prices (`currency` null) an account owing nothing is in none, whatever was paid, since a payment there is not "more than owed" (T153 review finding 8); one owing an amount set by hand reads as anywhere, since the reading follows the account, not the market (finding 10), and so does one owing nothing whose amount paid is below nothing (a refund beyond what was paid), which owes it back (finding 14); `compares` in the same file is that rule, which `market_summary` sums by too.
**The server alone reads the state** (T335): `account` serves `balanceState` and `compares` on every account it answers, `vendor_account`, every write's answer and `accounts`, and the front end words and tones what it is served and keeps no copy of the rule.
`offers_payment_states(currency, accounts)` says whether anyone on the market may be in a state: always where the market sets prices, and where it sets none only where some account `compares`.
`market_money` serves it to the Payments page as `offersPaymentStates`, which `owingCounted` in `front-end/src/utils/paymentsPage.ts` reads, and `_offers_payment_states` in `back-end/api/vendor_export.py` calls it, reading every account only where the market sets no prices; where it says no, the export's preview offers no payment state and `_build` drops a `payment` filter sent anyway, as the Payments page ignores one in its address.
It is the one reading of who owes: the export's payment filter reads each account's served `balanceState`, and the Payments page's lists each vendor's (`vendorShownIn`, whose filters' ids are the states'), and `paidOwingNothing` reads each vendor's served `compares`.
Both sides run one table of cases, [`back-end/tests/fixtures/balance_states.json`](../../../back-end/tests/fixtures/balance_states.json): each `{name, currency, owedCents, paidCents, compares, balanceState, text, chip}`, the back end checking `compares` and `balance_state` over every case and the front end `balanceText` and `balanceChip` over each case's served fields, so a case added there is checked on both.
An amount in the file is `money_cell` in `back-end/api/vendor_export.py`: `money_text` in `back-end/pricing.py`, the tab's own writing ("$35.00", "$15.01", "-$15.00"), except that a minus leading a currency's letters ("-A$15.00", a cell reference to a spreadsheet) is the minus sign U+2212.
Every amount, on screen and in the file, reads to the cent, pinned on both sides by one table of cases ([an amount reads to the cent](../../business/rules/an-amount-reads-to-the-cent.md)).

The front end words the served state in [`front-end/src/utils/payments.ts`](../../../front-end/src/utils/payments.ts) (`balanceText`: `owes` "Owes $27.00", `paid` "Paid in full", `over` "Paid $15.00 more than owed", and none "Paid $35.00" where something was paid, else "Nothing owed"), tones its chip with `balanceChip` (`owes` attention, `paid` positive, `over` informational, none neutral) for the tab and the Payments page alike, and shows it in [`VendorPaymentTab.vue`](../../../front-end/src/components/VendorPaymentTab.vue), whose chip carries the served state as `data-state`, `none` for none.
A payment, a refund and an edit go through [`RecordPaymentDialog.vue`](../../../front-end/src/components/RecordPaymentDialog.vue), an amount owed through [`ChangeOwedDialog.vue`](../../../front-end/src/components/ChangeOwedDialog.vue), which says the change before "Set amount owed", and "Use the calculated price" and a removal through a confirmation; each line's and each entry's actions sit behind a "..." menu ([`RowMenu.vue`](../../../front-end/src/components/RowMenu.vue)), offered on its row's answer.
The tab teleports the three dialogs to the body, so each opens centred on the window over the drawer, which stays behind it, inert, and Escape closes the dialog alone ([dialogs](../conventions/dialogs.md#the-rules)).
Both dialogs' amount fields are amount fields as [an amount reads to the cent](../../business/rules/an-amount-reads-to-the-cent.md#an-amount-field) says, through `useAmountField` in [`front-end/src/utils/useAmountField.ts`](../../../front-end/src/utils/useAmountField.ts): left, "$35.00" in the account's currency (`currencyOf`, Canadian dollars where the market sets no prices), focused, "35.00"; an edit opens on the entry's amount and an amount owed on the line's, "$0.00" where none is set.

## How it is tested

- `back-end/tests/test_an_owed_day_has_one_state.py`, the reproduction, through the routes: an Admin's $0 on Ana's Sunday, then a run that seats her on Saturday only, drops the record with one `owed_dropped` entry naming $0 and the Admin, "Use the calculated price" for Sunday is then 404 with nothing stored, and Sunday seated again at a Silver table owes the Silver price set by nobody.
  Beside it, an Admin's amount meeting a run that drops the day: refused 404 with nothing kept when the run lands before the owner's write, and answered with no Sunday line, its `owed_set` entry before the run's `owed_dropped`, when the run lands after it; and seating a day that holds a hidden amount recording its drop.
  Beside it, a day the run keeps keeps its amount, and a dropped day nobody set records nothing.
- `back-end/tests/test_the_owed_day_table.py`: every cell of [the table](#the-owed-days-state), each starting state reached and each event sent through the product's routes, asserting the answer, Sunday's line, the stored record, its mirror equal to `legacy_fields` of its state, its revision counted up, and the history entries; a guard keeps the table whole, and an Admin's change on a day with no line is refused with nothing written.
- `back-end/tests/test_the_owed_day_owner.py`: `next_owed_state` as a pure function over every cell, the refusals on a day not held and an Admin's change on a held day's freed record; `on_day` for each state held and not; `state_of` for no record, an agreeing state, every legacy shape, a disagreeing or unreadable one, never raising; `legacy_fields` and `derive_from_legacy` inverses over every state; `lines` as a projection; a rolled-back release's three writes over a record of this release, read as that release wrote them, and stored again by the next write; and the owner: its insert, revision, delete and nothing written, a legacy record, a refused cell, a revision missed and a first record created since each read again, `OwedDayChanged` after three, and `undo()` landing only on its own record and revision.
- `back-end/tests/test_migrate_owed_day_state.py`: every legacy shape stored as its state and read as it was; stopped frees on a held day read as the seat; a cleared record taken away; each shape of a hidden Admin's amount removed with its entry, and the day then seated owing the new seat's price; a disagreeing state stored again from the mirror; an agreeing record left; `--dry-run` writing nothing; a second run changing nothing; a market being deleted left; an unreadable record left and listed; no address printed; a record changed meanwhile read again, and one changed on every try skipped.
- `back-end/tests/test_a_vendors_payments.py`: $70 for two Gold full days, the half share, a seat moved from Gold to Silver, an amount set by hand that stays, a freed day's line kept with neither amount changed, every refusal of a payment, who may record, the history entry, and deletion with the market; `plant_amount_owed`, which the money tests share, plants an Admin's amount in the release before's shape, so they cover the read of a record with no state.
- `back-end/tests/test_the_payments_page.py`: the page's vendors as their tabs read, its totals against the sum of the tabs, the sharing by tier and by date to the cent, a vendor owing nothing, a vendor with no table whose payment was removed adding no row, a market with no prices (nobody owing in a payment state, an amount set by hand reading as anywhere, the figures summed by the account rule, a refund beyond what was paid owed back) or nobody, each vendor's `balanceState` and `compares` as their tab serves them, `offersPaymentStates` priced, unpriced, and unpriced with an amount set by hand, and who may read it.
- `back-end/tests/test_changing_owed_and_paid.py`: an amount set to $0 and taken back, each recorded, and every change in the vendor's own history read; a free ticked and unticked; a refund that squares the account; an edit and a removal with the entry's own history; an Editor refused every one of them, and the deduction before anything is freed; an amount set and a free racing for a new day's record, each losing once, leaving one record that holds both, and an index that keeps refusing changing nothing and answering 409; seating again reading only the records that may move.
- `back-end/tests/test_a_held_seat_wins_over_a_free.py`: a re-seat after a deducted free owing the new seat even when it stopped before the freed line was cleared, and an Admin's amount still holding on a held seat, and outliving a deducted free that stopped before its seat went and the next write of the day; a deducted free owing $0 whatever stops it after the seat, its "owed set" entry from what the held seat owed, and a free again on a day an older free left owing deducting it once, leaving an Admin's amount and a day with no line alone; a free whose seat write fails leaving nothing a later run could surface, and an Admin's amount as it was; a seat write that landed before its error keeping the day's line, and its $0, and one whose seat cannot be read again keeping the line; a run, a swap and a move clearing a stale freed record of a day held before with no entry, and a run or a placement seating a freed day again recording the taking back; an Admin's amount put back by a re-seat after a deducted free that landed, with its entry from $0 to that amount, and by one that stopped before it forgot the free and the next write of the day, and kept by a move with no free; an Admin's amount changed, or first set, between a free's read and its write kept as the one its $0 replaced, and one that keeps changing refusing the free with nothing freed; a day a run drops forgetting the amount it held; and the calculated price on a held day carrying a stopped free's record recording nothing.
- `back-end/tests/test_a_payment_is_recorded_once_per_press.py`: a payment or a refund pressed again recorded once, with one history entry; a repeat differing in each field, or in kind, refused 409 in its own words with the account as it stands; two presses at once, the second refused by the index, answering the same way; two keys making two entries, no key or a null one recording as before, and every key that is not a UUID refused; the key kept, and never answered or recorded; the boot building the partial index, or refusing naming no address, counting no entry recorded without a key and naming two that share one.
- `back-end/tests/test_one_record_for_a_vendors_day.py`: the boot builds the owed index and refuses on duplicates, naming them without an address, and the check before a release reads `amounts_owed` beside `attendance`.
- `back-end/tests/test_the_balance_states.py`: `compares` and `balance_state` over every case of `balance_states.json`, `account` serving both over every case, a guard that the table holds every state priced and not, the Payment tab and a write's answer carrying them, and `offers_payment_states`.
- `back-end/tests/test_a_payment_entry_holds_what_it_read.py`: an edit and a removal each meeting an edit and a removal landed between the request's read and its write (`harness.interleave`), for a payment and a refund, answering 409 with its sentence and the account as it stands and recording nothing; the account behind a refused edit showing the other Admin's; each landed write keeping one line of what it read; the history's `before` being the held read; and the filter itself.
- `back-end/tests/test_the_exports_money_columns.py`: `accounts` answers each vendor as `vendor_account` does, each state's export lists the vendors the Payments page serves in it, the export offers states exactly where the page's `offersPaymentStates` does, `balance_state` sorts five vendors into owing, paid in full, paid more and none, a market with no prices offers no payment state and ignores a payment filter where nobody owes, and offers and applies them where an amount was set by hand or a refund went beyond what was paid, `money_text` writes every offered currency as the screen does, and `money_cell` writes no amount a spreadsheet reads as a formula.
- `front-end/src/__tests__/balanceStates.test.ts`: `balanceText` and `balanceChip` over each case's served fields in `balance_states.json`, and the same guard; `paymentsPage.test.ts`: `owingCounted` and `paidOwingNothing` on served values, each taking the server's word over the amounts.
- `front-end/src/__tests__/payments.test.ts`, `vendorPaymentTab.test.ts` (the chip's `data-state` and tone for each served state, the removal confirmation kept open on a 409 with the account it carries shown behind it, held while it removes with one request for two presses, opened afresh after a refusal with no word of it, and Change owed's late account shown behind it, the dialog still open; the totals and both groups as cards, each table-day and payment a box even alone, and a date moving whole or breaking only after its weekday, read from the component's styles), `aVendorsAccountIsTheirs.test.ts` (Ana's late account dropped on Ben's tab, "Loading…" on the move, a payment, an amount owed and a removal sent on Ana answering on Ben's tab changing nothing there and telling Payments once, a write answering once the tab is gone, a removal and the calculated price among them, calling the page's `PAYMENT_WRITTEN`, one refused after the move telling nothing, Ana read again on coming back, and read once more when a payment, a removal or the calculated price sent before a move away and back answers after that read, or, for a removal and the calculated price, while it is still out) and `placementDialog.test.ts` (the question, unticked); `aPaymentIsRecordedOncePerPress.test.ts`: the same key on a second press after a lost answer, for a payment and a refund, a new key on a new opening, none on an edit, and a 409's account shown behind the dialog, its refusal kept, an edit refused as changed or removed included; `aDialogsWriteBelongsToItsOpening.test.ts`: the dialog closed and opened again while it records opening enabled with no old refusal and what was typed kept, the earlier opening's success or 409 handed on as `refreshed` and never as `saved`, and on the tab its closes refused while it records, one request for two presses, and its refusal gone on a field's change; `paymentAmountFields.test.ts`: each dialog's amount field focused, typed, left, refocused, refused and left, cleared, and an edit's or an amount owed's fill, and Change owed held while it saves with one request for two presses, and closed and opened again while it saves, its earlier opening's success handed on as `refreshed` and never `saved`, and its refusal said nowhere.
- `front-end/e2e/a-dialog-holds-while-it-writes.spec.ts`: Record payment's request held, Escape and the scrim refused with Cancel and the close disabled and the confirm reading "Recording…", then the dialog closing on the answer with one request sent and the payment on the tab.
- `front-end/e2e/the-payment-tab.spec.ts`: two Gold full days owe $70, $35 reads "Owes $35.00", $35 more "Paid in full", a freed day keeps its line; "35" typed reads "$35.00" once left and "35.00" focused again, "3x" keeps its error; Record payment, Change owed and a removal's confirmation each centred across the window at 390 and 1440, Record payment's and Change owed's tops held 48px down and the confirmation centred down, the drawer inert behind each, and Escape closing it alone with focus back on what opened it; the totals, "Table-days" and "Payments" each a card and each table-day and the lone payment a box, measured at 1440, 390, 375 and 320, with each box's words in their column, each date's day kept whole, and its amount and "..." on one midline at its end; a Viewer reads the tab with no "Record payment".
  `changing-owed-and-paid.spec.ts`: an Admin sets a $35 line to $0 and back, the field opening on "35.00" and reading "$0.00" once left; frees a paid $15 seat ticked, reads "Paid $15.00 more than owed", records a $15 refund and reads "Paid in full", and finds each change in the drawer's History with who and when; unticked, the line stays $15 owed.
  An Editor freeing the owed seat is asked nothing, its page never reads the account (`mayTake(ChangeOwed)` in `ResultView.vue`), and the line stays $15 owed.
  `exporting-a-payment-reminder.spec.ts` checks the export's "Owes" against the Payments page's "Owes" list too.
  `one-record-for-a-vendors-day.spec.ts`, on the stack's real MongoDB: a second owed record for a vendor's day is refused, and an Admin's amount set and an Editor's free of the same day, sent at once, leave one record holding both, its `state` a freed line owing the Admin's amount beside the mirror, which the tab reads as the freed line owing the amount set; a payment whose first answer is dropped after the server recorded it, pressed again from the same dialog, lists one entry and counts it once in what the vendor paid, and the database refuses a second entry with its key; a second press that differs is refused, with the entry shown behind the dialog.
  [The real-MongoDB suite](../testing/real-mongo-suite.md) builds both unique indexes through the boot, and over two planted owed records of one vendor's day, or two entries of one request key, the boot refuses to start; it races 20 amounts set by hand against 20 frees of one day with no record through the owner, which leave one record whose landed writes are one revision sequence, every write landing or raising `OwedDayChanged` ([one record per vendor's day](../testing/real-mongo-suite.md#one-record-per-vendors-day)); it releases two edits of one payment entry at once, 20 times, one landing and the other refused ([a payment entry holds what it read](../testing/real-mongo-suite.md#a-payment-entry-holds-what-it-read)); and it runs the migration on the server as an operator does ([`test_the_owed_day_state_migration_on_the_server.py`](../../../back-end/tests/real_mongo/test_the_owed_day_state_migration_on_the_server.py)).
  `the-payments-page.spec.ts`: the Payments page's totals against the sum of three vendors' tabs, each filter and the sort kept by a reload, and a payment recorded in the drawer read on the page again.
  `market-records-go-with-it.spec.ts` finds no payment or amount owed left after a market is deleted.
