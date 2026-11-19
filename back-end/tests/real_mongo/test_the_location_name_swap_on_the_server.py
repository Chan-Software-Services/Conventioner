"""``migrations/swap_location_names.py`` on the server, run as an operator runs it: on the configured
database, its one write through ``write_market``, which holds a sub-document (``madeFrom``) while
setting a key inside it and counts a revision the market may never have stored, and its read of
the ``history`` collection, where a run then records itself. The hermetic fakes
only model those conditions.
"""
import copy

import pytest

from assignment.made_from import fingerprint
from conftest import stored_assignment, stored_market
from datatypes import MarketPhase
from market_documents import market_from_document
from swap_location_names import Refused, swap

MARKET = "swap-market"
NORTH = {"id": "loc-north", "name": "North Wing"}
SOUTH = {"id": "loc-south", "name": "South Wing"}
GOLD = {"id": 0, "name": "Gold"}


def seat(email, code, section, location):
    return {"email": email, "date": "2099-08-01", "tableCode": code, "tableChoice": "Full Table",
            "section": section, "tier": "Gold", "location": location, "handPlaced": False}


def settled_market(**fields):
    """A market in its market days, results published, its allocation made from its plan."""
    doc = stored_market(
        MarketPhase.MARKET_DAYS, id=MARKET, name="Fixture swap", resultsPublished=True,
        setupObject={
            "priority": [], "marketDates": [{"date": "2099-08-01"}], "tiers": [GOLD],
            "locations": [copy.deepcopy(NORTH), copy.deepcopy(SOUTH)],
            "sections": [
                {"id": "sec-a", "name": "Aisle A", "count": 2, "tier": GOLD,
                 "location": copy.deepcopy(NORTH)},
                {"id": "sec-b", "name": "Aisle B", "count": 2, "tier": GOLD,
                 "location": copy.deepcopy(SOUTH)},
            ],
            "assignmentOptions": {},
            "floorplans": [{"id": "fp-north", "locationId": NORTH["id"], "revision": 1,
                            "tables": []}],
        },
        **fields,
    )
    plan = fingerprint(market_from_document(copy.deepcopy(doc)).setup_object, [], [])["plan"]
    doc["assignmentObject"] = stored_assignment(
        "run",
        [seat("ana@example.com", "Aisle A 1", "Aisle A", "North Wing"),
         seat("ben@example.com", "Aisle B 1", "Aisle B", "South Wing")],
        made_from={"rules": "r1", "plan": plan, "applications": "a1", "review": "1"},
        revision=4, published_revision=4)
    return doc


def stored(markets):
    return markets.find_one({"id": MARKET}, {"_id": 0})


def names(document):
    return {
        "locations": [(place["id"], place["name"]) for place in document["setupObject"]["locations"]],
        "sections": [(section["id"], section["location"]["id"], section["location"]["name"])
                     for section in document["setupObject"]["sections"]],
        "seats": [(row["tableCode"], row["location"])
                  for row in document["assignmentObject"]["vendorAssignments"]],
    }


def test_the_swap_lands_whole_and_a_second_run_swaps_back(real_db):
    markets = real_db["markets"]
    markets.insert_one(settled_market(planRevision=3))
    before = stored(markets)

    swap(MARKET, "North Wing", "South Wing", dry_run=True)
    assert stored(markets) == before
    assert list(real_db["history"].find({})) == []

    swap(MARKET, "North Wing", "South Wing")

    after = stored(markets)
    assert names(after) == {
        "locations": [("loc-north", "South Wing"), ("loc-south", "North Wing")],
        "sections": [("sec-a", "loc-north", "South Wing"), ("sec-b", "loc-south", "North Wing")],
        "seats": [("Aisle A 1", "South Wing"), ("Aisle B 1", "North Wing")],
    }
    assert after["setupObject"]["floorplans"] == before["setupObject"]["floorplans"]
    made_from = after["assignmentObject"]["madeFrom"]
    assert made_from["plan"] == fingerprint(
        market_from_document(copy.deepcopy(after)).setup_object, [], [])["plan"]
    assert made_from["plan"] != before["assignmentObject"]["madeFrom"]["plan"]
    assert (after["assignmentObject"]["revision"], after["assignmentObject"]["publishedRevision"],
            after["planRevision"], after["resultsPublished"]) == (4, 4, 4, True)

    swap(MARKET, "North Wing", "South Wing")
    # Every value but the plan's revision, which counts each run.
    assert stored(markets) == {**before, "planRevision": 5}
    entries = list(real_db["history"].find({}, {"_id": 0}).sort("at", 1))
    assert [(entry["market_id"], entry["actor"], entry["action"], entry["kind"])
            for entry in entries] == [(MARKET, None, "change-setup", "plan")] * 2
    assert [place["name"] for place in entries[0]["detail"]["after"]["locations"]] == [
        "South Wing", "North Wing"]
    assert entries[1]["detail"]["before"] == entries[0]["detail"]["after"]


def test_a_market_that_never_stored_a_plan_revision_is_swapped_and_counts_one(real_db):
    markets = real_db["markets"]
    markets.insert_one(settled_market())
    assert "planRevision" not in stored(markets)

    swap(MARKET, "loc-north", "loc-south")

    assert names(stored(markets))["locations"] == [
        ("loc-north", "South Wing"), ("loc-south", "North Wing")]
    assert stored(markets)["planRevision"] == 1


def test_it_counts_the_history_entries_naming_either_location_and_leaves_them(real_db, capsys):
    real_db["markets"].insert_one(settled_market())
    history = real_db["history"]
    for number, (kind, location) in enumerate((
            ("floorplan", "North Wing"), ("floorplan_removed", "South Wing"),
            ("floorplan", "West Wing"))):
        history.insert_one({
            "id": f"h-{number}", "market_id": MARKET, "actor": "owner@example.com",
            "at": "2099-07-01T00:00:00+00:00", "action": "change-setup", "kind": kind,
            "vendors": [], "subject": {"floorplan_id": "fp-north", "location": location},
            "detail": {}})
    before = list(history.find({}, {"_id": 0}).sort("id", 1))

    swap(MARKET, "North Wing", "South Wing")

    # Each entry there before is as it was; the run's own is the one more.
    assert list(history.find({"kind": {"$ne": "plan"}}, {"_id": 0}).sort("id", 1)) == before
    assert history.count_documents({}) == len(before) + 1
    assert ("the market's history: 1 layout save(s) and 1 layout removal(s) name either location"
            in capsys.readouterr().out)


def test_a_refusal_writes_nothing(real_db):
    markets = real_db["markets"]
    document = settled_market()
    document["assignmentObject"]["vendorAssignments"][0]["location"] = "West Wing"
    markets.insert_one(document)
    before = stored(markets)

    with pytest.raises(Refused, match="not that section's"):
        swap(MARKET, "North Wing", "South Wing")

    assert stored(markets) == before
    assert list(real_db["history"].find({})) == []
