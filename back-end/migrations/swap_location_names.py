#!/usr/bin/env python3
"""Swap the names of two locations of one market past Draft.

The setup settles on leaving draft (``docs/business/rules/the-setup-settles-on-leaving-draft.md``),
so the app refuses to rename a location or move a section once applicants rely on the plan. When
two sections were set up under each other's location name, this script puts each under the name of
the place it is in: the two locations trade names and keep everything else.

Each copy of a location's name the market's pages read as the name now is on the market's own
document, and each is rewritten:

- ``setupObject.locations[].name``, the location itself;
- ``setupObject.sections[].location.name``, each section's copy of its location;
- ``assignmentObject.vendorAssignments[].location``, each seat's copy, which a vendor's result, the
  door's roster and the organizer's tables read as stored;
- ``assignmentObject.madeFrom.plan``, the fingerprint of the plan the table allocation was made
  from, which covers the names: it is carried over to the plan as swapped only where it matched the
  plan as read, so an allocation that read as current still does, and one that did not is left.

It keeps every id (location, section, table), so a layout, which names its location by id, stays on
the same location under its new name. It does not count the assignment's ``revision``, so published
results do not read as changed, and it sends nothing to anyone.

**It records the swap in the market's history**, as one entry of the kind a change on Market Setup
records (``plan``, under the Market Setup row), with no actor and whichever of the plan's two
lists, its locations and its sections, changed, each list whole, before and after, as a plan
save's entry holds them: so the entry holds every location's name, the other locations' among
them, and every section's row when a section's copy changed. Manage market reads "Someone changed
Market Setup: locations and sections" when either location holds a section, and "locations" alone
when neither does. A dry run records none, and a second run records a second entry.

**The market's earlier history also holds the names, as text, and is left as written**, by the
owner's choice, for a later fix. Three kinds of entry in the ``history`` collection name a location
as it was called when they were recorded:

- ``floorplan``, each save of a layout, whose ``subject.location`` Manage market reads into its
  sentence;
- ``floorplan_removed``, a layout removed with its location, with the same subject;
- ``plan``, a change on Market Setup, whose detail holds the locations and sections before and
  after.

So after the swap an entry of a layout's save still names its location by the old name, which now
means the other place. The script counts the market's ``floorplan`` and ``floorplan_removed``
entries naming either location and prints the two counts, so the operator knows they are there.

It refuses, writing nothing and exiting 1, when: the market is not found, is being deleted, does
not parse, has no plan or is a draft (rename it on Market Setup); either location is not found, or
shares its name with another of the plan's locations; both arguments name one location; either
location, a section in it, or that section's copy of it has no stored id (run
``migrate_layouts.py`` first: an id read from a name would change with the name); a section's copy
disagrees with the location it names; both locations hold a section of one name; a seat's copy of
the name disagrees with the section it is in; or the market changed between the read and the
write.

**The swap is one write, all or nothing; its history entry is a second write.** The whole swap is
a single update of the market's document, through ``write_market``, holding the phase,
``planRevision``, the assignment's ``revision`` and ``madeFrom`` as read, and counting
``planRevision``, as every write of the plan does. It lands whole or not at all, and a market
whose held keys moved since the read refuses it with nothing written. The entry is written after
it, into another collection. A failure between the two leaves the names swapped and no entry: the
history logs a warning naming the market by id, and the script still says it swapped. The next
``--dry-run`` shows it: the names stand swapped, and its line counting the runs of this script
the history records counts one fewer than were run. Nothing is repaired by running again, which
would swap back; the missing entry is the only loss.

**Run it while no organizer is working on the market.** A plan or layout save that read the market
before the swap is refused after it, since the plan's revision moved. A seat written by hand is
not: the assignment's ``revision`` is left as it was, so a placement, a free or a swap of seats
whose request read the market just before the swap and wrote just after puts every seat back under
the old names, over the swapped plan. The next ``--dry-run`` shows it: it refuses with a stored
seat naming a location "which the plan does not put there". The seats' names are then put right
in the database by hand, each to its section's location, before anything is run again.

**A second run of the same swap swaps back**, restoring every value this script wrote but
``planRevision``, which counts each run. So run ``--dry-run`` first and read which section sits
under which name before and after, run it once, and run ``--dry-run`` again: the second dry run
shows the first one's "after" as its "before".

Each location is named by its id or its exact name. It prints the market's id, the two locations'
ids and names, the names of the sections in them, and counts: never a vendor's name or address,
and no other location's name. That is of what it prints: the history entry a run records holds
the plan's whole list of locations.

Usage (the production database address passed inline, never from back-end/.env):
    MONGODB_URI='<URI>' python migrations/swap_location_names.py \\
        <market-id> <location> <location> [--dry-run]
"""
import copy
import os
import sys
from typing import Any, Dict, List, Mapping, NamedTuple, Tuple

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pydantic import ValidationError  # noqa: E402

import api.market_actions as Actions  # noqa: E402
import history as History  # noqa: E402
import market_write as MarketWrite  # noqa: E402
from assignment.made_from import fingerprint  # noqa: E402
from datatypes import MarketPhase  # noqa: E402
from history import (  # noqa: E402
    FLOORPLAN, FLOORPLAN_REMOVED, HISTORY_COLLECTION, MARKET_ID_FIELD,
)
from market_documents import MARKETS_COLLECTION, market_doc_key, market_from_document  # noqa: E402
from market_write import MarketChanged, MarketNotFoundError, write_market  # noqa: E402
from tombstone import live  # noqa: E402

SETUP = market_doc_key("setup_object")
ASSIGNMENT = market_doc_key("assignment_object")
PLAN_REVISION = market_doc_key("plan_revision")
LOCATIONS = f"{SETUP}.locations"
SECTIONS = f"{SETUP}.sections"
ROWS = f"{ASSIGNMENT}.vendorAssignments"
MADE_FROM = f"{ASSIGNMENT}.madeFrom"
REVISION = f"{ASSIGNMENT}.revision"

#: Why the swap is recorded under the Market Setup row with no request asking it
#: (``History.unasked``).
SWAP_RECORDS_UNASKED = (
    "an operator's script, run from a shell and never a request: it changes the plan's locations "
    "and sections past draft, and records it as a plan write records its change, with no actor")

#: The plan's fields the swap changes, as a plan write's entry names them.
RECORDED_FIELDS = ("locations", "sections")

NEEDS_IDS = "Run migrations/migrate_layouts.py first, which stores the ids every read gives."


class Refused(Exception):
    """Why the swap is not made. Nothing was written."""


class Swap(NamedTuple):
    """One market's swap, judged: what is written, and what the operator reads of it."""

    #: The stored keys set, and their values.
    setting: Dict[str, Any]
    #: The two locations, as ``(id, name before, name after)``.
    locations: List[Tuple[str, str, str]]
    #: Each section in either location, as ``(name, location's name before, after)``.
    sections: List[Tuple[str, str, str]]
    #: How many stored seats change, and how many the market stores.
    rows_changed: int
    rows_stored: int
    #: How many of the two locations hold a layout, which stays on its location's id.
    layouts: int
    #: What becomes of the allocation's record of the plan: a sentence.
    record: str
    #: The history entry's detail: whichever of the plan's lists of locations and sections
    #: changed, each list whole, before and after.
    detail: Dict[str, Any]


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
    return found[0]


def _plan_fingerprint(document: Mapping[str, Any]) -> str:
    """The plan's fingerprint as a run records it and the market read compares it."""
    return fingerprint(market_from_document(dict(document)).setup_object, [], [])["plan"]


def _recorded_plan(document: Mapping[str, Any]) -> Dict[str, Any]:
    """The plan's locations and sections as a plan write's entry holds them."""
    plan = market_from_document(dict(document)).setup_object.model_dump()
    return {field: plan.get(field) for field in RECORDED_FIELDS}


def record_swapped(market_id: str, detail: Mapping[str, Any]) -> None:
    """The swap's entry in the market's history: a change on Market Setup, with no actor."""
    History.unasked(market_id, None, Actions.CHANGE_SETUP, because=SWAP_RECORDS_UNASKED).record(
        kind=History.PLAN, detail=dict(detail))


def _runs_recorded(history, market_id: str) -> int:
    """How many runs of this script the market's history records: its ``plan`` entries with no
    actor, which nothing else writes. Read only."""
    return sum(
        1 for entry in history.find({MARKET_ID_FIELD: market_id, "kind": History.PLAN})
        if entry.get("actor") is None and entry.get("action") == Actions.CHANGE_SETUP.id)


def judged(document: Mapping[str, Any], first: str, second: str) -> Swap:
    """The swap of the two locations' names on the market as read, or ``Refused``."""
    try:
        market = market_from_document(dict(document))
    except ValidationError as error:
        raise Refused(
            f"The market does not parse ({error.error_count()} field(s)); the app cannot read it "
            "either.") from error
    if market.phase is MarketPhase.DRAFT:
        raise Refused("The market is a draft: rename its locations on Market Setup.")
    setup = document.get(SETUP)
    if not isinstance(setup, dict):
        raise Refused("The market has no plan.")
    # Lists of rows, each location with a name: the parse above refuses anything else.
    locations: List[Dict[str, Any]] = setup["locations"]
    sections: List[Dict[str, Any]] = setup["sections"]
    rows: List[Dict[str, Any]] = (document.get(ASSIGNMENT) or {}).get("vendorAssignments") or []

    one, other = _named(locations, first), _named(locations, second)
    if one is other:
        raise Refused("Both arguments name the same location.")
    for place in (one, other):
        if not _has_id(place):
            raise Refused(f"The location {place.get('name')!r} has no stored id. {NEEDS_IDS}")
        if sum(1 for each in locations if each.get("name") == place["name"]) > 1:
            raise Refused(
                f"More than one location is named {place['name']!r}, so a copy of the name does "
                "not say which it means.")
    name_after = {one["id"]: other["name"], other["id"]: one["name"]}
    name_before = {one["id"]: one["name"], other["id"]: other["name"]}
    id_of = {name: place_id for place_id, name in name_before.items()}

    new_locations = [
        {**place, "name": name_after[place["id"]]} if place is one or place is other else place
        for place in locations
    ]

    new_sections, shown, section_names = [], [], {one["id"]: set(), other["id"]: set()}
    elsewhere: Dict[Any, set] = {}
    for section in sections:
        held = section.get("location")
        if not isinstance(held, dict):
            new_sections.append(section)
            continue
        held_id, held_name, label = held.get("id"), held.get("name"), section.get("name")
        if held_id not in name_before:
            if held_name in id_of:
                raise Refused(
                    f"The section {label!r} names the location {held_name!r} with "
                    + ("another location's id." if _has_id(held) else f"no stored id. {NEEDS_IDS}"))
            elsewhere.setdefault(held_name, set()).add(label)
            new_sections.append(section)
            continue
        if held_name != name_before[held_id]:
            raise Refused(
                f"The section {label!r} holds the id of the location {name_before[held_id]!r} "
                "under another name.")
        if not _has_id(section):
            raise Refused(f"The section {label!r} has no stored id. {NEEDS_IDS}")
        section_names[held_id].add(label)
        shown.append((label, held_name, name_after[held_id]))
        new_sections.append({**section, "location": {**held, "name": name_after[held_id]}})
    both = section_names[one["id"]] & section_names[other["id"]]
    if both:
        raise Refused(f"Both locations hold a section named {sorted(map(str, both))[0]!r}.")

    new_rows, rows_changed = [], 0
    for row in rows:
        held_name, section_name = row.get("location"), row.get("section")
        if held_name in id_of:
            if section_name not in section_names[id_of[held_name]]:
                raise Refused(
                    f"A stored seat names the location {held_name!r} in the section "
                    f"{section_name!r}, which the plan does not put there.")
            new_rows.append({**row, "location": name_after[id_of[held_name]]})
            rows_changed += 1
            continue
        if (any(section_name in names for names in section_names.values())
                and section_name not in elsewhere.get(held_name, set())):
            raise Refused(
                f"A stored seat in the section {section_name!r} names a location that is not "
                "that section's.")
        new_rows.append(row)

    setting: Dict[str, Any] = {LOCATIONS: new_locations, SECTIONS: new_sections}
    if rows_changed:
        setting[ROWS] = new_rows

    after = copy.deepcopy(dict(document))
    after[SETUP] = {**setup, "locations": new_locations, "sections": new_sections}
    made_from = (document.get(ASSIGNMENT) or {}).get("madeFrom")
    if not isinstance(made_from, dict) or "plan" not in made_from:
        record = "none is stored, so none is written"
    elif made_from["plan"] == _plan_fingerprint(document):
        setting[f"{MADE_FROM}.plan"] = _plan_fingerprint(after)
        record = "carried over to the plan as swapped, so the allocation stands as it stood"
    else:
        record = "left as it is, since it already differs from the plan as read"

    layouts = sum(
        1 for layout in setup.get("floorplans") or []
        if isinstance(layout, dict) and layout.get("locationId") in name_before)
    return Swap(
        setting=setting,
        locations=[(place["id"], place["name"], name_after[place["id"]]) for place in (one, other)],
        sections=shown, rows_changed=rows_changed, rows_stored=len(rows), layouts=layouts,
        record=record, detail=History.changes(_recorded_plan(document), _recorded_plan(after)))


def _history_entries_naming(history, market_id: str, names: set) -> Tuple[int, int]:
    """How many of the market's history entries of a layout's save, and of a layout removed with
    its location, name one of ``names`` as their subject's location. Read only."""
    counts = {FLOORPLAN: 0, FLOORPLAN_REMOVED: 0}
    for entry in history.find({MARKET_ID_FIELD: market_id, "kind": {"$in": list(counts)}}):
        if (entry.get("subject") or {}).get("location") in names:
            counts[entry["kind"]] += 1
    return counts[FLOORPLAN], counts[FLOORPLAN_REMOVED]


def swap(market_id: str, first: str, second: str, db=None, dry_run: bool = False) -> Swap:
    """Swap the two locations' names on the market, or say what a run would write.

    Raises:
        Refused: why not; nothing was written.
    """
    if db is None:
        from db_config import get_database
        db = get_database()
    markets = db[MARKETS_COLLECTION]
    if markets != MarketWrite.markets_collection:
        raise RuntimeError(
            "swap_location_names reads the markets write_market writes: pass the configured "
            "database, or none")
    if not History.records_in(db):
        raise RuntimeError(
            "swap_location_names records in the history the history module writes: pass the "
            "configured database, or none")

    document = markets.find_one(live({"id": market_id}))
    if document is None:
        raise Refused(f"No market has the id {market_id!r}.")
    judgment = judged(document, first, second)

    print(f"market {market_id}:" + (" (dry run: nothing is written)" if dry_run else ""))
    for place_id, before, after in judgment.locations:
        print(f"  - location {place_id}: {before!r} -> {after!r}")
    for name, before, after in judgment.sections:
        print(f"  - section {name!r}: under {before!r} -> under {after!r}")
    print(f"  - {len(judgment.sections)} section(s); {judgment.rows_changed} of "
          f"{judgment.rows_stored} stored seat(s); {judgment.layouts} layout(s), each kept on "
          "its location's id")
    print(f"  - the allocation's record of the plan: {judgment.record}")
    saved, removed = _history_entries_naming(
        db[HISTORY_COLLECTION], market_id, {before for _id, before, _after in judgment.locations})
    print(f"  - the market's history: {saved} layout save(s) and {removed} layout removal(s) name "
          "either location as it was called then, and stay as written")
    print(f"  - the market's history: {_runs_recorded(db[HISTORY_COLLECTION], market_id)} run(s) "
          "of this script recorded so far")

    if not dry_run:
        try:
            write_market(document, {"$set": judgment.setting}, holds=(REVISION, MADE_FROM),
                         revisions={PLAN_REVISION: document.get(PLAN_REVISION)})
        except MarketNotFoundError as error:
            raise Refused("The market is gone, or being deleted.") from error
        except MarketChanged as error:
            raise Refused(
                "The market changed between the read and the write, so nothing was written. "
                "Run it again.") from error
        record_swapped(market_id, judgment.detail)
    print("\nwould swap the two names." if dry_run else "\nswapped the two names.")
    return judgment


def main(argv: List[str]) -> int:
    dry_run = "--dry-run" in argv
    arguments = [argument for argument in argv if argument != "--dry-run"]
    if len(arguments) != 3 or any(argument.startswith("--") for argument in arguments):
        print("usage: swap_location_names.py <market-id> <location> <location> [--dry-run]",
              file=sys.stderr)
        return 2
    try:
        swap(*arguments, dry_run=dry_run)
    except Refused as refusal:
        print(f"refused, nothing written: {refusal}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
