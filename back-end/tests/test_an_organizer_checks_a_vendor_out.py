"""An organizer checks a vendor out at the door, and undoes it (T496).

A market day recorded that a vendor came and nothing recorded that they left. A check-out is three
fields on the day's one attendance record, beside the check-in's: when, by whom and by which way.
It needs only the record, so a vendor here with no table that day is checked out too, and nothing
else reads it: a checked-out vendor still came.

Each is sent through the Flask client, as the screen sends it.
"""
import pytest

from conftest import at_the_door, skip_without_real_dependencies

skip_without_real_dependencies()

import api.attendance as AttendanceApi  # noqa: E402
import history as History  # noqa: E402
from datatypes import MarketPhase  # noqa: E402
from test_a_check_in_keeps_its_table import (  # noqa: E402
    ARCHIVED, ATTENDANCE, PLACEMENTS, archive_at_the_write, check_in, on_its_days, row_of, undo,
)
from test_every_write_records import (  # noqa: E402,F401
    DATE, MARKET, OWNER, VENDOR, client, world,
)

CHECK_OUT = f"{ATTENDANCE}/check-out"
BEN = "ben@example.com"


def check_out(client, email=VENDOR, date=DATE):
    return client.post(CHECK_OUT, json={"vendorEmail": email, "date": date})


def undo_check_out(client, email=VENDOR, date=DATE):
    return client.delete(CHECK_OUT, json={"vendorEmail": email, "date": date})


def kinds(world):
    return [entry["kind"] for entry in world.history.documents]


@pytest.fixture
def here(client, world):
    """The market in its days, the vendor seated and checked in by the organizer."""
    on_its_days(world, VENDOR, BEN)
    assert check_in(client).status_code == 200
    world.history.documents.clear()
    return world


class TestACheckOut:
    def test_it_records_when_and_who_beside_the_check_in(self, client, here):
        [before] = [dict(record) for record in here.attendance.documents]

        answer = check_out(client)

        assert answer.status_code == 200, answer.get_json()
        body = answer.get_json()
        assert body["message"] == "Checked out"
        [record] = here.attendance.documents
        assert record["checked_out_at"] == body["checkedOutAt"]
        assert record["checked_out_by"] == OWNER
        assert record["checked_out_via"] is None
        # The check-in is as it was: one record for the vendor's day.
        assert {key: record[key] for key in before} == before

    def test_the_roster_row_carries_it(self, client, here):
        out_at = check_out(client).get_json()["checkedOutAt"]

        row = row_of(client)

        assert (row["checkedOutAt"], row["checkedOutBy"], row["checkedOutVia"]) == (
            out_at, OWNER, None)

    def test_a_vendor_not_checked_out_reads_null_for_each(self, client, here):
        for email in (VENDOR, BEN):
            row = row_of(client, email)
            assert (row["checkedOutAt"], row["checkedOutBy"], row["checkedOutVia"]) == (
                None, None, None)

    def test_a_record_made_before_check_outs_reads_as_not_checked_out(self, client, world):
        on_its_days(world, VENDOR)
        world.attendance.insert_one({
            "market_id": MARKET, "vendor_email": VENDOR, "date": DATE,
            "checked_in_at": "2026-08-01T09:00:00+00:00", "checked_in_by": None,
        })

        row = row_of(client)

        assert row["state"] == "here"
        assert (row["checkedOutAt"], row["checkedOutBy"], row["checkedOutVia"]) == (
            None, None, None)
        # And it is checked out as any other.
        assert check_out(client).status_code == 200

    def test_the_history_says_who_checked_them_out(self, client, here):
        check_out(client)

        [entry] = here.history.documents
        assert (entry["action"], entry["kind"], entry["actor"]) == (
            "check-in", History.CHECKED_OUT, OWNER)
        assert entry["vendors"] == [VENDOR]
        assert entry["subject"] == {"date": DATE}
        assert entry["detail"] == {
            "before": {"checked_out": False}, "after": {"checked_out": True}}

    def test_a_vendor_here_with_no_table_is_checked_out_too(self, client, here):
        freed = client.delete(PLACEMENTS, json={"email": VENDOR, "date": DATE, "whileHere": True})
        assert freed.status_code == 200, freed.get_json()

        answer = check_out(client)

        assert answer.status_code == 200, answer.get_json()
        row = row_of(client)
        assert (row["state"], row["checkedOutAt"]) == (
            "here_without_seat", answer.get_json()["checkedOutAt"])

    def test_the_address_is_read_in_any_case(self, client, here):
        assert check_out(client, email="  Vendor@Example.COM ").status_code == 200
        assert row_of(client)["checkedOutAt"]


class TestASecondCheckOut:
    def test_it_answers_the_stored_time_and_records_nothing(self, client, here):
        first = check_out(client).get_json()["checkedOutAt"]

        again = check_out(client)

        assert again.status_code == 200, again.get_json()
        assert again.get_json() == {"message": "Checked out", "checkedOutAt": first}
        assert row_of(client)["checkedOutAt"] == first
        assert kinds(here) == [History.CHECKED_OUT]

    def test_two_at_once_leave_one_time_and_one_entry(self, here):
        first, status = AttendanceApi.record_check_out(at_the_door(MARKET, OWNER), VENDOR, DATE)
        second, also = AttendanceApi.record_check_out(
            at_the_door(MARKET, "door@example.com"), VENDOR, DATE)

        assert (status, also) == (200, 200)
        assert second["checkedOutAt"] == first["checkedOutAt"]
        [record] = here.attendance.documents
        assert (record["checked_out_at"], record["checked_out_by"]) == (
            first["checkedOutAt"], OWNER)
        assert kinds(here) == [History.CHECKED_OUT]


class TestItsUndo:
    def test_it_clears_the_check_out_and_keeps_the_check_in(self, client, here):
        [before] = [dict(record) for record in here.attendance.documents]
        check_out(client)

        answer = undo_check_out(client)

        assert answer.status_code == 200, answer.get_json()
        assert answer.get_json() == {"message": "Check-out undone"}
        assert here.attendance.documents == [before]
        row = row_of(client)
        assert (row["state"], row["checkedOutAt"], row["checkedOutBy"], row["checkedOutVia"]) == (
            "here", None, None, None)

    def test_the_history_says_who_undid_it(self, client, here):
        check_out(client)

        undo_check_out(client)

        entry = here.history.documents[-1]
        assert (entry["action"], entry["kind"], entry["actor"]) == (
            "check-in", History.CHECK_OUT_UNDONE, OWNER)
        assert entry["vendors"] == [VENDOR]
        assert entry["subject"] == {"date": DATE}
        assert entry["detail"] == {
            "before": {"checked_out": True}, "after": {"checked_out": False}}

    def test_a_vendor_checked_out_again_after_it_has_a_new_time(self, client, here):
        check_out(client)
        undo_check_out(client)

        assert check_out(client).status_code == 200
        assert kinds(here) == [
            History.CHECKED_OUT, History.CHECK_OUT_UNDONE, History.CHECKED_OUT]


class TestWhatItRefuses:
    def _refused(self, answer, world, status, message, kept):
        assert answer.status_code == status, answer.get_json()
        assert answer.get_json()["error"] == message
        assert world.attendance.documents == kept
        assert world.history.documents == []

    def test_a_check_out_on_a_day_with_no_record(self, client, here):
        kept = [dict(record) for record in here.attendance.documents]

        self._refused(check_out(client, BEN), here, 404,
                      "No check-in found for this vendor on this date", kept)

    def test_an_undo_on_a_day_with_no_record(self, client, here):
        kept = [dict(record) for record in here.attendance.documents]

        self._refused(undo_check_out(client, BEN), here, 404,
                      "No check-out found for this vendor on this date", kept)

    def test_an_undo_with_no_check_out(self, client, here):
        kept = [dict(record) for record in here.attendance.documents]

        self._refused(undo_check_out(client), here, 404,
                      "No check-out found for this vendor on this date", kept)

    @pytest.mark.parametrize("write", [check_out, undo_check_out])
    @pytest.mark.parametrize("body, message", [
        ({"date": DATE}, "vendorEmail is required"),
        ({"vendorEmail": VENDOR}, "date is required"),
        ({"vendorEmail": "  ", "date": DATE}, "vendorEmail is required"),
    ])
    def test_a_body_missing_the_vendor_or_the_date(self, client, here, write, body, message):
        kept = [dict(record) for record in here.attendance.documents]
        method = client.post if write is check_out else client.delete

        self._refused(method(CHECK_OUT, json=body), here, 400, message, kept)

    @pytest.mark.parametrize("write", [check_out, undo_check_out])
    @pytest.mark.parametrize("phase", [MarketPhase.APPLICATIONS, MarketPhase.ASSIGNMENT])
    def test_a_market_not_in_its_days(self, client, here, write, phase):
        check_out(client)
        here.history.documents.clear()
        kept = [dict(record) for record in here.attendance.documents]
        here.markets.doc["phase"] = phase.value

        self._refused(write(client), here, 409,
                      "Vendors are checked in once the market is published.", kept)

    @pytest.mark.parametrize("write", [check_out, undo_check_out])
    def test_an_archived_market(self, client, here, write):
        check_out(client)
        here.history.documents.clear()
        kept = [dict(record) for record in here.attendance.documents]
        here.markets.doc["phase"] = MarketPhase.ARCHIVED.value

        answer = write(client)

        assert answer.status_code == 403, answer.get_json()
        assert here.attendance.documents == kept
        assert here.history.documents == []

    @pytest.mark.parametrize("write", [
        AttendanceApi.record_check_out, AttendanceApi.undo_check_out])
    def test_an_archived_market_is_refused_on_the_writes_own_read(self, client, here, write):
        check_out(client)
        kept = [dict(record) for record in here.attendance.documents]
        here.markets.doc["phase"] = MarketPhase.ARCHIVED.value

        result, status = write(at_the_door(MARKET, OWNER), VENDOR, DATE)

        assert (status, result["error"]) == (409, ARCHIVED)
        assert here.attendance.documents == kept


class TestTheCheckInsUndoWaitsOnTheCheckOuts:
    def test_an_undo_of_the_check_in_on_a_checked_out_day_is_refused(self, client, here):
        check_out(client)
        here.history.documents.clear()
        kept = [dict(record) for record in here.attendance.documents]

        answer = undo(client)

        assert answer.status_code == 409, answer.get_json()
        assert answer.get_json()["error"] == "Undo the check-out first."
        assert here.attendance.documents == kept
        assert here.history.documents == []

    def test_once_the_check_out_is_undone_the_check_in_is_too(self, client, here):
        check_out(client)
        undo_check_out(client)

        assert undo(client).status_code == 200
        assert here.attendance.documents == []

    def test_an_undo_with_no_check_in_is_still_not_found(self, client, here):
        answer = undo(client, BEN)

        assert answer.status_code == 404
        assert answer.get_json()["error"] == "No check-in found for this vendor on this date"

    def test_checking_in_again_leaves_the_check_out_as_it_is(self, client, here):
        out_at = check_out(client).get_json()["checkedOutAt"]

        assert check_in(client).status_code == 200

        row = row_of(client)
        assert (row["checkedOutAt"], row["checkedOutBy"]) == (out_at, OWNER)


class TestTheDoorHoldsThePhase:
    def test_a_check_out_on_a_market_archived_a_moment_before_is_taken_back(self, client, here):
        kept = [dict(record) for record in here.attendance.documents]
        archive_at_the_write(here)

        answer = check_out(client)

        assert answer.status_code == 409, answer.get_json()
        assert answer.get_json()["error"] == ARCHIVED
        assert here.attendance.documents == kept
        assert here.history.documents == []

    def test_an_undo_on_a_market_archived_a_moment_before_puts_the_check_out_back(
            self, client, here):
        check_out(client)
        here.history.documents.clear()
        kept = [dict(record) for record in here.attendance.documents]
        archive_at_the_write(here)

        answer = undo_check_out(client)

        assert answer.status_code == 409, answer.get_json()
        assert answer.get_json()["error"] == ARCHIVED
        assert here.attendance.documents == kept
        assert here.history.documents == []

    def test_a_check_in_again_archived_a_moment_before_puts_the_check_out_back_too(
            self, client, here):
        check_out(client)
        here.history.documents.clear()
        kept = [dict(record) for record in here.attendance.documents]
        archive_at_the_write(here)

        assert check_in(client).status_code == 409
        assert here.attendance.documents == kept


def everything_else(client, world):
    """What the door, the Stats tab, Payments and the placement doors read of the day, each as its
    own reader gives it, less the roster row's three check-out fields. The public map's read is
    held in its own world (``test_the_public_map.py``)."""
    roster = client.get(ATTENDANCE)
    payments = client.get(f"/markets/{MARKET}/payments")
    assert roster.status_code == payments.status_code == 200, (
        roster.get_json(), payments.get_json())
    record = AttendanceApi.checked_in_on(MARKET, VENDOR, DATE)
    return {
        "roster": [
            {key: value for key, value in row.items() if not key.startswith("checkedOut")}
            for row in roster.get_json()["roster"]
        ],
        "dates": roster.get_json()["dates"],
        "counts": AttendanceApi.check_in_counts(world.markets.doc),
        "payments": payments.get_json(),
        "is here, as a free or a move asks": record is not None,
        "check-ins of the vendor": AttendanceApi.check_ins_of(MARKET, VENDOR),
        "the market ran": AttendanceApi.market_has_attendance(MARKET),
        "the market's check-ins": AttendanceApi.get_attendance_for_market(MARKET),
    }


class TestNothingElseReadsIt:
    """A checked-out vendor still came: every state, count and read but the roster row's three
    fields and the vendor's own seat is the same before a check-out, after it and after its undo."""

    def test_the_door_the_counts_and_the_owed_days_read_as_before(self, client, here):
        before = everything_else(client, here)
        assert [row["state"] for row in before["roster"]] == ["here", "expected"]
        assert before["counts"]["came"] == 1

        assert check_out(client).status_code == 200
        checked_out = everything_else(client, here)
        assert undo_check_out(client).status_code == 200

        assert checked_out == before
        assert everything_else(client, here) == before

    def test_a_free_still_asks_first_for_a_vendor_checked_out(self, client, here):
        check_out(client)

        freed = client.delete(PLACEMENTS, json={"email": VENDOR, "date": DATE})

        assert freed.status_code == 409, freed.get_json()
        assert freed.get_json()["code"] == "vendor_is_here"
