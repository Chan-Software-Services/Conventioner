"""Every stored application is brought to the review state's machine (T277 ticket 02, phase 2).

Phase 1 gave the review state one owner, which reads every stored spelling as the state it stands
for (``ReviewState.state_of``), each missing origin by the market's intake (``origin_of``) and an
application in nobody's share as waiting for the deal (``review_team.is_waiting``). Stored
applications still carry the old spellings (``under_review``, a missing status, the old offers
flow's statuses) and no ``origin``, and one left in nobody's share by the bugs phase 1 fixed (T277
P1, P2, P3, P5) was never marked, so no deal will take it. The migration stores what the owner
reads: ``open`` for each spelling of open, the approval or rejection an old status stands for, the
origin, and on a market with chosen reviewers the mark that makes the next deal deal it.
"""
import copy
from types import SimpleNamespace

import pytest

import api.applications as ApplicationsApi
import api.markets as MarketsApi
import application_status as ReviewState
import history as History
import market_write as MarketWrite
import review_team as ReviewTeam
from conftest import FakeSlugMarketsCollection, stored_market
from datatypes import MarketPhase
from migrate_application_status import MIGRATED, TRIES, migrate
from test_each_arrival_is_dealt import world  # noqa: F401  (the fixture)
from tombstone import new_tombstone

FORM = "market-form"
CSV = "market-csv"
UNABLE = "market-unable"
DELETED = "market-deleted"
ANA = "ana@example.com"
BEN = "ben@example.com"
CAT = "cat@example.com"
ANA_PERSON = {"user_id": "user-ana", "email": ANA}
CAT_PERSON = {"user_id": "user-cat", "email": CAT}
GONE_PERSON = {"user_id": "user-gone", "email": "gone@example.com"}
A_PERSON = {"kind": "person", "user_id": "user-ben", "email": BEN}
A_RULE = {"kind": "rule", "rule": "student"}
AT = "2026-10-21T00:00:00+00:00"
ADDED_BY = {"user_id": "user-ben", "email": BEN}
MARK = {"actor": None, "action": MIGRATED}

#: The market's "Be chosen as a reviewer" row raised to Admin: nobody chosen there may review.
CHOSEN_ROW_AT_ADMIN = {"review-when-chosen": {"role": "admin", "source": "market"}}


def a_market(market_id, intake="form", reviewers=(), **overrides):
    roles = {"user-owner": "owner", "user-ana": "viewer", "user-ben": "editor",
             "user-cat": "viewer"}
    team = {"reviewers": [{"userId": f"user-{email.split('@')[0]}", "email": email}
                          for email in reviewers], "turn": 0}
    return stored_market(MarketPhase.APPLICATIONS, id=market_id, name=f"Market {market_id}",
                         intakeMode=intake, roles=roles, organizationId=None,
                         **({"reviewTeam": team} if reviewers else {}), **overrides)


class Database:
    """The collections the migration reads and writes, by name, as the configured database's."""

    def __init__(self, collections):
        self.collections = collections

    def __getitem__(self, name):
        return self.collections[name]


@pytest.fixture
def database(monkeypatch, applications):
    def make(*markets):
        collection = FakeSlugMarketsCollection(list(markets) or [
            a_market(FORM, reviewers=[ANA, BEN]), a_market(CSV, intake="csv"),
            a_market(UNABLE, reviewers=[CAT], permissions=CHOSEN_ROW_AT_ADMIN),
            a_market(DELETED, reviewers=[ANA], deleting=new_tombstone("user-owner"))])
        for module in (MarketsApi, MarketWrite, ReviewTeam):
            monkeypatch.setattr(module, "markets_collection", collection)
        return Database({"markets": collection, "applications": applications})
    return make


def plant(app_id, market_id=FORM, **fields):
    """An application as a release stored it: open, applied and Ana's share unless ``fields`` say
    otherwise, a field given as None not stored at all."""
    doc = {"id": f"app-{app_id}", "market_id": market_id,
           "applicant_email": f"{app_id}@vendor.test", "application_type": "main",
           "form_data": {}, "submitted_at": AT, "updated_at": AT, "status": "open",
           "origin": "applied", "reviewer": ANA_PERSON, "verdict_at": None}
    for key, value in fields.items():
        if value is None:
            doc.pop(key, None)
        else:
            doc[key] = value
    ApplicationsApi.applications_collection.insert_one(doc)
    return doc["id"]


def stored(app_id):
    found = ApplicationsApi.applications_collection.find_one({"id": app_id})
    found.pop("_id")
    return found


def every_application():
    return copy.deepcopy(ApplicationsApi.applications_collection.documents)


# --- each stored status ---------------------------------------------------------------------------

STATUSES = [
    pytest.param({"status": "under_review"}, {"status": "open"}, id="under review is open"),
    pytest.param({"status": None}, {"status": "open"}, id="a missing status is open"),
    pytest.param({"status": ""}, {"status": "open"}, id="an empty status is open"),
    *(pytest.param({"status": old, "verdict_by": A_PERSON, "verdict_at": AT},
                   {"status": "reviewer_approved"}, id=f"{old} is the approval it carried")
      for old in ("unassigned", "assigned", "assignment_sent", "vendor_accepted",
                  "vendor_refused")),
    pytest.param({"status": "cancelled", "verdict_by": A_PERSON, "verdict_at": AT},
                 {"status": "reviewer_rejected"}, id="cancelled is a person's rejection"),
]


@pytest.mark.parametrize("fields, written", STATUSES)
def test_each_old_spelling_is_stored_as_the_state_it_reads_as(database, fields, written):
    db = database()
    app_id = plant("v1", **fields)
    before = stored(app_id)
    state = ReviewState.state_of(before)

    assert migrate(db) == 1

    after = stored(app_id)
    assert after == {**before, **written}
    # The giver and the time are kept, and the state reads as it did.
    assert ReviewState.state_of(after) is state


@pytest.mark.parametrize("fields", [
    pytest.param({}, id="open"),
    pytest.param({"status": "needs_follow_up", "follow_up_owner": ANA_PERSON}, id="a follow-up"),
    pytest.param({"status": "reviewer_approved", "verdict_by": A_PERSON}, id="an approval"),
    pytest.param({"status": "reviewer_rejected", "verdict_by": A_RULE}, id="a rule's rejection"),
    pytest.param({"status": "reviewer_approved", "origin": "added", "added_by": ADDED_BY},
                 id="a vendor added by hand"),
])
def test_an_application_the_owner_already_stores_is_left(database, fields):
    db = database()
    app_id = plant("v1", **fields)
    before = stored(app_id)

    assert migrate(db) == 0

    assert stored(app_id) == before


def test_a_cancelled_a_rule_gave_is_left_and_listed(database, capsys):
    """``cancelled`` reads as a person's rejection, but stored ``reviewer_rejected`` with a rule's
    giver it would read as the rule's, which the rules may judge again: so it is left."""
    db = database()
    app_id = plant("v1", status="cancelled", verdict_by=A_RULE, origin=None)
    before = stored(app_id)

    assert migrate(db) == 0

    assert stored(app_id) == before
    assert (f"left 1 application(s) whose status would read as another state: {app_id}."
            in capsys.readouterr().out)


def test_a_status_no_state_names_is_left_and_listed(database, capsys):
    db = database()
    app_id = plant("v1", status="withdrawn")
    before = stored(app_id)

    assert migrate(db) == 0

    assert stored(app_id) == before
    assert (f"left 1 application(s) that could not be read: {app_id}."
            in capsys.readouterr().out)


# --- the origin -----------------------------------------------------------------------------------

@pytest.mark.parametrize("market_id, fields, origin", [
    pytest.param(FORM, {}, "applied", id="on a market vendors apply to, applied"),
    pytest.param(FORM, {"added_by": ADDED_BY}, "added", id="added by hand on a form market"),
    pytest.param(CSV, {}, "imported", id="on a market vendors are imported to, imported"),
    pytest.param(CSV, {"added_by": ADDED_BY}, "added", id="added by hand on an imported market"),
])
def test_a_missing_origin_is_stored_as_the_market_reads_it(database, market_id, fields, origin):
    db = database()
    app_id = plant("v1", market_id=market_id, origin=None, **fields)
    before = stored(app_id)

    assert migrate(db) == 1

    assert stored(app_id) == {**before, "origin": origin}


# --- waiting for the deal -------------------------------------------------------------------------

@pytest.mark.parametrize("fields", [
    pytest.param({"reviewer": None}, id="open, never dealt"),
    pytest.param({"reviewer": CAT_PERSON}, id="open, its reviewer removed"),
    pytest.param({"status": "needs_follow_up", "follow_up_owner": GONE_PERSON},
                 id="a follow-up whose owner holds no role on the market"),
])
def test_one_in_nobodys_share_is_marked_for_the_deal(database, fields):
    db = database()
    app_id = plant("v1", **fields)
    before = stored(app_id)

    assert migrate(db) == 1

    assert stored(app_id) == {**before, "arriving": MARK}


def test_an_old_spelling_in_nobodys_share_is_stored_open_and_marked_at_once(database):
    db = database()
    app_id = plant("v1", status="under_review", reviewer=None, origin=None)
    before = stored(app_id)

    assert migrate(db) == 1

    assert stored(app_id) == {**before, "status": "open", "origin": "applied", "arriving": MARK}


@pytest.mark.parametrize("fields", [
    pytest.param({"reviewer": ANA_PERSON}, id="open, dealt to a chosen reviewer"),
    pytest.param({"reviewer": None, "status": "reviewer_approved", "verdict_by": A_PERSON},
                 id="decided"),
    pytest.param({"status": "needs_follow_up", "reviewer": CAT_PERSON,
                  "follow_up_owner": CAT_PERSON},
                 id="a follow-up whose owner holds a role, its reviewer removed"),
])
def test_one_in_a_share_or_decided_is_not_marked(database, fields):
    db = database()
    app_id = plant("v1", **fields)

    migrate(db)

    assert "arriving" not in stored(app_id)


def test_one_already_marked_keeps_its_mark(database):
    """Its mark names the write that moved it, which the deal records it under."""
    db = database()
    marked = {"actor": BEN, "action": "give-verdicts"}
    app_id = plant("v1", reviewer=None, arriving=marked)
    before = stored(app_id)

    assert migrate(db) == 0

    assert stored(app_id) == before


def test_on_a_market_with_no_reviewers_chosen_nothing_is_marked(database):
    """First come, first served: nobody's share is no share to miss."""
    db = database()
    app_id = plant("v1", market_id=CSV, origin="imported", reviewer=None)

    assert migrate(db) == 0

    assert "arriving" not in stored(app_id)


def test_on_a_market_where_nobody_chosen_is_able_it_is_marked_and_the_deal_leaves_it(database):
    """As P5's marks: the deal leaves it for the next one once someone chosen is able."""
    db = database()
    app_id = plant("v1", market_id=UNABLE, reviewer=None)

    assert migrate(db) == 1
    market = MarketsApi.load_market_context(UNABLE).market
    assert ReviewTeam.deal_waiting(market, None) == 0

    assert stored(app_id)["arriving"] == MARK
    assert "reviewer" not in stored(app_id)


def test_a_market_being_deleted_is_neither_counted_nor_changed(database, capsys):
    db = database()
    app_id = plant("v1", market_id=DELETED, status="under_review", reviewer=None, origin=None)
    before = stored(app_id)

    assert migrate(db) == 0

    assert stored(app_id) == before
    assert "under_review" not in capsys.readouterr().out


def test_an_application_removed_meanwhile_is_left_gone(database, applications, monkeypatch):
    """Its market deleted between the read and the write: the held write matches nothing, the
    application reads as gone, and nothing is written in its place."""
    db = database()
    app_id = plant("v1", status="under_review")
    real = applications.update_one

    def deleted_first(query, update, **kwargs):
        applications.delete_many({"id": app_id})
        return real(query, update, **kwargs)

    monkeypatch.setattr(applications, "update_one", deleted_first)

    assert migrate(db) == 0

    assert applications.find_one({"id": app_id}) is None


# --- what it says -------------------------------------------------------------------------------

def a_market_of_every_shape(db):
    plant("v1", status="under_review", reviewer=None, origin=None)
    plant("v2", status=None)
    plant("v3", status="assignment_sent", verdict_by=A_PERSON)
    plant("v4", status="cancelled", verdict_by=A_RULE)
    plant("v5")
    plant("v6", status="needs_follow_up", follow_up_owner=GONE_PERSON)
    plant("v7", market_id=DELETED, status="vendor_refused")


def test_it_counts_every_stored_status_across_live_markets_first(database, capsys):
    """Daniel's read-only count of production (decision 9.6), its dry run's first lines."""
    db = database()
    a_market_of_every_shape(db)

    migrate(db, dry_run=True)

    out = capsys.readouterr().out
    assert out.startswith(
        "Applications in each stored status across live markets:\n"
        "  assignment_sent: 1\n"
        "  cancelled: 1\n"
        "  needs_follow_up: 1\n"
        "  open: 1\n"
        "  under_review: 1\n"
        "  (no status): 1\n")
    assert "vendor_refused" not in out


def test_a_dry_run_writes_nothing_and_says_what_it_would_change(database, capsys):
    db = database()
    a_market_of_every_shape(db)
    before = every_application()

    assert migrate(db, dry_run=True) == 4

    assert every_application() == before
    out = capsys.readouterr().out
    assert (f"  - market {FORM}, application app-v1: status under_review to open; origin "
            "applied; marked for the deal\n") in out
    assert f"  - market {FORM}, application app-v2: status missing to open\n" in out
    assert (f"  - market {FORM}, application app-v3: status assignment_sent to "
            "reviewer_approved\n") in out
    assert f"  - market {FORM}, application app-v6: marked for the deal\n" in out
    assert "app-v5" not in out
    assert "\nwould change 4 application(s).\n" in out
    assert "left 1 application(s) whose status would read as another state: app-v4." in out


def test_a_second_run_changes_nothing(database, capsys):
    db = database()
    a_market_of_every_shape(db)
    assert migrate(db) == 4
    after_first = every_application()
    capsys.readouterr()

    assert migrate(db) == 0

    assert every_application() == after_first
    assert "\nchanged 0 application(s).\n" in capsys.readouterr().out


def test_it_names_markets_and_applications_never_an_address(database, capsys):
    db = database()
    a_market_of_every_shape(db)

    migrate(db, dry_run=True)
    migrate(db)

    assert "@" not in capsys.readouterr().out


def test_it_refuses_a_database_other_than_the_configured_one(database):
    """It reads each market and its organization as a route loads them, through the markets
    module, which reads the configured database."""
    db = database()
    db.collections["markets"] = FakeSlugMarketsCollection([a_market(FORM)])

    with pytest.raises(RuntimeError, match="configured database"):
        migrate(db)


# --- each write holds the application as read ---------------------------------------------------

class ChangedOnEachWrite:
    """The applications, with another write landing on the application just before each of the
    migration's first ``times`` writes: a verdict's time moving, a field the write does not hold,
    then its reviewer, which it does."""

    def __init__(self, collection, times):
        self.collection = collection
        self.times = times
        self.writes = 0

    def __getattr__(self, name):
        return getattr(self.collection, name)

    def update_one(self, query, update, **kwargs):
        self.writes += 1
        if self.times > 0:
            self.times -= 1
            self.collection.update_one({"id": query["id"]},
                                       {"$set": {"reviewer": {**ANA_PERSON, "n": self.times}}})
        return self.collection.update_one(query, update, **kwargs)


def test_an_application_changed_meanwhile_is_read_again(database, applications):
    db = database()
    db.collections["applications"] = ChangedOnEachWrite(applications, TRIES - 1)
    app_id = plant("v1", status="under_review")

    assert migrate(db) == 1

    assert stored(app_id)["status"] == "open"
    assert db["applications"].writes == TRIES


def test_an_application_changed_on_every_try_is_skipped_and_listed(
        database, applications, capsys):
    db = database()
    db.collections["applications"] = ChangedOnEachWrite(applications, TRIES)
    app_id = plant("v1", status="under_review")

    assert migrate(db) == 0

    assert stored(app_id)["status"] == "under_review"
    assert (f"skipped 1 application(s) that changed on every try: {app_id}. Run it again."
            in capsys.readouterr().out)


def test_a_market_unreadable_on_a_retry_is_left_and_the_run_goes_on(
        database, applications, monkeypatch, capsys):
    """Its stored document stops reading as a market between a try and the next: what is left of
    it is left and said, and the other markets are still brought over."""
    db = database()
    db.collections["applications"] = ChangedOnEachWrite(applications, 1)
    first = plant("v1", status="under_review")
    plant("v2", status="under_review")
    elsewhere = plant("v3", market_id=CSV, status="under_review", reviewer=None)
    real = MarketsApi.load_market_context
    reads = {"form": 0}

    def unreadable_on_the_retry(market_id, *args, **kwargs):
        if market_id == FORM:
            reads["form"] += 1
            if reads["form"] > 1:
                return SimpleNamespace(market=None, organization=None)
        return real(market_id, *args, **kwargs)

    monkeypatch.setattr(MarketsApi, "load_market_context", unreadable_on_the_retry)

    assert migrate(db) == 1

    assert stored(first)["status"] == "under_review"
    assert stored(elsewhere)["status"] == "open"
    assert (f"  - market {FORM}: left from application {first} on, it cannot be read"
            in capsys.readouterr().out)


@pytest.mark.parametrize("field, changed", [
    ("status", "reviewer_approved"), ("verdict_by", A_PERSON), ("added_by", ADDED_BY),
    ("origin", "imported"), ("arriving", {"actor": BEN, "action": "give-verdicts"}),
    ("reviewer", CAT_PERSON), ("follow_up_owner", ANA_PERSON),
])
def test_a_write_holds_every_field_it_reads(database, applications, field, changed):
    """A change to any field the judgment read refuses the write, null and absent alike."""
    import migrate_application_status as Migration

    database()
    app_id = plant("v1", status=None, origin=None, reviewer=None)
    as_read = applications.find_one({"id": app_id})
    applications.update_one({"id": app_id}, {"$set": {field: changed}})

    assert Migration.written(applications, as_read, {"status": "open"}) is False
    assert stored(app_id).get("status") != "open"


# --- the next deal takes the marks ------------------------------------------------------------

class TestTheNextDealAfterARun:
    """Through the routes, as a reviewer meets it: the next card they ask for deals each
    application the migration marked, and the deal records it under the migration's action with
    no actor, through the deal's own door."""

    def test_the_next_card_deals_each_marked_application_and_records_it(self, world):
        from test_choosing_reviewers_deals_the_open_applications import (
            MARKET as ROUTED, _application, _choose,
        )
        from test_every_return_to_open_waits_for_the_deal import _next, _waiting

        assert _choose([ANA, BEN]).status_code == 200
        world.applications.documents += [
            _application("v8", 8, status="under_review"),
            _application("v9", 9, reviewer=CAT_PERSON),
            _application("v10", 10, status="needs_follow_up", reviewer=CAT_PERSON,
                         follow_up_owner=GONE_PERSON),
        ]
        db = Database({"markets": world.markets, "applications": world.applications})

        # The world's applications store no origin, so each is given one too.
        assert migrate(db) == 10
        assert sorted(_waiting(world)) == ["app-v10", "app-v8", "app-v9"]

        assert _next(BEN)["dealt"] == 3

        assert _waiting(world) == []
        marked = ("app-v8", "app-v9", "app-v10")
        dealt = {d["id"]: (d["reviewer"]["email"], (d.get("follow_up_owner") or {}).get("email"))
                 for d in world.applications.documents if d["id"] in marked}
        assert {reviewer for reviewer, _owner in dealt.values()} <= {ANA, BEN}
        assert dealt["app-v10"][0] == dealt["app-v10"][1]
        [entry] = [e for e in world.history.documents
                   if e["kind"] == History.DEALT and e["action"] == MIGRATED]
        assert (entry["market_id"], entry["actor"]) == (ROUTED, None)
        assert sorted(entry["subject"]["application_ids"]) == ["app-v10", "app-v8", "app-v9"]
        assert entry["detail"]["before"]["app-v9"] == {"reviewer": CAT}
        assert entry["detail"]["before"]["app-v10"] == {"reviewer": CAT,
                                                       "follow_up_owner": GONE_PERSON["email"]}
