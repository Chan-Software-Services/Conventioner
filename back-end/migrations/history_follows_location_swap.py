#!/usr/bin/env python3
"""Rename the older layout lines of one market's history after two of its locations traded names.

``swap_location_names.py`` trades the names of two locations on the market's document. The
market's history keeps a location's name as text, as it was called when each entry was recorded,
so after the swap a layout's save (``floorplan``) recorded before it names its location by the name
that now means the other place. This script renames those lines, so each names the place it was
about, by its name now: Manage market reads ``subject.location`` into the line's sentence ("...
started North Wing's layout").

**A line's place is read by id, from its layout.** A ``floorplan`` line names its layout by
``subject.floorplan_id``, and a layout keeps the location it was started on (its ``locationId``)
until it is removed with that location. So each line whose layout is one of the plan's, on either
of the two locations, is given that location's name as the plan has it now. That holds through any
number of swaps, with either location or a third, and through a rename: a line of either location
recorded before an ordinary rename of it, by ``rename_location.py`` or on Market Setup in draft,
takes the name it has now too. Each line keeps the name it was recorded under beside it, as
``subject.location_as_recorded``, set by its first rename: so a second run changes nothing, and a
run after a later swap renames each line once more.

**Left as written:** a change on Market Setup (``plan``), whose detail is the record of what the
plan said, its locations' names among it, when it was saved; a layout removed with its location
(``floorplan_removed``), which is about a location that left the plan, so never either of the two;
a line whose layout is no longer in the plan, or on another location; and every other kind of
entry.

It refuses, writing nothing and exiting 1, when: the market is not found or is being deleted; it
has no plan; either location is not found by its id or exact name, or has no stored id (run
``migrate_layouts.py`` first); both arguments name one location; or the market's history records
no trade of the two names, by the swap or on Market Setup, so the two were never swapped.

**Each line is its own write**, held to the name it was read under, so a line changed since the
read is left; the script then says how many it renamed of how many it meant to and exits 1, and a
second run renames the rest. Nothing records the rename in the history: the name as recorded is
kept on the line.

**Run it after each run of the swap** (the dry run first), at any time: of the market's document it
reads the plan alone, and it writes the history alone, so an organizer working on the market
meanwhile is not in its way. It needs no deploy: Manage market reads a line's ``subject.location``
as it is stored.

Its report prints the market's id, the two locations' ids and counts only, and a refusal no name
but an argument it was given: never a vendor's name or an address.

Usage (the production database address passed inline, never from back-end/.env):
    MONGODB_URI='<URI>' python migrations/history_follows_location_swap.py \\
        <market-id> <location> <location> [--dry-run]
"""
import os
import sys
from typing import Any, Dict, List, Mapping, NamedTuple, Optional, Tuple

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from history import FLOORPLAN, HISTORY_COLLECTION, MARKET_ID_FIELD, PLAN  # noqa: E402
from market_documents import MARKETS_COLLECTION, market_doc_key  # noqa: E402
from tombstone import live  # noqa: E402

SETUP = market_doc_key("setup_object")

#: Where a renamed line keeps the name it was recorded under.
AS_RECORDED = "location_as_recorded"

NEEDS_IDS = "Run migrations/migrate_layouts.py first, which stores the ids every read gives."


class Refused(Exception):
    """Why nothing is renamed. Nothing was written."""


class Incomplete(Exception):
    """Some lines were renamed and some changed between the read and the write: run it again."""


class Rename(NamedTuple):
    """One line, and the name it takes."""

    key: Any
    read_as: Optional[str]
    recorded: Optional[str]
    name: str


class Following(NamedTuple):
    """What a run renames, and what the operator reads of it."""

    ids: Tuple[str, str]
    trades: int
    renames: List[Rename]
    #: How many lines of the two locations a run before renamed, which stay so.
    renamed_before: int


def _has_id(row: Mapping[str, Any]) -> bool:
    return isinstance(row.get("id"), str) and bool(row["id"].strip())


def _named(locations: List[Dict[str, Any]], wanted: str) -> Dict[str, Any]:
    """The one location ``wanted`` names, by id or else by exact name."""
    found = ([place for place in locations if place.get("id") == wanted]
             or [place for place in locations if place.get("name") == wanted])
    if not found:
        raise Refused(f"The market's plan has no location with the id or name {wanted!r}.")
    if len(found) > 1:
        raise Refused(f"{len(found)} of the plan's locations are named {wanted!r}: name one by id.")
    if not _has_id(found[0]):
        raise Refused(f"The location {wanted!r} has no stored id. {NEEDS_IDS}")
    return found[0]


def _names_by_id(side: Any, ids: Tuple[str, str]) -> Optional[Dict[str, Optional[str]]]:
    """The two locations' names in one side of a plan entry's detail, or None when it holds no
    list of locations."""
    locations = side.get("locations") if isinstance(side, dict) else None
    if not isinstance(locations, list):
        return None
    names = {place.get("id"): place.get("name") for place in locations if isinstance(place, dict)}
    return {place_id: names.get(place_id) for place_id in ids}


def _trades(history, market_id: str, ids: Tuple[str, str]) -> int:
    """How many of the market's ``plan`` entries trade the two locations' names. Read only."""
    one, other = ids
    count = 0
    for entry in history.find({MARKET_ID_FIELD: market_id, "kind": PLAN}):
        detail = entry.get("detail") if isinstance(entry.get("detail"), dict) else {}
        before = _names_by_id(detail.get("before"), ids)
        after = _names_by_id(detail.get("after"), ids)
        if (before is not None and after is not None
                and None not in (before[one], before[other]) and before[one] != before[other]
                and (after[one], after[other]) == (before[other], before[one])):
            count += 1
    return count


def judged(document: Mapping[str, Any], history, first: str, second: str) -> Following:
    """What a run renames on the market's history as read, or ``Refused``."""
    setup = document.get(SETUP)
    if not isinstance(setup, dict) or not isinstance(setup.get("locations"), list):
        raise Refused("The market has no plan.")
    locations: List[Dict[str, Any]] = setup["locations"]
    one, other = _named(locations, first), _named(locations, second)
    if one is other:
        raise Refused("Both arguments name the same location.")
    ids = (one["id"], other["id"])
    market_id = document["id"]

    trades = _trades(history, market_id, ids)
    if not trades:
        raise Refused(f"The market's history records no trade of the two names of {ids[0]} and "
                      f"{ids[1]}, so no line names the other place.")

    name_now = {one["id"]: one["name"], other["id"]: other["name"]}
    place_of = {
        layout["id"]: layout.get("locationId")
        for layout in setup.get("floorplans") or []
        if isinstance(layout, dict) and isinstance(layout.get("id"), str)
    }
    renames, renamed_before = [], 0
    for entry in history.find({MARKET_ID_FIELD: market_id, "kind": FLOORPLAN}):
        subject = entry.get("subject") if isinstance(entry.get("subject"), dict) else {}
        place = place_of.get(subject.get("floorplan_id"))
        if place not in name_now:
            continue
        read_as = subject.get("location")
        if name_now[place] != read_as:
            recorded = subject[AS_RECORDED] if AS_RECORDED in subject else read_as
            renames.append(Rename(entry["_id"], read_as, recorded, name_now[place]))
        elif AS_RECORDED in subject:
            renamed_before += 1
    return Following(ids=ids, trades=trades, renames=renames, renamed_before=renamed_before)


def follow(market_id: str, first: str, second: str, db=None, dry_run: bool = False) -> Following:
    """Rename the market's older layout lines after its two locations traded names, or say what a
    run would rename.

    Raises:
        Refused: why not; nothing was written.
        Incomplete: a line changed between the read and the write; the rest were renamed.
    """
    if db is None:
        from db_config import get_database
        db = get_database()
    history = db[HISTORY_COLLECTION]
    document = db[MARKETS_COLLECTION].find_one(live({"id": market_id}))
    if document is None:
        raise Refused(f"No market has the id {market_id!r}.")
    judgment = judged(document, history, first, second)

    print(f"market {market_id}:" + (" (dry run: nothing is written)" if dry_run else ""))
    print(f"  - locations {judgment.ids[0]} and {judgment.ids[1]}: {judgment.trades} trade(s) of "
          "their names recorded")
    print(f"  - their layouts' save(s): {len(judgment.renames)} to rename, "
          f"{judgment.renamed_before} renamed before")
    print("  - layouts removed with their location, and changes on Market Setup: left as written")
    if dry_run:
        print(f"\nwould rename {len(judgment.renames)} line(s).")
        return judgment

    renamed = 0
    for rename in judgment.renames:
        written = history.update_one(
            {"_id": rename.key, MARKET_ID_FIELD: market_id, "kind": FLOORPLAN,
             "subject.location": rename.read_as},
            {"$set": {"subject.location": rename.name, f"subject.{AS_RECORDED}": rename.recorded}})
        renamed += written.matched_count
    if renamed != len(judgment.renames):
        raise Incomplete(
            f"renamed {renamed} of {len(judgment.renames)} line(s): the others changed between the "
            "read and the write. Run it again.")
    print(f"\nrenamed {renamed} line(s).")
    return judgment


def main(argv: List[str]) -> int:
    dry_run = "--dry-run" in argv
    arguments = [argument for argument in argv if argument != "--dry-run"]
    if len(arguments) != 3 or any(argument.startswith("--") for argument in arguments):
        print("usage: history_follows_location_swap.py <market-id> <location> <location> "
              "[--dry-run]", file=sys.stderr)
        return 2
    try:
        follow(*arguments, dry_run=dry_run)
    except Refused as refusal:
        print(f"refused, nothing written: {refusal}", file=sys.stderr)
        return 1
    except Incomplete as incomplete:
        print(incomplete, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
