"""One location of a market past Draft takes a new name, and every read shows it.

The setup settles on leaving draft, so the app refuses the rename; ``rename_location.py`` is the
operator's way to give a location a name no location of the market holds. These tests read the
market the way its pages do (the plan, a vendor's result, the door's roster, the organizer's
tables, the public map) before and after the rename, and hold the script to what it must leave
alone: every id, the layout's location, the assignment's revision, the published results, the
attendance records, the history's earlier entries, and everyone's inbox. A run records itself in
the history as one change on Market Setup, which the swap's script counts as a run of its own.
"""
import copy

import pytest

from conftest import FakeSlugMarketsCollection, made_from_now, stored_assignment, stored_market

import api.applications as ApplicationsApi
import api.attendance as AttendanceApi
import api.markets as MarketsApi
import app as app_module
import assignment.lifecycle as Lifecycle
import db_config as test_db_config
import discord_client
import market_write as MarketWrite
import result_outcome as ResultOutcome
import utils.email as Email
from assignment.lifecycle import Allocation
from datatypes import MarketPhase, market_name_slug
from market_documents import market_from_document
from market_write import MarketChanged, write_market
from rename_location import Refused, main, rename
from swap_location_names import swap

MARKET = "market-123"
SLUG = market_name_slug("Test Market")
DAY_ONE, DAY_TWO = "2099-08-01", "2099-08-02"
NORTH = {"id": "loc-north", "name": "North Wing"}
SOUTH = {"id": "loc-south", "name": "South Wing"}
GOLD = {"id": 0, "name": "Gold"}
SIX_FOOT = {"id": "tt-six", "name": "Standard 6 ft", "widthMm": 1830, "depthMm": 760}
FORM = {"fields": [{"key": "business_name", "label": "Business name", "type": "text"}]}
ANA, BEN = "ana@ember.test", "ben@kiln.test"
TOMBSTONE = {"at": "2099-08-01T00:00:00+00:00", "by": "user-1", "trail_id": "t-1"}
NEW = "Garden Hall"


def _table(table_id, number, x):
    return {"id": table_id, "sectionId": "sec-a", "number": number, "tableTypeId": "tt-six",
            "xMm": x, "yMm": 5000.0, "rotation": 0.0}


def _plan():
    """Two locations, a section in each; the North Wing alone is laid out."""
    return {
        "priority": [], "marketDates": [{"date": DAY_ONE}, {"date": DAY_TWO}],
        "tiers": [GOLD],
        "locations": [copy.deepcopy(NORTH), copy.deepcopy(SOUTH)],
        "sections": [
            {"id": "sec-a", "name": "Aisle A", "count": 2, "location": copy.deepcopy(NORTH),
             "tier": GOLD},
            {"id": "sec-b", "name": "Aisle B", "count": 3, "location": copy.deepcopy(SOUTH),
             "tier": GOLD},
        ],
        "assignmentOptions": {},
        "tableTypes": [copy.deepcopy(SIX_FOOT)],
        "floorplans": [{
            "id": "fp-north", "locationId": NORTH["id"], "revision": 3, "imageGridfsId": None,
            "scalePxPerUnit": 800 / 30_000,
            "tables": [_table("t-a1", 1, 3000.0), _table("t-a2", 2, 5000.0)],
            "zones": [], "sectionStyles": [],
            "startingCounts": [{"sectionId": "sec-a", "count": 2}], "followsPlan": False,
        }],
    }


def _seat(email, date, code, section, location, hand_placed=False):
    return {"email": email, "date": date, "tableCode": code, "tableChoice": "Full Table",
            "section": section, "tier": "Gold", "location": location, "handPlaced": hand_placed}


def _seats():
    return [
        _seat(ANA, DAY_ONE, "Aisle A 1", "Aisle A", "North Wing"),
        _seat(ANA, DAY_TWO, "Aisle A 2", "Aisle A", "North Wing", hand_placed=True),
        _seat(BEN, DAY_ONE, "Aisle B 2", "Aisle B", "South Wing"),
    ]


def settled_market(phase=MarketPhase.MARKET_DAYS, published=True, **overrides):
    """A market past Draft with tables allocated, as stored: in its market days with results
    published, unless asked otherwise. Its allocation was made from the plan it holds."""
    doc = stored_market(
        phase, id=MARKET, intakeMode="csv", applicationForm=copy.deepcopy(FORM),
        setupObject=_plan(), planRevision=7, resultsPublished=published,
        publicMap={"enabled": True, "nameQuestion": "business_name"},
        **overrides,
    )
    doc["assignmentObject"] = stored_assignment(
        "run", _seats(), made_from=made_from_now(doc), revision=5,
        published_revision=5 if published else None)
    return doc


class Database:
    """The markets the script reads, in the one collection ``write_market`` writes."""

    def __init__(self, markets_collection, history_collection):
        self.markets = markets_collection
        self.history = history_collection

    def __getitem__(self, name):
        return {"markets": self.markets, "history": self.history}[name]


@pytest.fixture
def database(monkeypatch, market_records):
    """A database holding the market given, with a check-in recorded, and nothing that can send."""
    def refuse_to_send(*_args, **_kwargs):
        raise AssertionError("the rename sends nothing to anyone")

    monkeypatch.setattr(Email, "send_mail", refuse_to_send)
    monkeypatch.setattr(discord_client, "_send", refuse_to_send)
    monkeypatch.setattr(ApplicationsApi, "vendor_names_for_market", lambda _id: {ANA: "Ana"})
    monkeypatch.setattr(ApplicationsApi, "vendor_full_names_for_market", lambda _id: {})
    market_records.attendance.insert_one({
        "market_id": MARKET, "vendor_email": ANA, "date": DAY_ONE, "table_code": "Aisle A 1",
        "checked_in_at": "2099-08-01T09:00:00+00:00", "checked_in_by": "owner@example.com",
    })

    def make(*docs, collection=FakeSlugMarketsCollection):
        markets = collection(list(docs))
        monkeypatch.setattr(MarketWrite, "markets_collection", markets)

        class _Db(dict):
            def __getitem__(self, name):
                if name == "history":
                    return market_records.history
                return markets if name == "markets" else FakeSlugMarketsCollection([])

        monkeypatch.setattr(test_db_config, "get_database", lambda *_a, **_kw: _Db())
        return Database(markets, market_records.history)
    return make


def stored(db):
    return next(doc for doc in db.markets.docs if doc["id"] == MARKET)


def read(db):
    """What the market's pages show of its locations, each read the way its page reads it."""
    doc = copy.deepcopy(stored(db))
    market = market_from_document(doc)
    plan = market.setup_object
    seats = market.assignment_object.vendor_assignments
    public = app_module.app.test_client().get(f"/public/markets/{SLUG}/map").get_json()
    return {
        "plan": {
            "locations": [(place.id, place.name) for place in plan.locations],
            "sections": [(section.id, section.name, section.location.id, section.location.name,
                          section.count) for section in plan.sections],
        },
        "results": {
            email: [(seat["date"], seat["tableCode"], seat["section"], seat["location"])
                    for seat in ResultOutcome.seats_of(email, seats)]
            for email in (ANA, BEN)
        },
        "door": [(row["vendorEmail"], row["date"], row["tableCode"], row["section"],
                  row["location"], row["state"])
                 for row in AttendanceApi.attendance_roster(doc)["roster"]],
        "tables": [(row.date, row.table_code, row.section, row.location, tuple(row.assignment))
                   for row in MarketsApi.derive_market_table_rows(market)],
        "map": [(place["id"], place["name"], [section["name"] for section in place["sections"]],
                 place["layout"]["locationId"], [table["id"] for table in place["layout"]["tables"]])
                for place in public["locations"]],
        "layouts": [(layout.id, layout.location_id, [table.id for table in layout.tables])
                    for layout in plan.floorplans],
    }


def renamed(value):
    """``value`` with the North Wing's name replaced wherever it stands, and nothing else moved."""
    if isinstance(value, str):
        return NEW if value == "North Wing" else value
    if isinstance(value, (list, tuple)):
        return type(value)(renamed(item) for item in value)
    if isinstance(value, dict):
        return {key: renamed(item) for key, item in value.items()}
    return value


# --- the rename, as every page reads it -------------------------------------------------------

def test_every_read_shows_the_new_name_over_the_same_tables(database, market_records):
    db = database(settled_market())
    attendance = copy.deepcopy(market_records.attendance.documents)
    before = read(db)
    assert before["plan"]["sections"][0] == ("sec-a", "Aisle A", "loc-north", "North Wing", 2)
    assert (ANA, DAY_ONE, "Aisle A 1", "Aisle A", "North Wing", "here") in before["door"]
    assert before["map"] == [("loc-north", "North Wing", ["Aisle A"], "loc-north", ["t-a1", "t-a2"])]

    rename(MARKET, "North Wing", NEW, db)

    after = read(db)
    # The organizer's tables are listed by location, so their order follows the names.
    assert sorted(after.pop("tables")) == sorted(renamed(before.pop("tables")))
    assert after == renamed(before)
    assert after["plan"]["locations"] == [("loc-north", NEW), ("loc-south", "South Wing")]
    assert after["plan"]["sections"][0] == ("sec-a", "Aisle A", "loc-north", NEW, 2)
    assert after["results"][ANA] == [
        (DAY_ONE, "Aisle A 1", "Aisle A", NEW), (DAY_TWO, "Aisle A 2", "Aisle A", NEW)]
    assert after["results"][BEN] == [(DAY_ONE, "Aisle B 2", "Aisle B", "South Wing")]
    assert (ANA, DAY_ONE, "Aisle A 1", "Aisle A", NEW, "here") in after["door"]
    # The layout is still on its location, and the attendance rows are as they were recorded.
    assert after["layouts"] == [("fp-north", "loc-north", ["t-a1", "t-a2"])]
    assert after["map"] == [("loc-north", NEW, ["Aisle A"], "loc-north", ["t-a1", "t-a2"])]
    assert market_records.attendance.documents == attendance


def test_nothing_but_the_name_and_the_plans_fingerprint_is_written(database):
    doc = settled_market()
    db = database(doc)

    rename(MARKET, "North Wing", NEW, db)

    expected = renamed(copy.deepcopy(doc))
    expected["planRevision"] = 8
    expected["assignmentObject"]["madeFrom"]["plan"] = made_from_now(stored(db))["plan"]
    assert stored(db) == expected
    assert expected["assignmentObject"]["madeFrom"]["plan"] != doc["assignmentObject"]["madeFrom"]["plan"]


def test_the_location_is_named_by_its_id_as_well_as_its_name(database):
    by_name = database(settled_market())
    rename(MARKET, "North Wing", NEW, by_name)
    after_by_name = stored(by_name)

    by_id = database(settled_market())
    rename(MARKET, "loc-north", NEW, by_id)

    assert stored(by_id) == after_by_name


def test_a_second_run_with_the_old_name_restores_every_value_but_the_plans_revision(database):
    doc = settled_market()
    db = database(doc)

    rename(MARKET, "North Wing", NEW, db)
    assert stored(db) != doc
    rename(MARKET, "loc-north", "North Wing", db)

    assert stored(db) == {**doc, "planRevision": 9}


def test_a_location_with_no_section_and_no_seat_is_renamed(database):
    doc = settled_market()
    doc["setupObject"]["locations"].append({"id": "loc-east", "name": "East Wing"})
    db = database(copy.deepcopy(doc))

    judgment = rename(MARKET, "East Wing", NEW, db)

    after = stored(db)
    assert after["setupObject"]["locations"][2] == {"id": "loc-east", "name": NEW}
    assert after["assignmentObject"]["vendorAssignments"] == doc["assignmentObject"]["vendorAssignments"]
    assert (judgment.sections, judgment.rows_changed, judgment.layouts) == ([], 0, 0)


# --- the dry run ------------------------------------------------------------------------------

def test_a_dry_run_writes_nothing_and_prints_the_before_and_after(
        database, market_records, capsys):
    doc = settled_market()
    db = database(doc)

    rename(MARKET, "North Wing", NEW, db, dry_run=True)

    assert stored(db) == doc
    assert db.markets.last_update is None
    assert market_records.history.documents == []
    printed = capsys.readouterr().out
    assert "market market-123: (dry run: nothing is written)" in printed
    assert "location loc-north: 'North Wing' -> 'Garden Hall'" in printed
    assert "section 'Aisle A': under 'North Wing' -> under 'Garden Hall'" in printed
    assert "1 section(s); 2 of 3 stored seat(s); 1 layout(s)" in printed
    assert "carried over to the plan as renamed" in printed
    assert "would rename the location." in printed


def test_the_dry_run_of_the_way_back_shows_the_first_runs_after_as_its_before(database, capsys):
    db = database(settled_market())
    rename(MARKET, "North Wing", NEW, db)
    capsys.readouterr()

    rename(MARKET, NEW, "North Wing", db, dry_run=True)

    assert "section 'Aisle A': under 'Garden Hall' -> under 'North Wing'" in capsys.readouterr().out


def test_it_prints_no_vendor_and_no_other_locations_name(database, capsys):
    db = database(settled_market())

    rename(MARKET, "North Wing", NEW, db)

    captured = capsys.readouterr()
    for other in (ANA, BEN, "Ana", "South Wing", "Aisle B"):
        assert other not in captured.out + captured.err


# --- what it leaves alone ---------------------------------------------------------------------

def test_published_results_stay_published_on_the_same_revision_and_nothing_is_sent(
        database, market_records):
    doc = settled_market()
    db = database(doc)
    assert Lifecycle.allocation(market_from_document(copy.deepcopy(doc))) is Allocation.PUBLISHED

    # ``database`` makes every send raise.
    rename(MARKET, "North Wing", NEW, db)

    after = stored(db)
    assert after["assignmentObject"]["revision"] == 5
    assert after["assignmentObject"]["publishedRevision"] == 5
    assert after["assignmentObject"]["state"] == "run"
    assert after["resultsPublished"] is True
    assert after["planRevision"] == 8
    assert after["phase"] == doc["phase"]
    assert Lifecycle.allocation(market_from_document(copy.deepcopy(after))) is Allocation.PUBLISHED
    assert market_records.payments.documents == []
    assert market_records.amounts_owed.documents == []


def test_an_allocation_that_read_as_current_still_does(database):
    doc = settled_market(MarketPhase.ASSIGNMENT, published=False)
    db = database(doc)
    assert Lifecycle.allocation(market_from_document(copy.deepcopy(doc))) is Allocation.CURRENT

    rename(MARKET, "North Wing", NEW, db)

    after = stored(db)
    assert Lifecycle.allocation(market_from_document(copy.deepcopy(after))) is Allocation.CURRENT
    assert after["assignmentObject"]["madeFrom"]["plan"] != doc["assignmentObject"]["madeFrom"]["plan"]
    assert after["assignmentObject"]["revision"] == 5


def test_an_allocation_made_from_another_plan_keeps_its_record(database, capsys):
    doc = settled_market(MarketPhase.ASSIGNMENT, published=False)
    doc["assignmentObject"]["madeFrom"]["plan"] = "an-older-plan"
    db = database(doc)
    assert Lifecycle.allocation(market_from_document(copy.deepcopy(doc))) is Allocation.STALE

    rename(MARKET, "North Wing", NEW, db)

    after = stored(db)
    assert after["assignmentObject"]["madeFrom"] == doc["assignmentObject"]["madeFrom"]
    assert Lifecycle.allocation(market_from_document(copy.deepcopy(after))) is Allocation.STALE
    assert "left as it is" in capsys.readouterr().out


# --- the rename's own entry in the market's history, and the swap's count of it ---------------

def plan_fields(doc):
    """The plan's locations and sections as a plan write's entry holds them."""
    plan = market_from_document(copy.deepcopy(doc)).setup_object.model_dump()
    return {"locations": plan["locations"], "sections": plan["sections"]}


def recorded(market_records):
    return [{key: value for key, value in entry.items() if key not in ("_id", "id", "at")}
            for entry in market_records.history.documents]


def test_a_run_records_one_plan_change_with_no_actor(database, market_records):
    doc = settled_market()
    db = database(doc)

    rename(MARKET, "North Wing", NEW, db)

    assert recorded(market_records) == [{
        "market_id": MARKET, "actor": None, "action": "change-setup", "kind": "plan",
        "vendors": [], "subject": {},
        "detail": {"before": plan_fields(doc), "after": plan_fields(stored(db))},
    }]
    [entry] = recorded(market_records)
    assert [place["name"] for place in entry["detail"]["after"]["locations"]] == [NEW, "South Wing"]


def test_a_rename_of_a_location_with_no_section_records_its_locations_alone(
        database, market_records):
    doc = settled_market()
    doc["setupObject"]["locations"].append({"id": "loc-east", "name": "East Wing"})
    db = database(doc)

    rename(MARKET, "East Wing", NEW, db)

    [entry] = recorded(market_records)
    assert list(entry["detail"]["before"]) == ["locations"]


def test_the_swaps_count_of_its_runs_takes_a_rename_and_the_renames_count_takes_no_swap(
        database, market_records, capsys):
    """The swap counts every Market Setup change with no actor as a run of its own, and is left as
    it is; the rename tells its own entries from a swap's by what each changed."""
    db = database(settled_market())

    rename(MARKET, "North Wing", NEW, db)
    assert ("0 rename(s) by this script recorded so far, of 0 Market Setup change(s) with no actor"
            in capsys.readouterr().out)

    swap(MARKET, NEW, "South Wing", db, dry_run=True)
    assert "1 run(s) of this script recorded so far" in capsys.readouterr().out
    swap(MARKET, NEW, "South Wing", db)
    capsys.readouterr()

    rename(MARKET, "loc-north", "North Wing", db, dry_run=True)
    assert ("1 rename(s) by this script recorded so far, of 2 Market Setup change(s) with no actor"
            in capsys.readouterr().out)
    assert len(market_records.history.documents) == 2


def test_an_entry_that_fails_to_write_leaves_the_rename_and_the_next_dry_run_shows_it(
        database, market_records, monkeypatch, capsys):
    db = database(settled_market())

    def fail(_entry):
        raise ConnectionError("the history could not be reached")

    with monkeypatch.context() as patched:
        patched.setattr(market_records.history, "insert_one", fail)
        rename(MARKET, "North Wing", NEW, db)

    assert stored(db)["setupObject"]["locations"][0] == {"id": "loc-north", "name": NEW}
    assert market_records.history.documents == []
    capsys.readouterr()

    rename(MARKET, "loc-north", "North Wing", db, dry_run=True)

    printed = capsys.readouterr().out
    assert "location loc-north: 'Garden Hall' -> 'North Wing'" in printed
    assert "0 rename(s) by this script recorded so far" in printed


def _entry(kind, location, market_id=MARKET):
    return {"id": f"h-{kind}-{location}-{market_id}", "market_id": market_id,
            "actor": "owner@example.com", "at": "2099-07-01T00:00:00+00:00",
            "action": "change-setup", "kind": kind, "vendors": [],
            "subject": {"floorplan_id": "fp-north", "location": location}, "detail": {}}


def test_it_counts_the_history_entries_naming_the_location_and_leaves_them(
        database, market_records, capsys):
    db = database(settled_market())
    for entry in (
        _entry("floorplan", "North Wing"), _entry("floorplan", "North Wing"),
        _entry("floorplan_removed", "North Wing"),
        # Not counted: another location's, another market's, and a kind that names none.
        _entry("floorplan", "South Wing"), _entry("floorplan", "North Wing", "market-other"),
        _entry("table_types", "North Wing"),
    ):
        market_records.history.insert_one(entry)
    before = copy.deepcopy(market_records.history.documents)

    rename(MARKET, "North Wing", NEW, db)

    # Every entry there before is as it was; the run adds its own after them.
    assert market_records.history.documents[:len(before)] == before
    assert len(market_records.history.documents) == len(before) + 1
    assert ("the market's history: 2 layout save(s) and 1 layout removal(s) name the location"
            in capsys.readouterr().out)


# --- each refusal writes nothing --------------------------------------------------------------

def _no_id_on(key, name):
    def change(doc):
        for row in doc["setupObject"][key]:
            if row["name"] == name:
                del row["id"]
    return change


def _no_id_on_the_copy(doc):
    del doc["setupObject"]["sections"][0]["location"]["id"]


def _another_name_on_the_copy(doc):
    doc["setupObject"]["sections"][0]["location"]["name"] = "West Wing"


def _another_id_on_the_copy(doc):
    doc["setupObject"]["sections"][0]["location"]["id"] = "loc-south"


def _the_new_name_on_another_sections_copy(doc):
    doc["setupObject"]["sections"][1]["location"]["name"] = NEW


def _a_seat_naming_another_location(doc):
    doc["assignmentObject"]["vendorAssignments"][0]["location"] = "West Wing"


def _a_seat_in_another_locations_section(doc):
    doc["assignmentObject"]["vendorAssignments"][0]["section"] = "Aisle B"


def _a_seat_already_under_the_new_name(doc):
    doc["assignmentObject"]["vendorAssignments"][2]["location"] = NEW


def _a_second_location_of_the_name(doc):
    doc["setupObject"]["locations"].append({"id": "loc-twin", "name": "North Wing"})


def _a_draft(doc):
    doc["phase"] = "draft"


def _a_plan_that_does_not_parse(doc):
    doc["setupObject"]["locations"] = "North Wing, South Wing"


def _no_plan(doc):
    del doc["setupObject"]


REFUSALS = [
    ("a location that is not the plan's", None, ("West Wing", NEW), "no location"),
    ("an empty name", None, ("North Wing", ""), "new name is empty"),
    ("a name of spaces alone", None, ("North Wing", "   "), "new name is empty"),
    ("a name ending with a space", None, ("North Wing", "Garden Hall "),
     "starts or ends with a space"),
    ("the name it has", None, ("North Wing", "North Wing"), "already named 'North Wing'"),
    ("the name it has, the location given by id", None, ("loc-north", "North Wing"),
     "already named 'North Wing'"),
    ("another location's name", None, ("North Wing", "South Wing"),
     "Another of the plan's locations is already named 'South Wing'"),
    ("a location with no stored id", _no_id_on("locations", "North Wing"), ("North Wing", NEW),
     "has no stored id"),
    ("a section with no stored id", _no_id_on("sections", "Aisle A"), ("North Wing", NEW),
     "has no stored id"),
    ("a section's copy with no stored id", _no_id_on_the_copy, ("North Wing", NEW),
     "no stored id"),
    ("a section's copy under another name", _another_name_on_the_copy, ("North Wing", NEW),
     "under another name"),
    ("a section's copy with another location's id", _another_id_on_the_copy, ("North Wing", NEW),
     "another location's id"),
    ("another section's copy already under the new name", _the_new_name_on_another_sections_copy,
     ("North Wing", NEW), "already names a location 'Garden Hall'"),
    ("a seat's copy naming another location", _a_seat_naming_another_location,
     ("North Wing", NEW), "is not that section's"),
    ("a seat under another location's section", _a_seat_in_another_locations_section,
     ("North Wing", NEW), "does not put there"),
    ("a seat already under the new name", _a_seat_already_under_the_new_name,
     ("North Wing", NEW), "A stored seat already names a location 'Garden Hall'"),
    ("two locations of one name", _a_second_location_of_the_name, ("loc-north", NEW),
     "More than one location"),
    ("two locations of one name, given by the name", _a_second_location_of_the_name,
     ("North Wing", NEW), "name one by id"),
    ("a draft", _a_draft, ("North Wing", NEW), "is a draft"),
    ("a market that does not parse", _a_plan_that_does_not_parse, ("North Wing", NEW),
     "does not parse"),
    ("a market with no plan", _no_plan, ("North Wing", NEW), "has no plan"),
]


@pytest.mark.parametrize("change,arguments,words", [case[1:] for case in REFUSALS],
                         ids=[case[0] for case in REFUSALS])
def test_it_refuses_and_writes_nothing(database, market_records, change, arguments, words):
    doc = settled_market()
    if change:
        change(doc)
    db = database(copy.deepcopy(doc))

    with pytest.raises(Refused, match=words):
        rename(MARKET, *arguments, db)

    assert stored(db) == doc
    assert db.markets.last_update is None
    assert market_records.history.documents == []


def test_it_refuses_a_market_that_is_not_there(database, market_records):
    db = database(settled_market())

    with pytest.raises(Refused, match="No market"):
        rename("market-gone", "North Wing", NEW, db)

    assert db.markets.last_update is None
    assert market_records.history.documents == []


def test_a_market_changed_between_the_read_and_the_write_is_left(database, market_records):
    class ChangedAfterTheRead(FakeSlugMarketsCollection):
        """Another write, a seat moved by hand, lands once the script has read the market."""

        def find_one(self, query, projection=None):
            found = super().find_one(query, projection)
            self.docs[0]["assignmentObject"]["revision"] = 6
            return found

    doc = settled_market()
    db = database(doc, collection=ChangedAfterTheRead)

    with pytest.raises(Refused, match="changed between the read and the write"):
        rename(MARKET, "North Wing", NEW, db)

    assert stored(db) == {**doc, "assignmentObject": {**doc["assignmentObject"], "revision": 6}}
    assert market_records.history.documents == []


def test_a_market_being_deleted_by_the_time_of_the_write_is_left(database, market_records):
    class DeletingAfterTheRead(FakeSlugMarketsCollection):
        """The market's deletion starts once the script has read it."""

        def find_one(self, query, projection=None):
            found = super().find_one(query, projection)
            if found is not None and "deleting" not in self.docs[0]:
                self.docs[0]["deleting"] = dict(TOMBSTONE)
            return found

    doc = settled_market()
    db = database(doc, collection=DeletingAfterTheRead)

    with pytest.raises(Refused, match="gone, or being deleted"):
        rename(MARKET, "North Wing", NEW, db)

    assert stored(db) == {**doc, "deleting": TOMBSTONE}
    assert market_records.history.documents == []


# --- a write that read the market before the rename -------------------------------------------

def test_a_plan_write_that_read_the_market_before_the_rename_is_refused(database):
    db = database(settled_market())
    read_before = copy.deepcopy(stored(db))

    rename(MARKET, "North Wing", NEW, db)
    after = copy.deepcopy(stored(db))

    with pytest.raises(MarketChanged):
        write_market(read_before, {"$set": {"setupObject": read_before["setupObject"]}},
                     revisions={"planRevision": read_before["planRevision"]})
    assert stored(db) == after


def test_a_seat_write_that_read_the_market_before_the_rename_lands_and_the_way_back_refuses(
        database):
    """Why the script is run while no organizer is working on the market: the assignment's
    revision is left unmoved, so a seat written by hand from a read before the rename is not
    refused. It stores the seats under the old name over the renamed plan, and the dry run of the
    way back says so and writes nothing."""
    db = database(settled_market())
    read_before = copy.deepcopy(stored(db))
    rename(MARKET, "North Wing", NEW, db)

    write_market(
        read_before,
        {"$set": {"assignmentObject.vendorAssignments":
                  read_before["assignmentObject"]["vendorAssignments"]}},
        revisions={"assignmentObject.revision": 5})
    disagreeing = copy.deepcopy(stored(db))

    with pytest.raises(Refused, match="already names a location 'North Wing'"):
        rename(MARKET, "loc-north", "North Wing", db, dry_run=True)
    assert stored(db) == disagreeing


# --- the command ------------------------------------------------------------------------------

def test_the_command_renames_and_exits_zero(database):
    db = database(settled_market())

    assert main([MARKET, "North Wing", NEW]) == 0

    assert stored(db)["setupObject"]["locations"][0] == {"id": "loc-north", "name": NEW}


def test_the_commands_dry_run_writes_nothing(database):
    doc = settled_market()
    db = database(doc)

    assert main([MARKET, "--dry-run", "North Wing", NEW]) == 0

    assert stored(db) == doc


def test_the_command_exits_one_on_a_refusal_and_says_why(database, capsys):
    doc = settled_market()
    db = database(doc)

    assert main([MARKET, "North Wing", "South Wing"]) == 1

    assert stored(db) == doc
    assert ("refused, nothing written: Another of the plan's locations is already named"
            in capsys.readouterr().err)


@pytest.mark.parametrize("arguments", [[], [MARKET, "North Wing"], [MARKET, "a", "b", "c"],
                                       [MARKET, "North Wing", NEW, "--yes"]])
def test_the_command_exits_two_on_anything_but_a_market_a_location_and_a_name(
        database, capsys, arguments):
    doc = settled_market()
    db = database(doc)

    assert main(arguments) == 2

    assert stored(db) == doc
    assert "usage:" in capsys.readouterr().err
