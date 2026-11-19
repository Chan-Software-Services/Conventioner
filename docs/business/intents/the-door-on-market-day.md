---
layer: business
kind: intent
verified: 2026-11-19
sources:
  - E29
  - E26/F06
  - T496
---

# The door on market day

On each day of the market, the organizer at the door sees every vendor expected that day, by name and table, who has arrived and who has not, and checks a vendor in themselves, and out again when they leave; a vendor reads their own table on their vendor page, signed in with the address they applied with.
The door is the organizers' unless they choose otherwise: a vendor checks themselves in and out, with the door code, only at a market that turned that on, and it is off until someone does.
A check-out records that a vendor left and changes nothing else: they still came, in every count ([ADR 0040](../../adr/0040-vendors-check-themselves-in-and-out-only-where-the-market-turned-it-on.md)).
The door reads the seats as they stand, so a vendor moved, freed or added that morning is sent where they were put.
Once the market is archived it is the record of what happened: nothing in it changes, a market that ran keeps its vendor page as a record marked ended, and no market in the middle of its life is deleted with its organization.

## Why

With a room full of vendors, a list of who has checked in cannot answer the question the door actually asks, which is who is missing.
The door is a laptop and sometimes a phone, run by volunteers the organizer gives a role, and every check-in and check-out made for a vendor records who made it.
A vendor leaving may have things to return, so the organizer wants to know who has left, and not every organizer wants vendors recording their own coming and going.
A market's seats change on the day itself, so the door must follow the seats, not a copy of the run.
And after the market, its plan, verdicts, seats and check-ins are the only account of what happened, so they must not shift under anyone reading them, and its public check-in address must not vanish while it is still the record.

## Rules

- [Adding a vendor who never applied](../rules/adding-a-vendor-who-never-applied.md): a vendor arriving unannounced is added, then seated by hand.
- [A vendor is called by their chosen name](../rules/a-vendor-is-called-by-their-chosen-name.md): the door names each vendor as they chose, with their address.
- [Vendor notes](../rules/vendor-notes.md): what a vendor asked for beyond a table, shown at the door.
- [An archived market is read-only](../rules/an-archived-market-is-read-only.md): nobody changes a finished market's record.
- [An archived market that ran stays a record](../rules/an-archived-market-that-ran-stays-a-record.md): its vendor page stays up, marked ended, taking no check-in.
- [When an organization may be deleted](../rules/when-an-organization-may-be-deleted.md): refused while it holds a market mid-lifecycle, and recorded first.

## Flows

- [Publishing, and the door on market day](../flows/market-day-door.md): the door code, the vendor's check-in and check-out on their vendor page where the market lets them, and the organizer's Attendance.
- [The market's map](../flows/the-markets-map.md): the public map a visitor finds a vendor on, and Attendance's map the organizer directs a vendor by.
- [The vendor drawer](../flows/vendor-drawer.md): one vendor's notes and seats, opened from Attendance.
- [Ending and managing a market](../flows/ending-and-managing-a-market.md): archiving, and what an archived market keeps.
