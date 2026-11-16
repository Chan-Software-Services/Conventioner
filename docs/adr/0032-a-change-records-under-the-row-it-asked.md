---
layer: implementation
kind: adr
describes:
  - back-end/history.py#_record
  - back-end/history.py#unasked
  - back-end/api/market_actions.py#Asked
  - back-end/api/markets.py#_market_change
  - back-end/tests/test_only_an_asking_writes_a_markets_history.py
verified: 2026-11-16
sources:
  - T105
  - T352
  - E40/F01/S02
  - E39/F01/S01
status: accepted
---

# A change records under the row it asked

The nodes it constrains: [the market's history](../implementation/data/history.md) and [the market's actions](../implementation/modules/market-actions.md).

## Context

Every change on a market records one entry in its history, and the entry's `action` is the row of the permission table the change asked ([ADR 0017](0017-one-history-for-every-change.md), [ADR 0019](0019-a-markets-permissions-are-a-table.md)).
Until T352, nothing tied the two.
About 40 calls of the history's public writer passed their action by hand, beside a permission check made elsewhere, sometimes in another module: the review routes in `app.py` checked a row and the applicants module recorded the verdict, the placements checked Assign and the payments recorded the freed line.
A write could ask one row and record another, and only a test that sent that write and expected that action would see it.
The few records no request asks (a vendor's own check-in, the first import's move into Review) were written the same way, so nothing said which they were or why.

## Decision

**A market's history entry is written only through the asking of a permission row, or through the one door for a record no request asked** (T105-9, T352).

- A write asks its row with `ask`, and records its change through the `Asked` it returns ([`back-end/api/market_actions.py`](../../back-end/api/market_actions.py)): the entry is under that row, as that person, and recording through a refused `Asked` raises `RecordedARefusal`, a programming error.
  A write that loads its market loads through `_market_change` in [`back-end/api/markets.py`](../../back-end/api/markets.py), which asks the row and hands the `Asked` back with the market; a helper that records for its caller's check takes the caller's `Asked` (or the unasked door's recorder), never a market id and an actor: `review_team.deal_arrivals` takes the asking of the write the applications arrived by, and stores its row and person for the deal recorded through the unasked door, an applicant's own save alone dealing theirs under `APPLY` (`deal_an_applicants_own`).
- A record no request asked goes through `unasked(market_id, actor, row, because=)` in [`back-end/history.py`](../../back-end/history.py), and only the functions listed in the guard below may call it, each passing the reason that sits beside it as a constant.
- The writer itself, `_record`, is private: only the history module and `Asked.record` call it.
- [`back-end/tests/test_only_an_asking_writes_a_markets_history.py`](../../back-end/tests/test_only_an_asking_writes_a_markets_history.py) reads every server module and fails one that writes the history any other way, and plants each way to see it found.

## Consequences

- The history and the permission table cannot disagree on what a change was let through on: a change of what a write asks changes what it records with it.
- A write that asks two rows records each entry through its own asking, and a write whose row is computed (a verdict's giving or changing row, a payment's row, a role's row) records through the asking of the row it computed.
- Adding a record no request asks is a reviewed change to the guard's list, with its reason, and to `UNASKED` in `test_every_write_records.py`, which ties each such record a route reaches to a request that reaches it.
- An applicant's own change stays `record_applicant`'s: no row asks it, and their sign-in is the check.
- An organization's own history is out of this decision: its writer, `record_for_organization`, still names its verb by hand.

## Considered and rejected

- **A runtime check that the row passed equals the row asked**: it keeps two values that must agree, and a write that asks in one module and records in another would have to carry both.
- **A row named on each route, recorded by the route**: several writes record under a row computed after the route asked, and some records belong to helpers that write for more than one route.
- **The spy test alone** (`test_every_write_records.py`'s asking spy): it sees only the writes it sends, so a new path that records by hand passes until someone sends it.
