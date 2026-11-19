"""Reading the market's history in Manage market (E40/F01/S03).

Every change, newest first, a page at a time: the newest entries, then older ones on request, and
filtered by who, by the group of the table their action is in, by vendor and by date. A market
with thousands of entries reads its first page as quickly as a market with ten, because the read
asks Mongo for one page and a cursor, never for the whole history.
"""
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from conftest import (
    FakeMarketsCollection, mongo_matches, mongo_project, sessions_load_through_get_user,
    stored_market,
)

import app as app_module
import api.market_actions as Actions
import api.markets as MarketsApi
import api.permissions as PermissionsApi
import api.users as UsersApi
import history as History
from datatypes import MarketRole
from lookup_indexes import LOOKUP_INDEXES

MARKET = "market-123"
START = datetime(2026, 11, 1, 9, 0, tzinfo=timezone.utc)


def _at(minutes: int) -> str:
    return (START + timedelta(minutes=minutes)).isoformat()


class Cursor:
    """A Mongo cursor over a fake's documents: sorted and limited, as the server would hand them
    back, counting how many documents the read was handed."""

    def __init__(self, collection, docs):
        self.collection = collection
        self.docs = docs

    def sort(self, keys):
        self.collection.sorts.append(list(keys))
        for field, direction in reversed(keys):
            self.docs.sort(key=lambda doc: doc.get(field) or "", reverse=direction < 0)
        return self

    def limit(self, count):
        self.collection.limits.append(count)
        self.docs = self.docs[:count]
        return self

    def __iter__(self):
        self.collection.handed += len(self.docs)
        return iter(self.docs)


def _matches(doc, query):
    for key, condition in query.items():
        if key == "$and":
            if not all(_matches(doc, clause) for clause in condition):
                return False
        elif key == "$or":
            if not any(_matches(doc, clause) for clause in condition):
                return False
        elif isinstance(condition, dict) and any(op in condition for op in (
                "$lt", "$lte", "$gt", "$gte")):
            value = doc.get(key)
            if value is None:
                return False
            if "$lt" in condition and not value < condition["$lt"]:
                return False
            if "$lte" in condition and not value <= condition["$lte"]:
                return False
            if "$gt" in condition and not value > condition["$gt"]:
                return False
            if "$gte" in condition and not value >= condition["$gte"]:
                return False
        elif isinstance(doc.get(key), list) and not isinstance(condition, dict):
            if condition not in doc[key]:
                return False
        elif not mongo_matches(doc, {key: condition}):
            return False
    return True


def _projected(doc, projection):
    """Mongo's projection, the exclusion form included, which the shared fake does not model."""
    if projection and all(not value for value in projection.values()):
        return {key: value for key, value in doc.items() if key not in projection}
    return mongo_project(dict(doc), projection)


class PagedHistory:
    """The ``history`` collection, read through a cursor."""

    def __init__(self):
        self.docs = []
        self.sorts = []
        self.limits = []
        self.handed = 0

    def insert_one(self, document):
        self.docs.append(document)

    def update_one(self, query, update, upsert=False):
        """The entry written once under its id: an upsert that only sets on insert, inserting the
        filter's plain fields with it, as the server does."""
        assert set(update) == {"$setOnInsert"} and upsert, "the history writes no other update"
        if not any(_matches(doc, query) for doc in self.docs):
            self.docs.append({**query, **update["$setOnInsert"]})

    def find(self, query, projection=None):
        found = [_projected(doc, projection) for doc in self.docs if _matches(doc, query)]
        return Cursor(self, found)

    def distinct(self, field, query):
        return list({doc.get(field) for doc in self.docs if _matches(doc, query)})


@pytest.fixture
def history(monkeypatch):
    fake = PagedHistory()
    monkeypatch.setattr(History, "history_collection", fake)
    monkeypatch.setattr(History, "legacy_placement_collection", PagedHistory())
    return fake


@pytest.fixture
def legacy(monkeypatch):
    fake = PagedHistory()
    monkeypatch.setattr(History, "legacy_placement_collection", fake)
    return fake


def entry(history, minutes, action="give-verdicts", kind="verdict", actor="dana@x.test",
          vendors=(), detail=None, market=MARKET, entry_id=None, subject=None):
    doc = {
        "id": entry_id or f"e-{minutes:05d}",
        "market_id": market,
        "actor": actor,
        "at": _at(minutes),
        "action": action,
        "kind": kind,
        "vendors": list(vendors),
        "subject": subject or {},
        "detail": detail or {"before": {"status": "pending"}, "after": {"status": "approved"}},
    }
    history.docs.append(doc)
    return doc


def ids(entries):
    return [e["id"] for e in entries]


class TestAPage:
    def test_it_is_the_newest_entries_first_and_a_cursor_to_the_rest(self, history):
        for minutes in range(30):
            entry(history, minutes)

        first, after = History.entries_page(MARKET, limit=10)

        assert ids(first) == [f"e-{m:05d}" for m in range(29, 19, -1)]
        assert after

        second, after = History.entries_page(MARKET, before=after, limit=10)
        assert ids(second) == [f"e-{m:05d}" for m in range(19, 9, -1)]

        third, after = History.entries_page(MARKET, before=after, limit=10)
        assert ids(third) == [f"e-{m:05d}" for m in range(9, -1, -1)]
        assert after is None

    def test_entries_written_in_the_same_instant_are_neither_lost_nor_repeated(self, history):
        for n in range(5):
            entry(history, 0, entry_id=f"same-{n}")

        first, after = History.entries_page(MARKET, limit=2)
        second, after = History.entries_page(MARKET, before=after, limit=2)
        third, after = History.entries_page(MARKET, before=after, limit=2)

        assert ids(first) + ids(second) + ids(third) == [f"same-{n}" for n in range(4, -1, -1)]
        assert after is None

    def test_it_reads_one_market_only(self, history):
        entry(history, 1)
        entry(history, 2, market="other-market")

        page, _after = History.entries_page(MARKET)

        assert ids(page) == ["e-00001"]

    def test_an_entry_is_served_whole_but_for_its_storage_keys(self, history):
        entry(history, 1, vendors=["ana@x.test"])

        [served], _after = History.entries_page(MARKET)

        assert set(served) == {"id", "actor", "at", "action", "kind", "vendors", "subject",
                               "detail"}

    def test_a_cursor_that_is_not_one_reads_nothing(self):
        assert History.parse_cursor("not a cursor") is None
        assert History.parse_cursor("") is None
        assert History.parse_cursor(f"{_at(1)}|e-1") == (_at(1), "e-1")


class TestTheFilters:
    def test_who_narrows_to_one_persons_changes(self, history):
        entry(history, 1, actor="dana@x.test")
        entry(history, 2, actor="priya@x.test")

        page, _after = History.entries_page(MARKET, actor="priya@x.test")

        assert ids(page) == ["e-00002"]

    def test_a_group_narrows_to_its_actions(self, history):
        entry(history, 1, action="give-verdicts")
        entry(history, 2, action="assign", kind="placed")
        entry(history, 3, action="change-setup", kind="plan")

        page, _after = History.entries_page(MARKET, actions=["assign"])

        assert ids(page) == ["e-00002"]

    def test_a_group_also_reads_the_kinds_of_another_rows_entries_it_names(self, history):
        """An entry filed under one row but about another group's change: a free's $0 taken back
        is recorded under Assign, the row the seating asked, and undoes a Payments change."""
        entry(history, 1, action="change-owed", kind="owed_set")
        entry(history, 2, action="assign", kind="owed_taken_back")
        entry(history, 3, action="assign", kind="placed")

        page, _after = History.entries_page(
            MARKET, actions=["change-owed"], kinds=[("assign", "owed_taken_back")])

        assert ids(page) == ["e-00002", "e-00001"]

    def test_a_vendor_narrows_to_the_entries_naming_them(self, history):
        entry(history, 1, vendors=["ana@x.test"])
        entry(history, 2, vendors=["ben@x.test", "ana@x.test"])
        entry(history, 3, vendors=["ben@x.test"])
        # A run of the assignment names nobody, so no vendor's list holds it (E40/F01/S04).
        entry(history, 4, action="assign", kind="assigned")

        page, _after = History.entries_page(MARKET, vendor="Ana@X.test")

        assert ids(page) == ["e-00002", "e-00001"]

    def test_a_date_range_keeps_the_entries_inside_it(self, history):
        for minutes in (0, 60, 120, 180):
            entry(history, minutes)

        page, _after = History.entries_page(MARKET, since=_at(60), until=_at(180))

        assert ids(page) == ["e-00120", "e-00060"]

    def test_a_market_day_keeps_that_days_entries_and_those_about_no_one_day(self, history):
        """Allocating tables is about every day, so it shows on whichever day is read (T224)."""
        entry(history, 1, action="assign", kind="placed", subject={"date": "2026-11-19"})
        entry(history, 2, action="assign", kind="freed", subject={"date": "2026-11-20"})
        entry(history, 3, action="assign", kind="assigned")
        entry(history, 4, action="assign", kind="rules")
        entry(history, 5, action="assign", kind="freed", subject={"date": None})

        page, _after = History.entries_page(MARKET, day="2026-11-19")

        assert ids(page) == ["e-00005", "e-00004", "e-00003", "e-00001"]

    def test_a_market_day_is_not_when_the_change_was_made(self, history):
        """A change made on the 19th about the 20th is the 20th's, whatever ``since`` asks."""
        entry(history, 1, action="assign", kind="placed", subject={"date": "2026-11-20"})

        on_its_day, _after = History.entries_page(MARKET, day="2026-11-20")
        on_the_day_it_was_made, _after = History.entries_page(
            MARKET, day=START.date().isoformat())

        assert ids(on_its_day) == ["e-00001"]
        assert on_the_day_it_was_made == []

    def test_a_market_day_holds_from_page_to_page(self, history):
        for minutes in range(20):
            date = "2026-11-19" if minutes % 2 else "2026-11-20"
            entry(history, minutes, action="assign", kind="placed", subject={"date": date})

        first, after = History.entries_page(MARKET, day="2026-11-19", limit=5)
        second, after = History.entries_page(MARKET, day="2026-11-19", before=after, limit=5)

        assert ids(first) + ids(second) == [f"e-{m:05d}" for m in range(19, 0, -2)]
        assert after is None

    def test_the_filters_hold_from_page_to_page(self, history):
        for minutes in range(20):
            entry(history, minutes, actor="dana@x.test" if minutes % 2 else "priya@x.test")

        first, after = History.entries_page(MARKET, actor="dana@x.test", limit=5)
        second, after = History.entries_page(MARKET, actor="dana@x.test", before=after, limit=5)

        assert ids(first) + ids(second) == [f"e-{m:05d}" for m in range(19, 0, -2)]
        assert after is None


class TestTheEntriesNotYetMoved:
    """Until a database runs the move from ``placement_history``, its older placements are read
    from there too, so the market's history does not start where the migration has not run."""

    def test_they_are_read_in_their_place_as_assign_entries(self, history, legacy):
        entry(history, 3)
        legacy.docs.append({
            "id": "old-1", "market_id": MARKET, "actor": "dana@x.test", "at": _at(2),
            "kind": "freed", "vendors": ["ana@x.test"],
            "detail": {"date": "2026-11-18", "table_code": "A1"},
        })
        entry(history, 1)

        page, _after = History.entries_page(MARKET)

        assert ids(page) == ["e-00003", "old-1", "e-00001"]
        old = page[1]
        assert old["action"] == "assign"
        assert old["subject"] == {"date": "2026-11-18", "table_codes": ["A1"]}

    def test_an_entry_in_both_is_read_once(self, history, legacy):
        moved = entry(history, 2, action="assign", kind="freed")
        legacy.docs.append({**moved})
        del legacy.docs[0]["action"]

        page, _after = History.entries_page(MARKET)

        assert ids(page) == [moved["id"]]

    def test_a_vendor_reads_their_own_among_them(self, history, legacy):
        """A vendor's drawer reads the history narrowed to them, the unmoved entries included."""
        for minutes, vendor in ((1, "ana@x.test"), (2, "ben@x.test")):
            legacy.docs.append({
                "id": f"old-{minutes}", "market_id": MARKET, "actor": "dana@x.test",
                "at": _at(minutes), "kind": "freed", "vendors": [vendor], "detail": {},
            })

        page, _after = History.entries_page(MARKET, vendor="Ben@X.test")

        assert ids(page) == ["old-2"]

    def test_a_market_day_reads_their_detail_since_they_have_no_subject(self, history, legacy):
        for minutes, kind, detail in (
                (1, "freed", {"date": "2026-11-19", "table_code": "A1"}),
                (2, "freed", {"date": "2026-11-20", "table_code": "A1"}),
                (3, "assigned", {"placements_written": 4})):
            legacy.docs.append({
                "id": f"old-{minutes}", "market_id": MARKET, "actor": "dana@x.test",
                "at": _at(minutes), "kind": kind, "vendors": [], "detail": detail,
            })

        page, _after = History.entries_page(MARKET, day="2026-11-19")

        assert ids(page) == ["old-3", "old-1"]

    def test_they_are_left_out_of_a_group_that_is_not_the_assignment(self, history, legacy):
        legacy.docs.append({
            "id": "old-1", "market_id": MARKET, "actor": "dana@x.test", "at": _at(2),
            "kind": "freed", "vendors": [], "detail": {},
        })

        page, _after = History.entries_page(MARKET, actions=["give-verdicts"])

        assert page == []


class TestWhoMayBeChosen:
    def test_it_is_every_organizer_who_changed_something_even_before_the_migration(
            self, history, legacy):
        entry(history, 1, actor="dana@x.test")
        entry(history, 2, action="apply", kind="submitted", actor="ana@x.test")
        legacy.docs.append({
            "id": "old-1", "market_id": MARKET, "actor": "priya@x.test", "at": _at(0),
            "kind": "freed", "vendors": [], "detail": {},
        })

        assert History.actors(MARKET) == ["dana@x.test", "priya@x.test"]


class TestThousandsOfEntries:
    def test_a_page_is_twenty_five_entries(self):
        """Enough to fill the box a list stands in; the box, not this, keeps the section short."""
        assert History.PAGE_SIZE == 25

    def test_the_first_page_asks_for_one_page_on_the_index_never_the_whole_history(self, history):
        """5,000 entries: the read asks Mongo for the newest page and one more, sorted on the
        index it is read by, so Mongo walks that many index keys and stops."""
        for minutes in range(5000):
            entry(history, minutes)

        page, after = History.entries_page(MARKET)

        assert len(page) == History.PAGE_SIZE
        assert after
        assert history.limits == [History.PAGE_SIZE + 1]
        assert history.handed == History.PAGE_SIZE + 1
        assert history.sorts == [[("at", -1), ("id", -1)]]
        assert ("market_id", "at", "id") in LOOKUP_INDEXES[History.HISTORY_COLLECTION]

    def test_a_page_is_never_larger_than_the_page_size(self, history):
        for minutes in range(200):
            entry(history, minutes)

        page, _after = History.entries_page(MARKET, limit=10_000)

        assert len(page) == History.PAGE_SIZE


@pytest.fixture
def market(monkeypatch):
    fake = FakeMarketsCollection(stored_market())
    monkeypatch.setattr(MarketsApi, "markets_collection", fake)
    monkeypatch.setattr(MarketsApi.ApplicationsApi, "vendor_names_for_market",
                        lambda _market_id: {"ana@x.test": "Ana Vendor"})
    return fake


def _as(monkeypatch, role):
    monkeypatch.setattr(PermissionsApi, "get_user_market_role", lambda *_a, **_k: role)


class TestTheEndpoint:
    def test_a_viewer_reads_the_first_page_with_what_the_filters_offer(
            self, market, history, monkeypatch):
        _as(monkeypatch, MarketRole.VIEWER)
        entry(history, 1, actor="dana@x.test", vendors=["ana@x.test"])
        entry(history, 2, action="apply", kind="submitted", actor="ana@x.test")
        entry(history, 3, action="check-in", kind="checked_in", actor=None)

        body, status = MarketsApi.get_history(MARKET, "viewer@x.test", {})

        assert status == 200
        assert ids(body["entries"]) == ["e-00003", "e-00002", "e-00001"]
        assert body["next"] is None
        assert body["vendorNames"] == {"ana@x.test": "Ana Vendor"}
        # Who changed something here, organizers only: an applicant's own change is found by
        # their name, and a check-in from the public page has nobody to name.
        assert body["actors"] == ["dana@x.test"]
        groups = {group["group"]: [a["id"] for a in group["actions"]] for group in body["groups"]}
        assert "Reading" not in groups
        assert groups["Applications"] == [
            "import-applications", "give-verdicts", "change-verdicts", "choose-reviewers",
            "apply"]
        assert groups["Assignment"] == ["assign"]

    def test_detail_and_subject_are_served_as_stored(self, market, history, monkeypatch):
        """Their keys are data - a question's key, an application's id - so they are not
        recased the way an entry's own fields are."""
        _as(monkeypatch, MarketRole.VIEWER)
        entry(history, 1, action="give-verdicts", kind="verdicts",
              detail={"before": {"app_one": {"follow_up_owner": None}}, "after": {}})

        body, _status = MarketsApi.get_history(MARKET, "viewer@x.test", {})

        assert body["entries"][0]["detail"] == {
            "before": {"app_one": {"follow_up_owner": None}}, "after": {}}

    def test_the_next_page_is_the_one_after_the_cursor(self, market, history, monkeypatch):
        _as(monkeypatch, MarketRole.VIEWER)
        for minutes in range(History.PAGE_SIZE + 3):
            entry(history, minutes)

        first, _status = MarketsApi.get_history(MARKET, "viewer@x.test", {})
        more, _status = MarketsApi.get_history(
            MARKET, "viewer@x.test", {"before": first["next"]})

        assert len(first["entries"]) == History.PAGE_SIZE
        assert ids(more["entries"]) == ["e-00002", "e-00001", "e-00000"]
        assert more["next"] is None
        # The filters' choices came with the first page; a later one does not ask again.
        assert "actors" not in more

    def test_the_filters_are_read_from_the_request(self, market, history, monkeypatch):
        _as(monkeypatch, MarketRole.VIEWER)
        entry(history, 1, action="assign", kind="placed", actor="dana@x.test",
              vendors=["ana@x.test"])
        entry(history, 2, action="assign", kind="placed", actor="priya@x.test",
              vendors=["ana@x.test"])
        entry(history, 3, action="give-verdicts", actor="dana@x.test", vendors=["ana@x.test"])
        entry(history, 600, action="assign", kind="placed", actor="dana@x.test",
              vendors=["ana@x.test"])

        body, status = MarketsApi.get_history(MARKET, "viewer@x.test", {
            "actor": "dana@x.test", "group": "Assignment", "vendor": "ana@x.test",
            "since": "2026-11-01T09:00:00.000Z", "until": "2026-11-01T10:00:00.000Z",
        })

        assert status == 200
        assert ids(body["entries"]) == ["e-00001"]

    def test_a_market_day_is_read_from_the_request(self, market, history, monkeypatch):
        _as(monkeypatch, MarketRole.VIEWER)
        entry(history, 1, action="assign", kind="placed", subject={"date": "2026-11-19"})
        entry(history, 2, action="assign", kind="placed", subject={"date": "2026-11-20"})
        entry(history, 3, action="assign", kind="assigned")

        body, status = MarketsApi.get_history(MARKET, "viewer@x.test", {
            "group": "Assignment", "day": "2026-11-20",
        })

        assert status == 200
        assert ids(body["entries"]) == ["e-00003", "e-00002"]

    @pytest.mark.parametrize("day", [
        "yesterday", "2026-13-45", "2026-02-30", "20261119", "2026-W47-4", "2026-11-19T09:00:00",
        " 2026-11-19",
    ])
    def test_a_day_that_is_not_a_calendar_day_is_refused(self, market, history, monkeypatch, day):
        _as(monkeypatch, MarketRole.VIEWER)

        body, status = MarketsApi.get_history(MARKET, "viewer@x.test", {"day": day})

        assert status == 400
        assert body["error"] == "The history's dates could not be read."

    def test_payments_reads_a_frees_deduction_taken_back_beside_the_change_it_undoes(
            self, market, history, monkeypatch):
        """T121 rereview-2 note 21: the $0 taken back is filed under Assign, the row the seating
        asked, so it reads under Assignment, and under Payments beside the $0 it undoes."""
        _as(monkeypatch, MarketRole.VIEWER)
        entry(history, 1, action="change-owed", kind="owed_set")
        entry(history, 2, action="assign", kind="owed_taken_back")
        entry(history, 3, action="assign", kind="placed")
        entry(history, 4, action="record-payment", kind=None)

        payments, _status = MarketsApi.get_history(MARKET, "viewer@x.test", {"group": "Payments"})
        assignment, _status = MarketsApi.get_history(
            MARKET, "viewer@x.test", {"group": "Assignment"})

        assert ids(payments["entries"]) == ["e-00004", "e-00002", "e-00001"]
        assert ids(assignment["entries"]) == ["e-00003", "e-00002"]
        # The group's actions stay its own rows, which the screen names each action by.
        groups = {group["group"]: [a["id"] for a in group["actions"]]
                  for group in payments["groups"]}
        assert groups["Payments"] == ["record-payment", "change-owed", "adjust-paid"]

    def test_payments_reads_an_amount_a_run_dropped_beside_the_change_it_undoes(
            self, market, history, monkeypatch):
        """T335: an Admin's amount dropped with a day a run drops is filed under Assign, the row
        the run asked, so it reads under Assignment, and under Payments beside the amount."""
        _as(monkeypatch, MarketRole.VIEWER)
        entry(history, 1, action="change-owed", kind="owed_set")
        entry(history, 2, action="assign", kind="assigned")
        entry(history, 3, action="assign", kind="owed_dropped")

        payments, _status = MarketsApi.get_history(MARKET, "viewer@x.test", {"group": "Payments"})
        assignment, _status = MarketsApi.get_history(
            MARKET, "viewer@x.test", {"group": "Assignment"})

        assert ids(payments["entries"]) == ["e-00003", "e-00001"]
        assert ids(assignment["entries"]) == ["e-00003", "e-00002"]

    @pytest.mark.parametrize("args", [
        {"group": "Not a group"},
        {"group": "Reading"},
        {"since": "yesterday"},
        {"until": "2026-13-45"},
        {"before": "not a cursor"},
    ])
    def test_a_filter_it_cannot_read_is_refused(self, market, history, monkeypatch, args):
        _as(monkeypatch, MarketRole.VIEWER)

        body, status = MarketsApi.get_history(MARKET, "viewer@x.test", args)

        assert status == 400
        assert body["error"]

    def test_a_person_below_the_row_is_refused_in_its_words(self, market, history, monkeypatch):
        _as(monkeypatch, None)
        entry(history, 1)

        body, status = MarketsApi.get_history(MARKET, "stranger@x.test", {})

        assert status == 403
        assert body == {"error": Actions.refusal_sentence(Actions.READ_HISTORY)}

    def test_the_read_asks_the_history_row(self, market, history, monkeypatch):
        asked = []
        monkeypatch.setattr(Actions, "refusal", lambda row, *_a: asked.append(row) or "No.")

        _body, status = MarketsApi.get_history(MARKET, "editor@x.test", {})

        assert status == 403
        assert asked == [Actions.READ_HISTORY]

    def test_a_missing_market_is_not_found(self, history, monkeypatch):
        monkeypatch.setattr(MarketsApi, "markets_collection", FakeMarketsCollection(None))

        _body, status = MarketsApi.get_history("nope", "viewer@x.test", {})

        assert status == 404


ANA, BEN, CY = "ana@x.test", "ben@x.test", "cy@x.test"
NAMES = {ANA: "Ana Vendor", BEN: "Ben Vendor", CY: "Cy Vendor"}


def _selection(history, minutes=1):
    """A selection's verdicts over three vendors, Ben's application dealt to someone else."""
    return entry(
        history, minutes, kind="verdicts", vendors=[ANA, BEN, CY],
        subject={"application_ids": ["a1", "a2", "a3"]},
        detail={
            "before": {"a1": {"status": "pending"}, "a2": {"status": "pending"},
                       "a3": {"status": "pending"}},
            "after": {"a1": {"status": "approved"}, "a2": {"status": "approved"},
                      "a3": {"status": "approved"}},
            "dealt_to": {"a1": "priya@x.test", "a2": "sam@x.test"},
        })


def _deal(history, minutes=2):
    """A deal of two applications among the reviewers, one of them a follow-up handed on."""
    return entry(
        history, minutes, action="choose-reviewers", kind="dealt", vendors=[BEN, ANA],
        subject={"application_ids": ["a2", "a1"]},
        detail={
            "cause": "reviewers_changed",
            "before": {"a2": {"reviewer": None}, "a1": {"reviewer": None}},
            "after": {"a2": {"reviewer": "sam@x.test"},
                      "a1": {"reviewer": "priya@x.test", "follow_up_owner": "priya@x.test"}},
        })


def _check(history, minutes=3):
    """A Discord check whose vendors leave out an application with no address, so they do not
    pair with its ids by position: each address is in the detail by id."""
    return entry(
        history, minutes, action="connect-discord", kind="discord_checked", vendors=[BEN, ANA],
        subject={"application_ids": ["a4", "a2", "a1"]},
        detail={
            "before": {"a4": None, "a2": None, "a1": None},
            "after": {"a4": "not_found", "a2": "in_server", "a1": "has_role"},
            "addresses": {"a4": None, "a2": BEN, "a1": ANA},
            "counts": {"has_role": 1, "in_server": 1, "not_found": 1},
        })


def _roles_given(history, minutes=4):
    return entry(
        history, minutes, action="connect-discord", kind="discord_roles_given",
        vendors=[ANA, CY], subject={"application_ids": ["a1", "a3"]},
        detail={
            "role_name": "Vendor Nov 2026", "given": ["a1", "a3"],
            "before": {"a1": "in_server", "a3": "in_server"},
            "after": {"a1": "has_role", "a3": "has_role"},
            "addresses": {"a1": ANA, "a3": CY},
            "counts": {"given": 2},
        })


def _served(body, entry_id):
    [served] = [each for each in body["entries"] if each["id"] == entry_id]
    return served


class TestOneVendorsOwnPart:
    """What a vendor's drawer reads (T468 review note 1): the entries naming the vendor, each
    many-vendor one narrowed to the vendor's own application, and the names of only the vendors
    those entries still hold, so the server sends no more than the drawer shows."""

    @pytest.fixture(autouse=True)
    def names(self, market, monkeypatch):
        monkeypatch.setattr(MarketsApi.ApplicationsApi, "vendor_names_for_market",
                            lambda _market_id: dict(NAMES))
        _as(monkeypatch, MarketRole.VIEWER)

    def test_a_selections_verdicts_are_narrowed_to_the_vendors_own_application(self, history):
        _selection(history)

        body, status = MarketsApi.get_history(MARKET, "viewer@x.test", {"own": "Ana@X.test"})

        assert status == 200
        served = _served(body, "e-00001")
        assert served["vendors"] == [ANA]
        assert served["subject"] == {"application_ids": ["a1"]}
        assert served["detail"] == {
            "before": {"a1": {"status": "pending"}},
            "after": {"a1": {"status": "approved"}},
            "dealt_to": {"a1": "priya@x.test"},
        }
        # How many the selection decided, so the drawer still says "and 2 others".
        assert served["applicationCount"] == 3
        assert body["vendorNames"] == {ANA: "Ana Vendor"}

    def test_a_deal_is_narrowed_to_the_vendors_own_share(self, history):
        _deal(history)

        body, _status = MarketsApi.get_history(MARKET, "viewer@x.test", {"own": ANA})

        served = _served(body, "e-00002")
        assert served["vendors"] == [ANA]
        assert served["subject"] == {"application_ids": ["a1"]}
        assert served["detail"] == {
            "cause": "reviewers_changed",
            "before": {"a1": {"reviewer": None}},
            "after": {"a1": {"reviewer": "priya@x.test", "follow_up_owner": "priya@x.test"}},
        }
        assert served["applicationCount"] == 2
        assert body["vendorNames"] == {ANA: "Ana Vendor"}

    def test_a_discord_check_is_narrowed_by_the_address_it_holds_for_each_application(
            self, history):
        _check(history)

        body, _status = MarketsApi.get_history(MARKET, "viewer@x.test", {"own": ANA})

        served = _served(body, "e-00003")
        assert served["vendors"] == [ANA]
        assert served["subject"] == {"application_ids": ["a1"]}
        assert served["detail"] == {
            "before": {"a1": None},
            "after": {"a1": "has_role"},
            "addresses": {"a1": ANA},
            # How many the check found in each state names no vendor: it is the check's own.
            "counts": {"has_role": 1, "in_server": 1, "not_found": 1},
        }
        assert served["applicationCount"] == 3

    def test_a_roles_run_is_narrowed_to_whether_the_vendor_was_given_the_role(self, history):
        _roles_given(history)

        body, _status = MarketsApi.get_history(MARKET, "viewer@x.test", {"own": CY})

        served = _served(body, "e-00004")
        assert served["vendors"] == [CY]
        assert served["subject"] == {"application_ids": ["a3"]}
        assert served["detail"]["given"] == ["a3"]
        assert served["detail"]["addresses"] == {"a3": CY}
        assert served["detail"]["role_name"] == "Vendor Nov 2026"
        assert body["vendorNames"] == {CY: "Cy Vendor"}

    def test_only_the_entries_naming_the_vendor_are_read(self, history):
        _selection(history)
        _deal(history)
        entry(history, 5, vendors=[BEN])
        entry(history, 6, action="assign", kind="assigned")

        body, _status = MarketsApi.get_history(MARKET, "viewer@x.test", {"own": CY})

        assert ids(body["entries"]) == ["e-00001"]

    def test_an_entry_about_the_vendor_alone_is_served_whole(self, history):
        alone = entry(history, 1, vendors=[ANA], subject={"application_id": "a1"})

        body, _status = MarketsApi.get_history(MARKET, "viewer@x.test", {"own": ANA})

        [served] = body["entries"]
        assert served["vendors"] == [ANA]
        assert served["subject"] == alone["subject"]
        assert served["detail"] == alone["detail"]
        assert "applicationCount" not in served

    def test_a_swap_keeps_the_vendor_they_traded_with_and_their_name(self, history):
        """Whom they traded seats with is the vendor's own change, not someone else's part."""
        seats = {"date": "2026-11-19", "seats": [{"email": ANA, "table_code": "A1"},
                                                 {"email": BEN, "table_code": "B2"}]}
        entry(history, 1, action="assign", kind="swapped", vendors=[ANA, BEN],
              subject={"date": "2026-11-19"}, detail=seats)

        body, _status = MarketsApi.get_history(MARKET, "viewer@x.test", {"own": ANA})

        [served] = body["entries"]
        assert served["vendors"] == [ANA, BEN]
        assert served["detail"] == seats
        assert body["vendorNames"] == {ANA: "Ana Vendor", BEN: "Ben Vendor"}

    def test_an_entry_whose_vendors_do_not_pair_with_its_applications_is_served_whole(
            self, history):
        """An application with no address is left out of ``vendors``, so a selection holding one
        cannot say which id is the vendor's by position: it is served as stored."""
        stored = entry(history, 1, kind="verdicts", vendors=[ANA, BEN],
                       subject={"application_ids": ["a1", "a2", "a5"]},
                       detail={"before": {}, "after": {}})

        body, _status = MarketsApi.get_history(MARKET, "viewer@x.test", {"own": ANA})

        [served] = body["entries"]
        assert served["vendors"] == stored["vendors"]
        assert served["subject"] == stored["subject"]

    def test_a_later_page_is_narrowed_too(self, history):
        _selection(history, minutes=0)
        for minutes in range(1, History.PAGE_SIZE + 1):
            entry(history, minutes, vendors=[ANA])

        first, _status = MarketsApi.get_history(MARKET, "viewer@x.test", {"own": ANA})
        more, _status = MarketsApi.get_history(
            MARKET, "viewer@x.test", {"own": ANA, "before": first["next"]})

        assert _served(more, "e-00000")["vendors"] == [ANA]
        assert more["vendorNames"] == {ANA: "Ana Vendor"}

    def test_a_vendor_filter_beside_it_is_refused(self, history):
        body, status = MarketsApi.get_history(
            MARKET, "viewer@x.test", {"own": ANA, "vendor": BEN})

        assert status == 400
        assert body["error"]

    def test_the_vendor_filter_still_answers_each_many_vendor_entry_whole(self, history):
        """Manage market's Vendor filter reads the market's own sentences, which name every
        vendor of a selection, a deal or a Discord check: it is answered whole, as before."""
        stored = [_selection(history), _deal(history), _check(history), _roles_given(history)]

        body, _status = MarketsApi.get_history(MARKET, "viewer@x.test", {"vendor": ANA})

        assert ids(body["entries"]) == ["e-00004", "e-00003", "e-00002", "e-00001"]
        for each in stored:
            served = _served(body, each["id"])
            assert served["vendors"] == each["vendors"]
            assert served["subject"] == each["subject"]
            assert served["detail"] == each["detail"]
            assert "applicationCount" not in served
        assert body["vendorNames"] == NAMES

    def test_the_route_reads_it_from_the_request(self, monkeypatch):
        monkeypatch.setattr(app_module.login_manager, "session_protection", None)
        sessions_load_through_get_user(monkeypatch)
        monkeypatch.setattr(UsersApi, "get_user", lambda email: SimpleNamespace(
            id="user-1", email=email, is_active=True, is_authenticated=True,
            is_anonymous=False, get_id=lambda e=email: e))
        asked = []
        monkeypatch.setattr(MarketsApi, "get_history",
                            lambda _market_id, _user, args: (asked.append(args) or {}, 200))
        client = app_module.app.test_client()
        with client.session_transaction() as session:
            session["_user_id"] = "viewer@x.test"
            session["_fresh"] = True

        response = client.get(f"/markets/{MARKET}/history?own=ana%40x.test")

        assert response.status_code == 200
        [args] = asked
        assert args["own"] == ANA and args["vendor"] == ""

    def test_the_whole_history_answers_each_many_vendor_entry_whole(self, history):
        stored = [_selection(history), _deal(history), _check(history), _roles_given(history)]

        body, _status = MarketsApi.get_history(MARKET, "viewer@x.test", {})

        for each in stored:
            served = _served(body, each["id"])
            assert (served["vendors"], served["subject"], served["detail"]) == (
                each["vendors"], each["subject"], each["detail"])
        assert body["vendorNames"] == NAMES


class TestTheRow:
    def test_reading_the_history_is_a_viewers_by_default(self):
        row = Actions.READ_HISTORY
        assert (row.id, row.group, row.label, row.default, row.fixed) == (
            "read-history", "Reading", "Read the market's history", MarketRole.VIEWER, False)

    def test_a_person_with_no_role_is_told_no_by_the_market_read(self):
        refusals = MarketsApi.role_action_refusals(None, MarketsApi.MarketPhase.DRAFT, {})
        viewer = MarketsApi.role_action_refusals(MarketRole.VIEWER, MarketsApi.MarketPhase.DRAFT, {})

        assert refusals["read-history"] == Actions.refusal_sentence(Actions.READ_HISTORY)
        assert viewer["read-history"] is None

    def test_an_archived_market_is_still_read(self):
        refusals = MarketsApi.role_action_refusals(
            MarketRole.VIEWER, MarketsApi.MarketPhase.ARCHIVED, {})

        assert refusals["read-history"] is None
