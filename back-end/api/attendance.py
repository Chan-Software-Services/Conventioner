"""Who came to a market on each of its days: the check-ins, the roster the organizer works from, the
Stats tab's count of it, and whether a market ran.

A check-in is made by an organizer at Attendance (``api/door.py``) or by the vendor on their vendor
page with the door code (``api/vendor_check_in.py``); both write through ``record_attendance``, and
the record says which (``checked_in_by``, ``checked_in_via``), and at which table (``table_code``,
T318).

A check-out is three fields on that same record (``CHECK_OUT_FIELDS``, T496): when the vendor left,
who recorded it and by which way, written by ``record_check_out`` and cleared by
``undo_check_out``. One vendor's day stays one record, and a record with no ``checked_out_at`` is a
vendor not checked out. Only the roster row and the vendor's own read carry it: a checked-out
vendor still came, so every state, count and "is anyone here" reads as before.

Both doors share one "today" (``day_has_begun``, ``within_the_window``): the server's UTC date, a
day either side of which is "today" somewhere on Earth, since the server cannot know the market's
time zone.
"""
from datetime import date as Date, datetime, timezone
from typing import Any, Dict, List, NamedTuple, Optional, Tuple

from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

import api.applications as ApplicationsApi
import history as History
import phase_record as PhaseRecord
from assignment.utils import convert_keys_to_camel_case, convert_keys_to_snake_case
from datatypes import MarketPhase, phase_from_market_document, table_code_sort_key
from db_config import get_database
from market_documents import market_dates_of
from tombstone import live
from unique_indexes import ensure_vendor_day_index
from utils.email_address import normalized_email

ATTENDANCE_COLLECTION = "attendance"

db = get_database()
attendance_collection = db[ATTENDANCE_COLLECTION]
markets_collection = db["markets"]

ENDED_REFUSAL = "This market has ended, so check-in is closed."
NOT_PUBLISHED = "Vendors are checked in once the market is published."
NOT_BEGUN = "That day has not begun yet, so nobody can be checked in for it."
MARKET_NOT_FOUND = "Market not found"
NO_CHECK_IN = "No check-in found for this vendor on this date"
NO_CHECK_OUT = "No check-out found for this vendor on this date"
CHECKED_OUT_FIRST = "Undo the check-out first."

#: What a check-out writes on the day's record, beside the check-in's fields: when (ISO 8601 UTC),
#: the organizer who made it (None for the vendor's own) and the vendor's way (``VIA_DOOR_CODE``,
#: else None).
CHECK_OUT_FIELDS = ("checked_out_at", "checked_out_by", "checked_out_via")
#: The ``$unset`` that takes a check-out off a record.
_NO_CHECK_OUT = {field: "" for field in CHECK_OUT_FIELDS}

#: How far a date may be from the server's UTC date and still be "today" somewhere on Earth.
WINDOW_DAYS = 1

#: Where a vendor stands at the door on a date (T318), served on each roster row as ``state``.
#: ``expected``: a seat that day and no check-in. ``here``: a check-in made at the seat they hold.
#: ``here_elsewhere``: a check-in made at another table than the one they hold now, so the record
#: never moves to a table they never reached. ``here_without_seat``: a check-in and no seat that day,
#: served as a row of its own, so an arrival is never hidden by a free.
EXPECTED = "expected"
HERE = "here"
HERE_ELSEWHERE = "here_elsewhere"
HERE_WITHOUT_SEAT = "here_without_seat"

#: What ``phase_from_market_document`` reads, for the door's second read of the phase.
_PHASE_FIELDS = {"id": 1, "phase": 1, "isDraft": 1, "is_draft": 1, "intakeMode": 1}

#: The ``via`` of a vendor's own check-in, made with the door code on their vendor page (ADR 0022).
VIA_DOOR_CODE = "door_code"
#: The ``via`` of a vendor's own undo, on their vendor page, which takes no door code.
VIA_VENDOR_PAGE = "vendor_page"


def ensure_attendance_indexes() -> None:
    """One attendance record per vendor's day, held by the database (T270).

    A check-in is an upsert by market, vendor and date, and two that land at once both match
    nothing and both insert, so only a unique index keeps the day one record: with two, one Undo
    left the vendor reading as here, and the history held two arrivals. ``app.py`` builds it at
    boot and refuses to start without it (``unique_indexes``).
    """
    ensure_vendor_day_index(attendance_collection, ATTENDANCE_COLLECTION)


def _stored_assignment_rows(market_doc: Dict[str, Any]) -> List[Dict[str, Any]]:
    """The market's stored placements, snake_cased: the one thing check-in reads, both to tell a
    vendor where to go and to record that they came."""
    market_snake = convert_keys_to_snake_case(market_doc.copy())
    assignment_object = market_snake.get("assignment_object") or {}
    return list(assignment_object.get("vendor_assignments") or [])


def seat_on(market_doc: Dict[str, Any], vendor_email: str, date: str) -> Optional[Dict[str, Any]]:
    """The stored row seating this vendor on this date, snake_cased, or None.

    A placement is dated by the market date itself. It used to be dated by the spreadsheet column
    heading that asked about that day, so every reader here had to build a map from headings back
    to dates before it could compare anything.
    """
    target_email = normalized_email(vendor_email)
    return next((
        row for row in _stored_assignment_rows(market_doc)
        if normalized_email(str(row.get("email", ""))) == target_email
        and str(row.get("date", "")) == date
    ), None)


def seated_on(market_doc: Dict[str, Any], vendor_email: str, date: str) -> bool:
    """Does the market's stored assignment seat this vendor on this date?"""
    return seat_on(market_doc, vendor_email, date) is not None


def today() -> Date:
    """The server's UTC date; a function so a test can move it."""
    return datetime.now(timezone.utc).date()


def _days_from_today(day: str) -> Optional[int]:
    try:
        return (Date.fromisoformat(day) - today()).days
    except ValueError:
        return None


def day_has_begun(day: str) -> bool:
    """Has this date begun somewhere on Earth: is it no later than the server's UTC date plus one?
    A string that is no date has not. The organizer's door takes any day that has (T318), so a tap
    missed in the rush is corrected after, and a mis-tapped future date is not an arrival."""
    days = _days_from_today(day)
    return days is not None and days <= WINDOW_DAYS


def within_the_window(day: str) -> bool:
    """Is this date "today" somewhere on Earth: within one day of the server's UTC date? The
    vendor's door keeps to it (ADR 0022), so a door code read today cannot check them in for next
    week, nor erase a past day's record."""
    days = _days_from_today(day)
    return days is not None and abs(days) <= WINDOW_DAYS


def market_has_ended(market_doc: Dict[str, Any]) -> bool:
    """Is this market a record rather than a door? Nobody checks in at an archived market."""
    return phase_from_market_document(market_doc) is MarketPhase.ARCHIVED


def _closed_door(market_doc: Optional[Dict[str, Any]]) -> Optional[Tuple[Dict[str, Any], int]]:
    """Why nobody may be checked in or out at this market now, or None in its days: gone, archived
    (``ENDED_REFUSAL``), or not yet in its days (``NOT_PUBLISHED``)."""
    if not market_doc:
        return {"error": MARKET_NOT_FOUND}, 404
    phase = phase_from_market_document(market_doc)
    if phase is MarketPhase.ARCHIVED:
        return {"error": ENDED_REFUSAL}, 409
    if phase is not MarketPhase.MARKET_DAYS:
        return {"error": NOT_PUBLISHED}, 409
    return None


def _closed_since(market_id: str) -> Optional[Tuple[Dict[str, Any], int]]:
    """The door's second read of the phase, after its write: why it closed since its first, or None.

    A check-in writes the attendance collection and the phase lives on the market, so no one write
    can hold both (ADR 0024's last consequence). The door reads the phase, writes, and reads it
    again; a market archived in between takes the write back (``_take_back_*``).
    """
    closed = _closed_door(markets_collection.find_one(live({"id": market_id}), _PHASE_FIELDS))
    if closed and closed[0]["error"] == NOT_PUBLISHED:
        # Only the archive can follow market days; whatever else moved it, the door is closed.
        return {"error": ENDED_REFUSAL}, 409
    return closed


def market_ran(market_doc: Dict[str, Any]) -> bool:
    """Did this market reach its market days? Read off its phase record, and where that is partial,
    off whether anyone checked in (``phase_record``)."""
    return PhaseRecord.phases_reached(market_doc, market_has_attendance).ran


def ended_after_it_ran(market_doc: Dict[str, Any]) -> bool:
    """Is this market a record of days that happened: archived, after it ran?"""
    return market_has_ended(market_doc) and market_ran(market_doc)


def checked_in_on(market_id: str, vendor_email: str, date: str) -> Optional[Dict[str, Any]]:
    """This vendor's check-in at this market on this date, or None: one record, read by the
    normalised address, which is how a check-in is stored. The placement doors read it to ask
    before they free, move or swap a vendor who is here (T318)."""
    return attendance_collection.find_one({
        "market_id": market_id,
        "vendor_email": normalized_email(vendor_email),
        "date": date,
    })


def check_ins_of(market_id: str, vendor_email: str) -> Dict[str, Optional[str]]:
    """When one vendor checked in at a market, ``{date: checked_in_at}``, for the dates they did."""
    return {
        doc["date"]: doc.get("checked_in_at")
        for doc in attendance_collection.find({
            "market_id": market_id,
            "vendor_email": normalized_email(vendor_email),
        })
        if doc.get("date")
    }


def check_outs_of(market_id: str, vendor_email: str) -> Dict[str, str]:
    """When one vendor checked out at a market, ``{date: checked_out_at}``, for the dates they
    did."""
    return {
        doc["date"]: doc["checked_out_at"]
        for doc in attendance_collection.find({
            "market_id": market_id,
            "vendor_email": normalized_email(vendor_email),
        })
        if doc.get("date") and doc.get("checked_out_at")
    }


def _not_a_vendors_day(
    market_id: Any, vendor_email: Any, date: Any,
) -> Optional[Tuple[Dict[str, Any], int]]:
    """The 400 for a door write that does not name a market, a vendor and a date, or None."""
    if not isinstance(market_id, str) or not market_id.strip():
        return {"error": "market_id is required"}, 400
    if not isinstance(vendor_email, str) or not vendor_email.strip():
        return {"error": "vendorEmail is required"}, 400
    if not isinstance(date, str) or not date.strip():
        return {"error": "date is required"}, 400
    return None


def _vendor_day(market_id: str, vendor_email: str, date: str) -> Dict[str, Any]:
    """The filter of one vendor's day, which is one record (``ensure_attendance_indexes``)."""
    return {
        "market_id": market_id,
        "vendor_email": normalized_email(vendor_email),
        "date": date.strip(),
    }


def undo_attendance(
    recorder: History.Recorder, vendor_email: str, date: str, via: Optional[str] = None,
) -> Tuple[Dict[str, Any], int]:
    """Remove a check-in a vendor made on the wrong day, on ``recorder``'s market, recorded
    through it as its actor: the organizer's "Check vendors in" asking, or the vendor's own undo's
    unasked recorder, with no actor (``_record_door``).

    A two-day market offered an identical button per date and no undo, so one mis-tap recorded a
    vendor as present on a day they were not. Deleting the record is the whole operation: a
    check-in is a single document keyed by (market, vendor, date), and there is nothing else it
    changed.

    Only in the market's days, on its own read of the phase, and a market archived between that
    read and the delete gets the record back (``_closed_since``): the archived record of who came
    stays whole.

    A checked-out day is refused, 409 ``CHECKED_OUT_FIRST``: the delete would drop the check-out
    with the record, and a check-out is never dropped without its own entry (T496).
    """
    market_id = recorder.market_id
    refused = _not_a_vendors_day(market_id, vendor_email, date)
    if refused:
        return refused

    closed = _closed_door(markets_collection.find_one(live({"id": market_id}), _PHASE_FIELDS))
    if closed:
        return closed

    vendor_day = _vendor_day(market_id, vendor_email, date)
    # A null matches a missing field, so a record made before check-outs is deleted as ever.
    removed = attendance_collection.find_one_and_delete({**vendor_day, "checked_out_at": None})
    if removed is None:
        if attendance_collection.find_one(vendor_day) is not None:
            return {"error": CHECKED_OUT_FIRST}, 409
        return {"error": NO_CHECK_IN}, 404
    closed = _closed_since(market_id)
    if closed:
        _take_back_a_delete(removed)
        return closed
    _record_door(recorder, vendor_email, date, via, History.CHECK_IN_UNDONE, "checked_in", False)
    return {"message": "Check-in undone"}, 200


def record_attendance(
    recorder: History.Recorder, vendor_email: str, date: str, via: Optional[str] = None,
) -> Tuple[Dict[str, Any], int]:
    """Upsert an attendance record for (``recorder``'s market, vendor_email, date), at the table
    the vendor holds that day, recorded through ``recorder`` (``_record_door``).

    ``checked_in_by`` is ``recorder``'s actor: the organizer who checked the vendor in at the door
    (E29/F01/S02), through their "Check vendors in" asking, and None when the vendor did it
    themselves, through the unasked door, when ``via`` says how (``VIA_DOOR_CODE``). Both are
    written either way, so a vendor checking in again after an organizer did is not still credited
    to the organizer, nor an organizer's check-in after a scan to the door code. ``table_code`` is
    the seat's at the moment of the check-in (T318), so a vendor moved or freed after reads as here
    at the table they reached; checking in again at a new seat moves it there, with the time.

    Two check-ins of one vendor's day at once leave one record and one "checked in" entry: the
    unique index refuses the second insert (``ensure_attendance_indexes``), the loser lands on the
    winner's record, and only the call that inserted the record writes the entry.

    Only in the market's days, on its own read of the phase, on a date that has begun somewhere
    (``day_has_begun``); and a market archived between that read and the write gets the write taken
    back, with no entry (``_closed_since``).

    A check-out on the record is left as it is: checking in again is a new time, never a second
    arrival, and the check-out's undo is what takes it off (T496).
    """
    market_id, checked_in_by = recorder.market_id, recorder.actor
    refused = _not_a_vendors_day(market_id, vendor_email, date)
    if refused:
        return refused

    market_doc = markets_collection.find_one(live({"id": market_id}))
    closed = _closed_door(market_doc)
    if closed:
        return closed

    target_email = normalized_email(vendor_email)
    target_date = date.strip()
    seat = seat_on(market_doc, target_email, target_date)
    if seat is None:
        return {"error": "No assignment found for this vendor on this date"}, 404
    if not day_has_begun(target_date):
        return {"error": NOT_BEGUN}, 409

    checked_in_at = datetime.now(timezone.utc).isoformat()
    vendor_day = {"market_id": market_id, "vendor_email": target_email, "date": target_date}
    check_in = {"$set": {
        **vendor_day,
        "table_code": seat.get("table_code"),
        "checked_in_at": checked_in_at,
        "checked_in_by": checked_in_by,
        "checked_in_via": via,
    }}
    try:
        replaced = _upsert(vendor_day, check_in)
    except DuplicateKeyError:
        # Another check-in of this vendor's day inserted between this upsert's match and its
        # insert, and the unique index refused the second record. Run once more, which lands on
        # the winner's record; a second refusal is not this race, and goes on as the error it is.
        replaced = _upsert(vendor_day, check_in)

    closed = _closed_since(market_id)
    if closed:
        _take_back_a_check_in(vendor_day, checked_in_at, replaced)
        return closed
    # Only a vendor not yet here is a change: checking in again is a new time, not a new arrival.
    if replaced is None:
        _record_door(recorder, vendor_email, target_date, via, History.CHECKED_IN, "checked_in", True)
    return {"message": "Checked in", "checkedInAt": checked_in_at}, 200


def record_check_out(
    recorder: History.Recorder, vendor_email: str, date: str, via: Optional[str] = None,
) -> Tuple[Dict[str, Any], int]:
    """Record that a vendor left on ``recorder``'s market on this date: ``CHECK_OUT_FIELDS`` set on
    the day's record, recorded through ``recorder`` as a check-in is (``_record_door``), with
    ``checked_out_by`` its actor and ``checked_out_via`` the vendor's own way.

    It needs only the record: no seat and no day that has begun, so a vendor here with no table
    that day is checked out too, and the record is the proof they came.

    It answers the check-out the day holds, ``checkedOutAt``, ``checkedOutBy`` and
    ``checkedOutVia`` (``_checked_out``), which Attendance's row shows at once.

    One update, filtered to a day not yet checked out, so two check-outs at once leave one time
    and one "checked out" entry: the second matches nothing, answers the stored check-out, who and
    way included, and writes and records nothing. Where the first was undone before the second
    read that time, the second writes after all, so "Checked out" is never answered with no time.
    A day with no record is 404 ``NO_CHECK_IN``.

    Only in the market's days, on its own read of the phase, and a market archived between that
    read and the write has the three fields unset again, held to the time this call wrote, with no
    entry (``_closed_since``).
    """
    market_id = recorder.market_id
    refused = _not_a_vendors_day(market_id, vendor_email, date)
    if refused:
        return refused

    closed = _closed_door(markets_collection.find_one(live({"id": market_id}), _PHASE_FIELDS))
    if closed:
        return closed

    vendor_day = _vendor_day(market_id, vendor_email, date)
    check_out = {
        "checked_out_at": datetime.now(timezone.utc).isoformat(),
        "checked_out_by": recorder.actor,
        "checked_out_via": via,
    }
    while True:
        # A null matches a missing field: a record made before check-outs is not checked out.
        written = attendance_collection.find_one_and_update(
            {**vendor_day, "checked_out_at": None}, {"$set": check_out})
        if written is not None:
            break
        stored = attendance_collection.find_one(vendor_day)
        if stored is None:
            return {"error": NO_CHECK_IN}, 404
        if stored.get("checked_out_at") is not None:
            return _checked_out(stored), 200
        # The check-out that held the record was undone before this read: the vendor is not
        # checked out, so this one writes after all.

    closed = _closed_since(market_id)
    if closed:
        attendance_collection.update_one(
            {**vendor_day, "checked_out_at": check_out["checked_out_at"]},
            {"$unset": _NO_CHECK_OUT})
        return closed
    _record_door(recorder, vendor_email, date, via, History.CHECKED_OUT, "checked_out", True)
    return _checked_out(check_out), 200


def _checked_out(record: Dict[str, Any]) -> Dict[str, Any]:
    """The answer to a check-out: when the day's record says the vendor left, who checked them
    out (an organizer's address, or None for the vendor's own) and by which way, so a check-out
    made after another organizer's or the vendor's own shows theirs, never the caller's."""
    return {
        "message": "Checked out",
        "checkedOutAt": record["checked_out_at"],
        "checkedOutBy": record.get("checked_out_by"),
        "checkedOutVia": record.get("checked_out_via"),
    }


def undo_check_out(
    recorder: History.Recorder, vendor_email: str, date: str, via: Optional[str] = None,
) -> Tuple[Dict[str, Any], int]:
    """Take a check-out back, on ``recorder``'s market: ``CHECK_OUT_FIELDS`` unset, the check-in
    left as it is, recorded through ``recorder`` (``_record_door``). A day with no check-out, or
    with no record, is 404 ``NO_CHECK_OUT``.

    Only in the market's days, on its own read of the phase, and a market archived between that
    read and the write gets the three fields back, where the day is still not checked out, with no
    entry (``_closed_since``).
    """
    market_id = recorder.market_id
    refused = _not_a_vendors_day(market_id, vendor_email, date)
    if refused:
        return refused

    closed = _closed_door(markets_collection.find_one(live({"id": market_id}), _PHASE_FIELDS))
    if closed:
        return closed

    vendor_day = _vendor_day(market_id, vendor_email, date)
    before = attendance_collection.find_one_and_update(
        {**vendor_day, "checked_out_at": {"$ne": None}}, {"$unset": _NO_CHECK_OUT},
        return_document=ReturnDocument.BEFORE)
    if before is None:
        return {"error": NO_CHECK_OUT}, 404

    closed = _closed_since(market_id)
    if closed:
        attendance_collection.update_one(
            {**vendor_day, "checked_out_at": None},
            {"$set": {field: before.get(field) for field in CHECK_OUT_FIELDS}})
        return closed
    _record_door(recorder, vendor_email, date, via, History.CHECK_OUT_UNDONE, "checked_out", False)
    return {"message": "Check-out undone"}, 200


def _upsert(vendor_day: Dict[str, Any], check_in: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Write the check-in: the record it replaced, or None when it inserted one."""
    return attendance_collection.find_one_and_update(
        vendor_day, check_in, upsert=True, return_document=ReturnDocument.BEFORE)


def _take_back_a_check_in(
    vendor_day: Dict[str, Any], checked_in_at: str, replaced: Optional[Dict[str, Any]],
) -> None:
    """Undo this call's own write, on a market archived since its read: an inserted record deleted,
    an updated one put back to the fields it had. Held to the time this call wrote, so a record
    another call wrote since is left to that call."""
    mine = {**vendor_day, "checked_in_at": checked_in_at}
    if replaced is None:
        attendance_collection.delete_one(mine)
        return
    restored = {key: value for key, value in replaced.items() if key != "_id"}
    gone = {key: "" for key in ("table_code", "checked_in_by", "checked_in_via")
            if key not in replaced}
    attendance_collection.update_one(
        mine, {"$set": restored, **({"$unset": gone} if gone else {})})


def _take_back_a_delete(removed: Dict[str, Any]) -> None:
    """Put back a record this call deleted, on a market archived since its read. A check-in of the
    same day that landed in between holds the day's one record (the unique index), and stands."""
    try:
        attendance_collection.insert_one(removed)
    except DuplicateKeyError:
        pass


def _record_door(
    recorder: History.Recorder, vendor_email: str, date: str, via: Optional[str], kind: str,
    fact: str, became: bool,
) -> None:
    """A check-in, a check-out or the undo of either, by the organizer who made it, through the
    "Check vendors in" row their request asked; or the vendor's own, on their vendor page, through
    the unasked door with no actor beside the vendor it names and ``via`` saying how
    (``VIA_DOOR_CODE``, ``VIA_VENDOR_PAGE``). ``fact`` is the detail's key, ``checked_in`` or
    ``checked_out``, and ``became`` what it became.

    An entry written before the vendor page carries ``via: "check_in_page"``: the public check-in
    page it names asked only an address and a date, and proved no one. The history's readers still
    word it.
    """
    vendor = normalized_email(vendor_email)
    recorder.record(
        kind=kind, vendors=[vendor], subject={"date": date.strip()},
        detail=lambda: {**History.changes({fact: not became}, {fact: became}),
                        **({"via": via} if via else {})},
    )


def attendance_roster(market_doc: Dict[str, Any]) -> Dict[str, Any]:
    """Every vendor the stored assignment places, per market date, where they stand at the door
    (``state``), and every vendor checked in on a date they no longer hold a seat on.

    What the organizer at the door works from (E29/F01/S01). Attendance listed only the vendors who
    had checked in, by email, so with 80 vendors a day nobody could say who was missing (known gap
    3). Read off the same stored rows check-in records against, so the list of who is expected
    where can never disagree with where a vendor is sent.

    Each row carries ``state`` and ``checked_in_table_code``, the table the check-in was made at
    (T318): a vendor checked in and then freed stays listed, ``here_without_seat``, with no table,
    and one seated again elsewhere reads ``here_elsewhere``, never here at a table they never
    reached. A record stored before check-ins kept their table reads as made at the seat held now,
    as it would have been. Seated rows come first on each date, by table; the seatless after them.

    Each row carries the day's check-out beside its check-in (``checked_out_at``,
    ``checked_out_by``, ``checked_out_via``, T496), null when the vendor is not checked out, and
    nothing here reads it: a checked-out vendor's ``state`` and place in the order are as before.

    Each row names the vendor as every screen does (``vendor_name``, the name they chose, else the
    one on their identification) and carries the one on their identification beside it
    (``vendor_full_name``), so the door's searches find someone who goes by another name by either,
    as Vendors and Payments do (T466).

    Each row carries the vendor's business name too (``vendor_business_name``, ``""`` when they
    have none, T502), as the organizer reads it: the door shows it under their name, since a name
    tag may carry it, and both searches find them by it.
    """
    market_id = market_doc.get("id")
    named = _Named(
        ApplicationsApi.vendor_names_for_market(market_id),
        ApplicationsApi.vendor_full_names_for_market(market_id),
        ApplicationsApi.vendor_business_names_for_market(market_id),
    )
    check_ins = {
        (doc.get("vendor_email"), doc.get("date")): doc
        for doc in attendance_collection.find({"market_id": market_id})
    }
    roster = []
    seated = set()
    for row in _stored_assignment_rows(market_doc):
        email = normalized_email(str(row.get("email", "")))
        date = str(row.get("date", ""))
        seated.add((email, date))
        roster.append(_roster_row(email, date, named, row, check_ins.get((email, date))))
    for (email, date), check_in in check_ins.items():
        if (email, date) not in seated:
            roster.append(_roster_row(email, date, named, None, check_in))
    roster.sort(key=lambda r: (
        r["date"], r["state"] == HERE_WITHOUT_SEAT,
        table_code_sort_key(r["table_code"] or ""), str(r["table_choice"] or ""),
        r["vendor_email"],
    ))

    return convert_keys_to_camel_case({"dates": market_dates_of(market_doc), "roster": roster})


class _Named(NamedTuple):
    """What a market's vendors are called at the door, each keyed by lowercased address: the name
    every screen shows, the one on their identification, and their business name."""
    names: Dict[str, str]
    full_names: Dict[str, str]
    business_names: Dict[str, str]


def _roster_row(
    email: str, date: str, named: _Named,
    seat: Optional[Dict[str, Any]], check_in: Optional[Dict[str, Any]],
) -> Dict[str, Any]:
    """One vendor's day at the door: their seat (or none), their check-in (or none), and the
    state the two make."""
    seat = seat or {}
    check_in = check_in or {}
    held = seat.get("table_code")
    if not check_in:
        state, made_at = EXPECTED, None
    elif not seat:
        state, made_at = HERE_WITHOUT_SEAT, check_in.get("table_code")
    else:
        made_at = check_in.get("table_code") or held
        state = HERE if made_at == held else HERE_ELSEWHERE
    return {
        "date": date,
        "vendor_email": email,
        "vendor_name": named.names.get(email, ""),
        "vendor_full_name": named.full_names.get(email, ""),
        "vendor_business_name": named.business_names.get(email, ""),
        "table_code": held,
        "table_choice": seat.get("table_choice"),
        "section": seat.get("section"),
        "location": seat.get("location"),
        "state": state,
        "checked_in_table_code": made_at,
        "checked_in_at": check_in.get("checked_in_at"),
        "checked_in_by": check_in.get("checked_in_by"),
        "checked_in_via": check_in.get("checked_in_via"),
        **{field: check_in.get(field) for field in CHECK_OUT_FIELDS},
    }


def check_in_counts(market_doc: Dict[str, Any]) -> Dict[str, Any]:
    """How the door stands, in figures only, for the Stats tab's Check-in (T201): per market date,
    the vendors expected and those checked in, and ``came``, the vendors checked in on any date.

    Read as ``attendance_roster`` reads it, off the same stored rows and attendance records, so
    each date's figures are the door's own count of that day (a row each, here or not); but it
    reads no names and holds no row, as the page it serves names nobody.
    """
    here = {
        (doc.get("vendor_email"), doc.get("date"))
        for doc in attendance_collection.find(
            {"market_id": market_doc.get("id")}, {"vendor_email": 1, "date": 1})
    }
    expected: Dict[str, int] = {}
    checked_in: Dict[str, int] = {}
    came = set()
    for row in _stored_assignment_rows(market_doc):
        email = normalized_email(str(row.get("email", "")))
        date = str(row.get("date", ""))
        expected[date] = expected.get(date, 0) + 1
        if (email, date) in here:
            checked_in[date] = checked_in.get(date, 0) + 1
            came.add(email)
    return {
        "dates": [
            {"date": date, "expected": expected.get(date, 0),
             "checkedIn": checked_in.get(date, 0)}
            for date in market_dates_of(market_doc)
        ],
        "came": len(came),
    }


def get_attendance_for_market(market_id: str) -> Tuple[List[Dict[str, Any]], int]:
    """Return all attendance documents for a market in camelCase."""
    records: List[Dict[str, Any]] = []
    for doc in attendance_collection.find({"market_id": market_id}):
        records.append(convert_keys_to_camel_case({
            "market_id": doc.get("market_id"),
            "vendor_email": doc.get("vendor_email"),
            "date": doc.get("date"),
            "checked_in_at": doc.get("checked_in_at"),
        }))
    return records, 200


def market_has_attendance(market_id: str) -> bool:
    """Has anyone checked in at this market? The one proof a market ran (``phase_record``)."""
    return attendance_collection.find_one({"market_id": market_id}) is not None


def delete_attendance_for_market(market_id: str) -> int:
    """Take a market's check-ins with the market (``market_deletion``). Returns how many went."""
    return attendance_collection.delete_many({"market_id": market_id}).deleted_count
