"""Every (state, event) of an application's review state, through the routes (T277 ticket 02).

An application is in one of six states: open, waiting on a follow-up, approved by a person or by
being added, rejected by a person or by a rule. Each state below is reached the way an organizer
reaches it, each event is sent as its route takes it, and every cell asserts what the route
answered, the state stored after it and what the market's history recorded. A stale-read cell per
event lands another write between the event's read and its own, and the event writes nothing
over it. The pure ``move`` is checked over the same grid, so a preview reads the table the writes
do. The table itself is stated once, in ``docs/implementation/data/application-document.md``.

Every move into open, and a follow-up's hand-on, marks the application for the deal by the write
it came by (``arriving``), and every cell asserts the mark it leaves. Changed answers are one event whoever
changes them (decision 9.1): the applicant's save, an import row and an organizer's update each
have a column, and the "(none)" row is the applicant's first save and an import's new row.

The Editor gives verdicts but may not change one; the Admin and the owner may. ``app-v1`` answers
that it is not a student and did not tick the no-shows box, so rule A (affiliation) and rule B (no
shows) each meet it.
"""
from typing import Callable, Dict, Optional, Tuple

import pytest

from conftest import applicant_form_version_now, seen_as_stored
from test_choosing_reviewers_deals_the_open_applications import (  # noqa: F401  (the fixture)
    ADMIN, EDITOR, MARKET, OWNER, _client, world,
)

import api.applicants as ApplicantsApi
import api.applications as ApplicationsApi
import application_status as ReviewState
import db_config
import history as History
import market_write as MarketWrite
from datatypes import ApplicationStatus, MarketPerson, VerdictGiver

State = ReviewState.State
APP = "app-v1"
OUTSIDER = "No, I am not a student"
FIELDS = [
    {"key": "affiliation", "label": "Are you a student?", "type": "select",
     "options": ["Yes, a student", OUTSIDER]},
    {"key": "no_shows", "label": "I understand that no-shows", "type": "checkbox"},
    {"key": "shop", "label": "Shop", "type": "text"},
]
VENDOR = "v1@vendor.test"
#: ``app-v1``'s answers as a changed-answers event writes them: a new shop, whatever writes it, and
#: the same answers the rules read, so a rule's rejection still meets them.
CHANGED = {"affiliation": OUTSIDER, "no_shows": False, "shop": "Kiln",
           "essential_full_name": "V One"}
#: The same, as a row of an import, mapped by column.
ROW_HEADERS = "Email,Name,Student,No shows,Shop"
ROW_MAPPING = {"applicant_email": 0, "essential_full_name": 1, "affiliation": 2, "no_shows": 3,
               "shop": 4}
RULE_A = {"key": "affiliation", "answers": [OUTSIDER]}
REASON_A = f"Answered “{OUTSIDER}” to “Are you a student?”"
RULE_B = {"key": "no_shows", "answers": ["not ticked"]}
REASON_B = "Did not tick “I understand that no-shows”"
CHANGE_REFUSED = (
    "Only an Admin or the owner may change a verdict or overturn an automatic rejection on this "
    "market.")
UNDO_REFUSED = "This verdict can no longer be undone here. An Admin or the owner can change it."
NOT_A_FOLLOW_UP = "Only an application that needs a follow-up has an owner."
ADDED_ONLY_REJECTED = "A vendor added by hand can only be rejected."
#: Who the stale-read cells' write in between is: the Admin, approving.
IN_BETWEEN = f"{ADMIN} approved this application since you opened it."


@pytest.fixture
def market(world, monkeypatch):
    """The world's market with a form the rules can judge, and ``app-v1`` answering it; the rules'
    own write lands on it too, and so does an applicant's save, signed in as ``app-v1``'s."""
    markets = world.market(applicationForm={"fields": FIELDS}, intakeMode="form")
    monkeypatch.setattr(MarketWrite, "markets_collection", markets)
    monkeypatch.setattr(db_config, "get_database", lambda *_a, **_k: {"markets": markets})
    monkeypatch.setattr(ApplicantsApi, "authenticate_request",
                        lambda _header: {"market_id": MARKET, "email": VENDOR})
    _doc(world)["form_data"] = {"affiliation": OUTSIDER, "no_shows": False}
    return world


def _doc(world, app_id=APP):
    return next(d for d in world.applications.documents if d["id"] == app_id)


def _ok(response):
    assert response.status_code == 200, response.get_json()
    return response.get_json()


# --- The states, each reached as an organizer reaches it ------------------------------------------

def _verdict(who, status, app_id=APP, **body):
    return _client(who).put(f"/markets/{MARKET}/applications/{app_id}/review",
                            json={"status": status, "seen": seen_as_stored(app_id), **body})


def _rules(*rules, who=OWNER):
    return _client(who).put(f"/markets/{MARKET}/rejection-rules", json={"rules": list(rules)})


def open_(world):
    pass


def follow_up(world):
    _ok(_verdict(EDITOR, "needs_follow_up"))


def approved_by_a_person(world):
    _ok(_verdict(EDITOR, "reviewer_approved"))


def approved_added(world):
    """As adding a vendor stores one (``ReviewState``'s ``add``), but for its origin, which
    ``origin_of`` reads off ``added_by``: adding is the Assignment phase's, and this table's events
    are the review's."""
    adder = MarketPerson(user_id="user-admin", email=ADMIN)
    _doc(world).update(status="reviewer_approved", verdict_by=adder.as_giver().model_dump(),
                       verdict_at="2026-10-21T00:00:00+00:00", added_by=adder.model_dump(),
                       added_at="2026-10-21T00:00:00+00:00", submitted_at=None)


def rejected_by_a_person(world):
    _ok(_verdict(EDITOR, "reviewer_rejected"))


def rejected_by_a_rule(world):
    _ok(_rules(RULE_A))


STATES: Dict[State, Callable] = {
    State.OPEN: open_,
    State.FOLLOW_UP: follow_up,
    State.APPROVED_BY_A_PERSON: approved_by_a_person,
    State.APPROVED_ADDED: approved_added,
    State.REJECTED_BY_A_PERSON: rejected_by_a_person,
    State.REJECTED_BY_A_RULE: rejected_by_a_rule,
}


# --- The events, each sent as its route takes it --------------------------------------------------

def give(world):
    """The Editor, who gives verdicts but may not change one, approves it as they see it."""
    return _verdict(EDITOR, "reviewer_approved")


def change(world):
    """The Admin, who may change a verdict, writes the other verdict over it as they see it."""
    approved = ReviewState.state_of(_doc(world)) in (State.APPROVED_BY_A_PERSON,
                                                     State.APPROVED_ADDED)
    return _verdict(ADMIN, "reviewer_rejected" if approved else "reviewer_approved")


def undo(world):
    """The Editor undoes what they gave, as their card shows it."""
    return _client(EDITOR).post(f"/markets/{MARKET}/applications/{APP}/review/undo",
                                json={"seen": seen_as_stored(APP)})


def rule_rejects(world):
    """The owner sets rule B alone, which meets ``app-v1``'s answers."""
    return _rules(RULE_B)


def rule_returns(world):
    """The owner, who may overturn an automatic rejection, takes every rule away."""
    return _rules()


def hand_on(world):
    """The Editor hands the follow-up to the Admin."""
    return _client(EDITOR).put(f"/markets/{MARKET}/applications/{APP}/follow-up-owner",
                               json={"ownerEmail": ADMIN})


def applicant_saves(world):
    """``app-v1``'s applicant saves a new shop on their page."""
    from app import app

    return app.test_client().put("/public/markets/test-market/applicant/application",
                                 json={"formData": CHANGED,
                                       "formVersion": applicant_form_version_now("test-market")})


def an_import_row(world, vendor=VENDOR):
    """The Admin imports a file whose row for ``app-v1`` has a new shop: the market's vendors are
    imported from here on."""
    world.markets.doc["intakeMode"] = "csv"
    row = f'{vendor},{CHANGED["essential_full_name"]},"{OUTSIDER}",,{CHANGED["shop"]}'
    return _client(ADMIN).post(f"/markets/{MARKET}/applications/import", json={
        "csvContent": f"{ROW_HEADERS}\n{row}", "mapping": ROW_MAPPING})


def an_organizer_updates(world):
    """The Admin updates ``app-v1``'s shop, kept beside what the vendor wrote."""
    return _client(ADMIN).put(f"/markets/{MARKET}/applications/{APP}/answers",
                              json={"answers": {"shop": CHANGED["shop"]}})


EVENTS: Dict[str, Callable] = {
    "give": give, "change": change, "undo": undo, "rule_rejects": rule_rejects,
    "rule_returns": rule_returns, "hand_on": hand_on, "applicant_saves": applicant_saves,
    "an_import_row": an_import_row, "an_organizer_updates": an_organizer_updates,
}


# --- The table: what each cell answers, the state after it, and its history entry -----------------

#: (status, the error answered or None, the state after, the history entry's (kind, action) or
#: None). A refused cell leaves the state as it was.
Cell = Tuple[int, Optional[str], State, Optional[Tuple[str, str]]]
_GIVEN = (History.VERDICT, "give-verdicts")
_CHANGED = (History.VERDICT, "change-verdicts")
_UNDONE = (History.VERDICT_UNDONE, "give-verdicts")
_RULES = (History.REJECTION_RULES, "change-form")
_HANDED = (History.FOLLOW_UP_OWNER, "give-verdicts")
_EDITED = (History.EDITED, History.APPLY)
_IMPORTED = (History.IMPORTED, "import-applications")
_UPDATED = (None, "update-vendor-info")


def _refused(state: State, code: int, error: Optional[str]) -> Cell:
    return (code, error, state, None)


TABLE: Dict[Tuple[State, str], Cell] = {
    # give verdict (a person): from an application awaiting one; on a decided one it is a change,
    # which the Editor may not make.
    (State.OPEN, "give"): (200, None, State.APPROVED_BY_A_PERSON, _GIVEN),
    (State.FOLLOW_UP, "give"): (200, None, State.APPROVED_BY_A_PERSON, _GIVEN),
    **{(state, "give"): _refused(state, 403, CHANGE_REFUSED) for state in (
        State.APPROVED_BY_A_PERSON, State.APPROVED_ADDED, State.REJECTED_BY_A_PERSON,
        State.REJECTED_BY_A_RULE)},
    # change verdict: over a verdict; on an application awaiting one the route gives instead.
    (State.OPEN, "change"): (200, None, State.APPROVED_BY_A_PERSON, _GIVEN),
    (State.FOLLOW_UP, "change"): (200, None, State.APPROVED_BY_A_PERSON, _GIVEN),
    (State.APPROVED_BY_A_PERSON, "change"): (200, None, State.REJECTED_BY_A_PERSON, _CHANGED),
    (State.APPROVED_ADDED, "change"): (200, None, State.REJECTED_BY_A_PERSON, _CHANGED),
    (State.REJECTED_BY_A_PERSON, "change"): (200, None, State.APPROVED_BY_A_PERSON, _CHANGED),
    (State.REJECTED_BY_A_RULE, "change"): (200, None, State.APPROVED_BY_A_PERSON, _CHANGED),
    # undo (its giver, in the window): only of a verdict given on one awaiting it.
    (State.OPEN, "undo"): _refused(State.OPEN, 403, UNDO_REFUSED),
    (State.FOLLOW_UP, "undo"): (200, None, State.OPEN, _UNDONE),
    (State.APPROVED_BY_A_PERSON, "undo"): (200, None, State.OPEN, _UNDONE),
    (State.APPROVED_ADDED, "undo"): _refused(State.APPROVED_ADDED, 403, UNDO_REFUSED),
    (State.REJECTED_BY_A_PERSON, "undo"): (200, None, State.OPEN, _UNDONE),
    (State.REJECTED_BY_A_RULE, "undo"): _refused(State.REJECTED_BY_A_RULE, 403, UNDO_REFUSED),
    # rule rejects: an open one, or a rule's rejection again by another rule; a person's verdict
    # and a follow-up are never judged. The rules' write is answered and recorded either way.
    (State.OPEN, "rule_rejects"): (200, None, State.REJECTED_BY_A_RULE, _RULES),
    **{(state, "rule_rejects"): (200, None, state, _RULES) for state in (
        State.FOLLOW_UP, State.APPROVED_BY_A_PERSON, State.APPROVED_ADDED,
        State.REJECTED_BY_A_PERSON)},
    (State.REJECTED_BY_A_RULE, "rule_rejects"): (200, None, State.REJECTED_BY_A_RULE, _RULES),
    # rule returns: only a rule's rejection, to open. With no rule to take away, nothing changed,
    # so nothing is recorded.
    **{(state, "rule_returns"): (200, None, state, None) for state in (
        State.OPEN, State.FOLLOW_UP, State.APPROVED_BY_A_PERSON, State.APPROVED_ADDED,
        State.REJECTED_BY_A_PERSON)},
    (State.REJECTED_BY_A_RULE, "rule_returns"): (200, None, State.OPEN, _RULES),
    # hand on the follow-up: only a follow-up.
    (State.FOLLOW_UP, "hand_on"): (200, None, State.FOLLOW_UP, _HANDED),
    **{(state, "hand_on"): _refused(state, 409, NOT_A_FOLLOW_UP) for state in (
        State.OPEN, State.APPROVED_BY_A_PERSON, State.APPROVED_ADDED, State.REJECTED_BY_A_PERSON,
        State.REJECTED_BY_A_RULE)},
    # answers changed by the applicant or an import (decision 9.1): a person's verdict back to
    # open; an added vendor approved, an applicant now; a rule's rejection the rules judge again,
    # which still meets it; open and follow-up stay.
    **{(state, event): (200, None, after, entry)
       for event, entry in (("applicant_saves", _EDITED), ("an_import_row", _IMPORTED))
       for state, after in (
           (State.OPEN, State.OPEN), (State.FOLLOW_UP, State.FOLLOW_UP),
           (State.APPROVED_BY_A_PERSON, State.OPEN),
           (State.APPROVED_ADDED, State.APPROVED_BY_A_PERSON),
           (State.REJECTED_BY_A_PERSON, State.OPEN),
           (State.REJECTED_BY_A_RULE, State.REJECTED_BY_A_RULE))},
    # answers changed by an organizer: every verdict kept, since they made both.
    **{(state, "an_organizer_updates"): (200, None, state, _UPDATED) for state in State},
}


#: The cells that move an application into open or follow-up, each marking it for the deal by its
#: route's write: who made it, and by which action. Every other cell leaves no mark.
MARKED: Dict[Tuple[State, str], Dict[str, str]] = {
    **{(state, "undo"): {"actor": EDITOR, "action": "give-verdicts"} for state in (
        State.FOLLOW_UP, State.APPROVED_BY_A_PERSON, State.REJECTED_BY_A_PERSON)},
    (State.REJECTED_BY_A_RULE, "rule_returns"): {"actor": OWNER, "action": "change-form"},
    (State.FOLLOW_UP, "hand_on"): {"actor": EDITOR, "action": "give-verdicts"},
    **{(state, "applicant_saves"): {"actor": VENDOR, "action": History.APPLY}
       for state in (State.APPROVED_BY_A_PERSON, State.REJECTED_BY_A_PERSON)},
    **{(state, "an_import_row"): {"actor": ADMIN, "action": "import-applications"}
       for state in (State.APPROVED_BY_A_PERSON, State.REJECTED_BY_A_PERSON)},
}


def test_the_table_holds_every_pair():
    assert set(TABLE) == {(state, event) for state in STATES for event in EVENTS}
    assert set(MARKED) <= set(TABLE)


def _entries_after(world, before):
    return world.history.documents[before:]


@pytest.mark.parametrize("state", STATES, ids=lambda s: s.value)
@pytest.mark.parametrize("event", EVENTS)
def test_each_cell(market, state, event):
    STATES[state](market)
    assert ReviewState.state_of(_doc(market)) is state
    recorded = len(market.history.documents)

    response = EVENTS[event](market)

    code, error, after, entry = TABLE[(state, event)]
    assert response.status_code == code, response.get_json()
    if error is not None:
        assert response.get_json()["error"] == error
    assert ReviewState.state_of(_doc(market)) is after
    assert _doc(market).get(ApplicationsApi.ARRIVING_FIELD) == MARKED.get((state, event))
    entries = _entries_after(market, recorded)
    if entry is None:
        assert entries == []
    else:
        assert [(e["kind"], e["action"]) for e in entries] == [entry]
    if event == "applicant_saves":
        # Their entry says when their save sent a verdict back (decision 9.1).
        assert entries[0]["detail"].get("returned_to_review", False) is (
            (state, event) in MARKED)


#: The "(none)" row: an application arrives, by the applicant's first save or an import's new row,
#: open, with its origin and marked for the deal by its write; an organizer has none to update.
NEW_VENDOR = "v9@vendor.test"
ARRIVES: Dict[str, Tuple[str, Dict[str, str]]] = {
    "applicant_saves": ("applied", {"actor": NEW_VENDOR, "action": History.APPLY}),
    "an_import_row": ("imported", {"actor": ADMIN, "action": "import-applications"}),
}


@pytest.mark.parametrize("event", [*ARRIVES, "an_organizer_updates"])
def test_the_none_row(market, monkeypatch, event):
    monkeypatch.setattr(ApplicantsApi, "authenticate_request",
                        lambda _header: {"market_id": MARKET, "email": NEW_VENDOR})
    if event == "an_organizer_updates":
        response = _client(ADMIN).put(f"/markets/{MARKET}/applications/app-none/answers",
                                      json={"answers": {"shop": "Kiln"}})
        assert response.status_code == 404
        return
    _ok(applicant_saves(market) if event == "applicant_saves"
        else an_import_row(market, NEW_VENDOR))

    [doc] = [d for d in market.applications.documents if d["applicant_email"] == NEW_VENDOR]
    origin, mark = ARRIVES[event]
    assert (ReviewState.state_of(doc), doc["origin"]) == (State.OPEN, origin)
    assert doc[ApplicationsApi.ARRIVING_FIELD] == mark
    assert doc["form_data"]["shop"] == "Kiln"


class TestWhatACellWrites:
    def test_a_verdict_given_keeps_what_its_undo_returns_to(self, market):
        follow_up(market)

        _ok(give(market))

        kept = _doc(market)["undo_to"]
        assert kept["status"] == "needs_follow_up"
        assert kept["follow_up_owner"]["email"] == EDITOR

    def test_a_verdict_changed_keeps_nothing_to_undo(self, market):
        approved_by_a_person(market)

        _ok(change(market))

        assert "undo_to" not in _doc(market)

    def test_a_rules_rejection_says_its_rule_and_reason(self, market):
        _ok(rule_rejects(market))

        doc = _doc(market)
        assert doc["verdict_by"] == {"kind": "rule", "rule": "no_shows", "user_id": None,
                                     "email": None}
        assert doc["verdict_reason"] == REASON_B

    def test_a_rules_rejection_again_by_another_rule_says_the_new_reason(self, market):
        rejected_by_a_rule(market)
        assert _doc(market)["verdict_reason"] == REASON_A

        body = _rules(RULE_B)

        assert body.status_code == 200
        assert _doc(market)["verdict_reason"] == REASON_B
        [entry] = [e for e in market.history.documents if e["kind"] == History.REJECTION_RULES][-1:]
        assert entry["detail"]["rejected"] == 1

    def test_a_rules_rejection_by_the_same_rule_is_not_written_again(self, market):
        rejected_by_a_rule(market)
        before = dict(_doc(market))

        _ok(_rules(RULE_A, RULE_B))

        assert _doc(market) == before

    def test_a_return_to_open_clears_the_verdict(self, market):
        rejected_by_a_rule(market)

        _ok(rule_returns(market))

        doc = _doc(market)
        assert doc["status"] == "open"
        assert not {"verdict_by", "verdict_at", "verdict_reason", "undo_to"} & set(doc)

    def test_a_hand_on_keeps_what_the_undo_returns_to(self, market):
        _ok(_verdict(EDITOR, "needs_follow_up"))
        kept = _doc(market)["undo_to"]

        _ok(hand_on(market))

        assert _doc(market)["undo_to"] == kept
        assert _doc(market)["follow_up_owner"]["email"] == ADMIN

    def test_a_verdict_ends_the_wait_for_the_deal(self, market):
        _doc(market)["arriving"] = {"actor": "v1@vendor.test", "action": "apply"}

        _ok(give(market))

        assert "arriving" not in _doc(market)

    def test_a_follow_up_keeps_its_wait_for_the_deal(self, market):
        _doc(market)["arriving"] = {"actor": "v1@vendor.test", "action": "apply"}

        _ok(_verdict(EDITOR, "needs_follow_up"))

        assert _doc(market)["arriving"] == {"actor": "v1@vendor.test", "action": "apply"}

    def test_a_verdict_keeps_whose_share_it_was(self, market):
        _doc(market)["reviewer"] = {"user_id": "user-editor", "email": EDITOR}

        _ok(give(market))

        assert _doc(market)["reviewer"] == {"user_id": "user-editor", "email": EDITOR}


class TestAnAddedVendor:
    @pytest.mark.parametrize("status", ["reviewer_approved", "needs_follow_up"])
    def test_changes_only_to_rejected(self, market, status):
        approved_added(market)
        before = dict(_doc(market))

        response = _verdict(ADMIN, status)

        assert response.status_code == 400
        assert response.get_json() == {"error": ADDED_ONLY_REJECTED}
        assert _doc(market) == before

    def test_in_a_selection_is_skipped_with_why(self, market):
        approved_added(market)

        response = _client(ADMIN).post(f"/markets/{MARKET}/applications/verdicts", json={
            "status": "needs_follow_up",
            "applications": [{"id": APP, "seen": seen_as_stored(APP)}]})

        assert _ok(response)["skipped"] == [
            {"id": APP, "email": "v1@vendor.test", "reason": ADDED_ONLY_REJECTED}]

    def test_rejected_then_approved_again_reads_as_added(self, market):
        approved_added(market)
        _ok(_verdict(ADMIN, "reviewer_rejected"))

        _ok(_verdict(ADMIN, "reviewer_approved"))

        assert ReviewState.state_of(_doc(market)) is State.APPROVED_ADDED


class TestARuleOverturnedByAPerson:
    def test_is_a_change_refused_to_who_may_not_change_a_verdict(self, market):
        rejected_by_a_rule(market)

        response = _verdict(EDITOR, "reviewer_approved")

        assert response.status_code == 403
        assert response.get_json() == {"error": CHANGE_REFUSED}

    def test_is_a_change_for_who_may(self, market):
        rejected_by_a_rule(market)

        _ok(_verdict(ADMIN, "reviewer_approved"))

        [entry] = [e for e in market.history.documents if e["kind"] == History.VERDICT]
        assert entry["action"] == "change-verdicts"
        assert "verdict_reason" not in _doc(market)


class TestAVerdictSaysWhatWasSeen:
    def test_one_naming_nothing_is_refused(self, market):
        response = _client(EDITOR).put(f"/markets/{MARKET}/applications/{APP}/review",
                                       json={"status": "reviewer_approved"})

        assert response.status_code == 400
        assert response.get_json() == {"error": "Say what the application was when you opened it."}
        assert _doc(market)["status"] == "open"

    def test_a_selections_entry_naming_nothing_is_skipped_with_why(self, market):
        response = _client(EDITOR).post(f"/markets/{MARKET}/applications/verdicts", json={
            "status": "reviewer_approved",
            "applications": [{"id": APP}, {"id": "app-v2", "seen": seen_as_stored("app-v2")}]})

        body = _ok(response)
        assert body["written"] == ["app-v2"]
        assert body["skipped"] == [{"id": APP, "email": "v1@vendor.test",
                                    "reason": "Say what the application was when you opened it."}]
        assert _doc(market)["status"] == "open"


# --- A stale read: another write lands between the event's read and its own ----------------------

def _the_admin_approves_before_the_next_held_write(monkeypatch, world):
    """Land the Admin's approval just before the next write of the review state that holds what
    it read, as a reviewer in another tab would."""
    collection = ApplicationsApi.applications_collection
    write = collection.update_one
    landed = []

    def update_one(query, update):
        held = "status" in query and query.get("id") == APP
        if held and not landed:
            landed.append(True)
            write({"id": APP}, {"$set": {
                "status": "reviewer_approved", "verdict_at": "2026-10-22T00:00:00+00:00",
                "verdict_by": {"kind": "person", "user_id": "user-admin", "email": ADMIN}},
                "$unset": {"verdict_reason": "", "follow_up_owner": "", "undo_to": ""}})
        return write(query, update)

    monkeypatch.setattr(collection, "update_one", update_one)
    return landed


#: Each event, from a state it moves, and what its route answers when the Admin's approval lands
#: in between: the stale sentence for a person, nothing written for the rules.
STALE: Dict[str, Tuple[State, int, Optional[str]]] = {
    "give": (State.OPEN, 409, IN_BETWEEN),
    "change": (State.REJECTED_BY_A_PERSON, 409, IN_BETWEEN),
    "undo": (State.REJECTED_BY_A_PERSON, 409, IN_BETWEEN),
    "rule_rejects": (State.OPEN, 200, None),
    "rule_returns": (State.REJECTED_BY_A_RULE, 200, None),
    "hand_on": (State.FOLLOW_UP, 409, NOT_A_FOLLOW_UP),
}


@pytest.mark.parametrize("event", STALE)
def test_a_stale_read_writes_nothing_over_what_landed(monkeypatch, market, event):
    state, code, error = STALE[event]
    STATES[state](market)
    landed = _the_admin_approves_before_the_next_held_write(monkeypatch, market)

    response = EVENTS[event](market)

    assert landed == [True]
    assert response.status_code == code, response.get_json()
    if error is not None:
        assert response.get_json()["error"] == error
    doc = _doc(market)
    assert doc["status"] == "reviewer_approved"
    assert doc["verdict_by"]["email"] == ADMIN
    assert doc["verdict_at"] == "2026-10-22T00:00:00+00:00"


@pytest.mark.parametrize("event", ["applicant_saves", "an_import_row"])
def test_a_stale_read_of_changed_answers_lands_on_what_is_stored(monkeypatch, market, event):
    """Changed answers are read again, not refused: the save lands on the approval that landed in
    between, and sends it back to open with the answers nobody judged."""
    landed = _the_admin_approves_before_the_next_held_write(monkeypatch, market)

    body = _ok(EVENTS[event](market))

    assert landed == [True]
    doc = _doc(market)
    assert (ReviewState.state_of(doc), doc["form_data"]["shop"]) == (State.OPEN, "Kiln")
    if event == "an_import_row":
        assert (body["updated"], body["returnedToReview"]) == (1, 1)
    else:
        [entry] = [e for e in market.history.documents if e["kind"] == History.EDITED]
        assert entry["detail"]["returned_to_review"] is True


# --- The pure move, over the same grid ------------------------------------------------------------

EDITOR_GIVER = VerdictGiver(kind="person", user_id="user-editor", email=EDITOR)
ADMIN_GIVER = VerdictGiver(kind="person", user_id="user-admin", email=ADMIN)
#: The write a pure event came by, which a move into open or follow-up marks for the deal.
ARRIVAL = ReviewState.Arrival(EDITOR, "give-verdicts")


def _stored(state: State) -> dict:
    """An application in ``state`` as it is stored, the Editor's verdict given a moment ago on one
    awaiting it, so their undo is in the window."""
    import datetime as dt

    now = dt.datetime.now(dt.timezone.utc).isoformat()
    editor = EDITOR_GIVER.model_dump()
    was_open = {"status": "open", "verdict_by": None, "verdict_at": None, "follow_up_owner": None}
    base = {"id": APP, "status": "open", "verdict_at": None, "updated_at": "2026-10-20T00:00:00Z"}
    return {
        State.OPEN: base,
        State.FOLLOW_UP: {**base, "status": "needs_follow_up", "verdict_by": editor,
                          "verdict_at": now, "undo_to": was_open,
                          "follow_up_owner": {"user_id": "user-editor", "email": EDITOR}},
        State.APPROVED_BY_A_PERSON: {**base, "status": "reviewer_approved", "verdict_by": editor,
                                     "verdict_at": now, "undo_to": was_open},
        State.APPROVED_ADDED: {**base, "status": "reviewer_approved", "verdict_by": editor,
                               "verdict_at": now, "added_by": {"email": ADMIN}},
        State.REJECTED_BY_A_PERSON: {**base, "status": "reviewer_rejected", "verdict_by": editor,
                                     "verdict_at": now, "undo_to": was_open},
        State.REJECTED_BY_A_RULE: {**base, "status": "reviewer_rejected", "verdict_at": now,
                                   "verdict_by": {"kind": "rule", "rule": "affiliation"},
                                   "verdict_reason": REASON_A},
    }[state]


#: The pure events: the routes' ``give`` and ``change`` as the person's own events (each from any
#: state), so ``move`` is seen to refuse what the route never sends.
MOVES: Dict[str, Callable[[State], ReviewState.Event]] = {
    "give": lambda state: ReviewState.GiveVerdict(
        ApplicationStatus.REVIEWER_APPROVED, EDITOR_GIVER),
    "change": lambda state: ReviewState.ChangeVerdict(
        ApplicationStatus.REVIEWER_REJECTED
        if state in (State.APPROVED_BY_A_PERSON, State.APPROVED_ADDED)
        else ApplicationStatus.REVIEWER_APPROVED,
        ADMIN_GIVER),
    "undo": lambda state: ReviewState.Undo("user-editor", ARRIVAL),
    "rule_rejects": lambda state: ReviewState.RuleRejects("no_shows", REASON_B),
    "rule_returns": lambda state: ReviewState.RuleReturns(ARRIVAL),
    "hand_on": lambda state: ReviewState.HandOnFollowUp(
        MarketPerson(user_id="u", email=ADMIN), ARRIVAL),
    # Answers changed from what each state's application stores, which names no shop.
    "answers_applicant": lambda state: ReviewState.AnswersChanged(
        ReviewState.Source.APPLICANT, {"shop": "Kiln"}, ARRIVAL),
    "answers_import": lambda state: ReviewState.AnswersChanged(
        ReviewState.Source.IMPORT, {"shop": "Kiln"}, ARRIVAL),
    "answers_organizer": lambda state: ReviewState.AnswersChanged(ReviewState.Source.ORGANIZER),
}
#: The pure events whose every move is into open or follow-up, so marks for the deal.
MARKING = ("undo", "rule_returns", "hand_on")
#: The changed answers' moves that send a person's verdict back to open, marked (decision 9.1).
RETURNING = {(state, f"answers_{source}") for state in (State.APPROVED_BY_A_PERSON,
                                                         State.REJECTED_BY_A_PERSON)
             for source in ("applicant", "import")}

_DECIDED = (State.APPROVED_BY_A_PERSON, State.APPROVED_ADDED, State.REJECTED_BY_A_PERSON,
            State.REJECTED_BY_A_RULE)
#: The state each pure move leaves, or None where the table refuses it.
MOVED: Dict[Tuple[State, str], Optional[State]] = {
    **{(state, "give"): State.APPROVED_BY_A_PERSON for state in (State.OPEN, State.FOLLOW_UP)},
    **{(state, "give"): None for state in _DECIDED},
    **{(state, "change"): None for state in (State.OPEN, State.FOLLOW_UP)},
    (State.APPROVED_BY_A_PERSON, "change"): State.REJECTED_BY_A_PERSON,
    (State.APPROVED_ADDED, "change"): State.REJECTED_BY_A_PERSON,
    (State.REJECTED_BY_A_PERSON, "change"): State.APPROVED_BY_A_PERSON,
    (State.REJECTED_BY_A_RULE, "change"): State.APPROVED_BY_A_PERSON,
    (State.OPEN, "undo"): None,
    (State.FOLLOW_UP, "undo"): State.OPEN,
    (State.APPROVED_BY_A_PERSON, "undo"): State.OPEN,
    (State.APPROVED_ADDED, "undo"): None,
    (State.REJECTED_BY_A_PERSON, "undo"): State.OPEN,
    (State.REJECTED_BY_A_RULE, "undo"): None,
    (State.OPEN, "rule_rejects"): State.REJECTED_BY_A_RULE,
    **{(state, "rule_rejects"): None for state in (
        State.FOLLOW_UP, State.APPROVED_BY_A_PERSON, State.APPROVED_ADDED,
        State.REJECTED_BY_A_PERSON)},
    (State.REJECTED_BY_A_RULE, "rule_rejects"): State.REJECTED_BY_A_RULE,
    **{(state, "rule_returns"): None for state in (
        State.OPEN, State.FOLLOW_UP, State.APPROVED_BY_A_PERSON, State.APPROVED_ADDED,
        State.REJECTED_BY_A_PERSON)},
    (State.REJECTED_BY_A_RULE, "rule_returns"): State.OPEN,
    (State.FOLLOW_UP, "hand_on"): State.FOLLOW_UP,
    **{(state, "hand_on"): None for state in (
        State.OPEN, State.APPROVED_BY_A_PERSON, State.APPROVED_ADDED, State.REJECTED_BY_A_PERSON,
        State.REJECTED_BY_A_RULE)},
    **{(state, f"answers_{source}"): after
       for source in ("applicant", "import")
       for state, after in (
           (State.OPEN, State.OPEN), (State.FOLLOW_UP, State.FOLLOW_UP),
           (State.APPROVED_BY_A_PERSON, State.OPEN),
           (State.APPROVED_ADDED, State.APPROVED_BY_A_PERSON),
           (State.REJECTED_BY_A_PERSON, State.OPEN),
           (State.REJECTED_BY_A_RULE, State.REJECTED_BY_A_RULE))},
    **{(state, "answers_organizer"): state for state in State},
}


def test_the_pure_grid_holds_every_pair():
    assert set(MOVED) == {(state, event) for state in State for event in MOVES}


@pytest.mark.parametrize("state", list(State), ids=lambda s: s.value)
@pytest.mark.parametrize("event", MOVES)
def test_each_pure_move(state, event):
    doc = _stored(state)
    assert ReviewState.state_of(doc) is state

    moved = ReviewState.move(doc, MOVES[event](state))

    expected = MOVED[(state, event)]
    if expected is None:
        assert isinstance(moved, ReviewState.Refused)
    else:
        assert isinstance(moved, ReviewState.Move), moved
        assert moved.to is expected
        assert ReviewState.state_of({**{k: v for k, v in doc.items() if k not in moved.unset},
                                     **moved.set}) is expected
        if event in MARKING or (state, event) in RETURNING:
            assert moved.set[ApplicationsApi.ARRIVING_FIELD] == ARRIVAL.stored()
        else:
            assert ApplicationsApi.ARRIVING_FIELD not in moved.set
        # A verdict ends the wait; a follow-up given keeps whatever wait it had. Changed answers
        # give no verdict, so end none.
        if not expected.undecided and not event.startswith("answers_"):
            assert ApplicationsApi.ARRIVING_FIELD in moved.unset


class TestThePureMove:
    def test_holds_the_status_and_the_verdicts_time_as_read(self):
        doc = _stored(State.REJECTED_BY_A_PERSON)

        moved = ReviewState.move(doc, ReviewState.Undo("user-editor", ARRIVAL))

        assert moved.pins == {"status": "reviewer_rejected", "verdict_at": doc["verdict_at"]}

    def test_a_verdict_holds_the_answers_time_and_the_follow_ups_owner_too(self):
        doc = _stored(State.FOLLOW_UP)

        moved = ReviewState.move(doc, MOVES["give"](State.FOLLOW_UP))

        assert moved.pins == {
            "status": "needs_follow_up", "verdict_at": doc["verdict_at"],
            "updated_at": "2026-10-20T00:00:00Z", "follow_up_owner": doc["follow_up_owner"]}

    def test_an_added_vendors_refusal_says_why(self):
        moved = ReviewState.move(_stored(State.APPROVED_ADDED), ReviewState.ChangeVerdict(
            ApplicationStatus.NEEDS_FOLLOW_UP, ADMIN_GIVER))

        assert moved == ReviewState.Refused(ADDED_ONLY_REJECTED)

    def test_a_refusal_is_falsy_as_a_write_that_did_not_land(self):
        assert not ReviewState.Refused()

    def test_an_undo_after_the_window_is_refused(self):
        doc = {**_stored(State.APPROVED_BY_A_PERSON), "verdict_at": "2026-10-01T00:00:00+00:00"}

        assert isinstance(ReviewState.move(doc, ReviewState.Undo("user-editor", ARRIVAL)),
                          ReviewState.Refused)

    def test_changed_answers_hold_the_status_and_the_verdicts_time_alone(self):
        doc = _stored(State.APPROVED_BY_A_PERSON)

        moved = ReviewState.move(doc, MOVES["answers_applicant"](State.APPROVED_BY_A_PERSON))

        assert moved.pins == {"status": "reviewer_approved", "verdict_at": doc["verdict_at"]}

    def test_an_organizers_update_holds_nothing_and_moves_nothing(self):
        for state in State:
            moved = ReviewState.move(_stored(state), MOVES["answers_organizer"](state))

            assert (moved.set, moved.unset, moved.pins) == ({}, (), {})

    @pytest.mark.parametrize("source,origin", [("applicant", "applied"), ("import", "imported")])
    def test_an_added_vendors_origin_moves_by_the_source(self, source, origin):
        moved = ReviewState.move(_stored(State.APPROVED_ADDED),
                                 MOVES[f"answers_{source}"](State.APPROVED_ADDED))

        assert moved.set == {"origin": origin}

    def test_answers_restated_move_nothing(self):
        doc = {**_stored(State.APPROVED_BY_A_PERSON), "form_data": {"shop": "Kiln"}}

        moved = ReviewState.move(doc, MOVES["answers_import"](State.APPROVED_BY_A_PERSON))

        assert (moved.to, moved.set, moved.unset) == (State.APPROVED_BY_A_PERSON, {}, ())

    def test_an_application_stored_with_no_status_is_given_open(self):
        doc = {**_stored(State.OPEN), "status": ""}

        moved = ReviewState.move(doc, MOVES["answers_applicant"](State.OPEN))

        assert moved.set == {"status": "open"}

    def test_an_undo_by_someone_else_is_refused(self):
        assert isinstance(ReviewState.move(_stored(State.APPROVED_BY_A_PERSON),
                                           ReviewState.Undo("user-admin", ARRIVAL)),
                          ReviewState.Refused)


# --- Every stored status reads as a state ---------------------------------------------------------

#: The state each stored status reads as, with nobody added by hand and no rule's giver: the
#: offers' statuses as the approval they carried and ``cancelled`` as a person's rejection
#: (decision 9.6).
STORED_AS: Dict[ApplicationStatus, State] = {
    ApplicationStatus.OPEN: State.OPEN,
    ApplicationStatus.UNDER_REVIEW: State.OPEN,
    ApplicationStatus.NEEDS_FOLLOW_UP: State.FOLLOW_UP,
    ApplicationStatus.REVIEWER_APPROVED: State.APPROVED_BY_A_PERSON,
    ApplicationStatus.REVIEWER_REJECTED: State.REJECTED_BY_A_PERSON,
    ApplicationStatus.UNASSIGNED: State.APPROVED_BY_A_PERSON,
    ApplicationStatus.ASSIGNED: State.APPROVED_BY_A_PERSON,
    ApplicationStatus.ASSIGNMENT_SENT: State.APPROVED_BY_A_PERSON,
    ApplicationStatus.VENDOR_ACCEPTED: State.APPROVED_BY_A_PERSON,
    ApplicationStatus.VENDOR_REFUSED: State.APPROVED_BY_A_PERSON,
    ApplicationStatus.CANCELLED: State.REJECTED_BY_A_PERSON,
}


@pytest.mark.parametrize("status", list(ApplicationStatus), ids=lambda s: s.value)
def test_every_stored_status_reads_as_a_state(status):
    """A status added later fails here until it is placed in the table."""
    assert ReviewState.state_of({"status": status.value}) is STORED_AS[status]


@pytest.mark.parametrize("status", [None, ""])
def test_no_status_reads_as_open(status):
    assert ReviewState.state_of({"status": status}) is State.OPEN


def test_an_approval_carried_on_reads_as_added_for_an_added_vendor():
    doc = {"status": ApplicationStatus.ASSIGNED.value, "added_by": {"email": ADMIN}}

    assert ReviewState.state_of(doc) is State.APPROVED_ADDED


def test_an_added_vendor_who_applied_since_reads_as_approved_by_a_person():
    doc = {"status": "reviewer_approved", "added_by": {"email": ADMIN}, "origin": "applied"}

    assert ReviewState.state_of(doc) is State.APPROVED_BY_A_PERSON


def test_a_rules_rejection_reads_as_the_rules():
    doc = {"status": "reviewer_rejected", "verdict_by": {"kind": "rule", "rule": "affiliation"}}

    assert ReviewState.state_of(doc) is State.REJECTED_BY_A_RULE


def test_a_status_nothing_spells_is_refused():
    with pytest.raises(ValueError):
        ReviewState.state_of({"status": "maybe_later"})


# --- Stored before the migration: each event on an old spelling, through the routes ---------------

#: A verdict the old offers flow carried on was given long before, outside any undo's window.
LONG_AGO = "2026-09-01T00:00:00+00:00"


def _stored_as(status: str) -> Callable:
    """Store ``app-v1``'s status as ``status``, its verdict given long ago."""

    def store(world):
        doc = _doc(world)
        doc["status"] = status
        if doc.get("verdict_at"):
            doc.update(verdict_at=LONG_AGO)
            doc.pop("undo_to", None)

    return store


#: Each spelling stored before the stored applications are migrated, the state it reads as, and
#: how it is reached: the state's own setup, then the status rewritten as stored. An application
#: stored with no status is not among them: the application model requires one, so no route serves
#: it, and nothing stores one.
OLD_SPELLINGS: Dict[str, Tuple[State, Callable]] = {
    "under_review": (State.OPEN, _stored_as(ApplicationStatus.UNDER_REVIEW.value)),
    "assigned": (State.APPROVED_BY_A_PERSON, _stored_as(ApplicationStatus.ASSIGNED.value)),
    "cancelled": (State.REJECTED_BY_A_PERSON, _stored_as(ApplicationStatus.CANCELLED.value)),
}


def _cell_for_an_old_spelling(state: State, event: str) -> Cell:
    """The table's cell, but for an undo of a verdict given long ago, which is refused."""
    if event == "undo" and not state.undecided:
        return _refused(state, 403, UNDO_REFUSED)
    return TABLE[(state, event)]


@pytest.mark.parametrize("spelling", OLD_SPELLINGS)
@pytest.mark.parametrize("event", EVENTS)
def test_each_cell_on_a_status_stored_before_the_migration(market, spelling, event):
    """An application stored ``under_review``, or in a status the old offers flow wrote, moves as
    the state it reads as, through every event's route."""
    state, store = OLD_SPELLINGS[spelling]
    STATES[state](market)
    store(market)
    assert ReviewState.state_of(_doc(market)) is state
    recorded = len(market.history.documents)

    response = EVENTS[event](market)

    code, error, after, entry = _cell_for_an_old_spelling(state, event)
    assert response.status_code == code, response.get_json()
    if error is not None:
        assert response.get_json()["error"] == error
    assert ReviewState.state_of(_doc(market)) is after
    marked = None if code != 200 else MARKED.get((state, event))
    assert _doc(market).get(ApplicationsApi.ARRIVING_FIELD) == marked
    entries = _entries_after(market, recorded)
    assert [(e["kind"], e["action"]) for e in entries] == ([] if entry is None else [entry])


def test_a_verdict_on_one_stored_under_review_undone_returns_to_it_and_waits(market):
    """A verdict given on an application stored ``under_review`` is held on it, and its undo
    restores it as stored, marked, so the next deal deals it."""
    _state, store = OLD_SPELLINGS["under_review"]
    store(market)
    stored = _doc(market).get("status")
    _ok(_verdict(EDITOR, "reviewer_approved"))

    _ok(_client(EDITOR).post(f"/markets/{MARKET}/applications/{APP}/review/undo",
                             json={"seen": seen_as_stored(APP)}))

    doc = _doc(market)
    assert doc.get("status") == stored
    assert ReviewState.state_of(doc) is State.OPEN
    assert doc.get(ApplicationsApi.ARRIVING_FIELD) == {"actor": EDITOR, "action": "give-verdicts"}
    [waiting] = [d for d in ApplicationsApi.arriving_in_arrival_order(MARKET) if d["id"] == APP]
    assert ReviewState.state_of(waiting) is State.OPEN
