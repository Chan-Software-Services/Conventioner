---
layer: implementation
kind: adr
describes:
  - back-end/review_team.py
  - back-end/datatypes.py#ReviewTeam
  - back-end/application_status.py#deal
  - back-end/application_status.py#settle_waiting
verified: 2026-11-18
sources:
  - E38/F07
  - E38/F07/S01
  - E38/F07/S02
  - E38/F07/S03
  - E38/F07/S04
status: accepted
---

# An application is dealt to one reviewer, and the review's record is the market's history

The nodes it constrains: [the review is dealt among chosen reviewers](../business/rules/the-review-is-dealt-among-chosen-reviewers.md), [the application document](../implementation/data/application-document.md) and [the market document](../implementation/data/market-document.md).

## Context

A market's applications are reviewed by a team, and every reviewer worked the same queue, first come, first served.
Nobody could be given a share ahead of time, so a team of four starting on 200 applications had no way to say "these 50 are yours", and nobody could tell afterwards who was meant to decide which.
The one person an application named was a follow-up's owner, and its document kept only its latest verdict; who had it before was the market's whole history to answer.
The model carried an `assigned_reviewer_id` on the application and an untyped `review_config` on the market, which nothing ever wrote.

## Decision

**An application carries its reviewer, and a market its review team.**
`reviewer` on the application (`{user_id, email}`, `Application` in [`back-end/datatypes.py`](../../back-end/datatypes.py)) names whose share it was dealt to, and a verdict never clears it, so it stays the record of whose share it was.
It sits beside the hold of [ADR 0014](0014-reviewers-claim-and-a-verdict-is-a-conditional-write.md): the hold is who is looking at it now, the reviewer is whose share it is, and a deal never moves a hold.
`reviewTeam` on the market (`{reviewers: [{userId, email}], turn}`) is the chosen people in the order they are dealt to, by address, so the deal is the same whoever chose them, and `turn`, how many applications were dealt since they last changed.
Absent, both read as before this existed: no reviewers, first come, first served, and no migration.
`assigned_reviewer_id` and `review_config` are gone.

**The deal is strict round robin, in arrival order.**
One module, [`back-end/review_team.py`](../../back-end/review_team.py), decides both fields; the writes of an application's `reviewer` are [`back-end/application_status.py`](../../back-end/application_status.py)'s, called only from there ([ADR 0037](0037-an-applications-review-state-has-one-owner.md)).
Choosing reviewers stores the team with its turn reset, then deals every open application (the state `open`, as [ADR 0037](0037-an-applications-review-state-has-one-owner.md) reads it) round robin from the first reviewer in the order they arrived, and sets the turn to how many it dealt; the first reviewers in address order take the remainder, and the next arrivals go first to those who got one fewer.
A deal never counts what each reviewer has left open.

**Every deal holds the market, so the turn has one writer at a time.**
The invariant: the turn always counts the applications dealt since the reviewers last changed, so the next arrival goes to the reviewer after the last one dealt, an application arriving is dealt once, and no reviewer is skipped, whatever order a change of reviewers and arrivals land in.
It holds by construction rather than by conditions on each write, which four rounds of review each found one more order to break (the turn taken before the application was won, a change landing after the turn, an emptied team, a turn taken inside a change).
A deal holds the market by a short lease on the team (`reviewTeam.dealing`, 30 seconds, so one that stopped half way lets the next in): a change of reviewers from writing its team to writing its turn, and a deal of arrivals from reading the turn to writing it, so the turn is only ever read and written by the deal holding the market.
An arrival never waits: its application is marked as waiting for the deal (`arriving` on the application, with the write it arrived by), and if it can hold the market it deals every application so marked; if another deal holds it, that deal deals them when it lets go, since an application is marked before its write tries to hold and every deal looks for marked applications after letting go: for as long as any wait and its last round dealt or left one, however long a burst runs, and after a deal that failed as well, before its error goes on.
**Every move into open, and a follow-up's hand-on, is marked, not only an arrival** (T277): an undo, a rule's return, a re-import's or an applicant's back to review and a follow-up's hand-on mark their application in the same update that moves it, whether or not reviewers are chosen and whoever its reviewer is.
The deal holding the market judges who may review: it keeps an able reviewer, or a follow-up's owner who may still own one here (anyone with a role on the market, whether or not they may be chosen to review), deals the rest to the next in turn, and with nobody able leaves the mark for the next deal, which a reviewer's next card starts.
So a verdict undone after a change of reviewers, or after its reviewer was removed, is dealt as an arrival is, and no open application sits in nobody's share while an able reviewer exists.
A change of reviewers waits for the market a few seconds, and is refused in words if another deal holds it longer.
`tests/test_every_order_of_a_deal.py` proves it by enumeration rather than by picking orders: an arrival landed before every step of a change, to a new team and to none, a change landed before every step of an arrival, an arrival before every step of another, and an undo, a rule's return and a re-import before every step of a change that removes their reviewer, and that change before every step of each; every order checks that no open application sits outside every share while an able reviewer exists.
The same cases run over a real MongoDB server in `tests/real_mongo/test_every_order_of_a_deal_on_the_server.py`, where the lease's hold is also raced by ten deals at once ([the real-MongoDB suite](../implementation/testing/real-mongo-suite.md#the-market-sides-guarantees)).
Three writes in [`back-end/application_status.py`](../../back-end/application_status.py), the one writer of the review state ([ADR 0037](0037-an-applications-review-state-has-one-owner.md)), deal an application, each called only from here while its deal holds the market and conditioned on the application as that deal read it.
`deal` writes an open application's reviewer, only while it is still open and dealt as it was read, so a verdict landing mid-deal is never touched; `deal_follow_up` hands a follow-up on, as its owner and its reviewer, only while its owner is still the one read; `deal` to a reviewer, and `deal_follow_up`, end its wait, while `deal` back to first come, first served leaves the mark.
`settle_waiting` ends the wait of one the deal leaves where it is (decided meanwhile, or with an able reviewer or owner), only while its status and its mark are still as read.
A decided application stays where it is, and so does a follow-up, unless its owner is a reviewer the change removed: then it is dealt with the open applications and handed, still a follow-up, to the reviewer it goes to. An unchanged set writes and records nothing; no reviewers returns every open application to first come, first served.

**Choosing is a row of the market's table**, "Choose reviewers" (default Admin, [ADR 0019](0019-a-markets-permissions-are-a-table.md)), open while the review is (draft through the stage) and refused on an archived market.
A reviewer is chosen from the people the chooser may hand a follow-up to, so someone outside the market's organization is never offered its people.

**Being chosen is a privilege of the market's table, not a role** (E38/F07/S03, [what each role may do](../business/rules/what-each-role-may-do.md)).
A second row, "Be chosen as a reviewer, and then give verdicts and follow-ups" (`review-when-chosen`, default Viewer), says whose role may be chosen: the chooser is offered only them, and a chosen reviewer whose role it no longer reaches is served not `able` and dealt nothing new, as one who lost their role is.
An eligible chosen reviewer takes the "Give verdicts and follow-ups" row whatever that row asks of their role, so a chosen Viewer approves, rejects and marks follow-ups on any application, hands a follow-up on, and claims and is handed cards; [`back-end/api/market_actions.py`](../../back-end/api/market_actions.py) answers it in `refusal` and `role_refusal`, so every check of the giving row lets them in and no other module names a role.
The change row stays on top of the giving row ([ADR 0019](0019-a-markets-permissions-are-a-table.md), E38/F06/S01): a chosen Viewer gives first verdicts and changes none already given.
The owner raising the row to Editor takes the privilege from the chosen Viewers on that market at once, without removing them.

**The review's record is the market's history** ([ADR 0017](0017-one-history-for-every-change.md)): a change of reviewers, the deal it made and each arrival's deal are entries of their own (`reviewers`, `dealt`).
A verdict's entry names whom the application was dealt to beside who decided it (`dealt_to`), so help and mistakes can be told apart.
One application's story is the history narrowed to its vendor, in the vendor drawer's History tab.

## Consequences

- Every write that moves an application into open, and every hand-on of a follow-up, marks it in the same update ([the review state](../implementation/data/application-document.md#waiting-for-the-deal)) and then asks `review_team.py` to deal; a request ended between the two leaves the mark, which the next deal takes.
- A chosen reviewer who loses their role on the market, or whose role the table no longer lets be chosen, is skipped by every deal and served as not `able` until an Admin removes them: removing someone is always a person's act, recorded, never a side effect of a role taken away.
- Being chosen is read off the market's team by address at every check, so removing a reviewer takes their verdicts away at once, with no role to take back.
- A verdict on someone else's share is not refused: dividing the review is a soft filter, and the warning is the screen's.
- The share is also the order a chosen reviewer is handed cards in: `review/next` hands them the open applications dealt to them, and the follow-ups they own when follow-ups are asked for, first, and with `mineOnly` nothing else, so One by one can say their share is done before offering the rest (`claim_next_for_review`, E38/F07/S04); for anyone else the hand-out is first come, first served.
- Whose share an application is in, and whether it waits for the deal, are served on every application an organizer reads (`review.share` and `review.waiting`, read by `share_of` and `is_waiting` in [`back-end/review_team.py`](../../back-end/review_team.py), [the served review state](../implementation/data/application-document.md#the-served-review-state)), by the rule this record keeps: an unable chosen reviewer's open applications stay theirs, a follow-up is also its owner's while they hold any role on the market, and an open application whose reviewer is not chosen waits.
- A change of reviewers can answer 409 ("The reviewers are being dealt applications right now. Try again in a moment.") when another deal holds the market longer than it waits; an arrival never does, since it leaves its application to whoever holds the market.

## Considered and rejected

- **A history array on the application**: [ADR 0017](0017-one-history-for-every-change.md) keeps one history, and an application's story is that history narrowed.
- **Balancing by what each reviewer has left open**: it punishes the fast reviewer with more (Daniel: "we don't want to punish our viewer for being fast").
- **A random shuffle**: unpredictable, untestable, and impossible to explain to the team.
- **A hard lock on another's share**: helping someone who is behind must stay easy (Daniel: "this is not a hard filter").
- **Being chosen as a new role**: a role is market-wide and outlives the review; being chosen is per review and is lost when removed.
- **Reusing the untyped `review_config`**: it said nothing about its shape, and nothing wrote it.
- **Judging at the move who may review, and marking only what no able reviewer holds**: a move landing after a change of reviewers read its pool would judge against the team the change was replacing, and stay in the removed reviewer's share; marking every move and judging in the deal that holds the market closes that order.
- **Letting an arrival go undealt while nobody chosen may review**: it stayed in nobody's share once someone could review again (T277 P5); it waits marked instead.
- **Conditions on each write, without holding the market**: a lease on each arriving application, a turn given back when its write failed, a change letting go of what arrivals held; each round of review found one more order of a change against an arrival that skipped a reviewer or dealt an application twice, since the turn and the applications are separate documents with no transaction across them.
