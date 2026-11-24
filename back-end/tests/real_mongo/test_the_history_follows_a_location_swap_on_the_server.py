"""``migrations/history_follows_location_swap.py`` on the server, run as an operator runs it after
the swap: on the configured database, its read of the ``history`` collection and its write of each
line, a dotted key set inside the line's subject and held to the name the line was read under. The
hermetic fakes only model those conditions.
"""
import copy

import pytest

from conftest import stored_market
from datatypes import MarketPhase
from history_follows_location_swap import Refused, follow
from swap_location_names import swap

MARKET = "follow-market"
NORTH = {"id": "loc-north", "name": "North Wing"}
SOUTH = {"id": "loc-south", "name": "South Wing"}
GOLD = {"id": 0, "name": "Gold"}


def settled_market():
    return stored_market(
        MarketPhase.MARKET_DAYS, id=MARKET, name="Fixture follow",
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
            "floorplans": [{"id": f"fp-{place['id']}", "locationId": place["id"], "revision": 1,
                            "tables": []} for place in (NORTH, SOUTH)],
        })


def lines(history):
    return [(entry["id"], entry["subject"])
            for entry in history.find({"kind": {"$ne": "plan"}}, {"_id": 0}).sort("id", 1)]


def test_the_older_lines_follow_the_swap_once_and_a_second_run_changes_nothing(real_db):
    real_db["markets"].insert_one(settled_market())
    history = real_db["history"]
    for number, (kind, floorplan, location) in enumerate((
            ("floorplan", "fp-loc-north", "North Wing"),
            ("floorplan", "fp-loc-south", "South Wing"),
            ("floorplan_removed", "fp-loc-west", "West Wing"))):
        history.insert_one({
            "id": f"h-{number}", "market_id": MARKET, "actor": "owner@example.com",
            "at": "2026-07-01T00:00:00+00:00", "action": "change-setup", "kind": kind,
            "vendors": [], "subject": {"floorplan_id": floorplan, "location": location},
            "detail": {}})
    swap(MARKET, "North Wing", "South Wing")
    before = lines(history)
    plans = list(history.find({"kind": "plan"}, {"_id": 0}))

    follow(MARKET, "loc-north", "loc-south", dry_run=True)
    assert lines(history) == before

    follow(MARKET, "loc-north", "loc-south")

    assert lines(history) == [
        ("h-0", {"floorplan_id": "fp-loc-north", "location": "South Wing",
                 "location_as_recorded": "North Wing"}),
        ("h-1", {"floorplan_id": "fp-loc-south", "location": "North Wing",
                 "location_as_recorded": "South Wing"}),
        ("h-2", {"floorplan_id": "fp-loc-west", "location": "West Wing"}),
    ]
    assert list(history.find({"kind": "plan"}, {"_id": 0})) == plans
    renamed = lines(history)

    follow(MARKET, "loc-north", "loc-south")

    assert lines(history) == renamed


def test_a_refusal_writes_nothing(real_db):
    real_db["markets"].insert_one(settled_market())
    real_db["history"].insert_one({
        "id": "h-0", "market_id": MARKET, "actor": "owner@example.com",
        "at": "2026-07-01T00:00:00+00:00", "action": "change-setup", "kind": "floorplan",
        "vendors": [], "subject": {"floorplan_id": "fp-loc-north", "location": "North Wing"},
        "detail": {}})
    before = lines(real_db["history"])

    with pytest.raises(Refused, match="records no trade"):
        follow(MARKET, "North Wing", "South Wing")

    assert lines(real_db["history"]) == before
