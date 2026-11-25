---
layer: implementation
kind: adr
describes:
  - back-end/application_status.py
  - back-end/tests/test_one_writer_of_the_review_state.py
  - back-end/tests/test_the_review_state_table.py
  - back-end/tests/test_changed_answers_are_one_event.py
  - back-end/datatypes.py#ApplicationOrigin
  - back-end/review_team.py#review_of
  - back-end/migrations/migrate_application_status.py
  - front-end/src/__tests__/noScreenSpellsAReviewStateOut.test.ts
  - front-end/src/__tests__/support/servedReview.ts
verified: 2026-11-25
sources:
  - T277
  - T429
  - T452
status: accepted
---

# An application's review state has one owner

## Context

An organizer runs a market's review with chosen reviewers, each dealt a share of the open applications ([ADR 0020](0020-an-application-is-dealt-to-one-reviewer.md)).
Where an application has got to in that review is several fields on [the application document](../implementation/data/application-document.md): its status, the verdict's giver, time and reason, the follow-up's owner, what an undo returns it to, who added it, its mark for the deal and the reviewer whose share it is.
T277 found eight writers of those fields, each with its own conditions, and traced every way an application fell out of every share to that: several fields, many writers, and no owner.
A rule about how an application moves between states could be kept only if every move were written in one place.

## Decision

**One module, [`back-end/application_status.py`](../../back-end/application_status.py), imported as `ReviewState`, is the only code that writes an application's review state.**

- The owned fields are `status`, `verdict_by`, `verdict_at`, `verdict_reason`, `follow_up_owner`, `undo_to`, `added_by`, `added_at`, `origin`, `arriving` and `reviewer` (`OWNED_FIELDS`).
  A move between states writes several of them in one update, so they are owned together.
- The owner writes through the collection [`back-end/api/applications.py`](../../back-end/api/applications.py) binds (`ApplicationsApi.applications_collection`, read at each call), so the suite's fakes and the real-MongoDB world rebind one name.
  That module stays the owner of the collection's storage contract (its key spelling, its identity index, its reads) and keeps the writes that name no owned field: the claim's ([ADR 0014](0014-reviewers-claim-and-a-verdict-is-a-conditional-write.md)) and the deletes.
- The owner names the states (`State`: open, follow-up, approved by a person or by being added, rejected by a person or by a rule) and reads them off the stored fields with one rule, `state_of`, so no stored status changes its spelling.
  The predicates that read the state live beside its writes: `state_of`, `origin_of`, `is_undecided`, `is_decided`, `saw_decided`, `is_judgeable`, `undo_to_of`, `undoable_by` and `UNDO_WINDOW`; the status lists are what the filters of the owner, the deal's pool and the claim need.
- **The transition table is data** (`TABLE`, the states each event moves from), stated once in [the application document](../implementation/data/application-document.md#the-transition-table), and **each event is one function** (`give_verdict`, `change_verdict`, `undo`, `rule_rejects`, `rule_returns`, `hand_on_follow_up`, `answers_changed`) taking the application as its caller read it, and an application is created by `arrive` or `add`.
  Each computes its move with one pure function, `move(doc, event)`, the move or the table's refusal, and writes it as one update held on the state as read, so a write landing in between is never written over.
  A table-driven test, [`back-end/tests/test_the_review_state_table.py`](../../back-end/tests/test_the_review_state_table.py), sends every event from every state through its route, refused pairs included, and checks `move` over the same grid.
- **Every move into open, an undo back into a follow-up, and a follow-up's hand-on mark the application for the deal in their own update** (`arriving`, by the `Arrival` it came by), whether or not reviewers are chosen: an arrival, an undo (into open or back into a follow-up), a rule's return, a re-import's or an applicant's back to review and a follow-up's hand-on; a follow-up a person gives keeps whatever mark it had.
  [`back-end/review_team.py`](../../back-end/review_team.py) stays the one owner of dealing: holding the market, it judges who may review, keeps an able reviewer or owner, deals the rest, and calls the owner's deal writes (`deal`, `deal_follow_up`, `settle_waiting`) to store it ([ADR 0020](0020-an-application-is-dealt-to-one-reviewer.md)).
- **Where an application came from is its own axis** (`origin`: `applied`, `imported` or `added`, `ApplicationOrigin` in [`back-end/datatypes.py`](../../back-end/datatypes.py)), stored by `arrive` and `add`, apart from the verdict: every back-end reader asking "did they apply" asks `is_added`, never `added_by`, which stays the record of who added them.
- **Changed answers are one event for every source** (`answers_changed`, Daniel's decision 9.1 of T277): the applicant's save, an import row and an organizer's update each pass the answers they built, and the owner writes them with their move in one update.
  A change by the applicant or an import sends a person's approval or rejection back to open, marked; an added vendor stays approved, and in whatever state an added vendor is their origin moves to `applied` or `imported`, so the run reads them (T277 P7); a rule's rejection is the rules' to judge again; an organizer's update keeps every verdict and holds nothing.
  The import's preview reads the same `move`, so what it says is what it does; [`back-end/tests/test_changed_answers_are_one_event.py`](../../back-end/tests/test_changed_answers_are_one_event.py) drives each source through its route.
- [`back-end/tests/test_one_writer_of_the_review_state.py`](../../back-end/tests/test_one_writer_of_the_review_state.py) walks every back-end module by AST and fails a write to the applications collection outside the owner unless it is listed with its reason, and fails a listed write whose update, replacement or inserted document names an owned field, or that the walk cannot read.
  A filter may name an owned field, since the claim holds the status it read.
  A one-time migration an operator runs is listed and not read.
  Its second check fails a module outside the owner, `tests/` and `migrations/` that reads a status the review no longer writes (`ApplicationStatus.UNDER_REVIEW`, the old offers flow's statuses, `CANCELLED`), so no reader spells a state out again beside `state_of`; its one exception, listed with its reason, is the offers stage's count of sent offers, which nothing enters and T277 ticket 14 removes.
- **The state is served, and every reader outside the owner counts with it** (T277 ticket 02, phase 2): every application an organizer reads carries `review` (its state read down to four, `State.served`; whether it is undecided; whose share it is in; whether it waits for the deal), read by [`back-end/review_team.py`](../../back-end/review_team.py)'s `review_of` over one `ReviewView` of the market per request ([the served review state](../implementation/data/application-document.md#the-served-review-state)).
  Begin assignment's guard counts with the owner's `undecided_counts`, walked off `state_of`, and the export's status and the table-share notice read `state_of`, so no stored spelling of a state reads as another anywhere.
- **The screens read the served state, never the status**: One by one, the All view and its drawer, the verdict lines and the Stats tab decide what is open, decided, in whose share and waiting from `review`, and the Stats tab counts the server's count of each state (`states`); the stored status stays for the labels and for comparing with the status a write would give.
  A front-end unit test ([`noScreenSpellsAReviewStateOut.test.ts`](../../front-end/src/__tests__/noScreenSpellsAReviewStateOut.test.ts)) fails a module that names the old spelling of open or declares one of the old lists of statuses for a state (`AWAITING`, `UNDECIDED`, `VERDICTS`), and the unit tests' fixtures state the review they stand for ([`servedReview`](../../front-end/src/__tests__/support/servedReview.ts)), so none derives it from a status.
- **A one-time migration brings stored applications to the machine** ([`back-end/migrations/migrate_application_status.py`](../../back-end/migrations/migrate_application_status.py), [the migration](../implementation/data/application-document.md#the-migration)): each spelling of open becomes `open`, an old offers flow's status the approval or rejection `state_of` reads it as, a missing origin what `origin_of` reads, and each application `is_waiting` reads as waiting on a market with chosen reviewers is marked for the deal under `review_state_migrated`, with no actor, so the next deal deals it.
  It applies the owner's own rules and needs no boot marker, since an unmigrated application already reads as it would store it.

## Consequences

- A rule about a move between states is written once, in the owner, and a second writer is a failing test rather than a bug found by a reviewer.
- A state nobody designed cannot be written: an event the table refuses from the state read writes nothing, and a stored status no state names is refused as it is read.
- A verdict must say what the reviewer saw (`seen`), since the event is held on it; the route refuses one that does not.
- The applicant's save now holds what it read, as an import row does: a verdict landing inside it is read again, three times, and then the applicant is asked to save again (409).
- A corrected answer from the file or the applicant sends a verdict back where before only a re-import's change of an answer the solver reads did ([ADR 0011](0011-re-import-upserts-on-market-and-email.md#superseded)); an organizer's own update never does.
- An application can no longer come back into open in nobody's share: the move and its mark are one update, and a request ended before its deal leaves the mark for the next.
- The owner and `api/applications.py` import each other, and neither reads the other at import.
- A test that patches a write patches `ReviewState`, and one that rebinds the collection still rebinds `ApplicationsApi.applications_collection`.
- An application stored with no status, or `under_review`, holds Begin assignment like any open one, and a card in nobody's share is served so: no screen can warn that it is dealt to a reviewer who was removed.
- Every organizer read takes the view its route built, with no default, so a test calling one directly builds a view by hand.
- An application left waiting before every move was marked is dealt by the next deal after the migration runs, and the market's history says it was dealt "having waited for the deal", true of one in nobody's share and of a follow-up still in its chosen reviewer's alike; until then it is served waiting.
- A card in nobody's share says "Reviewer: not dealt yet" on every screen, and warns of no one: an open one whose reviewer was removed, or that arrived while nobody chosen was able, or a follow-up whose owner holds no role on the market and whose reviewer is not chosen.
  A follow-up whose owner holds no role but whose reviewer is chosen waits too, yet stays in that reviewer's share, so it names them and warns of them, as every other reader of its share does (Daniel's answer of 2026-11-18).
- A screen's every new reader of the state reads `review`, so the unit tests and the component library's fixture carry it too; a fixture without it fails the type check.

## Considered and rejected

- **Keeping each writer's own conditions** (the eight writers T277 found): every new writer would have to know every rule the others keep, which is how applications fell out of every share.
- **A scan for owned field names as strings**, as `account_secrets` is guarded ([ADR 0028](0028-an-accounts-sign-in-secrets-are-one-machine.md)): `status` and `reviewer` are read everywhere, and a filter must name them, so only a walk of what each write writes tells a writer from a reader.
- **A status per combination** (eleven values already, five of them written): who gave a verdict, and how the application came, would multiply the statuses every reader spells out; the state is read off the fields instead.
- **Judging at the move whether the application needs dealing**: whether its reviewer may still review is the deal's question, answered while it holds the market; asked at the move, it races a change of reviewers ([ADR 0020](0020-an-application-is-dealt-to-one-reviewer.md#considered-and-rejected)).
- **Each route deciding its own move**: the review route, the undo, the rules and the follow-up's hand-on each kept the conditions of their write, which is how the eight writers came to disagree; a pure `move` is the one answer a preview and a write share.
- **Keeping origin as a reading of `added_by`**: the record of who added a vendor cannot also say they have applied since, so an added vendor a re-import brought in stayed out of the run; clearing `added_by` would lose who added them.
- **An answers write per source** (the applicant's, the import's, the organizer's, each deciding what a change does): three writers deciding the same question three ways is what T277 found; one event with the source as a value says once which change undoes which verdict.
- **The front end deriving the state from the status**, as each screen did before: the queue, One by one's counts, the All view's filters, the card's warning, the vendors list, the Stats tab, the export and the guard each held their own list, and "undecided" had four meanings among them, which disagreed with the server and with each other on an old spelling of open and on a status the old offers flow left behind, so the same application read differently on two screens.
- **Serving the share by who is able to review** (an open application's share only while its reviewer may still review): a chosen reviewer who can no longer review here keeps their share until an Admin removes them ([the dealing rule](../business/rules/the-review-is-dealt-among-chosen-reviewers.md)); a share by ableness would take it away silently, showing their work as not dealt yet, and the migration would deal it away.
- **Moving the collection's binding into the owner**: every fake and the real-MongoDB world would rebind two names, and the storage contract would leave the module that owns it.
- **A boot marker for the migration**, as a change of a stored shape the app could not read has: the owner reads every unmigrated application as the migration would store it, so a release that refused to boot until it ran would only stop the market for nothing.
- **The migration judging who is able on its own** (an open application dealt to a chosen reviewer who may no longer review, marked): it would deal that reviewer's share away silently; it marks what `is_waiting` reads, and leaves ableness to the deal.
