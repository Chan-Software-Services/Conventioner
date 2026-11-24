#!/usr/bin/env python3
"""Rename the older layout lines of one market's history after two of its locations traded names.

``swap_location_names.py`` trades the names of two locations on the market's document. The
market's history keeps a location's name as text, as it was called when each entry was recorded,
so after the swap a line recorded before it names its location by the name that now means the
other place. This script renames those lines, so each names the place it was about:

- ``floorplan``, each save of a layout, whose ``subject.location`` Manage market reads into its
  sentence ("... saved the North Wing's layout");
- ``floorplan_removed``, a layout removed with its location, with the same subject.

**A change on Market Setup (``plan``) is left as written**: its detail is the record of what the
plan said, its locations' names among it, when it was saved. So is every other kind of entry, and
every line of a location other than the two.

**Which lines it renames.** It reads the market's ``plan`` entries in which either location's name,
found by its id, differs before and after. Each that trades the two names is a trade, the swap's
own entry among them, and an organizer's trade saved on Market Setup in draft too. A line recorded
before a trade, naming one of the two names the trade's "before" gives, is about the location that
held that name then, which the trade gave the other name: so the line takes it, and a later trade
moves it on again, so a swap and a swap back leave the line as it was recorded. A line naming
neither name is left. Each line is computed afresh from the name it was recorded under, which the
first rename keeps beside it as ``subject.location_as_recorded``: so a second run changes nothing,
and a run after a later swap of the two renames each line once more.

It refuses, writing nothing and exiting 1, when: the market is not found or is being deleted; it
has no plan; either location is not found by its id or exact name, or has no stored id (run
``migrate_layouts.py`` first); both arguments name one location; the history records no trade of
the two names; the history's last change of the two names leaves them otherwise than the plan
names them now (a swap whose entry failed to write: put the history right by hand first); or a
line names a location by a name another change, one that was not a trade, gave the other of the
two, so no trade says which place the line meant.

**Each line is its own write**, held to the name it was read under, so a line changed since the
read is left; the script then says how many it renamed of how many it meant to and exits 1, and a
second run renames the rest. Nothing records the rename in the history: the name as recorded is
kept on the line.

**Run it after each run of the swap** (the dry run first), at any time: it reads only the market's
plan and writes only the history, so an organizer working on the market meanwhile is not in its
way. It needs no deploy: Manage market reads a line's ``subject.location`` as it is stored.

It prints the market's id, the two locations' ids and counts only: never a location's name, a
vendor's name or an address.

Usage (the production database address passed inline, never from back-end/.env):
    MONGODB_URI='<URI>' python migrations/history_follows_location_swap.py \\
        <market-id> <location> <location> [--dry-run]
"""
import os
import sys
from typing import Any, Dict, List, Mapping, NamedTuple, Optional, Tuple

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from history import (  # noqa: E402
    FLOORPLAN, FLOORPLAN_REMOVED, HISTORY_COLLECTION, MARKET_ID_FIELD, PLAN,
)
from market_documents import MARKETS_COLLECTION, market_doc_key  # noqa: E402
from tombstone import live  # noqa: E402

SETUP = market_doc_key("setup_object")

#: The kinds of line renamed: each names its location in ``subject.location``.
LINES = (FLOORPLAN, FLOORPLAN_REMOVED)

#: Where a renamed line keeps the name it was recorded under.
AS_RECORDED = "location_as_recorded"

NEEDS_IDS = "Run migrations/migrate_layouts.py first, which stores the ids every read gives."


class Refused(Exception):
    """Why nothing is renamed. Nothing was written."""


class Incomplete(Exception):
    """Some lines were renamed and some changed between the read and the write: run it again."""


class Change(NamedTuple):
    """A ``plan`` entry that changed either location's name: each one's name before and after."""

    at: str
    entry_id: str
    #: ``{location id: name}`` before and after, for the two locations.
    before: Dict[str, Optional[str]]
    after: Dict[str, Optional[str]]

    @property
    def trades(self) -> bool:
        one, other = sorted(self.before)
        return (self.before[one] is not None and self.before[other] is not None
                and self.before[one] != self.before[other]
                and self.after[one] == self.before[other]
                and self.after[other] == self.before[one])


class Rename(NamedTuple):
    """One line, and the name it takes."""

    key: Any
    kind: str
    read_as: Optional[str]
    recorded: Optional[str]
    name: Optional[str]


class Following(NamedTuple):
    """What a run renames, and what the operator reads of it."""

    ids: Tuple[str, str]
    trades: int
    renames: List[Rename]
    #: Per kind, how many lines a run before renamed and stay so.
    renamed_before: Dict[str, int]


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


def _changes(history, market_id: str, ids: Tuple[str, str]) -> List[Change]:
    """The market's ``plan`` entries that changed either location's name, oldest first."""
    changes = []
    for entry in history.find({MARKET_ID_FIELD: market_id, "kind": PLAN}):
        detail = entry.get("detail") if isinstance(entry.get("detail"), dict) else {}
        before = _names_by_id(detail.get("before"), ids)
        after = _names_by_id(detail.get("after"), ids)
        if before is None or after is None or before == after:
            continue
        changes.append(
            Change(str(entry.get("at") or ""), str(entry.get("id") or ""), before, after))
    return sorted(changes, key=lambda change: (change.at, change.entry_id))


def _place(name: Optional[str], names: Mapping[str, Optional[str]]) -> Optional[str]:
    """Which of the two locations ``name`` named, by id, or None for neither."""
    return next((place_id for place_id, held in names.items() if name is not None and held == name),
                None)


def _followed(
    recorded: Optional[str], at: str, changes: List[Change], line_id: str,
) -> Optional[str]:
    """The name a line recorded under ``recorded`` at ``at`` takes: moved on by each trade after
    it, and kept through each other change, or ``Refused`` where another change gave its name to
    the other of the two."""
    name = recorded
    for change in changes:
        if change.at <= at:
            continue
        was = _place(name, change.before)
        if change.trades:
            if was is not None:
                name = change.after[was]
            continue
        now = _place(name, change.after)
        if now is not None and now != was:
            raise Refused(
                f"The history's line {line_id} names a location by a name another change gave the "
                "other of the two, so no trade says which place it meant. Put it right by hand.")
    return name


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

    changes = _changes(history, market_id, ids)
    trades = sum(1 for change in changes if change.trades)
    if not trades:
        raise Refused(f"The market's history records no trade of the two names of {ids[0]} and "
                      f"{ids[1]}, so no line names the other place.")
    if changes[-1].after != {one["id"]: one["name"], other["id"]: other["name"]}:
        raise Refused(
            "The market's history does not record the last change of the two names: its last "
            "change leaves them otherwise than the plan names them now (a run of the swap whose "
            "entry failed to write?). Put the history right by hand first.")

    renames, renamed_before = [], {kind: 0 for kind in LINES}
    lines = history.find({MARKET_ID_FIELD: market_id, "kind": {"$in": list(LINES)}})
    for entry in sorted(lines, key=lambda each: (str(each.get("at") or ""), str(each.get("id")))):
        subject = entry.get("subject") if isinstance(entry.get("subject"), dict) else {}
        read_as = subject.get("location")
        recorded = subject[AS_RECORDED] if AS_RECORDED in subject else read_as
        name = _followed(recorded, str(entry.get("at") or ""), changes, str(entry.get("id")))
        if name != read_as:
            renames.append(Rename(entry["_id"], entry["kind"], read_as, recorded, name))
        elif AS_RECORDED in subject:
            renamed_before[entry["kind"]] += 1
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
    for kind, words in ((FLOORPLAN, "layout save(s)"), (FLOORPLAN_REMOVED, "layout removal(s)")):
        to_rename = sum(1 for rename in judgment.renames if rename.kind == kind)
        print(f"  - {words}: {to_rename} to rename, {judgment.renamed_before[kind]} renamed before")
    print("  - changes on Market Setup: left as written")
    if dry_run:
        print(f"\nwould rename {len(judgment.renames)} line(s).")
        return judgment

    renamed = 0
    for rename in judgment.renames:
        written = history.update_one(
            {"_id": rename.key, MARKET_ID_FIELD: market_id, "kind": rename.kind,
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
