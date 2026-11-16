"""Every (state, event) of an owed table-day, through the routes (T335).

An owed day is in one of four states: it follows its seat (no record), an Admin set its amount,
its table was freed (with or without an Admin's amount standing), or it was freed and waived by
the free's deduction (keeping the Admin's amount it replaced, if one stood). Each state below is
reached the way an organizer reaches it, each event is sent as the screen sends it, and every
cell asserts what the route answered, the vendor's Sunday line, the stored record and its mirror
of the release before's fields, and what the market's history recorded of what Ana owes.

Ana holds North Wing 1, a Gold full table at $35.00, on Saturday and Sunday; the Admin's amount
is $10.00, set before the event, and $25.00, set by it. A seat on Sunday is at Landing 1, a Silver
full table at $30.00; a run seats Ana on Saturday only, at Landing 2.
"""
from typing import Any, Callable, Dict, List, NamedTuple, Optional, Tuple

import pytest

from conftest import skip_without_real_dependencies

skip_without_real_dependencies()

import payments as Payments  # noqa: E402
from test_a_held_seat_wins_over_a_free import SATURDAY_ELSEWHERE, a_run_that_seats  # noqa: E402
from test_a_vendors_payments import ANA, MARKET, SUN, market, stores  # noqa: E402,F401
from test_an_owed_day_has_one_state import client  # noqa: E402,F401
from test_changing_owed_and_paid import ADMIN, admin, holding  # noqa: E402,F401

OWED = f"/markets/{MARKET}/payments/{ANA}/owed/{SUN}"
PLACEMENTS = f"/markets/{MARKET}/placements"
#: The history's kinds that say what a vendor owes.
OWED_KINDS = ("owed_set", "owed_calculated", "owed_taken_back", "owed_dropped")


# --- The states, each reached as an organizer reaches it ---------------------------------------

def _an_admins_amount(client):
    assert client.put(OWED, json={"cents": 1000}).status_code == 200


def _a_free(client, deduct=False):
    assert client.delete(PLACEMENTS, json={
        "email": ANA, "date": SUN, "deductOwed": deduct}).get_json() == {"removed": 1}


def follows_seat(client):
    pass


def set_by_hand(client):
    _an_admins_amount(client)


def freed_with_an_amount(client):
    _an_admins_amount(client)
    _a_free(client)


def freed(client):
    _a_free(client)


def freed_waived_over_an_amount(client):
    _an_admins_amount(client)
    _a_free(client, deduct=True)


def freed_waived(client):
    _a_free(client, deduct=True)


STATES: Dict[str, Callable] = {
    "follows_seat": follows_seat,
    "set(a)": set_by_hand,
    "freed(s, a)": freed_with_an_amount,
    "freed(s, none)": freed,
    "freed_waived(s, b)": freed_waived_over_an_amount,
    "freed_waived(s, none)": freed_waived,
}

#: What each state stores: its kind, and the Admin's amount it holds (``before`` for a waiver).
STORED = {
    "follows_seat": None,
    "set(a)": ("set", 1000),
    "freed(s, a)": ("freed", 1000),
    "freed(s, none)": ("freed", None),
    "freed_waived(s, b)": ("freed_waived", 1000),
    "freed_waived(s, none)": ("freed_waived", None),
}


# --- The events, each sent as the screen sends it ----------------------------------------------

def seated(client, monkeypatch, market):  # noqa: F811
    return client.put(PLACEMENTS, json={
        "email": ANA, "date": SUN, "tableCode": "Landing 1", "tableChoice": "Full Table"})


def freed_event(client, monkeypatch, market):  # noqa: F811
    return client.delete(PLACEMENTS, json={"email": ANA, "date": SUN, "deductOwed": False})


def freed_with_deduction(client, monkeypatch, market):  # noqa: F811
    return client.delete(PLACEMENTS, json={"email": ANA, "date": SUN, "deductOwed": True})


def dropped_by_run(client, monkeypatch, market):  # noqa: F811
    a_run_that_seats(monkeypatch, market, SATURDAY_ELSEWHERE)
    return client.post(f"/markets/{MARKET}/assignment")


def admin_sets(client, monkeypatch, market):  # noqa: F811
    return client.put(OWED, json={"cents": 2500})


def admin_calculated(client, monkeypatch, market):  # noqa: F811
    return client.delete(OWED)


EVENTS: Dict[str, Callable] = {
    "seated": seated,
    "freed": freed_event,
    "freed_with_deduction": freed_with_deduction,
    "dropped_by_run": dropped_by_run,
    "admin_sets": admin_sets,
    "admin_calculated": admin_calculated,
}


# --- What each cell leaves ---------------------------------------------------------------------

#: Sunday's line: (table, freed, owes, set by, owed by the free), or None for no line.
Line = Optional[Tuple[str, bool, int, Optional[str], bool]]


class Cell(NamedTuple):
    #: The record after, as ``STORED`` names one, or ``"as before"`` for nothing written.
    stored: Any
    line: Line
    #: The owed entries recorded, as (action, kind, owed before, owed after).
    recorded: List[Tuple[str, str, int, Optional[int]]] = []


AS_BEFORE = "as before"
#: A free of a day Ana holds no table on frees nothing, and says so.
FREES_NOTHING = {"removed": 0}

HELD = ("North Wing 1", False, 3500, None, False)
SET_A = ("North Wing 1", False, 1000, ADMIN, False)
FREED_LINE = ("North Wing 1", True, 3500, None, False)
FREED_A = ("North Wing 1", True, 1000, ADMIN, False)
WAIVED = ("North Wing 1", True, 0, ADMIN, True)
FREED_SET = ("North Wing 1", True, 2500, ADMIN, False)


def set_(before):
    return ("change-owed", "owed_set", before, 2500)


def calculated(before):
    return ("change-owed", "owed_calculated", before, 3500)


TABLE: Dict[Tuple[str, str], Cell] = {
    # Following its seat, on a held day.
    ("follows_seat", "seated"): Cell(AS_BEFORE, ("Landing 1", False, 3000, None, False)),
    ("follows_seat", "freed"): Cell(("freed", None), FREED_LINE),
    ("follows_seat", "freed_with_deduction"): Cell(
        ("freed_waived", None), WAIVED, [("change-owed", "owed_set", 3500, 0)]),
    ("follows_seat", "dropped_by_run"): Cell(AS_BEFORE, None),
    ("follows_seat", "admin_sets"): Cell(
        ("set", 2500), ("North Wing 1", False, 2500, ADMIN, False), [set_(3500)]),
    ("follows_seat", "admin_calculated"): Cell(AS_BEFORE, HELD),
    # An Admin's amount, on a held day: a move keeps it, a run that drops the day drops it.
    ("set(a)", "seated"): Cell(AS_BEFORE, ("Landing 1", False, 1000, ADMIN, False)),
    ("set(a)", "freed"): Cell(("freed", 1000), FREED_A),
    ("set(a)", "freed_with_deduction"): Cell(
        ("freed_waived", 1000), WAIVED, [("change-owed", "owed_set", 1000, 0)]),
    ("set(a)", "dropped_by_run"): Cell(None, None, [("assign", "owed_dropped", 1000, None)]),
    ("set(a)", "admin_sets"): Cell(
        ("set", 2500), ("North Wing 1", False, 2500, ADMIN, False), [set_(1000)]),
    ("set(a)", "admin_calculated"): Cell(None, HELD, [calculated(1000)]),
    # Freed with an Admin's amount standing, on a day not held: seated again, it owes it (Q1).
    ("freed(s, a)", "seated"): Cell(("set", 1000), ("Landing 1", False, 1000, ADMIN, False)),
    ("freed(s, a)", "freed"): Cell(AS_BEFORE, FREED_A),
    ("freed(s, a)", "freed_with_deduction"): Cell(AS_BEFORE, FREED_A),
    ("freed(s, a)", "dropped_by_run"): Cell(AS_BEFORE, FREED_A),
    ("freed(s, a)", "admin_sets"): Cell(("freed", 2500), FREED_SET, [set_(1000)]),
    ("freed(s, a)", "admin_calculated"): Cell(("freed", None), FREED_LINE, [calculated(1000)]),
    # Freed with nothing set: Free again with the deduction finishes an old free's deduction.
    ("freed(s, none)", "seated"): Cell(None, ("Landing 1", False, 3000, None, False)),
    ("freed(s, none)", "freed"): Cell(AS_BEFORE, FREED_LINE),
    ("freed(s, none)", "freed_with_deduction"): Cell(
        ("freed_waived", None), WAIVED, [("change-owed", "owed_set", 3500, 0)]),
    ("freed(s, none)", "dropped_by_run"): Cell(AS_BEFORE, FREED_LINE),
    ("freed(s, none)", "admin_sets"): Cell(("freed", 2500), FREED_SET, [set_(3500)]),
    ("freed(s, none)", "admin_calculated"): Cell(AS_BEFORE, FREED_LINE),
    # Freed and waived over an Admin's amount: seated again, the amount is back, and said so.
    ("freed_waived(s, b)", "seated"): Cell(
        ("set", 1000), ("Landing 1", False, 1000, ADMIN, False),
        [("assign", "owed_taken_back", 0, 1000)]),
    ("freed_waived(s, b)", "freed"): Cell(AS_BEFORE, WAIVED),
    ("freed_waived(s, b)", "freed_with_deduction"): Cell(AS_BEFORE, WAIVED),
    ("freed_waived(s, b)", "dropped_by_run"): Cell(AS_BEFORE, WAIVED),
    ("freed_waived(s, b)", "admin_sets"): Cell(("freed", 2500), FREED_SET, [set_(0)]),
    # The calculated price is the freed seat's, and the Admin's amount the $0 replaced stays gone
    # (Q2).
    ("freed_waived(s, b)", "admin_calculated"): Cell(
        ("freed", None), FREED_LINE, [calculated(0)]),
    # Freed and waived with nothing set before: seated again, the day follows its new seat.
    ("freed_waived(s, none)", "seated"): Cell(
        None, ("Landing 1", False, 3000, None, False), [("assign", "owed_taken_back", 0, 3000)]),
    ("freed_waived(s, none)", "freed"): Cell(AS_BEFORE, WAIVED),
    ("freed_waived(s, none)", "freed_with_deduction"): Cell(AS_BEFORE, WAIVED),
    ("freed_waived(s, none)", "dropped_by_run"): Cell(AS_BEFORE, WAIVED),
    ("freed_waived(s, none)", "admin_sets"): Cell(("freed", 2500), FREED_SET, [set_(0)]),
    ("freed_waived(s, none)", "admin_calculated"): Cell(
        ("freed", None), FREED_LINE, [calculated(0)]),
}


def test_the_table_names_every_state_and_event():
    assert set(TABLE) == {(state, event) for state in STATES for event in EVENTS}


def sunday_record(stores) -> Optional[Dict[str, Any]]:  # noqa: F811
    found = [doc for doc in stores.owed.documents if doc["date"] == SUN]
    assert len(found) <= 1
    return dict(found[0]) if found else None


def stored(doc: Optional[Dict[str, Any]]):
    """A record as ``STORED`` names one."""
    if doc is None:
        return None
    state = Payments.owed_state_from_stored(doc["state"])
    if isinstance(state, Payments.SetByHand):
        return ("set", state.amount.cents)
    if isinstance(state, Payments.Freed):
        return ("freed", state.amount.cents if state.amount else None)
    assert isinstance(state, Payments.FreedWaived)
    return ("freed_waived", state.before.cents if state.before else None)


def sunday_line(client) -> Line:
    lines = client.get(f"/markets/{MARKET}/payments/{ANA}").get_json()["lines"]
    found = [line for line in lines if line["date"] == SUN]
    if not found:
        return None
    [line] = found
    return (line["tableCode"], line["freed"], line["owedCents"], line["owedSetBy"],
            line["owedByFree"])


def owed_entries(stores) -> List[Tuple[str, str, int, Optional[int]]]:  # noqa: F811
    return [(entry["action"], entry["kind"], entry["detail"]["before"]["owed_cents"],
             entry["detail"]["after"]["owed_cents"])
            for entry in stores.history.documents if entry["kind"] in OWED_KINDS]


@pytest.mark.parametrize("state,event", list(TABLE), ids=[f"{s} + {e}" for s, e in TABLE])
def test_each_state_takes_each_event_as_the_table_says(
        client, stores, market, monkeypatch, state, event):  # noqa: F811
    STATES[state](client)
    before = sunday_record(stores)
    assert stored(before) == STORED[state]
    recorded_before = owed_entries(stores)
    expected = TABLE[(state, event)]

    answer = EVENTS[event](client, monkeypatch, market)

    assert answer.status_code == 200, answer.get_json()
    after = sunday_record(stores)
    if expected.stored == AS_BEFORE:
        # Taken, or refused, it wrote nothing: the record is exactly as it was read.
        assert after == before
        if event in ("freed", "freed_with_deduction") and state.startswith("freed"):
            assert answer.get_json() == FREES_NOTHING
    else:
        assert stored(after) == expected.stored
    if after is not None:
        # The release before reads the record's legacy fields alone, so every write keeps them
        # the mirror of its state.
        state_after = Payments.owed_state_from_stored(after["state"])
        assert {"freed": after.get("freed"), "set_by_hand": after.get("set_by_hand")} == (
            Payments.legacy_fields(state_after))
        if after != before:
            assert after["revision"] == (before or {}).get("revision", 0) + 1
    assert sunday_line(client) == expected.line
    assert owed_entries(stores)[len(recorded_before):] == expected.recorded


@pytest.mark.parametrize("event", ["admin_sets", "admin_calculated"])
def test_an_admins_change_on_a_day_with_no_line_is_refused_and_writes_nothing(
        client, stores, market, monkeypatch, event):  # noqa: F811
    """Following its seat on a day not held, the day has no line: an amount set there is one
    nobody could see."""
    dropped_by_run(client, monkeypatch, market)
    recorded_before = owed_entries(stores)

    answer = EVENTS[event](client, monkeypatch, market)

    assert answer.status_code == 404
    assert answer.get_json()["error"] == (
        "That vendor holds no table that day, so nothing is owed for it.")
    assert sunday_record(stores) is None
    assert sunday_line(client) is None
    assert owed_entries(stores) == recorded_before
