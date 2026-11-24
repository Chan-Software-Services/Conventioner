---
layer: implementation
kind: adr
describes:
  - back-end/api/applicants.py#applicant_form_version
  - back-end/api/applicants.py#save_applicant_application
verified: 2026-11-24
sources:
  - T507
status: accepted
---

# A vendor's save is held to the form their page drew

The rule it keeps: [a vendor's save is held to the form they saw](../business/rules/a-vendors-save-is-held-to-the-form-they-saw.md); the write it stands beside: [the market write](../implementation/modules/market-write.md#the-forms-revision).

## Context

A vendor's save carried only the answers, so the server judged them against the form as the market asked it at the save, whatever the vendor's page had drawn.
The form changes under an open page only while the market is back in draft or by the operator's business name migration, but then an answer to a question taken away was dropped without a word, a business name moved to the built-in field was stored nowhere, and choices were checked against dates, sections or tiers the vendor never saw.
The organizer's own form save is already held: it carries `formRevision`, the count of the writes of the form's questions.

## Decision

**The vendor's save carries the form version, a fingerprint of the form as their page drew it, and a save carrying another is refused with the 409 `form_changed`.**

- The version is the SHA-256 hex digest of the canonical JSON (keys sorted, compact separators, non-ASCII kept) of the market's own questions as the public form read serves them and of the essential options as it serves them (`applicant_form_version` in [`back-end/api/applicants.py`](../../back-end/api/applicants.py)).
  The read and the version are built from one helper's payload, so a change to what the read serves moves the version with it.
- It is computed on each read and each save and never stored: no field, no migration, no index.
- It is judged after the market is known to take applications and before any answer is judged or anything written, on the one read the answers are judged on ([`save_applicant_application`](../../back-end/api/applicants.py)).

## Consequences

- A vendor is refused only for a change they could see on their page; an organizer moving a table, or saving the form unchanged, refuses nobody.
- Every page open across a deploy that changes the shape of what the form read serves is refused once, and reloads onto its kept answers; accepted, as the tab opened before the version existed is.
- A save that names no version reads as one from such an old tab.
- A new part added to what the vendor's form read serves joins the version by being in the helper's payload, with no second list to keep.

## Considered and rejected

- **Holding the save to `formRevision`**: it counts the writes of the form's questions only, so a change to the plan's dates, sections or tiers before the first application would still reach the vendor unseen.
- **Holding it to `planRevision` as well**: it moves on every layout save past draft, so vendors would be sent to reload whenever an organizer moved a table.
- **Storing the version on the market**: every writer of the form or the plan would have to keep it, and one that forgot would refuse or let through saves wrongly; computed from what the read serves, it cannot drift.
- **Carrying a moved answer over to its new key on the page**: the server cannot know which question the vendor's answer meant once the form moved, and the migration has already copied the stored answer.
