"""Two locations of a market past Draft trade names, and every read shows it.

The setup settles on leaving draft, so the app refuses the rename; ``swap_location_names.py`` is the
operator's way to put two sections that were set up under each other's location name right. These
tests read the market the way its pages do (the plan, a vendor's result, the door's roster, the
organizer's tables, the public map) before and after the swap, and hold the script to what it must
leave alone: every id, the layout's location, the assignment's revision, the published results,
the attendance records, the history, and everyone's inbox.
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
from swap_location_names import Refused, main, swap

MARKET = "market-123"
SLUG = market_name_slug("Test Market")
DAY_ONE, DAY_TWO = "2099-08-01", "2099-08-02"
NORTH = {"id": "loc-north", "name": "North Wing"}
SOUTH = {"id": "loc-south", "name": "South Wing"}
EAST = {"id": "loc-east", "name": "East Wing"}
GOLD = {"id": 0, "name": "Gold"}
SIX_FOOT = {"id": "tt-six", "name": "Standard 6 ft", "widthMm": 1830, "depthMm": 760}
FORM = {"fields": [{"key": "business_name", "label": "Business name", "type": "text"}]}
ANA, BEN, CLEO = "ana@ember.test", "ben@kiln.test", "cleo@loom.test"


def _table(table_id, number, x):
    return {"id": table_id, "sectionId": "sec-a", "number": number, "tableTypeId": "tt-six",
            "xMm": x, "yMm": 5000.0, "rotation": 0.0}


def _plan():
    """Three locations, a section in each; the North Wing alone is laid out."""
    return {
        "priority": [], "marketDates": [{"date": DAY_ONE}, {"date": DAY_TWO}],
        "tiers": [GOLD],
        "locations": [copy.deepcopy(NORTH), copy.deepcopy(SOUTH), copy.deepcopy(EAST)],
        "sections": [
            {"id": "sec-a", "name": "Aisle A", "count": 2, "location": copy.deepcopy(NORTH),
             "tier": GOLD},
            {"id": "sec-b", "name": "Aisle B", "count": 3, "location": copy.deepcopy(SOUTH),
             "tier": GOLD},
            {"id": "sec-e", "name": "Aisle E", "count": 1, "location": copy.deepcopy(EAST),
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
        _seat(CLEO, DAY_ONE, "Aisle E 1", "Aisle E", "East Wing"),
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

    def __init__(self, markets_collection):
        self.markets = markets_collection

    def __getitem__(self, name):
        assert name == "markets", name
        return self.markets


@pytest.fixture
def database(monkeypatch, market_records):
    """A database holding the market given, with a check-in recorded, and nothing that can send."""
    def refuse_to_send(*_args, **_kwargs):
        raise AssertionError("the swap sends nothing to anyone")

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
                return markets if name == "markets" else FakeSlugMarketsCollection([])

        monkeypatch.setattr(test_db_config, "get_database", lambda *_a, **_kw: _Db())
        return Database(markets)
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
            for email in (ANA, BEN, CLEO)
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
    """``value`` with the two names traded wherever they stand, and nothing else moved."""
    trade = {"North Wing": "South Wing", "South Wing": "North Wing"}
    if isinstance(value, str):
        return trade.get(value, value)
    if isinstance(value, (list, tuple)):
        return type(value)(renamed(item) for item in value)
    if isinstance(value, dict):
        return {key: renamed(item) for key, item in value.items()}
    return value


# --- the swap, as every page reads it ---------------------------------------------------------

def test_every_read_shows_the_names_traded_over_the_same_tables(database):
    db = database(settled_market())
    before = read(db)
    assert before["plan"]["sections"][0] == ("sec-a", "Aisle A", "loc-north", "North Wing", 2)
    assert ("ana@ember.test", DAY_ONE, "Aisle A 1", "Aisle A", "North Wing", "here") in before["door"]
    assert before["map"] == [("loc-north", "North Wing", ["Aisle A"], "loc-north", ["t-a1", "t-a2"])]

    swap(MARKET, "North Wing", "South Wing", db)

    after = read(db)
    # The organizer's tables are listed by location, so their order follows the names.
    assert sorted(after.pop("tables")) == sorted(renamed(before.pop("tables")))
    assert after == renamed(before)
    assert after["plan"]["sections"][0] == ("sec-a", "Aisle A", "loc-north", "South Wing", 2)
    assert after["results"][ANA] == [
        (DAY_ONE, "Aisle A 1", "Aisle A", "South Wing"),
        (DAY_TWO, "Aisle A 2", "Aisle A", "South Wing"),
    ]
    assert after["results"][BEN] == [(DAY_ONE, "Aisle B 2", "Aisle B", "North Wing")]
    assert after["results"][CLEO] == [(DAY_ONE, "Aisle E 1", "Aisle E", "East Wing")]


def test_the_layout_stays_on_its_location_under_the_new_name(database):
    db = database(settled_market())

    swap(MARKET, "North Wing", "South Wing", db)

    after = read(db)
    assert after["layouts"] == [("fp-north", "loc-north", ["t-a1", "t-a2"])]
    assert after["map"] == [("loc-north", "South Wing", ["Aisle A"], "loc-north", ["t-a1", "t-a2"])]


def test_nothing_but_the_names_and_the_plans_fingerprint_is_written(database):
    doc = settled_market()
    db = database(doc)

    swap(MARKET, "North Wing", "South Wing", db)

    expected = renamed(copy.deepcopy(doc))
    expected["assignmentObject"]["madeFrom"]["plan"] = made_from_now(stored(db))["plan"]
    assert stored(db) == expected
    assert expected["assignmentObject"]["madeFrom"]["plan"] != doc["assignmentObject"]["madeFrom"]["plan"]


def test_a_location_is_named_by_its_id_as_well_as_its_name(database):
    by_name, by_id = database(settled_market()), None
    swap(MARKET, "South Wing", "North Wing", by_name)
    after_by_name = stored(by_name)

    by_id = database(settled_market())
    swap(MARKET, "loc-north", "loc-south", by_id)

    assert stored(by_id) == after_by_name


def test_a_second_run_restores_the_first_state_exactly(database):
    doc = settled_market()
    db = database(doc)

    swap(MARKET, "North Wing", "South Wing", db)
    assert stored(db) != doc
    swap(MARKET, "North Wing", "South Wing", db)

    assert stored(db) == doc


# --- the dry run ------------------------------------------------------------------------------

def test_a_dry_run_writes_nothing_and_prints_the_before_and_after(database, capsys):
    doc = settled_market()
    db = database(doc)

    swap(MARKET, "North Wing", "South Wing", db, dry_run=True)

    assert stored(db) == doc
    assert db.markets.last_update is None
    printed = capsys.readouterr().out
    assert "dry run: nothing is written" in printed
    assert "location loc-north: 'North Wing' -> 'South Wing'" in printed
    assert "location loc-south: 'South Wing' -> 'North Wing'" in printed
    assert "section 'Aisle A': under 'North Wing' -> under 'South Wing'" in printed
    assert "section 'Aisle B': under 'South Wing' -> under 'North Wing'" in printed
    assert "Aisle E" not in printed
    assert "2 section(s); 3 of 4 stored seat(s); 1 layout(s)" in printed
    assert "would swap the two names." in printed


def test_the_dry_run_after_a_run_shows_the_swap_back(database, capsys):
    db = database(settled_market())
    swap(MARKET, "North Wing", "South Wing", db)
    capsys.readouterr()

    swap(MARKET, "North Wing", "South Wing", db, dry_run=True)

    assert "section 'Aisle A': under 'South Wing' -> under 'North Wing'" in capsys.readouterr().out


def test_it_prints_no_vendor(database, capsys):
    db = database(settled_market())

    swap(MARKET, "North Wing", "South Wing", db)

    captured = capsys.readouterr()
    for vendor in (ANA, BEN, CLEO, "Ana"):
        assert vendor not in captured.out + captured.err


# --- what it leaves alone ---------------------------------------------------------------------

def test_published_results_stay_published_on_the_same_revision(database):
    doc = settled_market()
    db = database(doc)
    assert Lifecycle.allocation(market_from_document(copy.deepcopy(doc))) is Allocation.PUBLISHED

    swap(MARKET, "North Wing", "South Wing", db)

    after = stored(db)
    assert after["assignmentObject"]["revision"] == 5
    assert after["assignmentObject"]["publishedRevision"] == 5
    assert after["assignmentObject"]["state"] == "run"
    assert after["resultsPublished"] is True
    assert after["planRevision"] == 7
    assert after["phase"] == doc["phase"]
    assert Lifecycle.allocation(market_from_document(copy.deepcopy(after))) is Allocation.PUBLISHED


def test_it_sends_nothing_and_records_nothing_beside_the_market(database, market_records):
    db = database(settled_market())
    attendance = copy.deepcopy(market_records.attendance.documents)

    # ``database`` makes every send raise.
    swap(MARKET, "North Wing", "South Wing", db)

    assert market_records.attendance.documents == attendance
    assert market_records.history.documents == []
    assert market_records.payments.documents == []
    assert market_records.amounts_owed.documents == []


def test_an_allocation_that_read_as_current_still_does(database):
    doc = settled_market(MarketPhase.ASSIGNMENT, published=False)
    db = database(doc)
    assert Lifecycle.allocation(market_from_document(copy.deepcopy(doc))) is Allocation.CURRENT

    swap(MARKET, "North Wing", "South Wing", db)

    after = stored(db)
    assert Lifecycle.allocation(market_from_document(copy.deepcopy(after))) is Allocation.CURRENT
    assert after["assignmentObject"]["revision"] == 5


def test_an_allocation_made_from_another_plan_keeps_its_record(database, capsys):
    doc = settled_market(MarketPhase.ASSIGNMENT, published=False)
    doc["assignmentObject"]["madeFrom"]["plan"] = "an-older-plan"
    db = database(doc)
    assert Lifecycle.allocation(market_from_document(copy.deepcopy(doc))) is Allocation.STALE

    swap(MARKET, "North Wing", "South Wing", db)

    after = stored(db)
    assert after["assignmentObject"]["madeFrom"] == doc["assignmentObject"]["madeFrom"]
    assert Lifecycle.allocation(market_from_document(copy.deepcopy(after))) is Allocation.STALE
    assert "left as it is" in capsys.readouterr().out


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
    doc["setupObject"]["sections"][0]["location"]["id"] = "loc-east"


def _a_seat_naming_another_location(doc):
    doc["assignmentObject"]["vendorAssignments"][0]["location"] = "West Wing"


def _a_seat_in_the_other_locations_section(doc):
    doc["assignmentObject"]["vendorAssignments"][0]["section"] = "Aisle B"


def _a_seat_in_no_section_of_the_plan(doc):
    doc["assignmentObject"]["vendorAssignments"][0]["section"] = "Aisle Z"


def _a_second_location_of_the_name(doc):
    doc["setupObject"]["locations"].append({"id": "loc-twin", "name": "North Wing"})


def _a_draft(doc):
    doc["phase"] = "draft"


REFUSALS = [
    ("a location that is not the plan's", None, ("North Wing", "West Wing"), "no location"),
    ("the same location twice", None, ("North Wing", "North Wing"), "the same location"),
    ("one location by its id and its name", None, ("loc-north", "North Wing"),
     "the same location"),
    ("a location with no stored id", _no_id_on("locations", "South Wing"),
     ("North Wing", "South Wing"), "has no stored id"),
    ("a section with no stored id", _no_id_on("sections", "Aisle A"),
     ("North Wing", "South Wing"), "has no stored id"),
    ("a section's copy with no stored id", _no_id_on_the_copy, ("North Wing", "South Wing"),
     "no stored id"),
    ("a section's copy under another name", _another_name_on_the_copy,
     ("North Wing", "South Wing"), "under the name 'West Wing'"),
    ("a section's copy with another location's id", _another_id_on_the_copy,
     ("North Wing", "South Wing"), "another location's id"),
    ("a seat's copy naming neither location", _a_seat_naming_another_location,
     ("North Wing", "South Wing"), "is not that section's"),
    ("a seat under the other location's section", _a_seat_in_the_other_locations_section,
     ("North Wing", "South Wing"), "does not put there"),
    ("a seat under a section the plan lacks", _a_seat_in_no_section_of_the_plan,
     ("North Wing", "South Wing"), "does not put there"),
    ("two locations of one name", _a_second_location_of_the_name, ("loc-north", "South Wing"),
     "More than one location"),
    ("a draft", _a_draft, ("North Wing", "South Wing"), "is a draft"),
]


@pytest.mark.parametrize("change,locations,words", [case[1:] for case in REFUSALS],
                         ids=[case[0] for case in REFUSALS])
def test_it_refuses_and_writes_nothing(database, change, locations, words):
    doc = settled_market()
    if change:
        change(doc)
    db = database(copy.deepcopy(doc))

    with pytest.raises(Refused, match=words):
        swap(MARKET, *locations, db)

    assert stored(db) == doc
    assert db.markets.last_update is None


def test_it_refuses_a_market_that_is_not_there(database):
    db = database(settled_market())

    with pytest.raises(Refused, match="No market"):
        swap("market-gone", "North Wing", "South Wing", db)

    assert db.markets.last_update is None


def test_a_market_changed_between_the_read_and_the_write_is_left(database):
    class ChangedAfterTheRead(FakeSlugMarketsCollection):
        """Another write, a seat moved by hand, lands once the script has read the market."""

        def find_one(self, query, projection=None):
            found = super().find_one(query, projection)
            self.docs[0]["assignmentObject"]["revision"] = 6
            return found

    doc = settled_market()
    db = database(doc, collection=ChangedAfterTheRead)

    with pytest.raises(Refused, match="changed between the read and the write"):
        swap(MARKET, "North Wing", "South Wing", db)

    assert stored(db) == {**doc, "assignmentObject": {**doc["assignmentObject"], "revision": 6}}


# --- the command ------------------------------------------------------------------------------

def test_the_command_swaps_and_exits_zero(database):
    db = database(settled_market())

    assert main([MARKET, "North Wing", "South Wing"]) == 0

    assert stored(db)["setupObject"]["locations"][0] == {"id": "loc-north", "name": "South Wing"}


def test_the_commands_dry_run_writes_nothing(database):
    doc = settled_market()
    db = database(doc)

    assert main([MARKET, "--dry-run", "North Wing", "South Wing"]) == 0

    assert stored(db) == doc


def test_the_command_exits_one_on_a_refusal_and_says_why(database, capsys):
    doc = settled_market()
    db = database(doc)

    assert main([MARKET, "North Wing", "West Wing"]) == 1

    assert stored(db) == doc
    assert "refused, nothing written: The market's plan has no location" in capsys.readouterr().err


@pytest.mark.parametrize("arguments", [[], [MARKET, "North Wing"], [MARKET, "a", "b", "c"],
                                       [MARKET, "North Wing", "South Wing", "--yes"]])
def test_the_command_exits_two_on_anything_but_a_market_and_two_locations(
        database, capsys, arguments):
    doc = settled_market()
    db = database(doc)

    assert main(arguments) == 2

    assert stored(db) == doc
    assert "usage:" in capsys.readouterr().err
