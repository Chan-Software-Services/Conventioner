---
layer: implementation
kind: adr
describes:
  - back-end/public_map.py
  - back-end/public_answers.py
  - back-end/market_documents.py#public_map_market_by_slug
  - back-end/market_documents.py#public_map_is_open
verified: 2026-11-18
sources:
  - T422
  - T469
status: accepted
---

# The public map publishes a vendor's chosen answers

## Context

A market's layout was an organizer's planning drawing that nobody outside the team saw.
Visitors at a market had no way to find a vendor's table, and the organizers asked for a map anyone can open at the market's address, showing who is at each table on each market day.

That map is the first place an applicant's answers leave the organizer's side.
Until now an answer was read only by the people with a role on the market, and by the applicant on their own vendor page ([ADR 0022](0022-the-vendor-page-is-signed-in.md)); [ADR 0018](0018-what-of-an-applicants-answers-the-market-may-keep.md) says that keeping or showing any other part of an applicant's answers is a new ADR.
The answers are free text: a business name can be an email address, a website can be `javascript:`, and an application holds the vendor's full name, their address and the organizer's notes beside them.

## Decision

**The public map publishes three answers of each seated vendor, each read from a short text question of the market's own form that an Admin chooses, and nothing else of an application.**

- **It is off until an Admin turns it on** ([what each role may do](../business/rules/what-each-role-may-do.md)): a row of the permissions table, "Publish the map" (`publish-map`), an Admin's by default, asks the Public map card's write, and the market's history records who turned it on and what it shows.
- **The allowlist is three answers the organizer points at**: a public name, a website and an Instagram handle, each the key of a `text` question of the form, or none.
  Never the email address, the full name, the preferred name, another answer, a note, a payment or a status.
  The read builds its answer key by key in [`back-end/public_map.py`](../../back-end/public_map.py), never from a model's dump, so a field added to a stored model never reaches it.
- **A vendor with no public name is a taken table with no details**: the read answers their seat with a null name, and the page shows only that a vendor is at the table, whatever else they answered; nothing stands in for the name.
- **What is published is cleaned on the server**, in one pure module, [`back-end/public_answers.py`](../../back-end/public_answers.py): a name that reads as an email address anywhere in it is withheld and a name is cut at 80 characters; a website is published only as an `http` or `https` address with a host, at most 200 characters, a bare domain given `https://`; an Instagram answer only as a handle of 1 to 30 letters, digits, dots and underscores.
  Anything else is null, never shown raw.
- **The map reads the answers as the organizer reads them**: an organizer's update of an answer stands in its place (`effective_answers`), so a misspelt name is fixed in the vendor drawer.
- **The map opens with the results and closes with the market**: one gate beside the vendor page's lookup, `public_map_market_by_slug` in [`back-end/market_documents.py`](../../back-end/market_documents.py), serves it only while the vendor page finds the market and `public_map_is_open` holds: its results are out, it is not archived, the switch is on, its name question is still a text question of the form and a location is laid out; a market that fails it answers byte for byte as a slug naming no market ([a gated market answers as absent](../business/rules/a-gated-market-answers-as-absent.md)).
- **A vendor's address joins a seat to its application on the server and is never in the answer.**

It narrows ADR 0018: the answers a market keeps stay as that ADR keeps them, and these three alone may be shown outside the market's team, cleaned, while the map is on.
It stands beside ADR 0022: the vendor page is still where a vendor reads their own seat signed in; the map shows anyone the seats with the chosen answers, never a vendor's own application.
The map is shown at the market's own address, `/<market>`, on the market page, whenever that gate holds, and `/<market>/map` lands there ([ADR 0039](0039-a-markets-address-is-its-public-page.md)); the vendor page's read says whether it holds as `mapOpen`, from the same `public_map_is_open`, and says nothing else of the map.

How the map is read, its gate, its answer and its image: [the public map](../implementation/modules/public-map.md).

## Consequences

- An organizer decides what is public, question by question; a form with no short text question for a business name has no public map until one is asked.
- How an Admin opens the map and a visitor finds a vendor on it is [the market's map](../business/flows/the-markets-map.md).
- A vendor's seat is never public before results are, so a vendor learns their table before a stranger does.
- An archived market's map is closed for good, since its switch can no longer be turned off.
- The answer may be cached for a minute and the image for five; there is no rate limit of its own, as the vendor page's read has none.
- Adding a fourth published answer, publishing an answer of another kind, or showing any of them before results are out, is a new ADR that narrows this one.

## Considered and rejected

- **The vendor's preferred name as the public name**: a person's name, which Daniel ruled out.
- **A fixed "business name" essential question**: every market would ask it, where the organizer's own form already asks it in their words, and an imported market's column is a short text answer too.
- **On for every published market**: it publishes vendors' details to anyone, so it is a deliberate act by someone senior.
- **Keeping an archived market's map up**: the switch could never be turned off.
