"""A market day's check-outs are added from the organizers' sheet (T504).

On the live market's first market day check-out did not exist in Conventioner yet, so the
organizers kept that day's attendance on a spreadsheet. ``migrations/add_check_outs_from_sheet.py``
is the operator's way to make that day's records say what the sheet says: ``--list`` names the
markets and each date's counts, a dry run matches each sheet row to the day's seats by table code
and, within a shared table, each half to a vendor by name, and prints by table code what a run would
add, leave or report.

These tests run the command as the operator does, on a fixture market, a fixture sheet written into
``tmp_path`` and fixture records, and read what it prints and what the collections hold after. Every
name, table code and address here is made up.
"""
import copy
import csv
from datetime import date as Date

import pytest

from conftest import FakeSlugMarketsCollection, stored_assignment, stored_market

import api.attendance as AttendanceApi
import api.markets as MarketsApi
import api.permissions as PermissionsApi
import db_config as test_db_config
import essential_fields as EF
from add_check_outs_from_sheet import listed, main
from datatypes import MarketPhase
from utils.email_address import normalized_email

MARKET = "market-123"
OTHER = "market-456"
DAY = "2026-08-01"
NEXT_DAY = "2026-08-02"
AT = "2026-08-01T17:00:00-07:00"
ORGANIZER = "owner@example.com"
NOT_AN_ORGANIZER = "viewer@example.com"
DOOR_ORGANIZER = "editor@example.com"
DOOR_CHECK_OUT = "2026-08-01T21:30:00+00:00"
CHECKED_IN = "2026-08-01T16:00:00+00:00"

FULL = "Full Table"
LEFT = "Half Table (Left)"
RIGHT = "Half Table (Right)"

SETUP = {
    "priority": [],
    "marketDates": [{"date": DAY}, {"date": NEXT_DAY}],
    "tiers": [{"id": 1, "name": "Gold"}],
    "locations": [{"name": "Main Hall"}],
    "sections": [{"name": "Upper Hall", "location": {"name": "Main Hall"},
                  "tier": {"id": 1, "name": "Gold"}, "count": 11},
                 {"name": "Lower Hall", "location": {"name": "Main Hall"},
                  "tier": {"id": 1, "name": "Gold"}, "count": 1}],
    "assignmentOptions": {"maxAssignmentsPerVendor": 2, "maxHalfTableProportionPerSection": 50},
}

#: Each vendor of the fixture day: address, the seat on ``DAY`` (table code, table choice, or None
#: for none), business name, the name they go by.
VENDORS = [
    ("ana@example.com", "Upper Hall 1", FULL, "Paper & Pine", ""),
    ("ben@example.com", "Upper Hall 2", LEFT, "Kiln Works", ""),
    ("cy@example.com", "Upper Hall 2", RIGHT, "Fern & Feather", ""),
    ("dee@example.com", "Upper Hall 3", LEFT, "", "Dee Sample"),
    ("eve@example.com", "Upper Hall 3", RIGHT, "Moss Pottery", ""),
    ("fay@example.com", "Upper Hall 4", LEFT, "Clay Corner", ""),
    ("gus@example.com", "Upper Hall 4", RIGHT, "Glass Garden", ""),
    ("hal@example.com", "Upper Hall 5", LEFT, "Honey Hut", ""),
    ("ivy@example.com", "Upper Hall 5", RIGHT, "Ivy Inks", ""),
    ("jo@example.com", "Upper Hall 6", FULL, "Jade Jewels", ""),
    ("kim@example.com", "Upper Hall 7", FULL, "Kite Co", ""),
    ("lou@example.com", "Upper Hall 8", FULL, "Loom Lab", ""),
    ("max@example.com", "Upper Hall 10", FULL, "Map Makers", ""),
    ("ned@example.com", "Upper Hall 11", FULL, "Nest Notes", ""),
    ("oli@example.com", "Lower Hall 1", LEFT, "Oak & Ash", ""),
    ("pia@example.com", "Lower Hall 1", RIGHT, "Pip Prints", ""),
    ("quinn@example.com", None, None, "Quill Things", ""),
]
ADDRESSES = [vendor[0] for vendor in VENDORS]


def a_seat(email, table_code, choice, date=DAY):
    return {"email": email, "date": date, "tableCode": table_code, "tableChoice": choice,
            "section": table_code.rsplit(" ", 1)[0], "tier": "Gold", "location": "Main Hall",
            "handPlaced": True}


def the_seats():
    seats = [a_seat(email, code, choice) for email, code, choice, _b, _p in VENDORS if code]
    # A seat on the market's other date, which the day's matching never reads.
    seats.append(a_seat("ana@example.com", "Upper Hall 9", FULL, date=NEXT_DAY))
    return seats


def a_market(phase=MarketPhase.MARKET_DAYS, market_id=MARKET, seats=None, **overrides):
    fields = dict(id=market_id, name="Spring Fair", setupObject=copy.deepcopy(SETUP),
                  assignmentObject=stored_assignment(
                      "pinned", the_seats() if seats is None else seats))
    fields.update(overrides)
    return stored_market(phase, **fields)


def the_applications(market_id=MARKET):
    docs = []
    for email, _code, _choice, business, preferred in VENDORS:
        answers = {EF.FULL_NAME_KEY: f"Vendor {email.split('@')[0]}"}
        if business:
            answers[EF.BUSINESS_NAME_KEY] = business
        if preferred:
            answers[EF.PREFERRED_NAME_KEY] = preferred
        docs.append({"id": f"app-{email.split('@')[0]}", "market_id": market_id,
                     "applicant_email": email, "form_data": answers, "status": "approved",
                     "application_type": "main", "submitted_at": "2026-06-01T09:00:00+00:00"})
    return docs


def a_check_in(email, table_code=None, out_at=None, out_by=None, date=DAY, market_id=MARKET):
    record = {"market_id": market_id, "vendor_email": email, "date": date,
              "checked_in_at": CHECKED_IN, "checked_in_by": ORGANIZER, "checked_in_via": None,
              "table_code": table_code}
    if out_at:
        record.update(checked_out_at=out_at, checked_out_by=out_by, checked_out_via=None)
    return record


def the_attendance():
    return [
        a_check_in("ana@example.com", "Upper Hall 1"),
        a_check_in("ben@example.com", "Upper Hall 2"),
        a_check_in("cy@example.com", "Upper Hall 2"),
        a_check_in("dee@example.com", "Upper Hall 3", out_at=DOOR_CHECK_OUT,
                   out_by=DOOR_ORGANIZER),
        a_check_in("fay@example.com", "Upper Hall 4"),
        a_check_in("gus@example.com", "Upper Hall 4"),
        a_check_in("hal@example.com", "Upper Hall 5"),
        a_check_in("ivy@example.com", "Upper Hall 5"),
        a_check_in("kim@example.com", "Upper Hall 7"),
        a_check_in("lou@example.com", "Upper Hall 8"),
        a_check_in("max@example.com", "Upper Hall 10", out_at=DOOR_CHECK_OUT,
                   out_by=DOOR_ORGANIZER),
        a_check_in("oli@example.com", "Lower Hall 1"),
        a_check_in("quinn@example.com"),
        # The other date's, which the day never reads, and another market's.
        a_check_in("ana@example.com", "Upper Hall 9", date=NEXT_DAY),
        a_check_in("ana@example.com", "Upper Hall 1", market_id=OTHER),
    ]


def a_half(business="", preferred="", checked_in=False, checked_out=False):
    tick = {True: "TRUE", False: "FALSE"}
    return [business, preferred, tick[checked_in], tick[checked_in], tick[checked_out],
            tick[checked_out]]


NO_HALF = ["", "", "", "", "", ""]


def a_row(table_code, first, second=None, location="Main Hall"):
    return [table_code, location, *first, *(second or NO_HALF)]


def the_rows():
    """The fixture day's sheet, one row per table, as the organizers kept it."""
    return [
        # A full table, both halves the one vendor, its code in other capitals and spaces.
        a_row("upper  hall 1", a_half("Paper & Pine", checked_in=True, checked_out=True),
              a_half("paper and pine")),
        # A shared table matched by name across case, spaces and punctuation, the halves swapped.
        a_row("Upper Hall 2", a_half("fern and feather!", checked_in=True),
              a_half("KILN  works", checked_in=True, checked_out=True)),
        # One half by the name they go by, the other by elimination.
        a_row("Upper Hall 3", a_half("Dee's Stall", "dee  sample", True, True),
              a_half("Mos Pottery", checked_in=True, checked_out=True)),
        # No name matches, and the halves tick alike.
        a_row("Upper Hall 4", a_half("Studio One", checked_in=True, checked_out=True),
              a_half("Studio Two", checked_in=True, checked_out=True)),
        # No name matches, and the halves tick differently.
        a_row("Upper Hall 5", a_half("Bee Shop", checked_in=True, checked_out=True),
              a_half("Ink Spot", checked_in=True)),
        a_row("Upper Hall 6", a_half("Jade Jewels")),
        a_row("Upper Hall 7", a_half("Kite Co")),
        a_row("Upper Hall 8", a_half("Loom Lab", checked_out=True)),
        # A table code no seat holds that day.
        a_row("Upper Hall 9", a_half("Ghost Goods", checked_in=True, checked_out=True)),
        a_row("Upper Hall 10", a_half("Map Makers", checked_in=True)),
        # One half by name, the other half ticked with no name; Upper Hall 11 is not on the sheet.
        a_row("Lower Hall 1", a_half("Oak and Ash", checked_in=True, checked_out=True),
              ["", "", "", "", "TRUE", ""]),
        # A trailing blank line of the export.
        [""] * 14,
    ]


HEADER = [["Spring Fair attendance"], ["Day 1"], [""],
          ["", "", "First vendor", "", "", "", "", "", "Second vendor"],
          ["Table", "Location", "Business name", "Preferred name", "Checked in", "Lanyard",
           "Checked out", "Lanyard returned", "Business name", "Preferred name", "Checked in",
           "Lanyard", "Checked out", "Lanyard returned"]]


@pytest.fixture
def sheet(tmp_path):
    """Write a sheet as the organizers' CSV export: five header lines, then the rows."""
    def write(rows=None, header=HEADER, name="sheet.csv", encoding="utf-8"):
        path = tmp_path / name
        with open(path, "w", newline="", encoding=encoding) as out:
            writer = csv.writer(out)
            writer.writerows(header)
            writer.writerows(the_rows() if rows is None else rows)
        return str(path)
    return write


class Database:
    """The collections the script reads: the markets, applications, attendance and history the
    modules read and write."""

    def __init__(self, markets, applications, attendance, history):
        self.collections = {"markets": markets, "applications": applications,
                            "attendance": attendance, "history": history}

    def __getitem__(self, name):
        return self.collections[name]

    @property
    def markets(self):
        return self.collections["markets"]


@pytest.fixture
def database(monkeypatch, applications, market_records):
    def make(*docs, apps=None, attendance=None):
        markets = FakeSlugMarketsCollection(list(docs))
        monkeypatch.setattr(MarketsApi, "markets_collection", markets)
        applications.documents = copy.deepcopy(the_applications() if apps is None else apps)
        market_records.attendance.documents = copy.deepcopy(
            the_attendance() if attendance is None else attendance)
        db = Database(markets, applications, market_records.attendance, market_records.history)
        monkeypatch.setattr(test_db_config, "get_database", lambda *_a, **_kw: db)
        return db
    # Only the fixture organizer may check vendors in: the real row asks, through the real
    # ``Actions.ask``, whether they hold its role.
    monkeypatch.setattr(PermissionsApi, "user_has_permission",
                        lambda email, *_a, **_k: normalized_email(email) == ORGANIZER)
    monkeypatch.setattr(AttendanceApi, "today", lambda: Date(2026, 11, 24))
    return make


def everything(db):
    return copy.deepcopy([db[name].documents if name != "markets" else db[name].docs
                          for name in ("markets", "applications", "attendance", "history")])


def dry_run(sheet_path, market=MARKET, day=DAY, at=AT, by=ORGANIZER, dry=True):
    argv = ["--market", market, "--day", day, "--sheet", sheet_path, "--checked-out-at", at,
            "--by", by]
    return main(argv + (["--dry-run"] if dry else []))


def lines_of(out):
    return [line for line in out.splitlines() if line.strip()]


# --- the listing ------------------------------------------------------------------------------

def test_the_listing_counts_each_dates_seats_check_ins_and_check_outs(database, capsys):
    db = database(a_market(),
                  a_market(MarketPhase.ARCHIVED, market_id=OTHER, name="Winter Fair",
                           seats=[a_seat("ana@example.com", "Upper Hall 1", FULL)]),
                  a_market(MarketPhase.ASSIGNMENT, market_id="market-789", name="Not Yet"))
    before = everything(db)

    assert main(["--list"]) == 0

    out = capsys.readouterr().out
    assert everything(db) == before
    assert lines_of(out) == [
        'market market-123 "Spring Fair" (phase market_days)',
        f"  - {DAY}: 16 seat(s), 13 check-in(s), 2 check-out(s)",
        f"  - {NEXT_DAY}: 1 seat(s), 1 check-in(s), 0 check-out(s)",
        'market market-456 "Winter Fair" (phase archived)',
        f"  - {DAY}: 1 seat(s), 1 check-in(s), 0 check-out(s)",
        f"  - {NEXT_DAY}: 0 seat(s), 0 check-in(s), 0 check-out(s)",
        "listed 2 market(s): nothing written.",
    ]


def test_the_listing_leaves_out_a_market_being_deleted(database, capsys):
    database(a_market(), a_market(market_id=OTHER, deleting={
        "at": "2026-08-03T00:00:00+00:00", "by": "user-1", "trail_id": "t-1"}))

    listed()

    out = capsys.readouterr().out
    assert OTHER not in out
    assert out.rstrip().endswith("listed 1 market(s): nothing written.")


def test_the_listing_names_no_vendor(database, capsys):
    database(a_market())

    listed()

    out = capsys.readouterr().out
    for email, _code, _choice, business, preferred in VENDORS:
        assert email not in out
        assert not business or business not in out
        assert not preferred or preferred not in out


# --- the command --------------------------------------------------------------------------------

@pytest.mark.parametrize("argv", [
    [],
    ["--list", "--market", MARKET],
    ["--list", "--dry-run"],
    ["--market", MARKET, "--day", DAY, "--sheet", "s.csv", "--checked-out-at", AT, "--dry-run"],
    ["--market", MARKET, "--day", DAY, "--sheet", "s.csv", "--by", ORGANIZER, "--dry-run"],
    ["--market", MARKET, "--day", DAY, "--sheet", "s.csv", "--checked-out-at", AT, "--by"],
    ["--market", MARKET, "--day", DAY, "--sheet", "s.csv", "--checked-out-at", AT, "--by",
     ORGANIZER, "--dry-run", "--label", "x"],
    ["--market", MARKET, "--day", DAY, "--sheet", "s.csv", "--checked-out-at", AT, "--by",
     ORGANIZER, "extra"],
])
def test_missing_or_extra_arguments_print_the_usage_and_exit_one(database, capsys, argv):
    db = database(a_market())
    before = everything(db)

    assert main(argv) == 1

    assert "usage: add_check_outs_from_sheet.py" in capsys.readouterr().err
    assert everything(db) == before


def test_the_run_is_not_built_yet(database, sheet, capsys):
    db = database(a_market())
    before = everything(db)

    assert dry_run(sheet(), dry=False) == 1

    captured = capsys.readouterr()
    assert "the run is not built yet" in captured.err
    assert captured.out == ""
    assert everything(db) == before


# --- the refusals --------------------------------------------------------------------------------

def refused(capsys, db, before, answer):
    """The refusal's reason, after checking it exited 1 and wrote nothing."""
    assert answer == 1
    captured = capsys.readouterr()
    assert everything(db) == before
    assert captured.out == ""
    assert captured.err.startswith("refused, nothing written: ")
    return captured.err[len("refused, nothing written: "):].strip()


@pytest.mark.parametrize("market", ["market-999", OTHER])
def test_no_live_market_is_refused(database, sheet, capsys, market):
    db = database(a_market(), a_market(market_id=OTHER, deleting={
        "at": "2026-08-03T00:00:00+00:00", "by": "user-1", "trail_id": "t-1"}))
    before = everything(db)

    why = refused(capsys, db, before, dry_run(sheet(), market=market))

    assert why == f"No live market has the id {market!r} (none, or it is being deleted)."


def test_a_market_that_does_not_parse_is_refused(database, sheet, capsys):
    db = database(a_market(roles="not a mapping"))
    before = everything(db)

    why = refused(capsys, db, before, dry_run(sheet()))

    assert why.startswith("The market does not parse")


@pytest.mark.parametrize("phase", [MarketPhase.DRAFT, MarketPhase.APPLICATIONS, MarketPhase.OFFERS,
                                   MarketPhase.ASSIGNMENT])
def test_a_phase_other_than_market_days_or_archived_is_refused(database, sheet, capsys, phase):
    db = database(a_market(phase))
    before = everything(db)

    why = refused(capsys, db, before, dry_run(sheet()))

    assert why == (f"The market is in its {phase.value} phase: only a market in its market days "
                   "or archived has check-outs to add.")


def test_a_day_not_a_market_date_is_refused(database, sheet, capsys):
    db = database(a_market())
    before = everything(db)

    why = refused(capsys, db, before, dry_run(sheet(), day="2026-08-03",
                                              at="2026-08-03T17:00:00-07:00"))

    assert why == f"2026-08-03 is not one of the market's dates ({DAY}, {NEXT_DAY})."


def test_a_day_not_begun_is_refused(database, sheet, capsys, monkeypatch):
    db = database(a_market())
    before = everything(db)
    monkeypatch.setattr(AttendanceApi, "today", lambda: Date(2026, 7, 30))

    why = refused(capsys, db, before, dry_run(sheet(), day=NEXT_DAY,
                                              at="2026-08-02T17:00:00-07:00"))

    assert why == f"{NEXT_DAY} has not begun yet."


@pytest.mark.parametrize("at, reason", [
    ("five pm", "--checked-out-at is not an ISO 8601 time."),
    ("2026-08-01T17:00:00", "--checked-out-at has no UTC offset: give one, as -07:00."),
    ("2026-08-02T01:00:00+00:00", "--checked-out-at is on 2026-08-02 in its own offset, not on "
                                  f"the day {DAY}."),
])
def test_a_time_with_no_offset_or_on_another_date_is_refused(database, sheet, capsys, at, reason):
    db = database(a_market())
    before = everything(db)

    why = refused(capsys, db, before, dry_run(sheet(), at=at))

    assert why == reason


@pytest.mark.parametrize("phase", [MarketPhase.MARKET_DAYS, MarketPhase.ARCHIVED])
def test_an_address_that_may_not_check_vendors_in_is_refused_and_not_named(
        database, sheet, capsys, phase):
    db = database(a_market(phase))
    before = everything(db)

    why = refused(capsys, db, before, dry_run(sheet(), by=NOT_AN_ORGANIZER))

    assert why == ("the address given to --by may not check vendors in on this market: Only an "
                   "Editor, an Admin or the owner may check vendors in at this market.")
    assert NOT_AN_ORGANIZER not in why


def test_the_address_is_read_in_any_case(database, sheet, capsys):
    database(a_market())

    assert dry_run(sheet(), by="  Owner@Example.COM ") == 0


def test_an_unreadable_sheet_is_refused(database, sheet, capsys, tmp_path):
    db = database(a_market())
    before = everything(db)
    path = tmp_path / "latin.csv"
    path.write_bytes(b"\xff\xfe\x00not utf-8 \xe9\n")

    why = refused(capsys, db, before, dry_run(str(path)))

    assert why == "The sheet cannot be read as UTF-8 CSV."


def test_a_missing_sheet_is_refused(database, capsys, tmp_path):
    db = database(a_market())
    before = everything(db)

    why = refused(capsys, db, before, dry_run(str(tmp_path / "none.csv")))

    assert why == "The sheet cannot be read as UTF-8 CSV."


def test_a_sheet_with_a_byte_order_mark_is_read(database, sheet, capsys):
    database(a_market())

    assert dry_run(sheet(encoding="utf-8-sig")) == 0


def test_a_sheet_of_too_few_header_lines_is_refused(database, sheet, capsys):
    db = database(a_market())
    before = everything(db)

    why = refused(capsys, db, before, dry_run(sheet(rows=[], header=HEADER[:3])))

    assert why == "The sheet has 3 line(s), fewer than its 5 header lines."


def test_a_row_not_of_fourteen_cells_is_refused_by_its_line_alone(database, sheet, capsys):
    db = database(a_market())
    before = everything(db)
    rows = the_rows()
    rows[2] = rows[2][:13]

    why = refused(capsys, db, before, dry_run(sheet(rows=rows)))

    assert why == "Line 8 has 13 cell(s), not 14."
    assert "Upper Hall 3" not in why and "Mos Pottery" not in why


@pytest.mark.parametrize("tick", ["yes", "1", "x"])
def test_a_tick_not_true_false_or_blank_is_refused_by_its_line_alone(
        database, sheet, capsys, tick):
    db = database(a_market())
    before = everything(db)
    rows = the_rows()
    rows[1][12] = tick

    why = refused(capsys, db, before, dry_run(sheet(rows=rows)))

    assert why == "Line 7, column 13: a tick is not TRUE, FALSE or blank."
    assert "KILN" not in why


def test_a_tick_in_any_capitals_is_read(database, sheet, capsys):
    database(a_market())
    rows = the_rows()
    rows[0][4], rows[0][6] = "true", " True "

    assert dry_run(sheet(rows=rows)) == 0

    assert "  Upper Hall 1, whole table: add a check-out" in capsys.readouterr().out


def test_two_rows_sharing_a_table_code_are_refused(database, sheet, capsys):
    db = database(a_market())
    before = everything(db)
    rows = the_rows()
    rows.insert(5, a_row("UPPER HALL 2 ", a_half("Twice")))

    why = refused(capsys, db, before, dry_run(sheet(rows=rows)))

    assert why == "Lines 7 and 11 share a table code."


def test_every_refusal_names_no_address(database, sheet, capsys):
    database(a_market())
    rows = the_rows()
    rows[0][4] = "maybe"
    answers = [dry_run(sheet(), by=NOT_AN_ORGANIZER), dry_run(sheet(rows=rows)),
               dry_run(sheet(), at="2026-08-01T17:00:00")]

    captured = capsys.readouterr()
    assert answers == [1, 1, 1]
    for address in [*ADDRESSES, ORGANIZER, NOT_AN_ORGANIZER]:
        assert address not in captured.err + captured.out


# --- the dry run ---------------------------------------------------------------------------------

#: What the fixture day's dry run prints, row by row.
THE_DRY_RUN = [
    f'market market-123 "Spring Fair", {DAY}, each check-out at {AT} '
    "(dry run: nothing is written)",
    '  Lower Hall 1, left half: add a check-out (by name)',
    '  Lower Hall 1: unmatched, a half ticked with no name (sheet "Oak and Ash")',
    '  Lower Hall 1, right half: not on the sheet, left',
    '  Upper Hall 1, whole table: add a check-out (the table\'s one seat: sheet "Paper & Pine", '
    'Conventioner "Paper & Pine")',
    '  Upper Hall 2, right half: leave: here, not checked out, as the sheet says (by name)',
    '  Upper Hall 2, left half: add a check-out (by name)',
    f'  Upper Hall 3, left half: leave: already checked out at {DOOR_CHECK_OUT} (by name)',
    '  Upper Hall 3, right half: report: the sheet ticks a check-in Conventioner does not hold, '
    'not written (by elimination: sheet "Mos Pottery", Conventioner "Moss Pottery")',
    '  Upper Hall 4, left half: add a check-out (both halves tick alike: sheet "Studio One", '
    'Conventioner "Clay Corner")',
    '  Upper Hall 4, right half: add a check-out (both halves tick alike: sheet "Studio Two", '
    'Conventioner "Glass Garden")',
    '  Upper Hall 5: unmatched, the halves cannot be told apart and tick differently '
    '(sheet "Bee Shop", "Ink Spot")',
    '  Upper Hall 6, whole table: leave: not checked in, as the sheet says (the table\'s one '
    'seat: sheet "Jade Jewels", Conventioner "Jade Jewels")',
    '  Upper Hall 7, whole table: report: checked in at Conventioner, the sheet ticks no '
    'check-in, left (the table\'s one seat: sheet "Kite Co", Conventioner "Kite Co")',
    '  Upper Hall 8, whole table: report: the sheet ticks a check-out with no check-in, not '
    'written (the table\'s one seat: sheet "Loom Lab", Conventioner "Loom Lab")',
    '  Upper Hall 9: unmatched, no seat holds this table that day (sheet "Ghost Goods")',
    '  Upper Hall 10, whole table: report: Conventioner holds a check-out the sheet does not '
    'tick, left (the table\'s one seat: sheet "Map Makers", Conventioner "Map Makers")',
    "not on the sheet:",
    "  Upper Hall 11, whole table: not on the sheet, left",
    "  a check-in with no seat that day: not on the sheet, left",
    "would add 5, left 6, reported 4, unmatched 4, changed since the read 0",
    "would add 5 check-out(s).",
]


def test_the_dry_run_prints_by_table_code_what_a_run_would_do(database, sheet, capsys):
    database(a_market())

    assert dry_run(sheet()) == 0

    assert lines_of(capsys.readouterr().out) == THE_DRY_RUN


def test_a_dry_run_writes_nothing(database, sheet, capsys):
    db = database(a_market())
    before = everything(db)

    assert dry_run(sheet()) == 0

    assert everything(db) == before


def test_an_archived_market_is_judged_as_one_in_its_market_days(database, sheet, capsys):
    database(a_market(MarketPhase.ARCHIVED))

    assert dry_run(sheet()) == 0

    assert lines_of(capsys.readouterr().out) == THE_DRY_RUN


def test_no_output_prints_an_address(database, sheet, capsys):
    database(a_market())

    dry_run(sheet())
    listed()

    captured = capsys.readouterr()
    for address in [*ADDRESSES, ORGANIZER, DOOR_ORGANIZER]:
        assert address not in captured.out + captured.err


def test_only_a_match_not_made_by_name_prints_a_vendors_name(database, sheet, capsys):
    database(a_market())

    dry_run(sheet())

    out = capsys.readouterr().out
    # The vendors matched by name, the ones left off the sheet and the one with no seat.
    for name in ("Kiln Works", "Fern & Feather", "Dee Sample", "Oak & Ash", "Pip Prints",
                 "Nest Notes", "Quill Things", "Honey Hut", "Ivy Inks", "Vendor"):
        assert name not in out
    named = [line for line in lines_of(out) if "Conventioner \"" in line]
    assert all(("the table's one seat" in line or "by elimination" in line
                or "both halves tick alike" in line) for line in named)
    assert len(named) == 8


# --- matching, rule by rule --------------------------------------------------------------------

def one_row_dry_run(database, sheet, capsys, rows, seats, attendance=(), apps=None):
    """The dry run's row lines alone, on a day of ``seats`` and a sheet of ``rows``."""
    database(a_market(seats=seats), attendance=list(attendance), apps=apps)
    assert dry_run(sheet(rows=rows)) == 0
    out = lines_of(capsys.readouterr().out)
    return out[1:out.index(next(line for line in out if line.startswith("would add ")))]


def test_a_full_table_is_one_vendor_ticked_in_either_half(database, sheet, capsys):
    rows = [a_row("Upper Hall 1", a_half("Paper & Pine", checked_in=True),
                  a_half("PAPER AND PINE", checked_out=True))]

    lines = one_row_dry_run(database, sheet, capsys, rows,
                            [a_seat("ana@example.com", "Upper Hall 1", FULL)],
                            [a_check_in("ana@example.com", "Upper Hall 1")])

    assert lines == ['  Upper Hall 1, whole table: add a check-out (the table\'s one seat: '
                     'sheet "Paper & Pine", Conventioner "Paper & Pine")']


def test_a_full_table_by_its_preferred_names_when_no_business_name_is_given(
        database, sheet, capsys):
    rows = [a_row("Upper Hall 1", a_half("", "Dee Sample", True, True),
                  a_half("", "dee sample"))]

    lines = one_row_dry_run(database, sheet, capsys, rows,
                            [a_seat("dee@example.com", "Upper Hall 1", FULL)],
                            [a_check_in("dee@example.com", "Upper Hall 1")])

    assert lines == ['  Upper Hall 1, whole table: add a check-out (the table\'s one seat: '
                     'sheet "Dee Sample", Conventioner "Dee Sample")']


def test_a_shared_table_is_matched_by_business_name_across_case_spaces_and_punctuation(
        database, sheet, capsys):
    rows = [a_row("Upper Hall 2", a_half(" kiln-works ", checked_in=True, checked_out=True),
                  a_half("FERN AND  FEATHER.", checked_in=True))]

    lines = one_row_dry_run(database, sheet, capsys, rows, [
        a_seat("cy@example.com", "Upper Hall 2", RIGHT),
        a_seat("ben@example.com", "Upper Hall 2", LEFT)], [
        a_check_in("ben@example.com"), a_check_in("cy@example.com")])

    assert lines == [
        "  Upper Hall 2, left half: add a check-out (by name)",
        "  Upper Hall 2, right half: leave: here, not checked out, as the sheet says (by name)",
    ]


def test_a_shared_table_is_matched_by_the_name_on_their_identification(
        database, sheet, capsys):
    rows = [a_row("Upper Hall 2", a_half("", "Vendor Ben", True, True),
                  a_half("", "Vendor Cy", True))]

    lines = one_row_dry_run(database, sheet, capsys, rows, [
        a_seat("ben@example.com", "Upper Hall 2", LEFT),
        a_seat("cy@example.com", "Upper Hall 2", RIGHT)], [
        a_check_in("ben@example.com"), a_check_in("cy@example.com")])

    assert lines == [
        "  Upper Hall 2, left half: add a check-out (by name)",
        "  Upper Hall 2, right half: leave: here, not checked out, as the sheet says (by name)",
    ]


def test_one_half_by_name_gives_the_other_half_the_tables_other_vendor(
        database, sheet, capsys):
    rows = [a_row("Upper Hall 3", a_half("Moss Pottery", checked_in=True),
                  a_half("Dee's Stall", checked_in=True, checked_out=True))]

    lines = one_row_dry_run(database, sheet, capsys, rows, [
        a_seat("dee@example.com", "Upper Hall 3", LEFT),
        a_seat("eve@example.com", "Upper Hall 3", RIGHT)], [
        a_check_in("dee@example.com"), a_check_in("eve@example.com")])

    assert lines == [
        "  Upper Hall 3, right half: leave: here, not checked out, as the sheet says (by name)",
        '  Upper Hall 3, left half: add a check-out (by elimination: sheet "Dee\'s Stall", '
        'Conventioner "Dee Sample")',
    ]


def test_halves_with_no_name_match_ticking_alike_are_matched_in_table_choice_order(
        database, sheet, capsys):
    rows = [a_row("Upper Hall 4", a_half("Studio One", checked_in=True, checked_out=True),
                  a_half("Studio Two", checked_in=True, checked_out=True))]

    lines = one_row_dry_run(database, sheet, capsys, rows, [
        a_seat("gus@example.com", "Upper Hall 4", RIGHT),
        a_seat("fay@example.com", "Upper Hall 4", LEFT)], [
        a_check_in("fay@example.com"), a_check_in("gus@example.com")])

    assert lines == [
        '  Upper Hall 4, left half: add a check-out (both halves tick alike: sheet "Studio One", '
        'Conventioner "Clay Corner")',
        '  Upper Hall 4, right half: add a check-out (both halves tick alike: sheet "Studio Two", '
        'Conventioner "Glass Garden")',
    ]


def test_halves_that_cannot_be_told_apart_and_tick_differently_are_unmatched(
        database, sheet, capsys):
    rows = [a_row("Upper Hall 5", a_half("Bee Shop", checked_in=True, checked_out=True),
                  a_half("Ink Spot", checked_in=True))]

    lines = one_row_dry_run(database, sheet, capsys, rows, [
        a_seat("hal@example.com", "Upper Hall 5", LEFT),
        a_seat("ivy@example.com", "Upper Hall 5", RIGHT)], [
        a_check_in("hal@example.com"), a_check_in("ivy@example.com")])

    assert lines == ['  Upper Hall 5: unmatched, the halves cannot be told apart and tick '
                     'differently (sheet "Bee Shop", "Ink Spot")']


def test_a_table_code_no_seat_holds_that_day_is_unmatched(database, sheet, capsys):
    rows = [a_row("Upper Hall 9", a_half("Ghost Goods", checked_in=True, checked_out=True),
                  a_half("Grey Goods"))]

    lines = one_row_dry_run(database, sheet, capsys, rows, [
        a_seat("ana@example.com", "Upper Hall 9", FULL, date=NEXT_DAY)])

    assert lines == ['  Upper Hall 9: unmatched, no seat holds this table that day '
                     '(sheet "Ghost Goods", "Grey Goods")']


def test_a_half_ticked_with_no_name_is_unmatched(database, sheet, capsys):
    rows = [a_row("Upper Hall 1", NO_HALF, ["", "", "TRUE", "", "", ""])]

    lines = one_row_dry_run(database, sheet, capsys, rows, [
        a_seat("ana@example.com", "Upper Hall 1", FULL)])

    assert lines == ["  Upper Hall 1: unmatched, a half ticked with no name",
                     "  Upper Hall 1, whole table: not on the sheet, left"]


def test_a_half_with_no_name_that_ticks_nothing_is_no_vendor(database, sheet, capsys):
    rows = [a_row("Upper Hall 1", a_half("Paper & Pine", checked_in=True, checked_out=True))]

    lines = one_row_dry_run(database, sheet, capsys, rows, [
        a_seat("ana@example.com", "Upper Hall 1", FULL)],
        [a_check_in("ana@example.com", "Upper Hall 1")])

    assert len(lines) == 1 and "add a check-out" in lines[0]


def test_a_sheet_vendor_left_with_no_name_match_is_unmatched(database, sheet, capsys):
    # One seat, two sheet vendors: neither the table's one seat nor a pair left to tell apart.
    rows = [a_row("Upper Hall 1", a_half("Studio One", checked_in=True),
                  a_half("Studio Two", checked_in=True))]

    lines = one_row_dry_run(database, sheet, capsys, rows, [
        a_seat("ana@example.com", "Upper Hall 1", FULL)])

    assert lines == [
        '  Upper Hall 1: unmatched, no seat of this table matches its name (sheet "Studio One")',
        '  Upper Hall 1: unmatched, no seat of this table matches its name (sheet "Studio Two")',
        "  Upper Hall 1, whole table: not on the sheet, left",
    ]


def test_a_seat_not_on_the_sheet_and_a_check_in_with_no_seat_are_left(database, sheet, capsys):
    rows = [a_row("Upper Hall 1", a_half("Paper & Pine"))]

    lines = one_row_dry_run(database, sheet, capsys, rows, [
        a_seat("ana@example.com", "Upper Hall 1", FULL),
        a_seat("ned@example.com", "Upper Hall 11", FULL)],
        [a_check_in("quinn@example.com", "Upper Hall 12")])

    assert lines[1:] == [
        "not on the sheet:",
        "  Upper Hall 11, whole table: not on the sheet, left",
        "  a check-in with no seat that day (made at Upper Hall 12): not on the sheet, left",
    ]


# --- what each match does ----------------------------------------------------------------------

CHECKED_IN_NOT_OUT = "in"
CHECKED_OUT = "out"
NO_RECORD = "none"


@pytest.mark.parametrize("ticks_in, ticks_out, record, line, counted", [
    (True, True, CHECKED_IN_NOT_OUT, "add a check-out", "add"),
    (True, True, CHECKED_OUT, f"leave: already checked out at {DOOR_CHECK_OUT}", "left"),
    (True, False, CHECKED_IN_NOT_OUT, "leave: here, not checked out, as the sheet says",
     "left"),
    (True, False, CHECKED_OUT,
     "report: Conventioner holds a check-out the sheet does not tick, left", "reported"),
    (True, True, NO_RECORD,
     "report: the sheet ticks a check-in Conventioner does not hold, not written", "reported"),
    (True, False, NO_RECORD,
     "report: the sheet ticks a check-in Conventioner does not hold, not written", "reported"),
    (False, False, NO_RECORD, "leave: not checked in, as the sheet says", "left"),
    (False, False, CHECKED_IN_NOT_OUT,
     "report: checked in at Conventioner, the sheet ticks no check-in, left", "reported"),
    (False, False, CHECKED_OUT,
     "report: checked in at Conventioner, the sheet ticks no check-in, left", "reported"),
    (False, True, CHECKED_IN_NOT_OUT,
     "report: the sheet ticks a check-out with no check-in, not written", "reported"),
    (False, True, CHECKED_OUT,
     "report: the sheet ticks a check-out with no check-in, not written", "reported"),
    (False, True, NO_RECORD,
     "report: the sheet ticks a check-out with no check-in, not written", "reported"),
])
def test_each_match_reads_its_line_against_the_vendors_record(
        database, sheet, capsys, ticks_in, ticks_out, record, line, counted):
    attendance = {
        CHECKED_IN_NOT_OUT: [a_check_in("ben@example.com")],
        CHECKED_OUT: [a_check_in("ben@example.com", out_at=DOOR_CHECK_OUT,
                                 out_by=DOOR_ORGANIZER)],
        NO_RECORD: [],
    }[record]
    database(a_market(seats=[a_seat("ben@example.com", "Upper Hall 2", LEFT),
                             a_seat("cy@example.com", "Upper Hall 2", RIGHT)]),
             attendance=attendance)
    rows = [a_row("Upper Hall 2", a_half("Kiln Works", checked_in=ticks_in,
                                         checked_out=ticks_out),
                  a_half("Fern & Feather"))]

    assert dry_run(sheet(rows=rows)) == 0

    out = lines_of(capsys.readouterr().out)
    assert f"  Upper Hall 2, left half: {line} (by name)" in out
    # The table's other half, matched by name and never checked in, is left too.
    added, left, reported = {"add": (1, 1, 0), "left": (0, 2, 0), "reported": (0, 1, 1)}[counted]
    assert out[-2] == (f"would add {added}, left {left}, reported {reported}, unmatched 0, "
                       "changed since the read 0")
    assert out[-1] == f"would add {1 if line == 'add a check-out' else 0} check-out(s)."
