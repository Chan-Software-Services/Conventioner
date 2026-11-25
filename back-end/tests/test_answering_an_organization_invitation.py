"""A person accepts before they join an organization (T538, ADR 0047).

A person signed in with an invited address finds the organization's invitation among those waiting
for them, accepts it and holds its place, or declines it and holds nothing. Accepting is judged
again as the inviter's act: the organization live, the inviter's account there, the inviter's place
still one that may add to that place, and the invitee's place as adding them judges it, then the
place written holding both as read. Its entry is the inviter giving the place, by an invitation
accepted, and it takes the invitation's limit counts back.

Pinned through the test client against the real app, over collections that apply the writes.
"""
import threading
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from conftest import (
    FakeOrganizations,
    FakeSlugMarketsCollection,
    install_organizations,
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
import organization_people as OrganizationPeople  # noqa: E402
import utils.email as Email  # noqa: E402
from datatypes import MarketPhase  # noqa: E402

ORG_ID = "org-1"
OTHER_ORG_ID = "org-2"
MARKET_ID = "market-123"
OWNER = SimpleNamespace(id="user-owner", email="owner@example.com")
ADMIN = SimpleNamespace(id="user-admin", email="admin@example.com")
MEMBER = SimpleNamespace(id="user-member", email="member@example.com")
#: The person invited: an account holding no place in the organization.
INVITEE = SimpleNamespace(id="user-invitee", email="invitee@example.com")
PEOPLE = (OWNER, ADMIN, MEMBER, INVITEE)
PLACES = {OWNER.id: "owner", ADMIN.id: "admin", MEMBER.id: "member"}

SENT_AT = datetime(2026, 11, 24, 9, 30, tzinfo=timezone.utc)
ENDS_AT = SENT_AT + timedelta(days=14)

ENDED = {
    "error": ("This invitation has ended: it was withdrawn, it ran out, or whoever sent it can no "
              "longer give it. Ask them to invite you again."),
    "code": "invitation_ended",
}
ALREADY_IN_IT = {"error": "You are already in this organization, so this invitation has ended."}


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
    held = SimpleNamespace(now=SENT_AT)
    monkeypatch.setattr(Invitations, "now", lambda: held.now)
    return held


@pytest.fixture
def mail(monkeypatch):
    monkeypatch.setattr(Email, "send_mail", lambda *_message: True)


def an_organization(org_id=ORG_ID, name="Ember Markets", places=PLACES, **overrides):
    return {
        "id": org_id, "name": name, "people": dict(places),
        "markets": [], "theme": None, **overrides,
    }


@pytest.fixture
def organization(monkeypatch, people, clock, mail):
    """The organizations, the first of ``docs`` this test's own."""
    return install_organizations(monkeypatch, FakeOrganizations(an_organization()))


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


def invite(inviter, email=INVITEE.email, place="member", org_id=ORG_ID):
    """Invite through the organization's route; the invitation's id."""
    response = signed_in_as(inviter).post(
        f"/organizations/{org_id}/invitations", json={"email": email, "place": place})
    assert response.status_code == 200, response.get_json()
    return response.get_json()["invitation"]["id"]


def listed(person=INVITEE):
    return signed_in_as(person).get("/invitations")


def accept(invitation_id, person=INVITEE):
    return signed_in_as(person).post(f"/invitations/{invitation_id}/accept")


def decline(invitation_id, person=INVITEE):
    return signed_in_as(person).post(f"/invitations/{invitation_id}/decline")


def entries(history):
    return [doc for doc in history.documents
            if doc.get(History.ORGANIZATION_ID_FIELD) == ORG_ID]


def kinds(history):
    return [entry["kind"] for entry in entries(history)]


def place_directly(organization, user_id, place):
    """Someone placed in the organization by another door since the invitation was sent."""
    doc = organization.docs[0]
    doc["people"][user_id] = place


class TestTheList:
    def test_an_organizations_invitation_is_listed_beside_a_markets(
        self, monkeypatch, organization, clock,
    ):
        markets = FakeSlugMarketsCollection([stored_market(
            phase=MarketPhase.APPLICATIONS, id=MARKET_ID, name="Ember Night Market",
            roles={OWNER.id: "owner"})])
        monkeypatch.setattr(MarketsApi, "markets_collection", markets)
        monkeypatch.setattr(MarketWrite, "markets_collection", markets)
        to_the_market = signed_in_as(OWNER).post(
            f"/markets/{MARKET_ID}/invitations",
            json={"email": INVITEE.email, "role": "viewer"}).get_json()["invitation"]["id"]
        clock.now = SENT_AT + timedelta(hours=1)
        to_the_organization = invite(OWNER, place="admin")

        response = listed()

        assert response.status_code == 200
        assert response.get_json() == {"invitations": [
            {"id": to_the_organization, "kind": "organization", "targetId": ORG_ID,
             "targetName": "Ember Markets", "role": "admin", "invitedBy": OWNER.email,
             "sentAt": clock.now.isoformat(),
             "endsAt": (clock.now + Invitations.LIFETIME).isoformat()},
            {"id": to_the_market, "kind": "market", "targetId": MARKET_ID,
             "targetName": "Ember Night Market", "role": "viewer", "invitedBy": OWNER.email,
             "sentAt": SENT_AT.isoformat(), "endsAt": ENDS_AT.isoformat()},
        ]}

    def test_the_names_are_read_once_for_every_organization(
        self, monkeypatch, organization,
    ):
        organization.docs.append(an_organization(OTHER_ORG_ID, "Harbour Collective"))
        invite(OWNER)
        invite(OWNER, org_id=OTHER_ORG_ID)
        reads = []
        find = organization.find
        monkeypatch.setattr(organization, "find", lambda *args, **kwargs: reads.append(args)
                            or find(*args, **kwargs))

        names = [row["targetName"] for row in listed().get_json()["invitations"]]

        assert sorted(names) == ["Ember Markets", "Harbour Collective"]
        assert len(reads) == 1
        assert reads[0][0]["id"] == {"$in": [ORG_ID, OTHER_ORG_ID]}

    def test_an_invitation_to_an_organization_gone_is_left_out(self, organization):
        invite(OWNER)
        organization.docs.clear()

        assert listed().get_json() == {"invitations": []}

    def test_an_invitation_to_an_organization_being_deleted_is_left_out(self, organization):
        invite(OWNER)
        organization.docs[0]["deleting"] = {
            "at": "2026-11-24T09:00:00+00:00", "by": OWNER.email, "trail_id": "trail-1"}

        assert listed().get_json() == {"invitations": []}


class TestAccepting:
    def test_accepting_an_invitation_to_be_a_member_places_them(
        self, organization, invitations, history,
    ):
        invitation = invite(ADMIN)

        response = accept(invitation)

        assert response.status_code == 200
        assert response.get_json() == {"accepted": {
            "kind": "organization", "targetId": ORG_ID, "targetName": "Ember Markets",
            "role": "member"}}
        doc = organization.docs[0]
        assert doc["people"] == {**PLACES, INVITEE.id: "member"}
        assert invitations.documents == []

    def test_the_entry_is_the_inviter_giving_the_place_by_an_invitation_accepted(
        self, organization, history,
    ):
        accept(invite(ADMIN))

        given = entries(history)[-1]
        assert (given["actor"], given["action"], given["kind"], given["subject"],
                given["detail"]) == (
            ADMIN.email, History.MANAGE_ORGANIZATION_MEMBERS, History.ROLE_GIVEN,
            {"user_id": INVITEE.id, "email": INVITEE.email},
            {"before": {"role": None}, "after": {"role": "member"}, "by_invitation": True})

    def test_accepting_an_invitation_to_be_an_admin(self, organization, history):
        accept(invite(OWNER, place="admin"))

        assert organization.docs[0]["people"] == {**PLACES, INVITEE.id: "admin"}
        given = entries(history)[-1]
        assert (given["action"], given["kind"], given["detail"]) == (
            History.MANAGE_ORGANIZATION_ADMINS, History.ROLE_GIVEN,
            {"before": {"role": None}, "after": {"role": "admin"}, "by_invitation": True})

    def test_a_member_accepting_an_invitation_to_be_an_admin_becomes_one(
        self, organization, invitations, history,
    ):
        """Sent before they were made a member, as "Add admin" of a member made them one."""
        invitation = invite(OWNER, place="admin")
        place_directly(organization, INVITEE.id, "member")

        response = accept(invitation)

        assert response.status_code == 200
        doc = organization.docs[0]
        assert doc["people"] == {**PLACES, INVITEE.id: "admin"}
        changed = entries(history)[-1]
        assert (changed["actor"], changed["action"], changed["kind"], changed["detail"]) == (
            OWNER.email, History.MANAGE_ORGANIZATION_ADMINS, History.ROLE_CHANGED,
            {"before": {"role": "member"}, "after": {"role": "admin"}, "by_invitation": True})
        assert invitations.documents == []

    def test_accepting_takes_both_limit_counts_back(self, organization, sign_in_attempts):
        invitation = invite(ADMIN)
        assert sorted(doc["count"] for doc in sign_in_attempts.docs.values()) == [1, 1]

        accept(invitation)

        assert sorted(doc["count"] for doc in sign_in_attempts.docs.values()) == [0, 0]

    def test_another_addresss_invitation_has_ended(self, organization, invitations):
        invitation = invite(OWNER, email=MEMBER.email.replace("member", "someone"))

        response = accept(invitation)

        assert (response.status_code, response.get_json()) == (404, ENDED)
        assert len(invitations.documents) == 1
        assert INVITEE.id not in organization.docs[0]["people"]


class TestAlreadyInIt:
    @pytest.mark.parametrize("held, offered", [
        ("member", "member"), ("admin", "member"), ("admin", "admin"),
    ])
    def test_someone_placed_since_it_was_sent_is_told_and_it_ends(
        self, organization, invitations, history, held, offered,
    ):
        invitation = invite(OWNER, place=offered)
        place_directly(organization, INVITEE.id, held)

        response = accept(invitation)

        assert (response.status_code, response.get_json()) == (400, ALREADY_IN_IT)
        assert organization.docs[0]["people"][INVITEE.id] == held
        assert invitations.documents == []
        assert kinds(history) == [History.INVITED]

    def test_the_owner_is_told_and_it_ends(self, monkeypatch, people, clock, mail, invitations):
        """Ownership transferred to them since it was sent: the giver, now an admin, still may add
        a member, and the table refuses the owner."""
        organization = install_organizations(monkeypatch, FakeOrganizations(an_organization()))
        invitation = invite(ADMIN)
        organization.docs[0]["people"].update({INVITEE.id: "owner", OWNER.id: "admin"})

        response = accept(invitation)

        assert (response.status_code, response.get_json()) == (400, ALREADY_IN_IT)
        assert invitations.documents == []

    def test_a_cut_between_the_claim_and_the_place_loses_the_invitation(
        self, organization, invitations, history,
    ):
        """The claim comes first: a cut before the place's write leaves neither, and the person
        is invited again."""
        invitation = invite(OWNER)
        organization.cut_at = 1
        assert accept(invitation).status_code == 500
        organization.cut_at = None

        assert INVITEE.id not in organization.docs[0]["people"]
        assert invitations.documents == []

        response = accept(invitation)

        assert (response.status_code, response.get_json()) == (404, ENDED)
        assert INVITEE.id not in organization.docs[0]["people"]
        assert kinds(history) == [History.INVITED]


def landing_before_the_claim(monkeypatch, meanwhile):
    """``meanwhile``, another request, lands once the accept has read the invitation and judged
    it, before its claim. It runs on its own thread, as a request of its own: one made inside the
    accept's would share its app context, and so its signed-in account."""
    claim = Invitations.claim

    def after_meanwhile(invitation):
        monkeypatch.setattr(Invitations, "claim", claim)
        other = threading.Thread(target=meanwhile)
        other.start()
        other.join()
        return claim(invitation)
    monkeypatch.setattr(Invitations, "claim", after_meanwhile)


class TestJudgedAgainAsTheInvitersAct:
    def test_an_inviter_whose_account_was_deleted_can_no_longer_give_it(
        self, organization, invitations, people,
    ):
        invitation = invite(ADMIN)
        del people.by_email[ADMIN.email]

        response = accept(invitation)

        assert (response.status_code, response.get_json()) == (404, ENDED)
        assert invitations.documents == []
        assert INVITEE.id not in organization.docs[0]["people"]

    def test_an_address_made_again_is_not_the_inviter(self, organization, invitations, people):
        """Even made an admin since: the account that invited is gone."""
        invitation = invite(ADMIN)
        people.by_email[ADMIN.email] = SimpleNamespace(id="user-admin-again", email=ADMIN.email)
        place_directly(organization, "user-admin-again", "admin")

        assert (accept(invitation).status_code, len(invitations.documents)) == (404, 0)

    def test_an_admin_made_a_member_since_can_no_longer_give_it(
        self, organization, invitations, history,
    ):
        invitation = invite(ADMIN)
        organization.docs[0]["people"][ADMIN.id] = "member"

        response = accept(invitation)

        assert (response.status_code, response.get_json()) == (404, ENDED)
        assert invitations.documents == []
        assert INVITEE.id not in organization.docs[0]["people"]
        assert kinds(history) == [History.INVITED]

    def test_an_owner_who_handed_it_on_can_no_longer_make_an_admin(
        self, organization, invitations,
    ):
        invitation = invite(OWNER, place="admin")
        organization.docs[0]["people"].update({OWNER.id: "admin", ADMIN.id: "owner"})

        assert (accept(invitation).status_code, len(invitations.documents)) == (404, 0)

    def test_but_may_still_make_a_member(self, organization):
        invitation = invite(OWNER)
        organization.docs[0]["people"].update({OWNER.id: "admin", ADMIN.id: "owner"})

        assert accept(invitation).status_code == 200
        assert organization.docs[0]["people"][INVITEE.id] == "member"

    @pytest.mark.parametrize("gone", ["deleted", "being deleted"])
    def test_an_organization_gone_has_ended_it(self, organization, invitations, gone):
        invitation = invite(OWNER)
        if gone == "deleted":
            organization.docs.clear()
        else:
            organization.docs[0]["deleting"] = {
                "at": "2026-11-24T09:00:00+00:00", "by": OWNER.email, "trail_id": "trail-1"}

        assert (accept(invitation).status_code, accept(invitation).get_json()) == (404, ENDED)
        assert invitations.documents == []

    def test_an_organization_deleted_between_the_read_and_the_write_has_ended_it(
        self, organization, invitations,
    ):
        invitation = invite(OWNER)
        organization.before_write = organization.docs.clear

        response = accept(invitation)

        assert (response.status_code, response.get_json()) == (404, ENDED)
        assert invitations.documents == []

    @pytest.mark.parametrize("meanwhile", ["the inviter's place", "the invitee's place"])
    def test_a_change_meanwhile_is_judged_again_in_the_same_accept(
        self, organization, invitations, history, meanwhile,
    ):
        """The claim is held, and the accept judges again: the inviter no longer able ends it, and
        the invitee placed meanwhile is told they are in it."""
        invitation = invite(ADMIN)

        def changed():
            if meanwhile == "the inviter's place":
                organization.docs[0]["people"][ADMIN.id] = "member"
            else:
                organization.docs[0]["people"][INVITEE.id] = "member"
        organization.before_write = changed

        response = accept(invitation)

        assert (response.status_code, response.get_json()) == (
            (404, ENDED) if meanwhile == "the inviter's place" else (400, ALREADY_IN_IT))
        assert invitations.documents == []
        assert kinds(history) == [History.INVITED]

    def test_one_the_inviter_may_still_give_is_written_again_and_gives_the_place(
        self, organization, invitations, history,
    ):
        invitation = invite(ADMIN)

        def handed_on():
            organization.docs[0]["people"].update({OWNER.id: "admin", ADMIN.id: "owner"})
        organization.before_write = handed_on

        response = accept(invitation)

        assert response.status_code == 200, response.get_json()
        assert organization.docs[0]["people"][INVITEE.id] == "member"
        assert invitations.documents == []
        assert kinds(history) == [History.INVITED, History.ROLE_GIVEN]

    def test_a_change_that_keeps_coming_back_loses_the_invitation(
        self, monkeypatch, organization, invitations, history,
    ):
        invitation = invite(OWNER)
        writes = []

        def always_changed(*_args, **_kwargs):
            writes.append(True)
            raise OrganizationPeople.OrganizationChanged()
        monkeypatch.setattr(OrganizationPeople, "_change", always_changed)

        response = accept(invitation)

        assert (response.status_code, response.get_json()) == (404, ENDED)
        assert len(writes) == Invitations.ACCEPT_TRIES
        assert INVITEE.id not in organization.docs[0]["people"]
        assert invitations.documents == []
        assert kinds(history) == [History.INVITED]


def on_its_own_thread(request):
    """``request``, another request, run to its end on a thread of its own, as
    ``landing_before_the_claim`` runs one; its answer."""
    answers = []
    other = threading.Thread(target=lambda: answers.append(request()))
    other.start()
    other.join()
    return answers[0]


class TestEndingWhileAnAcceptMeetsAChange:
    @pytest.mark.parametrize("ending", ["withdrawal", "decline"])
    def test_one_said_to_have_ended_never_waits_again(
        self, organization, invitations, history, ending,
    ):
        """A withdrawal or a decline landing while the accept holds its claim, and its write meets
        a change of place, is told the invitation has ended: so it has, and nobody can accept it
        later (review finding 5)."""
        invitation = invite(ADMIN)
        endings = []

        def handed_on_and_ended_meanwhile():
            organization.docs[0]["people"].update({OWNER.id: "admin", ADMIN.id: "owner"})
            endings.append(on_its_own_thread(
                (lambda: signed_in_as(OWNER).delete(
                    f"/organizations/{ORG_ID}/invitations/{invitation}"))
                if ending == "withdrawal" else (lambda: decline(invitation))))
        organization.before_write = handed_on_and_ended_meanwhile

        accepted = accept(invitation)

        assert endings[0].status_code == 404
        assert invitations.documents == []
        again = accept(invitation)
        assert (again.status_code, again.get_json()) == (404, ENDED)
        assert (accepted.status_code, organization.docs[0]["people"][INVITEE.id]) == (
            200, "member")
        assert kinds(history) == [History.INVITED, History.ROLE_GIVEN]


class TestAcceptAndWithdrawal:
    def test_a_withdrawal_first_has_ended_it(self, organization, invitations):
        invitation = invite(OWNER)
        signed_in_as(OWNER).delete(f"/organizations/{ORG_ID}/invitations/{invitation}")

        assert (accept(invitation).status_code, accept(invitation).get_json()) == (404, ENDED)
        assert INVITEE.id not in organization.docs[0]["people"]

    def test_an_accept_first_leaves_the_withdrawal_already_ended(self, organization):
        invitation = invite(OWNER)
        assert accept(invitation).status_code == 200

        response = signed_in_as(OWNER).delete(
            f"/organizations/{ORG_ID}/invitations/{invitation}")

        assert (response.status_code, response.get_json()) == (
            404, {"error": "That invitation has already ended."})
        assert organization.docs[0]["people"][INVITEE.id] == "member"


class TestWhicheverCameFirstWins:
    def test_a_withdrawal_meanwhile_gives_nothing(
        self, monkeypatch, organization, invitations, history,
    ):
        invitation = invite(OWNER)
        landing_before_the_claim(monkeypatch, lambda: signed_in_as(OWNER).delete(
            f"/organizations/{ORG_ID}/invitations/{invitation}"))

        response = accept(invitation)

        assert (response.status_code, response.get_json()) == (404, ENDED)
        assert INVITEE.id not in organization.docs[0]["people"]
        assert invitations.documents == []
        assert kinds(history) == [History.INVITED, History.INVITATION_WITHDRAWN]

    def test_a_decline_meanwhile_gives_nothing(
        self, monkeypatch, organization, invitations, history,
    ):
        invitation = invite(OWNER)
        landing_before_the_claim(monkeypatch, lambda: decline(invitation))

        response = accept(invitation)

        assert (response.status_code, response.get_json()) == (404, ENDED)
        assert INVITEE.id not in organization.docs[0]["people"]
        assert invitations.documents == []
        assert kinds(history) == [History.INVITED, History.INVITATION_DECLINED]

    def test_a_resend_to_another_place_meanwhile_gives_nothing_and_still_waits(
        self, monkeypatch, organization, invitations, history,
    ):
        invitation = invite(OWNER)
        landing_before_the_claim(monkeypatch, lambda: invite(OWNER, place="admin"))

        response = accept(invitation)

        assert (response.status_code, response.get_json()) == (404, ENDED)
        assert INVITEE.id not in organization.docs[0]["people"]
        assert [(doc["id"], doc["role"]) for doc in invitations.documents] == [
            (invitation, "admin")]
        assert History.ROLE_GIVEN not in kinds(history)


class TestDeclining:
    @pytest.mark.parametrize("place, action", [
        ("member", History.MANAGE_ORGANIZATION_MEMBERS),
        ("admin", History.MANAGE_ORGANIZATION_ADMINS),
    ])
    def test_declining_ends_it_places_nothing_and_records_it(
        self, organization, invitations, history, place, action,
    ):
        invitation = invite(OWNER, place=place)

        response = decline(invitation)

        assert response.status_code == 200
        assert response.get_json() == {"message": "Invitation declined"}
        assert invitations.documents == []
        assert organization.docs[0]["people"] == PLACES
        declined = entries(history)[-1]
        assert (declined["actor"], declined["action"], declined["kind"], declined["subject"],
                declined["detail"]) == (
            INVITEE.email, action, History.INVITATION_DECLINED, {"email": INVITEE.email},
            {"role": place})

    def test_declining_again_has_ended(self, organization, history):
        invitation = invite(OWNER)
        decline(invitation)

        assert (decline(invitation).status_code, decline(invitation).get_json()) == (404, ENDED)
        assert kinds(history) == [History.INVITED, History.INVITATION_DECLINED]

    def test_an_organization_gone_has_ended_it(self, organization, invitations, history):
        invitation = invite(OWNER)
        organization.docs[0]["deleting"] = {
            "at": "2026-11-24T09:00:00+00:00", "by": OWNER.email, "trail_id": "trail-1"}

        assert (decline(invitation).status_code, decline(invitation).get_json()) == (404, ENDED)
        assert invitations.documents == []
        assert kinds(history) == [History.INVITED]

    def test_another_addresss_invitation_has_ended(self, organization, invitations):
        invitation = invite(OWNER, email="someone-else@example.com")

        assert decline(invitation).status_code == 404
        assert len(invitations.documents) == 1


def test_the_place_an_invitation_offers_is_one_adding_judges():
    assert OrganizationPeople.INVITED_TO == {
        "admin": OrganizationPeople.Event.ADD_ADMIN, "member": OrganizationPeople.Event.ADD_MEMBER}
