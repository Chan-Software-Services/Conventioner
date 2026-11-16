"""Every stored owed table-day is given its state, and every hidden Admin's amount is dropped (T335).

T335 stores each ``amounts_owed`` record's state (``set``, ``freed`` or ``freed_waived``; following
the seat is no record) beside the ``freed`` and ``set_by_hand`` the release before reads. A record
stored before has only those, and one a rolled-back release wrote may store a state they disagree
with. The migration derives the state from them, reads it as the day stands in the stored
assignment (a held seat wins over a freed record, T270), stores it, and drops an Admin's amount on a
day the vendor holds no table, recording the market's history entry (Daniel's decision 9.3).
"""
import copy

import pytest

import api.markets as MarketsApi
import api.payments as PaymentsApi
import history as History
import market_write as MarketWrite
import payments as Payments
from conftest import FakeSlugMarketsCollection, stored_assignment, stored_market
from datatypes import MarketPhase
from market_documents import market_from_document
from migrate_owed_day_state import TRIES, migrate
from payments import FollowsSeat, Freed, FreedSeat, FreedWaived, HandAmount, SetByHand
from test_a_vendors_payments import PLAN
from tombstone import new_tombstone

MARKET = "market-owed"
OTHER = "market-other"
ANA = "ana@example.com"
ADMIN = "admin@example.com"
OTHER_ADMIN = "other-admin@example.com"
EDITOR = "editor@example.com"
SAT, SUN = "2099-05-07", "2099-05-08"
AT = "2099-04-01T10:00:00+00:00"
FREED_AT = "2099-04-02T10:00:00+00:00"

#: Ana's Sunday seat as it stood when its table was freed, as the release before kept it.
FREED = {"table_code": "North Wing 2", "tier": "Gold", "table_choice": "Full Table",
         "cents": 3500, "group": None, "by": EDITOR, "at": FREED_AT}
SEAT = FreedSeat(Payments.Seat("North Wing 2", "Gold", "Full Table", 3500, None), EDITOR, FREED_AT)


def by_hand(cents=2000, by=ADMIN):
    return {"cents": cents, "by": by, "at": AT}


def by_free(replaced=None):
    """A free's $0, as the release before stored it, keeping the Admin's amount it replaced."""
    stored = {"cents": 0, "by": EDITOR, "at": FREED_AT, "by_free": True}
    if replaced is not None:
        stored["replaced"] = replaced
    return stored


def a_market(market_id=MARKET, **overrides):
    """A priced market in market days, Ana holding a Gold table on Saturday and none on Sunday."""
    row = {"email": ANA, "date": SAT, "tableCode": "North Wing 1", "tableChoice": "Full Table",
           "section": "North Wing", "tier": "Gold", "location": "Main Hall", "handPlaced": True}
    return stored_market(MarketPhase.MARKET_DAYS, id=market_id, name=f"Market {market_id}",
                         setupObject=copy.deepcopy(PLAN),
                         assignmentObject=stored_assignment("pinned", rows=[row]), **overrides)


class Database:
    """The collections the migration reads and writes, by name, as the configured database's."""

    def __init__(self, collections):
        self.collections = collections

    def __getitem__(self, name):
        return self.collections[name]


@pytest.fixture
def database(monkeypatch, market_records):
    def make(*markets):
        collection = FakeSlugMarketsCollection(list(markets or [a_market()]))
        monkeypatch.setattr(MarketsApi, "markets_collection", collection)
        monkeypatch.setattr(MarketWrite, "markets_collection", collection)
        return Database({"markets": collection, "amounts_owed": market_records.amounts_owed,
                         "history": market_records.history})
    return make


def plant(date, market_id=MARKET, **fields):
    """A record as a release stored it: only the fields given."""
    record = {"market_id": market_id, "vendor_email": ANA, "date": date, **fields}
    Payments.amounts_owed_collection.insert_one(record)
    return record["_id"]


def records(db):
    return db["amounts_owed"].documents


def record(db, record_id):
    return next((doc for doc in records(db) if doc["_id"] == record_id), None)


def entries(db):
    return [entry for entry in db["history"].documents if entry["kind"] == History.OWED_DROPPED]


def line(date, market_id=MARKET):
    """Ana's line for the day, as her Payment tab reads it, or None."""
    market = market_from_document(MarketsApi.markets_collection.find_one({"id": market_id}))
    return next((found for found in PaymentsApi._account(market, ANA)["lines"]
                 if found["date"] == date), None)


def assert_stored(db, record_id, state, revision=1):
    """The record stores ``state``, its mirror as the release before reads it, and ``revision``."""
    doc = record(db, record_id)
    assert doc["state"] == state.to_stored()
    assert {"freed": doc.get("freed"), "set_by_hand": doc.get("set_by_hand")} == \
        Payments.legacy_fields(state)
    assert doc["revision"] == revision
    assert Payments.state_of(doc) == state


# --- each legacy shape, as it reads -----------------------------------------------------------

LEGACY = [
    pytest.param(SAT, {"set_by_hand": by_hand()}, SetByHand(HandAmount(2000, ADMIN, AT)),
                 id="an Admin's amount on a held day is set"),
    pytest.param(SUN, {"freed": FREED}, Freed(SEAT, None),
                 id="a freed line is freed"),
    pytest.param(SUN, {"freed": FREED, "set_by_hand": by_hand()},
                 Freed(SEAT, HandAmount(2000, ADMIN, AT)),
                 id="a freed line with an Admin's amount is freed with it"),
    pytest.param(SUN, {"freed": FREED, "set_by_hand": by_free(replaced=by_hand())},
                 FreedWaived(SEAT, EDITOR, FREED_AT, HandAmount(2000, ADMIN, AT)),
                 id="a free's $0 over an Admin's amount is freed and waived, keeping it"),
    pytest.param(SUN, {"freed": FREED, "set_by_hand": by_free()},
                 FreedWaived(SEAT, EDITOR, FREED_AT, None),
                 id="a free's $0 is freed and waived"),
]


@pytest.mark.parametrize("date, fields, state", LEGACY)
def test_each_legacy_shape_stores_its_state_and_reads_as_it_did(database, date, fields, state):
    db = database()
    record_id = plant(date, **fields)
    before = line(date)

    assert migrate(db) == 1

    assert_stored(db, record_id, state)
    assert line(date) == before
    assert entries(db) == []


STOPPED_FREES = [
    pytest.param({"freed": FREED}, None, id="a freed line alone follows the seat"),
    pytest.param({"freed": FREED, "set_by_hand": by_hand()}, SetByHand(HandAmount(2000, ADMIN, AT)),
                 id="a freed line with an Admin's amount is set to it"),
    pytest.param({"freed": FREED, "set_by_hand": by_free(replaced=by_hand())},
                 SetByHand(HandAmount(2000, ADMIN, AT)),
                 id="a free's $0 over an Admin's amount is set to that amount"),
    pytest.param({"set_by_hand": by_free(replaced=by_hand())},
                 SetByHand(HandAmount(2000, ADMIN, AT)),
                 id="a free's $0 that never freed its seat is set to the amount it replaced"),
    pytest.param({"set_by_hand": by_free()}, None,
                 id="a free's $0 that never freed its seat, over nothing, follows the seat"),
]


@pytest.mark.parametrize("fields, state", STOPPED_FREES)
def test_a_stopped_free_on_a_held_day_reads_as_the_seat(database, fields, state):
    """A held seat wins over a free (T270): a freed record on a day the vendor holds is a free
    that stopped before its seat went, and is stored as seating the day makes it."""
    db = database()
    record_id = plant(SAT, **fields)

    assert migrate(db) == 1

    if state is None:
        assert record(db, record_id) is None
        assert (line(SAT)["owedCents"], line(SAT)["owedSetBy"]) == (3500, None)
    else:
        assert_stored(db, record_id, state)
        assert (line(SAT)["owedCents"], line(SAT)["owedSetBy"]) == (2000, ADMIN)
    assert line(SAT)["freed"] is False
    assert entries(db) == []


@pytest.mark.parametrize("date", [SAT, SUN])
def test_a_record_the_release_before_cleared_is_taken_away(database, date):
    db = database()
    record_id = plant(date, freed=None, set_by_hand=None)

    assert migrate(db) == 1

    assert record(db, record_id) is None
    assert entries(db) == []


# --- an Admin's amount hidden on a day not held -----------------------------------------------

HIDDEN = [
    pytest.param({"set_by_hand": by_hand(0)}, 0, ADMIN, id="an Admin's $0"),
    pytest.param({"set_by_hand": by_hand(2000)}, 2000, ADMIN, id="an Admin's amount"),
    pytest.param({"set_by_hand": by_free(replaced=by_hand(1500, OTHER_ADMIN))}, 1500,
                 OTHER_ADMIN, id="the amount a free's $0 replaced, the seat never freed"),
    pytest.param({"state": SetByHand(HandAmount(2000, ADMIN, AT)).to_stored(),
                  "set_by_hand": by_hand(2000), "revision": 4}, 2000, ADMIN,
                 id="an Admin's amount stored with its state"),
]


@pytest.mark.parametrize("fields, cents, set_by", HIDDEN)
def test_an_admins_amount_on_a_day_not_held_is_dropped_with_its_entry(
        database, fields, cents, set_by):
    """Decision 9.3: no line shows it, so it goes, and the market's history says so, with no actor,
    as the migration's."""
    db = database()
    record_id = plant(SUN, **fields)
    assert line(SUN) is None

    assert migrate(db) == 1

    assert record(db, record_id) is None
    assert line(SUN) is None
    [entry] = entries(db)
    assert (entry["market_id"], entry["actor"], entry["action"], entry["vendors"]) == \
        (MARKET, None, "assign", [ANA])
    assert entry["subject"] == {"date": SUN, "currency": "CAD", "set_by": set_by,
                                "by_migration": True}
    assert entry["detail"] == History.changes({"owed_cents": cents}, {"owed_cents": None})


def test_seating_the_day_again_after_the_drop_owes_the_new_seats_price(database):
    db = database()
    plant(SUN, set_by_hand=by_hand(0))
    migrate(db)

    db["markets"].docs[0]["assignmentObject"]["vendorAssignments"].append(
        {"email": ANA, "date": SUN, "tableCode": "Landing 1", "tableChoice": "Full Table",
         "section": "Landing", "tier": "Silver", "location": "Main Hall", "handPlaced": True})

    assert (line(SUN)["owedCents"], line(SUN)["owedSetBy"]) == (3000, None)


# --- a state a rolled-back release left -------------------------------------------------------

def test_a_state_its_mirror_disagrees_with_is_read_from_the_mirror_and_stored_again(database):
    """A rolled-back release writes only the legacy fields: here it freed the table with the
    deduction over a record this release had stored as an Admin's amount."""
    db = database()
    stored = Freed(SEAT, HandAmount(2000, ADMIN, AT))
    record_id = plant(SUN, state=stored.to_stored(), **Payments.legacy_fields(stored), revision=3)
    Payments.amounts_owed_collection.update_one(
        {"_id": record_id}, {"$set": {"set_by_hand": by_free(replaced=by_hand())}})
    before = line(SUN)

    assert migrate(db) == 1

    assert_stored(db, record_id, FreedWaived(SEAT, EDITOR, FREED_AT, HandAmount(2000, ADMIN, AT)),
                  revision=4)
    assert line(SUN) == before
    assert before["owedCents"] == 0 and before["owedByFree"] is True


def test_a_record_whose_state_agrees_is_left(database):
    db = database()
    state = Freed(SEAT, None)
    record_id = plant(SUN, state=state.to_stored(), **Payments.legacy_fields(state), revision=2)
    as_stored = copy.deepcopy(record(db, record_id))

    assert migrate(db) == 0

    assert record(db, record_id) == as_stored


def test_a_freed_state_that_agrees_on_a_held_day_is_left_to_its_owner(database):
    """A free writes its record before its seat goes, so a freed state the owner stored on a held
    day may be a free still in flight: the read already shows the seat (``on_day``), and the
    migration does not take the line from under it."""
    db = database()
    state = FreedWaived(SEAT, EDITOR, FREED_AT, None)
    record_id = plant(SAT, state=state.to_stored(), **Payments.legacy_fields(state), revision=1)
    as_stored = copy.deepcopy(record(db, record_id))

    assert migrate(db) == 0

    assert record(db, record_id) == as_stored


# --- safe to run, and to run again ------------------------------------------------------------

def plant_one_of_each():
    plant(SAT, set_by_hand=by_hand())
    plant(SUN, freed=FREED, set_by_hand=by_free(replaced=by_hand()))
    plant(SUN, market_id=OTHER, set_by_hand=by_hand(0))


def test_a_dry_run_writes_nothing_and_says_what_it_would_set(database, capsys):
    db = database(a_market(), a_market(OTHER))
    plant_one_of_each()
    as_stored = copy.deepcopy(records(db))

    assert migrate(db, dry_run=True) == 3

    assert records(db) == as_stored
    assert db["history"].documents == []
    assert "would set 3 record(s)." in capsys.readouterr().out


def test_a_second_run_changes_nothing(database, capsys):
    db = database(a_market(), a_market(OTHER))
    plant_one_of_each()
    assert migrate(db) == 3
    after_first = copy.deepcopy(records(db))
    history_after_first = copy.deepcopy(db["history"].documents)
    capsys.readouterr()

    assert migrate(db) == 0

    assert records(db) == after_first
    assert db["history"].documents == history_after_first
    assert "set 0 record(s)." in capsys.readouterr().out


def test_a_market_being_deleted_is_left(database):
    db = database(a_market(), a_market(OTHER, deleting=new_tombstone(ADMIN)))
    record_id = plant(SUN, market_id=OTHER, set_by_hand=by_hand(0))
    as_stored = copy.deepcopy(record(db, record_id))

    assert migrate(db) == 0

    assert record(db, record_id) == as_stored
    assert entries(db) == []


def test_a_record_that_cannot_be_read_is_left_and_listed(database, capsys):
    db = database()
    record_id = plant(SUN, set_by_hand={"by": ADMIN}, state={"kind": "unknown"})
    as_stored = copy.deepcopy(record(db, record_id))

    assert migrate(db) == 0

    assert record(db, record_id) == as_stored
    assert f"left 1 record(s) that could not be read: {record_id}." in capsys.readouterr().out


def test_what_it_prints_names_markets_dates_and_records_never_a_name_or_an_address(
        database, capsys):
    db = database(a_market(), a_market(OTHER))
    plant_one_of_each()
    ids = [doc["_id"] for doc in records(db)]

    migrate(db)

    out = capsys.readouterr().out
    assert "@" not in out
    assert "ana" not in out.lower() and "admin" not in out.lower()
    assert f"market {MARKET}, date {SAT}, record {ids[0]}: state set" in out
    assert f"market {MARKET}, date {SUN}, record {ids[1]}: state freed_waived" in out
    assert (f"market {OTHER}, date {SUN}, record {ids[2]}: removed, an amount set by hand on a "
            "day not held, dropped and recorded") in out
    assert "\nset 3 record(s)." in out


def test_a_record_following_the_seat_is_named_as_removed(database, capsys):
    db = database()
    record_id = plant(SAT, freed=FREED)

    migrate(db)

    assert f"record {record_id}: removed, it follows the seat" in capsys.readouterr().out


# --- each write holds the record as read ------------------------------------------------------

class ChangedOnEachWrite:
    """The amounts owed, with another write landing on the record just before each of the
    migration's first ``times`` writes: the owner's, counting its revision up."""

    def __init__(self, collection, times):
        self.collection = collection
        self.times = times

    def __getattr__(self, name):
        return getattr(self.collection, name)

    def _meanwhile(self, query):
        if self.times > 0:
            self.times -= 1
            self.collection.update_one({"_id": query["_id"]}, {"$inc": {"revision": 1}})

    def update_one(self, query, update, **kwargs):
        self._meanwhile(query)
        return self.collection.update_one(query, update, **kwargs)

    def delete_one(self, query):
        self._meanwhile(query)
        return self.collection.delete_one(query)


@pytest.mark.parametrize("date, fields", [
    pytest.param(SUN, {"freed": FREED}, id="a state stored"),
    pytest.param(SUN, {"set_by_hand": by_hand(0)}, id="a hidden amount dropped"),
])
def test_a_record_changed_meanwhile_is_read_again(database, market_records, date, fields):
    db = database()
    db.collections["amounts_owed"] = ChangedOnEachWrite(market_records.amounts_owed, TRIES - 1)
    record_id = plant(date, **fields)

    assert migrate(db) == 1

    doc = record(db, record_id)
    if "freed" in fields:
        assert doc["state"] == Freed(SEAT, None).to_stored()
        assert doc["revision"] == TRIES
    else:
        assert doc is None
        assert len(entries(db)) == 1


@pytest.mark.parametrize("date, fields", [
    pytest.param(SUN, {"freed": FREED}, id="a state stored"),
    pytest.param(SUN, {"set_by_hand": by_hand(0)}, id="a hidden amount dropped"),
])
def test_a_record_that_changed_on_every_try_is_skipped_and_listed(
        database, market_records, capsys, date, fields):
    db = database()
    db.collections["amounts_owed"] = ChangedOnEachWrite(market_records.amounts_owed, TRIES)
    record_id = plant(date, **fields)

    assert migrate(db) == 0

    doc = record(db, record_id)
    assert "state" not in doc and doc["revision"] == TRIES
    assert entries(db) == []
    assert (f"skipped 1 record(s) that changed on every try: {record_id}. Run it again."
            in capsys.readouterr().out)


def test_a_record_removed_meanwhile_is_left_gone(database, market_records, monkeypatch):
    db = database()
    record_id = plant(SUN, set_by_hand=by_hand(0))
    owed = market_records.amounts_owed
    delete_one = owed.delete_one

    def removed_first(query):
        owed.documents.clear()
        return delete_one(query)

    monkeypatch.setattr(owed, "delete_one", removed_first)

    assert migrate(db) == 0

    assert record(db, record_id) is None
    assert entries(db) == []


def test_it_refuses_a_database_other_than_the_one_the_history_writes(database, market_records):
    from conftest import FakeApplicationsCollection

    db = database()
    db.collections["history"] = FakeApplicationsCollection()

    with pytest.raises(RuntimeError):
        migrate(db)
