---
layer: implementation
kind: adr
describes:
  - back-end/api/door.py#set_self_check_in
  - back-end/api/attendance.py#record_check_out
  - back-end/api/attendance.py#undo_check_out
  - back-end/datatypes.py#vendor_self_check_in_from_market_document
verified: 2026-11-24
sources:
  - T496
status: accepted
---

# Vendors check themselves in and out only where the market turned it on

The nodes it constrains: [attendance and the door](../implementation/modules/attendance-and-door.md), [the market document](../implementation/data/market-document.md) and [the market's history](../implementation/data/history.md); the flow it changes: [the door on market day](../business/flows/market-day-door.md), which serves [the door on market day](../business/intents/the-door-on-market-day.md).
It amends [ADR 0022](0022-the-vendor-page-is-signed-in.md), "Check-in proves presence with a door code".

## Context

On a market day an organizer and a vendor could each record that the vendor came, and nothing recorded that they left.
An organizer asked for a check-out, since a vendor leaving may have things to return.
The vendor's own check-in was also open at every market once a door code existed: a code once made could not be unmade, and the vendor's undo needed none, so an organizer who does not use the vendor's door could not close it.

## Decision

**A check-out is three fields on the check-in's record, not a record of its own.**
`checked_out_at`, `checked_out_by` and `checked_out_via` stand beside the check-in's fields on the day's one `attendance` document, set by `record_check_out` and unset by `undo_check_out` in [`back-end/api/attendance.py`](../../back-end/api/attendance.py).
A document with no `checked_out_at` is a vendor not checked out, which is every document stored before, so nothing is migrated.

- One vendor's day stays one record, under the unique index it already has.
- A check-out is one update filtered to a day not yet checked out, so two at once leave one time and one history entry, and the second answers the stored check-out's time, and at the organizer's door who made it and by which way too.
- The undo of a check-in refuses a checked-out day, 409 "Undo the check-out first.", so a check-out is never dropped without its own entry.
- Nothing else reads it: a checked-out vendor still came, so the roster's states and counts, the Stats tab, the day map, the public map, the owed days and the placements are as they were.

**Both doors check out as they check in.**
The organizer's is the Check vendors in row, at a route of its own, on any date with a record.
The vendor's takes the door code, as their check-in does, since the code proves they are at the door, where what they return is handed back; its undo takes none.

**The vendor's door is behind one switch on the market, off until someone turns it on.**
`vendorSelfCheckIn` on the market document says whether its vendors check themselves in and out on their vendor page, and undo either; absent is off (`vendor_self_check_in_from_market_document` in [`back-end/datatypes.py`](../../back-end/datatypes.py)), so every market, the ones already running included, is the organizers' door until someone who may check vendors in turns it on (`set_self_check_in` in [`back-end/api/door.py`](../../back-end/api/door.py)), in Market Days, on the door code's screen.
While it is off, the vendor's four routes answer 403 with one sentence and write nothing, and the organizer's four writes never read it.
It is apart from the door code: the code stays stored while the switch is off and works again, with every poster of it, once it is on, and making a code does not turn it on.

## Consequences

- A market that was taking vendors' own check-ins before this change stops taking them until its organizer turns the switch on (Daniel's "option b"); its stored check-ins read as they did.
- The vendor page says so in place of its controls, "An organizer checks you in at the door.", and a door code scanned while the switch is off is dropped with the server's sentence, never held through a sign-in.
- A door code scanned by a vendor who is checked in fills the check-out's field and sends nothing: a second scan by accident must never end their day.
- Checking in again after a check-out is a new time on the same record, not a second arrival; undoing the check-out is how a vendor is here again.
- Every test of the vendor's own door turns the switch on first.

## Considered and rejected

- **A check-out as a second document**: a vendor's day would be two records to keep in step, and the unique index that keeps the day one record would need a second key.
- **One switch for check-in and another for check-out**: Daniel wanted one; an organizer who lets vendors in at the door lets them out there.
- **On for the markets already running, off for new ones**: it needs a migration and a stored value on every market, and the organizer of the running market does not use the vendor's door.
- **The door code as the switch** (no code, no vendor's door): a code cannot be unmade, the vendor's undo takes none, and turning the door off would end every printed poster for good.
- **A check-out with no door code**: a vendor could check out from anywhere, which says nothing of what they returned.
