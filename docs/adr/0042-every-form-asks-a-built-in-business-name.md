---
layer: implementation
kind: adr
describes:
  - back-end/essential_fields.py#business_name
  - back-end/essential_fields.py#_store_business_name
  - front-end/src/utils/essentialFields.ts#businessName
verified: 2026-11-20
sources:
  - T502
status: accepted
---

# Every form asks a built-in business name

The nodes it constrains: [essential fields](../implementation/modules/essential-fields.md) and [the CSV proposal and start](../implementation/modules/csv-proposal-and-start.md); the rule it stands beside: [a vendor is called by their chosen name](../business/rules/a-vendor-is-called-by-their-chosen-name.md); the concept it adds a question to: [Essential question](../business/concepts/essential-question.md).
It narrows [ADR 0035](0035-the-public-map-publishes-a-vendors-chosen-answers.md), "The public map publishes a vendor's chosen answers".

## Context

An organizer at the door finds a vendor by the name on their name tag, and for some vendors that is the name they trade under, not their own.
The app kept no business name of its own.
A market that wanted one asked it as a question of its own form, under a key and a label of its choosing, so no screen could rely on it: Attendance named each vendor by their own name and their address only.

## Decision

**Every application form asks an optional "Business name", a built-in question with no switch.**
Its key is `essential_business_name` (`BUSINESS_NAME_KEY` in [`back-end/essential_fields.py`](../../back-end/essential_fields.py), mirrored in [`front-end/src/utils/essentialFields.ts`](../../front-end/src/utils/essentialFields.ts)).
It sits right after the preferred name in `ESSENTIAL_QUESTIONS`, which the import's targets read, and in the front end's `ESSENTIAL_ORDER`, which the review card and the history read; the form draws it there too.

- **It is asked of every market and required of nobody**: in `asked_essential_keys`' unconditional set beside the two names, out of `plan_derived_asked_keys` as they are, and in neither `REQUIRED_ESSENTIAL_KEYS` nor `UNASKABLE_ESSENTIAL_KEYS`.
- **The solver never reads it**: it is out of `SOLVER_RELEVANT_KEYS`, so an organizer's update of it asks no assignment row.
- **It is stored only when given.**
  `_store_business_name` stores the answer stripped under the key when it gives a business name, and no key at all when it is blank, missing or exactly a none word (`NONE_WORDS`, "N/A" and the rest, in any capitals: `given_business_name`).
  An applicant's save and an import compare the whole stored `form_data` (`application_status._answers_move`, `csv_import._unchanged`), so a key every save wrote as `""` would make each application written before the question read as changed, and send a person's approval or rejection back to open on an unchanged file.
  The preferred name and the request keep their `""`; this key alone is absent when empty.
- **One reader states "the business name of these answers"**: `business_name(form_data)`, and `businessName(formData)` in the mirror, the stripped text or `""`, also for a value that is not text.
  The door, the drawer, the export, the public map and the review search read it through it, so an absent key and a blank one are one case there.
- **An organizer's update of it left blank, or to a none word, is `""`**, standing over the vendor's answer, since no key cannot say "the organizer removed it"; `business_name` reads that as none.
  A blank update over a vendor who gave none is their own answer, and takes any update away.
- **It is never the name a vendor is called by**: `display_name` does not read it.
  Attendance shows it as a second, smaller line under the vendor's name.
- **It has no length limit**, as no free-text essential question has one; the public map still cuts a published name at 80 characters.
- **A file's column headed "Business name" is proposed as it** when a market starts from a Google Form export, read off the heading, since a business name's answers have no shape of their own.

**It narrows ADR 0035.**
That ADR's rejected alternative, "a fixed 'business name' essential question", is superseded: the form now asks one.
The public name is still an Admin's choice, and the choice may be the built-in business name, offered first on the Public map card ([the market's map](../business/flows/the-markets-map.md), [the public map](../implementation/modules/public-map.md)).
Nothing else of ADR 0035 moves: the website and the Instagram handle are still read from text questions of the market's own form, what is published is still cleaned on the server, and the map still opens with the results and closes with the market.

## Consequences

- Every market has a business name to show without adding a question, an imported market included, whose column is mapped to it.
- An application stored before the question holds no key and reads as it did: nothing is backfilled, and an unchanged file imported again changes nobody.
- A reader that takes the key straight from `form_data` reads an absent key, a blank update and a hand-written value three ways; it goes through `business_name`.
- A market whose form already asks for a business name as a question of its own asks it twice, until an operator moves that question's answers onto the built-in field.
- A new essential answer that every save stores, even as `""`, reopens every verdict on the next unchanged save or import: it is stored only when given, as this one is, or backfilled before its release.

## Considered and rejected

- **Storing `""` when none was given**, as the preferred name does: every application stored before the question would read as changed.
- **A switch to leave the question off a form**: every screen that shows the business name would have to ask whether the market asks it, and a vendor who has none already leaves it empty.
- **Reading a market's own question by its label**: a label is the organizer's words, and a match on it would change data on a guess.
- **Making it the name a vendor is called by**: the name is a person's ([a vendor is called by their chosen name](../business/rules/a-vendor-is-called-by-their-chosen-name.md)), and the address beside it is what the product matches on.
