---
layer: business
kind: flow
describes:
  - front-end/src/components/market/MarketPublicMapCard.vue
  - front-end/src/views/PublicMapView.vue
  - front-end/src/components/attendance/AttendanceMap.vue
verified: 2026-11-17
sources:
  - T422
  - T466
---

# The market's map: published, found and directed by

**Who:** the market's Admin or owner publishes the map; a visitor, with no account, finds a vendor on it; an organizer at the door directs a vendor by Attendance's map.
**Where they start:** the Admin on the market's Tools tab; the visitor at the map's address, `/<market-slug>/map`, from a link or a printed QR code; the organizer on the Attendance tab.
**Serves:** [The door on market day](../intents/the-door-on-market-day.md).

A location's layout ([E6](planning.md#e6-a-locations-layout)) is each market day's map in two places: a public page anyone opens, and Attendance's map beside its list.
Both draw each table by who holds it that day, a shared table as two halves, each its own vendor's.
A layout can be made after Draft too, following the plan's settled seats, so a market planned without one can still have a map ([ADR 0034](../../adr/0034-a-layout-started-after-draft-follows-the-plan.md)).
The public map shows a vendor's public name, website and Instagram, read from the questions the Admin chose and cleaned on the server, and nothing else of them: never an email address or a full name ([ADR 0035](../../adr/0035-the-public-map-publishes-a-vendors-chosen-answers.md)).
How it is built is [the public map](../../implementation/modules/public-map.md), [the public map page](../../implementation/modules/public-map-page.md) and [attendance and the door](../../implementation/modules/attendance-and-door.md).

## K7. An Admin opens the public map

**Status:** Works (read from the code as of T422; walked whole, from a market past Draft with no layout to a visitor reading a vendor, by `a-market-past-draft-gets-a-public-map.spec.ts`).
**Task:** "Let visitors find each vendor's table on the day."

1. Tools tab, the "Public map" card ([`MarketPublicMapCard.vue`](../../../front-end/src/components/market/MarketPublicMapCard.vue)), after Discord's: "A page anyone can open, with no sign-in, that shows each market day's tables and who is at them. It shows only the answers you choose here, never an email address or a full name.", with the switch "Show the public map" off.
2. "Public name": choose the form's short text question that holds each vendor's business or artist name; "Website" and "Instagram" are chosen the same way, or left at "Not shown".
   Each choice saves at once; until a public name is chosen the switch is disabled, with "Choose the public name's question first." under it.
3. Turn on "Show the public map".
   Expect the address, `/<market-slug>/map` under the app's origin, with "Copy link" and "Open the map", which opens it in a new tab.
4. Until the map can open, the card says the first thing it still lacks: "Lay out a location first: the map draws the market's layouts." with "Open the layout", then "The map opens once results are published."; on an archived market "An archived market's map is closed.".
   Meanwhile its address answers as an address that names no market, so seats are never public before vendors are told them.

The switch and the three questions are the "Publish the map" row's, an Admin's by default ([what each role may do](../rules/what-each-role-may-do.md)); an Editor or a Viewer reads the card with its controls disabled and the row's sentence.
The market's history reads each change in words, "turned the public map on" or "set the public map's name to “Business name”" ([L6](reading-the-markets-history.md)).
Covered by:

- `a-market-past-draft-gets-a-public-map.spec.ts`
- `the-public-map-card.spec.ts`

## K8. A visitor finds a vendor

**Status:** Works (read from the code as of T422, `the-public-map.spec.ts`).
**Task (visitor):** "You are at the market. Find the ceramics stall."

1. Open the map's address ([`PublicMapView.vue`](../../../front-end/src/views/PublicMapView.vue)); it opens on today when today is a market date, else the next, else the last.
   Expect the market's name with "Map" under it, the day buttons in words ("Wed 18 Nov"), the open one pressed, a switch of the locations when the market has two or more, and the map: each table taken filled, each free one a grey dashed outline, as the legend "Taken" and "Free" says.
2. "Find a vendor", over the day's vendors by name, each "<name>" with "Table <code>, <location>" under it: type part of the name and press the vendor.
   Expect the map to open their location, outline their table and come into view, and the card to read "Table <code>", their public name, and "Website" and "Instagram" as links that open in a new tab.
3. Or press a table on the map: the card reads who is at it, "This table is free on Wed 18 Nov." with nobody, or "A vendor is at this table. Their details are not listed." for a vendor who gave no public name.
   A shared table's halves are pressed apart, and its card lists "Left half" then "Right half".
4. On a phone, pinch and drag the map; at a desk, "Zoom in", "Zoom out" and "Fit" on the map's corner, or Ctrl and the wheel, and a drag once zoomed.

The address keeps the day, the location and the table, so a link opens one vendor's table on one day; a value it does not know falls back to the opening day or the first location.
It works signed out, on a phone and at a desk, with the logo alone in the app bar, as the vendor page shows it.
Covered by:

- `the-public-map.spec.ts`

## K9. An organizer directs a vendor from Attendance's map

**Status:** Works (read from the code as of T422, `the-door-as-a-map.spec.ts`).
**Task:** "A vendor at the door asks where their table is."

1. Attendance, the open day, "Map" beside "List" ([`AttendanceMap.vue`](../../../front-end/src/components/attendance/AttendanceMap.vue)) ([K5](market-day-door.md#k5-watch-attendance), step 9).
2. "Find a vendor" ("Name, email or table"): type part of their name (the one they go by or the full one), address or table, and pick them from the dropdown, each row saying where they sit ("Table Aisle A 3, left half", or "No table"), with the mouse or with the arrow keys and Enter.
   Expect their [drawer](vendor-drawer.md) open on its Application tab, as a press on their table or their name on the list opens it, and their table outlined on the map, drawn filled once they are here and outlined while they are expected; a vendor sitting in the other location switches the map to it, and Back closes the drawer there.
   Typing alone outlines nothing, and closing the drawer clears the outline (T466).
3. Point them to it; or press their table, or their half of a shared one, to open their drawer, as their name on the list does.
4. Check them in on "List" or have them scan the door code ([K2](market-day-door.md#k2-a-vendor-scans-the-door-code-and-is-checked-in)): the map checks nobody in, and their table is drawn filled on the roster's next read.

A press on a table with nobody says "Table <code>: no vendor on <date>." under the map; vendors here with no table, and those at tables on no layout, are counted under it with "Show in the list".
The legend under the map reads "Here" and "Expected" ("Did not come" once the day is over), and "No vendor" only on a day the open location's map draws a table, or a half of a shared one, nobody sits at; the no-table zones, the stage or the entrance, are still drawn and named on the map, with no legend item (T466).
Covered by:

- `a-market-past-draft-gets-a-public-map.spec.ts`
- `the-door-as-a-map.spec.ts`

## The rules it obeys

- [A gated market answers as absent](../rules/a-gated-market-answers-as-absent.md): a map that is not open reads as no market.
- [What each role may do](../rules/what-each-role-may-do.md): publishing the map is an Admin's, the door an Editor's.
- [An archived market is read-only](../rules/an-archived-market-is-read-only.md): an archived market's map is closed, its switch no longer changes.

Its gaps worth a spec are in [walking the flows](../../implementation/testing/walking-the-flows.md#coverage-map).
