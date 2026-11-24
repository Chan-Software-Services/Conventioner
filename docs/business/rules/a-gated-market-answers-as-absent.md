---
layer: business
kind: rule
describes:
  - back-end/market_documents.py#applicant_intake_market_by_slug
  - back-end/market_documents.py#APPLICANT_SURFACE_PHASES
  - back-end/api/applicant_auth.py#request_login_code
  - back-end/api/applicant_auth.py#verify_login_code
  - back-end/tests/test_applicant_intake_gate.py
  - front-end/e2e/intake-mode.spec.ts
  - back-end/market_documents.py#vendor_page_market_by_slug
  - back-end/tests/test_a_google_form_markets_page.py
  - front-end/e2e/a-google-form-markets-vendor-page.spec.ts
  - back-end/market_documents.py#public_map_market_by_slug
  - back-end/tests/test_the_public_map.py
  - front-end/e2e/the-public-map.spec.ts
  - back-end/market_documents.py#public_map_is_open
  - front-end/src/views/MarketPublicView.vue
verified: 2026-11-24
sources:
  - wayfinding/v0-1-0/06
  - wayfinding/v0-1-0/07
  - wayfinding/the-order-of-the-work/09
  - wayfinding/the-order-of-the-work/map
  - brain-dump/2026-10-19#26
  - E03/F02/S02
  - E18/F04/S02
  - E26/F07/S02
  - E32/F03/S01
  - E32/F03/S02
  - E03
  - E03/F02
  - E03/F03
  - bug/20
  - T202
  - T263
  - T422
  - T469
  - T539
---

# A gated market answers as absent

A market with no vendor page (any market still a draft, or a CSV market before its results are published or its market days) answers every vendor request exactly as a market that does not exist.
Applying answers so on a CSV market in every phase: its vendors are the organizer's form responses, and nobody applies on its page.
**Never add a "not accepting applications online" message: it confirms to any stranger guessing slugs that the market is real.**

**Serves:** [Vendors apply on the market's own page](../intents/vendors-apply-on-the-markets-own-page.md).

## Why

Between a stranger learning nothing and a stranger learning that an organizer they have never met is running a market, the product takes the first.
A friendlier notice was considered and rejected for exactly that, and so was redirecting to check-in, which turns a stranger's typo into a vendor-facing page.
A gated market is invisible to every vendor request, check-in included; a market reaches its check-in only in `market_days`, where every market has a vendor page, so no check-in ever meets the gate.

**A market's two public addresses answer the same way**: its own address, `/<slug>`, the market page ([ADR 0039](../../adr/0039-a-markets-address-is-its-public-page.md), [`MarketPublicView.vue`](../../../front-end/src/views/MarketPublicView.vue)), and its vendor page, `/<slug>/vendor` ([ADR 0022](../../adr/0022-the-vendor-page-is-signed-in.md), [`VendorPage.vue`](../../../front-end/src/views/VendorPage.vue)).
A gated market's is "page not found" at both, and a form market's market page names the market, its dates and where it stands, while its vendor page names the market and asks for an email address and the code sent to it.
Both read the vendor page's answer before they draw anything, so neither has a gate of its own that could answer where the other does not.

**The two applicant-login endpoints keep their _uniform_ response rather than gaining a 404 of their own**: requesting a code always answers the same 200, and every failed verification the same 401.
A 404 there would be an oracle saying "this slug is a gated market" where every other answer says nothing.
The vendor page and the market page read `GET /public/markets/<slug>/vendor-page` first, which answers a gated or unknown slug with the same 404, so each says the page does not exist and the vendor page never takes an address (E32/F03/S01); a sign-in page once drew its form and answered "sent" for a code it never sent.
Until the market answers, each says it is loading and draws nothing of the market; a request that fails in transit is not an answer, and the page says it could not be loaded, with Try again.

**The code is sent within the request**, before the response goes out, to every address that asks at a market the gate serves ([a vendor signs in before they have applied](a-vendor-signs-in-before-applying.md)).
A gated market answers without sending anything, so the time a request takes says only that the market has a vendor page, which its public page already says.

**A form market has a vendor page in every phase but draft** (`APPLICANT_SURFACE_PHASES`, E26/F07/S02).
An applicant may always sign in and read their own application and its outcome; closing the surface with applications hid every verdict (bug 20).
Applying itself stays the `applications` phase's, while the organizer takes applications ([an applicant never reads a verdict early](an-applicant-never-reads-a-verdict-early.md)).

**A CSV market has a vendor page once its results are published** ([ADR 0022](../../adr/0022-the-vendor-page-is-signed-in.md)), when its vendors have a result to read there, and keeps it after, archived included.
Before then it has nothing to tell anyone, so its page would only confirm the market; after, an imported vendor signs in with the address their response gave and reads their table, with no application section ([the Google Form path](../flows/the-google-form-path.md)).
One that has reached its market days has a page too, published or not: a Google Form market went live before it could publish results, and the change must not lock its vendors out; its vendors read their tables there as if its results were published.
An archived one that reached them counts, by its phase record, and where that record began late, by a check-in, as everywhere else that asks whether a market ran.

**A market's public map answers the same way while it is closed** ([ADR 0035](../../adr/0035-the-public-map-publishes-a-vendors-chosen-answers.md)).
It is open only while the vendor page finds the market and `public_map_is_open` holds: its results are out (published, or it reached its market days), it is not archived, an Admin has turned it on, its public name question is still one the map may name (the built-in business name, or a short text question of the form), and a location is laid out with a table in a section; its read and its image then answer byte for byte as a slug naming no market does, with the vendor page's own body.
A seat is never public before its vendor is told it, and an archived market can no longer be written, so its switch could never be turned off.
What a public read may answer at all is [security invariants](../../implementation/conventions/security-invariants.md#each-request)' to say.
The map is shown on the market page while it is open, and `/<slug>/map` lands there; while it is closed the market page shows a market the vendor page finds its application call or its notice instead ("The map isn't published yet." once its results are out), which says no more than the vendor page already does ([the public map page](../../implementation/modules/public-map-page.md)).
Its own read, asked of a closed map, still answers as a slug naming no market, and [`the-public-map.spec.ts`](../../../front-end/e2e/the-public-map.spec.ts) holds that a slug naming nothing reads "Page not found" and a map that is off the notice.

**The organizer's own link to the page follows the gate.**
The rail shows the market's two addresses, "Market page" and "Vendor page", each with Copy, while the pages answer: a form market from the first phase after draft, a CSV market once its results are published or it reached its market days; both until it is archived, and after that only for a market that ran ([the phase rail](../../implementation/modules/phase-rail.md)).
Before then a link would be the one place the product admitted the market was real, and a draft's page deliberately tells the organizer nothing either.
An archived market's vendor page is the record of where its vendors sat only if it ran.
Manage market's Delete names the market page and the vendor page among what stops working by the same rule as the page itself (`hasVendorPage` in [`vendorPage.ts`](../../../front-end/src/utils/vendorPage.ts)), and the rail's chips by that rule and the archive's (`sharesVendorPage`).

## Where it is kept

- **`vendor_page_market_by_slug()`** ([`back-end/market_documents.py`](../../../back-end/market_documents.py)) decides whether a market has a vendor page: a market at the slug, in a phase of `APPLICANT_SURFACE_PHASES`, whose intake mode is `form`, or whose results are published, or that reached `market_days` (`attendance.market_ran`), or `None`, the same answer as for a slug that names nothing.
  It adds what it reads (the intake mode, the results flag, the id and the phase record) to the caller's projection, so a caller names only its own fields.
  It is read by the page's own public read (`get_vendor_page`), requesting and verifying a sign-in code and resuming a remembered one (`request_login_code`, `verify_login_code`, `resume_sign_in` in [`back-end/api/applicant_auth.py`](../../../back-end/api/applicant_auth.py)), and the vendor's own read (`get_applicant_application` in `back-end/api/applicants.py`), which on a CSV market carries no `formData`.
- **`public_map_market_by_slug()`**, beside it, is the public map's gate, the map's read and its image both asking it (`public_map.py`, [the public map](../../implementation/modules/public-map.md#the-gate)); it is the vendor page's lookup and `public_map_is_open`, which the vendor page's read answers as `mapOpen`, so the market page never chooses a map the map's read refuses.
  [`back-end/tests/test_the_public_map.py`](../../../back-end/tests/test_the_public_map.py) closes the map one condition at a time and asserts each answers as an unknown slug.
- **`applicant_intake_market_by_slug()`**, beside it, is the gate of applying: the public form and the save, which only a `form` market has.
  Every caller's existing not-found branch serves either's `None`, so the gate needs no message of its own; both are kept with [the market document](../../implementation/data/market-document.md), whose slug and draft rules they read.
  Each is one lookup rather than a check in each endpoint, because a check in each is a chance to forget one.
  The two sign-in endpoints count their caller against [the sign-in limits](a-vendor-signs-in-before-applying.md#sign-in-is-bounded), and ask the human check when they ask it at all, before they ask it, so a refusal past a limit, and the check's 403, are also the same for a gated market as for an absent one.
- **It is not the check-in lookup**, because check-in must stay open to every market that runs ([attendance and the door](../../implementation/modules/attendance-and-door.md)); both narrow `market_by_slug`, each with its own phases.
- What the mode is and when it may change: [intake mode decides how vendors arrive](intake-mode-decides-how-vendors-arrive.md), and why absence is CSV, [ADR 0006](../../adr/0006-intake-mode-fails-closed.md).
- The intake-mode control exists because this gate is what keeps the address from simply being shown: which mode a market has decides whether the page is real ([intake mode decides how vendors arrive](intake-mode-decides-how-vendors-arrive.md)).
- [`front-end/e2e/intake-mode.spec.ts`](../../../front-end/e2e/intake-mode.spec.ts) asserts the gated and absent renders are identical, rather than asserting each alone: the final address at `/<slug>` and `/<slug>/vendor`, whose text [`the-market-page.spec.ts`](../../../front-end/e2e/the-market-page.spec.ts) compares with an unknown slug's, signed out and signed in, and text and final address alike at `/<slug>/vendor/apply` and the deleted `/apply`, `/applicant-login` and `/applicant/dashboard`, which every market answers as not found; that they read alike to the market's own owner signed in, since "Page not found" offers an organizer Markets on who they are and never on the address ([the app bar](../../implementation/modules/app-bar.md#who-sees-what)); and that a vendor already signed in to a market taken back to draft is shown what a stranger is.
  [`back-end/tests/test_applicant_intake_gate.py`](../../../back-end/tests/test_applicant_intake_gate.py) pins the applying endpoints, the sign-in and the vendor's read on a CSV market, and the open check-in, and [`back-end/tests/test_the_vendor_page.py`](../../../back-end/tests/test_the_vendor_page.py) the vendor page's gate and its public read, byte for byte against an unknown slug.
  [`back-end/tests/test_a_google_form_markets_page.py`](../../../back-end/tests/test_a_google_form_markets_page.py) pins a CSV market's page per phase, results and record, every public vendor endpoint answering for it before its results byte for byte as for an unknown slug, and the read after; [`front-end/e2e/a-google-form-markets-vendor-page.spec.ts`](../../../front-end/e2e/a-google-form-markets-vendor-page.spec.ts) walks it at 1280 and 390, from absent to the vendor's table.

## Superseded

The application page's chip was to show in every phase of a form market, draft included, on the grounds that the page answers in every phase (wayfinding/the-order-of-the-work/09); a draft's page answers as absent, so the chip starts at the first phase after draft (E18/F04/S02).
