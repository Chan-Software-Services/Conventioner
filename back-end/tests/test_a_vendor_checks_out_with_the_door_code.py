"""A vendor checks themselves out on their vendor page, with the market's door code (T496).

The check-out mirrors the check-in: the vendor's sign-in says who they are, the door code that
they are at the door, where an organizer may want things returned, and every try is counted
against the check-in's limit. It needs no seat, only the day's check-in. Its undo takes no door
code, as the check-in's takes none. Every way it cannot pass writes nothing, and says why.
"""
import re
from datetime import date

import pytest

import api.attendance as AttendanceApi
import history as History
import sign_in_limits
from conftest import at_the_door
from datatypes import MarketPhase
from test_a_vendor_checks_in_with_the_door_code import (  # noqa: F401
    CODE, MARKET, RAN, SLUG, TODAY, VENDOR, client, ended_sign_in, signed_in, undo, world,
)

PATH = f"/public/markets/{SLUG}/vendor/check-out"
WRONG_CODE = "That isn't this market's door code. Check it, or ask at the door."
NOT_TODAY = "Check-in is open on the day itself."
SWITCH_OFF = "Vendors are checked in and out by an organizer at this market. Ask at the door."


def check_out(client, body=None, headers=None, slug=SLUG):
    return client.post(
        f"/public/markets/{slug}/vendor/check-out",
        json={"date": TODAY, "doorCode": CODE} if body is None else body,
        headers=signed_in() if headers is None else headers,
    )


def undo_check_out(client, body=None, headers=None):
    return client.delete(
        PATH, json={"date": TODAY} if body is None else body,
        headers=signed_in() if headers is None else headers,
    )


def stored(world):
    return [dict(record) for record in world.attendance.documents]


@pytest.fixture
def here(client, world):
    """The vendor checked in today with the door code, by a write that counts no try, and the
    history as new."""
    _result, status = AttendanceApi.record_attendance(
        at_the_door(MARKET), VENDOR, TODAY, via=AttendanceApi.VIA_DOOR_CODE)
    assert status == 200
    world.history.documents.clear()
    return world


class TestARightCodeChecksThemOut:
    def test_it_writes_the_check_out_made_with_the_door_code(self, client, here):
        [before] = stored(here)

        response = check_out(client)

        assert response.status_code == 200, response.get_json()
        body = response.get_json()
        assert body["message"] == "Checked out"
        [record] = here.attendance.documents
        assert record["checked_out_at"] == body["checkedOutAt"]
        assert record["checked_out_by"] is None
        assert record["checked_out_via"] == "door_code"
        assert {key: record[key] for key in before} == before

    @pytest.mark.parametrize("typed", ["k7m4qp", "K7M 4QP", "k7m-4qp", " K7M4QP "])
    def test_a_typed_code_is_read_as_the_check_in_reads_it(self, client, here, typed):
        assert check_out(client, {"date": TODAY, "doorCode": typed}).status_code == 200

    def test_the_history_names_the_vendor_and_the_door_code(self, client, here):
        check_out(client)

        [entry] = here.history.documents
        assert (entry["action"], entry["kind"], entry["actor"]) == (
            "check-in", History.CHECKED_OUT, None)
        assert entry["vendors"] == [VENDOR]
        assert entry["subject"] == {"date": TODAY}
        assert entry["detail"] == {
            "before": {"checked_out": False}, "after": {"checked_out": True}, "via": "door_code"}

    def test_the_roster_says_how_they_were_checked_out(self, client, here):
        out_at = check_out(client).get_json()["checkedOutAt"]

        [row] = [row for row in AttendanceApi.attendance_roster(here.markets.doc)["roster"]
                 if row["date"] == TODAY]
        assert (row["checkedOutAt"], row["checkedOutBy"], row["checkedOutVia"]) == (
            out_at, None, "door_code")

    def test_an_organizers_check_in_is_checked_out_by_the_vendor(self, client, world):
        world.attendance.insert_one({"market_id": MARKET, "vendor_email": VENDOR, "date": TODAY,
                                     "checked_in_at": "x", "checked_in_by": "o@x"})

        assert check_out(client).status_code == 200

    def test_a_vendor_freed_since_they_came_is_checked_out_with_no_seat(self, client, here):
        here.markets.doc["assignmentObject"] = {"vendorAssignments": []}

        assert check_out(client).status_code == 200

    def test_a_second_check_out_answers_the_stored_time_and_records_nothing(self, client, here):
        first = check_out(client).get_json()["checkedOutAt"]

        again = check_out(client)

        assert again.status_code == 200
        assert again.get_json()["checkedOutAt"] == first
        assert [entry["kind"] for entry in here.history.documents] == [History.CHECKED_OUT]


class TestEveryOtherWayWritesNothing:
    """Each refusal, in the order a vendor is told them."""

    def _refused(self, response, world, status, message, kept):
        assert response.status_code == status, response.get_json()
        assert response.get_json()["error"] == message
        assert stored(world) == kept
        assert world.history.documents == []

    def test_no_sign_in(self, client, here):
        kept = stored(here)

        response = check_out(client, headers={})

        assert response.status_code == 401
        assert stored(here) == kept

    def test_an_ended_sign_in(self, client, here):
        kept = stored(here)

        assert check_out(client, headers=ended_sign_in()).status_code == 401
        assert stored(here) == kept

    def test_a_market_with_no_vendor_page_answers_as_none(self, client, world):
        world.market(MarketPhase.ASSIGNMENT, intake_mode="csv", resultsPublished=False)
        gated = check_out(client)
        unknown = check_out(client, slug="no-such-market")

        assert gated.status_code == unknown.status_code == 404
        assert gated.get_data() == unknown.get_data()

    def test_another_markets_sign_in(self, client, here):
        self._refused(check_out(client, headers=signed_in("market-999")), here, 403,
                      "Your sign-in is for a different market. Please sign in again.",
                      stored(here))

    def test_an_ended_market(self, client, here):
        kept = stored(here)
        here.market(MarketPhase.ARCHIVED, reached=RAN)

        self._refused(check_out(client), here, 409, AttendanceApi.ENDED_REFUSAL, kept)

    @pytest.mark.parametrize("phase", [MarketPhase.APPLICATIONS, MarketPhase.ASSIGNMENT])
    def test_before_market_days(self, client, here, phase):
        kept = stored(here)
        here.market(phase)

        self._refused(check_out(client), here, 409,
                      "Check-in opens when the market's days begin.", kept)

    def test_the_switch_off_is_said_before_the_day_and_the_code(self, client, here):
        kept = stored(here)
        here.market(vendorSelfCheckIn=False)

        self._refused(check_out(client, {"date": "2099-08-03", "doorCode": "WRONG1"}), here, 403,
                      SWITCH_OFF, kept)

    def test_a_date_outside_a_day_of_the_servers_is_said_before_the_code(self, client, here):
        self._refused(check_out(client, {"date": "2099-08-03", "doorCode": "WRONG1"}), here, 409,
                      NOT_TODAY, stored(here))

    @pytest.mark.parametrize("body", [{"doorCode": CODE}, {"date": 20990801, "doorCode": CODE}])
    def test_no_date_is_no_day_in_reach(self, client, here, body):
        self._refused(check_out(client, body), here, 409, NOT_TODAY, stored(here))

    @pytest.mark.parametrize("typed", ["WRONG1", "", "K7M4Q", "K7M4QPX"])
    def test_a_wrong_door_code(self, client, here, typed):
        self._refused(check_out(client, {"date": TODAY, "doorCode": typed}), here, 403,
                      WRONG_CODE, stored(here))

    def test_no_door_code_sent(self, client, here):
        self._refused(check_out(client, {"date": TODAY}), here, 403, WRONG_CODE, stored(here))

    def test_a_wrong_code_is_said_before_a_day_with_no_check_in(self, client, world):
        self._refused(check_out(client, {"date": TODAY, "doorCode": "WRONG1"}), world, 403,
                      WRONG_CODE, [])

    def test_a_day_they_are_not_checked_in_on(self, client, world):
        self._refused(check_out(client), world, 404, "You are not checked in on this date.", [])

    def test_another_vendors_check_in_is_not_theirs(self, client, world):
        world.attendance.insert_one({"market_id": MARKET, "vendor_email": "other@example.com",
                                     "date": TODAY, "checked_in_at": "x"})

        response = check_out(client)

        assert response.status_code == 404
        assert "checked_out_at" not in world.attendance.documents[0]

    def test_a_code_never_reaches_a_wrong_answer(self, client, here):
        body = check_out(client, {"date": TODAY, "doorCode": "WRONG1"}).get_data(as_text=True)

        assert CODE not in body


class TestAttemptsAreBounded:
    def test_a_check_out_counts_against_the_check_ins_limit(self, client, here, monkeypatch):
        touched = []
        real = sign_in_limits.count_attempt
        monkeypatch.setattr(
            sign_in_limits, "count_attempt",
            lambda limit, subject, *a, **k: (
                touched.append((limit.name, subject)) or real(limit, subject, *a, **k)))

        check_out(client)

        assert touched == [("check-in:address", VENDOR)]

    def test_ten_tries_in_a_quarter_hour_then_the_check_ins_sentence(self, client, here):
        for _ in range(10):
            assert check_out(client, {"date": TODAY, "doorCode": "WRONG1"}).status_code == 403

        refused = check_out(client)

        assert refused.status_code == 429
        assert refused.headers["Retry-After"]
        assert re.fullmatch(
            r"Too many check-in attempts\. Please try again in (1 minute|\d+ minutes)\.",
            refused.get_json()["error"])
        assert "checked_out_at" not in here.attendance.documents[0]

    def test_the_limit_is_said_before_anything_about_the_market(self, client, here):
        for _ in range(10):
            check_out(client, {"date": TODAY, "doorCode": "WRONG1"})

        assert check_out(client, slug="no-such-market").status_code == 429


class TestItsUndo:
    def test_a_vendor_undoes_their_own_check_out_with_no_code(self, client, here):
        [before] = stored(here)
        check_out(client)

        response = undo_check_out(client)

        assert response.status_code == 200, response.get_json()
        assert response.get_json() == {"message": "Check-out undone"}
        assert stored(here) == [before]
        entry = here.history.documents[-1]
        assert (entry["kind"], entry["actor"], entry["vendors"]) == (
            History.CHECK_OUT_UNDONE, None, [VENDOR])
        assert entry["detail"] == {
            "before": {"checked_out": True}, "after": {"checked_out": False},
            "via": "vendor_page"}

    def test_an_organizers_check_out_today_may_be_undone(self, client, here):
        here.attendance.update_one(
            {"vendor_email": VENDOR}, {"$set": {
                "checked_out_at": "x", "checked_out_by": "o@x", "checked_out_via": None}})

        assert undo_check_out(client).status_code == 200
        assert "checked_out_at" not in here.attendance.documents[0]

    def test_it_counts_nothing_against_a_limit(self, client, here):
        statuses = {undo_check_out(client).status_code for _ in range(30)}

        assert 429 not in statuses

    def _kept(self, response, world, status, message, kept):
        assert response.status_code == status, response.get_json()
        if message is not None:
            assert response.get_json()["error"] == message
        assert stored(world) == kept

    def test_no_sign_in(self, client, here):
        check_out(client)

        self._kept(undo_check_out(client, headers={}), here, 401, None, stored(here))

    def test_another_markets_sign_in(self, client, here):
        check_out(client)

        self._kept(undo_check_out(client, headers=signed_in("market-999")), here, 403,
                   "Your sign-in is for a different market. Please sign in again.", stored(here))

    def test_not_once_the_market_has_ended(self, client, here):
        check_out(client)
        kept = stored(here)
        here.market(MarketPhase.ARCHIVED, reached=RAN)

        self._kept(undo_check_out(client), here, 409, AttendanceApi.ENDED_REFUSAL, kept)

    def test_not_while_the_switch_is_off(self, client, here):
        check_out(client)
        kept = stored(here)
        here.market(vendorSelfCheckIn=False)

        self._kept(undo_check_out(client), here, 403, SWITCH_OFF, kept)

    def test_not_a_past_days(self, client, here, monkeypatch):
        check_out(client)
        monkeypatch.setattr(AttendanceApi, "today", lambda: date.fromisoformat("2099-08-03"))

        self._kept(undo_check_out(client), here, 409, NOT_TODAY, stored(here))

    def test_no_date_is_the_undos_own_refusal(self, client, here):
        check_out(client)

        self._kept(undo_check_out(client, {}), here, 400, "date is required", stored(here))

    def test_a_day_with_no_check_out(self, client, here):
        self._kept(undo_check_out(client), here, 404,
                   "No check-out found for this vendor on this date", stored(here))

    def test_a_day_with_no_record(self, client, world):
        self._kept(undo_check_out(client), world, 404,
                   "No check-out found for this vendor on this date", [])


class TestTheCheckInsUndoWaitsOnTheCheckOuts:
    def test_a_vendor_undoing_their_check_in_while_checked_out_is_refused(self, client, here):
        check_out(client)
        here.history.documents.clear()
        kept = stored(here)

        response = undo(client)

        assert response.status_code == 409, response.get_json()
        assert response.get_json()["error"] == "Undo the check-out first."
        assert stored(here) == kept
        assert here.history.documents == []

    def test_after_the_check_outs_undo_it_goes(self, client, here):
        check_out(client)
        undo_check_out(client)

        assert undo(client).status_code == 200
        assert here.attendance.documents == []
