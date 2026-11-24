#!/usr/bin/env python3
"""Add one market day's check-outs from the organizers' sheet (T504).

On a market day kept before check-out existed (T496), the organizers ticked who arrived and who
left on a spreadsheet, and Conventioner holds the check-ins alone. This script reads that sheet's
CSV export against the day's seats and attendance records and, for each vendor the sheet ticks as
checked out whom Conventioner holds checked in and not out, adds the check-out an organizer's
check-out at Attendance stores: at the time the operator types, by the organizer address they type.
It never writes a check-in, never removes a record and never changes a check-out it finds.

**It lists first.** ``--list`` reads every live market in its market days or archived and prints its
id, name and phase, then for each of its dates the seats that day, the check-ins and the check-outs.
It writes nothing, prints no vendor's name or address, and says so in its last line.

**A dry run** takes the market's id, the day (``YYYY-MM-DD``), the sheet's CSV, the time to record
as every check-out's (ISO 8601 with its UTC offset) and the organizer address to record them as made
by, and prints by table code what a run would add, leave or report. It writes nothing.

**The sheet** is five header lines, skipped unread, then one row per table of 14 cells: the table
code, its location, then two halves of six, each a vendor's business name, the name they go by, and
four ticks (checked in, lanyard taken, checked out, lanyard returned), each ``TRUE``, ``FALSE`` or
blank in any capitals. A row whose cells are all blank is skipped. A half with no name is no vendor,
and one that ticks anything is reported. A row whose two halves give the same business name (or,
with no business name, the same name they go by) is one vendor at a whole table, ticked where either
half ticks. The lanyards are read for the sheet's shape alone: Conventioner keeps none.

**Matching.** A row's seats are the day's stored placements at its table code, compared with case
folded and spaces collapsed. Names are compared casefolded, "&" read as "and", with every character
that is not a letter or a digit dropped. One sheet vendor at a table of one seat is matched to it
("the table's one seat"). Otherwise each sheet vendor whose business name, or the name they go by,
names exactly one of the row's seats and no other sheet vendor names that seat is matched "by name";
then one sheet vendor and one seat left are matched "by elimination", and two of each left are
matched in table choice order when they tick alike ("both halves tick alike"), since which is which
writes nothing different, and are unmatched when they tick differently. A sheet vendor left is
unmatched, and a seat left is not on the sheet.

**What each match does**, read against the vendor's attendance record that day: ticked in and out
and checked in, not out, adds a check-out; already checked out, or ticked in and not out and here,
or ticked nothing and never checked in, is left; every other disagreement (a check-in or check-out
the sheet ticks that Conventioner does not hold, or one Conventioner holds the sheet does not tick)
is reported and not written. A vendor seated at two tables that day is judged once, on the first
of their lines, when their rows tick alike, their other lines left; when the rows tick differently,
each of their lines is reported and not written. A seat on no row, and a check-in with no seat that
day, are left.

**The run**, the same arguments without ``--dry-run``, prints the dry run's lines and, one vendor
at a time in their order, adds each check-out it said it would: ``checked_out_at`` the time in UTC
as the door stores it, ``checked_out_by`` the organizer address, ``checked_out_via`` none, held to
the day's record not being checked out, so a check-out made at the door is never overwritten. Each
records one "checked out" entry through the organizer's asking of Check vendors in, the entry their
own check-out at Attendance records. A write that finds the record checked out or gone since the
read is left with no entry, its line says so, and the count line counts it as changed since the
read. A second run reads each as already checked out and writes nothing, so it finishes a cut run.

**It refuses**, writing nothing and exiting 1 with "refused, nothing written:" and why, when: no
live market has the id (none, or it is being deleted), or it does not parse; the market is neither
in its market days nor archived; the day is not one of its dates or has not begun; the time is no
ISO 8601 time, has no UTC offset, or is on another date in its own offset; the address may not check
vendors in on the market (an archived market asks it as any market does), naming no address; or the
sheet cannot be read as UTF-8 CSV (a byte order mark accepted), has fewer than its five header
lines, holds a row not of 14 cells or a tick that is not ``TRUE``, ``FALSE`` or blank, or two rows
sharing a table code, each naming the line and never a cell's text.

It prints market ids and names, table codes, counts, and, for a match made other than by name, the
sheet's name for the vendor (its business name, else the name they go by) beside Conventioner's, and
for an unmatched row the sheet's names (the row's business names alone on a row no seat holds and on
a half ticked with no name), so the operator can check them: never an address, a vendor's or the
organizer's. So its output stays on the operator's terminal.

Usage (the production database address passed inline, never from back-end/.env):
    MONGODB_URI='<URI>' python migrations/add_check_outs_from_sheet.py --list
    MONGODB_URI='<URI>' python migrations/add_check_outs_from_sheet.py \\
        --market <market-id> --day <YYYY-MM-DD> --sheet <path to the CSV> \\
        --checked-out-at <ISO 8601 time with its offset> --by <organizer address> --dry-run
    MONGODB_URI='<URI>' python migrations/add_check_outs_from_sheet.py \\
        --market <market-id> --day <YYYY-MM-DD> --sheet <path to the CSV> \\
        --checked-out-at <ISO 8601 time with its offset> --by <organizer address>
"""
import argparse
import csv
import os
import re
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Mapping, NamedTuple, Optional, Set, Tuple

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pydantic import ValidationError  # noqa: E402

import api.applications as ApplicationsApi  # noqa: E402
import api.attendance as AttendanceApi  # noqa: E402
import api.market_actions as Actions  # noqa: E402
import api.markets as MarketsApi  # noqa: E402
import history as History  # noqa: E402
from datatypes import MarketPhase, phase_from_market_document, table_code_sort_key  # noqa: E402
from market_documents import MARKETS_COLLECTION, market_dates_of, market_from_document  # noqa: E402
from tombstone import live  # noqa: E402
from utils.email_address import normalized_email  # noqa: E402

USAGE = ("add_check_outs_from_sheet.py --list\n"
         "       add_check_outs_from_sheet.py --market <market-id> --day <YYYY-MM-DD> "
         "--sheet <path to the CSV>\n"
         "           --checked-out-at <ISO 8601 time with its offset> --by <organizer address> "
         "[--dry-run]")

#: The phases a market's check-outs are added in: its market days, or archived after them.
PHASES = (MarketPhase.MARKET_DAYS, MarketPhase.ARCHIVED)

HEADER_LINES = 5
CELLS = 14
#: A half's cells, after the table code and the location: the business name, the name they go by,
#: checked in, lanyard taken, checked out, lanyard returned.
HALVES = (2, 8)
TICKS = {"TRUE": True, "FALSE": False, "": False}

#: How the line of a seat names it, by its table choice.
SEAT_WORDS = {"Full Table": "whole table", "Half Table (Left)": "left half",
              "Half Table (Right)": "right half"}

ONE_SEAT = "the table's one seat"
BY_NAME = "by name"
BY_ELIMINATION = "by elimination"
ALIKE = "both halves tick alike"

NO_SEAT = "no seat holds this table that day"
NO_NAME = "a half ticked with no name"
APART = "the halves cannot be told apart and tick differently"
NO_MATCH = "no seat of this table matches its name"

ADD = "add a check-out"
HERE = "leave: here, not checked out, as the sheet says"
NOT_IN = "leave: not checked in, as the sheet says"
OUT_UNTICKED = "report: Conventioner holds a check-out the sheet does not tick, left"
IN_NOT_HELD = "report: the sheet ticks a check-in Conventioner does not hold, not written"
IN_UNTICKED = "report: checked in at Conventioner, the sheet ticks no check-in, left"
OUT_WITHOUT_IN = "report: the sheet ticks a check-out with no check-in, not written"
SAME_VENDOR = "leave: the same vendor as at {}, judged there"
SEATS_APART = "report: the vendor's seats that day tick differently, not written"
NOT_ON_THE_SHEET = "not on the sheet, left"
CHECKED_OUT_SINCE = "checked out since the read, left"
GONE_SINCE = "the record is gone since the read, left"

BY_REFUSED = "the address given to --by may not check vendors in on this market"


class Refused(Exception):
    """Why nothing is judged or written."""


class _UsageError(Exception):
    pass


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        raise _UsageError(message)


@dataclass
class SheetVendor:
    """One vendor of a sheet row: a half, or both halves of a whole table."""
    business: str
    preferred: str
    checked_in: bool
    checked_out: bool

    @property
    def name(self) -> str:
        """What the sheet calls them, for the operator to find them by."""
        return self.business or self.preferred


@dataclass
class SheetRow:
    line: int
    table_code: str
    vendors: List[SheetVendor]
    #: Halves with no name that tick something, each reported.
    unnamed: int


class Seat(NamedTuple):
    email: str
    table_code: str
    table_choice: str


@dataclass
class Line:
    """One line of the output, and how it counts."""
    table_code: str
    text: str
    #: ``add``, ``left``, ``reported``, ``unmatched``, or, on a run, ``changed`` since the read.
    counts: str
    many: int = 1
    #: A match's seat, whose vendor an ``add`` writes, and how it matched, as the line shows it.
    seat: Optional[Seat] = None
    how: str = ""


@dataclass
class Judged:
    """What a run on one market's day does, line by line."""
    lines: List[Line] = field(default_factory=list)
    not_on_the_sheet: List[Line] = field(default_factory=list)

    def counted(self, what: str) -> int:
        return sum(line.many for line in self.lines + self.not_on_the_sheet if line.counts == what)


# --- reading the sheet ------------------------------------------------------------------------

def _key(table_code: str) -> str:
    """A table code as compared: case folded, runs of spaces one."""
    return " ".join(str(table_code or "").split()).casefold()


def _name(text: str) -> str:
    """A name as compared: casefolded, "&" read as "and", only letters and digits kept."""
    return re.sub(r"[\W_]", "", str(text or "").casefold().replace("&", "and"))


def _ticks(row: List[str], line: int, columns: range) -> List[bool]:
    ticks = []
    for column in columns:
        value = row[column].strip().upper()
        if value not in TICKS:
            raise Refused(f"Line {line}, column {column + 1}: a tick is not TRUE, FALSE or blank.")
        ticks.append(TICKS[value])
    return ticks


def _one_vendor(first: SheetVendor, second: SheetVendor) -> bool:
    """Whether a row's two halves are one vendor at a whole table: the same business name, or,
    neither giving one, the same name they go by."""
    if first.business or second.business:
        return bool(first.business and second.business
                    and _name(first.business) == _name(second.business))
    return _name(first.preferred) == _name(second.preferred)


def _row(row: List[str], line: int) -> SheetRow:
    vendors: List[SheetVendor] = []
    unnamed = 0
    for start in HALVES:
        business, preferred = row[start].strip(), row[start + 1].strip()
        checked_in, _taken, checked_out, _returned = ticks = _ticks(
            row, line, range(start + 2, start + 6))
        if not business and not preferred:
            unnamed += any(ticks)
            continue
        vendors.append(SheetVendor(business, preferred, checked_in, checked_out))
    if len(vendors) == 2 and _one_vendor(*vendors):
        first, second = vendors
        vendors = [SheetVendor(first.business, first.preferred,
                               first.checked_in or second.checked_in,
                               first.checked_out or second.checked_out)]
    return SheetRow(line, " ".join(row[0].split()), vendors, unnamed)


def read_sheet(path: str) -> List[SheetRow]:
    """The sheet's rows, or ``Refused`` naming the first line that is not of its shape."""
    try:
        with open(path, newline="", encoding="utf-8-sig") as sheet:
            reader = csv.reader(sheet)
            # Each row with the line it ends on, which is the line it is on but in a quoted
            # cell holding a line break.
            read = [(reader.line_num, row) for row in reader]
    except (OSError, UnicodeDecodeError, csv.Error) as error:
        raise Refused("The sheet cannot be read as UTF-8 CSV.") from error
    if len(read) < HEADER_LINES:
        raise Refused(f"The sheet has {len(read)} line(s), fewer than its {HEADER_LINES} header "
                      "lines.")
    rows: List[SheetRow] = []
    seen: Dict[str, int] = {}
    for line, cells in read[HEADER_LINES:]:
        if not any(cell.strip() for cell in cells):
            continue
        if len(cells) != CELLS:
            raise Refused(f"Line {line} has {len(cells)} cell(s), not {CELLS}.")
        row = _row(cells, line)
        key = _key(row.table_code)
        if key and key in seen:
            raise Refused(f"Lines {seen[key]} and {line} share a table code.")
        seen[key] = line
        rows.append(row)
    return rows


# --- matching ------------------------------------------------------------------------------------

class _Names(NamedTuple):
    """What the market's vendors are called, each keyed by lowercased address."""
    business: Dict[str, str]
    names: Dict[str, str]
    full: Dict[str, str]

    def matches(self, vendor: SheetVendor, seat: Seat) -> bool:
        business = _name(vendor.business)
        preferred = _name(vendor.preferred)
        return bool(
            (business and business == _name(self.business.get(seat.email, "")))
            or (preferred and preferred in {
                _name(self.names.get(seat.email, "")), _name(self.full.get(seat.email, ""))}))

    def of(self, seat: Seat) -> str:
        """Conventioner's name for the vendor, for the operator to check a match against."""
        return self.business.get(seat.email) or self.names.get(seat.email) or ""


def _choice_order(seat: Seat) -> Tuple[int, str]:
    order = list(SEAT_WORDS)
    return (order.index(seat.table_choice) if seat.table_choice in order else len(order),
            seat.email)


def _quoted(names: List[str]) -> str:
    return ", ".join(f'"{name}"' for name in names)


def _match(row: SheetRow, seats: List[Seat], names: _Names) -> Tuple[
        List[Tuple[SheetVendor, Seat, str]], List[Tuple[str, List[str], int]], List[Seat]]:
    """The row's matches as (sheet vendor, seat, how), its unmatched as (why, the sheet's names,
    how many), and its seats left."""
    unmatched: List[Tuple[str, List[str], int]] = []
    row_names = [vendor.business for vendor in row.vendors if vendor.business]
    if row.unnamed:
        unmatched.append((NO_NAME, row_names, row.unnamed))
    if not seats:
        if row.vendors:
            unmatched.insert(0, (NO_SEAT, row_names, len(row.vendors)))
        return [], unmatched, []
    if len(row.vendors) == 1 and len(seats) == 1:
        return [(row.vendors[0], seats[0], ONE_SEAT)], unmatched, []

    named = {index: {seat for seat in seats if names.matches(vendor, seat)}
             for index, vendor in enumerate(row.vendors)}
    matched: Dict[int, Tuple[Seat, str]] = {}
    for index, found in named.items():
        if len(found) != 1:
            continue
        [seat] = found
        if not any(seat in others for other, others in named.items() if other != index):
            matched[index] = (seat, BY_NAME)
    taken: Set[Seat] = {seat for seat, _how in matched.values()}
    vendors_left = [index for index in range(len(row.vendors)) if index not in matched]
    seats_left = [seat for seat in seats if seat not in taken]
    if len(vendors_left) == 1 and len(seats_left) == 1:
        matched[vendors_left[0]] = (seats_left[0], BY_ELIMINATION)
        vendors_left, seats_left = [], []
    elif len(vendors_left) == 2 and len(seats_left) == 2:
        first, second = (row.vendors[index] for index in vendors_left)
        if (first.checked_in, first.checked_out) == (second.checked_in, second.checked_out):
            for index, seat in zip(vendors_left, sorted(seats_left, key=_choice_order)):
                matched[index] = (seat, ALIKE)
        else:
            unmatched.insert(0, (APART, [row.vendors[index].name for index in vendors_left], 2))
        vendors_left, seats_left = [], []
    for index in vendors_left:
        unmatched.append((NO_MATCH, [row.vendors[index].name], 1))
    pairs = [(row.vendors[index], *matched[index]) for index in sorted(matched)]
    return pairs, unmatched, seats_left


def _what(vendor: SheetVendor, record: Optional[Mapping[str, Any]]) -> Tuple[str, str]:
    """What a match does, read against the vendor's record that day: its line, and how it counts."""
    checked_out_at = (record or {}).get("checked_out_at")
    if not vendor.checked_in:
        if vendor.checked_out:
            return OUT_WITHOUT_IN, "reported"
        return (IN_UNTICKED, "reported") if record else (NOT_IN, "left")
    if record is None:
        return IN_NOT_HELD, "reported"
    if vendor.checked_out:
        if checked_out_at is not None:
            return f"leave: already checked out at {checked_out_at}", "left"
        return ADD, "add"
    return (OUT_UNTICKED, "reported") if checked_out_at is not None else (HERE, "left")


def _seat_line(seat: Seat, text: str) -> str:
    words = SEAT_WORDS.get(seat.table_choice, str(seat.table_choice or "seat").lower())
    return f"  {seat.table_code}, {words}: {text}"


def judged(document: Mapping[str, Any], day: str, rows: List[SheetRow],
           records: List[Mapping[str, Any]]) -> Judged:
    """What a run on the day does with each sheet row, as read."""
    market_id = str(document.get("id"))
    names = _Names(ApplicationsApi.vendor_business_names_for_market(market_id),
                   ApplicationsApi.vendor_names_for_market(market_id),
                   ApplicationsApi.vendor_full_names_for_market(market_id))
    seats = [Seat(normalized_email(row.get("email")), str(row.get("table_code") or ""),
                  str(row.get("table_choice") or ""))
             for row in AttendanceApi._stored_assignment_rows(dict(document))
             if str(row.get("date", "")) == day]
    by_table: Dict[str, List[Seat]] = {}
    for seat in seats:
        by_table.setdefault(_key(seat.table_code), []).append(seat)
    by_vendor = {normalized_email(record.get("vendor_email")): record for record in records}

    out = Judged()
    on_the_sheet: Set[str] = set()
    read: List[Tuple[str, List[Tuple[SheetVendor, Seat, str]], List[Tuple[str, List[str], int]],
                     List[Seat]]] = []
    for row in rows:
        key = _key(row.table_code)
        on_the_sheet.add(key)
        held = by_table.get(key, [])
        read.append((held[0].table_code if held else row.table_code, *_match(row, held, names)))
    read.sort(key=lambda row: table_code_sort_key(row[0]))

    # A vendor may hold two seats that day: their record is judged once, on the first of their
    # lines, when every one of their rows ticks alike, and reported on each when they differ.
    ticked: Dict[str, Set[Tuple[bool, bool]]] = {}
    first: Dict[str, str] = {}
    for code, pairs, _unmatched, _left in read:
        for vendor, seat, _how in pairs:
            ticked.setdefault(seat.email, set()).add((vendor.checked_in, vendor.checked_out))
            first.setdefault(seat.email, code)
    judged_once: Set[str] = set()

    for code, pairs, unmatched, seats_left in read:
        for vendor, seat, how in pairs:
            if len(ticked[seat.email]) > 1:
                text, counts = SEATS_APART, "reported"
            elif seat.email in judged_once:
                text, counts = SAME_VENDOR.format(first[seat.email]), "left"
            else:
                text, counts = _what(vendor, by_vendor.get(seat.email))
                judged_once.add(seat.email)
            shown = how if how == BY_NAME else (
                f"{how}: sheet {_quoted([vendor.name])}, Conventioner {_quoted([names.of(seat)])}")
            out.lines.append(Line(code, _seat_line(seat, f"{text} ({shown})"), counts,
                                  seat=seat, how=shown))
        for why, sheet_names, many in unmatched:
            shown = f" (sheet {_quoted(sheet_names)})" if sheet_names else ""
            out.lines.append(Line(code, f"  {code}: unmatched, {why}{shown}", "unmatched", many))
        for seat in seats_left:
            out.lines.append(Line(code, _seat_line(seat, NOT_ON_THE_SHEET), "left"))

    seated = {seat.email for seat in seats}
    for seat in sorted(seats, key=lambda seat: (table_code_sort_key(seat.table_code),
                                                _choice_order(seat))):
        if _key(seat.table_code) not in on_the_sheet:
            out.not_on_the_sheet.append(Line(seat.table_code, _seat_line(seat, NOT_ON_THE_SHEET),
                                             "left"))
    for email, record in by_vendor.items():
        if email not in seated:
            made_at = record.get("table_code")
            where = f" (made at {made_at})" if made_at else ""
            out.not_on_the_sheet.append(Line(
                "", f"  a check-in with no seat that day{where}: {NOT_ON_THE_SHEET}", "left"))
    return out


# --- the command ---------------------------------------------------------------------------------

def _database(db):
    if db is None:
        from db_config import get_database
        db = get_database()
    if db[MARKETS_COLLECTION] != MarketsApi.markets_collection:
        raise RuntimeError("add_check_outs_from_sheet reads the markets the markets module reads: "
                           "pass the configured database, or none")
    if db[ApplicationsApi.APPLICATIONS_COLLECTION] != ApplicationsApi.applications_collection:
        raise RuntimeError("add_check_outs_from_sheet reads the applications the applications "
                           "module reads: pass the configured database, or none")
    if db[AttendanceApi.ATTENDANCE_COLLECTION] != AttendanceApi.attendance_collection:
        raise RuntimeError("add_check_outs_from_sheet writes the attendance the attendance module "
                           "writes: pass the configured database, or none")
    if not History.records_in(db):
        raise RuntimeError("add_check_outs_from_sheet records in the history the history module "
                           "writes: pass the configured database, or none")
    return db


def listed(db=None) -> int:
    """Print every live market in its market days or archived, with each date's seats, check-ins
    and check-outs. Read only. How many markets it listed."""
    db = _database(db)
    attendance = db[AttendanceApi.ATTENDANCE_COLLECTION]
    markets = 0
    for document in db[MARKETS_COLLECTION].find(live({})):
        phase = phase_from_market_document(dict(document))
        if phase not in PHASES:
            continue
        markets += 1
        market_id = str(document.get("id"))
        print(f'market {market_id} "{document.get("name")}" (phase {phase.value})')
        rows = AttendanceApi._stored_assignment_rows(dict(document))
        records = list(attendance.find({"market_id": market_id}))
        for day in market_dates_of(dict(document)):
            seats = sum(1 for row in rows if str(row.get("date", "")) == day)
            ins = [record for record in records if record.get("date") == day]
            outs = sum(1 for record in ins if record.get("checked_out_at") is not None)
            print(f"  - {day}: {seats} seat(s), {len(ins)} check-in(s), {outs} check-out(s)")
    print(f"\nlisted {markets} market(s): nothing written.")
    return markets


def _the_market(db, market_id: str, day: str) -> Tuple[Mapping[str, Any], Any]:
    document = db[MARKETS_COLLECTION].find_one(live({"id": market_id}))
    if document is None:
        raise Refused(f"No live market has the id {market_id!r} (none, or it is being deleted).")
    try:
        market = market_from_document(dict(document))
    except ValidationError as error:
        raise Refused(
            f"The market does not parse ({error.error_count()} field(s)); the app cannot read it "
            "either.") from error
    phase = phase_from_market_document(dict(document))
    if phase not in PHASES:
        raise Refused(f"The market is in its {phase.value} phase: only a market in its market "
                      "days or archived has check-outs to add.")
    dates = market_dates_of(dict(document))
    if day not in dates:
        raise Refused(f"{day} is not one of the market's dates ({', '.join(dates)}).")
    if not AttendanceApi.day_has_begun(day):
        raise Refused(f"{day} has not begun yet.")
    return document, market


def _checked_out_at(at: str, day: str) -> datetime:
    try:
        when = datetime.fromisoformat(at)
    except ValueError as error:
        raise Refused("--checked-out-at is not an ISO 8601 time.") from error
    if when.tzinfo is None or when.utcoffset() is None:
        raise Refused("--checked-out-at has no UTC offset: give one, as -07:00.")
    if when.date().isoformat() != day:
        raise Refused(f"--checked-out-at is on {when.date().isoformat()} in its own offset, not on "
                      f"the day {day}.")
    return when


def _asked(by: str, market) -> Actions.Asked:
    """The organizer's asking of Check vendors in, as the door asks it, or ``Refused`` naming no
    address. An archived market asks it as any market does: the row reads roles, not the phase."""
    organization = MarketsApi._load_organization(market.organization_id)
    asked = Actions.ask(Actions.CHECK_IN, normalized_email(by), market, organization)
    if asked.refused is not None:
        raise Refused(f"{BY_REFUSED}: {asked.refused}")
    return asked


def check_out(market_id: str, day: str, seat: Seat, at: str, asked: Actions.Asked) -> Optional[str]:
    """Add one vendor's check-out as an organizer's at Attendance is stored, held to the day's
    record not being checked out, and record it through ``asked`` as the door does; or, the write
    matching nothing, say what changed since the read, writing and recording nothing."""
    attendance = AttendanceApi.attendance_collection
    vendor_day = {"market_id": market_id, "vendor_email": seat.email, "date": day}
    while True:
        # A null matches a missing field: a record made before check-outs is not checked out.
        written = attendance.update_one(
            {**vendor_day, "checked_out_at": None},
            {"$set": {"checked_out_at": at, "checked_out_by": asked.actor,
                      "checked_out_via": None}})
        if written.matched_count:
            AttendanceApi._record_door(asked, seat.email, day, None, History.CHECKED_OUT,
                                       "checked_out", True)
            return None
        stored = attendance.find_one(vendor_day)
        if stored is None:
            return GONE_SINCE
        if stored.get("checked_out_at") is not None:
            return CHECKED_OUT_SINCE
        # A check-out made and undone at the door between the two: not checked out, so try again.


def migrate(market_id: str, day: str, sheet: str, checked_out_at: str, by: str,
            db=None, dry_run: bool = False) -> Judged:
    """Say what a run adds, leaves or reports on the market's day and, but on a dry run, add each
    check-out it says it adds; or ``Refused``: every refusal is judged before the sheet is matched
    and before any write."""
    db = _database(db)
    document, market = _the_market(db, market_id, day)
    at = _checked_out_at(checked_out_at, day).astimezone(timezone.utc).isoformat()
    asked = _asked(by, market)
    rows = read_sheet(sheet)
    records = list(db[AttendanceApi.ATTENDANCE_COLLECTION].find(
        {"market_id": market_id, "date": day}))
    plan = judged(document, day, rows, records)

    print(f'market {market_id} "{document.get("name")}", {day}, each check-out at '
          f"{checked_out_at}" + (" (dry run: nothing is written)" if dry_run else ""))
    for line in plan.lines:
        if line.counts == "add" and not dry_run:
            changed = check_out(market_id, day, line.seat, at, asked)
            if changed:
                line.text, line.counts = _seat_line(line.seat, f"{changed} ({line.how})"), "changed"
        print(line.text)
    if plan.not_on_the_sheet:
        print("not on the sheet:")
        for line in plan.not_on_the_sheet:
            print(line.text)
    adding = plan.counted("add")
    verb = "would add" if dry_run else "added"
    print(f"\n{verb} {adding}, left {plan.counted('left')}, reported "
          f"{plan.counted('reported')}, unmatched {plan.counted('unmatched')}, changed since the "
          f"read {plan.counted('changed')}")
    print(f"{verb} {adding} check-out(s).")
    return plan


def _parser() -> _Parser:
    parser = _Parser(prog="add_check_outs_from_sheet.py", usage=USAGE, add_help=False)
    parser.add_argument("--list", action="store_true")
    for name in ("--market", "--day", "--sheet", "--checked-out-at", "--by"):
        parser.add_argument(name)
    parser.add_argument("--dry-run", action="store_true")
    return parser


def main(argv: List[str]) -> int:
    try:
        given = _parser().parse_args(argv)
    except _UsageError:
        print(f"usage: {USAGE}", file=sys.stderr)
        return 1
    values = [given.market, given.day, given.sheet, given.checked_out_at, given.by]
    if given.list and not given.dry_run and all(value is None for value in values):
        listed()
        return 0
    if given.list or any(value is None for value in values):
        print(f"usage: {USAGE}", file=sys.stderr)
        return 1
    try:
        migrate(*values, dry_run=given.dry_run)
    except Refused as refusal:
        print(f"refused, nothing written: {refusal}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
