"""The market's self check-in switch: whether vendors check themselves in and out (T496).

The vendor's own check-in was open at every market with a door code, and the organizer of a
market could not turn it off. One switch on the market now says whether its vendors check
themselves in and out on their vendor page. It is off until someone turns it on, for every market,
those already running included, so a market with no stored value reads as off. While it is off the
vendor's four door routes answer 403 and write nothing, and the organizer's four are untouched.

Each is sent through the Flask client, as the screens send it.
"""
from datetime import date

import pytest

from conftest import skip_without_real_dependencies

skip_without_real_dependencies()

import api.attendance as AttendanceApi  # noqa: E402
import api.door as DoorApi  # noqa: E402
import api.markets as MarketsApi  # noqa: E402
import history as History  # noqa: E402
import market_write as MarketWrite  # noqa: E402
from datatypes import MarketPhase  # noqa: E402
from test_every_write_records import (  # noqa: E402,F401
    DATE, MARKET, OWNER, VENDOR, _seated, client, world,
)
from utils.application_token import generate_application_token  # noqa: E402

SWITCH = f"/markets/{MARKET}/self-check-in"
DOOR_CODE = f"/markets/{MARKET}/door-code"
ATTENDANCE = f"/markets/{MARKET}/attendance"
VENDOR_DOOR = "/public/markets/test-market/vendor"
CODE = "K7M4QP"
OFF = "Vendors are checked in and out by an organizer at this market. Ask at the door."
MALFORMED = "enabled must be true or false."


def on_its_days(world, **fields):
    """The market in its days with a door code and the vendor seated, the switch as stored."""
    world.patch(AttendanceApi, "today", lambda: date.fromisoformat(DATE))
    return world.market(MarketPhase.MARKET_DAYS, **{
        "assignmentObject": _seated(VENDOR),
        "doorCode": {"code": CODE, "madeAt": "2026-08-01T08:00:00+00:00", "madeBy": OWNER},
        **fields})


def set_switch(client, enabled):
    return client.put(SWITCH, json={"enabled": enabled})


def as_the_vendor(client, method, door, with_code):
    body = {"date": DATE, **({"doorCode": CODE} if with_code else {})}
    return getattr(client, method)(
        f"{VENDOR_DOOR}/{door}", json=body,
        headers={"Authorization": f"Bearer {generate_application_token(MARKET, VENDOR)}"})


def as_the_organizer(client, method, path):
    return getattr(client, method)(path, json={"vendorEmail": VENDOR, "date": DATE})


#: The vendor's own four writes, in an order each can follow the last in.
THE_VENDORS_FOUR = [
    ("post", "check-in", True), ("post", "check-out", True),
    ("delete", "check-out", False), ("delete", "check-in", False),
]
#: The organizer's four, in the same order.
THE_ORGANIZERS_FOUR = [
    ("post", ATTENDANCE), ("post", f"{ATTENDANCE}/check-out"),
    ("delete", f"{ATTENDANCE}/check-out"), ("delete", ATTENDANCE),
]


def stored(world):
    return [dict(record) for record in world.attendance.documents]


class TestSettingIt:
    def test_it_is_off_until_someone_turns_it_on(self, client, world):
        on_its_days(world)

        assert client.get(DOOR_CODE).get_json()["selfCheckIn"] is False

    def test_turned_on_it_is_stored_and_answers_the_door_codes_shape(self, client, world):
        on_its_days(world)

        answer = set_switch(client, True)

        assert answer.status_code == 200, answer.get_json()
        body = answer.get_json()
        assert set(body) == {"code", "madeAt", "madeBy", "url", "selfCheckIn"}
        assert (body["code"], body["selfCheckIn"]) == (CODE, True)
        assert body == client.get(DOOR_CODE).get_json()
        assert world.markets.doc["vendorSelfCheckIn"] is True

    def test_turned_off_again(self, client, world):
        on_its_days(world, vendorSelfCheckIn=True)

        answer = set_switch(client, False)

        assert answer.status_code == 200, answer.get_json()
        assert answer.get_json()["selfCheckIn"] is False
        assert world.markets.doc["vendorSelfCheckIn"] is False
        # The code is apart from the switch: stored as it was.
        assert world.markets.doc["doorCode"]["code"] == CODE

    def test_a_market_with_no_code_answers_no_code_beside_it(self, client, world):
        world.market(MarketPhase.MARKET_DAYS)

        answer = set_switch(client, True)

        assert answer.get_json() == {"code": None, "selfCheckIn": True}
        assert "doorCode" not in world.markets.doc

    def test_the_history_says_who_turned_it_on_and_off(self, client, world):
        on_its_days(world)

        set_switch(client, True)
        set_switch(client, False)

        entries = world.history.documents
        assert [(e["actor"], e["action"], e["kind"], e["vendors"]) for e in entries] == [
            (OWNER, "check-in", History.SELF_CHECK_IN_SET, []),
        ] * 2
        assert [e["detail"] for e in entries] == [
            {"before": {"enabled": False}, "after": {"enabled": True}},
            {"before": {"enabled": True}, "after": {"enabled": False}},
        ]

    @pytest.mark.parametrize("stored_as, enabled", [
        ({}, False), ({"vendorSelfCheckIn": False}, False), ({"vendorSelfCheckIn": True}, True),
    ], ids=["never set", "off", "on"])
    def test_a_switch_restated_writes_and_records_nothing(
            self, client, world, stored_as, enabled):
        before = dict(on_its_days(world, **stored_as))
        written = []
        world.patch(MarketWrite, "write_market", lambda *a, **k: written.append(a))
        world.patch(DoorApi, "write_market", lambda *a, **k: written.append(a))

        answer = set_switch(client, enabled)

        assert answer.status_code == 200, answer.get_json()
        assert answer.get_json()["selfCheckIn"] is enabled
        assert written == []
        assert world.markets.doc == before
        assert world.history.documents == []


class TestWhatItRefuses:
    def _unchanged(self, answer, world, status, message, before):
        assert answer.status_code == status, answer.get_json()
        assert answer.get_json()["error"] == message
        assert world.markets.doc == before
        assert world.history.documents == []

    @pytest.mark.parametrize("body", [
        {"enabled": "true"}, {"enabled": 1}, {"enabled": 0}, {"enabled": None},
        {"enabled": [True]}, {"enabled": {"$ne": False}}, {},
        {"enabled": True, "vendorSelfCheckIn": True}, {"enabled": True, "doorCode": {"code": "X"}},
        {"vendorSelfCheckIn": True},
    ], ids=repr)
    def test_a_body_that_is_not_one_boolean(self, client, world, body):
        before = dict(on_its_days(world))

        self._unchanged(client.put(SWITCH, json=body), world, 400, MALFORMED, before)

    def test_no_body_at_all(self, client, world):
        before = dict(on_its_days(world))

        self._unchanged(client.put(SWITCH), world, 400, MALFORMED, before)

    @pytest.mark.parametrize("body", [[True], "true", True])
    def test_a_body_that_is_no_object(self, client, world, body):
        before = dict(on_its_days(world))

        self._unchanged(client.put(SWITCH, json=body), world, 400,
                        "A JSON object is required", before)

    @pytest.mark.parametrize("phase", [
        MarketPhase.DRAFT, MarketPhase.APPLICATIONS, MarketPhase.ASSIGNMENT])
    def test_before_market_days(self, client, world, phase):
        before = dict(world.market(phase))

        self._unchanged(set_switch(client, True), world, 409,
                        "Vendors' own check-in is set once the market is published.", before)

    def test_an_archived_market(self, client, world):
        before = dict(world.market(MarketPhase.ARCHIVED))

        self._unchanged(set_switch(client, True), world, 403, MarketsApi.ARCHIVED_REFUSAL, before)

    def test_a_market_archived_since_it_was_loaded_is_not_changed(self, client, world):
        on_its_days(world)
        load = MarketsApi._market_change

        def archived_after_the_load(*args, **kwargs):
            change = load(*args, **kwargs)
            world.markets.doc["phase"] = MarketPhase.ARCHIVED.value
            return change

        world.patch(MarketsApi, "_market_change", archived_after_the_load)

        answer = set_switch(client, True)

        assert answer.status_code == 409, answer.get_json()
        assert "vendorSelfCheckIn" not in world.markets.doc
        assert world.history.documents == []


class TestWhileItIsOff:
    @pytest.mark.parametrize("stored_as", [{}, {"vendorSelfCheckIn": False}],
                             ids=["never set", "off"])
    def test_the_vendors_four_routes_are_refused_and_write_nothing(
            self, client, world, stored_as):
        on_its_days(world, **stored_as)
        for method, path in THE_ORGANIZERS_FOUR[:2]:
            assert as_the_organizer(client, method, path).status_code == 200
        kept = stored(world)
        world.history.documents.clear()

        for method, door, with_code in THE_VENDORS_FOUR:
            answer = as_the_vendor(client, method, door, with_code)

            assert answer.status_code == 403, (method, door, answer.get_json())
            assert answer.get_json() == {"error": OFF}
        assert stored(world) == kept
        assert world.history.documents == []

    def test_a_vendor_not_yet_here_is_refused_too(self, client, world):
        on_its_days(world)

        for method, door, with_code in THE_VENDORS_FOUR:
            assert as_the_vendor(client, method, door, with_code).get_json() == {"error": OFF}
        assert world.attendance.documents == []

    def test_it_is_said_before_the_seat_the_day_and_the_code(self, client, world):
        on_its_days(world, assignmentObject={"vendorAssignments": []})
        headers = {"Authorization": f"Bearer {generate_application_token(MARKET, VENDOR)}"}

        for door in ("check-in", "check-out"):
            answer = client.post(f"{VENDOR_DOOR}/{door}", headers=headers,
                                 json={"date": "2031-01-01", "doorCode": "WRONG1"})

            assert (answer.status_code, answer.get_json()) == (403, {"error": OFF})

    @pytest.mark.parametrize("phase, status", [
        (MarketPhase.ASSIGNMENT, 409), (MarketPhase.ARCHIVED, 409)])
    def test_the_phase_is_said_before_it(self, client, world, phase, status):
        on_its_days(world)
        world.markets.doc["phase"] = phase.value
        world.markets.doc["resultsPublished"] = True
        world.markets.doc["intakeMode"] = "form"

        for method, door, with_code in THE_VENDORS_FOUR:
            answer = as_the_vendor(client, method, door, with_code)

            assert answer.status_code == status, answer.get_json()
            assert answer.get_json()["error"] != OFF

    @pytest.mark.parametrize("stored_as", [{}, {"vendorSelfCheckIn": False}],
                             ids=["never set", "off"])
    def test_the_organizers_four_writes_work(self, client, world, stored_as):
        on_its_days(world, **stored_as)

        for method, path in THE_ORGANIZERS_FOUR:
            answer = as_the_organizer(client, method, path)

            assert answer.status_code == 200, (method, path, answer.get_json())
        assert [entry["kind"] for entry in world.history.documents] == [
            History.CHECKED_IN, History.CHECKED_OUT, History.CHECK_OUT_UNDONE,
            History.CHECK_IN_UNDONE]
        assert world.attendance.documents == []


class TestTurnedOn:
    def test_the_vendors_four_work_once_an_organizer_turns_it_on(self, client, world):
        on_its_days(world)
        assert as_the_vendor(client, "post", "check-in", True).status_code == 403

        assert set_switch(client, True).status_code == 200
        world.history.documents.clear()

        for method, door, with_code in THE_VENDORS_FOUR:
            answer = as_the_vendor(client, method, door, with_code)

            assert answer.status_code == 200, (method, door, answer.get_json())
        assert [(entry["kind"], entry["actor"]) for entry in world.history.documents] == [
            (History.CHECKED_IN, None), (History.CHECKED_OUT, None),
            (History.CHECK_OUT_UNDONE, None), (History.CHECK_IN_UNDONE, None)]

    def test_turned_off_again_the_vendor_is_refused_and_their_record_stays(self, client, world):
        on_its_days(world, vendorSelfCheckIn=True)
        assert as_the_vendor(client, "post", "check-in", True).status_code == 200
        kept = stored(world)

        set_switch(client, False)

        assert as_the_vendor(client, "delete", "check-in", False).status_code == 403
        assert as_the_vendor(client, "post", "check-out", True).status_code == 403
        assert stored(world) == kept
        # The organizer's door goes on: the vendor's own check-in is checked out there.
        assert as_the_organizer(client, "post", f"{ATTENDANCE}/check-out").status_code == 200
