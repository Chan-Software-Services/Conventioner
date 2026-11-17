---
layer: implementation
kind: module
describes:
  - back-end/public_map.py
  - back-end/public_answers.py
  - back-end/market_documents.py#public_map_market_by_slug
  - back-end/datatypes.py#PublicMapSettings
  - back-end/tests/test_the_public_map.py
  - back-end/tests/test_the_public_map_settings.py
  - back-end/tests/test_public_answers.py
  - back-end/tests/test_a_layouts_stored_shapes.py
  - front-end/src/components/market/MarketPublicMapCard.vue
  - front-end/src/utils/historyReaders/publicMap.ts
  - front-end/src/__tests__/thePublicMapCard.test.ts
  - front-end/e2e/the-public-map-card.spec.ts
  - back-end/market_documents.py#public_map_is_open
verified: 2026-11-17
sources:
  - T422
  - T469
---

# The public map

A market's public map shows anyone, with no sign-in, each market day's tables and who is at them, on the market page at the market's own address, `/<slug>`, while it is open ([ADR 0035](../../adr/0035-the-public-map-publishes-a-vendors-chosen-answers.md), [ADR 0039](../../adr/0039-a-markets-address-is-its-public-page.md)); `/<slug>/map` lands there.
[`back-end/public_map.py`](../../../back-end/public_map.py) holds its settings' write, its gate's own conditions, its read and its image; [`back-end/public_answers.py`](../../../back-end/public_answers.py) cleans the three answers it publishes.
The page that draws it, and Attendance's map beside the list, read what this answers.
How an Admin opens it and a visitor uses it is [the market's map](../../business/flows/the-markets-map.md).

## The settings

**`publicMap` on the market is the Public map card's**, `{enabled, nameQuestion, websiteQuestion, instagramQuestion}` (`PublicMapSettings` in [`datatypes.py`](../../../back-end/datatypes.py), [the market document](../data/market-document.md)), and only `save_settings` writes it, through `PUT /markets/<id>/public-map`.

- The body is a JSON object of any of the four; another key is refused 400 naming it, `enabled` must be a boolean, and a question null or a string, the key of a `text` question of the market's form ("Choose one of the form's short text questions."); an empty string clears it as null does.
- The settings as they would stand with the map on and no name question the form still asks are refused 400 ("Choose the question that holds each vendor's public name before turning the public map on."), so turning the map on, taking its name question away while on, and leaving it on with a name question the form lost are each refused.
- It asks the table's "Publish the map" row (`publish-map`, an Admin's by default, [the market's actions](market-actions.md), [what each role may do](../../business/rules/what-each-role-may-do.md)) and loads through `_market_change`, so an archived market refuses it 403 whoever asks.
- It writes the settings whole through [the market write](market-write.md), holding `publicMap` as read: a product-made market stores `publicMap: null`, under which no field can be created, and a change saved meanwhile in another tab, of another setting even, refuses it 409 rather than being written over.
- It answers 200 `{"publicMap": {...}}` as stored, and records a history entry through the asking `_market_change` returned, action `publish-map`, kind `public_map`, its detail the fields that changed, each question by its key and its label (`name_question` and `name_question_label`, and so for the website and Instagram), as Discord's question is ([the market's history](../data/history.md)); a write that changes nothing writes and records nothing.

## The card

**The Public map card stands on the Tools tab, after Discord's** ([`MarketPublicMapCard.vue`](../../../front-end/src/components/market/MarketPublicMapCard.vue), in [`ToolsView.vue`](../../../front-end/src/views/ToolsView.vue), [the market frame](market-frame.md)).
It says what the map shows and never shows, offers three pickers of the form's short text questions (`formTextQuestions`, the Discord card's own reading), "Public name", "Website" and "Instagram", each with "Not shown" first, and the switch "Show the public map", a checkbox with `role="switch"`.

- Each change is saved at once through the settings write, and the page reads the market again (`changed`), never patching it; a refusal is said on the card's error line and the picker or the switch goes back to what is stored, as Discord's card does.
- A stored question the form no longer asks as short text shows as "Not shown", as the server reads it (`chosen_question`).
- Off with no public name chosen, the switch is disabled with "Choose the public name's question first." under it; on, it can always be turned off, even after the form lost the name's question.
- Someone the "Publish the map" row refuses reads the same controls, disabled, with the row's sentence; on an archived market the card says "An archived market's map is closed." in its place.
- While on, it shows the address, the market page's `/<slug>` under the app's origin (`marketPagePath`), built as the rail builds its two addresses, with "Copy link" (`useCopyAddress`, "Copied" for two seconds) and "Open the map", a new tab with `rel="noopener noreferrer"`.
- It says the first thing the map still lacks, the archived market's sentence above first, then: "Lay out a location first: the map draws the market's layouts." with "Open the layout", while no location is laid out as `mapped_locations` reads it (a scale, and a table numbered in one of the location's sections); then "The map opens once results are published." until `vendorsWereTold` ([`vendorPage.ts`](../../../front-end/src/utils/vendorPage.ts), the server's `results_are_out`).

The market's history reads each change in words ([the market's history](../data/history.md), [`historyReaders/publicMap.ts`](../../../front-end/src/utils/historyReaders/publicMap.ts)).

## The gate

**`public_map_market_by_slug`, in [`back-end/market_documents.py`](../../../back-end/market_documents.py) beside the vendor page's lookup, is the one gate** of the read and the image ([a gated market answers as absent](../../business/rules/a-gated-market-answers-as-absent.md)).
The market is found by its slug as the vendor page finds it (`vendor_page_market_by_slug`), and `public_map_is_open` holds of its document: its results are out (`results_are_out`), it is not archived, it reads as a `Market`, and `is_open` holds: the switch on, its name question still a `text` question of the form (`chosen_question`, which reads a key the form lost as not chosen), and at least one location the map draws (`mapped_locations`).
The vendor page's read answers `public_map_is_open` as `mapOpen`, which is how the market page chooses the map, so the two can never disagree; `test_the_vendor_page.py` closes the map one condition at a time and asserts `mapOpen` is whether the map's read answers 200.
A location is drawn when its layout has a scale and at least one table in one of the location's sections with a number.
A market that fails answers 404 with the vendor page's own not-found body, byte for byte as a slug naming no market, and both routes are classed "the public map" in `test_every_route_asks.py` and listed with the public vendor endpoints in `test_a_google_form_markets_page.py`.

## The read

**`GET /public/markets/<slug>/map` answers an allowlist, built key by key** (`public_map`), with `Cache-Control: public, max-age=60`:

- `marketName`, and `dates`, the market dates in calendar order;
- `tableTypes`, each `{id, name, widthMm, depthMm}`;
- `locations`, the drawn ones in the plan's order, each `{id, name, sections, layout}`: `sections` the location's, `{id, name}`, in the plan's order; `layout` its `{id, locationId, imageWidth, imageHeight, scalePxPerUnit, hasImage}`, its `tables` (only those in one of its sections with a number, `{id, sectionId, number, tableTypeId, xMm, yMm, rotation}`), its `zones` (`{id, label, xMm, yMm, widthMm, depthMm, rotation}`) and its `sectionStyles` of its own sections (`{sectionId, color, labelAt}`, `labelAt` `{xMm, yMm}` or null);
- `seats`, one for each stored placement on a market date at a listed table, matched by `table_code_for(section name, number)`, each `{date, tableId, half, name, website, instagram}`: `half` `whole`, `left` or `right` from "Full Table", "Half Table (Left)" and "Half Table (Right)", ordered by date, the locations' order, the table's code as a person counts and left before right.

A seat's three answers are its vendor's, read as the organizer reads them (`vendor_answers_for_market`, which reads `effective_answers` off a projection of the chosen keys alone) at the chosen questions, each cleaned by `public_answers`; a question not chosen, or one the form no longer asks as text, gives null.
A vendor's address joins a seat to its answers here and is never in the answer.

**The cleaning is `public_answers.py`, pure, with a table of inputs for each value**:

- `public_name`: trimmed, inner whitespace made one space, cut at 80 characters, and null when empty or when an email address stands anywhere in it;
- `public_website`: trimmed, a bare domain (letters, digits, dots and hyphens, a dot, a top-level label of 2 letters or more, an optional path) given `https://`, and kept only as an `http` or `https` address with a host and no user part, of at most 200 characters with no whitespace;
- `instagram_handle`: `@name`, `name`, or an `instagram.com/name` address with or without its scheme, `www.`, a trailing slash or a query, kept as `name` when it is 1 to 30 letters, digits, dots and underscores.

## The image

**`GET /public/markets/<slug>/map/image/<location_id>` answers the floorplan image of a location the map draws** (`public_map_image`), with its content type as the image route detects it (`detect_mimetype` in `api/floorplans.py`) and `Cache-Control: public, max-age=300`.
It is behind the same gate, and answers the same 404 for a location the map does not draw, a layout with no image, an image stored for another market or gone from the store.
It reads the image by the layout it found, never by an id the request names.

## What a layout stores for it

A no-table zone stores its turn, `rotation`, as [the market document](../data/market-document.md) sets out the zone's shape.
A layout stores `followsPlan`, whether it was started after Draft: true on one started past Draft ([ADR 0034](../../adr/0034-a-layout-started-after-draft-follows-the-plan.md)), false on one started in Draft, and kept on every later save whatever the body sends ([`back-end/api/floorplans_save.py`](../../../back-end/api/floorplans_save.py)).
[`back-end/tests/test_a_layouts_stored_shapes.py`](../../../back-end/tests/test_a_layouts_stored_shapes.py) saves both through the layout's own route.

## Tests

- [`back-end/tests/test_the_public_map.py`](../../../back-end/tests/test_the_public_map.py): the answer's key set at every level, exactly; a marker for an email, a full name, a preferred name, another answer and a note, none of them anywhere in the answer's text; a name that is an email withheld; the organizer's update of a name answered; each gate condition answering byte for byte as an unknown slug, for the read and the image; the image's type and cache header.
- [`back-end/tests/test_the_public_map_settings.py`](../../../back-end/tests/test_the_public_map_settings.py): the write and its refusals one by one, its history entry, and a write that changes nothing.
- [`back-end/tests/test_public_answers.py`](../../../back-end/tests/test_public_answers.py): the cleaning's table for each value, hostile inputs included.
- The walks every write joins hold it too: it records (`test_every_write_records.py`), names its row (`test_every_check_names_an_action.py`), is refused on an archived market (`test_an_archive_is_read_only.py`), and is refused on a changed market against a real MongoDB (`test_every_held_write_is_refused_on_a_changed_market.py`).
- [`front-end/src/__tests__/thePublicMapCard.test.ts`](../../../front-end/src/__tests__/thePublicMapCard.test.ts): the card's text and pickers, each save and its refusal, the switch's reason, a refused person and an archived market, the address and its copy, and what is still missing, case by case; `historyReaders.test.ts` holds the history's words.
- [`front-end/e2e/the-public-map-card.spec.ts`](../../../front-end/e2e/the-public-map-card.spec.ts), on the seam's market: an Admin chooses the three questions and turns the map on, a signed-out read then answers a vendor's public name and the card's address opens the map, and turned off it answers 404; an Editor reads the card disabled with the row's sentence; the card fits a phone; each state passes the accessibility check.
- [`front-end/e2e/a-market-past-draft-gets-a-public-map.spec.ts`](../../../front-end/e2e/a-market-past-draft-gets-a-public-map.spec.ts), the journey: on a market in Assignment with no layout, the organizer starts North Wing's layout and places Aisle A with Row of tables, chooses the questions and turns the map on, which waits for the results while the market page reads "Applications are closed.", publishes them, and a signed-out visitor on a phone opens the market's address, presses a vendor's table and reads it, which Attendance's map then draws as that vendor's.
- The four sweeps walk the public map before a pick, with a shared table picked and with one half of it picked, Attendance's map and the card turned on (`SCREENS` in [`front-end/e2e/helpers/screens.ts`](../../../front-end/e2e/helpers/screens.ts)).
- [`front-end/e2e/helpers/seedMarketDayMap.ts`](../../../front-end/e2e/helpers/seedMarketDayMap.ts) seeds a market on its days with a map to draw, for every spec of the map ([E2E seeds](../testing/e2e-seeds.md)).
