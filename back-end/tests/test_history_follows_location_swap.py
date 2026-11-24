"""After two locations trade names, each older layout line of the market's history names its place.

``swap_location_names.py`` trades two locations' names on the market's document, and the history
keeps each name as it was when its entry was recorded: so a layout's save recorded before the swap
names its location by the name that now means the other place. ``history_follows_location_swap.py``
renames those lines, each to the name its layout's location has now. These tests read the history
as Manage market reads it (``MarketsApi.get_history``) before and after, and hold the script to
what it must leave alone: a change on Market Setup, a layout removed with its location, a line of
another location, and every other market's history.
"""
import copy

import pytest

from conftest import FakeSlugMarketsCollection, stored_market

import api.markets as MarketsApi
import api.permissions as PermissionsApi
import db_config as test_db_config
import history as History
import market_write as MarketWrite
from datatypes import MarketPhase, MarketRole
from history_follows_location_swap import Incomplete, Refused, follow, main
from swap_location_names import swap

MARKET = "market-123"
NORTH = {"id": "loc-north", "name": "North Wing"}
SOUTH = {"id": "loc-south", "name": "South Wing"}
EAST = {"id": "loc-east", "name": "East Wing"}
GOLD = {"id": 0, "name": "Gold"}
OWNER = "owner@example.com"
#: Before any swap these tests make (the history stamps a swap's entry with the time it ran).
EARLIER = "2026-07-01T00:00:00+00:00"
#: After any swap these tests make.
LATER = "2999-01-01T00:00:00+00:00"


def plan(*locations):
    """A plan past draft with a section and a layout in each location, the layout's id
    ``fp-<location id>``."""
    places = [copy.deepcopy(place) for place in (locations or (NORTH, SOUTH, EAST))]
    return {
        "priority": [], "marketDates": [{"date": "2099-08-01"}], "tiers": [GOLD],
        "locations": places,
        "sections": [{"id": f"sec-{place['id']}", "name": f"Aisle {number}", "count": 1,
                      "location": copy.deepcopy(place), "tier": GOLD}
                     for number, place in enumerate(places, start=1)],
        "assignmentOptions": {},
        "floorplans": [{"id": f"fp-{place['id']}", "locationId": place["id"], "revision": 1,
                        "tables": []} for place in places],
    }


def settled_market(*locations):
    return stored_market(MarketPhase.MARKET_DAYS, id=MARKET, intakeMode="csv",
                         setupObject=plan(*locations), planRevision=3)


@pytest.fixture
def database(monkeypatch, market_records):
    """The market given, in the collection ``write_market`` writes and Manage market reads, and
    the history ``market_records`` holds; read as a viewer of the market."""
    monkeypatch.setattr(PermissionsApi, "get_user_market_role",
                        lambda *_a, **_k: MarketRole.VIEWER)
    monkeypatch.setattr(MarketsApi.ApplicationsApi, "vendor_names_for_market", lambda _id: {})
    # Who changed something, which the first page offers its filter: not what these tests read.
    monkeypatch.setattr(History, "actors", lambda _market_id: [])

    def make(document):
        markets = FakeSlugMarketsCollection([document])
        monkeypatch.setattr(MarketWrite, "markets_collection", markets)
        monkeypatch.setattr(MarketsApi, "markets_collection", markets)

        class _Db(dict):
            def __getitem__(self, name):
                if name == "history":
                    return market_records.history
                return markets if name == "markets" else FakeSlugMarketsCollection([])

        monkeypatch.setattr(test_db_config, "get_database", lambda *_a, **_kw: _Db())
        return _Db()
    return make


def line(history, number, kind, location, floorplan, at=EARLIER, market_id=MARKET):
    """A layout's line as the layout's save (``floorplan``) or a plan write that drops a location
    with its layout (``floorplan_removed``) records it: the layout's id, and its location's name
    as it was then."""
    history.insert_one({
        "id": f"h-{number:02d}", "market_id": market_id, "actor": OWNER, "at": at,
        "action": "change-setup", "kind": kind, "vendors": [],
        "subject": {"floorplan_id": floorplan, "location": location},
        "detail": {"started": True} if kind == "floorplan" else {
            "before": {"tables": 4}, "after": {"tables": None}},
    })


def plan_change(history, number, before, after, at=EARLIER, actor=OWNER):
    """A change on Market Setup that renamed locations, its lists whole as a plan save holds
    them."""
    history.insert_one({
        "id": f"h-{number:02d}", "market_id": MARKET, "actor": actor, "at": at,
        "action": "change-setup", "kind": "plan", "vendors": [], "subject": {},
        "detail": {"before": {"locations": [dict(place) for place in before]},
                   "after": {"locations": [dict(place) for place in after]}},
    })


def read(market_records):
    """Each entry of the market's history as Manage market is sent it: the line's kind and the
    location its sentence names, or a plan change's names before and after, oldest first."""
    body, status = MarketsApi.get_history(MARKET, "viewer@example.com", {})
    assert status == 200
    shown = []
    for entry in reversed(body["entries"]):
        if entry["kind"] == "plan":
            detail = entry["detail"]
            shown.append(("plan", [place["name"] for place in detail["before"]["locations"]],
                          [place["name"] for place in detail["after"]["locations"]]))
        else:
            shown.append((entry["kind"], entry["subject"]["location"]))
    return shown


def without_plan_lines(shown):
    return [each for each in shown if each[0] != "plan"]


# --- the lines follow the swap -------------------------------------------------------------------

def test_each_older_layout_line_names_the_place_it_was_about(database, market_records, capsys):
    db = database(settled_market())
    history = market_records.history
    line(history, 1, "floorplan", "North Wing", "fp-loc-north")
    line(history, 2, "floorplan", "South Wing", "fp-loc-south")
    line(history, 3, "floorplan", "East Wing", "fp-loc-east")
    # A layout removed with its location, another market's line, and the line of a layout no
    # longer in the plan.
    line(history, 4, "floorplan_removed", "West Wing", "fp-loc-west")
    line(history, 5, "floorplan", "North Wing", "fp-loc-north", market_id="market-other")
    line(history, 6, "floorplan", "West Wing", "fp-loc-west")
    swap(MARKET, "North Wing", "South Wing", db)
    # Saved after the swap, so named as the place is called now: the North Wing's layout, under
    # the South Wing's old name.
    line(history, 7, "floorplan", "South Wing", "fp-loc-north", at=LATER)
    assert without_plan_lines(read(market_records)) == [
        ("floorplan", "North Wing"), ("floorplan", "South Wing"), ("floorplan", "East Wing"),
        ("floorplan_removed", "West Wing"), ("floorplan", "West Wing"),
        ("floorplan", "South Wing")]
    plans = [each for each in read(market_records) if each[0] == "plan"]
    capsys.readouterr()

    follow(MARKET, "South Wing", "North Wing", db)

    assert without_plan_lines(read(market_records)) == [
        ("floorplan", "South Wing"), ("floorplan", "North Wing"), ("floorplan", "East Wing"),
        ("floorplan_removed", "West Wing"), ("floorplan", "West Wing"),
        ("floorplan", "South Wing")]
    # The swap's own change on Market Setup is left as written.
    assert [each for each in read(market_records) if each[0] == "plan"] == plans
    other = next(entry for entry in history.documents if entry["market_id"] == "market-other")
    assert other["subject"] == {"floorplan_id": "fp-loc-north", "location": "North Wing"}
    printed = capsys.readouterr().out
    assert "their layouts' save(s): 2 to rename, 0 renamed before" in printed
    assert "renamed 2 line(s)." in printed


def test_a_renamed_line_keeps_the_name_it_was_recorded_under(database, market_records):
    db = database(settled_market())
    line(market_records.history, 1, "floorplan", "North Wing", "fp-loc-north")
    swap(MARKET, "North Wing", "South Wing", db)

    follow(MARKET, "loc-north", "loc-south", db)

    [entry] = [each for each in market_records.history.documents if each["kind"] == "floorplan"]
    assert entry["subject"] == {
        "floorplan_id": "fp-loc-north", "location": "South Wing",
        "location_as_recorded": "North Wing"}
    assert entry["detail"] == {"started": True}
    assert (entry["actor"], entry["at"]) == (OWNER, EARLIER)


def test_a_change_on_market_setup_is_left_as_written(database, market_records):
    """A plan line is the record of what the plan said when it was saved: it is not renamed."""
    db = database(settled_market())
    renamed_wing = {**NORTH, "name": "Old North"}
    plan_change(market_records.history, 1, [renamed_wing, SOUTH, EAST], [NORTH, SOUTH, EAST])
    line(market_records.history, 2, "floorplan", "North Wing", "fp-loc-north")
    swap(MARKET, "North Wing", "South Wing", db)
    plans = [entry for entry in copy.deepcopy(market_records.history.documents)
             if entry["kind"] == "plan"]

    follow(MARKET, "North Wing", "South Wing", db)

    assert [entry for entry in market_records.history.documents if entry["kind"] == "plan"] == plans
    assert without_plan_lines(read(market_records)) == [("floorplan", "South Wing")]


def test_a_second_run_changes_nothing(database, market_records, capsys):
    db = database(settled_market())
    line(market_records.history, 1, "floorplan", "North Wing", "fp-loc-north")
    line(market_records.history, 2, "floorplan", "South Wing", "fp-loc-south")
    swap(MARKET, "North Wing", "South Wing", db)
    follow(MARKET, "North Wing", "South Wing", db)
    after_one = copy.deepcopy(market_records.history.documents)
    capsys.readouterr()

    follow(MARKET, "North Wing", "South Wing", db)

    assert market_records.history.documents == after_one
    printed = capsys.readouterr().out
    assert "their layouts' save(s): 0 to rename, 2 renamed before" in printed
    assert "renamed 0 line(s)." in printed


def test_a_swap_back_puts_each_line_back_under_its_recorded_name(
        database, market_records, monkeypatch):
    db = database(settled_market())
    line(market_records.history, 1, "floorplan", "North Wing", "fp-loc-north")
    monkeypatch.setattr(History, "_now", lambda: "2026-08-01T00:00:00+00:00")
    swap(MARKET, "North Wing", "South Wing", db)
    follow(MARKET, "North Wing", "South Wing", db)
    # Saved between the swap and the swap back, under the name the North Wing then had.
    line(market_records.history, 2, "floorplan", "South Wing", "fp-loc-north",
         at="2026-08-02T00:00:00+00:00")
    monkeypatch.setattr(History, "_now", lambda: "2026-08-03T00:00:00+00:00")
    swap(MARKET, "North Wing", "South Wing", db)

    follow(MARKET, "North Wing", "South Wing", db)

    assert without_plan_lines(read(market_records)) == [
        ("floorplan", "North Wing"), ("floorplan", "North Wing")]


def test_a_swap_with_a_third_location_is_followed_by_the_layouts_location(
        database, market_records, monkeypatch):
    """The North Wing traded names with the South Wing, then with the East Wing: its layout's line
    names it as it is called now after each follow-up, whichever pair it was run for."""
    db = database(settled_market())
    line(market_records.history, 1, "floorplan", "North Wing", "fp-loc-north")
    monkeypatch.setattr(History, "_now", lambda: "2026-08-01T00:00:00+00:00")
    swap(MARKET, "North Wing", "South Wing", db)
    follow(MARKET, "North Wing", "South Wing", db)
    assert without_plan_lines(read(market_records)) == [("floorplan", "South Wing")]
    monkeypatch.setattr(History, "_now", lambda: "2026-08-02T00:00:00+00:00")
    swap(MARKET, "loc-north", "loc-east", db)

    follow(MARKET, "loc-north", "loc-east", db)

    assert without_plan_lines(read(market_records)) == [("floorplan", "East Wing")]
    follow(MARKET, "loc-north", "loc-south", db)
    assert without_plan_lines(read(market_records)) == [("floorplan", "East Wing")]


def test_a_layout_removed_with_its_location_is_left_as_written(database, market_records):
    """A layout is removed only with its location, so its line is about a location no longer in
    the plan, though another location took its name in the same save."""
    db = database(settled_market())
    plan_change(market_records.history, 1,
                [{"id": "loc-gone", "name": "North Wing"}, SOUTH, EAST], [NORTH, SOUTH, EAST])
    line(market_records.history, 2, "floorplan_removed", "North Wing", "fp-loc-gone",
         at="2026-07-01T00:00:01+00:00")
    swap(MARKET, "North Wing", "South Wing", db)

    follow(MARKET, "South Wing", "North Wing", db)

    assert without_plan_lines(read(market_records)) == [("floorplan_removed", "North Wing")]


def test_a_line_before_an_ordinary_rename_takes_the_name_its_location_has_now(
        database, market_records, monkeypatch):
    """A line names its layout's location as it is called now, also after a rename of it, past
    draft by an operator's script, that was no trade."""
    db = database(settled_market())
    line(market_records.history, 1, "floorplan", "North Wing", "fp-loc-north")
    monkeypatch.setattr(History, "_now", lambda: "2026-08-01T00:00:00+00:00")
    swap(MARKET, "North Wing", "South Wing", db)
    hall = {**NORTH, "name": "Hall"}
    plan_change(market_records.history, 2, [{**NORTH, "name": "South Wing"},
                                            {**SOUTH, "name": "North Wing"}, EAST],
                [hall, {**SOUTH, "name": "North Wing"}, EAST],
                at="2026-08-02T00:00:00+00:00", actor=None)
    renamed = db["markets"].docs[0]["setupObject"]
    renamed["locations"][0]["name"] = renamed["sections"][0]["location"]["name"] = "Hall"

    follow(MARKET, "Hall", "North Wing", db)

    assert without_plan_lines(read(market_records)) == [("floorplan", "Hall")]


def test_an_organizers_trade_of_the_two_names_is_followed_too(database, market_records):
    """A trade of the two names saved on Market Setup in draft makes the lines before it read as
    about the other place, as the operator's swap does."""
    traded = [{**NORTH, "name": "South Wing"}, {**SOUTH, "name": "North Wing"}, EAST]
    db = database(settled_market(*traded))
    line(market_records.history, 1, "floorplan", "North Wing", "fp-loc-north")
    plan_change(market_records.history, 2, [NORTH, SOUTH, EAST], traded,
                at="2026-07-02T00:00:00+00:00")

    follow(MARKET, "North Wing", "South Wing", db)

    assert without_plan_lines(read(market_records)) == [("floorplan", "South Wing")]


def test_a_dry_run_writes_nothing_and_prints_counts_only(database, market_records, capsys):
    db = database(settled_market())
    line(market_records.history, 1, "floorplan", "North Wing", "fp-loc-north")
    line(market_records.history, 2, "floorplan", "South Wing", "fp-loc-south")
    line(market_records.history, 3, "floorplan_removed", "West Wing", "fp-loc-west")
    swap(MARKET, "North Wing", "South Wing", db)
    before = copy.deepcopy(market_records.history.documents)
    capsys.readouterr()

    follow(MARKET, "South Wing", "North Wing", db, dry_run=True)

    assert market_records.history.documents == before
    printed = capsys.readouterr().out
    assert printed == (
        f"market {MARKET}: (dry run: nothing is written)\n"
        "  - locations loc-north and loc-south: 1 trade(s) of their names recorded\n"
        "  - their layouts' save(s): 2 to rename, 0 renamed before\n"
        "  - layouts removed with their location, and changes on Market Setup: left as written\n"
        "\nwould rename 2 line(s).\n")


# --- refusals ------------------------------------------------------------------------------------

def _missing_market(db, history):
    db["markets"].docs.clear()


def _no_trade_recorded(db, history):
    history.documents.clear()


@pytest.mark.parametrize("change, locations, words", [
    (_missing_market, ("North Wing", "South Wing"), "No market has the id"),
    (None, ("North Wing", "West Wing"), "no location with the id or name 'West Wing'"),
    (None, ("loc-north", "South Wing"), "Both arguments name the same location"),
    (_no_trade_recorded, ("North Wing", "South Wing"), "records no trade of the two names"),
])
def test_it_refuses_and_writes_nothing(database, market_records, change, locations, words):
    db = database(settled_market())
    line(market_records.history, 1, "floorplan", "North Wing", "fp-loc-north")
    swap(MARKET, "North Wing", "South Wing", db)
    if change is not None:
        change(db, market_records.history)
    before = copy.deepcopy(market_records.history.documents)

    with pytest.raises(Refused, match=words):
        follow(MARKET, *locations, db)

    assert market_records.history.documents == before


def test_a_location_without_a_stored_id_is_refused(database, market_records):
    db = database(settled_market())
    swap(MARKET, "North Wing", "South Wing", db)
    del db["markets"].docs[0]["setupObject"]["locations"][2]["id"]

    with pytest.raises(Refused, match="'East Wing' has no stored id"):
        follow(MARKET, "North Wing", "East Wing", db)


def test_a_line_changed_between_the_read_and_the_write_is_left_for_a_second_run(
        database, market_records, monkeypatch):
    db = database(settled_market())
    line(market_records.history, 1, "floorplan", "North Wing", "fp-loc-north")
    line(market_records.history, 2, "floorplan", "South Wing", "fp-loc-south")
    swap(MARKET, "North Wing", "South Wing", db)
    history = market_records.history
    written = history.update_one
    calls = []

    def first_one_missed(query, update):
        calls.append(query)
        if len(calls) == 1:
            return written({**query, "subject.location": "changed meanwhile"}, update)
        return written(query, update)

    with monkeypatch.context() as patched:
        patched.setattr(history, "update_one", first_one_missed)
        with pytest.raises(Incomplete, match="renamed 1 of 2 line"):
            follow(MARKET, "North Wing", "South Wing", db)

    follow(MARKET, "North Wing", "South Wing", db)

    assert without_plan_lines(read(market_records)) == [
        ("floorplan", "South Wing"), ("floorplan", "North Wing")]


# --- the command ---------------------------------------------------------------------------------

def test_the_command_renames_and_exits_zero(database, market_records):
    db = database(settled_market())
    line(market_records.history, 1, "floorplan", "North Wing", "fp-loc-north")
    swap(MARKET, "North Wing", "South Wing", db)

    assert main([MARKET, "North Wing", "South Wing"]) == 0

    assert without_plan_lines(read(market_records)) == [("floorplan", "South Wing")]


def test_the_commands_dry_run_writes_nothing(database, market_records):
    db = database(settled_market())
    line(market_records.history, 1, "floorplan", "North Wing", "fp-loc-north")
    swap(MARKET, "North Wing", "South Wing", db)

    assert main([MARKET, "North Wing", "South Wing", "--dry-run"]) == 0

    assert without_plan_lines(read(market_records)) == [("floorplan", "North Wing")]


def test_the_command_exits_one_on_a_refusal_and_says_why(database, market_records, capsys):
    database(settled_market())

    assert main([MARKET, "North Wing", "South Wing"]) == 1

    assert "refused, nothing written: The market's history records no trade" in (
        capsys.readouterr().err)


@pytest.mark.parametrize("arguments", [
    [], [MARKET], [MARKET, "North Wing"], [MARKET, "North Wing", "South Wing", "East Wing"],
    [MARKET, "North Wing", "--write"],
])
def test_the_command_exits_two_on_anything_but_a_market_and_two_locations(arguments, capsys):
    assert main(arguments) == 2
    assert "usage:" in capsys.readouterr().err
