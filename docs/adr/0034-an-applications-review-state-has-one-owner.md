---
layer: implementation
kind: adr
describes:
  - back-end/application_status.py
  - back-end/tests/test_one_writer_of_the_review_state.py
verified: 2026-11-17
sources:
  - T277
  - T429
status: accepted
---

# An application's review state has one owner

## Context

An organizer runs a market's review with chosen reviewers, each dealt a share of the open applications ([ADR 0020](0020-an-application-is-dealt-to-one-reviewer.md)).
Where an application has got to in that review is several fields on [the application document](../implementation/data/application-document.md): its status, the verdict's giver, time and reason, the follow-up's owner, what an undo returns it to, who added it, its mark for the deal and the reviewer whose share it is.
T277 found eight writers of those fields across seven modules, each with its own conditions, and every way an application fell out of every share came from a writer that moved one field and forgot what another writer kept with it.
A rule about how an application moves between states could be kept only if every move were written in one place.

## Decision

**One module, [`back-end/application_status.py`](../../back-end/application_status.py), imported as `ReviewState`, is the only code that writes an application's review state.**

- The owned fields are `status`, `verdict_by`, `verdict_at`, `verdict_reason`, `follow_up_owner`, `undo_to`, `added_by`, `added_at`, `origin`, `arriving` and `reviewer` (`OWNED_FIELDS`).
  A move between states writes several of them in one update, so they are owned together.
- The owner writes through the collection [`back-end/api/applications.py`](../../back-end/api/applications.py) binds (`ApplicationsApi.applications_collection`, read at each call), so the suite's fakes and the real-MongoDB world rebind one name.
  That module stays the owner of the collection's storage contract (its key spelling, its identity index, its reads) and keeps the writes that name no owned field: the claim's ([ADR 0014](0014-reviewers-claim-and-a-verdict-is-a-conditional-write.md)) and the deletes.
- The predicates that read the state live beside its writes and are its only spelling: `is_decided`, `is_judgeable`, `undo_to_of`, `undoable_by`, `UNDO_WINDOW` and the status lists.
- [`back-end/review_team.py`](../../back-end/review_team.py) stays the one owner of dealing: it decides whom an application goes to while it holds the market, and calls the owner's deal writes to store it.
- [`back-end/tests/test_one_writer_of_the_review_state.py`](../../back-end/tests/test_one_writer_of_the_review_state.py) walks every back-end module by AST and fails a write to the applications collection outside the owner unless it is listed with its reason, and fails a listed write whose update, replacement or inserted document names an owned field, or that the walk cannot read.
  A filter may name an owned field, since the claim holds the status it read.
  A one-time migration an operator runs is listed and not read.

## Consequences

- A rule about a move between states is written once, in the owner, and a second writer is a failing test rather than a bug found by a reviewer.
- The owner and `api/applications.py` import each other, and neither reads the other at import.
- A test that patches a write patches `ReviewState`, and one that rebinds the collection still rebinds `ApplicationsApi.applications_collection`.

## Considered and rejected

- **Keeping each writer's own conditions** (the eight writers T277 found): every new writer would have to know every rule the others keep, which is how applications fell out of every share.
- **A scan for owned field names as strings**, as `account_secrets` is guarded ([ADR 0028](0028-an-accounts-sign-in-secrets-are-one-machine.md)): `status` and `reviewer` are read everywhere, and a filter must name them, so only a walk of what each write writes tells a writer from a reader.
- **Moving the collection's binding into the owner**: every fake and the real-MongoDB world would rebind two names, and the storage contract would leave the module that owns it.
