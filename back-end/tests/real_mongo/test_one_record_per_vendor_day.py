"""One owed record and one check-in per vendor's day, on a real server with real threads (T270).

Two writes that land at once on a day with no record both read none and both insert its first; only
the boot's unique index on (market, vendor, date) keeps the day one record. The hermetic suite
proves each writer's retry through fakes; these run the race where the index lives.

What the server does is part of the answer. MongoDB retries an upsert refused by a unique index
itself when its filter is equalities on exactly the index's fields, so a check-in, whose filter is
the vendor's day, never sees the refusal: none reached the client in 600 such upserts on 8.0. An
owed day's first record is an insert (``payments.owed_day_transition``, T335), whose refusal comes
back, and the owner's read again is what lands it; the staged test below makes every free meet it.
Every later write of the day holds the record's ``revision``, so the writes that land are one
sequence, each read off the one before it.

A check-out is fields on the check-in's record (T496), written by an update filtered to a day not
yet checked out; the last class races it, and its undo, where the filter is the server's to read.
"""
import threading
from datetime import date
from typing import Any, Dict, List

import pytest
from pymongo.errors import DuplicateKeyError

import api.attendance as AttendanceApi
import api.market_actions as Actions
import history as History
import payments as Payments
from real_mongo import harness

MARKET = "market-vendor-day"
VENDOR = "racing-vendor@example.com"
DAY = "2099-05-08"
ADMIN = "admin@example.com"
EDITOR = "editor@example.com"
SEAT = Payments.Seat(table_code="Main Hall 1", tier="Full Table", table_choice="Full Table",
                     cents=3500)

#: How long a staged thread waits for the others, so a missed release fails instead of hanging.
STAGE_TIMEOUT_SECONDS = harness.RACE_TIMEOUT_SECONDS


def _owed_records(amounts_owed) -> List[Dict[str, Any]]:
    return list(amounts_owed.find({"market_id": MARKET, "vendor_email": VENDOR, "date": DAY}))


def _set(i: int) -> Payments.OwedTransition:
    """The ``i``th Admin's amount by hand, ``100 + i`` cents, on the day the vendor holds."""
    return Payments.owed_day_transition(MARKET, VENDOR, DAY, Payments.OwedEvent.ADMIN_SETS,
                                        held=SEAT, by=f"{ADMIN}#{i}", cents=100 + i)


def _free(i: int, deduct: bool) -> Payments.OwedTransition:
    event = (Payments.OwedEvent.FREED_WITH_DEDUCTION if deduct else Payments.OwedEvent.FREED)
    return Payments.owed_day_transition(MARKET, VENDOR, DAY, event, held=SEAT, seat=SEAT,
                                        by=f"{EDITOR}#{i}")


def _landed(answered) -> List[Payments.OwedTransition]:
    """Each write that landed, in the order it landed: every answer is a write that landed or one
    that read a day that kept changing and wrote nothing, a 409 at the route."""
    assert [answer for answer in answered if not isinstance(
        answer, (Payments.OwedTransition, Payments.OwedDayChanged))] == []
    landed = [answer for answer in answered if isinstance(answer, Payments.OwedTransition)]
    assert all(answer.wrote for answer in landed)
    return sorted(landed, key=lambda answer: answer.revision)


def _one_sequence(landed, record) -> None:
    """The day's record is what the landed writes made, one after another: each read the record
    the one before it wrote, and the last is the one stored."""
    assert [answer.revision for answer in landed] == list(range(1, len(landed) + 1))
    assert landed[0].record is None
    for earlier, later in zip(landed, landed[1:]):
        assert later.record["revision"] == earlier.revision
        assert Payments.state_of(later.record) == earlier.after
    assert record["revision"] == landed[-1].revision
    assert Payments.state_of(record) == landed[-1].after
    assert {key: record.get(key) for key in ("freed", "set_by_hand")} == Payments.legacy_fields(
        landed[-1].after)


class _Counting:
    """The owed collection, counting each unique-index refusal its inserts met, by thread."""

    def __init__(self, collection):
        self._collection = collection
        self.refused: Dict[int, int] = {}
        self._lock = threading.Lock()

    def __getattr__(self, name):
        return getattr(self._collection, name)

    def insert_one(self, *args, **kwargs):
        try:
            return self._collection.insert_one(*args, **kwargs)
        except DuplicateKeyError:
            with self._lock:
                key = threading.get_ident()
                self.refused[key] = self.refused.get(key, 0) + 1
            raise


class TestOneOwedRecordPerVendorDay:
    @pytest.mark.parametrize("deduct", [False, True], ids=["free", "free and deduct"])
    def test_twenty_amounts_set_and_twenty_frees_at_once_on_a_new_day_leave_one_record(
            self, boot_indexes, market_records, race, deduct):
        """Every thread writes the day's first record: none was there when they were released."""
        amounts_owed = market_records.amounts_owed
        harness.warm(amounts_owed, 40)

        answered = race(40, lambda i: _set(i) if i < 20 else _free(i, deduct))

        landed = _landed(answered)
        assert landed
        [record] = _owed_records(amounts_owed)
        _one_sequence(landed, record)
        # An Admin's amount set is never lost to a free: once one landed, every state after it
        # holds an Admin's amount, as set, as the freed line's, or as what the free's $0 replaced.
        amounts_set = {(100 + i, f"{ADMIN}#{i}") for i in range(20)}
        for earlier, later in zip(landed, landed[1:]):
            if isinstance(earlier.after, Payments.SetByHand) or (
                    isinstance(earlier.after, Payments.Freed) and earlier.after.amount):
                kept = later.after
                amount = (kept.before if isinstance(kept, Payments.FreedWaived)
                          else kept.amount)
                assert (amount.cents, amount.by) in amounts_set

    @pytest.mark.parametrize("deduct", [False, True], ids=["free", "free and deduct"])
    def test_frees_that_read_no_record_meet_the_index_and_land_on_the_admins_record(
            self, boot_indexes, market_records, race, monkeypatch, deduct):
        """Staged so the losing branch runs every time: the twenty frees each read the day with no
        record, the twenty amounts set by hand then create it, and only then do the frees write.
        Each free's insert is refused by the unique index, and its read again lands it on that
        record, or reads a day the other frees kept changing and writes nothing."""
        amounts_owed = market_records.amounts_owed
        counting = _Counting(amounts_owed)
        monkeypatch.setattr(Payments, "amounts_owed_collection", counting)
        harness.warm(amounts_owed, 40)

        all_read = threading.Event()
        all_set = threading.Event()
        read_together = threading.Barrier(20, action=all_read.set, timeout=STAGE_TIMEOUT_SECONDS)
        staged = threading.local()
        set_count = []
        set_lock = threading.Lock()
        after_setters: Dict[str, Any] = {}

        def find_one(*args, **kwargs):
            found = amounts_owed.find_one(*args, **kwargs)
            if getattr(staged, "free", False) and not getattr(staged, "read", False):
                staged.read = True
                read_together.wait()
                if not all_set.wait(STAGE_TIMEOUT_SECONDS):
                    raise AssertionError("the amounts set never all landed")
            return found

        counting.find_one = find_one

        def setter(i):
            if not all_read.wait(STAGE_TIMEOUT_SECONDS):
                raise AssertionError("the frees never all read the day")
            try:
                return _set(i)
            finally:
                with set_lock:
                    set_count.append(i)
                    if len(set_count) == 20:
                        [after_setters["record"]] = _owed_records(amounts_owed)
                        all_set.set()

        frees_ident = set()

        def freer(i):
            staged.free = True
            frees_ident.add(threading.get_ident())
            return _free(i, deduct)

        answered = race(40, lambda i: setter(i) if i < 20 else freer(i))

        landed = _landed(answered)
        [record] = _owed_records(amounts_owed)
        _one_sequence(landed, record)
        # Every free's first write met the index once, and no free met it twice.
        assert {ident: counting.refused.get(ident, 0) for ident in frees_ident} == {
            ident: 1 for ident in frees_ident}
        setters_left = after_setters["record"]["revision"]
        frees = [answer for answer in landed if answer.revision > setters_left]
        assert frees
        admins = Payments.state_of(after_setters["record"])
        assert isinstance(admins, Payments.SetByHand)
        kept = Payments.state_of(record)
        if deduct:
            # Whichever free's $0 stands, it keeps the amount the Admins left as what it replaced.
            assert isinstance(kept, Payments.FreedWaived)
            assert kept.before == admins.amount
        else:
            # A free writes no amount, and leaves the Admins' amount standing on the freed line.
            assert isinstance(kept, Payments.Freed)
            assert kept.amount == admins.amount


class TestOneCheckInPerVendorDay:
    def test_twenty_check_ins_at_once_leave_one_record_and_one_arrival(
            self, boot_indexes, real_db, market_records, race, monkeypatch):
        real_db["markets"].insert_one({
            "id": MARKET,
            "phase": "market_days",
            "assignmentObject": {"vendorAssignments": [{"email": VENDOR, "date": DAY,
                                                        "tableCode": "Main Hall 1"}]},
        })
        # The market's day has begun: the door takes no check-in for a day that has not.
        monkeypatch.setattr(AttendanceApi, "today", lambda: date.fromisoformat(DAY))
        harness.warm(market_records.attendance, 20)

        answered = race(20, lambda i: AttendanceApi.record_attendance(
            Actions.Asked(Actions.CHECK_IN, MARKET, f"{EDITOR}#{i}", None), VENDOR, DAY))

        assert [status for _body, status in answered] == [200] * 20
        assert {body["message"] for body, _status in answered} == {"Checked in"}
        [record] = list(market_records.attendance.find(
            {"market_id": MARKET, "vendor_email": VENDOR, "date": DAY}))
        # The record is the last check-in's: each one writes its own time and organizer.
        assert record["checked_in_at"] in {body["checkedInAt"] for body, _status in answered}
        arrivals = list(market_records.history.find({"market_id": MARKET,
                                                     "kind": History.CHECKED_IN}))
        assert len(arrivals) == 1


class TestOneCheckOutPerVendorDay:
    """A check-out is one update filtered to a day not yet checked out (T496), so the server lets
    one of many at once write: the others answer its time. The filter's null must match a record
    with no check-out fields at all, which is every record stored before check-outs."""

    def _the_vendor_is_here(self, real_db, market_records):
        real_db["markets"].insert_one({"id": MARKET, "phase": "market_days"})
        # As stored before check-outs: no ``checked_out_*`` field.
        market_records.attendance.insert_one({
            "market_id": MARKET, "vendor_email": VENDOR, "date": DAY,
            "table_code": "Main Hall 1", "checked_in_at": "2099-05-08T09:00:00+00:00",
            "checked_in_by": None, "checked_in_via": "door_code"})

    def _record(self, market_records):
        [record] = list(market_records.attendance.find(
            {"market_id": MARKET, "vendor_email": VENDOR, "date": DAY}))
        return record

    def _entries(self, market_records, kind):
        return list(market_records.history.find({"market_id": MARKET, "kind": kind}))

    def test_twenty_check_outs_at_once_leave_one_time_and_one_entry(
            self, boot_indexes, real_db, market_records, race):
        self._the_vendor_is_here(real_db, market_records)
        harness.warm(market_records.attendance, 20)

        answered = race(20, lambda i: AttendanceApi.record_check_out(
            Actions.Asked(Actions.CHECK_IN, MARKET, f"{EDITOR}#{i}", None), VENDOR, DAY))

        assert [status for _body, status in answered] == [200] * 20
        record = self._record(market_records)
        assert {body["checkedOutAt"] for body, _status in answered} == {record["checked_out_at"]}
        [entry] = self._entries(market_records, History.CHECKED_OUT)
        # The one that wrote is the one recorded.
        assert entry["actor"] == record["checked_out_by"]
        assert record["checked_in_at"] == "2099-05-08T09:00:00+00:00"

    def test_a_checked_out_day_keeps_its_check_in_until_the_check_out_is_undone(
            self, boot_indexes, real_db, market_records, race):
        self._the_vendor_is_here(real_db, market_records)
        asked = Actions.Asked(Actions.CHECK_IN, MARKET, EDITOR, None)
        assert AttendanceApi.record_check_out(asked, VENDOR, DAY)[1] == 200

        refused = AttendanceApi.undo_attendance(asked, VENDOR, DAY)

        assert refused == ({"error": "Undo the check-out first."}, 409)
        assert self._record(market_records)["checked_out_at"]

        harness.warm(market_records.attendance, 20)
        undone = race(20, lambda i: AttendanceApi.undo_check_out(
            Actions.Asked(Actions.CHECK_IN, MARKET, f"{EDITOR}#{i}", None), VENDOR, DAY))

        # One undo landed; the rest found no check-out.
        assert sorted(status for _body, status in undone) == [200] + [404] * 19
        assert len(self._entries(market_records, History.CHECK_OUT_UNDONE)) == 1
        record = self._record(market_records)
        assert not {"checked_out_at", "checked_out_by", "checked_out_via"} & set(record)
        assert AttendanceApi.undo_attendance(asked, VENDOR, DAY)[1] == 200
        assert list(market_records.attendance.find({"market_id": MARKET})) == []
