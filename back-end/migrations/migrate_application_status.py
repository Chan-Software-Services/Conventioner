#!/usr/bin/env python3
"""Bring every stored application to the review state's machine (T277 ticket 02, ADR 0037).

The review state has one owner (``application_status.py``), which reads every stored spelling as
the state it stands for (``state_of``), a missing origin by the market's intake (``origin_of``), and
an application the next deal would move as waiting for the deal (``review_team.is_waiting``).
Applications stored before it still carry the old spellings and no origin, and one left waiting by
the bugs phase 1 fixed (T277 P1, P2, P3, P5), most in nobody's share and a follow-up whose owner
holds no role on the market in its chosen reviewer's, was never marked for the deal, so no deal
will take it.

It first prints how many applications of the live markets (``tombstone.live``) are stored in each
status, Daniel's read-only count of production (decision 9.6) when run with ``--dry-run``. Then, for
each application of each live market, it stores in one update whatever still differs from what
the owner reads:

- ``under_review``, a missing status and ``""`` become ``open``;
- an old offers flow's status becomes ``reviewer_approved`` and ``cancelled`` becomes
  ``reviewer_rejected``, its giver and time kept, only when ``state_of`` reads it so as the same
  state; one it would read as another (a ``cancelled`` whose giver is a rule, which would become the
  rule's rejection) is left whole and listed;
- a missing origin is stored as ``origin_of`` reads it, the market's intake passed;
- on a market with chosen reviewers, an application ``is_waiting`` reads as waiting over the
  market's ``review_view`` and not yet marked is marked ``arriving: {actor: null, action:
  "review_state_migrated"}`` (``MIGRATED``), so the next deal on the market deals it and records it
  under that action, with no actor, through the deal's own door; the migration records nothing
  itself.

A mark is never wrong to write: the deal, holding the market, keeps an able reviewer and only
deals the rest, so a change of reviewers landing during the run moves nothing it should not.

Each write holds the application as read, every field the judgment read (null and absent alike);
one that changed meanwhile is read again, with its market, up to three tries, then listed as
skipped. One whose status no state names is left and listed; one gone meanwhile, its market
deleted, is left gone, unlisted, as it needs nothing. A market whose stored document does not read
as a market is left and said, from the start or from the application whose retry found it so.

**No boot marker**: an unmigrated application reads correctly through ``state_of``, ``origin_of``
and ``is_waiting``, which apply this migration's own rules, so the migration only makes the stored
values the owner's.

Run it once the release that serves the review state is deployed, ``--dry-run`` first and only on
Daniel's word, and again after any roll-forward past a rollback: safe to run repeatedly, since an
application already stored as the owner reads it is left. It prints market and application ids,
never a name or an address.

Usage (the production database address passed inline, never from back-end/.env):
    MONGODB_URI='<URI>' python migrations/migrate_application_status.py [--dry-run]
"""
import os
import sys
from collections import Counter
from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import api.markets as MarketsApi  # noqa: E402
import application_status as ReviewState  # noqa: E402
import history as History  # noqa: E402
import review_team as ReviewTeam  # noqa: E402
from api.applications import APPLICATIONS_COLLECTION, ARRIVING_FIELD, MARKET_ID_FIELD  # noqa: E402
from datatypes import ApplicationStatus  # noqa: E402
from market_documents import MARKETS_COLLECTION  # noqa: E402
from tombstone import live  # noqa: E402

#: How many times an application is judged and written in all, the first try included, before one
#: that changed between its read and its write on every try is listed as skipped.
TRIES = 3

#: The action the migration's mark names, which the deal that takes it records under.
MIGRATED = History.REVIEW_STATE_MIGRATED

#: Every field the judgment reads, held as read by its write: the status and what ``state_of``
#: reads beside it, the origin, the mark, and whose share it is in.
HELD_FIELDS = ("status", "verdict_by", "added_by", "origin", ARRIVING_FIELD, "reviewer",
               "follow_up_owner")

#: The one stored spelling of each state, which every write of the owner stores.
_STORED: Dict[ReviewState.State, str] = {
    ReviewState.State.OPEN: ApplicationStatus.OPEN.value,
    ReviewState.State.FOLLOW_UP: ApplicationStatus.NEEDS_FOLLOW_UP.value,
    ReviewState.State.APPROVED_BY_A_PERSON: ApplicationStatus.REVIEWER_APPROVED.value,
    ReviewState.State.APPROVED_ADDED: ApplicationStatus.REVIEWER_APPROVED.value,
    ReviewState.State.REJECTED_BY_A_PERSON: ApplicationStatus.REVIEWER_REJECTED.value,
    ReviewState.State.REJECTED_BY_A_RULE: ApplicationStatus.REVIEWER_REJECTED.value,
}

_ABSENT = object()


class Unreadable(Exception):
    """An application whose status no state names: the app refuses to read it."""


class ReadsOtherwise(Exception):
    """An application whose status, stored in its one spelling, would read as another state."""


class MarketUnreadable(Exception):
    """A market whose stored document does not read as a market: its applications are left."""


class ChangedOnEveryTry(Exception):
    """An application that changed between its read and its write on each of ``TRIES`` tries:
    left for the next run."""


@dataclass(frozen=True)
class Judgment:
    """What one application needs stored, and what each of it is, as the operator reads it."""

    fields: Dict[str, Any]
    described: List[str]


def _status_named(doc: Mapping[str, Any]) -> str:
    """A stored status as the operator reads it: never a name or an address."""
    status = doc.get("status", _ABSENT)
    if status is _ABSENT:
        return "missing"
    if status is None:
        return "null"
    return status if status else '""'


def judged(doc: Mapping[str, Any], view: ReviewTeam.ReviewView) -> Optional[Judgment]:
    """What the application ``doc`` needs on a market read as ``view``, or None when nothing.

    Every rule is the owner's, so the migration and the read never differ: the state is
    ``state_of``'s, the origin ``origin_of``'s and the wait ``is_waiting``'s."""
    try:
        state = ReviewState.state_of(dict(doc))
    except ValueError as error:
        raise Unreadable(str(error)) from error
    fields: Dict[str, Any] = {}
    described: List[str] = []
    spelling = _STORED[state]
    if doc.get("status") != spelling:
        if ReviewState.state_of({**doc, "status": spelling}) is not state:
            raise ReadsOtherwise(state.value)
        fields["status"] = spelling
        described.append(f"status {_status_named(doc)} to {spelling}")
    migrated = {**doc, **fields}
    origin = ReviewState.origin_of(migrated, view.intake).value
    if doc.get("origin") != origin:
        fields["origin"] = origin
        described.append(f"origin {origin}")
    if (not isinstance(doc.get(ARRIVING_FIELD), dict)
            and ReviewTeam.is_waiting(migrated, view)):
        fields[ARRIVING_FIELD] = ReviewState.Arrival(None, MIGRATED).stored()
        described.append("marked for the deal")
    return Judgment(fields, described) if fields else None


def _view_of(market_id: str) -> Optional[ReviewTeam.ReviewView]:
    """The market's review view as an organizer's read builds it, from the market and its
    organization as a route loads them, or None when it is gone or being deleted."""
    context = MarketsApi.load_market_context(market_id)
    if context is None:
        return None
    if context.market is None:
        raise MarketUnreadable()
    return ReviewTeam.review_view(context.market, context.organization)


def count_statuses(markets, applications) -> Counter:
    """How many applications of the live markets are stored in each status, by ``_status_named``'s
    words for a missing, null or empty one."""
    market_ids = [market["id"] for market in markets.find(live({}), {"_id": 0, "id": 1})]
    return Counter(_status_named(doc) for doc in applications.find(
        {MARKET_ID_FIELD: {"$in": market_ids}}, {"_id": 0, "status": 1}))


def _print_counts(counts: Counter) -> None:
    print("Applications in each stored status across live markets:")
    named = {"missing": "(no status)", "null": "(null status)", '""': "(empty status)"}
    for status in sorted(status for status in counts if status not in named):
        print(f"  {status}: {counts[status]}")
    for status, words in named.items():
        if counts[status]:
            print(f"  {words}: {counts[status]}")


def migrate(db=None, dry_run: bool = False) -> int:
    """Returns the number of applications changed, or that would be on a dry run."""
    if db is None:
        from db_config import get_database
        db = get_database()
    markets = db[MARKETS_COLLECTION]
    if markets != MarketsApi.markets_collection:
        raise RuntimeError(
            "migrate_application_status reads each market and its organization as a route loads "
            "them, through the markets module: pass the configured database, or none")
    applications = db[APPLICATIONS_COLLECTION]

    _print_counts(count_statuses(markets, applications))
    print()

    changed = 0
    skipped: List[str] = []
    unreadable: List[str] = []
    otherwise: List[str] = []
    for market in markets.find(live({}), {"_id": 0, "id": 1}):
        market_id = market["id"]
        try:
            view = _view_of(market_id)
        except MarketUnreadable:
            print(f"  - market {market_id}: left, it cannot be read")
            continue
        if view is None:
            continue
        for doc in list(applications.find({MARKET_ID_FIELD: market_id})):
            app_id = doc.get("id")
            try:
                judgment = set_one(applications, market_id, doc, view, dry_run)
            except MarketUnreadable:
                # A retry read the market again, and it no longer reads as one: the rest of it is
                # left, as a market unreadable from the start is.
                print(f"  - market {market_id}: left from application {app_id} on, "
                      "it cannot be read")
                break
            except Unreadable:
                unreadable.append(str(app_id))
                continue
            except ReadsOtherwise:
                otherwise.append(str(app_id))
                continue
            except ChangedOnEveryTry:
                skipped.append(str(app_id))
                continue
            if judgment is not None:
                changed += 1
                print(f"  - market {market_id}, application {app_id}: "
                      f"{'; '.join(judgment.described)}")

    verb = "would change" if dry_run else "changed"
    print(f"\n{verb} {changed} application(s).")
    if skipped:
        print(f"skipped {len(skipped)} application(s) that changed on every try: "
              f"{', '.join(skipped)}. Run it again.")
    if otherwise:
        print(f"left {len(otherwise)} application(s) whose status would read as another state: "
              f"{', '.join(otherwise)}.")
    if unreadable:
        print(f"left {len(unreadable)} application(s) that could not be read: "
              f"{', '.join(unreadable)}.")
    return changed


def set_one(
    applications, market_id: str, doc: Mapping[str, Any],
    view: ReviewTeam.ReviewView, dry_run: bool,
) -> Optional[Judgment]:
    """Judge one application and write what it needs: the judgment written, or None when it needs
    nothing (or it, or its market, is gone); ``ChangedOnEveryTry`` when it changed between the
    read and the write on every try; ``MarketUnreadable`` when a try after the first finds the
    market no longer reads as one. A try after the first reads the market's view again with the
    application, so both are as fresh as each other."""
    for attempt in range(TRIES):
        if attempt:
            view = _view_of(market_id)
            if view is None:
                return None
        judgment = judged(doc, view)
        if judgment is None or dry_run:
            return judgment
        if written(applications, doc, judgment.fields):
            return judgment
        doc = applications.find_one({"id": doc["id"]})
        if doc is None:
            return None
    raise ChangedOnEveryTry()


def written(applications, doc: Mapping[str, Any], fields: Dict[str, Any]) -> bool:
    """Store ``fields``, holding the application as read, by its id and by the owner's rule
    (``ReviewState.held_as_read``), on every field the judgment read (``HELD_FIELDS``); whether it
    landed."""
    holding = {"id": doc["id"], **ReviewState.held_as_read(doc, *HELD_FIELDS)}
    return bool(applications.update_one(holding, {"$set": fields}).matched_count)


if __name__ == "__main__":
    migrate(dry_run="--dry-run" in sys.argv)
