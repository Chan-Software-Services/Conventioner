---
layer: business
kind: flow
describes:
  - front-end/src/views/AttendanceStatusView.vue
  - front-end/src/components/vendorPage/VendorCheckIn.vue
verified: 2026-11-19
sources:
  - brain-dump/2026-10-19#15
  - E10/F01/S02
  - E15/F02/S04
  - E29
  - E30/F01/S02
  - E31/F03/S02
  - E32/F01/S01
  - E35/F01/S02
  - E36/F04/S02
  - bug/1
  - E08/F03
  - T15
  - E38/F09/S01
  - E38/F15/S04
  - T202
  - T318
  - T277
  - T316
  - T422
  - T421
  - T466
  - T469
  - T496
  - T501
---

# Publishing, and the door on market day

**Who:** the market's Admin or owner publishes; an Editor shows the door code and checks vendors in at the door, and out again; a vendor, with no account, signs in on their vendor page with a code mailed to them and, where the market lets them, checks themselves in and out with the door code.
**Where they start:** the phase rail in Assignment; on the day, the organizer on the Attendance tab and the vendor at the door code's QR code, or at their vendor page.
**Serves:** [Results go out once, and settle the allocation](../intents/results-go-out-once-and-settle-the-allocation.md) and [The door on market day](../intents/the-door-on-market-day.md).

Publishing opens the market's days; from then on the market is in Market Days, and the door is two pages over one roster of who is placed where: the vendor's own check-in on their vendor page ([`VendorCheckIn.vue`](../../../front-end/src/components/vendorPage/VendorCheckIn.vue)) and the organizer's Attendance ([`AttendanceStatusView.vue`](../../../front-end/src/views/AttendanceStatusView.vue)).
A vendor's check-in proves presence: it takes their sign-in and the door code the organizer shows at the entrance ([ADR 0022](../../adr/0022-the-vendor-page-is-signed-in.md)).
The vendor's own door is off at every market until someone who may check vendors in turns it on ([K11](#k11-let-vendors-check-themselves-in-and-out), [ADR 0040](../../adr/0040-vendors-check-themselves-in-and-out-only-where-the-market-turned-it-on.md)); until then only organizers check vendors in and out, and K2 to K4 are for a market that turned it on.
Both read the stored assignment, so a vendor placed, swapped or freed by hand is sent where they were put; how the door works is [attendance and the door](../../implementation/modules/attendance-and-door.md).

## K1. Publish the market

**Status:** Works (re-walked live on 2026-10-03; its refusals, the landing and the tab read from the code as of E31/F03/S02, E32/F01/S01 and E36/F04/S02).
**Task:** "Your assignment is final. Make it live so vendors can find their tables."

1. Rail: "Publish market", the main button in Assignment.
2. "Publish market?": "Publishing opens the market's days: you check vendors in and out on Attendance. Vendors check themselves in and out on their vendor page only once you turn on "Vendors check themselves in and out", on the door code's screen. The tables they see are the ones you have now." and "A published market cannot be returned to an earlier phase."; focus starts on Cancel.
3. Expect Market Days, landing on Attendance, and "Market page" and "Vendor page", each with its address and "Copy", in the rail; the rail says "Print each day's roster, then check vendors in at the door."

Disabled before the click, with the rail naming the first blocker:

- no assignment is stored: "No tables have been allocated for this market, so its vendor page could not tell anyone where to stand. Allocate tables first.", with "Allocate tables";
- only tables assigned by hand are stored, with no table allocation run: "Only tables assigned by hand are stored, so every other approved vendor would read that they did not get one. Allocate tables first: allocating keeps the tables you assigned.", with "Allocate tables" (T316);
- every seat freed after results are published, when a run is refused: "Nobody has a table, so this market's vendor page could not tell anyone where to stand. Results are published, so tables are not allocated again: assign each one by hand.", with "Assign tables", which leads to Assignments (T316); and the same in a market left in Offers with nobody seated, where a run is refused too: "Nobody has a table, so this market's vendor page could not tell anyone where to stand. The table allocation for this market is settled, so tables are not allocated again: assign each one by hand.";
- a hand placement names a seat the plan no longer has ([J10](placing-by-hand.md#j10-a-pin-the-plan-no-longer-holds));
- the results are not published, on either path: "Vendors have not been told whether they have a table. Publish the results before the market goes live.", with "Publish results" ([I7](assignment-and-result.md#i7-publish-results)).

The Attendance tab is on the bar in every phase; before publishing it says "Opens when the market is published."
Covered by:

- `phase-rail.spec.ts`
- `phase-state-machine.spec.ts`
- `results-wait-for-the-allocation.spec.ts`
- `tier2.spec.ts`

## K2. A vendor scans the door code and is checked in

**Status:** Works (read from the code as of T202, `checkin.spec.ts`).
**Task (vendor):** "You are at the market's entrance. Check in."

1. Scan the door code's QR code with the phone's own camera; it opens the market's vendor page, `/<market-slug>/vendor?door=<code>`, and the code goes from the address at once.
   A poster printed before the vendor page moved holds `/<market-slug>?door=<code>`, which goes on to the same address ([ADR 0039](../../adr/0039-a-markets-address-is-its-public-page.md)).
2. Signed out, the page says "Sign in, and you'll be checked in for today." over the sign-in: an email address, then the code mailed to it ([applying online](applying-online.md)).
3. Expect, once signed in, today's seat on top, "Today", the date and the table in words with its size and location, and "Checked in at <time>" with "Undo"; their other days are listed below.

A vendor signed in already is checked in at once.
At a market that has not let vendors check themselves in, the code is dropped and the page says "Vendors are checked in and out by an organizer at this market. Ask at the door.", signed in or out, with no "Sign in, and you'll be checked in for today."; today's seat then shows no "Door code" field and no button, and "An organizer checks you in at the door." ([K11](#k11-let-vendors-check-themselves-in-and-out)).
A vendor already checked in who scans again is not checked out: the code is put in the "Check out" form's field and nothing is sent ([K10](#k10-check-a-vendor-out)).
With no seat today the page says "You have no table today, so you are not checked in."; before the market's days "Check-in opens when the market's days begin."; once it has ended "This market has ended, so check-in is closed."; none checks anything in.
A scanned code is used once: the page reloaded checks nobody in again.
On a device vendors share at the door, a scanned code checks in only the vendor it is held for: the first address sent a sign-in code, or the vendor whose sign-in ran out as it checked them in; anyone else who signs in next is not checked in, and types the code or scans it again.
Before any address was sent a code, the first sign-in, a remembered device's included, is taken for the scanner's own and checked in.
The seats shown are the stored assignment, so a vendor placed, swapped or freed by hand is sent where they were put (bug 1).
It works alike on a Google Form market, whose vendor page opens once its results are published ([the Google Form path](the-google-form-path.md)).
Covered by:

- `a-vendor-checks-out.spec.ts`: the scan at a market with the switch off, and a second scan once checked in
- `checkin.spec.ts`

## K3. Type the door code

**Status:** Works (read from the code as of T202, `checkin.spec.ts`).
**Task (vendor):** "Your camera will not read the QR code. Check in."

1. On the vendor page, signed in, today's seat offers "Door code" ("Type the code under the QR code at the door.") and "Check in".
2. Type the code as the poster prints it, "K7M 4QP"; case, spaces and dashes do not matter.
3. Expect "Checked in at <time>" and "Undo".

A wrong code says "That isn't this market's door code. Check it, or ask at the door.", and so does a code the organizer has replaced (K5's "New code"); a scanned old poster says the same.
Only today's seat offers a check-in; nothing invites a vendor to check in for another day, since a check-in is how the organizer knows a vendor is there on the day.
Covered by:

- `checkin.spec.ts`

## K4. Undo a check-in

**Status:** Works (read from the code as of T202).
"Undo" beside "Checked in at <time>" takes it back, with no door code, and offers "Check in" again, on the day itself only, so a vendor never erases a past day's attendance; the organizer can undo one at the door too (K5).
Once checked out, the check-in has no "Undo" until the check-out is undone ([K10](#k10-check-a-vendor-out)).
Covered by:

- `checkin.spec.ts`
- `the-door-on-market-day.spec.ts`

## K5. Watch attendance

**Status:** Works (re-walked live on 2026-10-03; the door rebuilt since, read from the code as of E29 and E35/F01/S02: `the-door-on-market-day.spec.ts`, `the-door-keeps-its-own-day.spec.ts`).

1. Attendance opens on today when it is a market date, else the next one, else the last; the day is a select at the start of the toolbar, each option the day alone ("Nov 17, 2026"), and choosing one keeps the view.
   The toolbar is one row: the day (and, on the map with two locations or more laid out, the location) at its start, then at its end "List" and "Map" as one joined choice, "Print roster" and "Door code", and "Refresh" last, a rule between each group; the Tab key walks it in that order (T466).
2. Under it, a second row holds "N of M checked in", and on the list "All M", "Not yet N" (or "Did not come N" once the day is over or the market archived) and "Checked in N" to show one or the other, and the search.
   At a desk, 1,024px wide and more, the two rows are pinned under the market's frame from the start, so they never move while the list or the map scrolls under them; on a phone they scroll away with the page, each control a 44px target.
3. "Find a vendor" ("Name, email or table") narrows the list, by the name a vendor goes by or the full name on their identification, their address or their table.
   It finds a vendor by a part of their business name too, in any case (T502).
4. Each vendor placed that day, by table: their name, a link at rest (link ink, underlined, a 44px target on a phone), which opens the [vendor drawer](vendor-drawer.md) and never checks them in; how and when they checked in ("Scanned in at 9:41 AM" for their own, with the door code, "9:41 AM by you" or by the organizer's address), or "Not yet"; and their notes under the row when they have some.
   A vendor who gave a business name on their application has it under their name and over their address, smaller and muted, on one line cut with "…" where the row has no more room, its whole text shown on hover; it is never the link and never the name they are called by, and a vendor who gave none has no such line (T502).
   A vendor checked in and then moved or swapped reads where they checked in, "9:41 AM by you, at table North Wing 2", in an attention chip, so they are sent to their new table.
   Under the day's seats, "Checked in, with no table on this date (<n>)" lists each vendor checked in and then freed, their table "No table", so a free never hides an arrival; they count toward no day's tally.
   A vendor checked out keeps that status and gains a second chip after it, "Out 4:05 PM by you", or by the organizer's address, or "Scanned out at 4:05 PM" for their own ([K10](#k10-check-a-vendor-out)).
5. While the market is in Market Days, each row ends in at most one button, for someone who may check vendors in: "Check in" checks a vendor in at the door, and a checked-in row offers "Check out" in its place ([K10](#k10-check-a-vendor-out)).
   Each undo is a quiet "Undo?" just left of the chip it undoes: the check-in's by the status chip, the check-out's by the departure chip.
   "Check in" is offered on today and past days, so a tap missed in the rush is put right after, and never on a day to come, which the server refuses too: "That day has not begun yet, so nobody can be checked in for it."
   A Viewer is offered neither: they read the frame's "You can view this market but not change it. …", the rail's "Follow who has checked in at the door.", and each row ending at its status (E38/F15/S04).
6. In Market Days, someone who may check vendors in opens "Door code", beside "Print roster" in the toolbar: the market's name, its QR code, the code as "K7M 4QP" and "Scan with your phone's camera to check in or out", full screen, for the tablet or laptop that stands at the entrance.
   With no code yet it offers "Make a door code".
   Until "Vendors check themselves in and out" is turned on there, the screen shows no code and offers neither ([K11](#k11-let-vendors-check-themselves-in-and-out)).
   "Print" prints the same poster on one page, and "New code" asks "Make a new door code? The current code and every printed poster of it stop working.", on Cancel, before it makes another; the code stays the same until then.
   A Viewer is offered no Door code, and the server refuses them the code.
7. The roster reads itself again every 15 seconds while the page is in view, and at once when the tab comes back into view or the browser comes back online, so a vendor who scanned in, or another organizer's check-in, shows with no tap or reload.
   "Updated just now" or "Updated N minutes ago" stands over the list's right edge, or under the map's bottom right, and "Refresh" ends the toolbar; a read that fails keeps the rows and says "Could not update. The roster is as it was last read." in red under the toolbar's end.
   Taps on several rows' Check in go through at once, each row showing its check-in as soon as the server answers.
   Moved to another market, the page reads "Loading…" until that market's roster arrives, never the last market's, and a check-in tapped on the last market posts there and says nothing on this one, even when it was refused.
8. "Print roster", in the toolbar for anyone who reads Attendance, prints the chosen date's roster on paper, the door's fallback when the venue's network or the app fails: the market's name, the date in words, "<N> vendors", "Printed <date> at <time>", then every vendor of the date by table, their name with their address under it, and when they came or an empty box to tick, whatever "Show" and "Find a vendor" leave on screen; vendors checked in with no table that day print under their own heading.
   A vendor's business name prints under their name, whole (T502).
   The phase guide's "Print each day's roster, then check vendors in at the door." asks for it; the page has no note of its own (T466).
9. "List" and "Map", first of the toolbar's end, show the day as its rows or as a map of the venue's layouts (T422); the map is kept across a change of day and a reload.
   With two locations or more laid out, the map's location is a select beside the day, offering exactly the locations the map can draw, and kept in the address, so a reload or a shared link opens the same hall; with one, there is no select.
   Each table is drawn by its vendor: filled once they are here, outlined while they are expected, and a grey dashed outline with nobody at it; the legend says "Here" and "Expected" (or "Did not come"), and "No vendor" only on a day the open location draws a table or half nobody sits at (T466).
   The no-table zones, the stage or the entrance, stay drawn and named on the map, with no legend item.
   A location's tables and its floorplan appear together, never one location's tables over another's floorplan: the other locations' floorplans load in the background once the open one has, so a later switch is instant, and a reload downloads none of them again (T501).
   If the floorplan takes more than two seconds, the tables are drawn on the plain floor with "Loading the floorplan..." under the map until it comes; one that cannot be loaded leaves them there with "The floorplan could not be loaded. The tables are drawn without it.", and is tried again the next time its location opens.
   With "Show the floorplan" unticked the tables are drawn at once and neither line shows.
   Under the legend, where the location has a floorplan, "Show the floorplan", "Greyscale" and "Faded" change how it is drawn, the same choices as the Layout page's, so one made on either page holds on the other; every organizer and viewer who sees the map has them.
   A shared table is two halves, each its own vendor's.
   A press on a vendor's table opens their drawer, as their name on the list does, and Back closes it on the map; a press on a table with nobody says "Table Aisle A 4: no vendor on Nov 17, 2026." under the map.
   On the map, "Find a vendor" is a search with a dropdown of the day's vendors, found by the name they go by, the full name on their identification, address or table, each row saying where they sit; picking one opens their drawer and outlines their table, switching the map to their location when it is the other one, and closing the drawer clears the outline; typing alone outlines nothing (T466).
   It finds a vendor by their business name too, and such a vendor's row says it before where they sit ("Paper & Pine, Table A 1, a whole table"); the map's tables still name the person (T502).
   The map changes as the roster reads itself again, and the dropdown keeps its words and stays open through a re-read.
   Under the map, "<n> here with no table" and "<n> vendors are at tables not on a layout." count the vendors it cannot draw, each with "Show in the list", which opens the list showing all; with no location laid out it says "No location has a layout yet." alone, with "Open the layout" for whoever may change the setup.
   Check in, Check out and Undo? stay on the list: the map and the drawer check nobody in or out, so a Viewer reads the map as an Editor does.

It lists everyone expected on the day, so it shows who is missing; "Nobody is assigned on this date." on a date with nobody.
It works at a phone's width, as only the other organizer screens that fit a phone do ([attendance and the door](../../implementation/modules/attendance-and-door.md#sharp-edges)), and there its rows keep a gutter at both sides rather than running to the card's edges (T15).
Covered by:

- `a-seat-and-an-entry-open-the-drawer.spec.ts`
- `a-viewer-at-the-door-reads-why.spec.ts`
- `checkin.spec.ts`
- `the-door-as-a-map.spec.ts`
- `the-door-code.spec.ts`
- `the-door-keeps-its-own-day.spec.ts`
- `the-door-map-draws-its-floorplan-in-step.spec.ts`
- `the-door-map-keeps-the-floorplan-choices.spec.ts`
- `the-door-names-a-vendors-business.spec.ts`
- `the-door-on-market-day.spec.ts`
- `the-door-stays-fresh.spec.ts`
- `the-door-tools-hold-still.spec.ts`
- `the-roster-prints.spec.ts`

## K10. Check a vendor out

**Status:** Works (read from the code as of T500, `the-door-checks-a-vendor-out.spec.ts`, `a-vendor-checks-out.spec.ts`).
**Task (organizer):** "A vendor is leaving and has handed back what they borrowed. Record that they left."

1. On Attendance's list, in Market Days, a checked-in vendor's row offers "Check out", its one button, for someone who may check vendors in, on any day with a check-in, a vendor here with no table that day included.
2. Expect the row to keep its status and gain a second chip, "Out 4:05 PM by you", with one "Undo?" just left of that chip, which undoes the check-out and brings "Check out" back, with the check-in's "Undo?" left of its status.
3. A check-in is not undone while the vendor is checked out: the row has no "Undo?" by its status, only the check-out's "Undo?" by the departure chip, and a check-in's undo sent anyway is answered "Undo the check-out first."

**Task (vendor), at a market that lets vendors check themselves in and out:** "You are leaving. Check out."

1. On the vendor page, signed in, today's seat shows "Checked in at <time>" with "Undo", then a second "Door code" field and "Check out".
2. Type the door code, or scan it again, which fills the field and sends nothing, and press "Check out".
3. Expect "Checked in at <time>", "Checked out at <time>" and one "Undo", which undoes the check-out, with no door code, on the day itself only.

A wrong code says what a check-in's does (K3), and a day with no check-in "You are not checked in on this date."
The vendor's other days read "(checked in at <time>, checked out at <time>)", and the record of a market that ended "Checked in at <time>, checked out at <time>".
A check-out changes nothing else: "N of M checked in", "Show", the search, the map, the printed roster, "Did not come", the Stats tab and what a vendor owes read a checked-out vendor as checked in, and freeing or moving them still asks first.
The market's history says each: "… checked Ana Rivera out on Nov 19, 2026", "… undid the check-out of Ana Rivera …", and for the vendor's own "Ana Rivera checked out with the door code …" ([reading the market's history](reading-the-markets-history.md#l6-read-the-markets-history)).
Covered by:

- `a-vendor-checks-out.spec.ts`
- `a-viewer-at-the-door-reads-why.spec.ts`: a Viewer reads the out chip and is offered no button
- `the-door-checks-a-vendor-out.spec.ts`

## K11. Let vendors check themselves in and out

**Status:** Works (read from the code as of T496, `the-door-code.spec.ts`, `a-vendor-checks-out.spec.ts`).
**Task:** "You want vendors to check themselves in at the entrance, with the door code. Turn that on."

1. Attendance, in Market Days, "Door code": under the controls, the switch "Vendors check themselves in and out", off at every market until someone turns it on, with "While this is off, only organizers check vendors in and out, on Attendance."
2. While it is off the screen says "Vendors' own check-in and check-out are off. Turn them on to show the door code." and offers no "Make a door code", "New code" or "Print".
3. Turn it on: expect the door code, or "Make a door code" when none was made, as K5 has it.
4. Turn it off again: the code is kept, and it and every poster of it work again once the switch is back on.

While it is off a vendor's page offers no check-in, no check-out and no "Undo": today's seat reads "An organizer checks you in at the door.", then "An organizer checks you out at the door." once an organizer has checked them in, and a scanned door code is answered "Vendors are checked in and out by an organizer at this market. Ask at the door." (K2).
The organizer's own "Check in", "Check out" and "Undo?" on Attendance work the same with the switch on or off.
A Viewer is offered no "Door code", so no switch.
The market's history says who turned it: "… let vendors check themselves in and out" and "… stopped vendors checking themselves in and out".
Covered by:

- `a-vendor-checks-out.spec.ts`: the vendor page with the switch off, and both doors back once it is on
- `the-door-code.spec.ts`

## The rules it obeys

- [Publish results waits for the allocation](../rules/publish-results-waits-for-the-allocation.md): a market whose vendors apply on its page goes live only after its applicants are told.
- [Intake mode decides how vendors arrive](../rules/intake-mode-decides-how-vendors-arrive.md): check-in is served on both paths.
- [An archived market that ran stays a record](../rules/an-archived-market-that-ran-stays-a-record.md): the vendor page after the market ([L1](ending-and-managing-a-market.md#l1-archive-after-market-days)).
- [What each role may do](../rules/what-each-role-may-do.md): publishing is an Admin's, checking in at the door an Editor's.
- [Vendor notes](../rules/vendor-notes.md): a request is marked handled at the door, and the mark can be taken back.

Its gaps worth a spec are in [walking the flows](../../implementation/testing/walking-the-flows.md#coverage-map).
