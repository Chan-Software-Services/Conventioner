"""Every return to open or follow-up waits for the deal (T277 ticket 02, its ticket 03).

An application could fall out of every reviewer's share and nobody noticed: a verdict undone, a
rule's rejection returned to open, or an approval a re-import sent back to review came back open
with no reviewer, or with a reviewer who had been removed, and no deal ever dealt it again (T277
P1, P2, P3); one that arrived while nobody chosen could review was let go undealt, and stayed so
once a reviewer's role came back (P5). Every move into open, an undo back into a follow-up, and a
follow-up's hand-on now mark the application for the deal in their own write, and the deal,
holding the market, keeps an able reviewer, deals the rest to the next in turn, and with nobody
able leaves the mark for the next deal, which a reviewer's next card starts.

Each case is set up through the routes, as an organizer and an applicant reach them.
"""
from conftest import seen_as_stored
from test_choosing_reviewers_deals_the_open_applications import (
    ADMIN, ANA, BEN, CAT, EDITOR, MARKET, _choose, _client, _reviewers,
)
from test_csv_import import GOOD_ROW, MAPPING, _csv
from test_csv_import import _market_doc as _import_market_doc
from test_each_arrival_is_dealt import (  # noqa: F401  (the fixture)
    DEALT, _arrivals, _id_of, _submit, world,
)

import api.applications as ApplicationsApi
import history as History
import review_team as ReviewTeam
from datatypes import MarketPhase

#: The import's row, then the same vendor available on one date only, which the solver reads.
ROW = GOOD_ROW
CHANGED_ROW = GOOD_ROW.replace('"2026-08-01, 2026-08-08",2', '2026-08-01,1')
NADIA = "nadia@ember.test"


def _doc(world, app_id):
    return next(d for d in world.applications.documents if d["id"] == app_id)


def _verdict(who, app_id, status="reviewer_approved"):
    response = _client(who).put(f"/markets/{MARKET}/applications/{app_id}/review",
                                json={"status": status, "seen": seen_as_stored(app_id)})
    assert response.status_code == 200, response.get_json()
    return response.get_json()["application"]


def _undo(who, app_id, given):
    return _client(who).post(
        f"/markets/{MARKET}/applications/{app_id}/review/undo",
        json={"seen": {"status": given["status"], "verdictAt": given["verdictAt"]}})


def _next(who):
    response = _client(who).post(f"/markets/{MARKET}/review/next", json={"mineOnly": True})
    assert response.status_code == 200, response.get_json()
    return response.get_json()


def _deals_of(world, app_id):
    return [e for e in world.history.documents
            if e["kind"] == History.DEALT and app_id in e["subject"]["application_ids"]]


def _waiting(world):
    return [d["id"] for d in world.applications.documents if d.get(ApplicationsApi.ARRIVING_FIELD)]


class TestAnUndoneVerdict:
    def test_p1_one_decided_before_the_reviewers_were_chosen_is_dealt_as_it_is_undone(self, world):
        given = _verdict(BEN, "app-v1")
        # Six open, dealt Ana, Ben, Ana, Ben, Ana, Ben: the turn at 6, Ana's.
        assert _choose([ANA, BEN]).status_code == 200

        response = _undo(BEN, "app-v1", given)

        assert response.status_code == 200, response.get_json()
        assert _reviewers(world)["v1"] == ANA
        assert response.get_json()["application"]["reviewer"]["email"] == ANA
        assert world.markets.doc["reviewTeam"]["turn"] == 7
        # The next arrival takes the next turn, not the one the undone application took.
        _submit(world, "v8@vendor.test")
        assert _reviewers(world)["v8"] == BEN
        assert _waiting(world) == []

    def test_p1_the_deal_is_recorded_as_the_undoers_write(self, world):
        given = _verdict(BEN, "app-v1")
        _choose([ANA, BEN])

        _undo(BEN, "app-v1", given)

        [entry] = _deals_of(world, "app-v1")
        assert (entry["actor"], entry["action"]) == (BEN, "give-verdicts")
        assert entry["detail"] == {"cause": ReviewTeam.ARRIVED,
                                   "before": {"app-v1": {"reviewer": None}},
                                   "after": {"app-v1": {"reviewer": ANA}}}

    def test_p2_one_whose_reviewer_was_removed_is_dealt_to_a_reviewer_still_chosen(self, world):
        world.markets.doc["roles"]["user-ana"] = "admin"
        _choose([ANA, BEN])
        assert _reviewers(world)["v1"] == ANA
        given = _verdict(ANA, "app-v1")
        _choose([BEN])

        response = _undo(ANA, "app-v1", given)

        assert response.status_code == 200, response.get_json()
        assert _reviewers(world)["v1"] == BEN
        [entry] = _deals_of(world, "app-v1")[-1:]
        assert (entry["actor"], entry["action"]) == (ANA, "give-verdicts")
        # Its reviewer before, as stored: Ana's, so the history reads "dealt ... to Ben".
        assert entry["detail"]["before"] == {"app-v1": {"reviewer": ANA}}
        assert entry["detail"]["after"] == {"app-v1": {"reviewer": BEN}}

    def test_one_whose_reviewer_is_still_able_keeps_them_and_moves_no_turn(self, world):
        _choose([ANA, BEN])
        world.markets.doc["roles"]["user-ana"] = "admin"
        given = _verdict(ANA, "app-v1")
        turn = world.markets.doc["reviewTeam"]["turn"]

        response = _undo(ANA, "app-v1", given)

        assert response.status_code == 200, response.get_json()
        assert _reviewers(world)["v1"] == ANA
        assert world.markets.doc["reviewTeam"]["turn"] == turn
        assert _waiting(world) == []
        assert len(_deals_of(world, "app-v1")) == 1  # the choice's alone

    def test_a_selections_undo_deals_each_it_returned(self, world):
        given = _verdict(BEN, "app-v1")
        _choose([ANA, BEN])

        response = _client(BEN).post(
            f"/markets/{MARKET}/applications/verdicts/undo",
            json={"applications": [{"id": "app-v1", "seen": {
                "status": given["status"], "verdictAt": given["verdictAt"]}}]})

        assert response.get_json()["written"] == ["app-v1"]
        assert _reviewers(world)["v1"] == ANA


class TestARequestStoppedBeforeItsDeal:
    def test_the_next_card_deals_what_the_undo_returned(self, world, monkeypatch):
        world.markets.doc["roles"]["user-ana"] = "admin"
        _choose([ANA, BEN])
        given = _verdict(ANA, "app-v1")
        _choose([BEN])
        real = ReviewTeam._settle

        def the_host_ends_the_request(*_args, **_kwargs):
            raise RuntimeError("the host ended the request")

        monkeypatch.setattr(ReviewTeam, "_settle", the_host_ends_the_request)
        assert _undo(ANA, "app-v1", given).status_code == 500
        monkeypatch.setattr(ReviewTeam, "_settle", real)
        assert _waiting(world) == ["app-v1"]
        assert _reviewers(world)["v1"] == ANA

        answered = _next(BEN)

        assert answered["dealt"] == 1
        assert _reviewers(world)["v1"] == BEN
        assert _waiting(world) == []


class TestARulesReturn:
    def test_p3_one_whose_reviewer_was_removed_is_dealt_to_a_reviewer_still_chosen(self, world):
        world.applicant_market(rejectionRules=[{"key": "student", "answers": ["Yes"]}])
        _choose([ANA])
        _submit(world, "v8@vendor.test", student="No")
        app_id = _id_of(world, "v8@vendor.test")
        assert _reviewers(world)["v8"] == ANA
        # The organizer's update meets the rule, which rejects it, still Ana's share.
        updated = _client().put(f"/markets/{MARKET}/applications/{app_id}/answers",
                                json={"answers": {"student": "Yes"}})
        assert updated.status_code == 200, updated.get_json()
        assert _doc(world, app_id)["status"] == "reviewer_rejected"
        _choose([BEN, CAT])

        response = _client().put(f"/markets/{MARKET}/rejection-rules", json={"rules": []})

        assert response.status_code == 200, response.get_json()
        assert _doc(world, app_id)["status"] == "open"
        assert _reviewers(world)["v8"] in (BEN, CAT)
        [entry] = _deals_of(world, app_id)[-1:]
        assert (entry["actor"], entry["action"]) == (ADMIN, "change-form")
        assert entry["detail"]["before"] == {app_id: {"reviewer": ANA}}
        assert _waiting(world) == []


class TestAReImportsBackToReview:
    def test_one_whose_reviewer_was_removed_is_dealt_to_a_reviewer_still_chosen(self, world):
        world.use(_import_market_doc(phase=MarketPhase.APPLICATIONS))
        _choose([ANA])
        imported = _client().post(f"/markets/{MARKET}/applications/import",
                                  json={"csvContent": _csv(ROW), "mapping": MAPPING})
        assert imported.status_code == 200, imported.get_json()
        app_id = _id_of(world, NADIA)
        assert _doc(world, app_id)["reviewer"]["email"] == ANA
        _verdict(ADMIN, app_id)
        _choose([BEN, CAT])

        response = _client().post(f"/markets/{MARKET}/applications/import",
                                  json={"csvContent": _csv(CHANGED_ROW), "mapping": MAPPING})

        assert response.status_code == 200, response.get_json()
        assert response.get_json()["returnedToReview"] == 1
        doc = _doc(world, app_id)
        assert doc["status"] == "open"
        assert doc["reviewer"]["email"] in (BEN, CAT)
        [entry] = _deals_of(world, app_id)[-1:]
        assert (entry["actor"], entry["action"]) == (ADMIN, "import-applications")
        assert entry["detail"]["before"] == {app_id: {"reviewer": ANA}}
        assert _waiting(world) == []


class TestNobodyAble:
    def test_p5_an_arrival_waits_and_is_dealt_on_the_reviewers_next_card(self, world):
        _choose([ANA])
        ana_role = world.markets.doc["roles"].pop("user-ana")

        _submit(world, "v8@vendor.test")

        app_id = _id_of(world, "v8@vendor.test")
        assert _reviewers(world)["v8"] is None
        assert _waiting(world) == [app_id]
        assert _arrivals(world) == []

        world.markets.doc["roles"]["user-ana"] = ana_role
        answered = _next(ANA)

        assert answered["dealt"] == 1
        assert _reviewers(world)["v8"] == ANA
        assert _waiting(world) == []
        [entry] = _arrivals(world)
        assert (entry["actor"], entry["action"]) == ("v8@vendor.test", History.APPLY)

    def test_a_deal_with_nobody_able_leaves_the_marks_and_ends(self, world):
        _choose([ANA])
        world.markets.doc["roles"].pop("user-ana")
        _submit(world, "v8@vendor.test")
        _submit(world, "v9@vendor.test")

        dealt = ReviewTeam.deal_arrivals(
            ReviewTeam.market_from_document(world.markets.doc))

        assert dealt == 0
        assert len(_waiting(world)) == 2
        assert "dealing" not in world.markets.doc["reviewTeam"]


class TestAFollowUpWaiting:
    """A follow-up marked for the deal: kept by an owner who still holds a role on the market,
    else handed on, as its owner and its reviewer, to the reviewer the turn names."""

    def _hand_to_cat(self, world):
        _choose([ANA, BEN])
        _verdict(ADMIN, "app-v1", status="needs_follow_up")
        return _client().put(f"/markets/{MARKET}/applications/app-v1/follow-up-owner",
                             json={"ownerEmail": CAT})

    def test_one_handed_to_an_owner_who_may_review_keeps_its_owner(self, world):
        response = self._hand_to_cat(world)

        assert response.status_code == 200, response.get_json()
        doc = _doc(world, "app-v1")
        assert doc["follow_up_owner"]["email"] == CAT
        assert doc["reviewer"]["email"] == ANA
        assert _waiting(world) == []
        assert world.markets.doc["reviewTeam"]["turn"] == len(DEALT)
        assert len(_deals_of(world, "app-v1")) == 1  # the choice's alone

    def test_one_whose_owner_may_no_longer_review_is_handed_on(self, world, monkeypatch):
        real = ReviewTeam._settle

        def the_host_ends_the_request(*_args, **_kwargs):
            raise RuntimeError("the host ended the request")

        monkeypatch.setattr(ReviewTeam, "_settle", the_host_ends_the_request)
        assert self._hand_to_cat(world).status_code == 500
        monkeypatch.setattr(ReviewTeam, "_settle", real)
        assert _waiting(world) == ["app-v1"]
        # Cat's role is taken before any deal: they may no longer be chosen to review here.
        world.markets.doc["roles"].pop("user-cat")

        answered = _next(BEN)

        assert answered["dealt"] == 1
        doc = _doc(world, "app-v1")
        # The turn stood at 7, Ben's.
        assert doc["status"] == "needs_follow_up"
        assert doc["follow_up_owner"]["email"] == BEN
        assert doc["reviewer"]["email"] == BEN
        assert _waiting(world) == []
        assert world.markets.doc["reviewTeam"]["turn"] == len(DEALT) + 1
        [entry] = _deals_of(world, "app-v1")[-1:]
        assert (entry["actor"], entry["action"]) == (ADMIN, "give-verdicts")
        assert entry["detail"]["before"] == {
            "app-v1": {"reviewer": ANA, "follow_up_owner": CAT}}
        assert entry["detail"]["after"] == {
            "app-v1": {"reviewer": BEN, "follow_up_owner": BEN}}


#: The market's "Be chosen as a reviewer" row raised to Editor, so a Viewer may own a follow-up,
#: as anyone with a role here may, but may not be chosen to review.
CHOSEN_ROW_AT_EDITOR = {"review-when-chosen": {"role": "editor", "source": "market"}}


class TestAFollowUpOwnedByOneWhoMayNotReview:
    """A follow-up's owner who may still own one here (anyone with a role on the market, whom an
    organizer may pick) keeps it, whether or not they may be chosen to review, as a change of
    reviewers leaves such a follow-up with its owner; the deal hands on only an owner who may no
    longer own one here (``TestAFollowUpWaiting``)."""

    def test_handed_to_them_with_reviewers_chosen_it_stays_theirs(self, world):
        world.markets.doc["permissions"] = CHOSEN_ROW_AT_EDITOR
        assert _choose([BEN, EDITOR]).status_code == 200
        _verdict(ADMIN, "app-v1", status="needs_follow_up")

        response = _client().put(f"/markets/{MARKET}/applications/app-v1/follow-up-owner",
                                 json={"ownerEmail": CAT})

        assert response.status_code == 200, response.get_json()
        assert response.get_json()["application"]["followUpOwner"]["email"] == CAT
        assert _doc(world, "app-v1")["follow_up_owner"]["email"] == CAT
        assert _waiting(world) == []

    def test_given_before_reviewers_are_chosen_it_stays_theirs_at_the_choice(self, world):
        world.markets.doc["permissions"] = CHOSEN_ROW_AT_EDITOR
        _submit(world, NADIA)
        app_id = _id_of(world, NADIA)
        assert _waiting(world) == [app_id]
        response = _client(ADMIN).put(
            f"/markets/{MARKET}/applications/{app_id}/review",
            json={"status": "needs_follow_up", "ownerEmail": CAT,
                  "seen": seen_as_stored(app_id)})
        assert response.status_code == 200, response.get_json()
        assert _doc(world, app_id)["follow_up_owner"]["email"] == CAT

        assert _choose([BEN, EDITOR]).status_code == 200

        assert _doc(world, app_id)["follow_up_owner"]["email"] == CAT
        assert _waiting(world) == []

    def test_a_chosen_reviewer_the_raised_row_made_unable_keeps_theirs(self, world):
        # Ana, a Viewer, is chosen; the row raised to Editor leaves her chosen but unable.
        assert _choose([ANA, BEN]).status_code == 200
        world.markets.doc["permissions"] = CHOSEN_ROW_AT_EDITOR
        _verdict(ADMIN, "app-v1", status="needs_follow_up")

        response = _client().put(f"/markets/{MARKET}/applications/app-v1/follow-up-owner",
                                 json={"ownerEmail": ANA})

        assert response.status_code == 200, response.get_json()
        assert _doc(world, "app-v1")["follow_up_owner"]["email"] == ANA
        assert _waiting(world) == []
