"""A market's own business name question moves to the built-in field (T502, ticket 04).

Before the built-in "Business name" existed, a market that wanted one asked it as a short text
question of its own form. ``migrations/migrate_business_name.py`` is the operator's way to move
one such question onto the built-in field: ``--list`` names the candidates, and a run takes the
market and the question key the operator types, copies each vendor's answer and each organizer's
update of it to the built-in key, takes the question off the form (with the public map, the review
highlights, the saved mapping and a stored run's fingerprint following it), records the change in
the market's history, and clears the old answers.

These tests read what an operator reads (the printed lines) and what the documents hold after; the
server's own behaviour, a cut run finished and the same file imported again, is in
``tests/real_mongo/test_the_business_name_migration_on_the_server.py``.
"""
import copy

import pytest

from conftest import (
    FakeApplicationsCollection, FakeSlugMarketsCollection, made_from_now, stored_assignment,
    stored_market,
)

import db_config as test_db_config
import essential_fields as EF
import market_write as MarketWrite
from datatypes import MarketPhase, market_name_slug
from market_write import write_market
from migrate_business_name import LeftAfterStepOne, Refused, listed, main, migrate

MARKET = "market-123"
OTHER = "market-456"
SLUG = market_name_slug("Test Market")
KEY = "business_name"
BUILT_IN = EF.BUSINESS_NAME_KEY
ORGANIZER = {"user_id": "user-1", "email": "owner@example.com"}
UPDATED_AT = "2099-07-01T10:00:00+00:00"


def _fields():
    return [
        {"key": "product_type", "label": "What do you sell?", "type": "text", "required": False,
         "options": [], "order": 0},
        {"key": KEY, "label": "Business name", "type": "text", "required": False, "options": [],
         "order": 1},
        {"key": "website", "label": "Website", "type": "text", "required": False, "options": [],
         "order": 2},
        {"key": "table_size", "label": "Table size", "type": "select", "required": False,
         "options": ["Small", "Large"], "order": 3},
    ]


def _mapping():
    return {
        "targets": {"applicant_email": ["Email Address"], KEY: ["Business Name"],
                    "product_type": ["What do you sell?"]},
        "headers": ["Email Address", "Business Name", "What do you sell?"],
        "resolutions": {KEY: {"N/A": None}},
        "savedAt": "2099-06-01T00:00:00+00:00", "madeBy": "import",
    }


def _example_columns():
    return [
        {"headers": ["Business Name"], "key": KEY, "label": "Business name", "type": "text",
         "question": True},
        {"headers": ["What do you sell?"], "key": "product_type", "label": "What do you sell?",
         "type": "text", "question": True},
    ]


def a_market(phase=MarketPhase.APPLICATIONS, market_id=MARKET, **overrides):
    """A market whose form asks a business name as its own short text question, which the public
    map names, a review highlight marks and the saved mapping maps a column to."""
    fields = dict(
        id=market_id, intakeMode="csv",
        applicationForm={"fields": _fields(), "essentialOptions": None, "unaskedEssentials": []},
        formRevision=4,
        publicMap={"enabled": False, "nameQuestion": KEY, "websiteQuestion": "website"},
        reviewHighlights=["product_type", KEY, EF.FULL_NAME_KEY],
        importMapping=_mapping(), exampleColumns=_example_columns(),
    )
    fields.update(overrides)
    return stored_market(phase, **fields)


def an_application(app_id, email, answers=None, updates=None, status="open", market_id=MARKET):
    doc = {
        "id": app_id, "market_id": market_id, "applicant_email": email,
        "form_data": {EF.FULL_NAME_KEY: f"Vendor {app_id}", "product_type": "Mugs",
                      **(answers or {})},
        "status": status, "application_type": "main", "updated_at": UPDATED_AT,
        "submitted_at": "2099-06-01T09:00:00+00:00",
    }
    if updates:
        doc["answer_updates"] = updates
    return doc


def an_update(value, over):
    return {"value": value, "by": dict(ORGANIZER), "at": "2099-06-20T12:00:00+00:00",
            "over": over}


def the_applications():
    return [
        an_application("app-ana", "ana@example.com", {KEY: " Paper & Pine "}),
        an_application("app-ben", "ben@example.com", {KEY: ""}),
        an_application("app-cy", "cy@example.com", {KEY: "   "}),
        an_application("app-dee", "dee@example.com", {KEY: "N/A"}),
        an_application("app-eve", "eve@example.com", {KEY: "Kiln Works", BUILT_IN: "Kiln & Co"}),
        an_application("app-fay", "fay@example.com", {KEY: "Pine Works"},
                       {KEY: an_update("Pine Works Ltd", "Pine Works")}),
        an_application("app-gus", "gus@example.com", {KEY: "N/A Studios"}),
        an_application("app-hal", "hal@example.com"),
    ]


class Database:
    """The collections the script reads, the ones ``write_market``, the applications module and
    the history write."""

    def __init__(self, markets, applications, history):
        self.markets, self.applications, self.history = markets, applications, history

    def __getitem__(self, name):
        known = {"markets": self.markets, "applications": self.applications,
                 "history": self.history}
        return known[name] if name in known else FakeApplicationsCollection()


@pytest.fixture
def database(monkeypatch, applications, market_records):
    def make(*docs, apps=None):
        markets = FakeSlugMarketsCollection(list(docs))
        monkeypatch.setattr(MarketWrite, "markets_collection", markets)
        applications.documents = copy.deepcopy(the_applications() if apps is None else apps)
        db = Database(markets, applications, market_records.history)
        monkeypatch.setattr(test_db_config, "get_database", lambda *_a, **_kw: db)
        return db
    return make


def stored(db, market_id=MARKET):
    return next(doc for doc in db.markets.docs if doc["id"] == market_id)


def application(db, app_id):
    return next(doc for doc in db.applications.documents if doc["id"] == app_id)


def everything(db):
    return copy.deepcopy((db.markets.docs, db.applications.documents, db.history.documents))


# --- the listing ------------------------------------------------------------------------------

def test_the_listing_names_each_candidate_question_and_what_else_names_it(database, capsys):
    other = a_market(MarketPhase.MARKET_DAYS, market_id=OTHER, name="Other Fair",
                     intakeMode="online",
                     applicationForm={"fields": [
                         {"key": "shop", "label": "Your BUSINESS", "type": "text", "order": 0},
                         {"key": "business_type", "label": "Kind", "type": "select",
                          "options": ["Food"], "order": 1},
                         {"key": "handle", "label": "Instagram", "type": "text", "order": 2}]},
                     publicMap=None, reviewHighlights=None, importMapping=None, exampleColumns=None)
    db = database(a_market(), other)
    before = everything(db)

    found = listed(db)

    out = capsys.readouterr().out
    assert everything(db) == before
    assert [(candidate.market_id, candidate.key) for candidate in found] == [
        (MARKET, KEY), (OTHER, "shop")]
    assert (f'market {MARKET} "Test Market" (phase applications, intake csv)') in out
    assert ("  - question 'business_name' (\"Business name\"): 5 answered, 1 hold a built-in "
            "business name; also named by: the public map's name, a review highlight, the saved "
            "import mapping, an example column") in out
    assert f'market {OTHER} "Other Fair" (phase market_days, intake online)' in out
    assert ("  - question 'shop' (\"Your BUSINESS\"): 0 answered, 0 hold a built-in business "
            "name; also named by: nothing") in out
    assert "business_type" not in out and "handle" not in out
    assert out.rstrip().endswith(
        "listed 2 question(s) on 2 market(s): nothing written, and no answer or address printed.")


def test_the_listing_prints_no_answer_and_no_address(database, capsys):
    db = database(a_market())

    listed(db)

    out = capsys.readouterr().out
    for doc in db.applications.documents:
        assert doc["applicant_email"] not in out
        for value in doc["form_data"].values():
            assert not str(value).strip() or str(value).strip() not in out.replace(
                "Business name", "")


def test_the_listing_leaves_out_a_market_being_deleted(database, capsys):
    database(a_market(), a_market(market_id=OTHER, deleting={"at": "2099-07-01T00:00:00+00:00",
                                                             "by": "user-1", "trail_id": "t-1"}))

    found = listed()

    assert [candidate.market_id for candidate in found] == [MARKET]
    assert OTHER not in capsys.readouterr().out


# --- the command --------------------------------------------------------------------------------

@pytest.mark.parametrize("argv", [
    [], ["--market", MARKET], ["--question", KEY], ["--market", MARKET, "--dry-run"],
    ["--market", MARKET, "--question"], ["--market", MARKET, "--question", KEY, "--label", "x"],
    ["--list", "--market", MARKET],
])
def test_a_run_needs_the_market_and_the_question_or_it_prints_the_usage_and_exits_one(
        database, capsys, argv):
    db = database(a_market())
    before = everything(db)

    assert main(argv) == 1

    assert "usage: migrate_business_name.py" in capsys.readouterr().err
    assert everything(db) == before


def test_the_command_lists_and_exits_zero(database, capsys):
    database(a_market())

    assert main(["--list"]) == 0
    assert "listed 1 question(s)" in capsys.readouterr().out


def test_the_command_moves_and_exits_zero(database):
    db = database(a_market())

    assert main(["--market", MARKET, "--question", KEY]) == 0
    assert KEY not in [field["key"] for field in stored(db)["applicationForm"]["fields"]]


def test_the_command_exits_one_on_a_refusal_and_says_why(database, capsys):
    db = database(a_market())
    before = everything(db)

    assert main(["--market", MARKET, "--question", "table_size"]) == 1

    assert "refused, nothing written: " in capsys.readouterr().err
    assert everything(db) == before


def test_the_question_is_never_chosen_by_its_label(database, capsys):
    db = database(a_market())
    before = everything(db)

    assert main(["--market", MARKET, "--question", "Business name"]) == 0

    assert "already migrated" in capsys.readouterr().out
    assert everything(db) == before


# --- a dry run ----------------------------------------------------------------------------------

def test_a_dry_run_prints_the_lines_a_run_prints_and_writes_nothing(database, capsys):
    db = database(a_market())
    before = everything(db)

    migrate(MARKET, KEY, db, dry_run=True)
    dry = capsys.readouterr().out

    assert everything(db) == before
    assert "(dry run: nothing is written)" in dry
    assert dry.rstrip().endswith("would move the question to the built-in business name.")

    migrate(MARKET, KEY, db)
    run = capsys.readouterr().out
    assert run.rstrip().endswith("moved the question to the built-in business name.")
    assert (dry.replace(" (dry run: nothing is written)", "").rsplit("\n", 2)[0]
            == run.rsplit("\n", 2)[0])


def test_a_run_prints_no_answer_and_no_address(database, capsys):
    db = database(a_market())
    answers = {str(value).strip() for doc in db.applications.documents
               for value in doc["form_data"].values() if str(value).strip()}

    migrate(MARKET, KEY, db)

    out = capsys.readouterr().out
    for doc in db.applications.documents:
        assert doc["applicant_email"] not in out
    assert [answer for answer in answers if answer in out and answer != "Business name"] == []


def test_a_run_prints_what_each_step_does(database, capsys):
    db = database(a_market())

    migrate(MARKET, KEY, db)

    out = capsys.readouterr().out
    assert (f"market {MARKET} \"Test Market\": the question 'business_name' (\"Business name\") "
            "moves to the built-in business name") in out
    assert ("  - step 1, copy: 3 answer(s) and 1 organizer's update(s) to the built-in key; "
            "3 blank or none, left; 1 already holding another business name, kept") in out
    assert "  - kept, each holding another built-in business name: app-eve" in out
    assert ("  - step 2, the market: the question leaves the form and 3 other question(s) are "
            "renumbered; formRevision 4 -> 5") in out
    assert "  - the public map's name question: moves to the built-in business name" in out
    assert "  - the review highlights: the question's place goes to the built-in" in out
    assert ("  - the saved import mapping: its column and resolutions move to the built-in; its "
            "example column is removed") in out
    assert "  - the allocation's record of the applications: none is stored" in out
    assert "  - the market's history: one form change with no actor" in out
    assert ("  - step 3, clean: 7 application(s) hold an answer or update under 'business_name', "
            "removed") in out


# --- a run, as the documents hold it -------------------------------------------------------------

def test_each_vendor_who_answered_holds_the_answer_under_the_built_in_key_alone(database):
    db = database(a_market())

    migrate(MARKET, KEY, db)

    holds = {doc["id"]: (doc["form_data"].get(BUILT_IN), KEY in doc["form_data"])
             for doc in db.applications.documents}
    assert holds == {
        "app-ana": ("Paper & Pine", False),
        "app-ben": (None, False), "app-cy": (None, False),
        # Daniel's Q7: an answer that is exactly a none word is no business name.
        "app-dee": (None, False),
        "app-eve": ("Kiln & Co", False),
        "app-fay": ("Pine Works", False),
        "app-gus": ("N/A Studios", False),
        "app-hal": (None, False),
    }


def test_an_organizers_update_moves_whole_and_nothing_the_review_owns_moves(database):
    db = database(a_market())
    before = {doc["id"]: copy.deepcopy(doc) for doc in db.applications.documents}

    migrate(MARKET, KEY, db)

    fay = application(db, "app-fay")
    assert fay["answer_updates"] == {BUILT_IN: an_update("Pine Works Ltd", "Pine Works")}
    for doc in db.applications.documents:
        was = before[doc["id"]]
        assert {key: doc.get(key) for key in ("status", "updated_at", "submitted_at",
                                               "verdict_at")} == {
            key: was.get(key) for key in ("status", "updated_at", "submitted_at", "verdict_at")}
        # Every other answer is as it was.
        assert {key: value for key, value in doc["form_data"].items() if key != BUILT_IN} == {
            key: value for key, value in was["form_data"].items() if key not in (KEY, BUILT_IN)}


def test_an_update_over_a_blank_answer_stands_over_no_business_name(database):
    apps = [an_application("app-ivy", "ivy@example.com", {KEY: ""},
                           {KEY: an_update("  Ivy Prints ", "")})]
    db = database(a_market(), apps=apps)

    migrate(MARKET, KEY, db)

    ivy = application(db, "app-ivy")
    assert BUILT_IN not in ivy["form_data"]
    # Stored as the built-in's own update is: stripped, and over the answer the vendor now has.
    assert ivy["answer_updates"] == {BUILT_IN: an_update("Ivy Prints", None)}


def test_an_update_to_a_none_word_is_stored_as_a_blank_update(database):
    apps = [an_application("app-jo", "jo@example.com", {KEY: "Jo's Jams"},
                           {KEY: an_update("N/A", "Jo's Jams")})]
    db = database(a_market(), apps=apps)

    migrate(MARKET, KEY, db)

    assert application(db, "app-jo")["answer_updates"] == {BUILT_IN: an_update("", "Jo's Jams")}


def test_an_application_holding_another_business_name_keeps_it_and_its_id_is_printed(
        database, capsys):
    apps = [an_application("app-eve", "eve@example.com", {KEY: "Kiln Works", BUILT_IN: "Kiln & Co"},
                           {KEY: an_update("Kiln Works Ltd", "Kiln Works")})]
    db = database(a_market(), apps=apps)

    migrate(MARKET, KEY, db)

    eve = application(db, "app-eve")
    assert eve["form_data"][BUILT_IN] == "Kiln & Co"
    assert KEY not in eve["form_data"]
    assert eve.get("answer_updates") == {}
    out = capsys.readouterr().out
    assert "1 already holding another business name, kept" in out
    assert "kept, each holding another built-in business name: app-eve" in out


def test_the_form_loses_the_question_and_renumbers_the_rest(database):
    db = database(a_market())

    migrate(MARKET, KEY, db)

    market = stored(db)
    assert [(field["key"], field["order"]) for field in market["applicationForm"]["fields"]] == [
        ("product_type", 0), ("website", 1), ("table_size", 2)]
    assert market["formRevision"] == 5


def test_what_named_the_question_names_the_built_in(database):
    db = database(a_market())

    migrate(MARKET, KEY, db)

    market = stored(db)
    assert market["publicMap"] == {"enabled": False, "nameQuestion": BUILT_IN,
                                   "websiteQuestion": "website"}
    assert market["reviewHighlights"] == ["product_type", BUILT_IN, EF.FULL_NAME_KEY]
    assert market["importMapping"]["targets"] == {
        "applicant_email": ["Email Address"], BUILT_IN: ["Business Name"],
        "product_type": ["What do you sell?"]}
    assert market["importMapping"]["resolutions"] == {BUILT_IN: {"N/A": None}}
    assert market["importMapping"]["headers"] == _mapping()["headers"]
    assert [column["key"] for column in market["exampleColumns"]] == ["product_type"]


def test_a_highlight_already_on_the_built_in_is_not_listed_twice(database):
    db = database(a_market(reviewHighlights=[BUILT_IN, KEY, "product_type"]))

    migrate(MARKET, KEY, db)

    assert stored(db)["reviewHighlights"] == [BUILT_IN, "product_type"]


def test_a_public_map_naming_another_question_is_left(database):
    db = database(a_market(publicMap={"enabled": True, "nameQuestion": "product_type"}))

    migrate(MARKET, KEY, db)

    assert stored(db)["publicMap"] == {"enabled": True, "nameQuestion": "product_type"}


def test_a_market_with_no_highlight_mapping_or_map_takes_the_question_off_alone(database):
    doc = a_market(publicMap=None, reviewHighlights=None, importMapping=None, exampleColumns=None)
    db = database(copy.deepcopy(doc))

    migrate(MARKET, KEY, db)

    market = stored(db)
    for key in ("publicMap", "reviewHighlights", "importMapping", "exampleColumns"):
        assert market[key] is None


def _approved(apps):
    return [{**doc, "status": "reviewer_approved"} for doc in apps]


def settled():
    """A market in assignment with a plan that asks nothing its approved vendors lack, so a run
    made from them reads every one complete."""
    return a_market(MarketPhase.ASSIGNMENT, setupObject={
        "priority": [], "marketDates": [], "tiers": [], "locations": [], "sections": [],
        "assignmentOptions": {}})


def test_a_stored_run_that_matched_the_applications_still_does(database, applications):
    apps = _approved(the_applications())
    db = database(settled(), apps=apps)
    market = stored(db)
    market["assignmentObject"] = stored_assignment(
        "run", [], made_from=made_from_now(copy.deepcopy(market)), revision=3)
    was = market["assignmentObject"]["madeFrom"]["applications"]

    migrate(MARKET, KEY, db)

    after = stored(db)
    assert after["assignmentObject"]["madeFrom"]["applications"] != was
    assert after["assignmentObject"]["madeFrom"] == made_from_now(copy.deepcopy(after))
    assert after["assignmentObject"]["revision"] == 3


def test_a_stored_run_that_did_not_match_the_applications_is_left(database, capsys):
    apps = _approved(the_applications())
    db = database(settled(), apps=apps)
    market = stored(db)
    made = made_from_now(copy.deepcopy(market))
    market["assignmentObject"] = stored_assignment(
        "run", [], made_from={**made, "applications": "from-other-applications"}, revision=3)

    migrate(MARKET, KEY, db)

    assert stored(db)["assignmentObject"]["madeFrom"] == {
        **made, "applications": "from-other-applications"}
    assert ("the allocation's record of the applications: left as it is, since it already "
            "differs from the applications as read") in capsys.readouterr().out


# --- the history ---------------------------------------------------------------------------------

def test_a_run_records_one_form_change_with_no_actor_and_a_dry_run_none(database):
    db = database(a_market())

    migrate(MARKET, KEY, db, dry_run=True)
    assert db.history.documents == []

    migrate(MARKET, KEY, db)

    entries = db.history.documents
    assert [(entry["market_id"], entry["actor"], entry["action"], entry["kind"])
            for entry in entries] == [(MARKET, None, "change-form", "form")]
    detail = entries[0]["detail"]
    assert detail["before"]["questions"][KEY]["label"] == "Business name"
    assert detail["after"]["questions"][KEY] is None
    # The questions after it are renumbered, as a form save that took it off records them.
    assert detail["after"]["questions"]["website"]["order"] == 1
    assert detail["before"]["order"] == ["product_type", KEY, "website", "table_size"]
    assert detail["after"]["order"] == ["product_type", "website", "table_size"]
    assert (detail["rejected"], detail["returned"]) == (0, 0)


# --- a second run --------------------------------------------------------------------------------

def test_a_second_run_says_the_market_is_already_migrated_and_writes_nothing(database, capsys):
    db = database(a_market())
    migrate(MARKET, KEY, db)
    capsys.readouterr()
    before = everything(db)

    assert main(["--market", MARKET, "--question", KEY]) == 0

    assert everything(db) == before
    assert "already migrated" in capsys.readouterr().out


def test_a_run_finds_a_question_off_the_form_with_answers_left_and_finishes_it(database, capsys):
    doc = a_market()
    doc["applicationForm"]["fields"] = [
        field for field in doc["applicationForm"]["fields"] if field["key"] != KEY]
    db = database(doc)
    market_before = copy.deepcopy(stored(db))

    migrate(MARKET, KEY, db)

    out = capsys.readouterr().out
    assert "finishing a run: the form no longer asks 'business_name'" in out
    assert stored(db) == market_before
    assert db.history.documents == []
    assert application(db, "app-ana")["form_data"][BUILT_IN] == "Paper & Pine"
    assert all(KEY not in doc["form_data"] for doc in db.applications.documents)


def test_an_answer_changed_meanwhile_is_neither_copied_nor_cleared(database, capsys, monkeypatch):
    """A vendor who saves a new answer while the run copies the others keeps it under the
    question: the copy is held to the answer it read, and the clean leaves an answer not copied."""
    import migrate_business_name as Script

    db = database(a_market())
    copying = Script.copy_answers

    def a_vendor_saves_first(*args, **kwargs):
        application(db, "app-ana")["form_data"][KEY] = "Paper & Pine Studio"
        return copying(*args, **kwargs)

    monkeypatch.setattr(Script, "copy_answers", a_vendor_saves_first)

    migrate(MARKET, KEY, db)

    ana = application(db, "app-ana")
    assert (ana["form_data"].get(BUILT_IN), ana["form_data"][KEY]) == (None, "Paper & Pine Studio")
    assert "1 application(s) changed during the run and were left: run it again" in (
        capsys.readouterr().out)

    migrate(MARKET, KEY, db)

    ana = application(db, "app-ana")
    assert (ana["form_data"][BUILT_IN], KEY in ana["form_data"]) == ("Paper & Pine Studio", False)


# --- refusals ------------------------------------------------------------------------------------

def _with_field(key, kind, **extra):
    fields = _fields() + [{"key": key, "label": key, "type": kind, "order": 4, **extra}]
    return {"fields": fields, "essentialOptions": None}


REFUSALS = [
    ("a question not of type text", {}, "table_size", "is a select question, not a short text"),
    ("an essential key", {}, BUILT_IN, "is a built-in question's key"),
    ("an essential key not on the form", {}, "essential_trade_name",
     "is a built-in question's key"),
    ("the website choice", {"publicMap": {"enabled": False, "websiteQuestion": KEY}}, KEY,
     "The public map's website question names it"),
    ("the Instagram choice", {"publicMap": {"enabled": False, "instagramQuestion": KEY}}, KEY,
     "The public map's Instagram question names it"),
    ("the Discord username question", {"discord": {"usernameQuestion": KEY}}, KEY,
     "Discord's username question names it"),
    ("a priority rule", {"setupObject": {
        "priority": [{"id": 0, "target": KEY, "ordering": []}], "marketDates": [], "tiers": [],
        "locations": [], "sections": [], "assignmentOptions": {}}}, KEY,
     "A priority rule names it"),
    ("a price group", {"setupObject": {
        "priority": [], "marketDates": [], "tiers": [], "locations": [], "sections": [],
        "assignmentOptions": {},
        "pricing": {"groups": [{"name": "Makers", "conditions": [{"key": KEY, "answers": ["x"]}],
                                "prices": []}], "everyoneElse": []}}}, KEY,
     "The price group 'Makers' names it"),
    ("a rejection rule", {"rejectionRules": [{"key": KEY, "answers": ["x"]}]}, KEY,
     "A rejection rule names it"),
    ("a mapping already targeting the built-in", {"importMapping": {
        **_mapping(), "targets": {**_mapping()["targets"], BUILT_IN: ["Trading as"]}}}, KEY,
     "The saved import mapping already maps a column to the built-in business name"),
]


@pytest.mark.parametrize("change, question, words", [refusal[1:] for refusal in REFUSALS],
                         ids=[refusal[0] for refusal in REFUSALS])
def test_it_refuses_writes_nothing_and_exits_one(database, capsys, change, question, words):
    db = database(a_market(**change))
    before = everything(db)

    with pytest.raises(Refused, match=words):
        migrate(MARKET, question, db)
    assert everything(db) == before

    assert main(["--market", MARKET, "--question", question]) == 1
    assert words in capsys.readouterr().err
    assert everything(db) == before


@pytest.mark.parametrize("market_id, docs", [
    ("market-none", lambda: [a_market()]),
    (MARKET, lambda: [a_market(deleting={"at": "2099-07-01T00:00:00+00:00", "by": "user-1",
                                         "trail_id": "t-1"})]),
], ids=["not found", "being deleted"])
def test_it_refuses_a_market_not_found_or_being_deleted(database, capsys, market_id, docs):
    db = database(*docs())
    before = everything(db)

    assert main(["--market", market_id, "--question", KEY]) == 1

    assert "no live market has the id" in capsys.readouterr().err.lower()
    assert everything(db) == before


def test_it_refuses_a_market_changed_between_the_read_and_the_write(
        database, capsys, monkeypatch):
    import migrate_business_name as Script

    db = database(a_market())
    copying = Script.copy_answers

    def an_organizer_saves_the_form_meanwhile(*args, **kwargs):
        result = copying(*args, **kwargs)
        write_market(copy.deepcopy(stored(db)), {"$set": {"applicationForm.fields": _fields()}},
                     revisions={"formRevision": 4})
        return result

    monkeypatch.setattr(Script, "copy_answers", an_organizer_saves_the_form_meanwhile)

    with pytest.raises(LeftAfterStepOne, match="The market changed between the read and the write"):
        migrate(MARKET, KEY, db)

    market = stored(db)
    assert KEY in [field["key"] for field in market["applicationForm"]["fields"]]
    assert (market["formRevision"], market["publicMap"]["nameQuestion"]) == (5, KEY)
    assert db.history.documents == []
    # Nothing is cleaned: every vendor still holds their answer under the question.
    assert application(db, "app-ana")["form_data"][KEY] == " Paper & Pine "
    # Step 1's copy stays, and a second run finds it copied and finishes the move.
    assert application(db, "app-ana")["form_data"][BUILT_IN] == "Paper & Pine"
    monkeypatch.setattr(Script, "copy_answers", copying)

    assert main(["--market", MARKET, "--question", KEY]) == 0

    assert KEY not in [field["key"] for field in stored(db)["applicationForm"]["fields"]]
    assert len(db.history.documents) == 1


def test_the_command_says_a_run_stopped_after_step_one_and_exits_one(
        database, capsys, monkeypatch):
    import migrate_business_name as Script

    db = database(a_market())
    copying = Script.copy_answers

    def an_import_saves_its_mapping_meanwhile(*args, **kwargs):
        result = copying(*args, **kwargs)
        stored(db)["importMapping"] = {**_mapping(), "savedAt": "2099-07-02T00:00:00+00:00"}
        return result

    monkeypatch.setattr(Script, "copy_answers", an_import_saves_its_mapping_meanwhile)

    assert main(["--market", MARKET, "--question", KEY]) == 1

    assert "stopped after step 1: The market changed" in capsys.readouterr().err
    assert KEY in [field["key"] for field in stored(db)["applicationForm"]["fields"]]


def test_a_market_deleted_under_the_write_says_step_one_copied(database, capsys, monkeypatch):
    import migrate_business_name as Script

    db = database(a_market())

    def the_market_is_deleted_meanwhile(*args, **kwargs):
        raise MarketWrite.MarketNotFoundError("Market not found")

    monkeypatch.setattr(Script, "write_market", the_market_is_deleted_meanwhile)

    assert main(["--market", MARKET, "--question", KEY]) == 1

    err = capsys.readouterr().err
    assert "stopped after step 1: The market is gone, or being deleted" in err
    assert "nothing written" not in err
    # Step 1 copied before the write was refused, which the command says rather than hiding.
    assert application(db, "app-ana")["form_data"][BUILT_IN] == "Paper & Pine"
    assert db.history.documents == []
