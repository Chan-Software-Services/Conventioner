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
verified: 2026-11-17
sources:
  - T422
---

# The public map

A market's public map shows anyone, with no sign-in, each market day's tables and who is at them, at `/<slug>/map` ([ADR 0032](../../adr/0032-the-public-map-publishes-a-vendors-chosen-answers.md)).
[`back-end/public_map.py`](../../../back-end/public_map.py) holds its settings' write, its gate's own conditions, its read and its image; [`back-end/public_answers.py`](../../../back-end/public_answers.py) cleans the three answers it publishes.
The page that draws it, and Attendance's map beside the list, read what this answers.

## The settings

**`publicMap` on the market is the Public map card's**, `{enabled, nameQuestion, websiteQuestion, instagramQuestion}` (`PublicMapSettings` in [`datatypes.py`](../../../back-end/datatypes.py), [the market document](../data/market-document.md)), and only `save_settings` writes it, through `PUT /markets/<id>/public-map`.

- The body is a JSON object of any of the four; another key is refused 400 naming it, `enabled` must be a boolean, and a question null or a string, the key of a `text` question of the market's form ("Choose one of the form's short text questions."); an empty string clears it as null does.
- The settings as they would stand with the map on and no name question the form still asks are refused 400 ("Choose the question that holds each vendor's public name before turning the public map on."), so turning the map on, taking its name question away while on, and leaving it on with a name question the form lost are each refused.
- It asks the table's "Publish the map" row (`publish-map`, an Admin's by default, [the market's actions](market-actions.md), [what each role may do](../../business/rules/what-each-role-may-do.md)) and loads through `_load_market_to_change`, so an archived market refuses it 403 whoever asks.
- It writes the settings whole through [the market write](market-write.md), holding `publicMap` as read: a product-made market stores `publicMap: null`, under which no field can be created, and a change saved meanwhile in another tab, of another setting even, refuses it 409 rather than being written over.
- It answers 200 `{"publicMap": {...}}` as stored, and records a history entry, action `publish-map`, kind `public_map`, its detail the fields that changed, each question by its key and its label (`name_question` and `name_question_label`, and so for the website and Instagram), as Discord's question is ([the market's history](../data/history.md)); a write that changes nothing writes and records nothing.

## The gate

**`public_map_market_by_slug`, in [`back-end/market_documents.py`](../../../back-end/market_documents.py) beside the vendor page's lookup, is the one gate** of the read and the image ([a gated market answers as absent](../../business/rules/a-gated-market-answers-as-absent.md)).
The market is found by its slug as the vendor page finds it (`vendor_page_market_by_slug`), its results are out (`results_are_out`), it is not archived, and `is_open` holds: the switch on, its name question still a `text` question of the form (`chosen_question`, which reads a key the form lost as not chosen), and at least one location the map draws (`mapped_locations`).
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

A no-table zone stores its turn, `rotation`, degrees clockwise about its centre, read into 0 to 360 as it parses; a turn that is not a finite number is refused by the floorplan's bounds.
A layout stores `followsPlan`, whether it was started after Draft: true on one started past Draft ([ADR 0033](../../adr/0033-a-layout-started-after-draft-follows-the-plan.md)), false on one started in Draft, and kept on every later save whatever the body sends ([`back-end/api/floorplans_save.py`](../../../back-end/api/floorplans_save.py)).
[`back-end/tests/test_a_layouts_stored_shapes.py`](../../../back-end/tests/test_a_layouts_stored_shapes.py) saves both through the layout's own route.

## Tests

- [`back-end/tests/test_the_public_map.py`](../../../back-end/tests/test_the_public_map.py): the answer's key set at every level, exactly; a marker for an email, a full name, a preferred name, another answer and a note, none of them anywhere in the answer's text; a name that is an email withheld; the organizer's update of a name answered; each gate condition answering byte for byte as an unknown slug, for the read and the image; the image's type and cache header.
- [`back-end/tests/test_the_public_map_settings.py`](../../../back-end/tests/test_the_public_map_settings.py): the write and its refusals one by one, its history entry, and a write that changes nothing.
- [`back-end/tests/test_public_answers.py`](../../../back-end/tests/test_public_answers.py): the cleaning's table for each value, hostile inputs included.
- The walks every write joins hold it too: it records (`test_every_write_records.py`), names its row (`test_every_check_names_an_action.py`), is refused on an archived market (`test_an_archive_is_read_only.py`), and is refused on a changed market against a real MongoDB (`test_every_held_write_is_refused_on_a_changed_market.py`).
- [`front-end/e2e/helpers/seedMarketDayMap.ts`](../../../front-end/e2e/helpers/seedMarketDayMap.ts) seeds a market on its days with a map to draw, for every spec of the map ([E2E seeds](../testing/e2e-seeds.md)).
