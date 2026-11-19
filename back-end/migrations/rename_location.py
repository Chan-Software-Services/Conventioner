#!/usr/bin/env python3
"""Give one location of a market past Draft a new name.

The setup settles on leaving draft (``docs/business/rules/the-setup-settles-on-leaving-draft.md``),
so the app refuses to rename a location once applicants rely on the plan. This script is the
operator's way to do it: the location takes a name no location of the market holds, and keeps
everything else. ``swap_location_names.py``, beside it, trades the names of two locations; this
one follows it step for step, for one location.

Each copy of the location's name the market's pages read as the name now is on the market's own
document, and each is rewritten:

- ``setupObject.locations[].name``, the location itself;
- ``setupObject.sections[].location.name``, each section's copy of its location;
- ``assignmentObject.vendorAssignments[].location``, each seat's copy, which a vendor's result, the
  door's roster and the organizer's tables read as stored;
- ``assignmentObject.madeFrom.plan``, the fingerprint of the plan the table allocation was made
  from, which covers the names: it is carried over to the plan as renamed only where it matched the
  plan as read, so an allocation that read as current still does, and one that did not is left.

It keeps every id (location, section, table), so a layout, which names its location by id, stays on
the same location under its new name. It does not count the assignment's ``revision``, so published
results do not read as changed, and it sends nothing to anyone.

**The new name is stored as given.** Market Setup stores a location's name as typed: the app trims
nothing, sets no length and no character limit, and does not refuse two locations of one name. The
script is stricter, since a seat's copy of a name must say which location it means: it refuses a
name that is empty or only spaces, that starts or ends with a space, that is the name the location
has, or that another of the plan's locations has, and one that a section's or a seat's copy
already holds.

**It records the rename in the market's history**, as one entry of the kind a change on Market
Setup records (``plan``, under the Market Setup row), with no actor and whichever of the plan's two
lists, its locations and its sections, changed, each list whole, before and after, as a plan
save's entry holds them: so the entry holds every location's name, the other locations' among
them, and every section's row when a section's copy changed. Manage market reads "Someone changed
Market Setup: locations and sections" when the location holds a section, and "locations" alone
when it holds none. A dry run records none, and a second run records a second entry.

**The swap's script counts a rename's entry as a run of its own.** ``swap_location_names.py``
counts the market's ``plan`` entries with no actor as its runs, and a rename's entry is one. This
script tells them apart by what an entry changed: it counts as a rename an entry with no actor
whose locations differ, before and after, in the name of exactly one, and prints that count beside
the count of every such entry with no actor. So after a rename, the swap's line "run(s) of this
script recorded so far" reads one more than the swaps that were run; the two scripts may be run in
either order.

**The market's earlier history also holds the name, as text, and is left as written**, as the swap
leaves it. Three kinds of entry in the ``history`` collection name a location as it was called when
they were recorded: ``floorplan``, each save of a layout; ``floorplan_removed``, a layout removed
with its location; and ``plan``, a change on Market Setup. So after the rename an entry of a
layout's save still names its location by the old name. The script counts the market's
``floorplan`` and ``floorplan_removed`` entries naming the location and prints the two counts.

It refuses, writing nothing and exiting 1, when: the market is not found, is being deleted, does
not parse, has no plan or is a draft (rename it on Market Setup); the location is not found, or
shares its name with another of the plan's locations; the new name is one of those refused above;
the location, a section in it, or that section's copy of it has no stored id (run
``migrate_layouts.py`` first: an id read from a name would change with the name); a section's copy
disagrees with the location it names; a seat's copy of the name disagrees with the section it is
in; or the market changed between the read and the write.

**The rename is one write, all or nothing; its history entry is a second write.** The whole rename
is a single update of the market's document, through ``write_market``, holding the phase,
``planRevision``, the assignment's ``revision`` and ``madeFrom`` as read, and counting
``planRevision``, as every write of the plan does. It lands whole or not at all, and a market
whose held keys moved since the read refuses it with nothing written. The entry is written after
it, into another collection. A failure between the two leaves the location renamed and no entry:
the history logs a warning naming the market by id, and the script still says it renamed. The next
``--dry-run`` of the way back shows it: the location stands under the new name, and the count of
renames recorded is one fewer than were run. Nothing is repaired by running again; the missing
entry is the only loss.

**Run it while no organizer is working on the market.** A plan or layout save that read the market
before the rename is refused after it, since the plan's revision moved. A seat written by hand is
not: the assignment's ``revision`` is left as it was, so a placement, a free or a swap of seats
whose request read the market just before the rename and wrote just after puts every seat back
under the old name, over the renamed plan. The next ``--dry-run`` of the way back shows it: it
refuses with a stored seat that "already names a location" of the old name, "which is none of the
plan's". The seats' names are then put right in the database by hand, each to its section's
location, before anything is run again.

**A rename is undone by a second run giving the old name**, which restores every value this script
wrote but ``planRevision``, which counts each run. So run ``--dry-run`` first and read the name and
the sections under it before and after, run it once, and run ``--dry-run`` of the way back: it
shows the first one's "after" as its "before".

The location is named by its id or its exact name. It prints the market's id, the location's id,
its old and new name, the names of the sections in it, and counts: never a vendor's name or
address, and no other location's name. That is of what it prints: the history entry a run records
holds the plan's whole list of locations.

It imports nothing of ``swap_location_names.py``, so it runs from a checkout that holds this file
alone on top of a release.

Usage (the production database address passed inline, never from back-end/.env):
    MONGODB_URI='<URI>' python migrations/rename_location.py \\
        <market-id> <location> <new-name> [--dry-run]
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

#: Why the rename is recorded under the Market Setup row with no request asking it
#: (``History.unasked``).
RENAME_RECORDS_UNASKED = (
    "an operator's script, run from a shell and never a request: it changes the plan's locations "
    "and sections past draft, and records it as a plan write records its change, with no actor")

#: The plan's fields the rename changes, as a plan write's entry names them.
RECORDED_FIELDS = ("locations", "sections")

NEEDS_IDS = "Run migrations/migrate_layouts.py first, which stores the ids every read gives."


class Refused(Exception):
    """Why the rename is not made. Nothing was written."""


class Rename(NamedTuple):
    """One market's rename, judged: what is written, and what the operator reads of it."""

    #: The stored keys set, and their values.
    setting: Dict[str, Any]
    #: The location, as ``(id, name before, name after)``.
    location: Tuple[str, str, str]
    #: The names of the sections in the location.
    sections: List[str]
    #: How many stored seats change, and how many the market stores.
    rows_changed: int
    rows_stored: int
    #: How many layouts the location holds, each staying on its location's id.
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


def record_renamed(market_id: str, detail: Mapping[str, Any]) -> None:
    """The rename's entry in the market's history: a change on Market Setup, with no actor."""
    History.unasked(market_id, None, Actions.CHANGE_SETUP, because=RENAME_RECORDS_UNASKED).record(
        kind=History.PLAN, detail=dict(detail))


def _renames_one(entry: Mapping[str, Any]) -> bool:
    """Whether a ``plan`` entry's locations differ, before and after, in the name of exactly one:
    a rename's entry, where a swap's differs in two."""
    detail = entry.get("detail") or {}
    before = (detail.get("before") or {}).get("locations")
    after = (detail.get("after") or {}).get("locations")
    if not isinstance(before, list) or not isinstance(after, list) or len(before) != len(after):
        return False
    pairs = list(zip(before, after))
    if not all(isinstance(one, dict) and isinstance(other, dict) and one.get("id") == other.get("id")
               for one, other in pairs):
        return False
    return sum(1 for one, other in pairs if one.get("name") != other.get("name")) == 1


def _runs_recorded(history, market_id: str) -> Tuple[int, int]:
    """How many runs of this script the market's history records, and how many ``plan`` entries
    with no actor it holds in all, which the swap's script counts as its own runs. Read only."""
    unasked = [
        entry for entry in history.find({MARKET_ID_FIELD: market_id, "kind": History.PLAN})
        if entry.get("actor") is None and entry.get("action") == Actions.CHANGE_SETUP.id]
    return sum(1 for entry in unasked if _renames_one(entry)), len(unasked)


def _new_name_refusal(new_name: str, place: Mapping[str, Any],
                      locations: List[Dict[str, Any]]) -> str:
    """Why the location may not take ``new_name``, or an empty string."""
    if not new_name.strip():
        return "The new name is empty."
    if new_name != new_name.strip():
        return f"The new name {new_name!r} starts or ends with a space."
    if new_name == place["name"]:
        return f"The location is already named {new_name!r}."
    if any(each.get("name") == new_name for each in locations):
        return f"Another of the plan's locations is already named {new_name!r}."
    return ""


def judged(document: Mapping[str, Any], wanted: str, new_name: str) -> Rename:
    """The rename of the location on the market as read, or ``Refused``."""
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

    place = _named(locations, wanted)
    if not _has_id(place):
        raise Refused(f"The location {place.get('name')!r} has no stored id. {NEEDS_IDS}")
    old_name, place_id = place["name"], place["id"]
    if sum(1 for each in locations if each.get("name") == old_name) > 1:
        raise Refused(
            f"More than one location is named {old_name!r}, so a copy of the name does not say "
            "which it means.")
    refused = _new_name_refusal(new_name, place, locations)
    if refused:
        raise Refused(refused)

    new_locations = [{**each, "name": new_name} if each is place else each for each in locations]

    new_sections, section_names = [], []
    elsewhere: Dict[Any, set] = {}
    for section in sections:
        held = section.get("location")
        if not isinstance(held, dict):
            new_sections.append(section)
            continue
        held_id, held_name, label = held.get("id"), held.get("name"), section.get("name")
        if held_id != place_id:
            if held_name == old_name:
                raise Refused(
                    f"The section {label!r} names the location {held_name!r} with "
                    + ("another location's id." if _has_id(held) else f"no stored id. {NEEDS_IDS}"))
            if held_name == new_name:
                raise Refused(
                    f"The section {label!r} already names a location {new_name!r}, which is none "
                    "of the plan's.")
            elsewhere.setdefault(held_name, set()).add(label)
            new_sections.append(section)
            continue
        if held_name != old_name:
            raise Refused(
                f"The section {label!r} holds the id of the location {old_name!r} under another "
                "name.")
        if not _has_id(section):
            raise Refused(f"The section {label!r} has no stored id. {NEEDS_IDS}")
        section_names.append(label)
        new_sections.append({**section, "location": {**held, "name": new_name}})

    new_rows, rows_changed = [], 0
    for row in rows:
        held_name, section_name = row.get("location"), row.get("section")
        if held_name == old_name:
            if section_name not in section_names:
                raise Refused(
                    f"A stored seat names the location {held_name!r} in the section "
                    f"{section_name!r}, which the plan does not put there.")
            new_rows.append({**row, "location": new_name})
            rows_changed += 1
            continue
        if held_name == new_name:
            raise Refused(
                f"A stored seat already names a location {new_name!r}, which is none of the "
                "plan's.")
        if section_name in section_names and section_name not in elsewhere.get(held_name, set()):
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
        record = "carried over to the plan as renamed, so the allocation stands as it stood"
    else:
        record = "left as it is, since it already differs from the plan as read"

    layouts = sum(
        1 for layout in setup.get("floorplans") or []
        if isinstance(layout, dict) and layout.get("locationId") == place_id)
    return Rename(
        setting=setting, location=(place_id, old_name, new_name), sections=section_names,
        rows_changed=rows_changed, rows_stored=len(rows), layouts=layouts, record=record,
        detail=History.changes(_recorded_plan(document), _recorded_plan(after)))


def _history_entries_naming(history, market_id: str, name: str) -> Tuple[int, int]:
    """How many of the market's history entries of a layout's save, and of a layout removed with
    its location, name ``name`` as their subject's location. Read only."""
    counts = {FLOORPLAN: 0, FLOORPLAN_REMOVED: 0}
    for entry in history.find({MARKET_ID_FIELD: market_id, "kind": {"$in": list(counts)}}):
        if (entry.get("subject") or {}).get("location") == name:
            counts[entry["kind"]] += 1
    return counts[FLOORPLAN], counts[FLOORPLAN_REMOVED]


def rename(market_id: str, location: str, new_name: str, db=None, dry_run: bool = False) -> Rename:
    """Give the location its new name on the market, or say what a run would write.

    Raises:
        Refused: why not; nothing was written.
    """
    if db is None:
        from db_config import get_database
        db = get_database()
    markets = db[MARKETS_COLLECTION]
    if markets != MarketWrite.markets_collection:
        raise RuntimeError(
            "rename_location reads the markets write_market writes: pass the configured "
            "database, or none")
    if not History.records_in(db):
        raise RuntimeError(
            "rename_location records in the history the history module writes: pass the "
            "configured database, or none")

    document = markets.find_one(live({"id": market_id}))
    if document is None:
        raise Refused(f"No market has the id {market_id!r}.")
    judgment = judged(document, location, new_name)

    place_id, before, after = judgment.location
    print(f"market {market_id}:" + (" (dry run: nothing is written)" if dry_run else ""))
    print(f"  - location {place_id}: {before!r} -> {after!r}")
    for name in judgment.sections:
        print(f"  - section {name!r}: under {before!r} -> under {after!r}")
    print(f"  - {len(judgment.sections)} section(s); {judgment.rows_changed} of "
          f"{judgment.rows_stored} stored seat(s); {judgment.layouts} layout(s), each kept on "
          "its location's id")
    print(f"  - the allocation's record of the plan: {judgment.record}")
    saved, removed = _history_entries_naming(db[HISTORY_COLLECTION], market_id, before)
    print(f"  - the market's history: {saved} layout save(s) and {removed} layout removal(s) name "
          "the location as it was called then, and stay as written")
    renames, unasked = _runs_recorded(db[HISTORY_COLLECTION], market_id)
    print(f"  - the market's history: {renames} rename(s) by this script recorded so far, of "
          f"{unasked} Market Setup change(s) with no actor, which swap_location_names.py counts "
          "as its own runs")

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
        record_renamed(market_id, judgment.detail)
    print("\nwould rename the location." if dry_run else "\nrenamed the location.")
    return judgment


def main(argv: List[str]) -> int:
    dry_run = "--dry-run" in argv
    arguments = [argument for argument in argv if argument != "--dry-run"]
    if len(arguments) != 3 or any(argument.startswith("--") for argument in arguments):
        print("usage: rename_location.py <market-id> <location> <new-name> [--dry-run]",
              file=sys.stderr)
        return 2
    try:
        rename(*arguments, dry_run=dry_run)
    except Refused as refusal:
        print(f"refused, nothing written: {refusal}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
