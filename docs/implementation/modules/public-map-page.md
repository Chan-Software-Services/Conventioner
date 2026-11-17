---
layer: implementation
kind: module
describes:
  - front-end/src/views/PublicMapView.vue
  - front-end/src/utils/publicMap.ts
  - front-end/src/__tests__/thePublicMapPage.test.ts
  - front-end/e2e/the-public-map.spec.ts
  - front-end/e2e/pages/PublicMapPage.ts
verified: 2026-11-18
sources:
  - T422
  - T469
---

# The public map page

A market's public map is a page anyone opens with no sign-in, at the market's own address, `/<market-slug>`, where the market page shows it while it is open, to find a vendor's table on a market day ([ADR 0035](../../adr/0035-the-public-map-publishes-a-vendors-chosen-answers.md), [ADR 0039](../../adr/0039-a-markets-address-is-its-public-page.md)); `/<market-slug>/map` lands there with its query.
[`PublicMapView.vue`](../../../front-end/src/views/PublicMapView.vue) draws it from [the public map's read](public-map.md), with the day map that Attendance draws too ([the component library](component-library.md) has its entry); [`utils/publicMap.ts`](../../../front-end/src/utils/publicMap.ts) holds its two reads and what it makes of the answer, pure but for the reads.

## The route

**The market page, `/:marketSlug`, renders `PublicMapView` as its whole output while the vendor page's read says `mapOpen`**, keyed by the slug; that route is `public` and `vendorFacing` ([every market page has an address](../conventions/every-market-page-has-an-address.md)).
As a public page it fits a phone, and as a vendor-facing one the bar shows the logo and the market page's "Vendor sign-in" alone, to an organizer too ([the app bar](app-bar.md)).
A 404 from the read, which the server answers alike for a slug naming no market and for a market whose map is not open, shows the app's "Page not found", and the page tells the bar its slug answered absent (`vendorPageAnswered`), as the vendor page does, so an organizer keeps the full bar there.
A read that never answered says "The map could not be loaded." with "Try again"; the bar stands apart meanwhile.
The browser's title is "<Market name> map" while the page is open, and is given back as it goes.
The app's one `RouterView` is unkeyed, so a move in the app from one market's map to another's keeps the page: it reads the new market's map afresh, a read that answers after the address moved on is dropped, and a move off the page reads nothing.

**The day, the open location and the picked table live in the query**, `date`, `location` and `table`, each written with `router.replace`, so a link or a QR code opens one table on one day, and Back leaves the page (D31).
`mapPlace` reads them: the date asked for when it is a market date, else today, else the next, else the last (`openingDate`, as Attendance chooses its day); the location asked for, else the asked table's own, else the first; and the table only when it is on the open location.
A value it does not know falls back without an error.
A change of day keeps the location and the table, so a table's card then reads that day; a change of location drops a table that is not there.
The find field's words are in the query too, as `find`, as every list frame's on a page.

## The page

**Top to bottom: the market's name as the heading with "Map" under it, the day buttons in words ("Wed 18 Nov", `dayInWords`), the open one pressed, the day map, the card, and "Find a vendor" over the day's vendors.**
The day map draws the location switch, the drawing in `read` with the day's seats (`publicSeats`, every seat filled), Zoom out, Zoom in and Fit, and the legend "Taken" and "Free"; its pick writes the table to the address, and the picked table is outlined.
At 1,000px and wider the map takes the left of a two-column frame no wider than `--workspace-max`, sticky under the app bar beside a long list, and the card and the list a 22rem column on the right; narrower, they stack in that order, on the page's 16px gutter.

**The floorplan image is read through the API client as bytes** (`fetchPublicMapImage`) and drawn from an object URL, since the API is another origin in production and the Content-Security-Policy draws images only from the app and from blobs ([security invariants](../conventions/security-invariants.md#security-headers)).
It is read as each location opens, once while it is read well, and every URL is revoked as the page goes or moves to another market's map; a failed read draws the hall on the floor's colour alone and is read again the next time its location opens.

**The card** (`tableCard`) heads "Table <code>"; a seat with a name reads the name, then "Website", a link whose text is the address's host, and "Instagram", a link "@handle" to `https://www.instagram.com/<handle>/`, each left out when null; a seat with no name reads "A vendor is at this table. Their details are not listed." (D27), whatever else they answered; a free table "This table is free on <day>."; a shared table lists "Left half" then "Right half", whichever half was pressed, a half with nobody "This half is free on <day>."; and before a pick "Press a table, or find a vendor below.".

**The list** (`mapListing`) is the open day's seats with a name, at every location, by name, in [the list frame](component-library.md) with its find field from the first row (`findFrom` 0), narrowing by name as typed, Enter doing nothing, its count line "<n> vendors", and "No vendors are listed for this day yet." with none.
Each row is a button, "<name>" over "Table <code>, <location>"; a press opens the vendor's location, picks their table and brings the map into view, and the picked table's rows are edged in black, as the map's mark.

## Sharp edges

**Nothing a vendor typed becomes markup or a link of its own**: the three answers come cleaned by the server, are drawn as text, and a link is built here again only from an `http` or `https` address with a host (`websiteLink`) or a handle of 1 to 30 letters, digits, dots and underscores (`instagramLink`), so a value the server let through by mistake still never becomes a `javascript:` link.
Every link opens in a new tab with `rel="noopener noreferrer"`.

**A table's id names it across the market**, so the address's `table` and a seat's `tableId` need no location; the seed gives each hall's tables their own prefix, since the server keeps ids unique only within one layout.

## Tests

- [`thePublicMapPage.test.ts`](../../../front-end/src/__tests__/thePublicMapPage.test.ts): the opening day, the place an address names and its fallbacks, the day in words, both links and what they refuse, the list's order, the card of each kind of table; the page mounted on a mocked read: "Page not found" and the bar's fallback, a failed read and Try again, the order of its parts, the title, the image read as a blob, each card, a hostile name drawn as text, each change written with `replace`, the list narrowing and opening a vendor.
- [`the-public-map.spec.ts`](../../../front-end/e2e/the-public-map.spec.ts), on a phone and at a desk, signed out on [the seeded market day](../testing/e2e-seeds.md): the allowlist on the page (every table and half of both halls on both days pressed, and the page's text and every link's address holding no email address and none of the seed's personal markers, every request to the two public routes or the app's own files), a press on a table, each half of the shared table, the search, a change of day and of location, a deep link and its fallback, a market with its map off reading exactly as an unknown slug, an organizer's bar, the columns at a desk, and a pinch on a phone that zooms the map and never the page.
  [`PublicMapPage.ts`](../../../front-end/e2e/pages/PublicMapPage.ts) is its page object; the map's tables are found by their accessible names, as a layout's are ([E2E patterns](../testing/e2e-patterns.md)).

## Why

- [ADR 0035](../../adr/0035-the-public-map-publishes-a-vendors-chosen-answers.md): the map publishes only the answers the organizer chose, cleaned.
- [A gated market answers as absent](../../business/rules/a-gated-market-answers-as-absent.md): a closed map reads as no market.
- [The market's map](../../business/flows/the-markets-map.md): how a visitor finds a vendor on it (K8).
