---
layer: implementation
kind: module
describes:
  - front-end/src/views/PublicMapView.vue
  - front-end/src/utils/publicMap.ts
  - front-end/src/__tests__/thePublicMapPage.test.ts
  - front-end/e2e/the-public-map.spec.ts
  - front-end/e2e/pages/PublicMapPage.ts
  - front-end/src/components/publicmap/
  - front-end/src/utils/useFillsTheWindow.ts
  - front-end/src/components/icons/IconSparkle.vue
  - front-end/src/__tests__/thePublicMapTableCard.test.ts
  - front-end/src/__tests__/thePublicMapBubble.test.ts
  - front-end/src/__tests__/thePublicMapVendors.test.ts
  - front-end/src/__tests__/bubblePlacement.test.ts
  - front-end/src/__tests__/publicMapBackdrop.test.ts
  - front-end/src/__tests__/publicMapPaint.test.ts
  - front-end/src/__tests__/publicMapSearch.test.ts
  - front-end/src/__tests__/useFillsTheWindow.test.ts
  - front-end/src/__tests__/support/publicMapAnswer.ts
  - front-end/e2e/the-public-map-backdrop.spec.ts
  - front-end/e2e/the-public-map-bubble.spec.ts
  - front-end/e2e/the-public-map-half.spec.ts
  - front-end/e2e/the-public-map-phone-card.spec.ts
  - front-end/e2e/the-public-map-vendors.spec.ts
verified: 2026-11-18
sources:
  - T422
  - T469
  - T465
---

# The public map page

A market's public map is a page anyone opens with no sign-in, at the market's own address, `/<market-slug>`, where the market page shows it while it is open, to find a vendor's table on a market day ([ADR 0035](../../adr/0035-the-public-map-publishes-a-vendors-chosen-answers.md), [ADR 0039](../../adr/0039-a-markets-address-is-its-public-page.md)); `/<market-slug>/map` lands there with its query.
[`PublicMapView.vue`](../../../front-end/src/views/PublicMapView.vue) draws it from [the public map's read](public-map.md), with the day map that Attendance draws too ([the component library](component-library.md) has its entry); [`utils/publicMap.ts`](../../../front-end/src/utils/publicMap.ts) holds its two reads and what it makes of the answer, pure but for the reads.
The page keeps the reads, the address, the title, the images and the state, and composes the parts in [`components/publicmap/`](../../../front-end/src/components/publicmap/), each with props of its own (T465).

## The route

**The market page, `/:marketSlug`, renders `PublicMapView` as its whole output while the vendor page's read says `mapOpen`**, keyed by the slug; that route is `public` and `vendorFacing` ([every market page has an address](../conventions/every-market-page-has-an-address.md)).
As a public page it fits a phone, and as a vendor-facing one the bar shows the logo and the market page's "Vendor sign-in" alone, to an organizer too ([the app bar](app-bar.md)).
A 404 from the read, which the server answers alike for a slug naming no market and for a market whose map is not open, shows the app's "Page not found", and the page tells the bar its slug answered absent (`vendorPageAnswered`), as the vendor page does, so an organizer keeps the full bar there.
A read that never answered says "The map could not be loaded." with "Try again"; the bar stands apart meanwhile.
The browser's title is "<Market name> map" while the page is open, and is given back as it goes.
The market page keys it by the slug, and reads a market afresh in "Loading…" before choosing its map, so a move in the app from one market's map to another's mounts a new page that reads its own; the page reads its market once, again only on Try again, keeps only its latest read, and drops one that answers after it has gone.
`/<market-slug>/map` is a redirect to the market page with the query and the hash, so a link made to the map's old address opens the same day, location, table and half; only the redirect's own tests open it.

**The day, the open location, the picked table and the half picked live in the query**, `date`, `location`, `table` and `half`, each written with `router.replace`, so a link or a QR code opens one table, or one vendor's half of a shared one, on one day, and Back leaves the page (D31).
`mapPlace` reads them: the date asked for when it is a market date, else today, else the next, else the last (`openingDate`, as Attendance chooses its day); the location asked for, else the asked table's own, else the first; the table only when it is on the open location; and the half only when it is exactly `left` or `right` beside such a table.
A value it does not know falls back without an error: `half=middle`, or a half with no table, reads as no half.
`goTo` writes the half only beside a table, so dropping the table drops the half with it.
A change of day keeps the location, the table and the half, so a table's card then reads that day; a change of location drops a table that is not there.
`shownParts` narrows the card to the half named when the table is split on the open day, and leaves it whole otherwise, so a half the table is not split into that day, an old link's, shows the whole table.

## The page

**One sheet fills the window under the app bar, and the page never scrolls.**
The page's column is `calc(100dvh - var(--banner-h))` tall, `overflow: hidden`, no wider than `--workspace-max`, while it loads, after a failed read and once the map is drawn.
While it is mounted `useFillsTheWindow` ([`useFillsTheWindow.ts`](../../../front-end/src/utils/useFillsTheWindow.ts)) puts `fills-the-window` on `<html>`, counting the pages that hold it, and `base.css` then gives the window no scroll bar gutter and gives `body` and `.app-container` a `min-height` of `100dvh` in place of every other page's `100vh`, which a phone's browser measures with its bars hidden, so the document would scroll by the bars' height.
The sheet is a grid on a white ground with `--radius-sheet` corners and `--shadow-float`: at 1,000px and wider the map side left of a 21rem vendor panel, narrower the map over the panel, three to two.

**The backdrop is the market's own section colours** ([`PublicMapBackdrop.vue`](../../../front-end/src/components/publicmap/PublicMapBackdrop.vue), [`publicMapBackdrop.ts`](../../../front-end/src/components/publicmap/publicMapBackdrop.ts)): a fixed `svg` larger than the window on every side, blurred 80px and taking no press, paints the `--mm-paper` paper, then four wavy ribbons.
`sectionColours` gives each section with a table drawn, hall by hall, `color-mix(in oklch, <edge> 12%, <fill>)`, each distinct value once, and `dealtShapes` deals them: one to four colours each take a run of the ribbons (one washes all four, two split them top and bottom), and each colour past four gets a lump of its own, so every colour is drawn at least once; none leaves the paper alone.

**The map side holds a title bar over the hall.**
The bar is a grid, the market's name and "vendor map" in the start column and the selects in the end one, so a long name wraps short of them; at 640px and under the selects take a row over the title, which stays first in the markup so a screen reader meets the heading first.
The name is an `h1` in Outfit at 600, `--text-2xl` (`--text-xl` at 640px and under), over a honey marker stroke drawn as a thick underline so it follows each line; "Vendor map" is in Merge One, lower case, led by the green sparkle of [`IconSparkle.vue`](../../../front-end/src/components/icons/IconSparkle.vue).
The day is a native select named "Market day", each option `shortDay` ("Nov 18"), and the hall a select named "Location", drawn only for two locations or more; each is a white pill `--control-height` tall with `--shadow-float`, 12px from the side's top and end edges.
The hall takes the rest: `DayMap` with `fills` ([the day map](floorplan-placement.md#the-day-map)), so it draws no switch and no legend of its own, its zoom a pill, and the page's legend in its `legend` slot.
Its pick writes the table, and the half pressed when a seated half was ([below](#a-half-picked-alone)).

**The legend names the open hall's sections** ([`PublicMapLegend.vue`](../../../front-end/src/components/publicmap/PublicMapLegend.vue), `hallLegend` in [`publicMapPaint.ts`](../../../front-end/src/components/publicmap/publicMapPaint.ts)): one item for each section with a table drawn, in the plan's order and the section's colours, read "Section A" for a name of three characters or fewer and the name as it is otherwise (`sectionLabel`), then "Free table", dashed, only on a day the open hall draws a free table or a free half.
No item is made for a no-table zone, while the zones and their labels stay drawn on the map to orient by (Daniel's Q3); "Taken" and "Free" are gone.
It is a white pill named "Legend" over the hall's bottom-left corner, and in a box under 30rem a row under the hall beside the zoom, their feet on one line, its spacing tighter there so two short section names keep one line at 390px.
Longer or more names wrap it upward, the zoom unmoved, so its corners there are the bubble's 18px, and each swatch, one line tall, stands beside its label's first line.
`tablePaints` gives every table in a section its `{ fill, edge }`, which the card's and the rows' code pills read.

**The floorplan image is read through the API client as bytes** (`fetchPublicMapImage`) and drawn from an object URL, since the API is another origin in production and the Content-Security-Policy draws images only from the app and from blobs ([security invariants](../conventions/security-invariants.md#security-headers)).
It is read as each location opens, once while it is read well, and every URL is revoked as the page goes; a failed read draws the hall on the floor's colour alone and is read again the next time its location opens.

## The card of the table picked

**The card** ([`PublicMapTableCard.vue`](../../../front-end/src/components/publicmap/PublicMapTableCard.vue), from `tableCard`) is a region named by its heading, "Table <code>" to a reader, the code alone shown in a pill of its section's colours, then the hall's name and a Close button.
Each part, the whole table or a half under "Left half" or "Right half", reads the vendor's public name in Merge One, then their website, a pill link whose text is the address's host, and their Instagram, a pill link "@handle" to `https://www.instagram.com/<handle>/`, each left out when null, their kind ("Website", "Instagram") said to a reader alone; a seat with no name reads "A vendor is at this table. Their details are not listed." (D27), whatever else they answered; a free table "This table is free on <day>."; a free half "This half is free on <day>.".
No card shows before a pick.
It is no dialog: it holds nothing modal and traps no focus, and a live region round it announces each pick.

**At 1,000px and wider it speaks from its table in a bubble** ([`PublicMapBubble.vue`](../../../front-end/src/components/publicmap/PublicMapBubble.vue)), which `useWideSheet` ([`useWideSheet.ts`](../../../front-end/src/components/publicmap/useWideSheet.ts)) tells by `matchMedia('(width >= 1000px)')`, a window with none answering wide; one card is ever in the page.
`placeBubble` ([`bubblePlacement.ts`](../../../front-end/src/components/publicmap/bubblePlacement.ts)) is pure: the bubble opens up and to the right of the table, to the left when it would pass the hall's right edge, under the table when the room over it is too short and shorter than the room under it, always held 8px inside the hall, its tail on the table's middle and at least 20px in from the bubble's corners, and hidden while the table is out of view.
It keeps 8px clear of the day map's zoom and legend (its `floatingRects`) by sliding along, its tail still on the table, to the nearest place that clears both; where no such place is in the hall, it stands where it would with nothing to keep clear of.
It places itself again when its anchor changes, when the day map's `viewed` says the map panned, zoomed or was measured at another size, and when the hall or the bubble is resized, with no animation-frame loop; it says where it opened by `data-side`, `data-vert` and `--tail-x`.
It fades in over 160ms, not under reduced motion, and keeps a press and a wheel on it to itself, so pressing it never pans the map.
**Nothing holding the focus lies under it either**: the keyboard bringing the focus to something in the hall it lies over, a neighbouring table by the arrow keys, or a zoom button by Tab where the hall had no room to keep the bubble clear of the zoom, closes the card, the focus staying where it went; judged a frame later against the same card.
A press is left alone, since it opens its own card or zooms the map: the keyboard's focus is told from a press's by the browser's own `:focus-visible`, and nothing tracks the pointer.
Its limit is that rule's: where a browser's heuristic judges a focus wrongly, the card closes on a press or stays over the keyboard's focus; the latter is WCAG 2.4.11's exception for content the visitor opened, which Escape closes without moving the focus.

**Under 1,000px it lies over the vendor panel's top** (Daniel's Q1, option (c)): absolute from the panel's top, the panel's full width, no taller than the panel and scrolling in its own `ScrollBox` beyond that, on white with a rule under it, with no tail.
So the whole hall stays in view with the table outlined, the list stays under the card, unmoved, and shows below it, and Close brings it back whole.
**Nothing holding the focus lies under it** (WCAG 2.4.11): the focus entering the search field, which the card always covers, closes the card as Close does, the focus staying on the field; a row the focus reaches is scrolled clear below the card by the list's `scroll-padding-top`, the card's reach over the list (`--public-map-card-reach`, measured as the card's box resizes), and closes the card if it is still under it once the browser has scrolled it; and a card opened or changed over what holds the focus, a row pressed by Enter or the field after a pick, scrolls that row clear, or gives the focus to the card's Close when it cannot.
**The card moves between the two as the window crosses 1,000px** (a tablet turned, a window resized): the focus in it goes to the same control of the card where it lands, and the focus outside it at the panel's top is kept in sight as when a card opens there, so the field after a pick at a desk gives the focus to the card's Close.
At 640px and under the tokens raise `--control-height`, `--control-height-compact` and `--target-min` to 44px, so the card's Close and links, the selects, the zoom's buttons and the vendor rows are 44px tall.

**Close and Escape shut it at any width**: each writes the address without `table` and `half`, then gives the focus back to the table, or to the half shown alone, when it was in the card (`focusTarget`); a table that is no button leaves it where the browser puts it.
Escape is heard on `window`, and does nothing when it was already handled, or when the focus is in a combobox whose list is open, since Escape closes that list first.

### A half picked alone

**A press on a seated half of a shared table picks that half alone**: the address gains `half=left` or `half=right`, the map outlines that half (`publicSeatKey`), the card shows that part alone, and the list rings that vendor's row alone.
A press on a whole table, or on a half with nobody at it, which the drawing gives no seat key, writes no half, so a free half opens the whole table, both parts.
A vendor opened from the list or the search writes their seat's half, none for a whole seat.
A half named in the address with nobody at it shows that half alone, "This half is free on <day>.", the map outlines the whole table, and the list rings no row.
This supersedes D35's "A half table's card lists both vendors, left then right" (T465): both are listed only when the whole table is picked.

## The vendor panel and its search

**The panel** ([`PublicMapVendors.vue`](../../../front-end/src/components/publicmap/PublicMapVendors.vue)), an `aside` named "Vendors", holds "Find a vendor" pinned at its top over every named vendor of the day, at every location, by name (`mapListing`), in a `ScrollBox` that takes the rest; with none it says "No vendors are listed for this day yet.".
Each row is a button: the table's code in a pill of its section's colours, hidden from a reader, then the name over the hall, "Table <code>, " before the hall for a reader alone; the picked vendor's row is ringed in mustard (`aria-current`), the row whose seat is picked, or every row at the picked table when no seat is.
A press opens the vendor's location and picks their table, or their half; the page never scrolls, so the map is always in view, and when their table is zoomed out of view the map is fitted first.
At rest the first row stands 12px into the list, the room scrolling away with the rows.
Once the list has scrolled, a band under the field blurs and fades the rows passing under it; at the top it is not drawn, so nothing covers the first vendor.

**Every row is drawn, with no paging and no count line**, the one list that does not use [the list frame](component-library.md)'s pages: a market's day is a few hundred rows at most, already in memory, and the design scrolls them under the field; a reader hears the dropdown's matches through its listbox instead.

**The search is the app's `SearchPicker`** ("Name, table, website or Instagram", `clearsOnChoice`, `listOver`, eight options at most): its dropdown offers the vendors the words find, a pick opens that vendor, and the field empties and keeps the focus, at a desk; on a phone the card then opens over the field, so the focus goes to its Close; the words never filter the list.
`publicVendorEntries` ([`publicMapSearch.ts`](../../../front-end/src/components/publicmap/publicMapSearch.ts)) builds each vendor's entry by naming each field it copies, never by spreading a seat: the public name, the website's host, the Instagram handle, the table's code, the section's name and the hall, so an extra key the server sent by mistake is never searched.
`findsVendor` finds a vendor when the words, trimmed, lower-cased and their spaces made one, are inside the name, the host, the handle (a leading "@" dropped), the code, the code with its spaces out ("a13" finds "A 13") or the section's name; never by an email address, a full name or a preferred name, which the server never sends ([ADR 0035](../../adr/0035-the-public-map-publishes-a-vendors-chosen-answers.md)).

## Sharp edges

**Nothing a vendor typed becomes markup or a link of its own**: the three answers come cleaned by the server, are drawn as text, and a link is built here again only from an `http` or `https` address with a host (`websiteLink`) or a handle of 1 to 30 letters, digits, dots and underscores (`instagramLink`), so a value the server let through by mistake still never becomes a `javascript:` link.
Every link opens in a new tab with `rel="noopener noreferrer"`.

**A table's id names it across the market**, so the address's `table` and a seat's `tableId` need no location; the seed gives each hall's tables their own prefix, since the server keeps ids unique only within one layout.

## Tests

The unit tests share the answer they mount on, [`support/publicMapAnswer.ts`](../../../front-end/src/__tests__/support/publicMapAnswer.ts).

- [`thePublicMapPage.test.ts`](../../../front-end/src/__tests__/thePublicMapPage.test.ts): the opening day, the place an address names and its fallbacks, each `half` value, `shownParts`, the day in words and `shortDay`, both links and what they refuse; the page mounted on a mocked read: "Page not found" and the bar's fallback, a failed read and Try again, the order of its parts, the selects and what they write, the title, the image read as a blob, the window's class, the legend's items, no card before a pick, each part given the page's place, a half pressed and a free half, the card in the bubble when wide and over the panel's top when not, in its own scroller, and Close there bringing the list back, the focus never left under it (the field closing it, a row covered closing it, one clear keeping it, a pick over the field giving the focus to Close), the card crossing 1,000px with the focus, a table under the bubble closing it and one clear keeping it, a zoom button the keyboard reaches under it closing it, a press on one or on a table under it keeping it, and a press that never ended leaving the keyboard's rule as it was, the bubble given the zoom and the legend to keep clear of, Close and Escape and Escape's exceptions, and a vendor out of view fitting the map.
- [`thePublicMapTableCard.test.ts`](../../../front-end/src/__tests__/thePublicMapTableCard.test.ts): each kind of card, the heading, the code pill's paint, the hidden link labels and Close.
- [`thePublicMapBubble.test.ts`](../../../front-end/src/__tests__/thePublicMapBubble.test.ts) and [`bubblePlacement.test.ts`](../../../front-end/src/__tests__/bubblePlacement.test.ts): where the bubble opens at each edge and corner, its tail's clamp, a bubble larger than the hall, hidden out of view, sliding clear of the zoom and the legend or standing put where nothing clears them, and when it places itself again.
- [`thePublicMapVendors.test.ts`](../../../front-end/src/__tests__/thePublicMapVendors.test.ts) and [`publicMapSearch.test.ts`](../../../front-end/src/__tests__/publicMapSearch.test.ts): every row, the pill, the ring, no count, the fade's rule, a pick and a row press; the entries' nine keys, no private key copied or found, and each public field finding its vendor.
- [`publicMapPaint.test.ts`](../../../front-end/src/__tests__/publicMapPaint.test.ts), [`publicMapBackdrop.test.ts`](../../../front-end/src/__tests__/publicMapBackdrop.test.ts) and [`useFillsTheWindow.test.ts`](../../../front-end/src/__tests__/useFillsTheWindow.test.ts): the legend's items and labels, the colours dealt for none to eight, and the window's class counted.

The E2E specs open the page signed out on [the seeded market day](../testing/e2e-seeds.md), on a phone and at a desk:

- [`the-public-map.spec.ts`](../../../front-end/e2e/the-public-map.spec.ts): the allowlist on the page (every table and half of both halls on both days pressed, and the page's text and every link's address holding no email address and none of the seed's personal markers, every request to the market page's read, the map's two public routes or the app's own files), a press on a table, each half of the shared table, the selects, the legend, the phone's legend on one line for two short names and wrapped whole for a long one, a deep link and its fallback, a market with its map off reading the market page's notice and an unknown slug "Page not found", an organizer's bar, the sheet filling the window with the document never scrolling, and a pinch on a phone that zooms the map and never the page.
- [`the-public-map-backdrop.spec.ts`](../../../front-end/e2e/the-public-map-backdrop.spec.ts): the backdrop past every edge, painted in the sections' mixes, taking no press.
- [`the-public-map-bubble.spec.ts`](../../../front-end/e2e/the-public-map-bubble.spec.ts), at a desk: the bubble up and right, under a table near the top, to the left near the right edge, following a zoom, hidden when panned away, Close and Escape giving the focus back, a table under it closing it when the arrow keys reach it, a vendor out of view fitting the map, in a short window, the bubble clear of the zoom, which a press and Tab from its table pass without closing it, and on a touch screen at a desk width a tap on a zoom button the bubble partly covers leaving it open.
- [`the-public-map-phone-card.spec.ts`](../../../front-end/e2e/the-public-map-phone-card.spec.ts): the phone's card over the panel's top, the hall wholly in view, a row below it pressable, the focus never under it (Tab out of it to the field, Enter on each row, Shift+Tab after), a tall card scrolling in its own box, Close and Escape, every target 44px tall, `100dvh` under the window's class, the bubble at a desk, and the card and the focus in sight as the window narrows past 1,000px and widens again.
- [`the-public-map-half.spec.ts`](../../../front-end/e2e/the-public-map-half.spec.ts): a half pressed, outlined and kept through a reload and a fresh link, a stale half and `half=middle` showing the whole table.
- [`the-public-map-vendors.spec.ts`](../../../front-end/e2e/the-public-map-vendors.spec.ts): the answer as received holding no private detail, the search finding by each public field and never by a private one, a pick, the whole list, the first row's room under the field and its fade.

[`PublicMapPage.ts`](../../../front-end/e2e/pages/PublicMapPage.ts) is their page object; the map's tables are found by their accessible names, as a layout's are ([E2E patterns](../testing/e2e-patterns.md)).
The four layout sweeps walk the page before a pick, with the shared table picked whole, and with its right half picked (`SCREENS` in `e2e/helpers/screens.ts`).

## Why

- [ADR 0035](../../adr/0035-the-public-map-publishes-a-vendors-chosen-answers.md): the map publishes only the answers the organizer chose, cleaned.
- [A gated market answers as absent](../../business/rules/a-gated-market-answers-as-absent.md): a closed map reads as no market.
- [The market's map](../../business/flows/the-markets-map.md): how a visitor finds a vendor on it (K8).
