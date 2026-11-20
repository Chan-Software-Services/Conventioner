"""``migrations/migrate_business_name.py`` on the server, run as an operator runs it: on the
configured database, its per-application writes held to the answers they read, its one market
write through ``write_market`` holding sub-documents as the server stores them, its history entry,
a run cut after each step and finished by a second, and the file the mapping was saved from
imported again through the route after a run. The hermetic fakes only model those conditions.
"""
import copy

import pytest

import app as app_module
import assignment.made_from as MadeFrom
import essential_fields as EF
import migrate_business_name as Script
from conftest import made_from_now, stored_assignment, stored_market
from datatypes import MarketPhase
from market_documents import market_from_document
from migrate_business_name import main, migrate
from test_csv_import import FORM_FIELDS, GOOD_ROW, HEADERS, MAPPING, SETUP_CAMEL, _csv
from test_the_public_map import FORM, ON, SEATS, SLUG, _plan

MARKET = "market-123"
KEY = "business_name"
BUILT_IN = EF.BUSINESS_NAME_KEY
ORGANIZER = "fixture-organizer@example.com"
UPDATED_AT = "2099-07-01T10:00:00+00:00"
UPDATE = {"value": "Dev's Doughnuts", "by": {"user_id": "user-1", "email": "owner@example.com"},
          "at": "2099-07-02T00:00:00+00:00", "over": "Dev's Donuts"}


def _application(email, answers, updates=None, status="reviewer_approved"):
    return {
        "id": f"app-{email.split('@')[0]}", "market_id": MARKET, "applicant_email": email,
        "application_type": "main", "status": status, "updated_at": UPDATED_AT,
        "submitted_at": "2099-06-01T09:00:00+00:00",
        "form_data": {EF.FULL_NAME_KEY: f"Fixture {email.split('@')[0]}", **answers},
        **({"answer_updates": updates} if updates else {}),
    }


def _applications():
    return [
        _application("ana@ember.test", {KEY: "  Ember   Ceramics ", "website": "ember.test"}),
        _application("ben@kiln.test", {KEY: ""}),
        _application("cleo@loom.test", {KEY: "   "}),
        _application("dev@dough.test", {KEY: "Dev's Donuts"}, {KEY: copy.deepcopy(UPDATE)}),
    ]


@pytest.fixture
def market(real_db):
    """A market in its market days whose public map names its own business name question, which
    a review highlight marks and its saved mapping maps; its stored run was made from its
    applications as they stand."""
    real_db["applications"].insert_many(_applications())
    doc = stored_market(
        MarketPhase.MARKET_DAYS, id=MARKET, intakeMode="csv", applicationForm=copy.deepcopy(FORM),
        setupObject=_plan(None), publicMap=copy.deepcopy(ON), formRevision=2,
        reviewHighlights=[KEY, "website"],
        importMapping={"targets": {"applicant_email": ["Email Address"], KEY: ["Business Name"]},
                       "headers": ["Email Address", "Business Name"], "resolutions": {},
                       "madeBy": "import"},
        exampleColumns=[{"headers": ["Business Name"], "key": KEY, "label": "Business name",
                         "type": "text", "question": True}],
    )
    # Made from the applications as the market's read compares them, those it would refuse as
    # incomplete among them.
    as_read = market_from_document(copy.deepcopy(doc))
    made_from = {**made_from_now(copy.deepcopy(doc)),
                 "applications": MadeFrom.applications_now(as_read)}
    doc["assignmentObject"] = stored_assignment(
        "run", SEATS, made_from=made_from, revision=6, published_revision=6)
    real_db["markets"].insert_one(doc)
    assert reads_as_changed(real_db) == []
    return doc


def reads_as_changed(real_db):
    """What the market's read says changed since the stored run."""
    return MadeFrom.changed_since_run(market_from_document(stored(real_db)))


def stored(real_db):
    return real_db["markets"].find_one({"id": MARKET}, {"_id": 0})


def applications(real_db):
    return {doc["id"]: doc for doc in real_db["applications"].find({}, {"_id": 0})}


def public_names():
    response = app_module.app.test_client().get(f"/public/markets/{SLUG}/map")
    assert response.status_code == 200, response.get_json()
    return [(seat["date"], seat["tableId"], seat["half"], seat["name"])
            for seat in response.get_json()["seats"]]


def assert_moved(real_db, before_apps):
    """Every vendor's business name under the built-in key alone, and the market moved with it."""
    after = applications(real_db)
    assert {app_id: (doc["form_data"].get(BUILT_IN), KEY in doc["form_data"],
                     KEY in (doc.get("answer_updates") or {}))
            for app_id, doc in after.items()} == {
        "app-ana": ("Ember   Ceramics", False, False),
        "app-ben": (None, False, False), "app-cleo": (None, False, False),
        "app-dev": ("Dev's Donuts", False, False)}
    assert after["app-dev"]["answer_updates"] == {BUILT_IN: UPDATE}
    for app_id, doc in after.items():
        was = before_apps[app_id]
        assert (doc["status"], doc["updated_at"], doc["submitted_at"]) == (
            was["status"], was["updated_at"], was["submitted_at"])
        assert {key: value for key, value in doc["form_data"].items() if key != BUILT_IN} == {
            key: value for key, value in was["form_data"].items() if key != KEY}

    market = stored(real_db)
    assert KEY not in [field["key"] for field in market["applicationForm"]["fields"]]
    assert [field["order"] for field in market["applicationForm"]["fields"]] == [0, 1, 2, 3]
    assert market["formRevision"] == 3
    assert market["publicMap"]["nameQuestion"] == BUILT_IN
    assert market["reviewHighlights"] == [BUILT_IN, "website"]
    assert market["importMapping"]["targets"] == {
        "applicant_email": ["Email Address"], BUILT_IN: ["Business Name"]}
    assert market["exampleColumns"] == []
    # The stored run still reads as made from the applications as they stand.
    assert reads_as_changed(real_db) == []
    assert (market["assignmentObject"]["revision"],
            market["assignmentObject"]["publishedRevision"]) == (6, 6)


def form_changes(real_db):
    return [(entry["actor"], entry["action"], entry["kind"])
            for entry in real_db["history"].find({"market_id": MARKET})]


def test_a_dry_run_writes_nothing_and_a_run_moves_every_answer(real_db, market, capsys):
    before_apps = applications(real_db)
    before = stored(real_db)

    migrate(MARKET, KEY, dry_run=True)
    assert (stored(real_db), applications(real_db)) == (before, before_apps)
    assert form_changes(real_db) == []
    capsys.readouterr()

    migrate(MARKET, KEY)

    assert_moved(real_db, before_apps)
    assert form_changes(real_db) == [(None, "change-form", "form")]
    assert "changed during the run" not in capsys.readouterr().out


def test_the_public_map_reads_the_same_names_before_between_the_steps_and_after(
        real_db, market, interleave):
    before = public_names()
    assert ("2099-08-01", "t-a1", "whole", "Ember Ceramics") in before
    assert ("2099-08-01", "t-b2", "whole", "Dev's Doughnuts") in before
    between = {}
    interleave("migrate_business_name.copy_answers",
               lambda: between.setdefault("step 1", public_names()))
    interleave("migrate_business_name.record_moved",
               lambda: between.setdefault("step 2", public_names()))

    migrate(MARKET, KEY)

    assert between == {"step 1": before, "step 2": before}
    assert public_names() == before


def test_a_second_run_says_already_migrated_writes_nothing_and_exits_zero(
        real_db, market, capsys):
    migrate(MARKET, KEY)
    capsys.readouterr()
    before = (stored(real_db), applications(real_db), form_changes(real_db))

    assert main(["--market", MARKET, "--question", KEY]) == 0

    assert "already migrated" in capsys.readouterr().out
    assert (stored(real_db), applications(real_db), form_changes(real_db)) == before


def test_a_market_without_the_question_is_already_migrated(real_db, signed_in, market_in, capsys):
    signed_in(ORGANIZER)
    other = market_in(MarketPhase.APPLICATIONS, applicationForm={"fields": [
        {"key": "website", "label": "Website", "type": "text", "order": 0}]})
    before = real_db["markets"].find_one({"id": other["id"]}, {"_id": 0})

    assert main(["--market", other["id"], "--question", KEY]) == 0

    assert "already migrated" in capsys.readouterr().out
    assert real_db["markets"].find_one({"id": other["id"]}, {"_id": 0}) == before
    assert list(real_db["history"].find({})) == []


class _Cut(Exception):
    pass


def _cut(*_args, **_kwargs):
    raise _Cut()


def test_a_run_cut_after_step_one_is_finished_by_a_second(real_db, market, monkeypatch):
    before_apps = applications(real_db)
    with monkeypatch.context() as patch:
        patch.setattr(Script, "write_market", _cut)
        with pytest.raises(_Cut):
            migrate(MARKET, KEY)
    # Each vendor holds both copies, and the market is as it was.
    assert applications(real_db)["app-ana"]["form_data"][KEY] == "  Ember   Ceramics "
    assert applications(real_db)["app-ana"]["form_data"][BUILT_IN] == "Ember   Ceramics"
    assert KEY in [field["key"] for field in stored(real_db)["applicationForm"]["fields"]]

    assert main(["--market", MARKET, "--question", KEY]) == 0

    assert_moved(real_db, before_apps)
    assert form_changes(real_db) == [(None, "change-form", "form")]


def test_a_run_cut_after_step_two_is_finished_by_a_second(real_db, market, monkeypatch, capsys):
    before_apps = applications(real_db)
    with monkeypatch.context() as patch:
        patch.setattr(Script, "clean_answers", _cut)
        with pytest.raises(_Cut):
            migrate(MARKET, KEY)
    assert KEY not in [field["key"] for field in stored(real_db)["applicationForm"]["fields"]]
    assert KEY in applications(real_db)["app-ana"]["form_data"]
    capsys.readouterr()

    assert main(["--market", MARKET, "--question", KEY]) == 0

    assert "finishing a run" in capsys.readouterr().out
    assert_moved(real_db, before_apps)
    # The finishing run records nothing of its own.
    assert form_changes(real_db) == [(None, "change-form", "form")]


def test_the_file_the_mapping_was_saved_from_imported_again_changes_no_application(
        real_db, signed_in, market_in):
    client = signed_in(ORGANIZER)
    imported = market_in(MarketPhase.APPLICATIONS, setupObject=SETUP_CAMEL, applicationForm={
        "fields": FORM_FIELDS, "essentialOptions": None})
    rows = [GOOD_ROW,
            GOOD_ROW.replace("nadia@ember.test", "kai@ember.test").replace(
                "Ember Ceramics", "N/A"),
            GOOD_ROW.replace("nadia@ember.test", "ivy@ember.test").replace(
                "Ember Ceramics", "N/A Studios")]
    content = _csv(*rows)

    def import_it(mapping):
        response = client.post(f"/markets/{imported['id']}/applications/import",
                               json={"csvContent": content, "mapping": mapping})
        assert response.status_code == 200, response.get_json()
        return response.get_json()

    import_it(MAPPING)
    assert main(["--market", imported["id"], "--question", KEY]) == 0
    moved = {doc["applicant_email"]: doc
             for doc in real_db["applications"].find({"market_id": imported["id"]}, {"_id": 0})}
    assert {email: doc["form_data"].get(BUILT_IN) for email, doc in moved.items()} == {
        "nadia@ember.test": "Ember Ceramics", "kai@ember.test": None,
        "ivy@ember.test": "N/A Studios"}
    targets = real_db["markets"].find_one({"id": imported["id"]})["importMapping"]["targets"]
    assert KEY not in targets

    # As the import's screen opens the same file: each target at the column its saved header names.
    body = import_it({target: HEADERS.index(headers[0]) for target, headers in targets.items()})

    assert (body["unchanged"], body["updated"], body["returnedToReview"]) == (3, 0, 0)
    assert {doc["applicant_email"]: doc for doc in real_db["applications"].find(
        {"market_id": imported["id"]}, {"_id": 0})} == moved
