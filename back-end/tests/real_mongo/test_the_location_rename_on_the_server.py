"""``migrations/rename_location.py`` on the server, run as an operator runs it: on the configured
database, its one write through ``write_market``, which holds a sub-document (``madeFrom``) while
setting a key inside it and counts a revision the market may never have stored, and its read of
the ``history`` collection, where a run then records itself. The hermetic fakes only model those
conditions.
"""
import copy

import pytest

from assignment.made_from import fingerprint
from conftest import stored_assignment, stored_market
from datatypes import MarketPhase
from market_documents import market_from_document
from rename_location import Refused, rename

MARKET = "rename-market"
NORTH = {"id": "loc-north", "name": "North Wing"}
SOUTH = {"id": "loc-south", "name": "South Wing"}
GOLD = {"id": 0, "name": "Gold"}
NEW = "Garden Hall"


def seat(email, code, section, location):
    return {"email": email, "date": "2099-08-01", "tableCode": code, "tableChoice": "Full Table",
            "section": section, "tier": "Gold", "location": location, "handPlaced": False}


def settled_market(**fields):
    """A market in its market days, results published, its allocation made from its plan."""
    doc = stored_market(
        MarketPhase.MARKET_DAYS, id=MARKET, name="Fixture rename", resultsPublished=True,
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


def test_the_rename_lands_whole_and_a_run_with_the_old_name_puts_it_back(real_db, capsys):
    markets = real_db["markets"]
    markets.insert_one(settled_market(planRevision=3))
    before = stored(markets)

    rename(MARKET, "North Wing", NEW, dry_run=True)
    assert stored(markets) == before
    assert list(real_db["history"].find({})) == []

    rename(MARKET, "North Wing", NEW)

    after = stored(markets)
    assert names(after) == {
        "locations": [("loc-north", NEW), ("loc-south", "South Wing")],
        "sections": [("sec-a", "loc-north", NEW), ("sec-b", "loc-south", "South Wing")],
        "seats": [("Aisle A 1", NEW), ("Aisle B 1", "South Wing")],
    }
    assert after["setupObject"]["floorplans"] == before["setupObject"]["floorplans"]
    made_from = after["assignmentObject"]["madeFrom"]
    assert made_from["plan"] == fingerprint(
        market_from_document(copy.deepcopy(after)).setup_object, [], [])["plan"]
    assert made_from["plan"] != before["assignmentObject"]["madeFrom"]["plan"]
    assert (after["assignmentObject"]["revision"], after["assignmentObject"]["publishedRevision"],
            after["planRevision"], after["resultsPublished"]) == (4, 4, 4, True)
    capsys.readouterr()

    rename(MARKET, "loc-north", "North Wing")
    # Every value but the plan's revision, which counts each run.
    assert stored(markets) == {**before, "planRevision": 5}
    assert "1 rename(s) by this script recorded so far, of 1 Market Setup" in capsys.readouterr().out
    entries = list(real_db["history"].find({}, {"_id": 0}).sort("at", 1))
    assert [(entry["market_id"], entry["actor"], entry["action"], entry["kind"])
            for entry in entries] == [(MARKET, None, "change-setup", "plan")] * 2
    assert [place["name"] for place in entries[0]["detail"]["after"]["locations"]] == [
        NEW, "South Wing"]
    assert entries[1]["detail"]["before"] == entries[0]["detail"]["after"]


def test_a_market_that_never_stored_a_plan_revision_is_renamed_and_counts_one(real_db):
    markets = real_db["markets"]
    markets.insert_one(settled_market())
    assert "planRevision" not in stored(markets)

    rename(MARKET, "loc-north", NEW)

    assert names(stored(markets))["locations"] == [("loc-north", NEW), ("loc-south", "South Wing")]
    assert stored(markets)["planRevision"] == 1


def test_a_refusal_writes_nothing(real_db):
    markets = real_db["markets"]
    markets.insert_one(settled_market())
    before = stored(markets)

    with pytest.raises(Refused, match="Another of the plan's locations is already named"):
        rename(MARKET, "North Wing", "South Wing")

    assert stored(markets) == before
    assert list(real_db["history"].find({})) == []
