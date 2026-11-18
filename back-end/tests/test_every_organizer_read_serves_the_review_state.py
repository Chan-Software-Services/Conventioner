"""Every application an organizer reads is served its review state (T277 ticket 02, phase 2).

Each screen used to work an application's review state out again from its stored status, each by its
own list of statuses, so they disagreed with the server and with each other: an application stored
with no status passed Begin assignment, and a card warned "This application is dealt to ..." for one
in nobody's share, its reviewer removed before the deal marked every move. The server now reads it
once, by the owner's rule, and serves it beside ``origin`` as ``review``: its state, whether it
awaits a verdict, whose share it is in (reviewer first) and whether it waits for the deal. The list,
the next card, a verdict's answer, an undo's, a follow-up's hand-on and an update of a vendor's
answers each serve it, over one view of the market read once per request.

Each case is set up through the routes, as an organizer reaches it, but for the shapes no route
writes any more (an application whose reviewer was removed before every move was marked), which are
stored as an older release left them.
"""
import pytest

from conftest import FakeOrganizations, install_organizations, seen_as_stored
from test_choosing_reviewers_deals_the_open_applications import (
    ADMIN, ANA, BEN, CAT, EDITOR, MARKET, VIEWER, _application, _choose, _client,
)
from test_csv_import import _market_doc as _import_market_doc
from test_each_arrival_is_dealt import world  # noqa: F401  (the fixture)

import api.applications as ApplicationsApi
import api.permissions as PermissionsApi
import application_status as ReviewState
import review_team as ReviewTeam
from datatypes import MarketPerson, MarketPhase

#: The market's "Be chosen as a reviewer" row raised to Editor: a Viewer then holds a role here,
#: and may own a follow-up, but may not be chosen to review.
CHOSEN_ROW_AT_EDITOR = {"review-when-chosen": {"role": "editor", "source": "market"}}

ANA_PERSON = {"user_id": "user-ana", "email": ANA}
CAT_PERSON = {"user_id": "user-cat", "email": CAT}
A_PERSONS_VERDICT = {"kind": "person", "user_id": "user-editor", "email": EDITOR}


def _review(open_=True, share=(), waiting=False, state=None):
    state = state or ("open" if open_ else None)
    return {"state": state, "undecided": state in ("open", "follow_up"), "share": list(share),
            "waiting": waiting}


def _listed(who=VIEWER):
    """Each application as the organizer's list serves it, by id."""
    response = _client(who).get(f"/markets/{MARKET}/applications")
    assert response.status_code == 200, response.get_json()
    return {row["id"]: row for row in response.get_json()["applications"]}


def _doc(world, app_id):
    return next(d for d in world.applications.documents if d["id"] == app_id)


def _store(world, app_id, **fields):
    """An application as an older release stored it, no route writing it so today."""
    doc = _doc(world, app_id)
    for key, value in fields.items():
        if value is None:
            doc.pop(key, None)
        else:
            doc[key] = value


def _verdict(who, app_id, status="reviewer_approved", **body):
    response = _client(who).put(f"/markets/{MARKET}/applications/{app_id}/review",
                                json={"status": status, "seen": seen_as_stored(app_id), **body})
    assert response.status_code == 200, response.get_json()
    return response.get_json()["application"]


def _hand_on(app_id, owner, who=ADMIN):
    response = _client(who).put(f"/markets/{MARKET}/applications/{app_id}/follow-up-owner",
                                json={"ownerEmail": owner})
    assert response.status_code == 200, response.get_json()
    return response.get_json()["application"]


def _next(who, **body):
    response = _client(who).post(f"/markets/{MARKET}/review/next", json=body)
    assert response.status_code == 200, response.get_json()
    return response.get_json()["application"]


class TestWithNoReviewersChosen:
    def test_every_state_is_served_in_no_share_and_none_waits(self, world):
        _store(world, "app-v2", status="needs_follow_up", follow_up_owner=CAT_PERSON,
               verdict_by=A_PERSONS_VERDICT, verdict_at="2026-10-21T00:00:00+00:00")
        _store(world, "app-v3", status="reviewer_approved", verdict_by=A_PERSONS_VERDICT)
        _store(world, "app-v4", status="reviewer_rejected",
               verdict_by={"kind": "rule", "rule": "student"})
        _store(world, "app-v5", status="under_review")
        _store(world, "app-v7", status="cancelled", reviewer=ANA_PERSON)

        listed = _listed()

        assert {app_id: row["review"] for app_id, row in listed.items()} == {
            "app-v1": _review(),
            "app-v2": _review(state="follow_up"),
            "app-v3": _review(state="approved"),
            "app-v4": _review(state="rejected"),
            "app-v5": _review(),
            "app-v6": _review(),  # open as it arrived
            "app-v7": _review(state="rejected"),
        }
        # The stored spelling stays served beside it, for its label.
        assert listed["app-v5"]["status"] == "under_review"


class TestAnOpenApplication:
    def test_with_a_chosen_reviewer_is_theirs_and_waits_for_nothing(self, world):
        _choose([ANA, BEN])

        listed = _listed()

        assert listed["app-v1"]["review"] == _review(share=[ANA])
        assert listed["app-v2"]["review"] == _review(share=[BEN])

    def test_with_a_chosen_reviewer_who_may_no_longer_review_stays_theirs(self, world):
        """A chosen reviewer who may no longer review here keeps their share until an Admin
        removes them, as the dealing rule says; the reviewers panel marks them unable."""
        _choose([ANA, BEN])
        world.markets.doc["permissions"] = CHOSEN_ROW_AT_EDITOR

        assert _listed()["app-v1"]["review"] == _review(share=[ANA])

    def test_with_a_removed_reviewer_is_in_no_share_and_waits(self, world):
        """Its reviewer removed before every move was marked for the deal (T277 P2): stored so,
        nothing dealt it again, and the card warned it was dealt to them."""
        _choose([ANA, BEN])
        _store(world, "app-v1", reviewer=CAT_PERSON)

        listed = _listed()

        assert listed["app-v1"]["review"] == _review(share=[], waiting=True)
        assert listed["app-v1"]["reviewer"]["email"] == CAT

    def test_with_no_reviewer_while_reviewers_are_chosen_waits(self, world):
        _choose([ANA, BEN])
        _store(world, "app-v1", reviewer=None)

        assert _listed()["app-v1"]["review"] == _review(share=[], waiting=True)


class TestAFollowUp:
    def test_dealt_to_one_reviewer_and_owned_by_another_is_in_both_shares_reviewer_first(
            self, world):
        _choose([ANA, BEN])

        given = _verdict(ADMIN, "app-v1", status="needs_follow_up", ownerEmail=BEN)

        review = _review(state="follow_up", share=[ANA, BEN])
        assert given["review"] == review
        assert _listed()["app-v1"]["review"] == review

    def test_owned_by_its_reviewer_is_in_their_share_once(self, world):
        _choose([ANA, BEN])
        _store(world, "app-v1", status="needs_follow_up", follow_up_owner=ANA_PERSON,
               verdict_by=A_PERSONS_VERDICT, verdict_at="2026-10-21T00:00:00+00:00")

        assert _listed()["app-v1"]["review"] == _review(state="follow_up", share=[ANA])

    def test_whose_owner_holds_no_role_on_the_market_waits(self, world):
        _choose([ANA, BEN])
        _verdict(ADMIN, "app-v1", status="needs_follow_up", ownerEmail=CAT)
        world.markets.doc["roles"].pop("user-cat")

        assert _listed()["app-v1"]["review"] == _review(
            state="follow_up", share=[ANA], waiting=True)

    def test_whose_owner_holds_a_role_but_may_not_be_chosen_is_theirs(self, world):
        world.markets.doc["permissions"] = CHOSEN_ROW_AT_EDITOR
        _choose([BEN, EDITOR])
        _verdict(ADMIN, "app-v1", status="needs_follow_up")

        handed = _hand_on("app-v1", CAT)

        review = _review(state="follow_up", share=[BEN, CAT])
        assert handed["review"] == review
        assert _listed()["app-v1"]["review"] == review

    def test_whose_reviewer_was_removed_is_its_owners_alone(self, world):
        _choose([ANA, BEN])
        _verdict(ADMIN, "app-v1", status="needs_follow_up", ownerEmail=BEN)
        _store(world, "app-v1", reviewer=CAT_PERSON)

        assert _listed()["app-v1"]["review"] == _review(state="follow_up", share=[BEN])


class TestADecidedApplication:
    def test_dealt_to_a_removed_reviewer_stays_the_record_of_their_share(self, world):
        _choose([ANA, BEN])
        world.markets.doc["roles"]["user-ana"] = "admin"
        _verdict(ANA, "app-v1")
        _choose([BEN])

        assert _listed()["app-v1"]["review"] == _review(state="approved", share=[ANA])

    def test_rejected_is_served_rejected_whoever_gave_it(self, world):
        _choose([ANA, BEN])

        rejected = _verdict(ADMIN, "app-v1", status="reviewer_rejected")

        assert rejected["review"] == _review(state="rejected", share=[ANA])

    def test_never_dealt_is_in_no_share(self, world):
        _verdict(ADMIN, "app-v1")
        _choose([ANA, BEN])

        assert _listed()["app-v1"]["review"] == _review(state="approved", share=[])


class TestEveryAnswerServesIt:
    def test_the_next_card(self, world):
        _choose([ANA, BEN])

        card = _next(ANA, mineOnly=True)

        assert card["id"] == "app-v1"
        assert card["review"] == _review(share=[ANA])

    def test_the_next_card_serves_the_share_as_its_deal_left_it(self, world):
        _choose([ANA, BEN])
        _store(world, "app-v1", reviewer=CAT_PERSON,
               arriving={"actor": ADMIN, "action": "give-verdicts"})

        card = _next(BEN, want="app-v1")

        # The turn stood at 7, Ben's: the deal before the card handed it to him.
        assert card["id"] == "app-v1"
        assert card["review"] == _review(share=[BEN])

    def test_a_verdicts_refusal_serves_the_application_as_it_stands(self, world):
        _choose([ANA, BEN])
        seen = seen_as_stored("app-v1")
        _verdict(ADMIN, "app-v1", status="reviewer_rejected")

        response = _client(ADMIN).put(f"/markets/{MARKET}/applications/app-v1/review",
                                      json={"status": "reviewer_approved", "seen": seen})

        assert response.status_code == 409
        assert response.get_json()["application"]["review"] == _review(
            state="rejected", share=[ANA])

    def test_an_undo_serves_the_share_as_its_deal_left_it(self, world):
        world.markets.doc["roles"]["user-ana"] = "admin"
        _choose([ANA, BEN])
        given = _verdict(ANA, "app-v1")
        _choose([BEN])

        response = _client(ANA).post(
            f"/markets/{MARKET}/applications/app-v1/review/undo",
            json={"seen": {"status": given["status"], "verdictAt": given["verdictAt"]}})

        assert response.status_code == 200, response.get_json()
        assert response.get_json()["application"]["review"] == _review(share=[BEN])

    def test_a_hand_on_serves_the_share_as_its_deal_left_it(self, world):
        _choose([ANA, BEN])
        _verdict(ADMIN, "app-v1", status="needs_follow_up")

        handed = _hand_on("app-v1", CAT)

        assert handed["followUpOwner"]["email"] == CAT
        assert handed["review"] == _review(state="follow_up", share=[ANA, CAT])

    def test_an_update_of_a_vendors_answers(self, world):
        _choose([ANA, BEN])
        _store(world, "app-v1", reviewer=CAT_PERSON)

        response = _client(ADMIN).put(f"/markets/{MARKET}/applications/app-v1/answers",
                                      json={"answers": {"business_name": "Ember & Ash"}})

        assert response.status_code == 200, response.get_json()
        assert response.get_json()["application"]["review"] == _review(share=[], waiting=True)


class TestTheServedOrigin:
    def test_one_stored_with_none_on_a_google_form_market_is_imported(self, world):
        world.use(_import_market_doc(phase=MarketPhase.APPLICATIONS))
        _store(world, "app-v1", origin=None)

        assert _listed()["app-v1"]["origin"] == "imported"

    def test_one_stored_with_none_on_a_form_market_applied(self, world):
        _store(world, "app-v1", origin=None)

        assert _listed()["app-v1"]["origin"] == "applied"

    def test_one_stored_with_none_and_added_by_hand_is_added_on_either(self, world):
        adder = {"user_id": "user-admin", "email": ADMIN}
        _store(world, "app-v1", origin=None, status="reviewer_approved", added_by=adder,
               added_at="2026-10-20T00:00:00+00:00")
        assert _listed()["app-v1"]["origin"] == "added"

        world.use(_import_market_doc(phase=MarketPhase.APPLICATIONS))
        assert _listed()["app-v1"]["origin"] == "added"


class TestTheViewIsReadOncePerRequest:
    def test_listing_359_applications_reads_the_people_with_a_role_once(self, world, monkeypatch):
        world.applications.documents = [
            _application(f"v{n}", 1 + n % 28) for n in range(1, 360)]
        _choose([ANA, BEN])
        calls = []
        real = PermissionsApi.people_with_market_role

        def counted(*args, **kwargs):
            calls.append(args)
            return real(*args, **kwargs)

        monkeypatch.setattr(PermissionsApi, "people_with_market_role", counted)

        listed = _listed()

        assert len(listed) == 359
        assert len(calls) == 1

    def test_a_market_whose_organization_is_gone_reads_its_own_roles(self, world, monkeypatch):
        gone = install_organizations(monkeypatch, FakeOrganizations())
        monkeypatch.setattr(PermissionsApi, "organizations_collection", gone)
        world.markets.doc["organizationId"] = "org-gone"
        _choose([ANA, BEN])
        _verdict(ADMIN, "app-v1", status="needs_follow_up", ownerEmail=CAT)

        assert _listed()["app-v1"]["review"] == _review(state="follow_up", share=[ANA, CAT])


def _in_each_state():
    """An application in each state of the transition table, dealt to and owned by each of the
    reviewers asked about, Cat holding a role but not chosen."""
    states = {
        ReviewState.State.OPEN: {"status": "open"},
        ReviewState.State.FOLLOW_UP: {"status": "needs_follow_up"},
        ReviewState.State.APPROVED_BY_A_PERSON: {"status": "reviewer_approved",
                                                 "verdict_by": A_PERSONS_VERDICT},
        ReviewState.State.APPROVED_ADDED: {"status": "reviewer_approved", "origin": "added"},
        ReviewState.State.REJECTED_BY_A_PERSON: {"status": "reviewer_rejected",
                                                 "verdict_by": A_PERSONS_VERDICT},
        ReviewState.State.REJECTED_BY_A_RULE: {"status": "reviewer_rejected",
                                               "verdict_by": {"kind": "rule", "rule": "student"}},
    }
    people = {"ana": ANA_PERSON, "ben": {"user_id": "user-ben", "email": BEN},
              "cat": CAT_PERSON, "nobody": None}
    for state, stored in states.items():
        for reviewer in people:
            for owner in people:
                doc = {**stored, "reviewer": people[reviewer], "follow_up_owner": people[owner]}
                yield pytest.param(state, doc, id=f"{state.value}-dealt-{reviewer}-owned-{owner}")


class TestTheClaimReadsTheServedShare:
    @pytest.mark.parametrize("state,doc", list(_in_each_state()))
    def test_a_chosen_askers_share_is_the_served_one(self, state, doc):
        """The claim hands a chosen reviewer their share first by the stored reviewer and owner
        (``api/applications.py`` cannot read the view, which imports it); for every chosen
        reviewer who may ask, that is exactly whether the served share holds them."""
        view = ReviewTeam.ReviewView(chosen=frozenset({ANA, BEN}),
                                     may_own=frozenset({"user-ana", "user-ben", "user-cat"}),
                                     intake=None)
        assert ReviewState.state_of(doc) is state

        for asker in (ANA_PERSON, {"user_id": "user-ben", "email": BEN}):
            person = MarketPerson(**asker)
            assert ApplicationsApi._in_share_of(doc, person) == (
                asker["email"] in ReviewTeam.share_of(doc, view)), asker["email"]
