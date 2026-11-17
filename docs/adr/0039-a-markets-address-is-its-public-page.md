---
layer: implementation
kind: adr
describes:
  - front-end/src/views/MarketPublicView.vue
  - front-end/src/utils/vendorPage.ts#marketPageShows
  - front-end/src/utils/vendorPage.ts#marketPageNotice
  - front-end/src/utils/market.ts#marketPagePath
  - front-end/src/utils/market.ts#vendorPagePath
  - back-end/market_documents.py#public_map_is_open
verified: 2026-11-18
sources:
  - T469
status: accepted
---

# A market's address is its public page, and the vendor's side is its own address

The nodes it constrains: [every market page has an address](../implementation/conventions/every-market-page-has-an-address.md), [a gated market answers as absent](../business/rules/a-gated-market-answers-as-absent.md), [the public map](../implementation/modules/public-map.md), [the public map page](../implementation/modules/public-map-page.md) and [the app bar](../implementation/modules/app-bar.md); the flows it changes: [applying online](../business/flows/applying-online.md), [the market's map](../business/flows/the-markets-map.md), [the door on market day](../business/flows/market-day-door.md) and [finding and opening markets](../business/flows/finding-a-market.md#c4-the-navigation-menu).
It amends [ADR 0022](0022-the-vendor-page-is-signed-in.md), which put the vendor page at the market's own address.

## Context

A market had one address, `/<market>`, and it was the vendor page ([ADR 0022](0022-the-vendor-page-is-signed-in.md)): signed out, it was only the sign-in form, with no dates and no way to the map.
The public map had an address of its own, `/<market>/map` ([ADR 0035](0035-the-public-map-publishes-a-vendors-chosen-answers.md)).
A shopper given the market's address found a sign-in form meant for vendors, and had to know to add `/map`; a vendor and a shopper were sent to one address for different things, and neither found their own (the release walk of 2026-11-17, `T469`).
No market in production used these addresses yet, so moving them broke nobody.

## Decision

**`/<market>` is the market page, for anyone, signed in or out, in every stage.**
[`MarketPublicView.vue`](../../front-end/src/views/MarketPublicView.vue) shows one of three things, chosen in this order by [`marketPageShows`](../../front-end/src/utils/vendorPage.ts):

1. the public map, whenever the server says it is open, in any stage;
2. the application call, while a market whose vendors apply on its page takes applications: the market's name and dates, "Applications are open.", Apply and "Already applied? Sign in", both leading to the vendor page;
3. otherwise a notice with the name and dates, its line chosen by `marketPageNotice` ("This market has ended." once archived, "The map isn't published yet." once the results are out, else "Applications are closed."), and a link to the vendor page, "Vendor sign-in" ("Your vendor page" for a tab signed in for that market).

On it the app bar carries "Vendor sign-in" to the vendor page ("Your vendor page" for a tab signed in for that market), so the map's own design needs no vendor control.

**`/<market>/vendor` is the vendor page**, everything ADR 0022 decided for it, unchanged but for its address and two additions: the market's dates under its name, signed in or out, and while the map is open "See the market map" to `/<market>`.
The sign-in code email links to it, the door's QR code opens `/<market>/vendor?door=<code>`, and the organizer's rail and Publish results share it.
The rail shares both addresses, "Market page" first, and the Public map card gives `/<market>` as the map's address.
The two addresses are built in one place each, `marketPagePath` and `vendorPagePath` in [`utils/market.ts`](../../front-end/src/utils/market.ts).

**One read is the gate of both pages.**
Both read `GET /public/markets/<slug>/vendor-page`, which answers a market with no vendor page (a draft, a Google Form market before its results, a slug naming nothing) with the 404 of a slug naming nothing, so both addresses read "Page not found" for it alike ([a gated market answers as absent](../business/rules/a-gated-market-answers-as-absent.md)).
Its one new field, `mapOpen`, is [`public_map_is_open`](../../back-end/market_documents.py), the same statement of the map's gate the map's own read is built on, so the market page never chooses a map the map's read would refuse.
Nothing else was added to the read, so nothing new about a market became public.

**The two older addresses stay, as redirects.**
`/<market>/map`, with its day, location and table, lands on `/<market>` with the same query, since links and QR codes to the map were made on `dev` before this.
`/<market>?door=<code>` goes on to `/<market>/vendor?door=<code>`, since a door poster printed while `/<market>` was the vendor page holds that address and must still check a vendor in.
Deeper addresses (`/<market>/vendor/anything`, `/<market>/apply`, `/<market>/check-in`) answer "Page not found".

## Consequences

- A shopper needs only the market's address, in every stage; a vendor needs only the vendor page's.
- An organizer shares two addresses and must choose: the market page for the public, the vendor page for vendors.
- The market page reads the vendor page's answer before it draws anything, so a slug is never printed back before the server has said there is a market there.
- A sign-in email sent before the change links to the market page, one click from the vendor page.
- The map may close between the market page's read and the map's own: the map then reads its own "Page not found" until the next load, a window of one round trip.

## Considered and rejected

- **Keeping `/<market>` the vendor page and only adding the dates and a map link to it**: a shopper would still meet a sign-in form at the market's address.
- **Dropping `/<market>/map` and the old door address**: a printed poster or a shared map link would read "Page not found", where ADR 0022 could delete its old addresses because nobody used them.
- **A gate of the market page's own**: two gates could disagree, and one answering where the other did not would confirm which markets exist.
