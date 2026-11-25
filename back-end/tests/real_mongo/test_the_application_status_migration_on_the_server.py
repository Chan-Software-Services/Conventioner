"""``migrations/migrate_application_status.py`` on the server, run as an operator runs it: on the
configured database, through writes held on the application as read, whose conditions on absent
and null fields and on whole sub-documents the hermetic fakes only model.
"""
import pytest

import migrate_application_status as Migration
from conftest import stored_market
from datatypes import MarketPhase
from migrate_application_status import MIGRATED, TRIES, migrate

ANA = {"user_id": "user-ana", "email": "ana@example.com"}
CAT = {"user_id": "user-cat", "email": "cat@example.com"}
A_PERSON = {"kind": "person", "user_id": "user-ana", "email": "ana@example.com"}
AT = "2026-10-21T00:00:00+00:00"
MARK = {"actor": None, "action": MIGRATED}


def store_market(markets, market_id, reviewers=(ANA,), **fields):
    team = {"reviewers": [{"userId": person["user_id"], "email": person["email"]}
                          for person in reviewers], "turn": 0}
    markets.insert_one(stored_market(
        MarketPhase.APPLICATIONS, id=market_id, name=f"Fixture {market_id}", intakeMode="form",
        roles={"user-owner": "owner", "user-ana": "viewer", "user-cat": "viewer"},
        organizationId=None, reviewTeam=team, **fields))


def plant(applications, market_id, app_id, **fields):
    doc = {"id": app_id, "market_id": market_id, "applicant_email": f"{app_id}@vendor.test",
           "application_type": "main", "form_data": {}, "submitted_at": AT, "status": "open",
           "origin": "applied", "reviewer": ANA, "verdict_at": None}
    for key, value in fields.items():
        if value is None:
            doc.pop(key, None)
        else:
            doc[key] = value
    applications.insert_one(doc)
    return app_id


def without_ids(collection):
    return sorted(({k: v for k, v in doc.items() if k != "_id"} for doc in collection.find({})),
                  key=lambda doc: doc["id"])


def a_market_of_every_shape(real_db):
    markets, applications = real_db["markets"], real_db["applications"]
    store_market(markets, "m1")
    store_market(markets, "deleting",
                 deleting={"at": "2099-04-03T00:00:00+00:00", "by": "user-1", "trail_id": "t-1"})
    plant(applications, "m1", "under-review", status="under_review", origin=None, reviewer=None)
    plant(applications, "m1", "no-status", status=None, verdict_at=None)
    plant(applications, "m1", "null-status", status=None)
    applications.update_one({"id": "null-status"}, {"$set": {"status": None}})
    plant(applications, "m1", "sent", status="assignment_sent", verdict_by=A_PERSON)
    plant(applications, "m1", "removed", reviewer=CAT)
    plant(applications, "m1", "settled")
    plant(applications, "deleting", "left", status="under_review", origin=None)


def test_a_dry_run_writes_nothing_then_a_run_then_a_second_that_changes_nothing(real_db):
    a_market_of_every_shape(real_db)
    applications = real_db["applications"]
    before = without_ids(applications)

    assert migrate(dry_run=True) == 5
    assert without_ids(applications) == before
    assert list(real_db["history"].find({})) == []

    assert migrate() == 5

    stored = {doc["id"]: doc for doc in without_ids(applications)}
    assert {app_id: doc["status"] for app_id, doc in stored.items()} == {
        "under-review": "open", "no-status": "open", "null-status": "open",
        "sent": "reviewer_approved", "removed": "open", "settled": "open",
        "left": "under_review"}
    assert stored["under-review"]["origin"] == "applied"
    assert stored["under-review"]["arriving"] == MARK
    assert stored["removed"]["arriving"] == MARK
    assert stored["sent"]["verdict_by"] == A_PERSON
    assert "arriving" not in stored["settled"]
    # The market being deleted is left whole.
    assert "origin" not in stored["left"]
    # The migration records nothing itself: the deal that takes a mark does.
    assert list(real_db["history"].find({})) == []
    after_first = without_ids(applications)

    assert migrate() == 0
    assert without_ids(applications) == after_first


def test_a_run_stopped_after_its_first_write_finishes_when_run_again(real_db, monkeypatch):
    a_market_of_every_shape(real_db)
    real = Migration.written
    writes = []

    def the_shell_ends(applications, doc, fields):
        if writes:
            raise KeyboardInterrupt("the operator's shell ended")
        writes.append(doc["id"])
        return real(applications, doc, fields)

    monkeypatch.setattr(Migration, "written", the_shell_ends)
    with pytest.raises(KeyboardInterrupt):
        migrate()
    monkeypatch.setattr(Migration, "written", real)
    [first] = writes
    once = {doc["id"]: doc for doc in without_ids(real_db["applications"])}
    assert once[first]["status"] in ("open", "reviewer_approved")

    assert migrate() == 4

    assert migrate() == 0


def test_a_write_interleaved_between_the_read_and_the_write_is_read_again(real_db, monkeypatch):
    """Another request lands on the application between the migration's read and its write: the
    held write matches nothing, so it reads the application again and writes over what it reads
    now, never over the change."""
    markets, applications = real_db["markets"], real_db["applications"]
    store_market(markets, "m1")
    plant(applications, "m1", "dealt-meanwhile", status="under_review", reviewer=None)
    real = Migration.written
    landed = []

    def a_deal_lands_first(collection, doc, fields):
        if not landed:
            landed.append(collection.update_one({"id": doc["id"]}, {"$set": {"reviewer": ANA}}))
        return real(collection, doc, fields)

    monkeypatch.setattr(Migration, "written", a_deal_lands_first)

    assert migrate() == 1

    doc = applications.find_one({"id": "dealt-meanwhile"})
    # Read again, it is in Ana's share: stored open, and not marked.
    assert (doc["status"], doc["reviewer"], "arriving" in doc) == ("open", ANA, False)


def test_one_changed_on_every_try_is_listed_as_skipped(real_db, monkeypatch, capsys):
    markets, applications = real_db["markets"], real_db["applications"]
    store_market(markets, "m1")
    plant(applications, "m1", "busy", status="under_review")
    real = Migration.written
    tries = []

    def changed_each_time(collection, doc, fields):
        tries.append(1)
        collection.update_one({"id": doc["id"]}, {"$set": {"verdict_by": {"n": len(tries)}}})
        return real(collection, doc, fields)

    monkeypatch.setattr(Migration, "written", changed_each_time)

    assert migrate() == 0

    assert len(tries) == TRIES
    assert applications.find_one({"id": "busy"})["status"] == "under_review"
    assert "skipped 1 application(s) that changed on every try: busy." in capsys.readouterr().out


def test_a_write_holds_each_field_as_read_absent_null_or_whole(real_db):
    applications = real_db["applications"]
    plant(applications, "m1", "held", status=None, origin=None, reviewer=None)
    applications.update_one({"id": "held"}, {"$set": {"follow_up_owner": None}})
    as_read = applications.find_one({"id": "held"})

    for change in ({"$set": {"status": "open"}}, {"$set": {"origin": "applied"}},
                   {"$set": {"reviewer": ANA}}, {"$set": {"follow_up_owner": CAT}},
                   {"$set": {"arriving": MARK}}, {"$set": {"verdict_by": A_PERSON}},
                   {"$set": {"added_by": ANA}}):
        applications.replace_one({"id": "held"}, as_read)
        applications.update_one({"id": "held"}, change)
        changed = applications.find_one({"id": "held"})

        assert Migration.written(applications, as_read, {"status": "open"}) is False, change
        assert applications.find_one({"id": "held"}) == changed

    applications.replace_one({"id": "held"}, as_read)
    applications.update_one({"id": "held"}, {"$set": {"reviewer": ANA}})
    with_reviewer = applications.find_one({"id": "held"})
    # A whole sub-document held: one of its fields changed refuses the write too.
    applications.update_one({"id": "held"}, {"$set": {"reviewer.email": "other@example.com"}})
    assert Migration.written(applications, with_reviewer, {"status": "open"}) is False

    applications.replace_one({"id": "held"}, as_read)
    assert Migration.written(applications, as_read, {"status": "open"}) is True
    assert applications.find_one({"id": "held"})["status"] == "open"
