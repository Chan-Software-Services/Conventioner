---
layer: implementation
kind: data
describes:
  - back-end/api/applications.py
  - back-end/datatypes.py#Application
  - back-end/datatypes.py#ApplicationStatus
  - back-end/datatypes.py#ApplicationType
  - back-end/datatypes.py#VerdictGiver
  - back-end/datatypes.py#MarketPerson
  - back-end/datatypes.py#AnswerUpdate
  - back-end/migrations/create_applications_collection.py
  - back-end/migrations/migrate_submitted_at_to_iso.py
  - back-end/application_status.py
  - back-end/tests/test_one_writer_of_the_review_state.py
  - back-end/tests/test_the_review_state_table.py
  - back-end/tests/test_changed_answers_are_one_event.py
  - back-end/datatypes.py#ApplicationOrigin
verified: 2026-11-18
sources:
  - wayfinding/v0-1-0/map
  - wayfinding/real-market-readiness/01
  - E01/F04/S02
  - E26/F07/S01
  - E33/F03/S02
  - E34/F01/S01
  - E34/F02/S01
  - E34/F03/S02
  - E36/F03/S01
  - E41/F01/S01
  - E38/F07/S02
  - E38/F07/S03
  - E41/F01/S02
  - E46/F01/S05
  - T263
  - T270
  - T429
---

# The application document

One document per application in the `applications` collection: a vendor's answers to one market's form, and where review has got to with them.
[`back-end/api/applications.py`](../../../back-end/api/applications.py) is the single owner of the collection, and every reader and writer goes through it, so the storage contract lives in one place.
Its review state is the one exception: every write of `status`, `verdict_by`, `verdict_at`, `verdict_reason`, `follow_up_owner`, `undo_to`, `added_by`, `added_at`, `origin`, `arriving` and `reviewer` is [`back-end/application_status.py`](../../../back-end/application_status.py)'s (imported as `ReviewState`, [ADR 0037](../../adr/0037-an-applications-review-state-has-one-owner.md)), through the collection `api/applications.py` binds, which keeps the reads, the claim's writes, the deletes and the indexes.
[`tests/test_one_writer_of_the_review_state.py`](../../../back-end/tests/test_one_writer_of_the_review_state.py) fails a write of any of those fields anywhere else.
The model is `Application` in [`back-end/datatypes.py`](../../../back-end/datatypes.py).

The glossary concepts: [Application](../../business/concepts/application.md) and [Essential question](../../business/concepts/essential-question.md).

## Key spelling

**Applications are stored snake_case**, unlike markets, which are camelCased on write ([the market document](market-document.md#key-spelling)).
The market foreign key is `market_id`, NOT `marketId`.
A writer that stored the market reference under any other key would silently disable [the application form lock](../../business/rules/the-form-locks-at-the-first-application.md): the count it reads (`count_applications_for_market`) would just return 0.
The organizer's and the applicant's views camel-case an application on the way out; the stored document never is.

## The fields that matter

| Field                                        | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                         | a UUID, the primary key                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `market_id`                                  | the market it belongs to                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `applicant_email`                            | the applicant, stored lowercased and trimmed by every writer ([users and email](users-and-email.md)); proven by a sign-in code on the online path, asserted by the file on an import, and nothing here says which ([an imported email is asserted](../../business/rules/an-imported-email-is-asserted.md))                                                                                                                                                                                                                                                                         |
| `application_type`                           | `main`, or `waitlist` for a second application beside it (`main_application_id` names the main one)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `form_data`                                  | the answers, keyed by form field key; the essential questions' answers under their reserved `essential_*` keys                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `answer_updates`                             | an organizer's updates of the answers, by form field key ([below](#an-organizers-update-of-an-answer)); absent or empty where none was made                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `status`                                     | where review has got to (below)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `submitted_at`                               | ISO 8601; the first save's time, kept through later edits                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `updated_at`                                 | when the answers as they read last changed, by the vendor, a re-import or an organizer's update; a verdict is conditioned on it                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `verdict_by`, `verdict_at`, `verdict_reason` | who gave the verdict (`{kind: person, user_id, email}` or `{kind: rule, rule}`), when, and a rule's reason in the organizer's words, never shown to the applicant                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `follow_up_owner`                            | who is reaching out, while the status is `needs_follow_up`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `undo_to`                                    | what its giver's undo returns it to (E38/F10/S01): its `status`, `verdict_by`, `verdict_at` and `follow_up_owner` as a person's verdict or follow-up found them while it awaited one (open, or needing a follow-up); never served, and cleared by every other status written ([the review state](#the-review-state)); a follow-up handed on or an answer updated keeps it, as neither changes what the verdict found                                                                                                                                                               |
| `held_by`, `held_until`                      | the reviewer looking at it, and until when: a five-minute lease, renewed while the card stays open                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `added_by`, `added_at`                       | who recorded a vendor who never applied, and when; kept once their answers arrive since                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `origin`                                     | how it came to the market, apart from its verdict: `applied`, `imported` or `added` ([below](#the-states-and-how-they-are-stored)); absent on one stored before it was kept                                                                                                                                                                                                                                                                                                                                                                                                        |
| `arriving`                                   | an application waiting for the deal, `{actor, action}`: the write that moved it into open or a follow-up (`Arrival`), for the deal's history entry; set by that move's own update whether or not reviewers are chosen, and cleared as the deal deals it to a reviewer or leaves it where it is, or as a verdict is given, so no move into open is left in nobody's share ([waiting for the deal](#waiting-for-the-deal))                                                                                                                                                           |
| `reviewer`                                   | whose share it was dealt to (`{user_id, email}`), absent when it never was, and on an open one a choice of no reviewers took back to first come, first served ([the review is dealt among chosen reviewers](../../business/rules/the-review-is-dealt-among-chosen-reviewers.md)); written only by the deal, `deal` for an open application and `deal_follow_up` for a follow-up handed on, which sets `follow_up_owner` with it ([the deal](#the-deal)); a verdict never clears it, so it stays the record of whose share it was; not who is looking at it now, which is `held_by` |

A vendor's names are answers in `form_data` too; `vendor_names_for_market` reads them as one map from address to the name to call each vendor ([a vendor is called by their chosen name](../../business/rules/a-vendor-is-called-by-their-chosen-name.md)).
Every map from address to answers (`_answers_by_address`) reads a vendor holding a main and a waitlist application by the main one's answers, whichever the query returns last, so their name, the search's terms, the public map's answers and the answers their price group is read from (`vendor_answers_for_market`) never come from the waitlist application.

Form field keys are held to `^[a-z0-9_]+$` (`FORM_FIELD_KEY_PATTERN` in `datatypes.py`) because they become keys inside `form_data`, where a dot or a leading `$` cannot be addressed by Mongo update operators.

**`submitted_at` is what first come, first served orders by**, and the review queue's arrival order too.
An applicant's first valid save stamps it ([`back-end/application_write.py`](../../../back-end/application_write.py)); **a CSV-imported row must carry its own**, or it gets the time of the import and first-come-first-served decides nothing.
**A submission time becomes a moment at import**: the import normalises the form's timestamp to ISO 8601 at the boundary (`normalized_submitted_at` in [the CSV import](../modules/csv-import.md)), so every reader compares one stored shape.
The applicant's own save already wrote ISO; only the import disagreed, and converting at each reader instead would keep two stored shapes alive and fix only the reader someone remembered.
A mapped timestamp that is not a time refuses its row, naming the value, rather than sorting last in silence; an unmapped one refuses nothing, since the column is optional, and the import warns instead when a priority rule orders by arrival.
[`migrate_submitted_at_to_iso.py`](../../../back-end/migrations/migrate_submitted_at_to_iso.py) rewrote the raw `9/12/2025 18:22:56` values imported before that, which sorted wrongly as strings and scored every vendor alike in the solver.
It has no boot marker: a raw timestamp misorders in plain sight, and the marker is for a hazard nobody can see.

## An organizer's update of an answer

**An update is stored beside the vendor's answer, never over it** ([an update is kept beside the vendor's answer](../../business/rules/an-update-is-kept-beside-the-vendors-answer.md)): `answer_updates` maps a form field key to an `AnswerUpdate`, `{value, by, at, over}`, the value read, who made it (`{user_id, email}`), when, and the vendor's answer it was made over.
`form_data` stays the vendor's: only their own save and an import write it, so a re-import writes the file's answers there and leaves every update standing.
Writing over `form_data` instead would last until the next re-import.
The update is the review state's answers-changed event for an organizer (`answers_changed` with source `organizer`, [below](#changed-answers)), which sets and unsets each update by its own dotted path and holds nothing, so two organizers updating different answers at once both land.
It sets `updated_at` to now in the same update, since an update changes the answers every reader reads, and `updated_at` is the answers' version a verdict is conditioned on: a verdict on a card opened before the update is refused (T270); with nothing to set or unset it writes nothing.

**`effective_answers` is the one reader of the answers as the organizer reads them**: `form_data` with each update's value in its place.
The organizer's views (`formData` in `_application_response_organizer`, beside `answerUpdates`), the results search and the names (`_answers_by_address`), the vendor export (`Vendor.answers` in `api/vendor_export.py`), the Stats tab's answer counts (`market_stats.py`), the price groups (`vendor_answers_for_market`, [a price follows the table](../../business/rules/a-price-follows-the-table.md#price-groups)), the [automatic rejections](../../business/rules/automatic-rejections.md), the solver's input (`_solver_vendor` in `assignment/vendor_input.py`, and so the placement warnings and what a run was made from), the empty-tier check (`NoAskedForTierWithoutTablesGuard`), the table-share notice (`_share_request` in `api/applicants.py`) and the vendor's request beside the notes (`get_vendor_notes`) read through it, and so does any reader added later that calls it.
A reader that wants one answer from each of a market's applications reads only that answer (`list_applications_with_answers`): each application's `id` and the `form_data` and `answer_updates` entries of the keys asked, a projection, so [the Discord connection](../modules/discord.md#who-is-in-the-server)'s shown-vendors read does not ship every application's whole `form_data`, and `effective_answers` still reads the partial documents.
The applicant's own view serves `form_data`, what they wrote, and no update.
A re-import still compares the file with `form_data` (`csv_import._unchanged`): whether the vendor's own answer changed is the question there, not how it reads.

`answerUpdates` serves each update with `theyWrote`, the vendor's answer now, and `changedSince`, whether that differs from `over`: a re-import or their own edit changed it after the update, which the drawer says.
[`back-end/api/vendor_info.py`](../../../back-end/api/vendor_info.py) makes the update (`PUT /markets/:id/applications/:app_id/answers`): it validates each answer as the form does (`validated_answer` in `application_write.py`, and `validated_essential_update` in `essential_fields.py` for an essential question), refuses a key the form does not ask, takes an update away when its answer is set back to what the vendor wrote, and keeps an update restated as it stands, with who made it; restated over an answer the vendor changed since, the update is kept over what they wrote now, by whoever saved it, and recorded as kept.

## The review state

The applicant never reads a status: their page reads "Submitted" until results are published, then an outcome read off the stored seats ([an applicant never reads a verdict early](../../business/rules/an-applicant-never-reads-a-verdict-early.md)).

Every function this section names is in `application_status.py`, the review state's owner ([ADR 0037](../../adr/0037-an-applications-review-state-has-one-owner.md)).
This section states the transition table once; every other node points here rather than restate a transition.

### The states, and how they are stored

An application is in one of six states (`State`), read off the stored fields by `state_of`, the rule the review state's own events read, while the deal's pool and the claim, and readers outside the owner such as Begin assignment's guards, the Stats tab and the export, still filter on the stored status; no state is stored itself, so no stored status changes its spelling:

| State              | Stored as                                                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `open`             | `status` `open`, `under_review` (from before, never written now), or no status at all                                                                                    |
| `follow_up`        | `needs_follow_up`, owned by `follow_up_owner`, who must reach out first ([needs follow-up](../../business/rules/needs-follow-up.md))                                     |
| `approved(person)` | `reviewer_approved`, by a person                                                                                                                                         |
| `approved(added)`  | `reviewer_approved` on an application added by hand (`origin_of` is `added`) that never applied                                                                          |
| `rejected(person)` | `reviewer_rejected`, by a person                                                                                                                                         |
| `rejected(rule)`   | `reviewer_rejected` whose `verdict_by.kind` is `rule`, with the rule's reason in `verdict_reason` ([automatic rejections](../../business/rules/automatic-rejections.md)) |

`ApplicationStatus` names eleven values, and five are written: `open`, `reviewer_approved`, `reviewer_rejected`, `needs_follow_up`, and `vendor_refused`, written only by `sweep_offers`, which moves every `assignment_sent` application to it and stands outside the table, since nothing enters the offers stage.
The statuses of the old offers flow read as what it reached them from (decision 9.6 of T277's report): `unassigned`, `assigned`, `assignment_sent`, `vendor_accepted` and `vendor_refused` as the approval they carried, and `cancelled` as a person's rejection, as the table-share notice already counts it with the rejected as not taking part.
A status no member names is refused, as reading the application would refuse it, and the table-driven test walks every member, so a status added later fails until it is placed.
`is_undecided` (open or follow-up), `is_decided` (the other four) and `is_judgeable` (open, or a rule's rejection) are read off the state, never off a list of statuses.
What a reviewer saw is read by `saw_decided`, which never refuses: a `seen` whose status no member names is nothing they could have seen, so the verdict held on it matches nothing and is answered as changed since they opened it.
Its times, `verdict_at` and `updated_at`, are read as a string or null only, and a `seen` naming one of any other type matches nothing in the same way.

**Where an application came from is its own axis, apart from its verdict**: `origin` (`ApplicationOrigin`) is `applied` (the applicant's first save), `imported` (an import row's create) or `added` (adding a vendor), stored by `arrive` and `add` and moved by changed answers (below).
`origin_of` reads it, and for one stored before the origin was kept, `added` when `added_by` is set, else `imported` on a market whose vendors are imported and `applied` on one whose vendors apply (with no intake given, `applied`, since only "added or not" changes behaviour).
Every back-end reader asking "did they apply" asks `is_added`, never `added_by`: the run's input (`approved_solver_vendors`), the export's "Added by hand", the Stats tab's added-by-hand count and `addedByHand` on the placement read; the organizer's view serves `origin`.
Readers naming who added someone read `added_by`, which stays the record of it.

### The transition table

Each cell names the state after an event, or "refused"; `TABLE` holds the states each event moves from, and `move(doc, event)` where it takes them.
"Marked" means the same update marks the application for the deal ([waiting for the deal](#waiting-for-the-deal)).

| From \ event       | give verdict (a person)        | change verdict              | undo (its giver, in the window)          | rule rejects                            | rule returns   | hand on the follow-up        | answers changed by the applicant or an import          | answers changed by an organizer           |
| ------------------ | ------------------------------ | --------------------------- | ---------------------------------------- | --------------------------------------- | -------------- | ---------------------------- | ------------------------------------------------------ | ----------------------------------------- |
| (none)             | -                              | -                           | -                                        | -                                       | -              | -                            | arrives `open`, origin `applied` or `imported`, marked | -                                         |
| `open`             | to the verdict, `undo_to` kept | refused                     | refused                                  | `rejected(rule)`                        | refused        | refused                      | `open`                                                 | `open`                                    |
| `follow_up`        | to the verdict, `undo_to` kept | refused                     | to `undo_to` (open or follow-up), marked | refused                                 | refused        | follow-up, new owner, marked | `follow_up`                                            | `follow_up`                               |
| `approved(person)` | refused                        | to any verdict or follow-up | to `undo_to`, marked                     | refused                                 | refused        | refused                      | `open`, marked                                         | `approved(person)`                        |
| `approved(added)`  | refused                        | to `rejected(person)` only  | refused                                  | refused                                 | refused        | refused                      | approved, its origin moved to `applied` or `imported`  | `approved(added)`                         |
| `rejected(person)` | refused                        | to any verdict or follow-up | to `undo_to`, marked                     | refused                                 | refused        | refused                      | `open`, marked                                         | `rejected(person)`                        |
| `rejected(rule)`   | refused                        | to any verdict or follow-up | refused                                  | again, only with another rule or reason | `open`, marked | refused                      | `rejected(rule)`, then the caller's rules judge it     | `rejected(rule)`, then the rules judge it |

- The review route picks give or change by what the reviewer saw (`seen`): an undecided state gives, a decided one changes, and only a change asks the table's change row (E38/F06/S01), so a person's verdict over a rule's rejection is a change, refused to someone who may not change verdicts, as [what each role may do](../../business/rules/what-each-role-may-do.md) reads.
- A change of an added vendor's approval to anything but a rejection answers 400 "A vendor added by hand can only be rejected." (`ADDED_ONLY_REJECTED`); every other refused cell answers as its route always has: the change row's 403, the undo's `UNDO_REFUSED`, the hand-on's 409 "Only an application that needs a follow-up has an owner.", and a rule simply writes nothing.
- A rule's rejection meets the answers again with another rule or reason, so the reason shown is the rule that meets them now; with the same rule and reason nothing is written.
- An undo exists only for a verdict given on an application awaiting one: only that verdict keeps `undo_to`, `undo_to_of` of the state it found, and only the person `verdict_by` names may undo it, within `UNDO_WINDOW` of `verdict_at` (`undoable_by`); a change of verdict keeps nothing to undo.
  It writes `undo_to` back whole and clears it, so an open application comes back with no giver and a follow-up marked and owned as it was, and a request never names what it returns to ([what each role may do](../../business/rules/what-each-role-may-do.md#where-it-is-kept)).
- A follow-up marked again by a person is a give from `follow_up`, which may name a new owner, and keeps the follow-up it found as `undo_to`; handing one on keeps `undo_to`, so its marking can still be undone.
- Every write that leaves open or follow-up for a verdict clears `arriving` and the claim; every move to open clears the verdict's giver, time and reason, the follow-up's owner, `undo_to` and the claim; a verdict never clears `reviewer`, which stays the record of whose share it was.
- Verdicts are given while the market can still reach review, and settle when it enters assignment ([verdicts settle on entering assignment](../../business/rules/verdicts-settle-on-entering-assignment.md)): "once the review is closed every event is refused" is each route's own check, and the owner reads no phase.
- An application arrives by the applicant's first save or an import row's create (`arrive`): open, with its origin, marked by its `Arrival`; adding a vendor (`add`) is an event from "(none)" alone, to `approved(added)` with origin `added`, unmarked, and answers None when the market already holds an application for the address, which the route refuses.
- Changed answers are one event whoever changes them ([changed answers](#changed-answers)).

### Each event holds what was read

Each event is one function (`give_verdict`, `change_verdict`, `undo`, `rule_rejects`, `rule_returns`, `hand_on_follow_up`, `answers_changed`), taking the application as the caller read it, and writes its `move` as one update held on the status and the verdict's time as read (null and absent alike), so a write landing in between is never written over ([ADR 0014](../../adr/0014-reviewers-claim-and-a-verdict-is-a-conditional-write.md)).
A verdict, a person's or a rule's, holds the answers' time (`updated_at`) too, so neither another reviewer's verdict nor answers changed since, a re-import's or an organizer's update, are written over; a person's verdict holds them as they saw them, `seen`, which the review route requires ("Say what the application was when you opened it."), and a selection's entry without it is skipped with that reason.
A verdict given keeps `undo_to` and holds the follow-up's owner as read too, so what is kept is what was there.
A hand-on holds only that it still needs a follow-up.
Changed answers hold the status and the verdict's time alone, and an organizer's update holds nothing ([changed answers](#changed-answers)).
An event answers whether it was written, or `Refused` when the table refuses it from the state read, falsy as a write that did not land, with the table's own words where it has some.
`move` is pure, so the table-driven test ([`back-end/tests/test_the_review_state_table.py`](../../../back-end/tests/test_the_review_state_table.py)) and the writes read one answer.

### Changed answers

The applicant's save, an import row and an organizer's update write the answers through one event, `answers_changed(read, source, answers, arrival)`, which adds its `move` to the answers the caller built and writes both as one update, so no stop between the answers and the state can leave a vendor approved on answers nobody read, nor open in nobody's share (Daniel's decision 9.1 of T277's report):

- by the applicant or an import, a person's approval or rejection goes back to `open`, clearing what every move to open clears, marked for the deal by the write; nobody judged the answers as they read now;
- an added vendor stays approved and becomes an applicant: their origin moves to `applied` or `imported`, so the stored approval reads as `approved(person)`, given by whoever added them, and the run reads them (T277 P7);
  the origin moves in whatever state the added vendor is, so one whose approval was changed to a rejection goes back to `open` as an applicant and is approved by a person when approved again;
- a rule's rejection stays, and the caller's rules judge it after the write, returning it to open or rejecting it again by the rule that meets it now;
- open and follow-up stay; answers saved as they already stand move nothing; an application stored with no status is given the `open` it reads as;
- an organizer's update keeps every verdict, since they made both, and holds nothing.

The applicant's and the import's write is held on the status and the verdict's time as read, so it never lands under a verdict given after the read: `record_application_answers` answers `ANSWERS_MOVED`, and the caller reads the application again and writes on what is stored then, three times (`ANSWER_TRIES`); then an import row is left out with `CHANGED_WHILE_IMPORTED` ([the CSV import](../modules/csv-import.md)), and the applicant is answered 409 "Your application changed while it was saved. Save again.", a sentence that names no verdict, since an applicant never reads one.
"While the review is open" needs no check in the event: the applicant saves only in Applications and an import runs only in draft and Applications.
The applicant's history entry says `returned_to_review: true` when their save sent a verdict back to open, which the history reads as ", which sent it back to Open"; the import's entry counts `returned_to_review`.
The import's preview reads the same `move` for each row it would write, so its "will return to review" and "keeps its verdict" counts are what the import then does ([importing a Google Form's responses](../../business/flows/import.md#h2h-import-a-later-export)).
[`back-end/tests/test_changed_answers_are_one_event.py`](../../../back-end/tests/test_changed_answers_are_one_event.py) drives each source through its route: a verdict sent back or kept, a save read again under a verdict and refused after three, and a save cut short after its write.

The claim on the next card is held on the status the queue read as well as on the claim (`claim_next_for_review` in `api/applications.py`), so a card decided between the queue's read and its claim is passed over, never handed as if it were open (T277 P4).

### The deal

The deal hands open applications out among the reviewers chosen for a market ([the review is dealt among chosen reviewers](../../business/rules/the-review-is-dealt-among-chosen-reviewers.md), and [ADR 0020](../../adr/0020-an-application-is-dealt-to-one-reviewer.md) for why it works this way).
[`back-end/review_team.py`](../../../back-end/review_team.py) decides whom each application goes to, holding the market, and writes the turn; its writes to an application are three functions here, `deal`, `deal_follow_up` and `settle_waiting`, each called only from there while its deal holds the market.
This section is the one description of how the deal writes; every other node points here.

#### Waiting for the deal

Every move into open, an undo back into a follow-up, and a follow-up's hand-on mark the application for the deal in their own update (`arriving`, the `Arrival` it came by: who, and by which action): an arrival, an undo (into open or back into a follow-up), a rule's return, a re-import's or an applicant's back to review and a follow-up's hand-on (T277 P1, P2, P3, P5).
A follow-up a person gives, from open or as a change of verdict, keeps whatever mark it had; every other verdict, a rule's included, ends the wait.
It marks whether or not reviewers are chosen and whoever its reviewer is: who may review is judged only by the deal holding the market, so a move landing after a change of reviewers read its pool is still marked, and that change deals it as it lets go.
The write then asks for the deal, and a request ended between its move and that deal leaves the mark, which the next deal takes.
With no reviewers chosen nothing deals, and the marks wait for the deal a choice of reviewers makes.

#### A deal holds the market

Every deal holds the market by a lease on its team (`reviewTeam.dealing`, `{by, until}`, on [the market document](market-document.md)), taken only while no other deal's lease stands and running out after 30 seconds, so a deal that stopped half way lets the next one in.
A change of reviewers holds it from writing its team to writing its turn, and a deal of what waits from reading the turn to writing it, so the turn is only ever read and written by the one deal holding the market, and no order of a change and a move deals an application twice or skips a reviewer.
Every write a deal makes to the market names its lease and reads whether it matched, so one whose lease ran out is never written as if it held the market: a change of reviewers is then refused with "The reviewers are being dealt applications right now. Try again in a moment.", and a deal of what waits logs that its applications are dealt and the turn did not move on.
A change of reviewers waits up to about five seconds for another deal to let go, and is refused in the same words if none does.
A move never waits: its application is marked before its write tries to hold the market, so it deals every marked application if it can hold the market, and if another deal holds it, that deal deals them, since every deal looks for marked applications after letting go.
It looks again for as long as any wait, it can hold the market and its last round dealt or settled one, however long a burst of moves runs, and once more after a round that failed, before that round's error goes on.
A lease nobody let go, from a deal the host ended, runs out on its own, and what it left marked is dealt by the next deal, which a reviewer's next card starts at the latest (`deal_waiting`).

#### What a deal writes

The deal of what waits takes each marked application in arrival order, with the roles read with the turn:

- one decided since it was marked waits no longer, its verdict kept (`settle_waiting`);
- an open one whose reviewer is an able chosen reviewer keeps them, the turn unmoved (`settle_waiting`);
- any other open one is dealt to the able reviewer the turn names, the turn moving on by one (`deal`);
- a follow-up whose owner may still own one here keeps its owner (`settle_waiting`): anyone with a role on the market, whom an organizer may pick as its owner (`people_with_market_role`), whether or not they may be chosen to review;
- any other follow-up is handed on, as its owner and its reviewer, to the able reviewer the turn names (`deal_follow_up`);
- with nobody chosen able, an undecided one stays marked, and the next deal deals it once someone is: a reviewer's next card starts one, so does every move and every change of reviewers.

A change of reviewers reads the team again once it holds the market, writes the new team with its turn reset, and deals its pool round robin from the first able reviewer, in arrival order: every open application, those waiting for the deal included, and every follow-up whose owner it removed, which is handed on, still a follow-up, as its owner and its reviewer (`deal_follow_up`).
It writes nothing for an open application already dealt to whom the turn names, a decided application, or a follow-up whose owner is still chosen or never was a reviewer; its last write sets the turn to the pool's size, or to 0 when nobody it chose is able, in which case it deals nothing.
Choosing nobody takes every open application back to first come, first served (`deal` with no reviewer), and every follow-up stays with its owner.
Having let go of the market, it deals what waits, as above.

The three writes, each held on the application as the deal read it, so a move landing in between is never written over:

- `deal` writes an open application's `reviewer`, only while it is still open (`open` or `under_review`) and still dealt to whom the deal read; dealt to a reviewer it ends the wait, and dealt back to first come, first served it unsets `reviewer` and leaves the mark;
- `deal_follow_up` sets a follow-up's `follow_up_owner` and `reviewer` both to the reviewer it is dealt to, keeping its status, and ends its wait, only while it still needs a follow-up from the owner the deal read;
- `settle_waiting` ends the wait of one the deal leaves where it is, only while its status and its mark are still as the deal read them, so a move landing in between keeps the mark it wrote for the next round.

The deal of what waits records under the write that marked each application, and a change of reviewers under whoever chose them; each entry names the reviewer before as stored, and a follow-up's owner before ([the market's history](history.md)).

### Added vendors, and what is recorded

A vendor added by hand is stored `reviewer_approved` with `added_by` and origin `added`, holding only their name and their answers to the questions the price groups read in `form_data`; the solver run never reads them while their origin is `added`, and they are seated by hand ([adding a vendor who never applied](../../business/rules/adding-a-vendor-who-never-applied.md)).
An application is also what a seat needs: a placement names an applicant or is refused ([a seat only for an applicant](../../business/rules/a-seat-only-for-an-applicant.md)).

**Each verdict or follow-up a person gives, each follow-up handed on, each vendor added, each update of a vendor's answers and each change an applicant makes to their own application records into [the market's history](history.md)**: the verdict fields here stay the state the review reads, and the history keeps every verdict a person gives, not only the latest.
A rule's verdict is not an entry of its own: the write that judged counts it in its entry (the form, the rules, an applicant's save, an import).

## Indexes

**`(market_id, applicant_email, application_type)` identifies an application, and the database enforces it:** the unique index `market_applicant_type_unique`, built by `ensure_application_indexes()`.
Creating one is a read-then-insert on a public endpoint, so two concurrent saves for a new address would otherwise both insert, leaving an orphan that sits on the organizer's list and double-counts through review, assignment and the form lock.
`arrive()` and `add()` (in `application_status.py`, since the document they create holds the review state) are one conditional upsert against that index: `arrive` returns the winner's document when it loses the race, and `add` answers None, so adding never writes over an application; an applicant's first valid save creates theirs through `arrive` ([a vendor signs in before applying](../../business/rules/a-vendor-signs-in-before-applying.md)), and so does an import row.
`app.py` builds the index at boot and refuses to start when it cannot (`verify_application_indexes`); the likeliest cause is duplicates already stored, which the refusal names by application id, never by address, and which have to be merged by hand ([Operations](../../OPERATIONS.md#when-the-back-end-refuses-to-boot)).
The index's `market_id` prefix serves every read of a market's applications; `id` is a [lookup index](lookup-indexes.md).

[`migrations/create_applications_collection.py`](../../../back-end/migrations/create_applications_collection.py) creates the collection, a `market_id` index and the identity index on an older deployed database, and with `--dry-run` names any applicant holding two applications.
`mongo-init.js` creates the collection and the `market_id` index on a fresh volume.
Two migrations reshape stored answers for the essential questions: `migrate_tier_preference_per_date.py` and `migrate_table_share_answer.py`.

## With its market

An application belongs to its market for life: `delete_applications_for_market` takes every one with the market ([`back-end/market_deletion.py`](../../../back-end/market_deletion.py), [market deletion](../modules/market-deletion.md)), and `delete_application` exists only to undo a create whose answers were then refused.
