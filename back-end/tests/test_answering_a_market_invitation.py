"""A person accepts before they join a market (T538, ADR 0047).

A person signed in with an invited address lists the invitations waiting for them, accepts one and
holds its role, or declines it and holds nothing. Accepting is judged again as the inviter's act:
the market live, the inviter's account there, the row that gives the role asked of the inviter
again, and the invitee holding no role yet, then the role written holding what was read. Its entry
is the inviter giving the role, by an invitation accepted, and it takes the invitation's limit
counts back. An invitation that is another address's, ran out, was withdrawn, or whose market is
gone answers one sentence that it has ended.

Pinned through the test client against the real app, over collections that apply the writes.
"""
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from conftest import (
    FakeSlugMarketsCollection,
    sessions_load_through_get_user,
    skip_without_real_dependencies,
    stored_market,
)

skip_without_real_dependencies()

import app as app_module  # noqa: E402
import api.markets as MarketsApi  # noqa: E402
import api.users as UsersApi  # noqa: E402
import history as History  # noqa: E402
import invitations as Invitations  # noqa: E402
import market_write as MarketWrite  # noqa: E402
import sign_in_limits  # noqa: E402
import utils.email as Email  # noqa: E402
from datatypes import MarketPhase  # noqa: E402
from market_write import MARKET_CHANGED  # noqa: E402

MARKET_ID = "market-123"
OTHER_MARKET_ID = "market-456"
OWNER = SimpleNamespace(id="user-owner", email="owner@example.com")
ADMIN = SimpleNamespace(id="user-admin", email="admin@example.com")
EDITOR = SimpleNamespace(id="user-editor", email="editor@example.com")
#: The person invited: an account holding no role on the market.
INVITEE = SimpleNamespace(id="user-invitee", email="invitee@example.com")
#: Someone else signed in, holding no role either.
STRANGER = SimpleNamespace(id="user-stranger", email="stranger@example.com")
PEOPLE = (OWNER, ADMIN, EDITOR, INVITEE, STRANGER)
ROLES = {OWNER.id: "owner", ADMIN.id: "admin", EDITOR.id: "editor"}

SENT_AT = datetime(2026, 11, 24, 9, 30, tzinfo=timezone.utc)
ENDS_AT = SENT_AT + timedelta(days=14)

ENDED = {
    "error": ("This invitation has ended: it was withdrawn, it ran out, or whoever sent it can no "
              "longer give it. Ask them to invite you again."),
    "code": "invitation_ended",
}
ALREADY_ON_IT = {"error": (
    "You already have a role on this market, so this invitation has ended. Ask its owner or an "
    "Admin to change your role.")}


@pytest.fixture
def people(monkeypatch):
    """The accounts, by address; a test deletes one by taking it out of ``by_email``."""
    accounts = SimpleNamespace(by_email={person.email: person for person in PEOPLE})

    def account(email):
        person = accounts.by_email.get(email)
        return person and SimpleNamespace(
            id=person.id, email=email, is_active=True, is_authenticated=True,
            is_anonymous=False, get_id=lambda e=email: e,
        )

    def by_id(user_id):
        return next((person for person in accounts.by_email.values() if person.id == user_id),
                    None)
    monkeypatch.setattr(UsersApi, "get_user", account)
    monkeypatch.setattr(UsersApi, "get_user_by_id", by_id)
    monkeypatch.setattr(app_module.login_manager, "session_protection", None)
    sessions_load_through_get_user(monkeypatch)
    return accounts


@pytest.fixture
def clock(monkeypatch):
    """The invitations' clock, held at ``SENT_AT`` until a test moves it."""
    held = SimpleNamespace(now=SENT_AT)
    monkeypatch.setattr(Invitations, "now", lambda: held.now)
    return held


@pytest.fixture
def mail(monkeypatch):
    sent = []
    monkeypatch.setattr(Email, "send_mail", lambda kind, email, *_message: sent.append(email)
                        or True)
    return sent


def a_market(**overrides):
    return stored_market(phase=MarketPhase.APPLICATIONS, **{
        "id": MARKET_ID, "name": "Ember Night Market", "roles": dict(ROLES), **overrides})


def market_with(monkeypatch, **overrides):
    """The markets, the first of ``docs`` this test's own."""
    markets = FakeSlugMarketsCollection([a_market(**overrides)])
    monkeypatch.setattr(MarketsApi, "markets_collection", markets)
    monkeypatch.setattr(MarketWrite, "markets_collection", markets)
    return markets


@pytest.fixture
def market(monkeypatch, people, clock, mail):
    return market_with(monkeypatch)


@pytest.fixture
def invitations(market_records):
    return market_records.invitations


@pytest.fixture
def history(market_records):
    return market_records.history


def signed_in_as(person):
    client = app_module.app.test_client()
    with client.session_transaction() as session:
        session["_user_id"] = person.email
        session["_fresh"] = True
    return client


def invite(inviter, email=INVITEE.email, role="editor", market_id=MARKET_ID):
    """Invite through the organizer's route, as Manage market does; the invitation's id."""
    response = signed_in_as(inviter).post(
        f"/markets/{market_id}/invitations", json={"email": email, "role": role})
    assert response.status_code == 200, response.get_json()
    return response.get_json()["invitation"]["id"]


def listed(person=INVITEE):
    return signed_in_as(person).get("/invitations")


def accept(invitation_id, person=INVITEE):
    return signed_in_as(person).post(f"/invitations/{invitation_id}/accept")


def decline(invitation_id, person=INVITEE):
    return signed_in_as(person).post(f"/invitations/{invitation_id}/decline")


def entries(history):
    return [doc for doc in history.documents if doc.get(History.MARKET_ID_FIELD) == MARKET_ID]


def kinds(history):
    return [entry["kind"] for entry in entries(history)]


class TestTheList:
    def test_it_lists_the_invitations_waiting_for_the_signed_in_address(self, market, clock):
        first = invite(OWNER, role="viewer")

        response = listed()

        assert response.status_code == 200
        assert response.get_json() == {"invitations": [{
            "id": first, "kind": "market", "targetId": MARKET_ID,
            "targetName": "Ember Night Market", "role": "viewer", "invitedBy": OWNER.email,
            "sentAt": SENT_AT.isoformat(), "endsAt": ENDS_AT.isoformat(),
        }]}

    def test_newest_first(self, monkeypatch, people, clock, mail, invitations):
        markets = market_with(monkeypatch)
        older = invite(OWNER)
        clock.now = SENT_AT + timedelta(hours=1)
        Invitations.invitations_collection.insert_one({
            "id": "invitation-other", "target_kind": "market", "target_id": OTHER_MARKET_ID,
            "email": INVITEE.email, "role": "viewer", "invited_by": OWNER.id,
            "invited_by_email": OWNER.email, "sent_at": clock.now,
            "expires_at": clock.now + Invitations.LIFETIME, "counted_at": clock.now,
        })
        markets.docs.append(a_market(id=OTHER_MARKET_ID, name="Harbour Fair"))

        ids = [row["id"] for row in listed().get_json()["invitations"]]

        assert ids == ["invitation-other", older]

    def test_only_the_signed_in_addresss_invitations_are_listed(self, market):
        invite(OWNER, email=STRANGER.email)

        assert listed().get_json() == {"invitations": []}

    def test_the_address_is_compared_in_its_one_spelling(self, market):
        invite(OWNER, email="  InVitee@Example.COM ")

        assert [row["targetId"] for row in listed().get_json()["invitations"]] == [MARKET_ID]

    def test_an_invitation_past_its_end_is_not_listed(self, market, clock):
        invite(OWNER)
        clock.now = ENDS_AT

        assert listed().get_json() == {"invitations": []}

    def test_an_invitation_to_a_market_gone_is_left_out(self, market):
        invite(OWNER)
        market.docs.clear()

        assert listed().get_json() == {"invitations": []}

    def test_an_invitation_to_a_market_being_deleted_is_left_out(self, market):
        invite(OWNER)
        market.docs[0]["deleting"] = {
            "at": "2026-11-24T09:00:00+00:00", "by": OWNER.email, "trail_id": "trail-1"}

        assert listed().get_json() == {"invitations": []}

    def test_the_names_are_read_once_for_every_market(self, monkeypatch, market):
        invite(OWNER)
        invite(ADMIN, role="viewer", email=INVITEE.email.upper())
        reads = []
        find = market.find
        monkeypatch.setattr(market, "find", lambda *args, **kwargs: reads.append(args)
                            or find(*args, **kwargs))

        listed()

        assert len(reads) == 1
        assert reads[0][0]["id"] == {"$in": [MARKET_ID]}

    def test_signing_in_is_required(self, market):
        assert app_module.app.test_client().get("/invitations").status_code == 401


class TestAccepting:
    def test_accepting_gives_the_role(self, market, invitations):
        invitation = invite(OWNER, role="viewer")

        response = accept(invitation)

        assert response.status_code == 200
        assert response.get_json() == {"accepted": {
            "kind": "market", "targetId": MARKET_ID, "targetName": "Ember Night Market",
            "role": "viewer"}}
        assert market.docs[0]["roles"] == {**ROLES, INVITEE.id: "viewer"}
        assert invitations.documents == []

    def test_the_entry_is_the_inviter_giving_the_role_by_an_invitation_accepted(
        self, market, history,
    ):
        invitation = invite(ADMIN)

        accept(invitation)

        given = entries(history)[-1]
        assert {key: given[key] for key in ("actor", "action", "kind", "subject", "detail")} == {
            "actor": ADMIN.email, "action": "manage-editors-and-viewers",
            "kind": History.ROLE_GIVEN,
            "subject": {"user_id": INVITEE.id, "email": INVITEE.email},
            "detail": {"before": {"role": None}, "after": {"role": "editor"},
                       "by_invitation": True},
        }
        assert kinds(history) == [History.INVITED, History.ROLE_GIVEN]

    def test_an_admin_role_is_recorded_under_the_admin_row(self, market, history):
        accept(invite(OWNER, role="admin"))

        assert entries(history)[-1]["action"] == "manage-admins"
        assert market.docs[0]["roles"][INVITEE.id] == "admin"

    def test_it_takes_back_both_limit_counts(self, market, sign_in_attempts):
        accept(invite(OWNER))

        assert sorted(doc["count"] for doc in sign_in_attempts.docs.values()) == [0, 0]

    def test_a_count_taken_back_is_the_one_of_when_it_was_sent(
        self, market, sign_in_attempts, clock,
    ):
        """Accepted in another window than it was sent in, it leaves the window it was counted in."""
        invitation = invite(OWNER)
        clock.now = SENT_AT + timedelta(days=2)

        accept(invitation)

        for limit, subject in ((sign_in_limits.INVITATION_PER_INVITER, OWNER.id),
                               (sign_in_limits.INVITATION_PER_ADDRESS, INVITEE.email)):
            key, _ends = sign_in_limits._window(limit, subject, SENT_AT)
            assert sign_in_attempts.docs[key]["count"] == 0

    def test_a_count_taken_back_from_a_naive_stored_time_is_read_as_utc(
        self, market, invitations, sign_in_attempts,
    ):
        """The driver hands a stored time back without its zone."""
        invitation = invite(OWNER)
        for doc in invitations.documents:
            doc["counted_at"] = doc["counted_at"].replace(tzinfo=None)

        accept(invitation)

        assert sorted(doc["count"] for doc in sign_in_attempts.docs.values()) == [0, 0]


class TestAnInvitationThatHasEnded:
    def test_another_addresss_invitation_has_ended_for_them(self, market, invitations, history):
        invitation = invite(OWNER, email=STRANGER.email)

        for answer in (accept, decline):
            response = answer(invitation, INVITEE)
            assert (response.status_code, response.get_json()) == (404, ENDED)
        assert INVITEE.id not in market.docs[0]["roles"]
        assert len(invitations.documents) == 1
        assert kinds(history) == [History.INVITED]

    def test_an_id_that_never_was(self, market):
        for answer in (accept, decline):
            response = answer("invitation-never")
            assert (response.status_code, response.get_json()) == (404, ENDED)

    def test_one_past_its_end_has_ended(self, market, clock):
        invitation = invite(OWNER)
        clock.now = ENDS_AT

        for answer in (accept, decline):
            response = answer(invitation)
            assert (response.status_code, response.get_json()) == (404, ENDED)
        assert INVITEE.id not in market.docs[0]["roles"]

    def test_one_withdrawn_has_ended(self, market):
        invitation = invite(OWNER)
        assert signed_in_as(OWNER).delete(
            f"/markets/{MARKET_ID}/invitations/{invitation}").status_code == 200

        response = accept(invitation)

        assert (response.status_code, response.get_json()) == (404, ENDED)
        assert INVITEE.id not in market.docs[0]["roles"]

    def test_one_accepted_cannot_be_accepted_again(self, market, history):
        invitation = invite(OWNER)
        assert accept(invitation).status_code == 200

        response = accept(invitation)

        assert (response.status_code, response.get_json()) == (404, ENDED)
        assert kinds(history) == [History.INVITED, History.ROLE_GIVEN]

    @pytest.mark.parametrize("answer", [accept, decline], ids=["accepted", "declined"])
    @pytest.mark.parametrize("gone", ["deleted", "being deleted"])
    def test_one_whose_market_is_gone_has_ended(self, market, invitations, history, gone, answer):
        invitation = invite(OWNER)
        if gone == "deleted":
            market.docs.clear()
        else:
            market.docs[0]["deleting"] = {
                "at": "2026-11-24T09:00:00+00:00", "by": OWNER.email, "trail_id": "trail-1"}

        response = answer(invitation)

        assert (response.status_code, response.get_json()) == (404, ENDED)
        assert invitations.documents == []
        assert kinds(history) == [History.INVITED]

    def test_one_whose_inviter_was_deleted_has_ended(self, market, people, invitations, history):
        invitation = invite(ADMIN)
        del people.by_email[ADMIN.email]

        response = accept(invitation)

        assert (response.status_code, response.get_json()) == (404, ENDED)
        assert INVITEE.id not in market.docs[0]["roles"]
        assert invitations.documents == []
        assert kinds(history) == [History.INVITED]

    def test_one_whose_inviters_address_has_a_new_account_has_ended(self, market, people):
        """Even one given the same role since: it is not the account that invited."""
        invitation = invite(ADMIN)
        people.by_email[ADMIN.email] = SimpleNamespace(id="user-admin-again", email=ADMIN.email)
        market.docs[0]["roles"]["user-admin-again"] = "admin"

        response = accept(invitation)

        assert (response.status_code, response.get_json()) == (404, ENDED)
        assert INVITEE.id not in market.docs[0]["roles"]

    @pytest.mark.parametrize("now", ["editor", None])
    def test_one_whose_inviter_can_no_longer_give_it_has_ended(
        self, market, invitations, history, now,
    ):
        """An Admin's invitation, accepted once they are an Editor, or off the market."""
        invitation = invite(ADMIN)
        if now is None:
            del market.docs[0]["roles"][ADMIN.id]
        else:
            market.docs[0]["roles"][ADMIN.id] = now

        response = accept(invitation)

        assert (response.status_code, response.get_json()) == (404, ENDED)
        assert INVITEE.id not in market.docs[0]["roles"]
        assert invitations.documents == []
        assert kinds(history) == [History.INVITED]

    def test_an_admin_invitation_from_an_owner_since_made_an_admin_has_ended(self, market):
        invitation = invite(OWNER, role="admin")
        market.docs[0]["roles"][OWNER.id] = "admin"
        market.docs[0]["roles"][ADMIN.id] = "owner"

        assert accept(invitation).get_json() == ENDED

    def test_an_invitee_already_on_the_market_is_told_and_the_invitation_ends(
        self, market, invitations, history,
    ):
        invitation = invite(OWNER, role="admin")
        market.docs[0]["roles"][INVITEE.id] = "viewer"

        response = accept(invitation)

        assert (response.status_code, response.get_json()) == (400, ALREADY_ON_IT)
        assert market.docs[0]["roles"][INVITEE.id] == "viewer"
        assert invitations.documents == []
        assert kinds(history) == [History.INVITED]

    def test_a_role_written_before_its_invitation_was_ended_ends_it_on_the_next_accept(
        self, monkeypatch, market, invitations, history,
    ):
        """A cut between the role's write and the invitation's delete loses neither."""
        invitation = invite(OWNER)

        end, cutting = Invitations.end, [True]

        def cut(invitation):
            if cutting[0]:
                raise RuntimeError("the request was cut here")
            return end(invitation)
        monkeypatch.setattr(Invitations, "end", cut)
        assert accept(invitation).status_code == 500
        cutting[0] = False
        assert market.docs[0]["roles"][INVITEE.id] == "editor"
        assert len(invitations.documents) == 1

        response = accept(invitation)

        assert (response.status_code, response.get_json()) == (400, ALREADY_ON_IT)
        assert market.docs[0]["roles"][INVITEE.id] == "editor"
        assert invitations.documents == []
        assert kinds(history) == [History.INVITED, History.ROLE_GIVEN]


class TestAcceptingAndWithdrawing:
    def test_a_withdrawal_first_leaves_nothing_to_accept(self, market, invitations):
        invitation = invite(OWNER)
        signed_in_as(ADMIN).delete(f"/markets/{MARKET_ID}/invitations/{invitation}")

        assert accept(invitation).get_json() == ENDED
        assert INVITEE.id not in market.docs[0]["roles"]

    def test_an_accept_first_leaves_the_withdrawal_already_ended_and_the_role_standing(
        self, market, history,
    ):
        invitation = invite(OWNER)
        assert accept(invitation).status_code == 200

        response = signed_in_as(ADMIN).delete(f"/markets/{MARKET_ID}/invitations/{invitation}")

        assert (response.status_code, response.get_json()) == (
            404, {"error": "That invitation has already ended."})
        assert market.docs[0]["roles"][INVITEE.id] == "editor"
        assert kinds(history) == [History.INVITED, History.ROLE_GIVEN]


class TestAcceptingOnAMarketChanged:
    def test_a_role_change_between_the_read_and_the_write_keeps_the_invitation(
        self, monkeypatch, market, invitations, history,
    ):
        invitation = invite(ADMIN)
        read = MarketsApi.load_market_context

        def read_then_change(market_id):
            context = read(market_id)
            market.docs[0]["roles"][ADMIN.id] = "viewer"
            return context
        monkeypatch.setattr(MarketsApi, "load_market_context", read_then_change)

        response = accept(invitation)

        assert (response.status_code, response.get_json()) == (
            409, {"error": MARKET_CHANGED, "code": "market_changed"})
        assert INVITEE.id not in market.docs[0]["roles"]
        assert len(invitations.documents) == 1
        assert kinds(history) == [History.INVITED]


class TestDeclining:
    def test_declining_ends_the_invitation_and_gives_nothing(self, market, invitations):
        invitation = invite(OWNER)

        response = decline(invitation)

        assert (response.status_code, response.get_json()) == (
            200, {"message": "Invitation declined"})
        assert market.docs[0]["roles"] == ROLES
        assert invitations.documents == []
        assert listed().get_json() == {"invitations": []}

    @pytest.mark.parametrize("role, row", [
        ("editor", "manage-editors-and-viewers"), ("admin", "manage-admins")])
    def test_the_decline_is_recorded_with_the_address_as_its_actor(
        self, market, history, role, row,
    ):
        decline(invite(OWNER, role=role))

        declined = entries(history)[-1]
        assert {key: declined[key] for key in ("actor", "action", "kind", "subject", "detail")} == {
            "actor": INVITEE.email, "action": row, "kind": History.INVITATION_DECLINED,
            "subject": {"email": INVITEE.email}, "detail": {"role": role},
        }

    def test_a_declined_invitation_keeps_its_limit_counts(self, market, sign_in_attempts):
        decline(invite(OWNER))

        assert sorted(doc["count"] for doc in sign_in_attempts.docs.values()) == [1, 1]

    def test_one_declined_cannot_be_accepted(self, market):
        invitation = invite(OWNER)
        decline(invitation)

        assert accept(invitation).get_json() == ENDED
        assert decline(invitation).get_json() == ENDED


class TestNobodyGainsARoleByBeingInvited:
    def test_an_invited_person_who_has_not_answered_reads_the_market_as_before(self, market):
        before = signed_in_as(INVITEE).get(f"/markets/{MARKET_ID}")
        invite(OWNER)

        after = signed_in_as(INVITEE).get(f"/markets/{MARKET_ID}")

        assert before.status_code in (403, 404)
        assert (after.status_code, after.get_json()) == (before.status_code, before.get_json())

    def test_they_are_not_among_the_people_with_access(self, market):
        invite(OWNER)

        response = signed_in_as(OWNER).get(f"/markets/{MARKET_ID}")

        assert INVITEE.email not in str(response.get_json())
