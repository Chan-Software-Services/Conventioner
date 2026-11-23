---
layer: business
kind: rule
describes:
  - back-end/api/applicants.py#applicant_form_version
  - back-end/api/applicants.py#save_applicant_application
  - back-end/app.py#public_save_applicant_application
  - front-end/src/utils/api.ts#isFormChanged
  - front-end/src/components/vendorPage/VendorApplicationForm.vue
verified: 2026-11-24
sources:
  - T507
  - T502
  - T271
---

# A vendor's save is held to the form they saw

A vendor's save is taken only against the form their page drew: a save from a page drawn from another form than the market asks now is refused, storing nothing, with "This form changed since you opened it. Reload to continue."
The vendor reloads onto the form as it now asks, with the answers they typed kept.

**Serves:** [Vendors apply on the market's own page](../intents/vendors-apply-on-the-markets-own-page.md).

## Why

A vendor often fills in the form over minutes or hours, on a phone, with the tab left open.
The form changes under an open page only while the market is back in draft (Reopen for editing, while nobody has applied) or by the operator's [business name migration](../../OPERATIONS.md#moving-a-markets-business-name-question-to-the-built-in-field), but when it does, a save judged against the form as it is now is judged against a form the vendor never saw:

- An answer to a question taken away is dropped without a word, and a new question is stored blank.
- An answer to a question moved to another key is lost: after the migration, a page opened before its run sends the old key beside a blank built-in field, and the business name would be stored nowhere while an approved application went back to open.
- Dates, sections, tiers or table types changed before the first application are checked against options the vendor never saw.

So the server refuses the save rather than guess what the vendor meant, and the page sends them back to the form as it asks now.

## What the form version covers

**The form version** is a fingerprint of the form as the vendor's page draws it: the SHA-256 hex digest of the canonical JSON of the market's own questions as the public form read serves them and of what the essential questions offer (`applicant_form_version` in [`back-end/api/applicants.py`](../../../back-end/api/applicants.py)).
The read and the version are made from one helper's payload, so they never disagree.

- It moves with everything the vendor sees: a question's label, help text, options, order or required flag, a question added or removed, the plan's dates, sections, tiers or table types before the first application froze the offering, and an essential question left unasked.
- It does not move with what the vendor cannot see: a layout saved, a form saved with nothing changed, a phase move.
- Neither revision counter stands in for it: `formRevision` misses the plan's options, and `planRevision` moves on every layout save past draft, which would refuse vendors whenever an organizer moves a table ([ADR 0044](../../adr/0044-a-vendors-save-is-held-to-the-form-their-page-drew.md)).
- It is never stored: computed on each read and each save.

## The refusal

The vendor's form read, `GET /public/markets/<slug>/application-form`, answers `formVersion` beside the form in every phase it answers, and the page's save, `PUT /public/markets/<slug>/applicant/application`, carries it as `formVersion` beside `formData` ([`public_save_applicant_application`](../../../back-end/app.py)).
The save ([`save_applicant_application`](../../../back-end/api/applicants.py)) refuses, in this order:

1. answers that are not an object (400);
2. no such market (404);
3. a sign-in for another market (403);
4. a market not taking applications (403), so a closed market says it is closed, never that the form changed;
5. a version that is not the form's version now, a body naming none, `null` and a value that is not a string included: 409 `{"error": "This form changed since you opened it. Reload to continue.", "code": "form_changed"}`;
6. then everything else it refuses, judged against the form the vendor saw.

The version is judged on the one read of the market the answers are judged on, and before anything is written: no application is made for a vendor who had none, the essential offering is not frozen, nothing is recorded in the market's history, and an existing application keeps its answers, status and verdict.
A save sent again without reloading is refused the same way.
The code `form_changed` is the vendor's own, never `market_changed`, which re-reads an organizer's open market.

A body naming no version, from a tab opened before the version existed, is refused the same way.
That page drew its form before anything could say which form it was, so the server cannot tell whether the vendor saw the form it asks now, and taking the save would judge their answers against a form they may never have seen, the loss this rule exists to prevent.
The old page shows the server's sentence in its error box, as it shows any refusal, with no Reload of its own, and keeps the typed answers in the tab, so the vendor's own reload loses nothing.

## On the page

The vendor page's store keeps the version its form read answered (`formVersion` in [`stores/application.ts`](../../../front-end/src/stores/application.ts)), and every save sends it beside the answers.
The vendor reads the sentence where a refused save's reason always shows, the form's error box, with Reload after it in a row that wraps, under the sentence on a phone ([`VendorApplicationForm.vue`](../../../front-end/src/components/vendorPage/VendorApplicationForm.vue)).
The page tells the refusal apart by its code (`isFormChanged` in [`api.ts`](../../../front-end/src/utils/api.ts), beside the other coded 409s of [an exception never reaches a client](../../implementation/conventions/an-exception-never-reaches-a-client.md#what-the-organizer-reads)); any other refusal offers no Reload, and Reload goes with the sentence it came with, so the next save, Cancel or another sentence in its place takes it away (`formChanged`).
"Save application" and "Cancel" stay: a second save is refused the same way, and Cancel drops the kept answers as it always has.

Reload reloads the page, which reopens the form by itself on the answers the vendor typed, kept in the tab as they typed them (T271), drawn as the form now asks: an answer to a question it still asks is there, a question taken away is gone, and a new one is blank ([applying online](../flows/applying-online.md#h3a-a-new-vendor-applies)).
No restore of its own is written for it: the reloaded form puts the kept answers over the application as stored now, and a key the new form does not ask is dropped as it is sent.

A save that met an ended sign-in keeps the version it was sent with beside its answers, and the save the page sends by itself after the vendor signs in again carries that version, not the one read after the sign-in (`takeSaveAfterSignIn`), so a form that changed in between refuses it with the sentence and Reload rather than take it unseen.
Answers kept before the version existed carry none, and are refused the same way.

## Where it is kept

- [`back-end/api/applicants.py`](../../../back-end/api/applicants.py): `applicant_form_version`, the form read's `formVersion`, and the save's check (`FORM_CHANGED`).
- [`back-end/app.py`](../../../back-end/app.py): `public_save_applicant_application` reads `formVersion` from the body.
- [The market write](../../implementation/modules/market-write.md#the-forms-revision): the organizer's form save holds `formRevision`; the vendor's save holds the form version instead.
- [`front-end/src/stores/application.ts`](../../../front-end/src/stores/application.ts) and [`VendorApplicationForm.vue`](../../../front-end/src/components/vendorPage/VendorApplicationForm.vue): the version kept and sent, `formChanged`, and Reload.
- Pinned by `back-end/tests/test_a_save_from_an_older_form_is_refused.py`, and for the business name migration by `back-end/tests/test_migrate_business_name.py`; on the page by `VendorPage.test.ts` ("a save from a form that changed since the page read it") and `a-save-from-an-older-form-is-refused.spec.ts`.
