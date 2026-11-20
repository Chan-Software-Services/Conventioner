---
layer: implementation
kind: module
describes:
  - back-end/essential_fields.py
  - front-end/src/utils/essentialFields.ts
  - front-end/src/components/application/EssentialApplicationFields.vue
  - front-end/src/components/application/RankedChoiceInput.vue
  - back-end/application_write.py#_asks_nothing
  - back-end/guards.py#FormHasFieldsGuard
  - front-end/src/utils/applicationForm.ts#applicationFormError
  - front-end/src/utils/applicationForm.ts#applicationFormRefusal
verified: 2026-11-17
sources:
  - wayfinding/readable-journey/02
  - wayfinding/v0-1-0/map
  - wayfinding/v0-1-0/01
  - wayfinding/real-market-readiness/03
  - wayfinding/the-order-of-the-work/01
  - wayfinding/the-order-of-the-work/04
  - wayfinding/the-order-of-the-work/map
  - E01
  - E01/F06
  - E13/F01/S01
  - E19/F01/S02
  - E19/F02/S01
  - E27/F01/S01
  - E31/F04
  - E18
  - E19
  - E41/F01/S01
  - E41/F01/S02
  - E38/F03/S01
  - T123
  - T181
  - T263
  - T502
---

# Essential fields

The essential questions are the ones every application form asks whatever else the organizer builds, because the solver reads their answers.
[`back-end/essential_fields.py`](../../../back-end/essential_fields.py) is the single owner of that contract: the reserved `essential_*` answer keys in `Application.form_data`, what each question offers, the validation of an applicant's answers, and the freeze.
[`front-end/src/utils/essentialFields.ts`](../../../front-end/src/utils/essentialFields.ts) is its front-end mirror (the keys, the labels, the offering, the answer rows a reviewer reads) and must stay in step with it; the market's history reads a vendor's recorded answers through it too (`answerLabel`, `answerReading`, `inFormOrder`), so they read as the Application tab does.
Why the set is exactly what it is: [essential fields are exactly what the solver reads](../../adr/0001-essential-fields-are-the-solver-contract.md).

## The questions

`ESSENTIAL_QUESTIONS` lists the eleven in the order the form asks them: full name, preferred name, business name, available dates, number of dates wanted, table choice, table-share partner, tier preference, section preference, table-type preference, and the vendor's request.
The import lists its targets in that order and the CSV proposal its unanswered questions, so neither drifts from the form.

- **Asked** is `asked_essential_keys(options)`, the one statement of which questions an offering asks: the name, preferred name, business name and request always; the dates, the number wanted, the table choice and the partner when the plan has dates; the tiers when it has tiers; a ranking only over two or more options (`asks_ranking`), since a list of one has one order.
  The applicant validator, the solver's input translation ([the assignment solver](assignment-solver.md)), the import and the automatic rejections all read it, so the solver can never reject answers the form has just accepted.
- **Required** is `REQUIRED_ESSENTIAL_KEYS`, every essential question but the preferred name, the business name, the partner and the request, and only when asked ([an incomplete application refuses the run](../../business/rules/an-incomplete-application-refuses-the-run.md)); an import may leave the number of dates unanswered ([what an import may leave unasked](../../business/rules/what-an-import-may-leave-unasked.md)).
- **Solver-relevant** is `SOLVER_RELEVANT_KEYS`, the answers the solver reads; what any changed answer does to a verdict is the review state's, whichever answer it is ([the transition table](../data/application-document.md#the-transition-table)), and a reformatted answer is no change.
- **Updated by an organizer** ([an update of a vendor's answer](../../business/rules/an-update-is-kept-beside-the-vendors-answer.md)) through `validated_essential_update`, which runs the form's own steps over the update and the answers it leaves, judges only the steps the update touches, and returns the stored answers each updated question writes (`UPDATABLE_ESSENTIAL_QUESTIONS`: the table-share words write the addresses read out of them too).
  A question whose stored answers meet `SOLVER_RELEVANT_KEYS` also asks the row "Update info the assignment or price reads", an Admin's by default; the solver and the other readers read the update through `effective_answers`.
  The dialog asks them with the applicant's own component ([`EssentialApplicationFields.vue`](../../../front-end/src/components/application/EssentialApplicationFields.vue), its `locked` questions read-only and its `after` slot under each), on the offering `marketEssentialOptions` in `essentialFields.ts` mirrors from `effective_essential_options_for_market`.
  A `locked` question is drawn in the `.field` primitive's one disabled state, as the dialog draws the market's own locked questions: its choice rows and its ranking ([`RankedChoiceInput.vue`](../../../front-end/src/components/application/RankedChoiceInput.vue)'s `locked`) beige with muted ink and a `not-allowed` cursor, the chosen row and the ranks marked by a line rather than the applicant's mint and green.
  A locked ranking draws no arrows, so it has no "Use the arrows ..." line above it either.
  `disabled`, which the Form preview passes, takes every input away and keeps the applicant's look and words, the arrows' line included, since the preview shows what a vendor sees; only `locked` changes the look ([`aLockedEssentialLooksLocked.test.ts`](../../../front-end/src/__tests__/aLockedEssentialLooksLocked.test.ts)).
- **Switched off** is `unaskedEssentials` on the form: a market may declare the two rankings and the request unasked (`UNASKABLE_ESSENTIAL_KEYS`), and nothing else, since only a ranking is a preference the solver never filters on, and a default for a date, a tier or a table choice would answer for the vendor.

**Table type is stubbed to one type** (`STUB_TABLE_TYPE`, "Standard") in every market, whatever its `setupObject.tableTypes`, so the table-type ranking is never asked.
A table's type belongs to the table, not its section, so only a layout can describe it: the market's types now live in `setupObject.tableTypes` and each layout's table names one ([the layout](floorplan-placement.md)), but the form and the solver do not read them yet, and a follow-up makes them.
The stub is a decision, not a gap: the key, its validation and its mirror stay, only a real offering is missing.

**Dates and tiers are stored in one shape** however the form asked: `reconciled_dates_and_tiers` turns a per-date grid (the dates named are the dates available) or one flat list of tiers (those tiers on every available date) into a per-date tier answer and a list of dates.
It is the one statement of that conversion, read by the applicant form and the import alike (`csv_import.py` calls it rather than widening rows itself).
The applicant form asks the two as one grid, a row per market date with its tiers and "Not available" (`EssentialApplicationFields.vue`), as a real Google Form does; with no tiers it asks the dates alone.

**The name to call a vendor** is `display_name`: their preferred name, else their full name.
`VendorIdentity.vue` shows the name it is handed on every screen that names a vendor; the review card alone shows both, labelled, since deciding about a person is not scanning a list.
`applicantName` in `essentialFields.ts` is the same rule read from an application's answers, for a screen that holds the answers rather than the served names: the All view's rows and the import preview's.
The Vendors page and its drawer read it too, so a refused placement read still names every vendor, the served name winning where the server has one (T123).
The preferred name is asked of everyone, after the full name, and is never required, never solver-relevant and never switched off.
What every screen does with the name is [a vendor is called by their chosen name](../../business/rules/a-vendor-is-called-by-their-chosen-name.md).

**The business name is the name a vendor trades under**, asked of everyone right after the preferred name, and never required, never solver-relevant and never switched off ([ADR 0042](../../adr/0042-every-form-asks-a-built-in-business-name.md)).
It is never the name a vendor is called by: `display_name` does not read it.
**It is stored only when given, the one essential answer that is**: its step (`_store_business_name`) stores the answer stripped when it is not blank, and no key at all when it is blank or missing, where the preferred name and the request store `""`.
An applicant's save and an import compare the whole stored `form_data` ([the transition table](../data/application-document.md#the-transition-table)), so a key every save wrote empty would make each application stored before the question read as changed, and send a person's verdict back to open on an unchanged file.
`business_name(form_data)`, and `businessName(formData)` in the mirror, read it as the stripped text, or `""` for an absent key, a blank one or a value that is not text; the door, the drawer, the export, the public map and the review search go through them.
An organizer's update of it left blank is the exception to "as the form stores them": `validated_essential_update` returns `""`, the update standing over the vendor's answer, since no key cannot say the organizer removed it, and `update_vendor_info` reads a blank one over a vendor who gave none as their own answer, which takes any update away.
The search on the results finds a vendor by it (`vendor_search_terms_for_market`), the review's find field too (`findsApplication`), and the vendors' export offers it as a column ([exporting vendors](../../business/flows/vendors.md)).
`back-end/tests/test_the_built_in_business_name.py` and `front-end/src/__tests__/theBuiltInBusinessName.test.ts` pin it.

## The offering, and the freeze

**The offering is the market plan, never a list of its own**: dates from `setupObject.marketDates`, sections from `setupObject.sections`, tiers from `setupObject.tiers`, and table types from the stub (`essential_options_from_setup`, mirrored by `essentialOptionsFromSetup`).

**It follows the plan live until the first accepted answer, then freezes.**
The first applicant save or imported row writes the offering it was validated against onto `applicationForm.essentialOptions` (camelCase, server-owned like `publishedAt`; no client payload can write it), before the answer itself is stored, so no answer ever lands against an unfrozen offering.
Every later read serves that snapshot (`effective_essential_options`), so no plan edit reaches the form afterwards, and there is deliberately no refresh path.
The freeze is one conditional update, first writer wins (`freeze_and_effective_essential_options`); a save that loses the race re-validates against the snapshot that won.
The form save never writes the snapshot: it sets the questions and the unasked essentials alone and holds `essentialOptions` as it read it, so a save crossing the first answer is refused rather than erasing the offering ([the form's revision](market-write.md#the-forms-revision)); a first save on a market with no form writes it with `essentialOptions: null`, so the freeze filter matches null-or-missing (`None` in a Mongo filter), never `$exists`.
The plan itself settles earlier still, on leaving draft.

## A form is custom fields plus asked essentials

**Either half alone is a form.**
Every layer that asks "does this market have a form?" counts the essential questions as well as the custom fields: `FormHasFieldsGuard` in [`back-end/guards.py`](../../../back-end/guards.py), which keeps a market from leaving draft on either intake path, and `_asks_nothing` in [`back-end/application_write.py`](../../../back-end/application_write.py), which refuses an application to a market that asks nothing.
When `_asks_nothing` counted custom fields alone, a market could open applications and then refuse every application it received, by import and by applicant alike.
Both read `plan_derived_asked_keys`, the asked questions less the name, preferred name, business name and request: those are asked unconditionally, so counting them would leave both unable to say no, and a market whose plan offers nothing to apply for is still refused.
The applicant's form reads its front-end mirror, `planDerivedAskedKeys`, so a market asking the essential questions alone offers its form and its Save; it once told vendors it had no form.
`_normalized_application_form` stores a form with no custom fields ([the market document](../data/market-document.md#the-fields-that-matter)).

## The reserved prefix

**A custom field's key may not start with `essential_`**: the essential answers live beside the custom ones in `form_data`, and a custom field that shadowed one would corrupt what the solver reads.
The server refuses it in `_normalized_application_form` ([`back-end/api/markets.py`](../../../back-end/api/markets.py)), and the form builder says so first in `applicationFormError`, by `applicationFormRefusal` ([`front-end/src/utils/applicationForm.ts`](../../../front-end/src/utils/applicationForm.ts)), through `fieldKeyError`, which the amendment's dialog asks too.
The same check refuses the import's own targets as keys (`applicant_email`, `submitted_at`, `sheet_note`), each named with what the import reads it as ([the market document](../data/market-document.md#the-fields-that-matter)).

## The generated schema

`docs/schema.d.ts` is generated from `MarketSchemaContract`; after changing a contract model, regenerate it as [the market document](../data/market-document.md#the-schema-contract) says.

## Why

- [Essential fields are exactly what the solver reads](../../adr/0001-essential-fields-are-the-solver-contract.md).
- [Every form asks a built-in business name](../../adr/0042-every-form-asks-a-built-in-business-name.md): why it is stored only when given.
- [An incomplete application refuses the run](../../business/rules/an-incomplete-application-refuses-the-run.md): requiredness is what the market asked.
- [What an import may leave unasked](../../business/rules/what-an-import-may-leave-unasked.md).
- [Table-share pairing](../../business/rules/table-share-pairing.md): how the partner's address is read out of the answer.
- [Tier filters, section prefers](../../business/rules/tier-filters-section-prefers.md): why tier is a set and section a ranking.
- [Building the application form](../../business/flows/form-tab.md): the essential questions as the organizer meets them, on the form tab's first step.

The glossary concepts it serves: [Essential question](../../business/concepts/essential-question.md) and [Table sharing](../../business/concepts/table-sharing.md).
