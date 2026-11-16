"""``migrations/migrate_owed_day_state.py`` on the server, run as an operator runs it: on the
configured database, through writes held on the record as read, whose conditions on absent and null
fields and on whole sub-documents the hermetic fakes only model.
"""
import copy

import history as History
import payments as Payments
from conftest import stored_assignment, stored_market
from datatypes import MarketPhase
from migrate_owed_day_state import Judgment, migrate, written
from payments import Freed, FreedSeat, FreedWaived, HandAmount, SetByHand
from test_a_vendors_payments import PLAN

ANA = "ana@example.com"
ADMIN = "admin@example.com"
EDITOR = "editor@example.com"
SAT, SUN = "2099-05-07", "2099-05-08"
AT = "2099-04-01T10:00:00+00:00"
FREED = {"table_code": "North Wing 2", "tier": "Gold", "table_choice": "Full Table",
         "cents": 3500, "group": None, "by": EDITOR, "at": AT}
SEAT = FreedSeat(Payments.Seat("North Wing 2", "Gold", "Full Table", 3500, None), EDITOR, AT)
AMOUNT = HandAmount(2000, ADMIN, AT)


def store_market(markets, market_id, **fields):
    """A priced market in market days, Ana holding a Gold table on Saturday and none on Sunday."""
    row = {"email": ANA, "date": SAT, "tableCode": "North Wing 1", "tableChoice": "Full Table",
           "section": "North Wing", "tier": "Gold", "location": "Main Hall", "handPlaced": True}
    markets.insert_one(stored_market(
        MarketPhase.MARKET_DAYS, id=market_id, name=f"Fixture {market_id}",
        setupObject=copy.deepcopy(PLAN), assignmentObject=stored_assignment("pinned", rows=[row]),
        **fields))


def plant(owed, market_id, date, **fields):
    return owed.insert_one({"market_id": market_id, "vendor_email": ANA, "date": date,
                            **fields}).inserted_id


def test_every_record_is_given_its_state_and_a_second_run_changes_nothing(real_db):
    markets, owed = real_db["markets"], real_db["amounts_owed"]
    store_market(markets, "m1")
    store_market(markets, "deleting",
                 deleting={"at": "2099-04-03T00:00:00+00:00", "by": "user-1", "trail_id": "t-1"})
    by_hand = {"cents": 2000, "by": ADMIN, "at": AT}
    waived = {"cents": 0, "by": EDITOR, "at": AT, "by_free": True, "replaced": by_hand}
    held_amount = plant(owed, "m1", SAT, set_by_hand=by_hand)
    freed_waived = plant(owed, "m1", SUN, freed=FREED, set_by_hand=waived)
    # A record cleared by the release before: both fields null.
    cleared = plant(owed, "deleting", SAT, freed=None, set_by_hand=None)
    hidden = plant(owed, "deleting", SUN, set_by_hand=by_hand)
    before = list(owed.find({}))

    assert migrate(dry_run=True) == 2
    assert list(owed.find({})) == before
    assert list(real_db["history"].find({})) == []

    assert migrate() == 2

    assert owed.find_one({"_id": held_amount})["state"] == SetByHand(AMOUNT).to_stored()
    waived_state = FreedWaived(SEAT, EDITOR, AT, AMOUNT)
    stored = owed.find_one({"_id": freed_waived})
    assert (stored["state"], stored["revision"]) == (waived_state.to_stored(), 1)
    assert Payments.state_of(stored) == waived_state
    # The market being deleted is left whole.
    assert owed.find_one({"_id": cleared}) is not None
    assert "state" not in owed.find_one({"_id": hidden})
    after_first = list(owed.find({}))

    assert migrate() == 0
    assert list(owed.find({})) == after_first


def test_a_hidden_amount_and_a_cleared_record_are_removed_on_the_server(real_db):
    markets, owed = real_db["markets"], real_db["amounts_owed"]
    store_market(markets, "m1")
    cleared = plant(owed, "m1", SAT, freed=None, set_by_hand=None)
    hidden = plant(owed, "m1", SUN, set_by_hand={"cents": 0, "by": ADMIN, "at": AT})

    assert migrate() == 2

    assert owed.find_one({"_id": cleared}) is None
    assert owed.find_one({"_id": hidden}) is None
    [entry] = real_db["history"].find({"kind": History.OWED_DROPPED})
    assert (entry["actor"], entry["vendors"], entry["subject"]) == (
        None, [ANA], {"date": SUN, "currency": "CAD", "set_by": ADMIN, "by_migration": True})


def test_a_write_holds_the_record_as_read(real_db):
    """Each field held as read, absent, null or a whole sub-document: a change to any of them
    since refuses the write."""
    owed = real_db["amounts_owed"]
    state = Freed(SEAT, AMOUNT)
    record_id = plant(owed, "m1", SUN, freed=None, set_by_hand={"cents": 2000, "by": ADMIN,
                                                                 "at": AT})
    as_read = owed.find_one({"_id": record_id})

    for change in ({"$set": {"freed": FREED}}, {"$set": {"revision": 1}},
                   {"$set": {"set_by_hand.cents": 1000}}, {"$set": {"state": {"kind": "set"}}}):
        owed.replace_one({"_id": record_id}, as_read)
        owed.update_one({"_id": record_id}, change)
        changed = owed.find_one({"_id": record_id})

        assert written(owed, as_read, Judgment(state)) is False, change
        assert owed.find_one({"_id": record_id}) == changed

    owed.replace_one({"_id": record_id}, as_read)
    assert written(owed, as_read, Judgment(state)) is True
    assert owed.find_one({"_id": record_id})["state"] == state.to_stored()
