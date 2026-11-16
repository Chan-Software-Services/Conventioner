#!/usr/bin/env python3
"""Give every stored owed table-day its state, and drop each Admin's amount nobody can see (T335).

Each ``amounts_owed`` record now stores its state (``set``, ``freed`` or ``freed_waived``;
following the seat is no record at all), written by ``payments.owed_day_transition``, beside the
``freed`` and ``set_by_hand`` the release before reads, kept as a mirror (``legacy_fields``). A
record stored before has only those, and one a rolled-back release wrote may store a state they
disagree with: the read (``payments.state_of``) trusts the state only while they agree.

For each live market (``tombstone.live``) with records, this reads its records, then the stored
assignment, and for each record:

- whose ``state`` is absent or disagrees with its legacy fields, derives the state from them
  (``derive_from_legacy``) and takes the state the day reads as, held or not (``on_day``): a held
  seat wins over a freed record (T270), so a free that stopped before its seat went is stored as
  seating the day makes it;
- that holds an Admin's amount on a day the vendor holds no table, a line nobody sees, deletes it
  and records one ``owed_dropped`` entry with no actor, ``by_migration`` in its subject, naming
  the amount and who set it (Daniel's choice, T335), whether or not its state was stored;
- otherwise deletes a record that follows the seat, and stores any other state with its mirror
  and its ``revision`` counted up (1 on a record no release counted).

A stored state that agrees is otherwise the owner's and left, a freed one on a held day included:
a free writes its record before its seat goes, so it may be a free in flight, and the read already
shows the seat.

Each write holds the record as read (its ``_id``, ``state``, legacy fields and ``revision``); a
record that changed meanwhile is read again, with the assignment, up to three tries, then listed
as skipped. A record that cannot be read is left and listed.

**No boot marker**: an unmigrated record reads correctly through ``state_of``, which derives the
state by the same rule, so the migration only makes the stored state the owner's.

Run it once the release is deployed, ``--dry-run`` first, and again after any roll-forward past a
rollback: safe to run repeatedly, since a record whose state agrees is left. It prints market ids,
dates and record ids, never a name or an address.

Usage (the production database address passed inline, never from back-end/.env):
    MONGODB_URI='<URI>' python migrations/migrate_owed_day_state.py [--dry-run]
"""
import os
import sys
from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional, Set, Tuple

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import api.market_actions as Actions  # noqa: E402
import api.markets as MarketsApi  # noqa: E402
import history as History  # noqa: E402
import payments as Payments  # noqa: E402
import pricing as Pricing  # noqa: E402
from market_documents import MARKETS_COLLECTION, market_from_document  # noqa: E402
from payments import AMOUNTS_OWED_COLLECTION, FollowsSeat, OwedState, SetByHand  # noqa: E402
from tombstone import live  # noqa: E402
from utils.email_address import normalized_email  # noqa: E402

#: How many times a record that changed between its read and its write is read and judged again.
TRIES = 3

#: Why the migration's dropped amounts are recorded under the Assignment row with no request
#: asking it (``History.unasked``).
MIGRATION_DROPS_UNASKED = (
    "an operator's migration, run from a shell and never a request: it drops the amount a run "
    "would have dropped with its day, and records it as a run records the drop, with no actor")


class Unreadable(Exception):
    """A record whose legacy fields do not parse; the app reads it as following the seat."""


class ChangedOnEveryTry(Exception):
    """A record that changed between its read and its write on each of ``TRIES`` tries: left for
    the next run."""


@dataclass(frozen=True)
class Judgment:
    """What one record needs: the state to store, following the seat being its removal, and the
    Admin's amount hidden on a day not held that the removal drops, if that is what it is."""

    state: OwedState
    dropped: Optional[Payments.HandAmount] = None

    def described(self) -> str:
        """What is set, as the operator reads it: never a name or an address."""
        if self.dropped is not None:
            return "removed, an amount set by hand on a day not held, dropped and recorded"
        if isinstance(self.state, FollowsSeat):
            return "removed, it follows the seat"
        return f"state {self.state.kind}"


def judged(doc: Mapping[str, Any], held: bool) -> Optional[Judgment]:
    """What the record ``doc`` needs on a day ``held`` or not, or None when nothing.

    Whether its stored state is trusted is ``payments``' own rule, so the migration and the read
    never differ on it.
    """
    stored, trusted = Payments.read_record(doc)
    if not trusted:
        try:
            stored = Payments.derive_from_legacy(doc)
        except Payments.UNREADABLE as error:
            raise Unreadable(type(error).__name__) from error
    if not held and isinstance(stored, SetByHand):
        return Judgment(FollowsSeat(), stored.amount)
    if trusted:
        return None
    return Judgment(Payments.on_day(stored, held))


def held_days(market_doc: Mapping[str, Any]) -> Set[Tuple[str, str]]:
    """Every (address, date) the stored assignment seats, as the Payment tab reads it."""
    market = market_from_document(dict(market_doc))
    return {(normalized_email(email), row.date)
            for row in MarketsApi.derive_market_table_rows(market)
            for email in row.assignment if email}


def migrate(db=None, dry_run: bool = False) -> int:
    """Returns the number of records set or removed, or that would be on a dry run."""
    if db is None:
        from db_config import get_database
        db = get_database()
    markets = db[MARKETS_COLLECTION]
    owed = db[AMOUNTS_OWED_COLLECTION]
    if not History.records_in(db):
        raise RuntimeError(
            "migrate_owed_day_state records in the history the history module writes: pass the "
            "configured database, or none")

    changed = 0
    skipped: List[str] = []
    unreadable: List[str] = []
    for market in markets.find(live({}), {"_id": 0, "id": 1}):
        market_id = market["id"]
        for doc in list(owed.find({Payments.MARKET_ID_FIELD: market_id})):
            named = (f"market {market_id}, date {doc.get('date')}, record {doc['_id']}")
            try:
                judgment = set_one(markets, owed, market_id, doc, dry_run)
            except Unreadable as error:
                unreadable.append(str(doc["_id"]))
                print(f"  - {named}: left, it cannot be read ({error})")
                continue
            except ChangedOnEveryTry:
                skipped.append(str(doc["_id"]))
                continue
            if judgment is not None:
                changed += 1
                print(f"  - {named}: {judgment.described()}")

    verb = "would set" if dry_run else "set"
    print(f"\n{verb} {changed} record(s).")
    if skipped:
        print(f"skipped {len(skipped)} record(s) that changed on every try: {', '.join(skipped)}."
              " Run it again.")
    if unreadable:
        print(f"left {len(unreadable)} record(s) that could not be read: "
              f"{', '.join(unreadable)}.")
    return changed


def set_one(
    markets, owed, market_id: str, doc: Mapping[str, Any], dry_run: bool,
) -> Optional[Judgment]:
    """Judge one record and write what it needs: the judgment written, or None when it needs
    nothing (or it, or its market, is gone); ``ChangedOnEveryTry`` when it changed between the read
    and the write on every try. The assignment is read after the record, so the day's held-ness is
    as fresh as it."""
    for _ in range(TRIES):
        market_doc = markets.find_one(live({"id": market_id}))
        if market_doc is None:
            return None
        address = normalized_email(doc.get(Payments.VENDOR_EMAIL_FIELD) or "")
        judgment = judged(doc, (address, doc.get("date")) in held_days(market_doc))
        if judgment is None or dry_run:
            return judgment
        if written(owed, doc, judgment):
            if judgment.dropped is not None:
                record_dropped(market_doc, doc, judgment.dropped)
            return judgment
        doc = owed.find_one({"_id": doc["_id"]})
        if doc is None:
            return None
    raise ChangedOnEveryTry()


def written(owed, doc: Mapping[str, Any], judgment: Judgment) -> bool:
    """Write the judgment holding the record as read, every field its owner writes
    (``OWNED_FIELDS``); whether it landed."""
    holding: Dict[str, Any] = {"_id": doc["_id"]}
    for field in Payments.OWNED_FIELDS:
        holding[field] = doc[field] if field in doc else {"$exists": False}
    if isinstance(judgment.state, FollowsSeat):
        return bool(owed.delete_one(holding).deleted_count)
    return bool(owed.update_one(holding, {"$set": {
        "state": judgment.state.to_stored(), **Payments.legacy_fields(judgment.state),
        "revision": (doc.get("revision") or 0) + 1,
    }}).matched_count)


def record_dropped(market_doc: Mapping[str, Any], doc: Mapping[str, Any],
                   amount: Payments.HandAmount) -> None:
    """The ``owed_dropped`` entry a run records for an amount it drops, as the migration's."""
    market = market_from_document(dict(market_doc))
    History.unasked(market.id, None, Actions.ASSIGN, because=MIGRATION_DROPS_UNASKED).record(
        kind=History.OWED_DROPPED, vendors=[doc.get(Payments.VENDOR_EMAIL_FIELD)],
        subject={"date": doc.get("date"), **Pricing.pricing_subject(market.setup_object),
                 "set_by": amount.by, "by_migration": True},
        detail=History.changes({"owed_cents": amount.cents}, {"owed_cents": None}))


if __name__ == "__main__":
    migrate(dry_run="--dry-run" in sys.argv)
