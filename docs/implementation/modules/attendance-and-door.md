---
layer: implementation
kind: module
describes:
  - back-end/api/attendance.py
  - back-end/api/door.py
  - back-end/api/vendor_check_in.py
  - back-end/app.py#vendor_check_in
  - back-end/app.py#vendor_undo_check_in
  - back-end/app.py#vendor_check_out
  - back-end/app.py#vendor_undo_check_out
  - back-end/app.py#get_market_attendance
  - back-end/app.py#_door_write
  - back-end/app.py#organizer_check_in
  - back-end/app.py#organizer_undo_check_in
  - back-end/app.py#organizer_check_out
  - back-end/app.py#organizer_undo_check_out
  - back-end/app.py#get_door_code
  - back-end/app.py#make_door_code
  - back-end/app.py#set_self_check_in
  - front-end/src/views/AttendanceStatusView.vue
  - front-end/src/components/DoorCodeScreen.vue
  - front-end/src/utils/doorCode.ts
  - front-end/src/utils/qrDrawing.ts
  - front-end/src/components/vendorPage/VendorCheckIn.vue
  - front-end/src/App.vue#fitsAPhone
  - front-end/src/utils/fitsAPhone.ts
  - back-end/app.py#verify_attendance_indexes
  - front-end/e2e/one-record-for-a-vendors-day.spec.ts
  - front-end/src/components/ListFreshness.vue
  - front-end/src/components/DoorRosterPrint.vue
  - front-end/src/components/attendance/AttendanceMap.vue
  - front-end/src/utils/useUpdatedWords.ts
  - front-end/src/components/attendance/laidOutLocations.ts
verified: 2026-11-19
sources:
  - wayfinding/real-market-readiness/map
  - wayfinding/claims-and-room/map
  - wayfinding/readable-journey/06
  - wayfinding/readable-journey/map
  - E29
  - E29/F01/S01
  - E29/F01/S02
  - E26/F06/S02
  - bug/1
  - bug/9
  - known-gap/3
  - T15
  - T82
  - T142
  - T148
  - E38/F15/S04
  - T202
  - T251
  - T270
  - T201
  - T274
  - T318
  - T421
  - T422
  - T411
  - T466
  - T469
  - T496
  - T501
---

# Attendance and the door

Who comes on market day, and who has left, recorded at two doors: the vendor's own check-in and check-out, on their vendor page behind their sign-in and the market's door code, keyed by the market's address, and the organizer's Attendance page, keyed by the market's id.
The vendor's door is open only where the market turned its self check-in switch on; until then only organizers check vendors in and out ([ADR 0040](../../adr/0040-vendors-check-themselves-in-and-out-only-where-the-market-turned-it-on.md)).
[`back-end/api/attendance.py`](../../../back-end/api/attendance.py) owns the `attendance` collection and both readings of it; [`back-end/api/door.py`](../../../back-end/api/door.py) is the organizer's door and the door code; [`back-end/api/vendor_check_in.py`](../../../back-end/api/vendor_check_in.py) is the vendor's; the routes are in [`back-end/app.py`](../../../back-end/app.py); the organizer's page is [`AttendanceStatusView.vue`](../../../front-end/src/views/AttendanceStatusView.vue), and the vendor's is the check-in section of the vendor page, [`VendorCheckIn.vue`](../../../front-end/src/components/vendorPage/VendorCheckIn.vue).

## The collection

One document per `(market_id, vendor_email, date)`, stored snake_case, upserted by `record_attendance` with `table_code` (the table code of the seat the vendor held when it was made, T318), `checked_in_at` (ISO 8601 UTC, the latest check-in), `checked_in_by` (the organizer's address, or None for the vendor's own) and `checked_in_via` (`door_code` for the vendor's own, else None).
Checking in again updates the table with the time, so a vendor checked in again at a new seat is recorded there.
A check-in made on the public check-in page before it was removed has `checked_in_by` None and no `checked_in_via`, and one made before T318 has no `table_code`: it is read as made at the seat the vendor holds now, which is the answer a stored table would give, so nothing was migrated.
The vendor's address is normalised (`utils/email_address.normalized_email`) on every write and lookup.
Undoing a check-in deletes its document: nothing else was changed by it.
A check-out is three more fields on that document (`CHECK_OUT_FIELDS`, T496): `checked_out_at` (ISO 8601 UTC), `checked_out_by` (the organizer's address, or None for the vendor's own) and `checked_out_via` (`door_code` for the vendor's own, else None), set by `record_check_out` and unset by `undo_check_out`.
A document with no `checked_out_at` is a vendor not checked out, which is every document stored before check-outs, so nothing was migrated.
The collection goes with the market when it is deleted.

### One vendor's day is one record, by the database

The one document per vendor's day is the database's to hold, not the upsert's (T270).
An upsert with no unique index behind it can insert twice when two land at once, so without the index two organizers at the door, or an organizer's tap and the vendor's own door-code check-in, could leave two records: one Undo would take one away and leave the vendor reading as here, and the history would hold two arrivals.

- `ensure_attendance_indexes` builds `attendance_vendor_day_unique`, unique on `(market_id, vendor_email, date)`, through [`unique_indexes.py`](../../../back-end/unique_indexes.py), and `app.py`'s `verify_attendance_indexes` refuses to boot without it, naming any duplicates by market id, date and record id, never by address ([OPERATIONS.md](../../OPERATIONS.md#when-the-back-end-refuses-to-boot)).
- `record_attendance` writes by `find_one_and_update(..., upsert=True, return_document=BEFORE)`, so it knows whether it inserted the record and what it replaced, and runs it once more on a `DuplicateKeyError`, which then lands on the winner's record; a second refusal goes on as the error it is.
  MongoDB itself retries such an upsert when its query is equality on the unique index's fields, so the retry is the fallback when the server does not.
- Only the call whose upsert inserted the record writes the "checked in" entry, so two racing check-ins write one.
- The index's prefix serves a vendor's check-ins, so `attendance` has no lookup index of its own in [the lookup indexes](../data/lookup-indexes.md); a database that already held the old `(market_id, vendor_email)` one keeps it, which is harmless.
- [`one-record-for-a-vendors-day.spec.ts`](../../../front-end/e2e/one-record-for-a-vendors-day.spec.ts) proves the refusal and 16 check-ins at once on the stack's real MongoDB; the back end's suite runs on fakes, which hold no index, except [the real-MongoDB suite](../testing/real-mongo-suite.md), which builds the index through the boot, refuses to start over two planted records of one vendor's day, and races 20 check-ins of one vendor's day, which leave one record and one "checked in" entry ([one record per vendor's day](../testing/real-mongo-suite.md#one-record-per-vendors-day)).

## The routes

| Route                                           | Who                                                        | Does                                                                                   |
| ----------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `POST /public/markets/<slug>/vendor/check-in`   | the vendor, signed in, with the live door code             | their own check-in for `date`, `{date, doorCode}`                                      |
| `DELETE /public/markets/<slug>/vendor/check-in` | the vendor, signed in                                      | the undo of their check-in for `date`, within a day of the server's date, no door code |
| `GET /markets/<id>/attendance`                  | the Read row: any role                                     | the roster                                                                             |
| `POST`/`DELETE /markets/<id>/attendance`        | the Check vendors in row: EDITOR by default                | the organizer's check-in for a day that has begun, or its undo                         |
| `GET /markets/<id>/door-code`                   | the Check vendors in row                                   | the door code, `{code, madeAt, madeBy, url}`, or `{code: null}`                        |
| `POST /markets/<id>/door-code`                  | the Check vendors in row, in `market_days`, never archived | a new door code, which ends the old one                                                |

The check-out's routes and the switch's, each beside the route it mirrors above (T496):

| Route                                              | Who                                                        | Does                                                                          |
| -------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `POST /public/markets/<slug>/vendor/check-out`     | the vendor, signed in, with the live door code             | their own check-out for `date`, `{date, doorCode}`                            |
| `DELETE /public/markets/<slug>/vendor/check-out`   | the vendor, signed in                                      | the undo of their check-out for `date`, within the same window, no door code  |
| `POST`/`DELETE /markets/<id>/attendance/check-out` | the Check vendors in row                                   | the organizer's check-out of any date with a check-in, or its undo            |
| `PUT /markets/<id>/self-check-in`                  | the Check vendors in row, in `market_days`, never archived | the self check-in switch, `{enabled}`; answers what the door code's read does |

Both door code routes and the switch's answer `selfCheckIn`, the switch, beside the code, with a code or with none.
All four of the vendor's routes answer 403 while the switch is off (below).

## Sharp edges

**Attendance is a roster off the stored assignment.**
`GET /markets/:id/attendance` serves `{dates, roster}`: every vendor the stored assignment places on each date, with `vendorName` (the name they go by, else the one on their identification), `vendorFullName` (the one on their identification, which both of the page's searches find too, T466), `state`, `checkedInTableCode`, `checkedInAt`, `checkedInBy`, `checkedInVia` and the check-out's `checkedOutAt`, `checkedOutBy` and `checkedOutVia`, each null when the vendor is not checked out (`attendance_roster`), and after a date's seated rows, a row for each check-in of that date whose vendor holds no seat on it.
Never derive who is expected from check-in records: that list is who came, and it is how the page could not say who was missing on a day of 80 vendors (known gap 3).
The roster, the vendor's own read and the check-in all read the same stored rows, so who is expected where can never disagree with where a vendor is sent; the public lookup once ran the solver afresh and sent a vendor moved by hand to their old seat (bug 1).
A row's status says who checked the vendor in: "Scanned in at 9:41 AM" for the vendor's own (`checkedInVia: door_code`), "Checked in 9:41 AM" for an organizer's, with "by you" or "by <organizer>" on a plain line after the chip, and with no such line for one made on the old public page.
A vendor's own check-in times are `check_ins_of`, which the vendor page's own read uses, so each seat a vendor reads carries when they checked in to it ([ADR 0022](../../adr/0022-the-vendor-page-is-signed-in.md)), and `check_outs_of` beside it gives each seat `checkedOutAt`; whether a market ran is `market_ran`.
The Stats tab's Check-in is `check_in_counts`, beside the roster: the same stored rows and attendance records, counted per date as the door's "18 of 24 checked in" counts them and with `came`, the vendors in on any date, but reading no names and sending no row ([who has come](../../business/flows/stats.md#n6-see-who-has-come)).

**Attendance's tools are one toolbar and a count row, pinned under the market's frame at a desk** (T466, release walk F5).
Once the roster has dates the page is a [`PinnedTools`](../../../front-end/src/components/PinnedTools.vue) (`attendance-tools`) of two [`ToolRow`](../../../front-end/src/components/ToolRow.vue)s over the padded `.door`; the loading line, a failed first read and "This market has no dates yet." stand in `.door` alone, with nothing to pin.
The toolbar (`attendance-toolbar`) starts with the date as a `.field--compact` select (`attendance-date-select`, its hidden label "Market date"), each option the day alone, written to `date` in the address with `router.replace`, and, on Map with two locations or more laid out, the location the same way (`attendance-location-select`, "Location"), written to `location`.
Its end is three [`ToolGroup`](../../../front-end/src/components/ToolGroup.vue)s: List and Map as a [`SegmentedControl`](../../../front-end/src/components/SegmentedControl.vue) (`attendance-view`), Print roster with Door code, and [`ListFreshness`](../../../front-end/src/components/ListFreshness.vue) with no time, so Refresh is the last control in the markup and the Tab key's last stop; no style reorders a control.
The count row (`attendance-bar`) holds "N of M checked in" (`attendance-summary`), on List the four filters (a group named "Show"), and the search, `.field--compact`, taking the row's room: on List a field that filters the rows (`attendance-search`), on Map a [`SearchPicker`](../../../front-end/src/components/SearchPicker.vue) (`attendance-map-search`).
From 1024px the block is sticky under the frame from the start, so it never moves while the list or the map scrolls under it; under 1024px it scrolls away with the page, and on a phone each control is 44px.
There are no date buttons and no per-date tallies, and no note asking for paper.
`AttendanceStatusView.test.ts` holds the date select, the Tab order, the groups and the read time's place, [`theDoorAsAMap.test.ts`](../../../front-end/src/__tests__/theDoorAsAMap.test.ts) the location select, and [`the-door-tools-hold-still.spec.ts`](../../../front-end/e2e/the-door-tools-hold-still.spec.ts) the block's top at the frame's bottom at 1100, 1440 and 1990 wide through 900px of the list's scroll and the map's whole (600 tall, where the map page scrolls), a failed refresh's line inside it, each row 12px over and under its tallest item, and on a phone the block scrolling away with every target 44px.

**Attendance is a list or a map of the open day** (T422, D38 to D41): "List" and "Map" stand first in the toolbar's end, the open one pressed, and Map is `view=map` in the address, written with `router.replace` beside `date`, so a change of day and a reload keep it; List is the page as it was.
On Map, [`AttendanceMap.vue`](../../../front-end/src/components/attendance/AttendanceMap.vue) stands in place of the filters and the rows, and draws the [day map](../../../front-end/src/components/daymap/DayMap.vue) of the chosen date from the roster the page already reads and re-reads, so it is as fresh as the list, with no read of its own but the laid-out locations' floorplan images, read with the session as the layout page reads them.
**A location's tables and its floorplan appear together** (T501): the images are read through [the one loader of a map's images](floorplan-placement.md#a-maps-floorplan-images), each keyed by its gridfs id, the open location's first and the others' behind it, so a switch to a location opened before, or read behind the open one, asks for nothing and draws at once; the day map is handed the open location's image alone and the loader's `pending` as `imagePending`, so while the open image loads it draws the floor alone, for at most two seconds.
Past those, while the image is still on its way, the tables stand on the floor and "Loading the floorplan..." stands under the map (`attendance-map-image-loading`); an open image that cannot be loaded leaves them there with "The floorplan could not be loaded. The tables are drawn without it." (`attendance-map-image-failed`), and is read again the next time its location opens; both in the map's note style, `aria-live="polite"`.
With "Show the floorplan" unticked nothing waits and neither line shows: the tables are drawn at once, as they are for a location with no image.
**Under the legend stand the Layout page's three ticks**, "Show the floorplan", "Greyscale" and "Faded", a group named "Floorplan" (`attendance-map-floorplan`), the last two disabled while the floorplan is not shown: the same remembered choices, `rememberedChoice('showImage' | 'imageInGrey' | 'imageFaded', true)` in [`layoutViewChoices.ts`](../../../front-end/src/components/layout/layoutViewChoices.ts), so one made on either page is the other's on its next mount, passed to the day map as `showImage`, `imageInGrey` and `imageFaded`.
They stand only while the open location's layout has an image, for everyone who sees the map, a Viewer and a team member with no check-in right included; on a phone each label is a 44px target and the line wraps.
Its locations are those laid out as the public map's server chooses them (`mapped_locations`): a layout with a scale and a table numbered in one of the location's own sections, written once in [`laidOutLocations.ts`](../../../front-end/src/components/attendance/laidOutLocations.ts) (`laidOutLocations`), which the map and the page's location select both read, so they never disagree; the open one is `location` in the address when it is laid out, else the first (`openLocationId`).
The page's select chooses it, so the map passes `locationSwitch: false` and the day map draws no switch of its own.
A roster row is matched to a table by its code, its section's name and its number (`rosterSeats` in [`dayMap.ts`](../../../front-end/src/components/daymap/dayMap.ts)), each in its `rosterTone` (T501): `here` and `here_elsewhere` are `filled`, or `checkedOut` once the row has a `checkedOutAt`, in the section's out shade, `expected` is `outlined`, and a table with nobody is free; the roster's states are the server's, unchanged, and the check-out is read off the row on the page.
The legend reads "Checked in", "Checked out" and "Not checked in", in that order, at every time of day, whether or not the day has a vendor in each, since it names the map's states, and "No vendor" only when the open location draws a table or half nobody sits at (`drawsAFreePart`); the no-table zones stay drawn, with no legend item.
When the roster was read stands under the map's bottom right, the day map's `note`.
A seat is named as the list names its vendor, their name or else their address, then their state ("Ana Rivera, checked in", ", not checked in" or ", checked out"), which `AttendanceMap` builds into the seat's `name`, so a screen reader hears the states without colour and `LayoutMap` names the seat as it names any other; it is keyed by their address, so a press on it opens the vendor drawer through the page's own `useVendorDrawer`, on its Application tab, keeping `view` and `date`; the open vendor's seat is the one picked, and each half of a shared table is its own seat.
A press on a table with nobody says "Table <code>: no vendor on <date>." under the map, the date spelled as the date select spells it, and opens nothing; a free half of a shared table is no button.
On Map, "Find a vendor" is a `SearchPicker` (`compact`, `listOver`, `clearsOnChoice`, `hideLabel`, capped at `PEOPLE_CAP`) of the chosen date's every roster row, seated or here with no table, one option per vendor by address, labelled as the row names them and its detail where they sit (`whereTheySit`); it finds by the table code and through `vendorMatches` given the roster's full names, the list search's own terms, so a vendor going by another name is found by the name on their identification too, and its list lies over the map from the field's start, at most 32rem wide, so a name and where they sit stand close.
A pick opens the vendor's drawer, so their seat is the picked one; when that seat stands on another laid-out location the page first replaces `location` in the address, then opens the drawer, so the drawer's own history step is taken on the vendor's location and Back closes it there (T466, release walk F3).
A vendor with no seat the map draws opens with nothing outlined, and closing the drawer clears the outline.
Typing outlines nothing: the map has no `found` prop any more, which replaces T422's D40 outline of every match, and the day map's `marked` stays for its other callers.
At a desk the map is no taller than the window leaves under the door's head (its own rule caps the day map's frame at the window less 30rem, at least 20rem), so the whole map, its zoom and its legend stand in view as the page opens; a phone keeps the day map's own height.
Under the map, "<n> checked in with no table" and "<n> vendors are at tables not on a layout." each show only when they apply, with "Show in the list", which goes back to List with Show set to All, since the toggle is hidden on Map and would hide some of them; with no location laid out the map says "No location has a layout yet." in place of the second count, with "Open the layout" for whoever may change the setup.
Nothing on the map writes: Check in, Check out, Undo? and notes stay on the list (D39), and the drawer has no check-in.
[`aMapsFloorplanLoadsInStep.test.ts`](../../../front-end/src/__tests__/aMapsFloorplanLoadsInStep.test.ts) holds the image's loading and its two lines, [`theDoorMapKeepsTheFloorplanChoices.test.ts`](../../../front-end/src/__tests__/theDoorMapKeepsTheFloorplanChoices.test.ts) the three ticks and their keys, and the tables drawn at once with neither line while "Show the floorplan" is unticked, [`the-door-map-draws-its-floorplan-in-step.spec.ts`](../../../front-end/e2e/the-door-map-draws-its-floorplan-in-step.spec.ts) every frame of a switch with an image held, the background fetch, a reload's 304s and a failed image, and [`the-door-map-keeps-the-floorplan-choices.spec.ts`](../../../front-end/e2e/the-door-map-keeps-the-floorplan-choices.spec.ts) the ticks for an organizer, an Editor with no check-in right and a Viewer, a choice carried to the Layout page and back, and their targets on a phone.
[`theDoorAsAMap.test.ts`](../../../front-end/src/__tests__/theDoorAsAMap.test.ts) holds the switch, the tones, the re-read, the presses, the search's rows, terms, picks and re-read, and the counts; [`the-door-as-a-map.spec.ts`](../../../front-end/e2e/the-door-as-a-map.spec.ts) walks it on a phone and at a desk, where the zoom and the legend stand in the window, with a check-in on the list and one elsewhere that the re-read brings, a pick by the keys and one in South Wing, and a Viewer who reads it and writes nothing.

**A check-in needs a stored placement for that vendor on that date** (`seat_on`, the stored row or None; `seated_on` asks whether there is one), or it is a 404.
A placement is dated by the market date itself, so no reader maps anything back to a date.

**A check-in keeps its table, and the roster says where each vendor stands** (T318, [the roster states](../../../CONTEXT.md#at-the-door)).
A check-in said only that a vendor came on a date, so a vendor checked in and then freed vanished from the roster while their record stayed, and once seated again elsewhere read as checked in, with the old time, at a table they never reached (T277's report, section 4.9).
Each roster row's `state` is `expected` (a seat and no record), `here` (a record made at the seat held now, or a record with no `table_code`), `here_elsewhere` (a record made at another table, after a move or a swap) or `here_without_seat` (a record and no seat that day, after a free), and `checkedInTableCode` is the record's table (on a seated row, the seat's for a record with none); a `here_without_seat` row has `tableCode`, `tableChoice`, `section` and `location` null.
The page words `expected` "Not checked in" on every day, to come, today or over, and on an archived market (T501): it once said "Did not come" of a day over on the viewer's calendar, a guess, since the server cannot know the market's time zone.
The record itself is never moved: freeing, moving or swapping a vendor leaves it as it was, and the state says where they went.
Freeing, moving or swapping a vendor who has a record that day asks first: the placement doors read it (`checked_in_on`, one record by the normalised address) and answer 409 `vendor_is_here` until asked again with `whileHere: true` ([placements](placements.md)).
`check_in_counts` and the page's tally count seated rows only, so a vendor here with no table that day counts toward no day's "18 of 24 checked in".
[`test_a_check_in_keeps_its_table.py`](../../../back-end/tests/test_a_check_in_keeps_its_table.py) holds each state through the route, the record's table, and the free and the move that once moved it.

**A check-out is fields on the check-in's record, and besides its own chip and the vendor page, only Attendance's map and filters read it** (T496, T501, [ADR 0040](../../adr/0040-vendors-check-themselves-in-and-out-only-where-the-market-turned-it-on.md)).
A checked-out vendor still came: a row's `state` and its place in the order, `check_in_counts`, `checked_in_on`, `market_has_attendance`, the Stats tab, the public map, the owed days and the placements read exactly as before, and freeing or moving a checked-out vendor still asks first.
`record_check_out` needs only the day's record, no seat and no day that has begun, so a vendor here with no table that day is checked out too.
It is one `find_one_and_update` filtered to the vendor's day with `checked_out_at: None`, which matches a missing field, on a real server too.

- Matched: 200 `{"message": "Checked out", "checkedOutAt": <time>}` and a `checked_out` entry.
- Not matched, and the day's record has a check-out's time: the vendor is checked out already, so it answers 200 with the stored time, writes nothing and records nothing; two check-outs at once leave one time and one entry.
- Not matched, and the day's record has no check-out's time: the check-out that held the record was undone before this read, so it writes again, and "Checked out" is never answered with no time.
- Not matched, and no record: 404, "No check-in found for this vendor on this date".

`undo_check_out` unsets the three fields, leaving the check-in as it is, with one `find_one_and_update` filtered to a day that is checked out: 200 `{"message": "Check-out undone"}` and a `check_out_undone` entry, or 404, "No check-out found for this vendor on this date".
`undo_attendance` refuses a checked-out day: its delete is filtered to `checked_out_at: None`, and when nothing was deleted and the day has a record it answers 409, "Undo the check-out first.", so a check-out is never dropped without its own entry.
`record_attendance` leaves a check-out's fields as they are: checking in again is a new time, never a second arrival.
[`test_an_organizer_checks_a_vendor_out.py`](../../../back-end/tests/test_an_organizer_checks_a_vendor_out.py) holds the record, a second check-out, the refused undo of a check-in, and each reader above answering the same before and after a check-out; [`test_the_public_map.py`](../../../back-end/tests/test_the_public_map.py) holds the map's answer to the same bytes; [the real-MongoDB suite](../testing/real-mongo-suite.md#one-record-per-vendors-day) races 20 check-outs and 20 undos over a record stored with no check-out fields.

**A check-in, a check-out or the undo of either holds the market's phase** (T318, T496).
The record lives in `attendance` and the phase on the market, so no one write holds both, the race [ADR 0024](../../adr/0024-a-market-write-holds-what-it-read.md)'s last consequence leaves to compensation.
`record_attendance`, `undo_attendance`, `record_check_out` and `undo_check_out` read the market themselves (`live`) and refuse outside `market_days`, archived with "This market has ended, so check-in is closed." (409) and otherwise "Vendors are checked in once the market is published." (409); then they write, and read the phase again (`_closed_since`).
A market no longer in its days by then gets the write taken back, with no history entry and the archived refusal (or "Market not found", 404, for one gone since): an inserted record deleted (held to the time this call wrote, so another call's is left to it), an updated one put back to the fields it had, a deleted one inserted again; a check-in of that day which landed in between keeps the day's one record.
A check-out taken back has its three fields unset again, held to the time this call wrote, and an undone one has them put back where the day is still not checked out.
The two refusals keep their wording for a check-out: "check-in is closed" names the door.
So neither door's check-in, check-out nor the undo of either lands on a market archived a moment before, and the archived record of who came stays whole.

**Both doors keep one "today": the server's UTC date, a day either side of which is today somewhere on Earth** (`day_has_begun` and `within_the_window`, in `api/attendance.py`).
The organizer's check-in takes any market date no later than the server's UTC date plus one, so a tap missed in the rush is corrected after, and refuses a later one with 409, "That day has not begun yet, so nobody can be checked in for it." (in `record_attendance`, after the seat check); its undo takes any date.
The vendor's door keeps its window, a day either side of the server's UTC date.
The page's "today" stays the viewer's calendar day (`calendarToday`), so the page offers Check in only on a chosen date no later than it, never inviting the refusal; Undo stays wherever there is a record.

**A vendor checks themselves in only signed in, and only with the door code** ([ADR 0022](../../adr/0022-the-vendor-page-is-signed-in.md)).
The check-in was a public page at `/<slug>/check-in`, where anyone with the market's address typed any vendor's email, read their seats and checked them in or out, so a check-in proved nothing; it, its read and its four public endpoints are gone, and answer 404.
`api/vendor_check_in.py` wants the vendor page's Bearer token (401 without), counts every try, right code or wrong, against `check-in:address` (10 in 15 minutes) by the token's address and counts nothing per caller, so a venue's shared wifi never refuses one vendor's right code for others' wrong ones, while a vendor at home cannot guess the code ([`sign_in_limits`](../../../back-end/sign_in_limits.py), beside the sign-in's own bounds in [a vendor signs in before they have applied](../../business/rules/a-vendor-signs-in-before-applying.md#sign-in-is-bounded)), and goes through the vendor page gate (`vendor_page_market_by_slug`), so a market with no vendor page answers exactly as a slug that names nothing.
Then, each with its own sentence and writing nothing: a token for another market (403, "Your sign-in is for a different market. Please sign in again."), an archived market (409, "This market has ended, so check-in is closed."), any phase before `market_days` (409, "Check-in opens when the market's days begin."), no seat for them on `date` (404, "You have no table on this date."), a `date` more than a day from the server's UTC date (409, "Check-in is open on the day itself."), so a code read today cannot check them in for next week while "today" is still in reach in every time zone, and a code that is not the live one (403, "That isn't this market's door code. Check it, or ask at the door.").
The code is compared in `api/door.py` (`door_code_matches`), upper-cased with its spaces and dashes dropped, in constant time, so the live code never leaves that module; a market with no code yet matches nothing.
It writes through `record_attendance` with `checked_in_via: door_code`, through the unasked recorder of the history's Check vendors in row with no actor, so `checked_in_by` is None (`History.unasked`, `VENDORS_OWN_CHECK_IN_UNASKED`: a vendor holds no role, so no row of the table asks their own check-in); the undo takes no door code, only the vendor's sign-in, `market_days` and a date within the same one-day window, counting nothing against a limit, and takes back their check-in for the date, whoever made it, so an organizer's check-in today may be undone by the vendor but no past day's by anyone but an organizer.
Both read their body with `json_object`, so a body that is not a JSON object is `A JSON object is required`, 400 ([a request value is a string](../conventions/a-request-value-is-a-string.md)).

**A vendor checks themselves out as they checked in: signed in, with the door code** (T496).
The door code proves the vendor is at the door, where what they return is handed back.
`check_out` in `api/vendor_check_in.py` counts every try against the same `check-in:address` limit, with the limit's sentence unchanged, and refuses in the check-in's order: 401 with no sign-in, the limit, 404 for no market, 403 for another market's sign-in, 409 once ended, 409 before the market's days, 403 while the switch is off (below), 409 for a `date` outside the window, 403 for a wrong code.
It asks for no seat, since the day's record is the check: a day with none answers 404, "You are not checked in on this date.", the vendor's wording of `record_check_out`'s own 404.
It writes through `record_check_out` with `checked_out_via: door_code`, through the same unasked recorder as the check-in.
Its undo takes no door code and counts nothing: the sign-in, `market_days`, the switch and the window, then `undo_check_out` with `via: vendor_page`.
A check-out with no `date` answers the window's 409, and its undo with none `undo_check_out`'s own 400, "date is required", as the check-in's undo does.
The vendor's undo of a check-in on a checked-out day answers the 409 above, "Undo the check-out first.".
[`test_a_vendor_checks_out_with_the_door_code.py`](../../../back-end/tests/test_a_vendor_checks_out_with_the_door_code.py) holds both routes, each refusal in that order, and the limit.

**The vendor's door is behind the market's self check-in switch, off until someone turns it on** (T496, [ADR 0040](../../adr/0040-vendors-check-themselves-in-and-out-only-where-the-market-turned-it-on.md)).
It is the boolean `vendorSelfCheckIn` on [the market document](../data/market-document.md), `vendor_self_check_in` of the `Market` model, server-owned as `applications_stopped` is; a market that stores none reads as off (`vendor_self_check_in_from_market_document`), the markets that ran before it included, so nothing was migrated.
`PUT /markets/<id>/self-check-in` (`set_self_check_in` in `api/door.py`) sets it: the Check vendors in row through the change loader, only in `market_days` (else 409, "Vendors' own check-in is set once the market is published."), a body whose `enabled` is not a JSON boolean or that holds any other key 400, "enabled must be true or false.", read after the person is let in, so a Viewer's malformed body is their 403.
It writes through [the market write](market-write.md) holding the field, records `self_check_in_set`, and a switch restated writes and records nothing.
It is apart from the door code: the code stays stored while the switch is off and works again, with every poster of it, once it is on, and making a code does not turn it on.
It is read in four places:

- the vendor's four routes, off the market document each already loads (`_market_on_its_days` in `api/vendor_check_in.py`, the field added to its projection), after the phase's refusals and before the seat, the window and the code: off, each answers 403, "Vendors are checked in and out by an organizer at this market. Ask at the door.", and writes nothing;
- the door code's `GET` and `POST` and the switch's own `PUT`, as `selfCheckIn`, so the door code's screen needs no other read;
- the public vendor-page read, as `selfCheckIn`, which the vendor page reads before any sign-in;
- the market read, as `vendorSelfCheckIn`, false when the document stores none.

The organizer's four writes never read it.
[`test_the_self_check_in_switch.py`](../../../back-end/tests/test_the_self_check_in_switch.py) holds the write, its refusals, the vendor's four refused while off and working once on, and the organizer's four untouched; `test_the_door_code.py` the reads' shape and who may set it, by role; `test_the_vendor_page.py` the public read's `selfCheckIn` and each seat's `checkedOutAt`.

**The vendor page checks a scanned vendor in for today, after the sign-in it may take** ([`VendorCheckIn.vue`](../../../front-end/src/components/vendorPage/VendorCheckIn.vue), [`VendorPage.vue`](../../../front-end/src/views/VendorPage.vue)).
The QR code opens `/<slug>/vendor?door=<code>`, and a poster printed while the vendor page was at `/<slug>` still works, since `/<slug>?door=<code>` goes on to it ([every market page has an address](../conventions/every-market-page-has-an-address.md#old-addresses)): the page keeps the code in this tab's `sessionStorage` (the application store's `holdDoorCode`) and takes it off the address at once with `router.replace`, and "Sign in, and you'll be checked in for today." stands over the sign-in while it waits.
Once the vendor's own read has loaded, the check-in section takes the code (`takeDoorCode`, used once) and checks them in for today's seat; with no seat today, before the market's days or once it has ended, it says so instead (`scannedCodeRefusal`) and sends nothing, and a seat already checked in to sends nothing either.
A sign-in that ran out mid-check-in (401) takes the page back to the sign-in with the code held again for that vendor's address, so it checks them in after their next sign-in.
A held code checks in only the vendor who scanned it, since vendors may share a device at the door: scanned with nobody signed in, it is held for no address until the sign-in sends a code to one (`requestCode`), and a sign-in at the market by any other address drops it unused (`holdSignIn`); `takeDoorCode` gives it to no other address.
Before any address was sent a code, the next sign-in, a remembered device's included, is taken for the scanner's own.
"Today" is the vendor's own calendar day (`calendarToday`), read again whenever the page comes back into view.
In Market Days the section shows today's seat on top with Check in, a "Door code" field for a vendor whose camera will not read the QR code, then "Checked in at <time>" with Undo, and the other days listed below; the status card then lists no seats, since the section does.
Archived after it ran, it is "Where you sat": each seat, and when they checked in or "Not checked in", and no check-in.

**Today's card has a state for each step of the vendor's day, and none of its controls while the switch is off** (T496).
With the switch on (`selfCheckIn` of the page's public read):

- not checked in: the card as above;
- checked in, not out: the "Checked in at <time>" chip and its Undo, then a second form (`vendor-check-out-form`) with the same "Door code" field (`vendor-check-out-code-input`) and a primary "Check out" (`vendor-check-out-btn`, disabled until the code is whole);
- checked out: the "Checked in at <time>" chip, a "Checked out at <time>" chip (`vendor-check-out-done`) and one Undo (`vendor-check-out-undo-btn`), which undoes the check-out; the check-in has no Undo until then.

One write is out at a time (`doing`), each button naming only its own ("Undoing…", "Checking out…") and both disabled while either is out; a refusal of any of the four writes is said in the card's one error line (`vendor-check-in-error`), so a switch turned off after the page loaded shows the server's 403 sentence there.
A door code scanned while the vendor is checked in and not out is put in the check-out field, taken out of the tab, and sends nothing, so a second scan by accident never ends their day; scanned once checked out, it is dropped.
No code is held for a check-out through a sign-in that ran out, since a check-out is never sent unasked.
With the switch off in Market Days (`onlyOrganizersCheckIn` in [`vendorPage.ts`](../../../front-end/src/utils/vendorPage.ts)) the card shows the day, the table and whichever chips the record has, with no form and no Undo, and one line (`vendor-check-in-at-door`, `atTheDoorLine`): "An organizer checks you in at the door." before a check-in, "An organizer checks you out at the door." after it, nothing once checked out.
A door code that arrives then is dropped at once, before any sign-in, after the market's read on load and again when scanned on the open page, and the page says the server's sentence in a notice under its header (`vendor-self-check-in-off`), signed in or out; "Sign in, and you'll be checked in for today." is not shown.
The notice follows the server's order: before the market's days or once it has ended, the phase answers a scan as before.
The other days read "(checked in at <time>, checked out at <time>)" and the ended market's record "Checked in at <time>, checked out at <time>" (`cameAndLeft`).
The store's `checkOut(date, doorCode)` and `undoCheckOut(date)` are built as `checkIn` and `undoCheckIn` are, with the fallbacks "You were not checked out. Please try again." and "Your check-out was not undone. Please try again.".
`aVendorChecksOut.test.ts` holds each state with the switch on, off and missing from the read, the scanned code's outcomes and each refusal; [`a-vendor-checks-out.spec.ts`](../../../front-end/e2e/a-vendor-checks-out.spec.ts) walks it at 390 under a phone's emulation: a check-in, a second scan that fills the field and sends nothing, the check-out and its undo, each state's controls 44px and inside the window, then a market with the switch off, the scan's notice signed out, the at-the-door lines, and both doors back once it is turned on.
It works alike on both kinds of market: a Google Form market's vendor page opens once its results are published ([a gated market answers as absent](../../business/rules/a-gated-market-answers-as-absent.md)).
[`checkin.spec.ts`](../../../front-end/e2e/checkin.spec.ts) walks the door: the organizer makes the code, a vendor opens its `url` signed out, signs in and lands checked in, and the roster says "Scanned in"; a new code makes the old `url` refuse; a typed code and its Undo; a scan with no table today; a held code that checks in no other vendor, after another address is sent a code or a sign-in that ran out; and the old endpoints' 404.

**An organizer checks a vendor in through `api/door.py`**: the table's Check vendors in row ([the market's actions](market-actions.md)), EDITOR by default, the bar every market write sets, so a door volunteer is added to the market as an editor.
It loads through the change loader (`_market_change`), so an archived market's record is never changed, and refuses with a 409 outside `market_days`; `record_attendance` and `undo_attendance` then hold the phase on their own reads (above).
Its `check_out` and `undo_check_out` are built the same way over `record_check_out` and `undo_check_out`, at `/markets/<id>/attendance/check-out`, a route of their own so each of the four writes has its own address; they take any date with a record, as the undo of a check-in takes any date.
It writes through `record_attendance` and `undo_attendance`, passing the Check vendors in asking the loader returned, whose person `record_attendance` stamps as `checked_in_by` and the history records as the actor, so the two doors record alike, and a vendor checking in again after an organizer did is no longer credited to the organizer.
`_door_write` catches nothing: a market that does not exist answers 404, an archived one or a person the row refuses 403 with its sentence, and one that cannot be read `Invalid market data`, 400, each raised by the change loader ([an exception never reaches a client](../conventions/an-exception-never-reaches-a-client.md)); a body that is not a JSON object is `A JSON object is required`, 400.
An organizer checking a vendor in on a past market date is not refused, and on one to come is (above).

**The roster stays fresh by itself** (T318).
It was read on load and after the organizer's own tap, so a vendor who scanned themselves in, or another organizer's check-in, showed only after this organizer's next tap or a reload, and "who is missing" was stale at exactly the moment it was asked.
Attendance reads its roster again every 15 seconds while the page is in view (`REREAD_MS`), and at once when the tab comes back into view or the browser comes back online; hidden, it reads nothing, and the clock never asks for a read while one is out.
A read that has not answered in `REREAD_MS` is given up (its own axios `timeout`, not the shared instance's) and fails as any read does, so a stalled request on the venue's wifi never stops the clock or holds Refresh disabled.
The roster is one keyed read, by the market open ([reads keyed by market](market-store.md#reads-keyed-by-market)): only the newest read's answer lands, so two reads answering out of order never show a vendor just checked in as not here, and a dropped answer changes nothing on screen, its error included.
Moved to another market, the page says "Loading…" at once, never the last market's roster, and nothing the last market's reads or writes answer lands on it.
A check-in or its undo is held on the market whose roster the row came from, and posts there only: no read asked before it lands, so none undoes it, and it shows on its row from the server's answer at once (`checkedInAt` from the answer, `checkedInBy` the signed-in address and `state` `here` at the row's own table, or all three cleared and `state` `expected`; an undone row with no seat goes), and a re-read follows.
Its refusal is said only on the market it was made on, so a refusal landing after the organizer moved says nothing on the market they moved to, and it is forgotten on moving, so coming back to that market never says it again; each row is held busy only while its own write is out, by its market, date and vendor, so taps on several rows all go through and a write still out on the last market holds no row of this one.
The toolbar ends with Refresh (`attendance-refresh`), [`ListFreshness`](../../../front-end/src/components/ListFreshness.vue) given `showTime` false; when the roster was last read, ageing on screen, stands over the list's right edge (`attendance-updated`), or under the map as the day map's note.
Its words age by [`useUpdatedWords`](../../../front-end/src/utils/useUpdatedWords.ts), a 10-second clock that says a read landing now as "Updated just now" at once, the composable `ListFreshness` reads too; the clock runs only for the scope that called it, a component's setup, and stops with it (T466).
A re-read or a Refresh that fails keeps the rows and says "Could not update. The roster is as it was last read." (`attendance-refresh-error`) in red under the toolbar's end, inside the pinned block, until a read lands; the page draws that line itself, as the last item of the toolbar's end, which wraps it under the groups and adds nothing to the end's width (`contain: inline-size`), so it never moves Print roster or Door code to a line of their own; a first read that fails is still the page that could not be read, with Try again.
The clock, a tab coming back and the browser coming back online read it again quietly, so that page stays, with its sentence, while their read is out; only Try again says "Loading…".
There is no offline copy and no queue of taps.
`AttendanceStatusView.test.ts` holds each of these, `theDoorReadsItsOwnMarket.test.ts` the move to another market while a read or a check-in is out, and [`the-door-stays-fresh.spec.ts`](../../../front-end/e2e/the-door-stays-fresh.spec.ts) a vendor's own check-in showing on the open roster once `page.clock` runs 15 seconds, and a re-read that fails.

**The roster prints whole** (T318).
Paper is the door's only fallback when the venue's network or the back end fails.
"Print roster" (`attendance-print`) stands in the toolbar after List and Map, before Door code where that is offered, for anyone who reads Attendance whenever the market has dates, in every phase the page opens in, and calls `window.print()`.
[`DoorRosterPrint.vue`](../../../front-end/src/components/DoorRosterPrint.vue), rendered by Attendance and hidden on screen, is what prints: the market's name, the chosen date in words, "<N> vendors" (the date's seats, as its tally counts them), "Printed <date> at <time>" (stamped again on the window's `beforeprint`, so a print from the browser's menu is current too), then a table of every row of the date in the roster's order, by table: Table, Vendor (the name, and the address under it; the address alone when there is no name) and Checked in (the row's status when checked in, else an empty box to tick; "Here" until T501); the date's `here_without_seat` rows print in a second table under "Checked in, with no table on this date (<n>)".
It takes the date's rows from the roster itself, not the rows on screen, so the filters and the search never leave a vendor off the paper; notes are not printed.
It is teleported to `body`, beside the app, and its print rules sit in its scoped block, as the door code's do (below); only the rule hiding the app is global, and it holds only while the door code's screen is not open, so that screen's poster still prints alone.
[The rail](market-guide.md) asks for it: "Print each day's roster, then check vendors in at the door."; the page has no note of its own (T466).
`aRosterPrintsWhole.test.ts` holds the sheet with a filter and a search on, `AttendanceStatusView.test.ts` the button and that no note shows, and [`the-roster-prints.spec.ts`](../../../front-end/e2e/the-roster-prints.spec.ts) the sheet under print emulation at 1440: the app hidden, every vendor of the day with a filter on, nothing past the page's width, and a Letter and an A4 PDF whose first page opens on the market's name (read by `e2e/helpers/pdfText.ts`).

**The page words each roster state** (T318).
`here` reads "Checked in <time>" in a positive chip; `here_elsewhere` reads "<status>, at table <checkedInTableCode>" in an attention chip, "Checked in 9:41 AM, at table North Wing 2", who made it on the plain line after it, since where they went is what the attention tone flags, so the organizer sends the vendor to their new table, "table <checkedInTableCode>" one run joined by no-break spaces, so neither the chip nor the printed column leaves the code's last word on a line alone; `here_without_seat` rows are listed after the date's seated rows under "Checked in, with no table on this date (<n>)" (`attendance-unseated-heading`), their table "No table", their chip the status in attention, with its "Undo?" for whoever may check in.
The date's tally, its "N of M checked in", and the filters count seated rows only, as the Stats tab does; a `here_without_seat` row shows under All and under Checked in or Checked out by its own check-out, never under Not checked in.
`AttendanceStatusView.test.ts` holds each, and Check in offered by date.

**The page offers Check in and Undo only in Market Days, to someone who may check vendors in, Check in only on today and past days, and a row offering neither ends at its status** (`door-row--read`).
At a desk each row's last column holds the action, one button wide: `door-action` draws "Check out", the wider label, unseen in the button's place and type, and the button fills that cell, so Check in and Check out are one width and a row with no button keeps the column, its chips ending where every row's do.
For someone offered no action the column is dropped, since the empty column left each status about 130px short of the row's edge (E38/F15/S04).
On a phone the row is one grid column: its first line (`door-top`) is a wrapping line of the vendor (`door-who`) and the action, and the table and the chips (`door-chips`) share a line of their own under it (`door-place`), the chips at its end or, when both do not fit, under the table: in the action's column a wide status ("9:44 AM by" an address) squeezed the vendor's line and broke their address mid-word.
A row's notes, where it has them, take a third line of their own (`door-notes`, `grid-row: 3`): a named notes area kept an empty track and its gap under every row without notes, so the row's space under its last line was twice its space above the vendor (T501).
For whoever may check vendors in, the chips stand one over the other there as at a desk, since side by side an "Undo?" between them read as the undo of either; for someone offered no action they stay side by side; a row with no button keeps no room for one on the vendor's line (`door-action:empty`).
The action stays on the vendor's line while the vendor's widest unbreakable piece fits beside it, and goes under the vendor, at the line's end, when it does not; for that the name and the address inside `door-who` break by `overflow-wrap: break-word`, the same last-resort break as `anywhere`, which does not count toward the vendor's narrowest width (T496).
So the vendor comes first in the row's markup, and at a desk `door-top` and `door-place` are `display: contents` and each cell is placed in its column, the table first.
Which of the two a row takes is the list's width, not the window's: a container query (`door-list`, below 64rem) gives a tablet's row the phone's layout, since at 768px the desk's four columns left the vendor a third of the row and broke their address inside its domain (T318).

**A row's action follows the vendor's day, and a checked-out row says so in a second chip** (T496).
A row ends in at most one button, and each undo is a quiet "Undo?" just left of the chip it undoes, so the page reads cleanly at the door.
For whoever may check vendors in, in Market Days:

- not checked in: "Check in" (`attendance-check-in`), on today and past days;
- checked in, not out: a primary "Check out" (`attendance-check-out`, named "Check out <who>"), and "Undo?" (`attendance-undo`, named "Undo <who>'s check-in") left of the status chip, on any date, as the server takes any date with a record;
- checked out: no button, and one "Undo?" (`attendance-undo-check-out`, named "Undo <who>'s check-out") left of the departure chip, none by the status, since the check-in's undo is refused until the check-out's is made.

Each chip stands on a line of its own (`door-line`), its "Undo?" before it in the chip's own line (`door-pill-line`): a `button` (`door-undo`) in the muted ink, underlined, with no box, its tap area `--target-min` tall and wide, which grows the chip's line to a thumb's 44px on a phone.
Each chip's words are two parts (`ChipWords`, T501): the state and when, in the chip, a one-line pill ("Checked in 9:41 AM", "Checked out 4:05 PM", "Scanned in at 9:41 AM"), and who made it, "by you" or "by <address>" (`door-chip-by`, `attendance-row-status-by` and `attendance-row-out-by`, the address drawn by `EmailAddress`), on a plain line after the chip, at `--text-xs` in `--mm-text-muted`, where an organizer made it.
At a desk who made it stands beside its chip, on the chip's line; on a phone it stands under the chip, ending where the chip ends, "by" held to the address by `white-space: nowrap` and the address breaking only before its "@" or a dot, since the page sets `white-space: normal` again on `EmailAddress`'s pieces, and it rises into the "Undo?"'s 44px line by that line's slack, so it stands as close under its chip as where no "Undo?" is beside it.
Two-line chips, the state on one line and "by" the address on the next, ran their words into the pill's rounded ends on a phone and stretched each chip across the row; Daniel chose the plain line (T501).
On a phone a chip too wide to share its line with its "Undo?", "Checked in" at a long table code on a narrow phone, keeps the row's width, and its "Undo?" goes under it, at the line's end (`flex-wrap: wrap-reverse`), who made it under both; while the row's write is out the "Undo?" loses its underline.
At a desk the chips' column is as wide as its widest line, so each is one line.

A checked-out row keeps its status chip and gains a neutral chip after it (`attendance-row-out`, `departure`): "Scanned out at <time>" for the vendor's own (`checkedOutVia: door_code`), "Checked out <time>" for an organizer's, "by you" or "by <address>" on its plain line (T501, was "Out <time>"); at a desk the two lines stand one over the other.
The printed roster's "Checked in" column keeps the time and who made it, "9:41 AM by you", since its header already says "Checked in" (`status`).
A check-out and its undo go through the page's one `write(row, what)`, which takes one of the door's four writes and holds and adopts it as a check-in's is (below): the row shows the server's answer at once, `checkedOutAt` from the answer, `checkedOutBy` the signed-in address and `checkedOutVia` null, or all three cleared, and a refusal says the server's sentence, else "That check-out was not recorded." or "That check-out was not undone.".
The map reads it (its `checkedOut` tone, above), and so do the list's filters (T501): "All N", "Not checked in N", "Checked in N" and "Checked out N" (`Show`, `attendance-show-all`, `-not-checked-in`, `-checked-in`, `-checked-out`), the last three apart, checked in meaning checked in and not out (`showsUnder`); the summary, the search, each row's status and the printed roster do not, so "N of M checked in" counts every check-in of the day, checked out or not, as the Stats tab does.
A filter or a search that leaves no row says "Nobody matches."; "Nobody is assigned on this date." stands for a date with no seats and no check-in.
`theDoorChecksAVendorOut.test.ts` holds each row state's button, each "Undo?" on its chip's line, and their names, the chips' wordings, each chip's state and time alone in it and who made it on the line after it, the write's answer, each refusal, a Viewer and an archived market offered nothing, the address's halves on that line, "Not checked in" on a day to come, today, a day over and an archived market, the four filters' counts and rows, each vendor under one of the last three, and the count, the search, the statuses, the rows the map is given and the printed roster equal with and without check-outs; [`the-door-checks-a-vendor-out.spec.ts`](../../../front-end/e2e/the-door-checks-a-vendor-out.spec.ts) walks it at 390 under a phone's emulation and at 1440: a check-in, each "Undo?" left of its chip, a check-out, a reload, a seatless vendor's check-out, a long address, the undo, then the history's sentences in Manage market.
[`the-door-reads-one-set-of-words.spec.ts`](../../../front-end/e2e/the-door-reads-one-set-of-words.spec.ts) walks a market of a day over, today and a day to come at 390 under a phone's emulation and at 1440: on each day the bar, the four filters and the rows each lists, "Not checked in", and none of "Here", "Expected", "Not yet" or "Did not come" in the page's text, each text node read on its own, its printed sheet and its map view included, though the market lays out no location, so its map view draws no legend: the legend's words are [`the-door-as-a-map.spec.ts`](../../../front-end/e2e/the-door-as-a-map.spec.ts)'s on today and `theDoorAsAMap.test.ts`'s on every day; on a day begun, a vendor checked in and out by an organizer with a long address, each chip a one-line pill inside the row, the check-out's at `--text-xs` in `--mm-black` on `--mm-beige`, and who made it after it at `--text-xs` in `--mm-text-muted`, under the chip and ending where it ends on a phone, beside it at a desk, its address breaking only before its "@" or a dot; and the layout sweep's gating findings, none.
A vendor's name and address are drawn by `VendorIdentity`, whose address breaks only before its "@" or a dot (`EmailAddress`); drawn as plain text, it broke after a hyphen on a phone.
[`a-viewer-at-the-door-reads-why.spec.ts`](../../../front-end/e2e/a-viewer-at-the-door-reads-why.spec.ts) holds both widths for a Viewer and an Editor, every address on one line, and for an Editor at most one button a row, Check in and Check out one width, each "Undo?" left of its chip, and every row's chips, or who made them, ending at one edge, and for the owner, reading the Editor's check-in and check-out, each chip, who made it and "Undo?" inside the row.
[`the-door-at-three-widths.spec.ts`](../../../front-end/e2e/the-door-at-three-widths.spec.ts) walks the door at 390x844 under a phone's emulation, at 768x1024 as a tablet and at 1440x900: a check-in, a check-out and the undo of each, the freshness line and Refresh, Print roster and no note, a vendor here at another table and one here with no table, each row inside the window with its address whole, the row layout each width takes, and the layout sweep's gating findings, the phone's 44px targets among them.

**An archived market that ran is still served, as a record** ([an archived market that ran stays a record](../../business/rules/an-archived-market-that-ran-stays-a-record.md)).
Its vendor page's read says it has `ended` (`ended_after_it_ran`), and each vendor's own read carries their seats and when they checked in, so the page shows the record and takes no check-in; a check-in there answers 409 with "This market has ended, so check-in is closed.".
Check-in is open to every market that runs, whatever its intake mode: how a vendor entered has no bearing on whether they can check in on the day ([intake mode decides how vendors arrive](../../business/rules/intake-mode-decides-how-vendors-arrive.md)); applying is a lookup of its own ([a gated market answers as absent](../../business/rules/a-gated-market-answers-as-absent.md)).

**The door works on a phone, as do the organizer screens it leads to.**
The product is built for a laptop, and an organizer market screen need not work below a laptop's width unless [the design language](../../design-system.md#layout) lists it as fitting a phone; the door is one carve-out, the one someone may hold in their hand, and the Tools tab another, since an organizer may connect Discord from a phone (Daniel, T113).
The account pages on the way in fit a phone too ([the design language](../../design-system.md#layout)).
The vendor page, where vendors check in, is not an organizer screen at all, so the organizer screens' widths never apply to it.
A route with `meta: { fitsAPhone: true }`, or a page its `meta.fitsAPhone` lists on a route that is several pages ([the market frame](market-frame.md#sharp-edges)), lifts the app's 1000px desktop floor ([`fitsAPhone`](../../../front-end/src/utils/fitsAPhone.ts), read by [`App.vue`](../../../front-end/src/App.vue)), as every public page does, and gives the market frame the phone's 16px gutter ([the market frame](market-frame.md#sharp-edges)); at 640px and below the rail's spine scrolls sideways inside itself, and below about a 990px window the market bar's tabs do ([the market frame](market-frame.md)).
Of the organizer market screens Attendance has it, because the door is sometimes a person standing up, and so does each place the door's journey reaches; [the design language](../../design-system.md#layout) lists every place that has it, one a line.
So the door's journey fits a phone from end to end: `/markets`, the door, a check-in, each of the vendor drawer's tabs, and "Change assignment" to the Assignments page and its change-placement dialog.
[`the-door-on-a-phone.spec.ts`](../../../front-end/e2e/the-door-on-a-phone.spec.ts) walks it at 390x844 under a phone's own emulation (touch, device scaling), and at 1440x900, where the bar and the whole rail stay pinned.
At that width only the app bar and the market bar stay pinned, 138px of an 844px window, and the rail scrolls away with the page ([the market frame](market-frame.md)); the rail is laid out for a phone, its addresses named as chips and its actions wrapping beside them, so on a form market in market days the door starts within the top 340px of 844 on first paint rather than at 409px, which `phase-rail.spec.ts` holds it to ([the phase rail](phase-rail.md)).
At that width the door's gutter narrows to `--space-4` and stays on both sides; at 0 its rows ran to the card's edges (T15).
Every target the door's organizer and its vendors tap there is 44px, through the design language's [target tokens](../../design-system.md#the-primitive-layer); the layout sweep walks the attendance, the app bar's sheet, the vendor drawer on each of its tabs, rail menu and archive confirmation, and the vendor page on a market day, checked in, checked out, checked in at the door with the switch off and as the record, at 390px, and fails on a target under 44px (T82).
A roster that could not be read says which kind of failure it was, with a Try again, 44px on a phone, that reads it once more, apart from a check-in or undo the server did not record ([what the organizer reads](../conventions/an-exception-never-reaches-a-client.md#what-the-organizer-reads)).

**The door code is the market's, one at a time, and no market read serves it** ([ADR 0022](../../adr/0022-the-vendor-page-is-signed-in.md)).
It is stored on the market document as `doorCode`, `{code, madeAt, madeBy}`, and `api/door.py` serves it on its own endpoints, to whoever may check vendors in: a Viewer who read it could check vendors in by proxy.
So `leave_out_what_no_read_serves` in [`back-end/market_documents.py`](../../../back-end/market_documents.py) takes it off the market read and every Markets list entry.
A code is 6 characters of `23456789ABCDEFGHJKLMNPQRSTUVWXYZ` (no 0, O, 1 or I), each drawn by `secrets`.
Making one loads through the change loader, answers 409 outside `market_days`, and writes through [the market write](market-write.md), holding the phase it was loaded in, so a market archived since it was loaded is not changed and the request answers the one 409 with [its sentence](market-write.md#what-it-answers); a new code replaces the old at once, so every poster of the old one stops working.
It records `door_code_made` through the loader's Check vendors in asking, with the organizer as the actor and `replaced` in its detail, never the code.
Its `url`, the address the QR code opens, is the vendor page with the code, `<FRONTEND_URL>/<slug>/vendor?door=<code>` (`door_url`, the slug and the code each quoted).

**Attendance offers "Door code" in Market Days to whoever may check vendors in** (`offersDoorCode` in [`doorCode.ts`](../../../front-end/src/utils/doorCode.ts)), and it opens [`DoorCodeScreen.vue`](../../../front-end/src/components/DoorCodeScreen.vue) over the whole window: the market's name, the QR code, the code in two groups of three ("K7M 4QP"), "Scan with your phone's camera to check in or out", and who made it and when.
It is a modal, not an `AppDialog`, which is a small window: it holds the page behind inert, takes Escape while on top and gives focus back to "Door code", as [every modal](../conventions/dialogs.md) does, and its one confirmation, "Make a new door code?", is an `AppDialog` teleported beside it that opens on Cancel.
Nothing closes the confirmation while the new code is being made, and a second press makes none; each opening starts with no refusal said (T411).
The QR code is encoded by the `qrcode` package and drawn by the app as one SVG path (`qrDrawing` in [`qrDrawing.ts`](../../../front-end/src/utils/qrDrawing.ts), with the standard's four-module quiet zone, kept out of `doorCode.ts` so the vendor page, which reads and types the code with `normalizedDoorCode` and `DOOR_CODE_LENGTH` there, never loads the encoder), so no markup from the package reaches the page; `theDoorCode.test.ts` decodes the drawn path with `jsqr` back to the `url`.
The package loads only with Attendance's chunk, never the entry's ([the bundle budget](../testing/ci-and-the-gate.md#the-bundle-budget)).
The QR code's box is a square the window's width that gives up height where the rest needs it, and the typed code is the scale's display figure, `--text-2xl`.
"Print" prints the same poster on one page: the print rules sit in the component's scoped block, since unscoped ones lost to the scoped screen rules and the poster printed as the fixed screen; only the rule that hides the app, a sibling of the screen under `body`, is global.
[`the-door-code.spec.ts`](../../../front-end/e2e/the-door-code.spec.ts) holds the journey, the fit at 390 and 1280, a 14cm QR code on one Letter and one A4 page, a short window where the screen scrolls in a `ScrollBox` from its controls down and prints whole with no shade, and a Viewer offered nothing and refused the code; the layout sweep walks it before a code, full screen and at its confirmation.

**The self check-in switch stands on the door code's screen, and while it is off the screen shows no code** (T496).
Under the controls row, never printed (`.door-code-self` is in the print block's hidden list), a checkbox with `role="switch"` (`door-code-self-switch`) labelled "Vendors check themselves in and out", marked up as the public map card's switch is, with the help line "While this is off, only organizers check vendors in and out, on Attendance."; it is drawn only once the door code is read, so a failed read shows no switch.
Off, the poster's place holds the market's name and "Vendors' own check-in and check-out are off. Turn them on to show the door code." (`door-code-off`), and Print, New code, Make a door code, the QR code, the code and who made it are not rendered, a stored code included; turned on, the screen is as above.
`setSelfCheckIn` in `doorCode.ts` writes the `PUT` and answers the door code's shape, which the screen adopts whole.
While its write is out the switch is disabled and shows what was clicked, and the screen under it stays as stored; after the answer the box is set to the served state by hand, since Vue leaves `checked` alone where the stored value did not change, and the switch takes focus back, which a disabled input loses, unless focus has moved to another control.
A refused write says the server's sentence, else "That was not saved.", in the screen's one error line, which the first code's failure shares and a new turn of the switch clears.
"Door code" is offered as before (`offersDoorCode` does not read the switch), so the switch is always reachable in Market Days.
`theDoorCode.test.ts` holds the switch's name, role and help, off with a code and with none, the write held with focus kept, a refusal and the fallback; `the-door-code.spec.ts` walks a market never set, off with no code, turned on by the keyboard, a code made, off, reopened still off and on again with the same code, at 390 and 1280, with the switch off the printed poster; the layout sweep walks the screen with vendors not checking themselves in.

**Each check-in and its undo records into [the market's history](../data/history.md)** (`checked_in`, `check_in_undone`, under `check-in`) in `record_attendance` and `undo_attendance`, through the recorder each door passes, so both doors record alike, and only when whether the vendor is here changed: the organizer is the actor at theirs, and the vendor's own records no actor beside the vendor it names, with `via: door_code` for a check-in and `via: vendor_page` for an undo; an entry from the old public page keeps `via: check_in_page`, and its readers word all three.
A check-out and its undo record the same way (`checked_out`, `check_out_undone`, T496), through `_record_door` given the detail's key, `checked_out` in place of `checked_in`, and the switch records `self_check_in_set` with the organizer as the actor.

## Why

The page an organizer works from at the door, and the record a market leaves behind.
The phase record that says whether a market ran is `back-end/phase_record.py`; the date "today" is the viewer's own (`calendarToday` in [the market guide](market-guide.md)).
Publishing, the door code, the vendor's check-in and check-out on their vendor page and Attendance, as the people at the door use them, are [the door on market day](../../business/flows/market-day-door.md).
Directing a vendor from Attendance's map is [K9 of the market's map](../../business/flows/the-markets-map.md#k9-an-organizer-directs-a-vendor-from-attendances-map).

The glossary concept it serves: [Placement and pin](../../business/concepts/placement-and-pin.md).
